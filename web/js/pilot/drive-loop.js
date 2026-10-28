// Phone-side drive loop: link state machine, one latest-wins command slot, a fixed 33 ms sender, STOP, ARM and
// reconnect with backoff. Pure (clock and transport injected), so the tests drive it with a fake clock.
//
// DISCONNECTED -> (connect) -> CONNECTED_LATCHED -> (arm, after a user gesture) -> ARMED <-> DRIVING (dead-man held)
// Any STOP, a latched AX_STATE from the bridge, a stalled timer or a lost link drops back to CONNECTED_LATCHED or
// DISCONNECTED. Nothing ever re-arms on its own. These checks are UX: the bridge firmware enforces safety.
import * as P from "./ax-proto.js";

export const LINK = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  LATCHED: "connected_latched",
  ARMED: "armed",
  DRIVING: "driving",
};
export const TICK_MS = 33;
export const STALL_MS = 250;
export const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 4000];
export const MAX_LEASE_MS = 3000; // holdFor(): the longest a drive can run without being asked again (used by the AI Pilot)
export const ARM_CONFIRM_MS = 600; // the bridge must report ARMED within this time, or the ARM counts as refused

const defaultNonce = () => {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const a = new Uint32Array(1);
    do c.getRandomValues(a);
    while (a[0] === 0);
    return a[0];
  }
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
};

/**
 * createDriveLoop({ transport, clock, nonce, onChange })
 * clock: { now, setInterval, clearInterval, setTimeout, clearTimeout } (see twin-transport.js realTimers).
 */
export function createDriveLoop({ transport, clock, nonce = defaultNonce, onChange = () => {} }) {
  let link = LINK.DISCONNECTED;
  let info = null;
  let body = 0;
  let compatible = false;
  let message = "";
  let last = null; // decoded AX_STATE
  let seq = Math.floor(Math.random() * 0xffff);
  let timer = null;
  let lastTick = 0;
  let held = false;
  let speed = 60;
  let wheels = [0, 0];
  let targets = []; // deci per joint, latest wins
  let userClosed = false;
  let reconnectTimer = null;
  let attempt = 0;
  let sent = 0;
  let generation = 0; // invalidates in-flight async work after a disconnect
  let established = false; // the link reached LATCHED once: only then is a drop worth reconnecting
  let stops = 0; // STOP presses, so an ARM in flight knows it was overtaken
  let armConfirmed = false;
  let armDeadline = 0;
  let leaseEnd = 0; // holdFor(): the drive ends by itself at this time (0 = no lease)
  let recorder = null; // opt-in passive demonstration recorder (setRecorder); null = nothing recorded, nothing allocated

  const snap = () => ({
    link, info, body, compatible, message, state: last, held, speed, wheels: wheels.slice(), targets: targets.slice(), seq, sent,
    reconnecting: reconnectTimer !== null, attempt,
  });
  const emit = () => {
    try {
      onChange(snap());
    } catch {} // a UI callback never breaks the loop
  };
  const set = (l, msg) => {
    link = l;
    if (msg !== undefined) message = msg;
    emit();
  };

  function startSender() {
    stopSender();
    lastTick = clock.now();
    timer = clock.setInterval(tick, TICK_MS);
  }
  function stopSender() {
    if (timer !== null) clock.clearInterval(timer);
    timer = null;
  }

  function frame() {
    seq = (seq + 1) & 0xffff;
    if (P.BODIES[body].drive) {
      const [l, r] = held ? wheels : [0, 0];
      return P.encodeDrive({ seq, mask: P.DRIVE_MASK.WHEELS | P.DRIVE_MASK.PAN | P.DRIVE_MASK.TILT, left: l, right: r, pan: targets[0], tilt: targets[1], speed });
    }
    return P.encodeJoints({ seq, mask: P.fullMask(body), targets, speed });
  }

  /** Passive tap on the clamped values of the frame just built. Reads only; a recorder that throws is ignored. */
  function record() {
    try {
      const drive = P.BODIES[body].drive;
      recorder.push({ joints: targets.map((d) => d / 10), drive: drive ? (held ? wheels.slice() : [0, 0]) : undefined });
    } catch {} // a recorder never breaks the loop
  }

  function tick() {
    const now = clock.now();
    if (link !== LINK.ARMED && link !== LINK.DRIVING) return stopSender();
    if (now - lastTick > TICK_MS + STALL_MS) {
      lastTick = now;
      return api.stop("The phone paused (busy or in the background), so the robot was told to hold.");
    }
    lastTick = now;
    if (!armConfirmed && now > armDeadline) {
      stopSender();
      held = false;
      leaseEnd = 0;
      wheels = [0, 0];
      const f = last ? P.faultText(last.fault) : [];
      return set(LINK.LATCHED, `ARM refused by the robot${f.length ? `: ${f.join(", ")}` : " (no confirmation)"}.`);
    }
    if (leaseEnd && now >= leaseEnd) {
      // the lease ran out: this very frame carries zero wheels (the lease is the backstop if the caller froze)
      leaseEnd = 0;
      held = false;
      wheels = [0, 0];
      if (link === LINK.DRIVING) set(LINK.ARMED);
    }
    let bytes;
    try {
      bytes = frame();
    } catch {
      return api.stop("A command could not be built, so the robot was told to hold. Press ARM to continue."); // never send a guess
    }
    sent++;
    if (recorder) record();
    transport.sendCmd(bytes).catch(() => {}); // write without response: the latest frame wins, a lost one is replaced in 33 ms
  }

  function onNotify(bytes) {
    let st;
    try {
      st = P.decodeState(bytes);
    } catch {
      return;
    }
    last = st;
    if ((link === LINK.ARMED || link === LINK.DRIVING) && st.state === P.STATE.ARMED) armConfirmed = true;
    // before the bridge confirms the ARM, older "latched" reports are still in flight: ignore them
    if ((link === LINK.ARMED || link === LINK.DRIVING) && st.state !== P.STATE.ARMED && armConfirmed) {
      stopSender();
      held = false;
      leaseEnd = 0;
      wheels = [0, 0];
      set(LINK.LATCHED, `The robot is holding: ${P.LATCH_TEXT[st.latch] || "latched"}. Press ARM to continue.`);
      return;
    }
    emit();
  }

  function onDisconnect() {
    const wasUp = link === LINK.LATCHED || link === LINK.ARMED || link === LINK.DRIVING;
    stopSender();
    held = false;
    leaseEnd = 0;
    wheels = [0, 0];
    generation++;
    if (userClosed) return set(LINK.DISCONNECTED, "Disconnected.");
    // a drop during the first connect is a failed pairing, not a lost link: retrying would ask for the passkey
    // again and again, and the bridge locks pairing after 5 failures
    if (!established) return set(LINK.DISCONNECTED, "Could not connect: the robot closed the link. Check the passkey on its sticker (hold BOOT 2 s to open pairing), then press Connect.");
    if (wasUp) attempt = 0; // a drop during a reconnect try keeps counting tries
    set(LINK.DISCONNECTED, "Link lost. The robot holds by itself. Reconnecting…");
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (attempt >= RECONNECT_DELAYS.length) {
      reconnectTimer = null;
      return set(LINK.DISCONNECTED, "Could not reconnect. Check the robot's power and press Connect.");
    }
    const delay = RECONNECT_DELAYS[attempt++];
    const gen = generation;
    const stale = () => userClosed || gen !== generation; // Disconnect pressed, or another drop took over
    reconnectTimer = clock.setTimeout(async () => {
      reconnectTimer = null;
      if (stale()) return;
      try {
        set(LINK.CONNECTING, `Reconnecting (try ${attempt} of ${RECONNECT_DELAYS.length})…`);
        await transport.reconnect();
        if (stale()) return void transport.disconnect().catch(() => {});
        await afterConnect("Reconnected. The robot stays stopped until you press ARM.");
      } catch {
        if (!stale()) scheduleReconnect();
      }
    }, delay);
    emit();
  }

  async function afterConnect(okMsg) {
    const gen = generation;
    info = P.decodeInfo(await transport.readInfo());
    if (gen !== generation || userClosed) return;
    body = info.body;
    compatible = info.protoMajor === P.PROTO_MAJOR && !!P.BODIES[body];
    const def = P.BODIES[body];
    targets = def ? def.joints.map((j) => j.home) : [];
    if (transport.readState) {
      try {
        last = P.decodeState(await transport.readState());
      } catch {}
    }
    if (gen !== generation || userClosed) return;
    established = true;
    if (!compatible) {
      const why = !def ? `an unknown body (${info.body})` : `protocol ${info.protoMajor}.x, this app speaks ${P.PROTO_MAJOR}.x`;
      return set(LINK.LATCHED, `This bridge runs ${why}. Driving is disabled: update the app or the firmware.`);
    }
    set(LINK.LATCHED, okMsg);
  }

  const api = {
    get snapshot() {
      return snap();
    },
    get link() {
      return link;
    },

    async connect() {
      if (link !== LINK.DISCONNECTED) return;
      userClosed = false;
      established = false;
      if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer), (reconnectTimer = null);
      transport.onNotify(onNotify);
      transport.onDisconnect(onDisconnect);
      set(LINK.CONNECTING, "Connecting…");
      try {
        await transport.connect();
        await afterConnect("Connected. Press ARM when the robot is clear.");
      } catch (e) {
        generation++; // anything still in flight belongs to this failed try
        try {
          await transport.disconnect(); // free the bridge's single connection slot
        } catch {}
        set(LINK.DISCONNECTED, e && e.name === "NotFoundError" ? "No robot picked." : `Could not connect: ${e && e.message ? e.message : e}`);
      }
    },

    async disconnect() {
      userClosed = true;
      established = false;
      if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer), (reconnectTimer = null);
      if (link === LINK.ARMED || link === LINK.DRIVING) await api.stop("Disconnected by you.");
      stopSender();
      try {
        await transport.disconnect();
      } catch {}
      generation++;
      set(LINK.DISCONNECTED, "Disconnected.");
    },

    /** Call only from a user gesture (click / keydown). */
    async arm() {
      if (link !== LINK.LATCHED) return false;
      if (!compatible) return set(LINK.LATCHED, message), false;
      const def = P.BODIES[body];
      // start from where the robot is, so ARM never moves anything
      if (last && last.positions.length >= def.joints.length) targets = last.positions.slice(0, def.joints.length);
      wheels = [0, 0];
      held = false;
      leaseEnd = 0;
      const gen = generation;
      const stopsBefore = stops;
      const overtaken = () => gen !== generation || stops !== stopsBefore || link !== LINK.LATCHED; // link lost or STOP pressed
      try {
        await transport.writeArm(P.encodeArm({ nonce: nonce(), seqBase: seq }));
      } catch (e) {
        if (overtaken()) return false;
        const why = e && e.code === P.ERR.FAULT ? `the robot reports a fault (${P.faultText(last ? last.fault : 0).join(", ") || "check power"})` : e && e.code === P.ERR.STATE ? "it is not in a state that can be armed" : "the write failed";
        set(LINK.LATCHED, `ARM refused: ${why}.`);
        return false;
      }
      if (overtaken()) return false; // the queued STOP already latched the bridge again
      // the firmware cannot fail a GATT write with a reason: the ARM counts once AX_STATE says ARMED (see tick)
      armConfirmed = false;
      armDeadline = clock.now() + ARM_CONFIRM_MS;
      set(LINK.ARMED, P.BODIES[body].drive ? "Armed. Hold to drive; release to stop." : "Armed. The robot follows your controls; STOP holds it.");
      startSender();
      return true;
    },

    /** STOP: local first (sender off), then AX_STOP. Works from any state. */
    async stop(reason = "Stopped by you.", { relax = false } = {}) {
      stops++;
      const wasActive = link === LINK.ARMED || link === LINK.DRIVING;
      stopSender();
      held = false;
      leaseEnd = 0;
      wheels = [0, 0];
      if (wasActive) set(LINK.LATCHED, reason);
      else if (link !== LINK.DISCONNECTED && link !== LINK.CONNECTING) set(link, reason);
      if (link === LINK.DISCONNECTED || link === LINK.CONNECTING) return;
      for (let i = 0; i < 3; i++) {
        try {
          await transport.writeStop(P.encodeStop(relax ? P.STOP_REASON.RELAX : P.STOP_REASON.HOLD));
          return;
        } catch {} // the watchdog holds the robot within 250 ms anyway
      }
    },

    /** Dead-man: true while a finger/key holds the drive control. Release zeroes the wheels at once. */
    setHeld(on) {
      leaseEnd = 0; // a human on the controls (or anyone) takes over: an old lease must never cut their drive
      if (on && link === LINK.ARMED) set(LINK.DRIVING);
      else if (!on) {
        held = false;
        wheels = [0, 0];
        if (link === LINK.DRIVING) set(LINK.ARMED);
        return;
      }
      held = link === LINK.DRIVING;
    },
    /**
     * Drive for at most `ms` (capped at MAX_LEASE_MS) and then stop by itself: tick() sends zero wheels in the first
     * frame at or after the end. Any setHeld() or STOP ends the lease earlier. ARMED or DRIVING only, wheeled bodies
     * only, and never while a human holds the controls (held without a lease); returns false (and does nothing)
     * otherwise. Used by the AI Pilot: it never has to remember to let go.
     */
    holdFor(ms, x = 0, y = 1) {
      const def = P.BODIES[body];
      if ((link !== LINK.ARMED && link !== LINK.DRIVING) || !def || !def.drive) return false;
      if (held && !leaseEnd) return false; // a human is driving
      const dur = Math.min(MAX_LEASE_MS, Number(ms));
      if (!(dur > 0)) return false;
      api.setHeld(true);
      api.setStick(x, y);
      leaseEnd = clock.now() + dur;
      return true;
    },
    /** x = turn, y = forward, both -1..1 (arcade mix). */
    setStick(x, y) {
      const cx = Math.max(-1, Math.min(1, x || 0));
      const cy = Math.max(-1, Math.min(1, y || 0));
      const l = cy + cx;
      const r = cy - cx;
      const k = Math.max(1, Math.abs(l), Math.abs(r));
      wheels = held ? [Math.round((l / k) * P.DRIVE_MAX), Math.round((r / k) * P.DRIVE_MAX)] : [0, 0];
    },
    /** Joint target in degrees by joint name (clamped to the body table; the bridge clamps again). */
    setJoint(name, deg) {
      const def = P.BODIES[body];
      if (!def || typeof deg !== "number" || !Number.isFinite(deg)) return; // NaN never becomes a target
      const i = def.joints.findIndex((j) => j.name === name);
      if (i < 0) return;
      const j = def.joints[i];
      targets[i] = Math.max(j.min, Math.min(j.max, Math.round(deg * 10)));
    },
    setPose(map) {
      for (const [k, v] of Object.entries(map)) api.setJoint(k, v);
    },
    setSpeed(pct) {
      speed = Math.max(5, Math.min(100, Math.round(pct)));
    },
    /**
     * Opt-in demonstration recording: `rec.push({ joints, drive })` gets the clamped values of every frame the loop
     * sends (joints in degrees, wheels -1000..1000). null (the default) turns it off. It is read-only and cannot
     * change a frame, the watchdog, STOP, the lease or ARM.
     */
    setRecorder(rec) {
      if (rec !== null && !(rec && typeof rec.push === "function")) throw new TypeError("a recorder needs push(sample), or null");
      recorder = rec;
    },
    /** For tests: run one sender tick now. */
    _tick: tick,
  };
  return api;
}
