// OpenForge AX-1 bridge protocol + Feetech STS bus frames. Pure C++ (no Arduino headers), CC0.
// Mirror of web/js/pilot/ax-proto.js and the STS parts of web/js/pilot/bridge-sim.js + web/js/robot/sts-bus.js.
// Both sides must reproduce firmware/ax-bridge/test/ax-vectors.json and sts-vectors.json byte for byte.
// All multi-byte fields little-endian; angles are int16 tenths of a degree ("deci").
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace ax {

constexpr uint8_t PROTO_MAJOR = 1;
constexpr uint8_t PROTO_MINOR = 0;

// Custom 128-bit UUIDs: base 7a3e000N-4f1b-4c2a-9d0e-5b6c7d8e9fa1
constexpr const char* UUID_SERVICE = "7a3e0000-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_INFO = "7a3e0001-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_CMD = "7a3e0002-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_STOP = "7a3e0003-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_ARM = "7a3e0004-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_STATE = "7a3e0005-4f1b-4c2a-9d0e-5b6c7d8e9fa1";
constexpr const char* UUID_CONFIG = "7a3e0006-4f1b-4c2a-9d0e-5b6c7d8e9fa1";

enum Body : uint8_t { BODY_ROVER = 1, BODY_DESK = 2, BODY_WALKER = 3 };
enum Msg : uint8_t { MSG_JOINTS = 1, MSG_DRIVE = 2 };
enum DriveMask : uint16_t { DRIVE_WHEELS = 1, DRIVE_PAN = 2, DRIVE_TILT = 4 };
enum StopReason : uint8_t { STOP_HOLD = 0, STOP_RELAX = 1 };
enum State : uint8_t { ST_BOOT = 0, ST_LATCHED = 1, ST_ARMED = 2, ST_FAULT = 3, ST_CONFIG = 4 };
enum Latch : uint8_t { L_NONE = 0, L_BOOT = 1, L_USER_STOP = 2, L_WATCHDOG = 3, L_LINK_LOST = 4, L_LOW_BATT = 5, L_SERVO_FAULT = 6, L_BOOT_CHECK = 7, L_CONFIG = 8 };
enum Flag : uint8_t { F_TORQUE = 1, F_PAIRING = 2, F_RELAX_PENDING = 4 };
enum Fault : uint16_t { FT_LOW_BATT = 1, FT_SERVO_FATAL = 2, FT_SERVO_MISSING = 4, FT_BAD_MODEL = 8, FT_BAD_MODE = 16, FT_MTU_LOW = 32, FT_TORQUE_VERIFY = 64 };
constexpr uint16_t RELAX_FAULTS = FT_LOW_BATT | FT_SERVO_FATAL | FT_SERVO_MISSING | FT_TORQUE_VERIFY;
enum Err : uint8_t { E_OK = 0, E_LEN = 1, E_VER = 2, E_TYPE = 3, E_MASK = 4, E_SEQ = 5, E_STATE = 6, E_NONCE = 7, E_FAULT = 8, E_AUTH = 9, E_OP = 10 };
enum ConfigOp : uint8_t { CFG_SET_LIMIT = 1, CFG_SAVE = 2, CFG_RESET = 3 };

constexpr uint32_t WD_HOLD_MS = 250;
constexpr uint32_t WD_RELAX_MS = 3000;
constexpr int32_t MAX_DEG_S = 90;
constexpr uint32_t CONTROL_MS = 20;
constexpr uint32_t STATE_MS = 100;
constexpr uint32_t PAIR_WINDOW_MS = 60000;
constexpr uint16_t MIN_MTU = 64;
constexpr uint16_t SEQ_WINDOW = 1024;
constexpr int32_t DRIVE_MAX = 1000;
constexpr int32_t DRIVE_SLEW = 40;
constexpr int MAX_JOINTS = 16;

// ---------------------------------------------------------------- joint tables (same numbers as ax-proto.js)

struct Joint {
  const char* name;
  int16_t min, max, home;
};

constexpr Joint ROVER_JOINTS[] = {{"head_pan", -900, 900, 0}, {"head_tilt", -300, 300, 0}};
constexpr Joint DESK_JOINTS[] = {
    {"torso_yaw", -1200, 1200, 0}, {"head_pan", -1000, 1000, 0}, {"head_tilt", -250, 350, 0},  {"l_shoulder", -1700, 400, 0},
    {"l_elbow", -1200, 0, -200},    {"r_shoulder", -1700, 400, 0}, {"r_elbow", -1200, 0, -200},
};
constexpr Joint WALKER_JOINTS[] = {
    {"l_hip_yaw", -300, 300, 0},   {"l_hip_roll", -250, 250, 0},  {"l_hip_pitch", -900, 600, 0}, {"l_knee", 0, 1300, 0},
    {"l_ankle_pitch", -600, 600, 0}, {"l_ankle_roll", -250, 250, 0}, {"r_hip_yaw", -300, 300, 0},   {"r_hip_roll", -250, 250, 0},
    {"r_hip_pitch", -900, 600, 0}, {"r_knee", 0, 1300, 0},        {"r_ankle_pitch", -600, 600, 0}, {"r_ankle_roll", -250, 250, 0},
    {"torso_yaw", -600, 600, 0},
};

struct BodyDef {
  const Joint* joints;
  uint8_t n;
  bool drive;
  uint16_t lowBattMv;
};
inline BodyDef bodyDef(uint8_t body) {
  switch (body) {
    case BODY_ROVER: return {ROVER_JOINTS, 2, true, 6400};
    case BODY_DESK: return {DESK_JOINTS, 7, false, 6400};
    case BODY_WALKER: return {WALKER_JOINTS, 13, false, 9600};
    default: return {nullptr, 0, false, 0};
  }
}

// ---------------------------------------------------------------- integer helpers

inline uint16_t getU16(const uint8_t* b) { return (uint16_t)(b[0] | (b[1] << 8)); }
inline int16_t getI16(const uint8_t* b) { return (int16_t)getU16(b); }
inline uint32_t getU32(const uint8_t* b) { return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24); }
inline void putU16(uint8_t* b, uint16_t v) { b[0] = v & 0xff; b[1] = (v >> 8) & 0xff; }
inline void putI16(uint8_t* b, int32_t v) {
  if (v > 32767) v = 32767;
  if (v < -32768) v = -32768;
  putU16(b, (uint16_t)(int16_t)v);
}
inline void putU32(uint8_t* b, uint32_t v) { b[0] = v & 0xff; b[1] = (v >> 8) & 0xff; b[2] = (v >> 16) & 0xff; b[3] = (v >> 24) & 0xff; }
template <typename T> inline T clampT(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline uint8_t popcount16(uint16_t m) {
  uint8_t n = 0;
  for (; m; m &= (uint16_t)(m - 1)) n++;
  return n;
}

/** Division rounding half away from zero (b > 0). C++ '/' truncates toward zero, as Math.trunc in JS. */
inline int32_t roundDiv(int32_t a, int32_t b) { return a >= 0 ? (a + b / 2) / b : -((-a + b / 2) / b); }

/** seq is fresh if 1 <= (seq - last) mod 65536 <= window. Equal or older = replay, dropped. */
inline bool seqNewer(uint16_t seq, uint16_t last, uint16_t window = SEQ_WINDOW) {
  uint16_t d = (uint16_t)(seq - last);
  return d != 0 && d <= window;
}

/** STS3215: 4096 steps per turn. deci -> raw steps around `center`, `dir` +1/-1, clamped to 0..4095. */
inline int32_t deciToSteps(int32_t deci, int32_t center = 2048, int32_t dir = 1) { return clampT<int32_t>(center + dir * roundDiv(deci * 4096, 3600), 0, 4095); }
inline int32_t stepsToDeci(int32_t steps, int32_t center = 2048, int32_t dir = 1) { return roundDiv((steps - center) * dir * 3600, 4096); }

/** Largest move per control tick (deci): MAX_DEG_S x speed %, at least 1 while speed > 0. */
inline int32_t maxStepDeci(int32_t dtMs, int32_t speedPct) {
  if (speedPct <= 0) return 0;
  if (speedPct > 100) speedPct = 100;
  int32_t s = (MAX_DEG_S * 10 * dtMs * speedPct) / 100000;
  return s < 1 ? 1 : s;
}
inline int32_t rateStep(int32_t cur, int32_t target, int32_t maxStep) {
  return target > cur ? (cur + maxStep < target ? cur + maxStep : target) : (cur - maxStep > target ? cur - maxStep : target);
}
/** Wheel output: speeding up is slew-limited, slowing down and stopping are immediate, reversing passes zero. */
inline int32_t driveStep(int32_t cur, int32_t want) {
  if (want == 0 || (cur != 0 && ((want > 0) != (cur > 0)))) return 0;
  int32_t aw = want < 0 ? -want : want, ac = cur < 0 ? -cur : cur;
  if (aw <= ac) return want;
  return rateStep(cur, want, DRIVE_SLEW);
}

/** FNV-1a 32 over: body, n, then per joint min, max, home as int16 LE. */
inline uint32_t limitsHash(uint8_t body, const Joint* j, uint8_t n) {
  uint32_t h = 0x811c9dc5u;
  auto mix = [&h](uint8_t x) { h = (h ^ x) * 0x01000193u; };
  mix(body);
  mix(n);
  for (uint8_t i = 0; i < n; i++) {
    uint8_t b[6];
    putI16(b, j[i].min);
    putI16(b + 2, j[i].max);
    putI16(b + 4, j[i].home);
    for (uint8_t k = 0; k < 6; k++) mix(b[k]);
  }
  return h;
}

// ---------------------------------------------------------------- frames

/** AX_INFO: major | minor | fw u16 | body | n_joints | limits_hash u32 (10 bytes). */
inline size_t encodeInfo(uint8_t* o, uint16_t fwVer, uint8_t body, uint8_t n, uint32_t hash) {
  o[0] = PROTO_MAJOR;
  o[1] = PROTO_MINOR;
  putU16(o + 2, fwVer);
  o[4] = body;
  o[5] = n;
  putU32(o + 6, hash);
  return 10;
}

struct Cmd {
  uint8_t type;
  uint16_t seq, mask;
  uint8_t n;
  int16_t v[MAX_JOINTS];  // JOINTS: targets in mask bit order
  int16_t left, right, pan, tilt;  // DRIVE
  uint8_t speed;
};

/** AX_CMD. JOINTS: ver|1|seq|mask|n x i16|speed. DRIVE: ver|2|seq|mask|left|right|pan|tilt|speed (15 bytes). */
inline uint8_t decodeCmd(const uint8_t* b, size_t len, Cmd& c) {
  if (len < 7) return E_LEN;
  if (b[0] != PROTO_MAJOR) return E_VER;
  c.type = b[1];
  c.seq = getU16(b + 2);
  c.mask = getU16(b + 4);
  if (c.type == MSG_JOINTS) {
    c.n = popcount16(c.mask);
    if (!c.n) return E_MASK;
    if (len != (size_t)(7 + 2 * c.n)) return E_LEN;
    for (uint8_t k = 0; k < c.n; k++) c.v[k] = getI16(b + 6 + 2 * k);
    c.speed = b[6 + 2 * c.n];
    return E_OK;
  }
  if (c.type == MSG_DRIVE) {
    if (len != 15) return E_LEN;
    if (!c.mask || (c.mask & ~7u)) return E_MASK;
    c.left = getI16(b + 6);
    c.right = getI16(b + 8);
    c.pan = getI16(b + 10);
    c.tilt = getI16(b + 12);
    c.speed = b[14];
    return E_OK;
  }
  return E_TYPE;
}

/** AX_STOP never fails on content: only an exact RELAX byte asks for torque off later. */
inline uint8_t decodeStop(const uint8_t* b, size_t len) { return (len >= 2 && b[1] == STOP_RELAX) ? STOP_RELAX : STOP_HOLD; }

/** AX_ARM: ver | nonce u32 | seq_base u16 (7 bytes). */
inline uint8_t decodeArm(const uint8_t* b, size_t len, uint32_t& nonce, uint16_t& seqBase) {
  if (len != 7) return E_LEN;
  if (b[0] != PROTO_MAJOR) return E_VER;
  nonce = getU32(b + 1);
  seqBase = getU16(b + 5);
  return E_OK;
}

/** AX_CONFIG: ver | op | joint | min i16 | max i16 (7 bytes). */
inline uint8_t decodeConfig(const uint8_t* b, size_t len, uint8_t& op, uint8_t& joint, int16_t& mn, int16_t& mx) {
  if (len != 7) return E_LEN;
  if (b[0] != PROTO_MAJOR) return E_VER;
  op = b[1];
  joint = b[2];
  mn = getI16(b + 3);
  mx = getI16(b + 5);
  return E_OK;
}

/** AX_STATE: ver|state|latch|flags|fault u16|batt_mV u16|last_seq u16|n|n x i16 (11 + 2n bytes). 0 if cap too small. */
inline size_t encodeState(uint8_t* o, size_t cap, uint8_t state, uint8_t latch, uint8_t flags, uint16_t fault, uint16_t battMv, uint16_t lastSeq, const int16_t* pos, uint8_t n) {
  if (cap < (size_t)(11 + 2 * n)) return 0;
  o[0] = PROTO_MAJOR;
  o[1] = state;
  o[2] = latch;
  o[3] = flags;
  putU16(o + 4, fault);
  putU16(o + 6, battMv);
  putU16(o + 8, lastSeq);
  o[10] = n;
  for (uint8_t k = 0; k < n; k++) putI16(o + 11 + 2 * k, pos[k]);
  return 11 + 2 * n;
}

// ---------------------------------------------------------------- Feetech STS bus (as web/js/robot/sts-bus.js)

namespace sts {
constexpr uint8_t BROADCAST = 0xfe;
enum Inst : uint8_t { PING = 0x01, READ = 0x02, WRITE = 0x03, SYNC_READ = 0x82, SYNC_WRITE = 0x83 };
enum Reg : uint8_t { MODEL = 3, MIN_LIMIT = 9, MAX_LIMIT = 11, MAX_VOLT = 14, MIN_VOLT = 15, MODE = 33, TORQUE = 40, ACCEL = 41, GOAL = 42, GOAL_TIME = 44, GOAL_VELOCITY = 46, TORQUE_LIMIT = 48, PRESENT = 56, PRESENT_VELOCITY = 58, PRESENT_LOAD = 60, VOLTAGE = 62 };
constexpr uint16_t STS3215_MODEL = 777;
constexpr uint8_t ERR_VOLTAGE = 1, ERR_ANGLE = 2, ERR_OVERHEAT = 4, ERR_OVERCURRENT = 8, ERR_OVERLOAD = 32;
constexpr uint8_t FATAL_ERRORS = ERR_VOLTAGE | ERR_OVERHEAT | ERR_OVERCURRENT | ERR_OVERLOAD;
constexpr uint8_t ACCEL_VALUE = 100;       // x100 steps/s^2
constexpr uint16_t TORQUE_LIMIT_VALUE = 800;  // 80 %
constexpr uint16_t VEL_CAP = 1229;            // ceil(90 deg/s x 1.2 x 4096 / 360): hardware backstop

/** Sign-magnitude (bit 15) position, as LeRobot-calibrated servos can read below zero. */
inline void encodePos(uint8_t* b, int32_t p) {
  if (p < 0) putU16(b, (uint16_t)((-p > 0x7fff ? 0x7fff : -p) | 0x8000));
  else putU16(b, (uint16_t)(p > 0x7fff ? 0x7fff : p));
}
inline int32_t decodePos(uint16_t v) { return (v & 0x8000) ? -(int32_t)(v & 0x7fff) : (int32_t)v; }

inline uint8_t checksum(const uint8_t* body, size_t n) {
  uint32_t s = 0;
  for (size_t i = 0; i < n; i++) s += body[i];
  return (uint8_t)(~s & 0xff);
}
/** FF FF id len instr params chk; len = params + 2. Returns bytes written, 0 if cap too small. */
inline size_t packet(uint8_t* o, size_t cap, uint8_t id, uint8_t instr, const uint8_t* params, size_t np) {
  if (cap < np + 6 || np > 250) return 0;
  o[0] = 0xff;
  o[1] = 0xff;
  o[2] = id;
  o[3] = (uint8_t)(np + 2);
  o[4] = instr;
  if (np) memcpy(o + 5, params, np);
  o[5 + np] = checksum(o + 2, np + 3);
  return np + 6;
}
inline size_t pingPacket(uint8_t* o, size_t cap, uint8_t id) { return packet(o, cap, id, PING, nullptr, 0); }
inline size_t readPacket(uint8_t* o, size_t cap, uint8_t id, uint8_t addr, uint8_t len) {
  const uint8_t p[2] = {addr, len};
  return packet(o, cap, id, READ, p, 2);
}
/** Registers 41..49: accel, goal, goal time 0, velocity cap, torque limit (RAM only). */
inline void motionBlock(uint8_t* o, int32_t goal) {
  o[0] = ACCEL_VALUE;
  encodePos(o + 1, goal);
  o[3] = 0;
  o[4] = 0;
  putU16(o + 5, VEL_CAP);
  putU16(o + 7, TORQUE_LIMIT_VALUE);
}
/** One SYNC_WRITE per control tick for every servo. */
inline size_t motionPacket(uint8_t* o, size_t cap, const uint8_t* ids, const int32_t* goals, uint8_t n) {
  uint8_t p[2 + MAX_JOINTS * 10];
  if (n > MAX_JOINTS) return 0;
  p[0] = ACCEL;
  p[1] = 9;
  for (uint8_t i = 0; i < n; i++) {
    p[2 + 10 * i] = ids[i];
    motionBlock(p + 3 + 10 * i, goals[i]);
  }
  return packet(o, cap, BROADCAST, SYNC_WRITE, p, 2 + 10 * n);
}
/** TORQUE is only ever 0 or 1 (128 would re-centre the servo and rewrite its offset in EEPROM). */
inline size_t torquePacket(uint8_t* o, size_t cap, const uint8_t* ids, uint8_t n, bool on) {
  uint8_t p[2 + MAX_JOINTS * 2];
  if (n > MAX_JOINTS) return 0;
  p[0] = TORQUE;
  p[1] = 1;
  for (uint8_t i = 0; i < n; i++) {
    p[2 + 2 * i] = ids[i];
    p[3 + 2 * i] = on ? 1 : 0;
  }
  return packet(o, cap, BROADCAST, SYNC_WRITE, p, 2 + 2 * n);
}

/** Stream parser with the same resync rules as createParser() in sts-bus.js. feed() returns true per packet. */
struct Parser {
  uint8_t buf[80];
  size_t len = 0;
  uint8_t id = 0, error = 0, nparams = 0;
  uint8_t params[64];
  uint8_t raw[80];
  size_t rawLen = 0;

  void drop(size_t k) {
    if (k >= len) {
      len = 0;
      return;
    }
    memmove(buf, buf + k, len - k);
    len -= k;
  }
  /** Push one byte; returns true when a complete, valid packet is available in id/error/params/raw. */
  bool feed(uint8_t byte) {
    if (len >= sizeof(buf)) drop(1);
    buf[len++] = byte;
    for (;;) {
      size_t i = 0;
      while (i + 1 < len && !(buf[i] == 0xff && buf[i + 1] == 0xff)) i++;
      if (i) drop(i);
      if (len < 4) return false;
      if (buf[2] == 0xff) {  // three FFs in a row: drop one
        drop(1);
        continue;
      }
      uint8_t l = buf[3];
      if (l < 2) {
        drop(2);
        continue;
      }
      if (len < (size_t)(4 + l)) return false;
      size_t total = 4 + l;
      if (checksum(buf + 2, total - 3) != buf[total - 1]) {
        drop(2);  // corrupt: rescan after the header
        continue;
      }
      id = buf[2];
      error = buf[4];
      nparams = (uint8_t)(l - 2);
      if (nparams > sizeof(params)) nparams = sizeof(params);
      memcpy(params, buf + 5, nparams);
      rawLen = total;
      memcpy(raw, buf, total);
      drop(total);
      return true;
    }
  }
};
}  // namespace sts
}  // namespace ax
