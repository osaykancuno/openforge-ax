# Self-hosting OpenForge AX

> Status: shipped. OpenForge AX is open source (CC0) and runs no project-funded servers or robot stations. Everything that needs a server is run by the people who use it, with the connectors in this repo. The product still has to work end to end out of the box. This page is how.

## 1. What runs where

| Piece | Who runs it | Without it |
|---|---|---|
| Contracts (mint, agent wallets, reputation, renderer) | Ethereum mainnet | — |
| Site (`web/`, static) | Anyone: IPFS, GitHub Pages, or `npm run selfhost` | — |
| Proving Grounds verifier (`scripts/proving-server.mjs`) | Holders and community operators | Missions still play as guest; no verified runs or leaderboard |
| Neo-Forge world server (`scripts/world-server.mjs`) | Holders and community operators | The world page can't connect |
| Robot Link (`web/robot.html`) | Runs in your browser, talks to your SO-101 over USB | — |
| SO-101 arm, a "physical station" | You | Use the virtual arm |

## 2. One command

You need Node.js 20+ and a copy of this repo with the `web/deployment.json` of the network you use (mainnet after launch).

```bash
npm install --legacy-peer-deps
```

```bash
npm run selfhost
```

It starts three things, already wired to each other:
- the site on http://localhost:8080. Its `deployment.json` is served with your own server URLs;
- the Proving Grounds verifier on http://localhost:8787;
- the Neo-Forge world server on ws://localhost:8788. It accepts only your local site's origin.

Open http://localhost:8080. Ctrl+C stops everything. If one service fails (a wrong RPC, a port in use), the others stop too and the error is printed, prefixed with the service name.

**Network exposure.** On the local chain (31337) the site and the world server bind to `127.0.0.1` only, and refuse requests whose `Host` header is not `localhost`, `127.0.0.1`, `[::1]`, or your `PUBLIC_URL` / `SITE` host (HTTP 421, a guard against DNS rebinding). To try the Phone Brain from a phone on your LAN, opt in explicitly: `HOST=0.0.0.0 npm run local` (or `HOST=0.0.0.0 npm run selfhost`), then open `http://<your-LAN-IP>:8080/pilot.html` on the phone. With `HOST` set to `0.0.0.0` any `Host` is accepted, so only do it on a network you trust. The Proving Grounds verifier (`scripts/proving-server.mjs`) does not read `HOST` yet and listens on all interfaces: keep its port firewalled. `npm run selfhost` also gives each service only the secrets it needs: the site and the world server never see `PRIVATE_KEY`, `SEPOLIA_PRIVATE_KEY`, `PINATA_JWT`, `ETHERSCAN_API_KEY`, `SIM_ATTESTER_KEY` or `ADMIN_TOKEN`; the verifier gets `SIM_ATTESTER_KEY` and `ADMIN_TOKEN` but not the deploy secrets.

Optional `.env` values: `HOST`, `PROVING_RPC_URL` (default: a public RPC for mainnet or Sepolia), `WEB_PORT`, `PORT`, `WORLD_PORT`, `SIM_ATTESTER_KEY`, `ALLOWED_ORIGIN(S)`.

## 3. On-chain attestation (optional)

Without `SIM_ATTESTER_KEY` the verifier runs in **verify-only** mode. Missions, server-side replay, run storage, episode files and the leaderboard all work. Runs are not written on-chain.

Sim results go on-chain only through an address with the `isSimAttester` role on `AgentReputation`, granted by the owner (the Safe) with `setSimAttester(address, true)`. An operator who gets the role:
1. sets `SIM_ATTESTER_KEY` to a hot key with a little ETH;
2. restarts. The verifier batch-attests every `FLUSH_SECONDS`.

The contract caps each token at 10 sim runs per day, whoever attests. `ATTEST=off` forces verify-only, for example for testing.

## 4. Connecting the public site to your servers

Use this when you run the verifier and the world server on your own machine, or on a host with TLS, and want to use the public site:
1. open the site and click **Servers** in the footer;
2. enter your Proving Grounds URL (`https://…`, or `http://localhost:8787`) and your Neo-Forge URL (`wss://…`, or `ws://localhost:8788`);
3. save. The setting stays in your browser only. **Use published servers** resets it.

Plain `http`/`ws` is accepted only for `localhost`. A URL can never set this, so a link can't redirect anyone's runs.

On a public host, also set `ALLOWED_ORIGIN` (verifier) and `ALLOWED_ORIGINS` (world, comma-separated) to the site's origin. Put both servers behind a TLS reverse proxy, and set `TRUST_PROXY=true`: it applies to the world server and to the verifier (both then trust the rightmost `X-Forwarded-For` entry, appended by your proxy, for rate limits). Bind the servers to `127.0.0.1` (`HOST=127.0.0.1`) behind the proxy, and never expose their ports directly while `TRUST_PROXY` is set: a client could forge `X-Forwarded-For` and dodge the per-IP limits. IPv6 clients are limited per /64 and IPv4-mapped addresses as IPv4.

## 5. Your robot station

Plug an SO-101 follower arm into the computer running the browser and open **Robot Link**. There is nothing else to install ([05-ROBOT-LINK.md](05-ROBOT-LINK.md)). LeRobot users can use `scripts/real/replay_so101.py` instead.

## 6. Trying everything locally (no mainnet)

1. `npx hardhat node`, left running.
2. `npm run demo`: deploys to the local chain, mints, reveals and writes `web/deployment.json`.
3. `npm run selfhost`.
