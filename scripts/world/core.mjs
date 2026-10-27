// Neo-Forge presence server core (transport + rules). Chain access is injected so tests can run without a node.
import { WebSocketServer } from "ws";
import { verifyTypedData } from "ethers";
import { randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";
import { PROTOCOL, EMOTES, ROOM_CAP, GUEST_CAP, RESUME_SECONDS, joinTypedData, qPos, qYaw } from "../../web/js/world/protocol.js";
import { DISTRICT, SIZE, SPAWN, MAX_SPEED, buildDistrict } from "../../web/js/world/district.js";

const hex = (n) => "0x" + randomBytes(n).toString("hex");

/** Rate-limit key for a peer address: IPv4-mapped IPv6 becomes the IPv4, other IPv6 collapses to its /64 (one host owns a whole /64). */
export function normalizeIp(ip) {
  if (typeof ip !== "string" || !ip) return "unknown";
  let a = ip.split("%")[0].toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!isIPv6(a)) return a;
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

/** Host-header allowlist (DNS-rebinding guard for servers bound to loopback). extra: extra allowed hostnames; port is ignored. */
export function hostAllowed(hostHeader, extra = []) {
  if (typeof hostHeader !== "string") return false;
  const m = /^(\[[0-9a-f:.]+\]|[^:\/]+)(?::\d+)?$/i.exec(hostHeader.trim());
  if (!m) return false;
  return ["localhost", "127.0.0.1", "[::1]", ...extra.map((h) => String(h).toLowerCase())].includes(m[1].toLowerCase());
}

/** Hostnames out of a list of URLs or bare hosts (PUBLIC_URL, SITE, ALLOWED_ORIGINS). */
export function hostsOf(list) {
  const out = [];
  for (const v of list) {
    if (!v) continue;
    try { out.push(new URL(v.includes("://") ? v : `http://${v}`).hostname); } catch { /* ignore junk */ }
  }
  return out;
}

export const isLoopbackHost = (h) => h === "localhost" || h === "::1" || /^127\./.test(h);

/**
 * deps: { chainId, verifyingContract, ownerOf(tokenId) -> address, agentInfo(tokenId) -> {name, traits},
 *         verifySignature(owner, typedData, signature) -> bool }
 */
export function createWorldServer({ port = 8788, server, deps, origins = null, trustProxy = false, hosts = null, now = () => Date.now(), limits = {} }) {
  const L = { perIp: 4, global: 500, connectsPerMin: 30, rpcHellosPerMin: 10, msgPerSec: 15, maxViolations: 40, helloMs: 5000, recheckMs: 60_000, maxResumable: 2000, maxIpKeys: 10_000, ...limits };
  const { walkable } = buildDistrict();
  const wss = new WebSocketServer({
    ...(server ? { server } : { port }), maxPayload: 512,
    // hosts (loopback-bound servers only): a foreign Host header is DNS rebinding
    ...(hosts ? { verifyClient: (info, cb) => (hostAllowed(info.req.headers.host, hosts) ? cb(true) : cb(false, 421, "misdirected")) } : {}),
  });
  const players = new Map(); // id -> player
  const rooms = new Map(); // room name -> Set<id>
  const resumable = new Map(); // resumeToken -> { player, until }
  const perIp = new Map();
  const ipRate = new Map(); // `${kind}:${ip}` -> timestamps (sliding minute)
  const overRate = (key, max) => {
    if (!ipRate.has(key) && ipRate.size >= L.maxIpKeys) {
      pruneRates();
      if (ipRate.size >= L.maxIpKeys) return true; // table full of live keys: fail closed rather than grow
    }
    const ts = (ipRate.get(key) || []).filter((t) => t > now() - 60_000);
    ts.push(now());
    ipRate.set(key, ts);
    return ts.length > max;
  };
  const pruneRates = () => {
    for (const [k, ts] of ipRate) if (!ts.some((t) => t > now() - 60_000)) ipRate.delete(k);
  };
  const send = (ws, msg) => ws.readyState === 1 && ws.bufferedAmount < 64_000 && ws.send(JSON.stringify(msg));
  const pub = (p) => ({ id: p.id, kind: p.kind, tokenId: p.tokenId, name: p.name, traits: p.traits, x: qPos(p.x), z: qPos(p.z), yaw: qYaw(p.yaw) });

  function roomFor(kind) {
    for (let n = 1; ; n++) {
      const name = `${DISTRICT}#${n}`;
      const ids = rooms.get(name) || new Set();
      const guests = [...ids].filter((id) => players.get(id)?.kind === "guest").length;
      if (ids.size < ROOM_CAP && (kind !== "guest" || guests < GUEST_CAP)) {
        rooms.set(name, ids);
        return name;
      }
    }
  }
  const broadcast = (room, msg, except) => {
    for (const id of rooms.get(room) || []) if (id !== except) send(players.get(id).ws, msg);
  };

  function enter(ws, p) {
    if (ws.readyState !== 1) return; // socket closed while we were verifying: no ghost session
    p.ws = ws;
    p.room ??= roomFor(p.kind);
    rooms.get(p.room)?.add(p.id) ?? rooms.set(p.room, new Set([p.id]));
    players.set(p.id, p);
    p.resumeToken = hex(16);
    ws.player = p;
    send(ws, { t: "welcome", v: PROTOCOL, you: pub(p), room: p.room, resumeToken: p.resumeToken, players: [...rooms.get(p.room)].filter((id) => id !== p.id).map((id) => pub(players.get(id))) });
    broadcast(p.room, { t: "join", p: pub(p) }, p.id);
  }

  function leave(p, { keepResume = true } = {}) {
    if (!players.has(p.id)) return;
    players.delete(p.id);
    rooms.get(p.room)?.delete(p.id);
    if (rooms.get(p.room)?.size === 0) rooms.delete(p.room);
    broadcast(p.room, { t: "leave", id: p.id });
    if (keepResume && p.kind === "holder" && resumable.size < L.maxResumable) resumable.set(p.resumeToken, { player: p, until: now() + RESUME_SECONDS * 1000 });
  }

  async function hello(ws, m) {
    if (m.v !== PROTOCOL) return fail(ws, "protocol");
    if (m.mode === "resume") {
      const r = resumable.get(m.token);
      if (!r || r.until < now()) return fail(ws, "resume_expired");
      resumable.delete(m.token);
      if ([...players.values()].some((q) => q.tokenId === r.player.tokenId)) return fail(ws, "session_active");
      const o = await deps.ownerOf(r.player.tokenId).catch(() => null);
      if (!o || o.toLowerCase() !== r.player.owner.toLowerCase()) return fail(ws, "not_owner");
      const room = rooms.get(r.player.room);
      return enter(ws, { ...r.player, ws: null, room: room && room.size >= ROOM_CAP ? null : r.player.room, last: now(), budget: 0 });
    }
    if (m.mode === "guest") return enter(ws, { id: `v-${hex(4).slice(2)}`, kind: "guest", tokenId: 0, name: "Visitor", traits: null, x: SPAWN.x, z: SPAWN.z, yaw: Math.PI, last: now(), budget: 0 });
    if (m.mode !== "holder") return fail(ws, "bad_hello");
    // cheap checks first, chain calls last
    const tokenId = Number(m.tokenId);
    if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > 1024) return fail(ws, "bad_token");
    if (!Number.isInteger(m.deadline) || m.deadline < now() / 1000 || m.deadline > now() / 1000 + 300) return fail(ws, "bad_deadline");
    if (typeof m.signature !== "string" || typeof m.owner !== "string") return fail(ws, "bad_hello");
    const td = joinTypedData({ chainId: deps.chainId, verifyingContract: deps.verifyingContract, tokenId, owner: m.owner, district: DISTRICT, nonce: ws.nonce, deadline: m.deadline });
    ws.nonce = null; // single use, consumed before any await
    let recovered = null;
    try {
      recovered = verifyTypedData(td.domain, td.types, td.value, m.signature);
    } catch {}
    const eoaMatch = recovered && recovered.toLowerCase() === m.owner.toLowerCase();
    // contract wallets need RPC calls even to reject: rate-limit them per IP
    if (!eoaMatch && overRate(`rpc:${ws.ip}`, L.rpcHellosPerMin)) return fail(ws, "rate_limited");
    let owner;
    try {
      owner = await deps.ownerOf(tokenId);
    } catch {
      return fail(ws, "unknown_agent");
    }
    if (owner.toLowerCase() !== m.owner.toLowerCase() || !(await deps.verifySignature(owner, td, m.signature))) return fail(ws, "not_owner");
    const info = await deps.agentInfo(tokenId);
    if (ws.readyState !== 1) return;
    // one live session per agent: the newest verified join replaces the old one
    for (const q of players.values()) if (q.tokenId === tokenId) kick(q, "session_replaced");
    enter(ws, { id: `a-${tokenId}`, kind: "holder", tokenId, owner, name: info.name, traits: info.traits, x: SPAWN.x, z: SPAWN.z, yaw: Math.PI, last: now(), budget: 0, checkedAt: now() });
  }

  function move(p, m) {
    if (![m.x, m.z, m.yaw].every(Number.isFinite)) return;
    const t = now();
    // distance budget earned from server time (max 1 m banked): no idle-then-jump, no burst speed hacks
    p.budget = Math.min(1, p.budget + (MAX_SPEED * (t - p.last)) / 1000);
    p.last = t;
    const dx = m.x - p.x;
    const dz = m.z - p.z;
    const d = Math.hypot(dx, dz);
    const allowed = Math.min(d, p.budget);
    if (allowed > 0) {
      // walk the segment in <= 0.2 m sub-steps so walls can't be crossed, sliding along them
      const steps = Math.ceil(allowed / 0.2);
      const sx = (dx / d) * (allowed / steps);
      const sz = (dz / d) * (allowed / steps);
      let moved = 0;
      for (let i = 0; i < steps; i++) {
        const nx = p.x + sx;
        const nz = p.z + sz;
        if (walkable(nx, nz)) [p.x, p.z] = [nx, nz];
        else if (walkable(nx, p.z)) p.x = nx;
        else if (walkable(p.x, nz)) p.z = nz;
        else break;
        moved += Math.hypot(sx, sz);
      }
      p.budget -= moved;
    }
    p.yaw = ((m.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    p.dirty = true;
    if (Math.hypot(m.x - p.x, m.z - p.z) > 0.6) send(p.ws, { t: "correct", x: qPos(p.x), z: qPos(p.z) });
  }

  function emote(p, m) {
    if (!EMOTES.includes(m.e) || now() - (p.emoteAt || 0) < 1000) return;
    p.emoteAt = now();
    broadcast(p.room, { t: "emote", id: p.id, e: m.e });
  }

  function fail(ws, code) {
    send(ws, { t: "error", code });
    ws.close(4000, code);
  }

  function kick(p, reason) {
    send(p.ws, { t: "kicked", reason });
    leave(p, { keepResume: false });
    p.ws.close(4001, reason);
  }

  wss.on("connection", (ws, req) => {
    ws.on("error", () => ws.terminate()); // first: even rejected sockets must never crash the process
    const fwd = trustProxy && typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",").at(-1).trim() : null; // rightmost = appended by our proxy
    const ip = normalizeIp(fwd || req.socket.remoteAddress);
    ws.ip = ip;
    if (overRate(`conn:${ip}`, L.connectsPerMin)) return ws.close(4029, "rate_limited");
    const origin = req.headers.origin;
    if (origins && origin && !origins.includes(origin)) return ws.close(4003, "origin");
    if (wss.clients.size > L.global || (perIp.get(ip) || 0) >= L.perIp) return ws.close(4029, "busy");
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.counted = true;
    ws.nonce = hex(32);
    ws.alive = true;
    ws.bucket = { tokens: L.msgPerSec, at: now(), violations: 0 };
    send(ws, { t: "challenge", v: PROTOCOL, nonce: ws.nonce, district: DISTRICT, expiresAt: Math.floor(now() / 1000) + 300 });
    const helloTimer = setTimeout(() => !ws.player && ws.close(4008, "hello_timeout"), L.helloMs);

    ws.on("pong", () => (ws.alive = true));
    ws.on("message", async (raw) => {
      const b = ws.bucket;
      b.tokens = Math.min(L.msgPerSec, b.tokens + ((now() - b.at) / 1000) * L.msgPerSec);
      b.at = now();
      if (b.tokens < 1) {
        if (++b.violations > L.maxViolations) ws.close(4029, "flood");
        return;
      }
      b.tokens -= 1;
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      if (!ws.player) {
        if (m.t === "hello" && !ws.helloing) {
          ws.helloing = true;
          await hello(ws, m).catch(() => fail(ws, "server_error"));
          ws.helloing = false;
        }
        return;
      }
      if (m.t === "move") move(ws.player, m);
      else if (m.t === "emote") emote(ws.player, m);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (ws.counted) {
        const n = (perIp.get(ip) || 1) - 1;
        if (n > 0) perIp.set(ip, n);
        else perIp.delete(ip);
      }
      if (ws.player && players.get(ws.player.id)?.ws === ws) leave(ws.player);
    });
  });

  // 10 Hz snapshots: changed players only, full keyframe every 2 s
  let tick = 0;
  const snapTimer = setInterval(() => {
    tick++;
    const key = tick % 20 === 0;
    for (const [room, ids] of rooms) {
      const ps = [...ids].map((id) => players.get(id)).filter((p) => p && (key || p.dirty)).map((p) => [p.id, qPos(p.x), qPos(p.z), qYaw(p.yaw)]);
      if (ps.length) broadcast(room, { t: "snap", k: key, ps });
    }
    for (const p of players.values()) p.dirty = false;
  }, 100);

  // heartbeat, resume expiry, ownership re-check (a sold agent drops its session)
  let housekeeping = false;
  const houseTimer = setInterval(async () => {
    if (housekeeping) return;
    housekeeping = true;
    try {
      await house();
    } catch (e) {
      console.error("housekeeping:", e.message);
    } finally {
      housekeeping = false;
    }
  }, 15_000);
  async function house() {
    pruneRates();
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      ws.alive = false;
      ws.ping();
    }
    for (const [k, r] of resumable) if (r.until < now()) resumable.delete(k);
    for (const p of [...players.values()]) {
      if (p.kind !== "holder" || now() - p.checkedAt < L.recheckMs) continue;
      p.checkedAt = now();
      const o = await deps.ownerOf(p.tokenId).catch(() => null);
      if (o && o.toLowerCase() !== p.owner.toLowerCase() && players.get(p.id) === p) kick(p, "ownership_changed");
    }
  }

  wss.on("error", (e) => console.error("world server error:", e.message));
  const ready = server ? Promise.resolve() : new Promise((r) => wss.once("listening", r));

  return {
    wss,
    ready,
    stats: () => ({ players: players.size, rooms: Object.fromEntries([...rooms].map(([k, v]) => [k, v.size])) }),
    close: () => {
      clearInterval(snapTimer);
      clearInterval(houseTimer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((r) => wss.close(r));
    },
  };
}
