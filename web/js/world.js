import { CONFIG } from "./config.js";
import { loadConfig, renderChrome, onWallet, ownedBy, tokenMeta, toast, friendlyError, isDeployed } from "./chain.js";
import { createWorldView } from "./world/world-view.js";
import { buildDistrict, nearStation, MAX_SPEED } from "./world/district.js";
import { PROTOCOL, EMOTES, joinTypedData, dqYaw } from "./world/protocol.js";

await loadConfig();
renderChrome("world");

const $ = (id) => document.getElementById(id);
const view = createWorldView($("view"));
const { walkable } = buildDistrict();
const WS_URL = CONFIG.worldWs || ""; // retired: no server configured means offline (never a guess at localhost)
let signer = null;
let ws = null;
let me = null; // { id, tokenId, x, z, yaw }
let resumeToken = null;
let kicked = false;
const keys = new Set();

// ---------------------------------------------------------------- identity
onWallet(async (s) => {
  signer = s;
  if (!s || !isDeployed()) return;
  const ids = await ownedBy(s.addressChecksum);
  const metas = await Promise.all(ids.map((id) => tokenMeta(id)));
  ids.forEach((id, i) => $("who").add(new Option(metas[i].name, String(id))));
  if (ids.length) $("who").value = String(ids[0]);
  $("whoInfo").textContent = ids.length ? "You will appear as your agent, built from its on-chain traits." : "This wallet owns no agents yet: enter as a Visitor.";
});

// ---------------------------------------------------------------- networking
function connect(mode) {
  if (!WS_URL) return toast("Neo-Forge is retired and no world server is configured.", true);
  ws = new WebSocket(WS_URL);
  ws.onmessage = async (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === "challenge") return sendHello(m, mode);
    if (m.t === "welcome") return welcome(m);
    if (m.t === "join") return view.upsert(unq(m.p)), online();
    if (m.t === "leave") return view.remove(m.id), online();
    if (m.t === "snap") for (const [id, x, z, yaw] of m.ps) if (id !== me?.id) view.setTarget(id, x / 100, z / 100, dqYaw(yaw));
    if (m.t === "emote") view.emote(m.id, m.e);
    if (m.t === "correct" && me) [me.x, me.z] = [m.x / 100, m.z / 100];
    if (m.t === "kicked") {
      kicked = true;
      toast(m.reason === "session_replaced" ? "Your agent entered Neo-Forge from another window." : "Your agent changed owner.", true);
    }
    if (m.t === "error") toast(errorText(m.code), true);
  };
  ws.onclose = () => {
    if (kicked || !me) return showJoin();
    // mobile networks drop: resume the same session without a new signature
    toast("Connection lost, reconnecting…");
    setTimeout(() => connect("resume"), 1000);
  };
}

async function sendHello({ nonce }, mode) {
  if (mode === "resume" && resumeToken) return ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, mode: "resume", token: resumeToken }));
  const tokenId = Number($("who").value);
  if (!tokenId) return ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, mode: "guest" }));
  try {
    const deadline = Math.floor(Date.now() / 1000) + 120;
    const td = joinTypedData({ chainId: CONFIG.chainId, verifyingContract: CONFIG.reputation, tokenId, owner: signer.addressChecksum, district: "rust-docks", nonce, deadline });
    toast("Sign the Neo-Forge entry message: free, no gas, it cannot move any funds.");
    const signature = await signer.signTypedData(td.domain, td.types, td.value);
    ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, mode: "holder", tokenId, owner: signer.addressChecksum, deadline, signature }));
  } catch (e) {
    toast(friendlyError(e), true);
    ws.close();
  }
}

const unq = (p) => ({ ...p, x: p.x / 100, z: p.z / 100, yaw: dqYaw(p.yaw) });

function welcome(m) {
  const you = unq(m.you);
  me = { id: you.id, tokenId: you.tokenId, x: you.x, z: you.z, yaw: you.yaw };
  resumeToken = m.resumeToken;
  view.upsert(you);
  view.setLocal(you.id);
  m.players.forEach((p) => view.upsert(unq(p)));
  $("hudRoom").textContent = m.room.replace("rust-docks", "RUST DOCKS").toUpperCase();
  $("joinCard").hidden = true;
  online();
  toast(`Welcome to Neo-Forge, ${you.name}.`);
}

const online = () => ($("hudOnline").textContent = `${view.count()} ONLINE`);
const errorText = (c) => ({ not_owner: "This wallet doesn't own that agent.", resume_expired: "Session expired, please enter again.", busy: "Neo-Forge is full right now, try again soon." })[c] || `Server error (${c}).`;

function showJoin() {
  me = null;
  $("joinCard").hidden = false;
}

$("enterBtn").onclick = () => {
  if (Number($("who").value) && !signer) return toast("Connect your wallet first.", true);
  kicked = false;
  connect("fresh");
};

// ---------------------------------------------------------------- input + local movement
const TURN = 2.6;
const SPEED = MAX_SPEED * 0.85;
addEventListener("keydown", (e) => {
  if (!me || e.target.tagName === "SELECT") return;
  const map = { ArrowUp: "KeyW", ArrowDown: "KeyS", ArrowLeft: "KeyA", ArrowRight: "KeyD" };
  const code = map[e.code] || e.code;
  if (["KeyW", "KeyS", "KeyA", "KeyD"].includes(code)) {
    e.preventDefault();
    keys.add(code);
  }
  const n = Number(e.key);
  if (n >= 1 && n <= 4 && !e.repeat) sendEmote(EMOTES[n - 1]);
  if (e.code === "KeyE" && nearStation(me.x, me.z)) enterStation();
});
addEventListener("keyup", (e) => keys.delete({ ArrowUp: "KeyW", ArrowDown: "KeyS", ArrowLeft: "KeyA", ArrowRight: "KeyD" }[e.code] || e.code));
addEventListener("blur", () => keys.clear());
for (const b of document.querySelectorAll("#movePad button")) {
  const k = b.dataset.k;
  b.addEventListener("pointerdown", (e) => (e.preventDefault(), keys.add(k), b.classList.add("on")));
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => (keys.delete(k), b.classList.remove("on")));
}
for (const b of document.querySelectorAll(".emotes button")) b.onclick = () => sendEmote(b.dataset.e);

function sendEmote(e) {
  if (!me || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: "emote", e }));
}

function enterStation() {
  location.href = `arena.html${me?.tokenId ? `?pilot=${me.tokenId}` : ""}`;
}
$("stationBtn").onclick = enterStation;

let last = performance.now();
let sendAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (me) {
    const k = (c) => (keys.has(c) ? 1 : 0);
    me.yaw += (k("KeyA") - k("KeyD")) * TURN * dt;
    const step = (k("KeyW") - k("KeyS")) * SPEED * dt;
    const nx = me.x + Math.sin(me.yaw) * step;
    const nz = me.z + Math.cos(me.yaw) * step;
    // same walkability grid as the server: slide along walls
    if (walkable(nx, nz)) [me.x, me.z] = [nx, nz];
    else if (walkable(nx, me.z)) me.x = nx;
    else if (walkable(me.x, nz)) me.z = nz;
    view.setTarget(me.id, me.x, me.z, me.yaw);
    sendAcc += dt;
    if (sendAcc >= 0.1 && ws?.readyState === 1) {
      sendAcc = 0;
      ws.send(JSON.stringify({ t: "move", x: +me.x.toFixed(2), z: +me.z.toFixed(2), yaw: +me.yaw.toFixed(3) }));
    }
    $("stationBtn").hidden = !nearStation(me.x, me.z);
  }
  view.update(dt, now / 1000);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
