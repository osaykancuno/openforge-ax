// Neo-Forge world server (WebSocket presence). Reads web/deployment.json.
//   node scripts/world-server.mjs
// Env: WORLD_PORT=8788, HOST (bind address; default 127.0.0.1 on the local chain, 0.0.0.0 otherwise), PROVING_RPC_URL, ALLOWED_ORIGINS (comma-separated, required in production), TRUST_PROXY=true behind a TLS proxy
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { ownerVerifier } from "./lib/signatures.mjs";
import { createWorldServer, hostsOf, isLoopbackHost, hardenHttpServer, installCrashGuards } from "./world/core.mjs";
import { PREFIX, SUFFIX, LEGENDARY } from "../art/traits.mjs";

installCrashGuards("world"); // a stray rejected promise is logged, it must not take the world server down

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dep = JSON.parse(readFileSync(join(root, "web/deployment.json"), "utf8"));
const env = process.env;
const PUBLIC_RPC = { 1: "https://ethereum-rpc.publicnode.com", 11155111: "https://ethereum-sepolia-rpc.publicnode.com", 31337: "http://127.0.0.1:8545" };
const rpcUrl = env.PROVING_RPC_URL || dep.rpcUrl || PUBLIC_RPC[dep.chainId];
if (!rpcUrl) throw new Error(`No RPC for chain ${dep.chainId}: set PROVING_RPC_URL`);
const provider = new JsonRpcProvider(rpcUrl, dep.chainId, { staticNetwork: true });
const agents = new Contract(dep.agents, ["function ownerOf(uint256) view returns (address)"], provider);
const renderer = new Contract(dep.renderer, ["function traitsOf(uint256) view returns ((uint8 class_,uint8 core,uint8 sensor,uint8 finish,uint8 frame,uint8 district,uint8 faction,uint8 augment,uint8 prefix,uint8 suffix,uint8 legendary))"], provider);

const ownerCache = new Map(); // tokenId -> { owner, at }  (short TTL)
const infoCache = new Map(); // tokenId -> info (traits are immutable after reveal)

if (dep.chainId !== 31337 && !env.ALLOWED_ORIGINS) throw new Error("ALLOWED_ORIGINS is required outside the local chain");

// local demo: loopback only (HOST=0.0.0.0 to open it to the LAN); loopback binds also check the Host header against DNS rebinding
const host = env.HOST || (dep.chainId === 31337 ? "127.0.0.1" : "");
const guarded = host && isLoopbackHost(host);
const httpServer = hardenHttpServer(createServer((_req, res) => res.writeHead(426).end("websocket only"))); // timeouts bound the upgrade handshake
httpServer.listen(Number(env.WORLD_PORT || 8788), ...(host ? [host] : []));

const world = createWorldServer({
  server: httpServer,
  hosts: guarded ? hostsOf([env.PUBLIC_URL, env.SITE, ...(env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",") : [])]) : null,
  // no Origin list (null) is accepted only on the local demo: it is bound to 127.0.0.1 behind the Host guard above; every other chain requires ALLOWED_ORIGINS
  origins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",") : null,
  trustProxy: env.TRUST_PROXY === "true",
  deps: {
    chainId: dep.chainId,
    verifyingContract: dep.reputation,
    verifySignature: ownerVerifier(provider),
    async ownerOf(id) {
      const c = ownerCache.get(id);
      if (c && Date.now() - c.at < (c.owner ? 20_000 : 60_000)) {
        if (!c.owner) throw new Error("unknown agent");
        return c.owner;
      }
      try {
        const owner = getAddress(await agents.ownerOf(id));
        ownerCache.set(id, { owner, at: Date.now() });
        return owner;
      } catch (e) {
        ownerCache.set(id, { owner: null, at: Date.now() }); // negative cache: unminted ids can't amplify RPC load
        throw e;
      }
    },
    async agentInfo(id) {
      if (!infoCache.has(id)) {
        const t = await renderer.traitsOf(id);
        const traits = { class_: Number(t.class_), core: Number(t.core), sensor: Number(t.sensor), finish: Number(t.finish), augment: Number(t.augment), faction: Number(t.faction), legendary: Number(t.legendary) };
        const call = traits.legendary ? LEGENDARY[traits.legendary - 1] : `${PREFIX[Number(t.prefix)]} ${SUFFIX[Number(t.suffix)]}`;
        infoCache.set(id, { name: `AX-${String(id).padStart(4, "0")} // ${call}`, traits });
      }
      return infoCache.get(id);
    },
  },
});
console.log(`Neo-Forge world server on ws://localhost:${env.WORLD_PORT || 8788} (chain ${dep.chainId})`);
setInterval(() => console.log("stats", JSON.stringify(world.stats())), 60_000);
