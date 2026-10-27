// OpenForge AX-1 bridge firmware: BLE (phone) <-> motors and servos. CC0 1.0. EXPERIMENTAL, UNTESTED ON HARDWARE.
//
// The phone is untrusted: every safety rule lives here, and the same state machine runs in the browser twin
// (web/js/pilot/bridge-sim.js), which the tests exercise. Change both together.
//   - boot: torque off, motor driver standby low, STS3215 model 777 + position mode checked, nothing moves;
//   - LATCHED until ARM (a write the app sends only after a user gesture); ARM sets goal = present before torque on
//     and verifies nothing jumped; a reused nonce is refused;
//   - CMD frames: version, length, mask, replayed/stale seq are dropped; targets clamped to limits (NVS), every
//     joint rate-limited to MAX_DEG_S (90 deg/s) x speed % over the real elapsed time;
//   - staged watchdog: no valid CMD for WD_HOLD_MS (250 ms) -> HOLD (goal = present, DC motors brake) + latch;
//     WD_RELAX_MS (3 s) later torque off only after a fault or a user RELAX request. Never resumes on its own;
//   - loop() runs under the ESP task watchdog (reboot = torque off), and a timer cuts the DC motors if it stalls 300 ms;
//   - low battery, a fatal servo error or a missing servo -> HOLD + latch; ARM refused until it clears;
//   - RAM-only register writes; ACCEL / GOAL_VELOCITY cap / TORQUE_LIMIT resent in every SYNC_WRITE; TORQUE only 0/1;
//   - BLE: static 6-digit passkey (MITM), LE Secure Connections requested, 128-bit keys only; writes need an
//     encrypted authenticated link, one connection. Unknown phones may connect only inside a 60 s window opened by
//     holding BOOT 2 s (10 s clears all bonds); 5 failed links lock every connection out for 60 s; a link must
//     authenticate within 10 s (45 s while pairing, to type the passkey).
//
// Board: "ESP32 Dev Module" (Arduino-ESP32 core 3.x). Library: NimBLE-Arduino 2.x (Apache-2.0, see NOTICE).
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>

#include "ax_proto.h"
#include "config.h"

using namespace ax;

static_assert(AX_PASSKEY >= 100000 && AX_PASSKEY <= 999999, "Set AX_PASSKEY in config.h to your own 6-digit number (100000-999999).");
/** Guessable 6-digit passkeys: one digit repeated, a run up or down, a repeated pair or triple, or four zeros. */
constexpr bool weakPasskey(uint32_t k) {
  int d[6] = {};
  for (int i = 5; i >= 0; i--) d[i] = k % 10, k /= 10;
  bool same = true, up = true, down = true, pair = true, triple = true;
  int zeros = 0;
  for (int i = 1; i < 6; i++) same &= d[i] == d[0], up &= d[i] == d[i - 1] + 1, down &= d[i] + 1 == d[i - 1], zeros += d[i] == 0;
  for (int i = 2; i < 6; i++) pair &= d[i] == d[i - 2];
  for (int i = 3; i < 6; i++) triple &= d[i] == d[i - 3];
  return same || up || down || pair || triple || zeros >= 4;
}
static_assert(!weakPasskey(AX_PASSKEY), "AX_PASSKEY is too easy to guess: pick a random number.");
static_assert(AX_BODY == BODY_ROVER || AX_BODY == BODY_DESK || AX_BODY == BODY_WALKER, "AX_BODY must be BODY_ROVER, BODY_DESK or BODY_WALKER");

static const uint16_t FW_VERSION = 0x0001;  // 0.1
static const BodyDef DEF = bodyDef(AX_BODY);
static const bool BUS = !DEF.drive;  // Desk / Walker: STS3215 bus; Rover: TB6612 + hobby servos
static const uint8_t N = DEF.n;
static const int16_t CENTERS[] = BUS_CENTERS;
static const int8_t DIRS[] = BUS_DIRS;
static const uint8_t MISSING_TICKS = 5;
static const uint32_t MAX_STEP_DT_MS = 50;      // a late control tick moves at most this much time's worth
static const uint32_t LOOP_STALL_MS = 300;      // loop() silent this long: DC motors cut from the timer task
static const uint32_t TASK_WDT_MS = 1000;       // loop() silent this long: reboot (boot = torque off)
static const uint32_t AUTH_TIMEOUT_MS = 10000;  // a link must be encrypted + authenticated within this...
static const uint32_t PAIR_AUTH_TIMEOUT_MS = 45000;  // ...or this while the pairing window is open (typing the passkey)
static const uint32_t KICK_RETRY_MS = 2000;     // a disconnect that did not land is retried
static const uint8_t AUTH_FAIL_MAX = 5;         // failed pairings before the window closes...
static const uint32_t AUTH_LOCK_MS = 60000;     // ...and cannot reopen for this long
static const uint8_t MIN_KEY_SIZE = 16;         // bytes: refuse shortened keys
static const uint16_t NO_CONN = 0xffff;

// ================================================================ state (loop task only)

static uint8_t gState = ST_BOOT, gLatch = L_BOOT;
static uint16_t gFault = 0;
static bool gTorque = false, gBrake = false, gRelaxRequested = false, gServoFatal = false;
static uint32_t gLatchedAt = 0, gLastCmdAt = 0;
static uint16_t gLastSeq = 0;
static uint32_t gLastNonce = 0;
static bool gHasNonce = false;
static uint8_t gSpeed = 100;
static Joint gLimits[MAX_JOINTS];
static int32_t gPresent[MAX_JOINTS], gCommanded[MAX_JOINTS], gTarget[MAX_JOINTS];
static int32_t gDrive[2] = {0, 0}, gDriveTarget[2] = {0, 0};
static uint16_t gBattMv = 0;
static uint8_t gMissing[MAX_JOINTS];
static uint8_t gIds[MAX_JOINTS];
static Preferences gPrefs;

// ================================================================ link inbox (NimBLE task -> loop task)

static portMUX_TYPE gMux = portMUX_INITIALIZER_UNLOCKED;
struct Inbox {
  uint8_t cmd[48];
  size_t cmdLen;
  bool cmdNew;  // latest wins
  uint8_t arm[8];
  size_t armLen;
  bool armNew;
  bool stop, stopRelax;
  uint8_t cfg[8];
  size_t cfgLen;
  bool cfgNew;
  bool linkDown;
  uint16_t mtu;
  bool mtuNew;
};
static Inbox gIn;
static volatile bool gConnected = false;
static volatile bool gAuthOk = false;
static volatile uint16_t gConnHandle = NO_CONN;  // the one accepted phone; every other handle is ignored
static volatile uint32_t gConnAt = 0;
static volatile uint32_t gPairUntil = 0;
static volatile bool gPairWindow = false;
static volatile uint32_t gPairLockUntil = 0;
static volatile bool gPairLocked = false;
static volatile uint8_t gAuthFails = 0;
static volatile int gBondsAtConnect = 0;
static NimBLEAddress gForget;                   // a bond made outside the rules, deleted once its link is down
static volatile bool gForgetPending = false;
static volatile bool gForgetAll = false;        // "clear all bonds" while a phone was linked: repeat once it is gone
static NimBLEServer* gServer = nullptr;
static NimBLECharacteristic* gInfoChr = nullptr;
static NimBLECharacteristic* gStateChr = nullptr;

static bool pairingOpen() { return gPairWindow && (int32_t)(gPairUntil - millis()) > 0; }

// ================================================================ loop supervision (esp_timer task -> loop task)

static volatile uint32_t gLoopAt = 0;
static volatile bool gStalled = false;

// ================================================================ STS3215 bus

static HardwareSerial& Bus = Serial2;
static uint8_t gTx[2 + 6 + MAX_JOINTS * 10];
static size_t gTxLen = 0;

static void busWrite(const uint8_t* b, size_t n) {
  while (Bus.available()) Bus.read();  // drop stale bytes (and the echo of the previous frame)
  Bus.write(b, n);
  Bus.flush();
  memcpy(gTx, b, n);
  gTxLen = n;
}

static bool busReply(uint8_t id, sts::Parser& p) {
  uint32_t t0 = micros();
  while ((uint32_t)(micros() - t0) < BUS_TIMEOUT_US) {
    while (Bus.available()) {
      if (!p.feed((uint8_t)Bus.read())) continue;
      if (BUS_ECHO && p.rawLen == gTxLen && memcmp(p.raw, gTx, gTxLen) == 0) continue;  // our own request echoed
      if (p.id == id) return true;
    }
  }
  return false;
}

static bool busRead(uint8_t id, uint8_t addr, uint8_t len, uint8_t* out, uint8_t* err) {
  uint8_t pk[8];
  size_t n = sts::readPacket(pk, sizeof pk, id, addr, len);
  for (int attempt = 0; attempt < 2; attempt++) {
    sts::Parser p;
    busWrite(pk, n);
    if (busReply(id, p) && p.nparams >= len) {
      memcpy(out, p.params, len);
      if (err) *err = p.error;
      return true;
    }
  }
  return false;
}

static bool busPing(uint8_t id) {
  uint8_t pk[6];
  size_t n = sts::pingPacket(pk, sizeof pk, id);
  for (int attempt = 0; attempt < 2; attempt++) {
    sts::Parser p;
    busWrite(pk, n);
    if (busReply(id, p)) return true;
  }
  return false;
}

static void busTorque(bool on) {
  uint8_t pk[8 + MAX_JOINTS * 2];
  size_t n = sts::torquePacket(pk, sizeof pk, gIds, N, on);  // TORQUE only ever 0 or 1
  busWrite(pk, n);
}

static void busGoals(const int32_t* deci) {
  int32_t goals[MAX_JOINTS];
  for (uint8_t i = 0; i < N; i++) goals[i] = deciToSteps(deci[i], CENTERS[i], DIRS[i]);
  uint8_t pk[8 + MAX_JOINTS * 10];
  size_t n = sts::motionPacket(pk, sizeof pk, gIds, goals, N);
  if (n) busWrite(pk, n);
}

/** Reads every servo's position and status error. Sets gServoFatal; counts missing replies. */
static void busReadPresent() {
  for (uint8_t i = 0; i < N; i++) {
    uint8_t b[2], err = 0;
    if (busRead(gIds[i], sts::PRESENT, 2, b, &err)) {
      gPresent[i] = stepsToDeci(sts::decodePos(getU16(b)), CENTERS[i], DIRS[i]);
      gMissing[i] = 0;
      if (err & sts::FATAL_ERRORS) gServoFatal = true;
    } else if (gMissing[i] < 255) {
      gMissing[i]++;
    }
    if (gMissing[i] >= MISSING_TICKS) gFault |= FT_SERVO_MISSING;
  }
}

static void bootCheckBus() {
  busTorque(false);
  for (uint8_t i = 0; i < N; i++) {
    uint8_t b[2];
    if (!busPing(gIds[i])) {
      gFault |= FT_SERVO_MISSING;
      continue;
    }
    if (!busRead(gIds[i], sts::MODEL, 2, b, nullptr) || getU16(b) != sts::STS3215_MODEL) gFault |= FT_BAD_MODEL;
    if (!busRead(gIds[i], sts::MODE, 1, b, nullptr) || b[0] != 0) gFault |= FT_BAD_MODE;  // anything but position mode would spin
  }
  busReadPresent();
}

// ================================================================ Rover: TB6612 + hobby servos

static void motorPins(int pwm, int in1, int in2, int32_t v, bool brake) {
  if (brake) {  // TB6612 short brake: IN1 = IN2 = HIGH
    digitalWrite(in1, HIGH);
    digitalWrite(in2, HIGH);
    ledcWrite(pwm, 1023);
    return;
  }
  digitalWrite(in1, v > 0 ? HIGH : LOW);
  digitalWrite(in2, v < 0 ? HIGH : LOW);
  ledcWrite(pwm, (uint32_t)((v < 0 ? -v : v) * 1023 / DRIVE_MAX));
}

static bool gServosAttached = false;
static void servoWrite(int pin, int32_t deci, int dir) {
  int32_t us = SERVO_US_CENTER + dir * deci * SERVO_US_PER_DEG / 10;
  us = clampT<int32_t>(us, 500, 2500);
  ledcWrite(pin, (uint32_t)(us * 16383 / 20000));  // 50 Hz, 14-bit
}

static void roverInit() {
  pinMode(PIN_TB_STBY, OUTPUT);
  digitalWrite(PIN_TB_STBY, LOW);  // driver off before anything else
  for (int p : {PIN_TB_AIN1, PIN_TB_AIN2, PIN_TB_BIN1, PIN_TB_BIN2}) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  ledcAttach(PIN_TB_PWMA, MOTOR_PWM_HZ, 10);
  ledcAttach(PIN_TB_PWMB, MOTOR_PWM_HZ, 10);
  ledcWrite(PIN_TB_PWMA, 0);
  ledcWrite(PIN_TB_PWMB, 0);
}

static void roverApply() {
  if (!gTorque) {
    digitalWrite(PIN_TB_STBY, LOW);
    ledcWrite(PIN_TB_PWMA, 0);
    ledcWrite(PIN_TB_PWMB, 0);
    if (gServosAttached) {
      ledcDetach(PIN_SERVO_PAN);
      ledcDetach(PIN_SERVO_TILT);
      gServosAttached = false;
    }
    return;
  }
  if (!gServosAttached) {
    ledcAttach(PIN_SERVO_PAN, 50, 14);
    ledcAttach(PIN_SERVO_TILT, 50, 14);
    gServosAttached = true;
  }
  digitalWrite(PIN_TB_STBY, HIGH);
  motorPins(PIN_TB_PWMA, PIN_TB_AIN1, PIN_TB_AIN2, MOTOR_LEFT_INVERT ? -gDrive[0] : gDrive[0], gBrake);
  motorPins(PIN_TB_PWMB, PIN_TB_BIN1, PIN_TB_BIN2, MOTOR_RIGHT_INVERT ? -gDrive[1] : gDrive[1], gBrake);
  servoWrite(PIN_SERVO_PAN, gCommanded[0], SERVO_PAN_DIR);
  servoWrite(PIN_SERVO_TILT, gCommanded[1], SERVO_TILT_DIR);
  for (uint8_t i = 0; i < N; i++) gPresent[i] = gCommanded[i];  // open loop
}

// ================================================================ outputs, latch

static void applyOutputs() {
  if (BUS) {
    if (gTorque) busGoals(gCommanded);
  } else {
    roverApply();
  }
}

static void torqueOff() {
  gTorque = false;
  gBrake = false;
  if (BUS) busTorque(false);
  else roverApply();
}

/** HOLD + STOP latch: goal = present (bus), DC motors brake, targets forgotten. */
static void latchNow(uint8_t reason) {
  gState = ST_LATCHED;
  gLatch = reason;
  gLatchedAt = millis();
  if (gTorque) {
    if (BUS) memcpy(gCommanded, gPresent, sizeof(int32_t) * N);
    gBrake = true;
  }
  memcpy(gTarget, gCommanded, sizeof(int32_t) * N);
  gDrive[0] = gDrive[1] = gDriveTarget[0] = gDriveTarget[1] = 0;
  applyOutputs();
}

// ================================================================ limits (NVS)

static void loadLimits() {
  for (uint8_t i = 0; i < N; i++) gLimits[i] = DEF.joints[i];
  gPrefs.begin("axlim", true);
  int16_t buf[MAX_JOINTS * 2];
  size_t got = gPrefs.getBytes(("b" + String(AX_BODY)).c_str(), buf, sizeof(int16_t) * 2 * N);
  gPrefs.end();
  if (got != sizeof(int16_t) * 2 * N) return;
  for (uint8_t i = 0; i < N; i++) {  // stored limits may only narrow the compiled ones
    int16_t mn = buf[2 * i], mx = buf[2 * i + 1];
    if (mn < DEF.joints[i].min || mx > DEF.joints[i].max || mn >= mx) return;
  }
  for (uint8_t i = 0; i < N; i++) {
    gLimits[i].min = buf[2 * i];
    gLimits[i].max = buf[2 * i + 1];
    gLimits[i].home = clampT<int16_t>(DEF.joints[i].home, gLimits[i].min, gLimits[i].max);
  }
}

static void saveLimits() {
  int16_t buf[MAX_JOINTS * 2];
  for (uint8_t i = 0; i < N; i++) buf[2 * i] = gLimits[i].min, buf[2 * i + 1] = gLimits[i].max;
  gPrefs.begin("axlim", false);
  gPrefs.putBytes(("b" + String(AX_BODY)).c_str(), buf, sizeof(int16_t) * 2 * N);
  gPrefs.end();
}

static void publishInfo() {
  uint8_t b[10];
  encodeInfo(b, FW_VERSION, AX_BODY, N, limitsHash(AX_BODY, gLimits, N));
  gInfoChr->setValue(b, sizeof b);
}

// ================================================================ BLE

static bool secureLink(NimBLEConnInfo& info) { return info.isEncrypted() && info.isAuthenticated() && info.getSecKeySize() >= MIN_KEY_SIZE; }
static bool linkOk(NimBLEConnInfo& info) { return info.getConnHandle() == gConnHandle && gAuthOk && secureLink(info); }

/** NimBLE task. 5 links that end without authenticating lock every connection out for AUTH_LOCK_MS. */
static void noteAuthFailure() {
  gAuthFails = gAuthFails + 1;
  if (gAuthFails < AUTH_FAIL_MAX) return;
  gAuthFails = 0;
  gPairWindow = false;
  gPairLockUntil = millis() + AUTH_LOCK_MS;
  gPairLocked = true;
}

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    uint16_t h = info.getConnHandle();
    // One phone at a time; nobody during a lockout. While the pairing window is closed, a known identity address
    // must be bonded. A private address the stack has not resolved yet (most phones) cannot be checked here: it goes
    // on to onAuthenticationComplete, which refuses anything not bonded inside the window, and every failed link
    // counts toward the lockout. EXPERIMENTAL: check RPA resolution timing on the first hardware build.
    NimBLEAddress id = info.getIdAddress();
    bool unknown = !id.isRpa() && !NimBLEDevice::isBonded(id);
    if (gConnHandle != NO_CONN || gPairLocked || (!pairingOpen() && unknown)) {
      s->disconnect(h);
      return;
    }
    gBondsAtConnect = NimBLEDevice::getNumBonds();
    gAuthOk = false;
    gConnAt = millis();
    gConnHandle = h;
    gConnected = true;
    s->updateConnParams(h, 12, 24, 0, 200);  // 15-30 ms interval, 2 s supervision timeout
    NimBLEDevice::startSecurity(h);          // ask for encryption now; the loop drops the link after AUTH_TIMEOUT_MS
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    if (info.getConnHandle() != gConnHandle) {  // a refused extra connection: the accepted phone stays linked
      if (gConnHandle == NO_CONN) NimBLEDevice::startAdvertising();
      return;
    }
    if (!gAuthOk) noteAuthFailure();  // wrong passkey, cancelled pairing, timeout or a refused bond
    if (gForgetPending) {
      gForgetPending = false;
      if (!NimBLEDevice::deleteBond(gForget)) Serial.println("[ax] could not delete a bond made outside the pairing window");
    }
    if (gForgetAll) {
      gForgetAll = false;
      uint16_t h = gConnHandle;
      if (h != NO_CONN) gForgetAll = true, gServer->disconnect(h);  // a revoked phone must not keep control
      NimBLEDevice::deleteAllBonds();
    }
    gConnHandle = NO_CONN;
    gConnected = false;
    gAuthOk = false;
    portENTER_CRITICAL(&gMux);
    gIn.linkDown = true;
    portEXIT_CRITICAL(&gMux);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo& info) override {
    if (info.getConnHandle() != gConnHandle) return;
    portENTER_CRITICAL(&gMux);
    gIn.mtu = mtu;
    gIn.mtuNew = true;
    portEXIT_CRITICAL(&gMux);
  }
  uint32_t onPassKeyDisplay() override { return AX_PASSKEY; }
  void onAuthenticationComplete(NimBLEConnInfo& info) override {
    uint16_t h = info.getConnHandle();
    if (h != gConnHandle) {
      NimBLEDevice::getServer()->disconnect(h);
      return;
    }
    bool ok = secureLink(info);
    bool newBond = NimBLEDevice::getNumBonds() > gBondsAtConnect;
    if (ok && !pairingOpen() && (newBond || !info.isBonded())) ok = false;  // paired outside the window
    if (!ok) {
      gAuthOk = false;
      if (newBond) {  // never keep a bond made outside the rules; the stack refuses to delete it while linked
        gForget = info.getIdAddress();
        gForgetPending = true;
      }
      NimBLEDevice::getServer()->disconnect(h);  // onDisconnect counts the failure
      return;
    }
    gAuthFails = 0;
    gAuthOk = true;
  }
};

static void copyIn(NimBLECharacteristic* c, uint8_t* dst, size_t cap, size_t& len, bool& flag) {
  NimBLEAttValue v = c->getValue();
  size_t n = v.size() < cap ? v.size() : cap;
  portENTER_CRITICAL(&gMux);
  memcpy(dst, v.data(), n);
  len = v.size() <= cap ? n : cap + 1;  // too long: decoders reject it by length
  flag = true;
  portEXIT_CRITICAL(&gMux);
}

class CmdCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    if (linkOk(info)) copyIn(c, gIn.cmd, sizeof gIn.cmd, gIn.cmdLen, gIn.cmdNew);
  }
};
class ArmCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    if (linkOk(info)) copyIn(c, gIn.arm, sizeof gIn.arm, gIn.armLen, gIn.armNew);
  }
};
class ConfigCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    if (linkOk(info)) copyIn(c, gIn.cfg, sizeof gIn.cfg, gIn.cfgLen, gIn.cfgNew);
  }
};
class StopCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    if (!linkOk(info)) return;
    NimBLEAttValue v = c->getValue();
    bool relax = decodeStop(v.data(), v.size()) == STOP_RELAX;  // any content stops
    portENTER_CRITICAL(&gMux);
    gIn.stop = true;
    gIn.stopRelax = gIn.stopRelax || relax;
    portEXIT_CRITICAL(&gMux);
  }
};

static void bleInit() {
  NimBLEDevice::init(AX_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setSecurityAuth(true, true, true);  // bonding, MITM, LE Secure Connections (requested: NimBLE cannot report which was used)
  NimBLEDevice::setSecurityPasskey(AX_PASSKEY);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);  // the "display" is the sticker: the phone types it
  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCB());
  gServer->advertiseOnDisconnect(false);  // onDisconnect restarts it, only when no phone is linked
  NimBLEService* svc = gServer->createService(UUID_SERVICE);
  const uint32_t W = NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN;
  gInfoChr = svc->createCharacteristic(UUID_INFO, NIMBLE_PROPERTY::READ);  // open: versions only
  svc->createCharacteristic(UUID_CMD, NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN)->setCallbacks(new CmdCB());
  svc->createCharacteristic(UUID_STOP, W)->setCallbacks(new StopCB());
  svc->createCharacteristic(UUID_ARM, W)->setCallbacks(new ArmCB());
  gStateChr = svc->createCharacteristic(UUID_STATE, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::READ_AUTHEN | NIMBLE_PROPERTY::NOTIFY);
  svc->createCharacteristic(UUID_CONFIG, W)->setCallbacks(new ConfigCB());
  svc->start();
  publishInfo();

  NimBLEAdvertisementData adv, scan;
  adv.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  adv.addServiceUUID(NimBLEUUID(UUID_SERVICE));
  scan.setName(AX_NAME);
  NimBLEAdvertising* a = NimBLEDevice::getAdvertising();
  a->setAdvertisementData(adv);
  a->setScanResponseData(scan);
  a->start();
}

static void publishState(bool notify) {
  int16_t pos[MAX_JOINTS + 2];
  uint8_t n = 0;
  for (uint8_t i = 0; i < N; i++) pos[n++] = (int16_t)gPresent[i];
  if (DEF.drive) pos[n++] = (int16_t)gDrive[0], pos[n++] = (int16_t)gDrive[1];
  uint8_t flags = (gTorque ? F_TORQUE : 0) | (pairingOpen() ? F_PAIRING : 0) |
                  (gTorque && gState == ST_LATCHED && (gRelaxRequested || (gFault & RELAX_FAULTS)) ? F_RELAX_PENDING : 0);
  uint8_t b[11 + 2 * (MAX_JOINTS + 2)];
  size_t len = encodeState(b, sizeof b, gState, gLatch, flags, gFault, gBattMv, gLastSeq, pos, n);
  gStateChr->setValue(b, len);
  if (notify && gConnected && gAuthOk) gStateChr->notify();
}

// ================================================================ handlers (loop task)

/** Keeps v[] inside the current limits (they can narrow in config mode). */
static void clampToLimits(int32_t* v) {
  for (uint8_t i = 0; i < N; i++) v[i] = clampT<int32_t>(v[i], gLimits[i].min, gLimits[i].max);
}

static void handleArm(const uint8_t* b, size_t len) {
  uint32_t nonce;
  uint16_t seqBase;
  if (decodeArm(b, len, nonce, seqBase) != E_OK) return;
  if (gState != ST_LATCHED) return;
  if (nonce == 0 || (gHasNonce && nonce == gLastNonce)) return;
  // ARM is the only way out of a latch: re-check every fault now
  if (PIN_BATT_ADC >= 0 && gBattMv < DEF.lowBattMv + BATT_HYST_MV) gFault |= FT_LOW_BATT;
  else gFault &= ~FT_LOW_BATT;
  if (BUS) {
    gServoFatal = false;
    for (uint8_t i = 0; i < N; i++) gMissing[i] = 0;
    gFault &= ~(FT_SERVO_FATAL | FT_SERVO_MISSING | FT_TORQUE_VERIFY);
    busReadPresent();
    for (uint8_t i = 0; i < N; i++)
      if (gMissing[i]) gFault |= FT_SERVO_MISSING;
    if (gServoFatal) gFault |= FT_SERVO_FATAL;
  }
  if (gFault) return;
  gLastNonce = nonce;
  gHasNonce = true;
  if (!gTorque) {
    if (BUS) {
      int32_t before[MAX_JOINTS];
      memcpy(before, gPresent, sizeof(int32_t) * N);
      memcpy(gCommanded, gPresent, sizeof(int32_t) * N);
      busGoals(gCommanded);  // goal = present, BEFORE torque on (RAM registers)
      busTorque(true);
      gTorque = true;
      delay(40);
      busReadPresent();
      for (uint8_t i = 0; i < N; i++) {
        int32_t d = gPresent[i] - before[i];
        if (d > 20 || d < -20 || gMissing[i]) {  // a servo jumped more than 2 deg: torque off again
          torqueOff();
          gFault |= FT_TORQUE_VERIFY;
          return;
        }
      }
    } else {
      gTorque = true;  // hobby servos: first ARM moves them to the last commanded angle (open loop)
    }
  }
  // Bus servos hold exactly where they are (no jump on ARM; new targets are clamped). Open-loop hobby servos are
  // driven to gCommanded, so it must never be outside the limits.
  if (BUS) memcpy(gCommanded, gPresent, sizeof(int32_t) * N);
  else clampToLimits(gCommanded);
  memcpy(gTarget, gCommanded, sizeof(int32_t) * N);
  gDrive[0] = gDrive[1] = gDriveTarget[0] = gDriveTarget[1] = 0;
  gBrake = false;
  gRelaxRequested = false;
  gState = ST_ARMED;
  gLatch = L_NONE;
  gLastSeq = seqBase;
  gLastCmdAt = millis();
  applyOutputs();
}

static void handleCmd(const uint8_t* b, size_t len) {
  if (gState != ST_ARMED) return;
  Cmd c;
  if (decodeCmd(b, len, c) != E_OK) return;
  if (c.type == MSG_JOINTS && (c.mask & ~(uint16_t)((1u << N) - 1))) return;
  if (c.type == MSG_DRIVE && !DEF.drive) return;
  if (!seqNewer(c.seq, gLastSeq)) return;  // replayed or stale
  gLastSeq = c.seq;
  gLastCmdAt = millis();
  gSpeed = c.speed > 100 ? 100 : c.speed;
  if (c.type == MSG_JOINTS) {
    gDriveTarget[0] = gDriveTarget[1] = 0;  // only DRIVE frames move the wheels
    uint8_t k = 0;
    for (uint8_t i = 0; i < N; i++)
      if (c.mask & (1u << i)) gTarget[i] = clampT<int32_t>(c.v[k++], gLimits[i].min, gLimits[i].max);
  } else {
    if (c.mask & DRIVE_WHEELS) {
      gDriveTarget[0] = clampT<int32_t>(c.left, -DRIVE_MAX, DRIVE_MAX);
      gDriveTarget[1] = clampT<int32_t>(c.right, -DRIVE_MAX, DRIVE_MAX);
    } else {
      gDriveTarget[0] = gDriveTarget[1] = 0;  // a head-only frame stops the wheels
    }
    if (c.mask & DRIVE_PAN) gTarget[0] = clampT<int32_t>(c.pan, gLimits[0].min, gLimits[0].max);
    if (c.mask & DRIVE_TILT) gTarget[1] = clampT<int32_t>(c.tilt, gLimits[1].min, gLimits[1].max);
  }
  gBrake = false;
}

static void handleStop(bool relax) {
  bool wasArmed = gState == ST_ARMED;
  if (wasArmed) latchNow(L_USER_STOP);
  if (relax && gTorque) {
    gRelaxRequested = true;
    if (!wasArmed) gLatchedAt = millis();  // already holding: the relax delay counts from this request
  }
}

static void handleConfig(const uint8_t* b, size_t len) {
  if (gState != ST_CONFIG) return;
  uint8_t op, j;
  int16_t mn, mx;
  if (decodeConfig(b, len, op, j, mn, mx) != E_OK) return;
  if (op == CFG_SET_LIMIT) {
    if (j >= N || mn >= mx || mn < DEF.joints[j].min || mx > DEF.joints[j].max) return;  // only narrower
    gLimits[j].min = mn;
    gLimits[j].max = mx;
    gLimits[j].home = clampT<int16_t>(DEF.joints[j].home, mn, mx);
  } else if (op == CFG_SAVE) {
    saveLimits();
  } else if (op == CFG_RESET) {
    for (uint8_t i = 0; i < N; i++) gLimits[i] = DEF.joints[i];
  }
  clampToLimits(gTarget);
  clampToLimits(gCommanded);
  publishInfo();
}

static void processInbox() {
  Inbox in;
  portENTER_CRITICAL(&gMux);
  in = gIn;
  gIn.cmdNew = gIn.armNew = gIn.cfgNew = gIn.stop = gIn.stopRelax = gIn.linkDown = gIn.mtuNew = false;
  portEXIT_CRITICAL(&gMux);

  if (in.linkDown) {
    in.armNew = in.cmdNew = in.cfgNew = false;  // written just before the drop: never act on them without a link
    if (gState == ST_ARMED) latchNow(L_LINK_LOST);
    gFault &= ~FT_MTU_LOW;
    gHasNonce = false;
  }
  if (in.mtuNew) {
    if (in.mtu < MIN_MTU) gFault |= FT_MTU_LOW;
    else gFault &= ~FT_MTU_LOW;
  }
  if (in.armNew) handleArm(in.arm, in.armLen);
  if (in.cmdNew) handleCmd(in.cmd, in.cmdLen);
  if (in.cfgNew) handleConfig(in.cfg, in.cfgLen);
  if (in.stop) handleStop(in.stopRelax);  // last: STOP always wins
}

// ================================================================ control loop (50 Hz)

static void readBattery() {
  if (PIN_BATT_ADC < 0) return;
  uint32_t mv = (uint32_t)analogReadMilliVolts(PIN_BATT_ADC) * BATT_DIVIDER_X1000 / 1000;
  gBattMv = gBattMv ? (uint16_t)((gBattMv * 7 + mv) / 8) : (uint16_t)mv;  // light smoothing
}

/** One control tick; dtMs is the real time since the previous one (capped), so the rate limit holds when late. */
static void controlStep(uint32_t dtMs) {
  uint32_t now = millis();
  readBattery();
  if (BUS) busReadPresent();
  if (gTorque && PIN_BATT_ADC >= 0 && gBattMv < DEF.lowBattMv) {
    gFault |= FT_LOW_BATT;
    if (gState == ST_ARMED) latchNow(L_LOW_BATT);
  }
  if (gTorque && (gServoFatal || (gFault & FT_SERVO_MISSING))) {
    if (gServoFatal) gFault |= FT_SERVO_FATAL;
    if (gState == ST_ARMED) latchNow(L_SERVO_FAULT);
  }
  if (gState == ST_ARMED && now - gLastCmdAt >= WD_HOLD_MS) latchNow(L_WATCHDOG);
  if (gState == ST_ARMED) {
    int32_t max = maxStepDeci((int32_t)dtMs, gSpeed);
    for (uint8_t i = 0; i < N; i++) gCommanded[i] = rateStep(gCommanded[i], gTarget[i], max);
    for (int k = 0; k < 2; k++) gDrive[k] = driveStep(gDrive[k], gDriveTarget[k] * gSpeed / 100);
  }
  if (gState == ST_LATCHED && gTorque && (gRelaxRequested || (gFault & RELAX_FAULTS)) && now - gLatchedAt >= WD_RELAX_MS) torqueOff();
  applyOutputs();
}

// ================================================================ BOOT button: pairing window, clear bonds, config mode

static void bootButton() {
  static bool down = false;
  static uint32_t since = 0;
  static uint32_t taps[3] = {0, 0, 0};
  bool pressed = digitalRead(PIN_BOOT_BUTTON) == LOW;
  uint32_t now = millis();
  if (pressed && !down) down = true, since = now;
  if (!pressed && down) {
    down = false;
    uint32_t held = now - since;
    if (held >= AX_CLEAR_BONDS_MS) {
      NimBLEDevice::deleteAllBonds();
      Serial.println("[ax] all bonds cleared");
    } else if (held >= AX_PAIR_HOLD_MS && gPairLocked) {
      Serial.println("[ax] connections locked for 60 s after 5 failed links");
    } else if (held >= AX_PAIR_HOLD_MS) {
      gPairUntil = now + PAIR_WINDOW_MS;
      gPairWindow = true;
      Serial.println("[ax] pairing window open for 60 s");
    } else if (held > 30) {
      taps[0] = taps[1];
      taps[1] = taps[2];
      taps[2] = now;
      if (taps[0] && now - taps[0] < 2000 && !gTorque && gState != ST_ARMED && gState != ST_FAULT) {
        taps[0] = taps[1] = taps[2] = 0;
        if (gState == ST_CONFIG) gState = ST_LATCHED, gLatch = L_BOOT;
        else gState = ST_CONFIG, gLatch = L_CONFIG;
        Serial.println(gState == ST_CONFIG ? "[ax] config mode" : "[ax] config mode off");
      }
    }
  }
  if (gPairWindow && !pairingOpen()) gPairWindow = false;
  if (gPairLocked && (int32_t)(gPairLockUntil - now) <= 0) gPairLocked = false;
}

// ================================================================ supervision: auth timeout, stalled loop

/** Drops a link that has not been encrypted and authenticated in time; retries if the disconnect did not land. */
static void authTimeout() {
  static uint32_t lastKick = 0;
  uint16_t h = gConnHandle;
  if (h == NO_CONN || gAuthOk) return;
  uint32_t now = millis();
  if (now - gConnAt < (pairingOpen() ? PAIR_AUTH_TIMEOUT_MS : AUTH_TIMEOUT_MS)) return;
  if (lastKick && now - lastKick < KICK_RETRY_MS) return;
  lastKick = now ? now : 1;
  gServer->disconnect(h);
}

/**
 * esp_timer task, every 50 ms: if loop() has not run for LOOP_STALL_MS, cut the DC motors (TB6612 standby) and
 * flag it so the loop latches when it resumes. Bus servos cannot be reached from here without colliding with the
 * loop on the bus: they keep their last (rate-limited) goal, and the task watchdog reboots, which turns torque off.
 */
static void stallCheck(void*) {
  if ((int32_t)(millis() - gLoopAt) < (int32_t)LOOP_STALL_MS) return;
  if (!BUS) {
    digitalWrite(PIN_TB_STBY, LOW);
    ledcWrite(PIN_TB_PWMA, 0);
    ledcWrite(PIN_TB_PWMB, 0);
    ledcWrite(PIN_SERVO_PAN, 0);  // no pulses: hobby servos go limp (a no-op if they are detached)
    ledcWrite(PIN_SERVO_TILT, 0);
  }
  gStalled = true;
}

static void supervisionInit() {
  esp_task_wdt_config_t wdt = {.timeout_ms = TASK_WDT_MS, .idle_core_mask = 0, .trigger_panic = true};
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);  // core 3.x usually starts it already
  esp_task_wdt_add(nullptr);                                             // setup() and loop() share this task
  gLoopAt = millis();
  static esp_timer_handle_t timer = nullptr;
  const esp_timer_create_args_t args = {.callback = stallCheck, .arg = nullptr, .dispatch_method = ESP_TIMER_TASK, .name = "ax-stall"};
  if (esp_timer_create(&args, &timer) != ESP_OK || esp_timer_start_periodic(timer, 50 * 1000) != ESP_OK)
    Serial.println("[ax] WARNING: stall timer not running; only the task watchdog guards a stuck loop");
}

// ================================================================ Arduino entry points

void setup() {
  if (!BUS) roverInit();  // motor driver standby low first thing
  pinMode(PIN_BOOT_BUTTON, INPUT_PULLUP);
  if (PIN_STATUS_LED >= 0) pinMode(PIN_STATUS_LED, OUTPUT);
  Serial.begin(115200);
  Serial.printf("[ax] OpenForge AX-1 bridge fw %u.%u, body %u, %u joints (EXPERIMENTAL)\n", FW_VERSION >> 8, FW_VERSION & 0xff, AX_BODY, N);
  for (uint8_t i = 0; i < N; i++) {
    gIds[i] = i + 1;
    gPresent[i] = gCommanded[i] = gTarget[i] = DEF.joints[i].home;
  }
  loadLimits();
  if (PIN_BATT_ADC >= 0) analogSetPinAttenuation(PIN_BATT_ADC, ADC_11db);
  if (BUS) {
    Bus.begin(BUS_BAUD, SERIAL_8N1, PIN_BUS_RX, PIN_BUS_TX);
    bootCheckBus();
  }
  if (gFault & (FT_BAD_MODEL | FT_BAD_MODE | FT_SERVO_MISSING)) {
    gState = ST_FAULT;
    gLatch = L_BOOT_CHECK;
    Serial.printf("[ax] boot check failed, fault bits 0x%02x: the bridge will not arm until fixed and rebooted\n", gFault);
  } else {
    gState = ST_LATCHED;
    gLatch = L_BOOT;
  }
  bleInit();
  publishState(false);
  supervisionInit();
}

void loop() {
  static uint32_t lastCtl = millis(), lastNotify = 0;
  gLoopAt = millis();
  esp_task_wdt_reset();
  if (gStalled) {  // the timer cut the motors while we were stuck: hold and latch
    gStalled = false;
    if (gState == ST_ARMED) latchNow(L_WATCHDOG);
    Serial.println("[ax] control loop stalled: latched");
  }
  processInbox();
  bootButton();
  authTimeout();
  uint32_t now = millis();
  if (now - lastCtl >= CONTROL_MS) {  // no catch-up bursts: one step per elapsed interval, sized by real time
    uint32_t dt = now - lastCtl;
    lastCtl = now;
    controlStep(dt > MAX_STEP_DT_MS ? MAX_STEP_DT_MS : dt);
  }
  if (now - lastNotify >= STATE_MS) {
    lastNotify = now;
    publishState(true);
  }
  if (PIN_STATUS_LED >= 0) digitalWrite(PIN_STATUS_LED, gState == ST_ARMED ? HIGH : ((now / (pairingOpen() ? 100 : 500)) & 1));
  delay(1);
}
