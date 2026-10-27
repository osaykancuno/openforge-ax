// Minimal static server for web/ (dev, demo and self-hosting). Usage: node scripts/serve.mjs [port]
// HOST: bind address. Default 127.0.0.1 on the local chain (31337); otherwise all interfaces (behind a proxy).
//   HOST=0.0.0.0 opens it to the LAN (e.g. to try the Phone Brain from a phone): then any Host header is accepted.
//   Bound to loopback, requests whose Host is not localhost / 127.0.0.1 / [::1] / PUBLIC_URL / SITE get 421 (DNS rebinding).
// SITE_OVERRIDES='{"provingApi":"...","worldWs":"..."}' is merged into /deployment.json (npm run selfhost sets it).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostAllowed, hostsOf, isLoopbackHost } from "./world/core.mjs";

const root = fileURLToPath(new URL("../web/", import.meta.url));
const port = Number(process.argv[2] || 8080);
const chainId = (() => { try { return JSON.parse(readFileSync(join(root, "deployment.json"), "utf8")).chainId; } catch { return null; } })();
const HOST = process.env.HOST || (chainId === 31337 ? "127.0.0.1" : "");
const guard = HOST && isLoopbackHost(HOST) ? hostsOf([process.env.PUBLIC_URL, process.env.SITE]) : null;
const OVERRIDES = process.env.SITE_OVERRIDES ? JSON.parse(process.env.SITE_OVERRIDES) : null;
const PILOT_POLICY = "bluetooth=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(), screen-wake-lock=(self), microphone=(), geolocation=(), serial=()";
const TYPES = {
  ".webmanifest": "application/manifest+json",
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
// Same headers as web/_headers (static hosts); pages also carry a CSP meta tag.
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), serial=(), bluetooth=()",
};

export const createHandler = (guard, rootDir = root) => async (req, res) => {
  if (guard && !hostAllowed(req.headers.host, guard)) return res.writeHead(421, SECURITY).end("misdirected request");
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    let file = join(rootDir, p);
    if (!file.startsWith(rootDir)) return res.writeHead(403, SECURITY).end();
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    let body = await readFile(file);
    if (OVERRIDES && p === "deployment.json") body = JSON.stringify({ ...JSON.parse(body), ...OVERRIDES });
    // Robot Link needs Web Serial and the camera (film mode); Phone Brain needs camera, Bluetooth and motion sensors; other pages keep them off
    const camera = p === "robot.html" ? { "Permissions-Policy": SECURITY["Permissions-Policy"].replace("camera=()", "camera=(self)").replace("serial=()", "serial=(self)") }
      : p === "pilot.html" ? { "Permissions-Policy": PILOT_POLICY } : {};
    res.writeHead(200, { ...SECURITY, ...camera, "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch (e) {
    // malformed URLs (URIError) are the client's fault; anything else is a missing file
    if (!res.headersSent) res.writeHead(e instanceof URIError ? 400 : 404, SECURITY).end(e instanceof URIError ? "bad request" : "not found");
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  createServer(createHandler(guard)).listen(port, ...(HOST ? [HOST] : []), () => console.log(`OpenForge web at http://localhost:${port}${HOST ? ` (bound to ${HOST})` : ""}`));
}
