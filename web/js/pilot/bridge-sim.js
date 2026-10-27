// Reference model of the AX-1 ESP32 bridge firmware (firmware/ax-bridge/ax-bridge.ino): the same state machine,
// limits, watchdog, replay protection and STS bus frames, in pure JS with an injected clock. Used by the 3D twin
// (twin-transport.js), the Node loopback bridge (scripts/loopback-bridge.mjs) and the tests. If you change a rule
// here, change it in the firmware too: the shared test vectors catch codec drift, not logic drift.
import * as P from "./ax-proto.js";
import { BROADCAST, INST, REG, STS3215_MODEL, encodePos, packet, u16 } from "../robot/sts-bus.js";

export const FW_VERSION = 0x0001; // 0.1 (experimental)
export const BATT_HYST_MV = 200; // ARM needs the battery this far above the cutoff
/** Hardware faults that let a held robot go limp after WD_RELAX_MS (a small MTU is not one: it only blocks ARM). */
export const RELAX_FAULTS = P.FAULT.LOW_BATT | P.FAULT.SERVO_FATAL | P.FAULT.SERVO_MISSING | P.FAULT.TORQUE_VERIFY;
export const STS = {
  ACCEL: 100, // x100 steps/s^2, as Robot Link
  TORQUE_LIMIT: 800, // 80 %
  VEL_CAP: Math.ceil((P.MAX_DEG_S * 1.2 * 4096) / 360), // steps/s, a hardware backstop above the firmware rate limit (1229)
  MISSING_TICKS: 5, // consecutive unanswered reads before SERVO_MISSING
};

// ---------------------------------------------------------------- STS3215 bus frames the firmware sends

/** Registers 41..49 for one servo: accel, goal, goal time 0, speed cap, torque limit (RAM only). */
export const motionBlock = (goalSteps) => [STS.ACCEL, ...encodePos(goalSteps), 0, 0, ...u16(STS.VEL_CAP), ...u16(STS.TORQUE_LIMIT)];
/** One SYNC_WRITE per control tick: goal + ACCEL/GOAL_VELOCITY/TORQUE_LIMIT resent every cycle. */
export const stsMotionPacket = (ids, goals) => packet(BROADCAST, INST.SYNC_WRITE, [REG.ACCEL, 9, ...ids.flatMap((id, i) => [id, ...motionBlock(goals[i])])]);
/** TORQUE is only ever 0 or 1 (128 would re-centre the servo and rewrite its offset). */
export const stsTorquePacket = (ids, on) => packet(BROADCAST, INST.SYNC_WRITE, [REG.TORQUE, 1, ...ids.flatMap((id) => [id, on ? 1 : 0])]);
export const stsReadPacket = (id, addr, len) => packet(id, INST.READ, [addr, len]);
export const stsPingPacket = (id) => packet(id, INST.PING);

/**
 * createBridge({ body, now, battMv, servoModel, servoMode, configMode, onNotify })
 * Test hooks: setBattery(mV), setServoFault(i, bool), setTorqueJump(bool), pressBoot(ms).
 */
export function createBridge({ body = P.BODY.ROVER, now = 0, battMv, servoModel = STS3215_MODEL, servoMode = 0, configMode = false, onNotify = null } = {}) {
  const def = P.BODIES[body];
  if (!def) throw new Error(`unknown body ${body}`);
  const hard = def.joints; // compile-time limits: config can only narrow them
  let limits = hard.map((j) => ({ ...j }));
  const n = hard.length;
  const bus = !def.drive; // Desk and Walker: STS3215 bus; Rover: hobby servos + TB6612
  const ids = hard.map((_, i) => i + 1);

  const s = {
    t: now,
    lastTick: now,
    lastNotify: now,
    state: P.STATE.BOOT,
    latch: P.LATCH.BOOT,
    fault: 0,
    torque: false,
    brake: false,
    relaxRequested: false,
    latchedAt: now,
    lastCmdAt: now,
    lastSeq: 0,
    lastNonce: null,
    speed: 100,
    present: hard.map((j) => j.home), // what the servos report (sim physics)
    commanded: hard.map((j) => j.home), // rate-limited goal actually sent
    target: hard.map((j) => j.home), // last accepted target
    drive: [0, 0], // wheel outputs
    driveTarget: [0, 0],
    conn: null,
    advertising: true,
    bonds: new Set(),
    pairingUntil: -1,
    batt: battMv ?? (body === P.BODY.WALKER ? 11400 : 7800),
    servoFault: hard.map(() => false),
    torqueJump: false,
    missing: hard.map(() => 0),
    saved: false,
    lastBus: null, // last STS SYNC_WRITE bytes (bus bodies)
  };

  // ---- boot: torque off, check every servo, never move
  if (configMode) {
    s.state = P.STATE.CONFIG;
    s.latch = P.LATCH.CONFIG;
  } else if (bus && (servoModel !== STS3215_MODEL || servoMode !== 0)) {
    s.state = P.STATE.FAULT;
    s.latch = P.LATCH.BOOT_CHECK;
    if (servoModel !== STS3215_MODEL) s.fault |= P.FAULT.BAD_MODEL;
    if (servoMode !== 0) s.fault |= P.FAULT.BAD_MODE;
  } else {
    s.state = P.STATE.LATCHED;
    s.latch = P.LATCH.BOOT;
  }
  if (bus) s.lastBus = stsTorquePacket(ids, false);

  const clamp = (i, v) => Math.min(limits[i].max, Math.max(limits[i].min, v));
  const authOk = () => s.conn && s.conn.encrypted && s.conn.authenticated;

  function latch(reason) {
    s.state = P.STATE.LATCHED;
    s.latch = reason;
    s.latchedAt = s.t;
    if (s.torque) {
      if (bus) s.commanded = s.present.slice(); // goal = present: hold exactly where it is
      s.brake = true; // DC motors: short brake
    }
    s.target = s.commanded.slice();
    s.drive = [0, 0];
    s.driveTarget = [0, 0];
  }

  function torqueOff() {
    s.torque = false;
    s.brake = false; // TB6612 standby low: coast
    if (bus) s.lastBus = stsTorquePacket(ids, false);
  }

  /** One control tick; dtMs is the real time since the previous one (the firmware caps it at 50 ms). */
  function step(dtMs) {
    const t = s.t;
    if (s.torque && s.batt < def.lowBattMv) {
      s.fault |= P.FAULT.LOW_BATT;
      if (s.state === P.STATE.ARMED) latch(P.LATCH.LOW_BATT);
    }
    if (s.torque && s.servoFault.some(Boolean)) {
      s.fault |= P.FAULT.SERVO_FATAL;
      if (s.state === P.STATE.ARMED) latch(P.LATCH.SERVO_FAULT);
    }
    if (s.state === P.STATE.ARMED && t - s.lastCmdAt >= P.WD_HOLD_MS) latch(P.LATCH.WATCHDOG);
    if (s.state === P.STATE.ARMED) {
      const max = P.maxStepDeci(dtMs, s.speed);
      for (let i = 0; i < n; i++) s.commanded[i] = P.rateStep(s.commanded[i], s.target[i], max);
      for (let k = 0; k < 2; k++) s.drive[k] = P.driveStep(s.drive[k], Math.trunc((s.driveTarget[k] * s.speed) / 100));
    }
    if (s.state === P.STATE.LATCHED && s.torque && (s.relaxRequested || s.fault & RELAX_FAULTS) && t - s.latchedAt >= P.WD_RELAX_MS) torqueOff();
    // physics of the twin: bus servos chase their goal at a finite speed; hobby servos are open loop
    if (s.torque) {
      const servoStep = Math.trunc((3000 * P.CONTROL_MS) / 1000); // 300 deg/s
      for (let i = 0; i < n; i++) s.present[i] = bus ? P.rateStep(s.present[i], s.commanded[i], servoStep) : s.commanded[i];
      if (bus) s.lastBus = stsMotionPacket(ids, s.commanded.map((d) => P.deciToSteps(d)));
    }
  }

  function notifyMaybe() {
    if (!s.conn || s.t - s.lastNotify < P.STATE_MS) return;
    s.lastNotify = s.t;
    if (onNotify) onNotify(api.stateBytes());
  }

  const api = {
    body,
    get snapshot() {
      return {
        state: s.state, latch: s.latch, fault: s.fault, torque: s.torque, brake: s.brake, lastSeq: s.lastSeq, speed: s.speed,
        present: s.present.slice(), commanded: s.commanded.slice(), target: s.target.slice(), drive: s.drive.slice(),
        connected: !!s.conn, advertising: s.advertising, pairing: s.t < s.pairingUntil, bonds: s.bonds.size, saved: s.saved,
        limits: limits.map((j) => ({ ...j })), lastBus: s.lastBus,
      };
    },
    set onNotify(fn) {
      onNotify = fn;
    },

    /** Advance the control loop to `now` in CONTROL_MS ticks, then notify AX_STATE at 10 Hz. */
    tick(nowMs) {
      while (s.lastTick + P.CONTROL_MS <= nowMs) {
        s.lastTick += P.CONTROL_MS;
        s.t = s.lastTick;
        step(P.CONTROL_MS);
        notifyMaybe();
      }
      s.t = Math.max(s.t, nowMs);
    },

    // ---- link
    /** One connection at a time; new phones bond only inside the pairing window. Returns { ok, err }. */
    connect({ id = "phone", mtu = 247, encrypted = true, authenticated = true } = {}) {
      if (s.conn) return { ok: false, err: "busy" };
      if (!s.bonds.has(id)) {
        if (s.t >= s.pairingUntil) return { ok: false, err: "not bonded: open the pairing window (hold BOOT 2 s)" };
        s.bonds.add(id);
      }
      s.conn = { id, mtu, encrypted, authenticated };
      s.advertising = false;
      s.lastNonce = null;
      if (mtu < P.MIN_MTU) s.fault |= P.FAULT.MTU_LOW;
      else s.fault &= ~P.FAULT.MTU_LOW;
      s.lastNotify = s.t - P.STATE_MS; // first notify on the next tick
      return { ok: true };
    },
    disconnect() {
      if (!s.conn) return;
      if (s.state === P.STATE.ARMED) latch(P.LATCH.LINK_LOST);
      s.conn = null;
      s.advertising = true;
      s.fault &= ~P.FAULT.MTU_LOW;
    },
    /** BOOT button: 2..10 s opens the 60 s pairing window; >= 10 s clears every bond. */
    pressBoot(ms) {
      if (ms >= 10000) s.bonds.clear();
      else if (ms >= 2000) s.pairingUntil = s.t + P.PAIR_WINDOW_MS;
    },
    /** 3 quick BOOT presses: enter or leave config mode, only while stopped with torque off. */
    tripleTapBoot() {
      if (s.torque || s.state === P.STATE.ARMED || s.state === P.STATE.FAULT) return;
      if (s.state === P.STATE.CONFIG) (s.state = P.STATE.LATCHED), (s.latch = P.LATCH.BOOT);
      else (s.state = P.STATE.CONFIG), (s.latch = P.LATCH.CONFIG);
    },

    infoBytes() {
      return P.encodeInfo({ fwVer: FW_VERSION, body, nJoints: n, limitsHash: P.limitsHash(body, limits) });
    },
    stateBytes() {
      const flags = (s.torque ? P.FLAG.TORQUE : 0) | (s.t < s.pairingUntil ? P.FLAG.PAIRING : 0) | (s.torque && s.state === P.STATE.LATCHED && (s.relaxRequested || s.fault & RELAX_FAULTS) ? P.FLAG.RELAX_PENDING : 0);
      return P.encodeState({ state: s.state, latch: s.latch, flags, fault: s.fault, battMv: s.batt, lastSeq: s.lastSeq, positions: [...s.present, ...(def.drive ? s.drive : [])] });
    },

    // ---- characteristics: each returns an ERR code (0 = accepted)
    writeCmd(raw) {
      if (!authOk()) return P.ERR.AUTH;
      if (s.state !== P.STATE.ARMED) return P.ERR.STATE;
      let c;
      try {
        c = P.decodeCmd(raw);
      } catch (e) {
        return e.code ?? P.ERR.LEN;
      }
      if (c.type === P.MSG.JOINTS && c.mask & ~P.fullMask(body)) return P.ERR.MASK;
      if (c.type === P.MSG.DRIVE && !def.drive) return P.ERR.TYPE;
      if (!P.seqNewer(c.seq, s.lastSeq)) return P.ERR.SEQ;
      s.lastSeq = c.seq;
      s.lastCmdAt = s.t;
      s.speed = Math.min(100, c.speed);
      if (c.type === P.MSG.JOINTS) {
        s.driveTarget = [0, 0]; // only DRIVE frames move the wheels
        let k = 0;
        for (let i = 0; i < n; i++) if (c.mask & (1 << i)) s.target[i] = clamp(i, c.targets[k++]);
      } else {
        // a head-only frame stops the wheels
        s.driveTarget = c.mask & P.DRIVE_MASK.WHEELS ? [c.left, c.right].map((v) => Math.min(P.DRIVE_MAX, Math.max(-P.DRIVE_MAX, v))) : [0, 0];
        if (c.mask & P.DRIVE_MASK.PAN) s.target[0] = clamp(0, c.pan);
        if (c.mask & P.DRIVE_MASK.TILT) s.target[1] = clamp(1, c.tilt);
      }
      s.brake = false;
      return P.ERR.OK;
    },

    /** STOP always works for an authenticated phone, whatever the bytes say. */
    writeStop(raw) {
      if (!authOk()) return P.ERR.AUTH;
      const { reason } = P.decodeStop(raw);
      const wasArmed = s.state === P.STATE.ARMED;
      if (wasArmed) latch(P.LATCH.USER_STOP);
      if (reason === P.STOP_REASON.RELAX && s.torque) {
        s.relaxRequested = true;
        if (!wasArmed) s.latchedAt = s.t; // already holding: the relax delay counts from this request
      }
      return P.ERR.OK;
    },

    writeArm(raw) {
      if (!authOk()) return P.ERR.AUTH;
      let a;
      try {
        a = P.decodeArm(raw);
      } catch (e) {
        return e.code ?? P.ERR.LEN;
      }
      if (s.state !== P.STATE.LATCHED) return P.ERR.STATE;
      if (a.nonce === 0 || a.nonce === s.lastNonce) return P.ERR.NONCE;
      // re-check every fault now; ARM is the only way out of a latch
      if (s.batt < def.lowBattMv + BATT_HYST_MV) s.fault |= P.FAULT.LOW_BATT;
      else s.fault &= ~P.FAULT.LOW_BATT;
      if (s.servoFault.some(Boolean)) s.fault |= P.FAULT.SERVO_FATAL;
      else s.fault &= ~(P.FAULT.SERVO_FATAL | P.FAULT.SERVO_MISSING | P.FAULT.TORQUE_VERIFY);
      if (s.fault) return P.ERR.FAULT;
      s.lastNonce = a.nonce;
      if (!s.torque) {
        // goal = present, then torque on, then verify nothing jumped
        s.commanded = s.present.slice();
        if (bus) s.lastBus = stsMotionPacket(ids, s.commanded.map((d) => P.deciToSteps(d)));
        s.torque = true;
        if (s.torqueJump) {
          torqueOff();
          s.fault |= P.FAULT.TORQUE_VERIFY;
          return P.ERR.FAULT;
        }
        if (bus) s.lastBus = stsTorquePacket(ids, true);
      }
      // bus servos hold where they are; open-loop hobby servos go to `commanded`, so keep it inside the limits
      s.commanded = bus ? s.present.slice() : s.commanded.map((v, i) => clamp(i, v));
      s.target = s.commanded.slice();
      s.drive = [0, 0];
      s.driveTarget = [0, 0];
      s.brake = false;
      s.relaxRequested = false;
      s.state = P.STATE.ARMED;
      s.latch = P.LATCH.NONE;
      s.lastSeq = a.seqBase;
      s.lastCmdAt = s.t;
      return P.ERR.OK;
    },

    /** Config mode only (3 BOOT presses with torque off): narrow limits, save to NVS, reset. Motion is impossible here. */
    writeConfig(raw) {
      if (!authOk()) return P.ERR.AUTH;
      if (s.state !== P.STATE.CONFIG) return P.ERR.STATE;
      let c;
      try {
        c = P.decodeConfig(raw);
      } catch (e) {
        return e.code ?? P.ERR.LEN;
      }
      if (c.op === P.CONFIG_OP.SET_LIMIT) {
        const h = hard[c.joint];
        if (!h || c.min >= c.max || c.min < h.min || c.max > h.max) return P.ERR.OP;
        limits[c.joint] = { ...h, min: c.min, max: c.max, home: Math.min(c.max, Math.max(c.min, h.home)) };
        s.saved = false;
      } else if (c.op === P.CONFIG_OP.SAVE) {
        s.saved = true;
      } else if (c.op === P.CONFIG_OP.RESET) {
        limits = hard.map((j) => ({ ...j }));
        s.saved = false;
      } else {
        return P.ERR.OP;
      }
      s.target = s.target.map((v, i) => clamp(i, v));
      s.commanded = s.commanded.map((v, i) => clamp(i, v));
      return P.ERR.OK;
    },

    // ---- test hooks (hardware in the real bridge)
    setBattery(mv) {
      s.batt = mv;
    },
    setServoFault(i, on = true) {
      s.servoFault[i] = on;
    },
    setTorqueJump(on = true) {
      s.torqueJump = on;
    },
  };
  return api;
}
