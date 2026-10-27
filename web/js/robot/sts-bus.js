// Feetech STS3215 bus protocol (the servos inside an SO-101). Pure ES module: browser and Node tests.
// Packet: FF FF id len instr params… chk, len = params + 2, chk = ~(id + len + instr + Σparams) & 0xFF.
// 16-bit values are little-endian. Only RAM registers (>= 40) are ever written by this project.

export const BROADCAST = 0xfe;
export const INST = { PING: 0x01, READ: 0x02, WRITE: 0x03, SYNC_READ: 0x82, SYNC_WRITE: 0x83 };
export const REG = {
  MODEL: 3, // EEPROM, read only (777 = STS3215)
  MIN_LIMIT: 9,
  MAX_LIMIT: 11,
  MAX_VOLT: 14, // 0.1 V
  MIN_VOLT: 15,
  MODE: 33, // 0 = position mode; anything else is refused
  TORQUE: 40, // only ever 0 or 1 (128 re-centres the servo and changes its stored offset)
  ACCEL: 41, // x100 steps/s^2, 0 = unlimited
  GOAL: 42, // sign-magnitude, bit 15
  GOAL_TIME: 44,
  GOAL_VELOCITY: 46, // steps/s (1 step = 0.088 deg), 0 = unlimited
  TORQUE_LIMIT: 48, // 0..1000 (0.1 %)
  PRESENT: 56, // sign-magnitude, bit 15
  PRESENT_VELOCITY: 58,
  PRESENT_LOAD: 60, // 0..1000, direction in bit 10
  VOLTAGE: 62, // 0.1 V
};
export const STS3215_MODEL = 777;
// Status error bits. Angle (2) is ignored: it only flags goals outside the EEPROM limits, which the servo clamps.
export const ERR = { VOLTAGE: 1, ANGLE: 2, OVERHEAT: 4, OVERCURRENT: 8, OVERLOAD: 32 };
export const FATAL_ERRORS = ERR.VOLTAGE | ERR.OVERHEAT | ERR.OVERCURRENT | ERR.OVERLOAD;

export const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
export const readU16 = (b, o = 0) => b[o] | (b[o + 1] << 8);
// Positions are sign-magnitude (bit 15): LeRobot-calibrated arms can read below zero.
export const decodePos = (v) => (v & 0x8000 ? -(v & 0x7fff) : v);
export const encodePos = (p) => u16(p < 0 ? (Math.min(0x7fff, -p) | 0x8000) : Math.min(0x7fff, p));
export const decodeLoad = (v) => (v & 0x3ff) * (v & 0x400 ? -1 : 1);

export function checksum(body) {
  let sum = 0;
  for (const b of body) sum += b;
  return ~sum & 0xff;
}

export function packet(id, instr, params = []) {
  const body = [id, params.length + 2, instr, ...params];
  return Uint8Array.from([0xff, 0xff, ...body, checksum(body)]);
}

/** Stream parser: feeds arbitrary chunks, emits {id, error, params, raw} for each valid packet; resyncs on noise. */
export function createParser(onPacket) {
  let buf = [];
  return function push(chunk) {
    for (const b of chunk) buf.push(b);
    for (;;) {
      let i = 0;
      while (i + 1 < buf.length && !(buf[i] === 0xff && buf[i + 1] === 0xff)) i++;
      if (i) buf = buf.slice(i);
      if (buf.length < 4) return;
      if (buf[2] === 0xff) { // three FFs in a row: drop one
        buf.shift();
        continue;
      }
      const len = buf[3];
      if (len < 2) {
        buf = buf.slice(2);
        continue;
      }
      if (buf.length < 4 + len) return;
      const raw = buf.slice(0, 4 + len);
      buf = buf.slice(4 + len);
      if (checksum(raw.slice(2, -1)) !== raw[raw.length - 1]) {
        buf = raw.slice(2).concat(buf); // corrupt: rescan after the header
        continue;
      }
      onPacket({ id: raw[2], error: raw[4], params: raw.slice(5, -1), raw });
    }
  };
}

export class BusError extends Error {}

/**
 * Request/response bus over a transport { write(Uint8Array): Promise|void, onData(cb) }.
 * One request at a time; replies are matched by id. Echoed TX bytes (some adapters echo) are ignored.
 */
export function createBus(transport, { timeoutMs = 50, retries = 2 } = {}) {
  let pending = null;
  let lastSent = null;
  let chain = Promise.resolve();
  const servoErrors = new Map(); // id -> last status error byte

  const parse = createParser((p) => {
    if (lastSent && p.raw.length === lastSent.length && p.raw.every((b, i) => b === lastSent[i])) return; // echo
    servoErrors.set(p.id, p.error);
    if (pending && pending.waiting.has(p.id)) {
      pending.waiting.delete(p.id);
      pending.replies.set(p.id, p);
      if (!pending.waiting.size) pending.done();
    }
  });
  transport.onData(parse);

  async function once(id, instr, params, replyIds) {
    const bytes = packet(id, instr, params);
    lastSent = Array.from(bytes);
    if (!replyIds.length) {
      await transport.write(bytes);
      return new Map();
    }
    return new Promise((resolve, reject) => {
      const pendingIds = new Set(replyIds);
      const replies = new Map();
      const timer = setTimeout(() => {
        pending = null;
        reject(new BusError(`no reply from servo ${[...pendingIds].join(", ")}`));
      }, timeoutMs);
      pending = { waiting: pendingIds, replies, done: () => (clearTimeout(timer), (pending = null), resolve(replies)) };
      Promise.resolve(transport.write(bytes)).catch((e) => (clearTimeout(timer), (pending = null), reject(e)));
    });
  }

  function request(id, instr, params, replyIds) {
    const run = async () => {
      let err;
      for (let a = 0; a <= retries; a++) {
        try {
          return await once(id, instr, params, replyIds);
        } catch (e) {
          err = e;
          if (!(e instanceof BusError)) break;
        }
      }
      throw err;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  return {
    servoErrors,
    async ping(id) {
      try {
        await request(id, INST.PING, [], [id]);
        return true;
      } catch (e) {
        if (e instanceof BusError) return false;
        throw e;
      }
    },
    async read(id, addr, len) {
      return (await request(id, INST.READ, [addr, len], [id])).get(id).params;
    },
    async write(id, addr, data) {
      await request(id, INST.WRITE, [addr, ...data], [id]);
    },
    /** entries: [[id, bytes[]], ...] with equal byte lengths. Broadcast: no reply. */
    async syncWrite(addr, entries) {
      const len = entries[0][1].length;
      const params = [addr, len];
      for (const [id, data] of entries) params.push(id, ...data);
      await request(BROADCAST, INST.SYNC_WRITE, params, []);
    },
    /** Returns Map id -> bytes. */
    async syncRead(addr, len, ids) {
      const replies = await request(BROADCAST, INST.SYNC_READ, [addr, len, ...ids], ids);
      return new Map([...replies].map(([id, p]) => [id, p.params]));
    },
  };
}
