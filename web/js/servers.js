// Connectors: point the site at your own Proving Grounds and Neo-Forge servers (self-hosting).
// Pure module (Node-tested). Values are set only from the "Servers" dialog, never from a URL, so a link cannot
// silently redirect a visitor's runs or session to someone else's server.
export const SERVERS_KEY = "openforge.servers";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Normalised URL, or null. Proving: https (http only for localhost). World: wss (ws only for localhost). */
export function validServerUrl(kind, value) {
  if (typeof value !== "string" || value.length > 200) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  const ok = kind === "proving" ? u.protocol === "https:" || (u.protocol === "http:" && local) : kind === "world" ? u.protocol === "wss:" || (u.protocol === "ws:" && local) : false;
  if (!ok || u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Config with the user's servers applied (invalid or missing entries keep the published defaults). */
export function applyServers(config, stored) {
  const out = { ...config };
  const proving = validServerUrl("proving", stored?.provingApi);
  const world = validServerUrl("world", stored?.worldWs);
  if (proving) out.provingApi = proving;
  if (world) out.worldWs = world;
  out.customServers = Boolean(proving || world);
  return out;
}
