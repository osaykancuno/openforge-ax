// Emulated SO-101 servo bus: six STS3215 servos behind the same transport interface as Web Serial.
// Used by the "Try the virtual arm" mode and by the Node tests. Behaviour that matters for safety is modelled:
// on torque enable a servo drives to its Goal register (so a missing goal = present write shows up as a jump),
// Goal_Velocity 0 means full speed, positions are sign-magnitude, and a joint can be blocked (load rises).
import { BROADCAST, INST, REG, STS3215_MODEL, checksum, createParser, decodePos, encodePos, readU16, u16 } from "./sts-bus.js";

const MAX_STEPS_PER_S = 3000; // ~264 deg/s, STS3215 at 12 V
const DEFAULT_GOAL = 2048;

export function createVirtualArm({ ids = [1, 2, 3, 4, 5, 6], start = [2048, 2048, 2048, 2048, 2048, 2048], now = () => performance.now(), limits, mode = 0, volts = 12.0 } = {}) {
  const servos = new Map();
  ids.forEach((id, i) => {
    const mem = new Uint8Array(80);
    mem.set(u16(STS3215_MODEL), REG.MODEL);
    mem[5] = id;
    mem.set(encodePos(limits?.[i]?.[0] ?? 0), REG.MIN_LIMIT);
    mem.set(encodePos(limits?.[i]?.[1] ?? 4095), REG.MAX_LIMIT);
    mem[REG.MAX_VOLT] = 140;
    mem[REG.MIN_VOLT] = 45;
    mem[REG.MODE] = mode;
    mem.set(encodePos(DEFAULT_GOAL), REG.GOAL);
    mem.set(u16(1000), REG.TORQUE_LIMIT);
    mem[REG.VOLTAGE] = Math.round(volts * 10);
    servos.set(id, { mem, pos: start[i], vel: 0, t: now(), block: null, error: 0 });
  });
  let listener = () => {};
  const log = []; // decoded writes, for tests

  function advance(s) {
    const t = now();
    const dt = Math.max(0, (t - s.t) / 1000);
    s.t = t;
    s.pushing = false;
    if (!s.mem[REG.TORQUE]) s.vel = 0;
    if (!s.mem[REG.TORQUE] || dt === 0) return;
    const lo = decodePos(readU16(s.mem, REG.MIN_LIMIT));
    const hi = decodePos(readU16(s.mem, REG.MAX_LIMIT));
    const goal = Math.min(hi, Math.max(lo, decodePos(readU16(s.mem, REG.GOAL))));
    const vmax = readU16(s.mem, REG.GOAL_VELOCITY) || MAX_STEPS_PER_S;
    const d = goal - s.pos;
    let next = s.pos + Math.sign(d) * Math.min(Math.abs(d), vmax * dt);
    if (s.block && (next < s.block.lo || next > s.block.hi)) {
      next = Math.min(s.block.hi, Math.max(s.block.lo, next));
      s.pushing = true;
    }
    s.vel = (next - s.pos) / dt;
    s.pos = next;
  }

  function reply(id, error, params = []) {
    const body = [id, params.length + 2, error, ...params];
    const bytes = Uint8Array.from([0xff, 0xff, ...body, checksum(body)]);
    queueMicrotask(() => listener(bytes));
  }

  function regs(s) {
    advance(s);
    const goal = decodePos(readU16(s.mem, REG.GOAL));
    s.mem.set(encodePos(Math.round(s.pos)), REG.PRESENT);
    s.mem.set(encodePos(Math.round(s.vel)), REG.PRESENT_VELOCITY);
    const load = s.pushing || (s.block && s.mem[REG.TORQUE] && Math.abs(goal - s.pos) > 20) ? 1000 : 120;
    s.mem.set(u16(load), REG.PRESENT_LOAD);
    return s.mem;
  }

  function writeReg(id, s, addr, data) {
    advance(s);
    s.mem.set(data, addr);
    log.push({ id, addr, data: Array.from(data), pos: Math.round(s.pos), torque: s.mem[REG.TORQUE] });
  }

  const parse = createParser(({ raw }) => {
    const id = raw[2];
    const instr = raw[4];
    const p = raw.slice(5, -1);
    const s = servos.get(id);
    if (instr === INST.PING && s) reply(id, s.error);
    else if (instr === INST.READ && s) reply(id, s.error, Array.from(regs(s).slice(p[0], p[0] + p[1])));
    else if (instr === INST.WRITE && s) {
      writeReg(id, s, p[0], p.slice(1));
      reply(id, s.error);
    } else if (instr === INST.SYNC_WRITE && id === BROADCAST) {
      const [addr, len] = p;
      for (let o = 2; o + len < p.length + 1; o += len + 1) {
        const t = servos.get(p[o]);
        if (t) writeReg(p[o], t, addr, p.slice(o + 1, o + 1 + len));
      }
    } else if (instr === INST.SYNC_READ && id === BROADCAST) {
      const [addr, len] = p;
      for (const sid of p.slice(2)) {
        const t = servos.get(sid);
        if (t) reply(sid, t.error, Array.from(regs(t).slice(addr, addr + len)));
      }
    }
  });

  return {
    virtual: true,
    transport: {
      write: (bytes) => parse(bytes),
      onData: (cb) => (listener = cb),
      close: async () => {},
    },
    /** The user's hand: moves a limp servo (ignored while torque holds it). */
    hand(id, raw) {
      const s = servos.get(id);
      advance(s);
      if (!s.mem[REG.TORQUE]) s.pos = Math.round(raw);
    },
    position: (id) => (advance(servos.get(id)), servos.get(id).pos),
    goal: (id) => decodePos(readU16(servos.get(id).mem, REG.GOAL)),
    torque: (id) => servos.get(id).mem[REG.TORQUE] === 1,
    /** Something in the way: the joint cannot leave [lo, hi] (raw). block(id) clears it. */
    block(id, lo, hi) {
      servos.get(id).block = lo == null ? null : { lo, hi };
    },
    setError(id, bits) {
      servos.get(id).error = bits;
    },
    log,
  };
}
