# 13 · Phone Brain and OpenForge AX-1

Status: app and twin working in the browser; bridge firmware **experimental and untested on hardware** (phase 3 is
the first physical build). Licence: CC0 for everything in this repo; third-party build dependencies in
`firmware/ax-bridge/NOTICE`.

## 1. What it is

Phone Brain (`web/pilot.html`) turns a smartphone into the brain of **OpenForge AX-1**. The phone does the seeing,
the deciding and the user interface; a small ESP32 board, the **bridge**, runs the real-time motor and servo loop
and enforces every safety rule.

```
Phone (pilot.html, PWA)                 ESP32 bridge (firmware/ax-bridge)          Body
touch, tilt, camera ── BLE GATT ──────▶ AX-1 service, state machine     ── TTL ─▶ STS3215 bus servos (Desk, Walker)
twin view ◀── AX_STATE 10 Hz ────────── watchdog, limits, rate limit    ── PWM ─▶ TB6612 + 2 DC motors, 2 hobby servos (Rover)
```

With no robot the app drives a **3D twin**. The twin is not a separate animation: it runs `bridge-sim.js`, the
same state machine as the firmware, behind a transport with the same interface as Bluetooth. Every command takes
the real path (encode → bridge → `AX_STATE` → decode), so trying the twin exercises the protocol and the safety
rules. The twin is the default and works on any device, iPhone included.

| File | Role |
|---|---|
| `web/pilot.html`, `web/css/pilot.css`, `web/pilot.webmanifest` | The app (installable PWA, no service worker) |
| `web/js/pilot/ax-proto.js` | Protocol codec (pure, Node-importable) |
| `web/js/pilot/bridge-sim.js` | Reference model of the firmware state machine |
| `web/js/pilot/drive-loop.js` | Phone link state machine, 33 ms latest-wins sender, ARM/STOP, reconnect |
| `web/js/pilot/twin-transport.js`, `ble-transport.js` | Same interface: in-page twin, or Web Bluetooth |
| `web/js/pilot/sensors.js` | Tilt, camera "look at movement" (frame differencing, no ML), Wake Lock |
| `firmware/ax-bridge/` | ESP32 sketch, C++ codec mirror, config, test vectors |
| `scripts/loopback-bridge.mjs` | Node run of app loop + bridge model with real timers (CI smoke test) |
| `test/AxProto.test.js`, `test/PilotBridge.test.js` | Codec, vectors, state machine, drive loop |

## 2. The three bodies

| Body | Actuators | Bridge drives | Status |
|---|---|---|---|
| **AX-1 Rover** | 2 geared DC motors (TB6612), 2 hobby servos for the phone's pan/tilt head | DRIVE frames: left/right −1000…1000 + pan/tilt | First build |
| **AX-1 Desk** | 7 × STS3215: body turn, head pan/tilt, two 2-DoF arms | JOINTS frames, servo IDs 1–7 in table order | Next |
| **AX-1 Walker** | 13 × STS3215: 12 leg servos + torso yaw | JOINTS frames, **still poses only, no gait** | Experimental |

Joint tables (names, limits in 0.1°, servo ID order) are defined once in `ax-proto.js` and mirrored in
`ax_proto.h`; a test checks they agree with each other and with the twin's joint names.

## 3. Bill of materials

Prices are list prices from `docs/research/open-robot-catalog.md` (checked 2026-10-26, USD, before shipping and
tax). "to verify" = no confirmed source yet. The phone is not included. **Every body gets a physical kill switch
on the motor/servo power line.**

**Rover** — target ≈ $50–80 (to verify at the first build)

| Part | Qty | Price | Note |
|---|---|---|---|
| ESP32-WROOM-32 DevKit (38-pin) | 1 | $8–12, to verify | Original ESP32 (BLE + Classic). ESP32-S3/C3 also work for BLE, pins differ |
| TB6612FNG breakout (Adafruit #2448) | 1 | $6.95 | Add a 10 kΩ pull-down on STBY |
| TT gear motor 200 RPM (Adafruit #3777) | 2 | $5.90 | + wheels and a caster, to verify |
| MG90S micro servo (Waveshare) / SG92R (Adafruit #169) | 2 | $5.18 / $11.90 | Pan/tilt head |
| 2S Li-ion pack (2 × 18650 + BMS) | 1 | to verify | 7.4 V nominal |
| 5 V 3 A buck (Pololu D36V28F5 #3782, or a generic one) | 1 | $23.95 / to verify | Servos + ESP32 |
| Kill switch (rocker, ≥ 5 A) + fuse | 1 | to verify | |
| Divider 30 kΩ + 10 kΩ for battery sense | 1 | cents | |
| Printed chassis and phone clamp (CC0, original) | – | filament | |

All-in-one alternative: Waveshare **General Driver for Robots** ($27.99: ESP32 + TB6612 + ST3215 bus port + IMU).
Its pins differ from `config.h`: read its schematic first.

**Desk** — verified subtotal $125.22 (General Driver $27.99 + 7 × STS3215 at $13.89), target ≈ $150–170 with a
7.4 V supply or 2S pack, clamp and filament. A bare ESP32 plus a Waveshare Bus Servo Adapter (A) ($4.99) works too.

**Walker** — verified subtotal $208.56 (General Driver $27.99 + 13 × STS3215), target ≈ $250–270 with a
high-current 2S pack, screws and filament. Poses only until a walking policy exists in sim and on a real unit.

STS3215 7.4 V servos match a 2S pack directly. 12 V servos need a 3S pack and a different low-voltage cutoff.

## 4. Wiring (generic ESP32 DevKit, as in `config.h`)

Rover:

```
 2S pack + ──[KILL SWITCH]──[FUSE]──┬──────────────── TB6612 VM
                                    └── 5 V buck IN ── 5 V ─┬── ESP32 5V (VIN)
                                                            ├── servo PAN  +   (red)
                                                            └── servo TILT +   (red)
 2S pack − ─────────────────────────── GND common to TB6612, buck, ESP32, servos
 2S pack + ── 30k ──┬── 10k ── GND
                    └──────────── GPIO34 (battery sense, ADC1)

 ESP32            TB6612                    ESP32           servos
 GPIO32 ───────── STBY  (+10k to GND!)      GPIO22 ──────── PAN  signal
 GPIO25 ───────── PWMA                      GPIO23 ──────── TILT signal
 GPIO26 ───────── AIN1    AO1/AO2 ── left motor
 GPIO27 ───────── AIN2
 GPIO4  ───────── PWMB    BO1/BO2 ── right motor
 GPIO13 ───────── BIN1
 GPIO33 ───────── BIN2
 3V3    ───────── VCC (logic)
```

Desk / Walker (STS3215 bus through a half-duplex adapter such as Waveshare Bus Servo Adapter (A)):

```
 2S pack + ──[KILL SWITCH]──[FUSE]── adapter V+ ── servo bus (daisy chain, IDs 1..7 or 1..13)
 GPIO18 (RX) ── adapter TX      GPIO19 (TX) ── adapter RX      GND common
```

Never use the ESP32 strapping pins (0, 2, 5, 12, 15) or 6–11 for outputs. Set servo IDs once (LeRobot motor
setup or Feetech tools) and measure each joint's centre into `BUS_CENTERS` / `BUS_DIRS`.

## 5. Flash the bridge (no experience needed)

See `firmware/ax-bridge/README.md` for the click-by-click version. In short: Arduino IDE 2 → install
**esp32 by Espressif** (3.x) and the **NimBLE-Arduino** library (2.x) → open `ax-bridge.ino` → in `config.h` pick
the body, **type your own 6-digit passkey** (the sketch will not compile until you do) and check the pins →
board *ESP32 Dev Module* → Upload → Serial Monitor at 115200 shows the boot check.

## 6. Pairing and first drive

1. Power the robot, wheels off the table. Hold **BOOT** 2 s: the 60 s pairing window opens. After 5 wrong
   passkeys the robot refuses every connection for 60 s.
2. Phone: Chrome on Android. Open `pilot.html`, *Connect a real AX-1* → *Connect* → pick **AX-1** → type the
   passkey from the sticker. The app reads `AX_INFO` and refuses to drive if the protocol major differs.
3. The robot is **latched**. Press **ARM** when it is clear. Rover: press and hold the joystick to drive; let go
   to stop. Desk: sliders and gestures (wave, nod, point, shrug). Walker: poses.
4. **STOP** (the red bar, or Space / Esc) always works. After any stop, motion needs a new ARM.

## 7. Safety rules

The phone link is untrusted; the app's checks are UX. The firmware enforces:

| Rule | Where |
|---|---|
| Boot: torque off, TB6612 standby low, STS3215 model 777 + position mode checked, nothing moves | `setup()`, `bootCheckBus()` |
| LATCHED until ARM; ARM refused on any fault, low battery, MTU < 64 or a reused nonce (nonces are tracked per connection: a reconnect starts fresh, and still lands latched) | `handleArm()` |
| ARM: goal = present **before** torque on, then verify no servo jumped > 2° (else torque off) | `handleArm()` |
| Staged watchdog: no valid CMD 250 ms → HOLD (goal = present, motors brake) + latch | `controlStep()` |
| 3 s after the hold: torque off **only** after a fault or a user RELAX request | `controlStep()` |
| Boot and a failed boot check are limp (torque off): a joint under load can sag until the first ARM | `setup()` |
| `loop()` under the ESP task watchdog (1 s → reboot → torque off); a 50 ms timer cuts the DC motors and hobby-servo pulses if `loop()` stalls 300 ms (bus servos hold their last goal until the reboot) | `supervisionInit()` |
| Never resumes on its own: every latch needs a new ARM | state machine |
| Joint limits from `ax_proto.h`, narrowed (never widened) from NVS in config mode; targets and open-loop angles re-clamped after a change and on ARM | `loadLimits()`, `handleConfig()` |
| 90 °/s rate limit × speed %, sized by the real time since the last tick (no catch-up bursts); wheel speed-up slew-limited, slow-down immediate; a DRIVE frame without the wheels bit stops them | `rateStep`, `driveStep` |
| Low-voltage cutoff (2S: 6.4 V; 3S: 9.6 V) → HOLD; ARM needs +0.2 V hysteresis | `controlStep()` |
| Fatal servo error (voltage, heat, current, overload) or 5 missed replies → HOLD | `busReadPresent()` |
| RAM-only register writes; ACCEL, velocity cap, torque limit resent every SYNC_WRITE; TORQUE only 0/1 | `ax_proto.h sts::` |
| Replay protection: drop seq ≤ last accepted (16-bit wrap, window 1024) | `seqNewer()` |
| Static passkey (MITM), LE Secure Connections requested, 128-bit keys only; writes need an encrypted, authenticated link on the accepted connection | `bleInit()`, `linkOk()` |
| Unknown phones may connect only within the 60 s window (bonds made outside it are deleted once the link is down); 5 links that end unauthenticated lock every connection out for 60 s; a link must authenticate within 10 s (45 s while the window is open); the 10 s press clears bonds and drops the linked phone; one connection; no advertising while connected | `ServerCB`, `authTimeout()` |

The app adds: hold-to-drive dead-man, STOP on `visibilitychange` (hidden) and on page hide, STOP when its own
timer stalls (> 283 ms between ticks), ARM only from a click or key, and an ARM that the bridge does not confirm
within 600 ms counts as refused.

## 8. Protocol (version 1.0)

Service `7a3e0000-4f1b-4c2a-9d0e-5b6c7d8e9fa1`; characteristic *n* = `7a3e000n-…`. Little-endian; angles are
int16 tenths of a degree. Requested MTU 247; below 64 the bridge sets fault `MTU_LOW` and refuses ARM.

| Char | UUID n | Properties | Payload |
|---|---|---|---|
| `AX_INFO` | 1 | read (open) | `proto_major u8, proto_minor u8, fw_ver u16, body u8, n_joints u8, limits_hash u32` (10 B) |
| `AX_CMD` | 2 | write w/o response, enc + MITM | JOINTS: `ver u8, type=1, seq u16, mask u16, popcount(mask) × i16 target, speed_pct u8` · DRIVE: `ver, type=2, seq, mask (1 wheels, 2 pan, 4 tilt), left i16, right i16, pan i16, tilt i16, speed_pct` (15 B) |
| `AX_STOP` | 3 | write with response, enc + MITM | `ver u8, reason u8` (0 hold, 1 hold then relax). Any content stops |
| `AX_ARM` | 4 | write with response, enc + MITM | `ver u8, nonce u32 (≠ 0, ≠ previous), seq_base u16` (7 B). Next CMD must be newer than `seq_base` |
| `AX_STATE` | 5 | notify 10 Hz + read, enc + MITM | `ver u8, state u8, latch u8, flags u8, fault u16, batt_mV u16, last_seq u16, n u8, n × i16` (11 + 2n B). Channels: joints in table order, then `drive_l, drive_r` for the Rover |
| `AX_CONFIG` | 6 | write with response, enc + MITM, config mode only | `ver u8, op u8 (1 set limit, 2 save, 3 reset), joint u8, min i16, max i16` |

| Code | state | latch reason | flags | fault bits |
|---|---|---|---|---|
| 0 | boot | none | – | – |
| 1 | latched | boot | torque on | low battery |
| 2 | armed | user stop | pairing window open | servo fatal error |
| 3 | fault (boot check) | watchdog | relax pending | servo missing |
| 4 | config | link lost | | (8) not STS3215 · (16) not position mode |
| 5–8 | | low battery · servo fault · boot check · config | | (32) MTU < 64 · (64) torque-on jump |

`limits_hash` is FNV-1a 32 over `body, n, (min, max, home) × n` (int16 LE); the app shows "custom limits" when it
differs from its own table. The codec, STS frames and conversions are pinned by `firmware/ax-bridge/test/*.json`
(regenerate with `AX_WRITE_VECTORS=1 npx hardhat test test/AxProto.test.js`).

## 9. Phone features

- **Capability panel** first: Web Bluetooth, motion, camera, Wake Lock, HTTPS, each with what works without it.
- **Drive:** joystick or button D-pad, both hold-to-drive; keyboard arrows/WASD on desktop; optional tilt-to-steer
  (iOS asks permission on the toggle tap). Speed slider caps every command.
- **Look at movement:** the front camera is sampled at 64 × 48, 12 fps; the centre of changed pixels turns the
  twin's eyes, and the head (or the Walker torso) once armed. Nothing is recorded or sent.
- **Performance:** pixel ratio ≤ 1.5, 1024 px shadow map, no post-processing, ~30 fps, paused when hidden.
- **PWA:** `pilot.webmanifest` (standalone, maskable icon). No service worker yet.

## 9a. AI Pilot

A chat panel on `pilot.html`. You type a request ("wave, then look left", "drive forward 2 seconds then turn
right"); it becomes a short plan of tool calls, shown as a card, and runs through the **same drive loop as the
buttons**, on the 3D twin or the real robot. The AI never arms the robot; STOP always wins.

**Two planners, one set of rules.** With no model, a built-in parser reads short English commands (works out of the
box, offline). With a model you run yourself, free-form requests work too, and a new message while the robot is moving
re-plans from where the last plan was cut. Every plan says where it came from: *built-in parser* or *model*. If the model
is down or answers nonsense, the app says so and falls back to the parser.

**Built-in parser.** Clauses joined by `then`, `and then`, `,` `;` `.`: move (`forward`, `back`, `go`, `reverse`, with
`2 s`, default 1 s), turn (`turn`, `rotate`, `spin` + `left`/`right`/`around` + degrees, default 90), look (`look left`,
`look up`, `look center`, `pan -30`, `tilt 15`), acts (`wave nod point shrug home` on the Desk; `stand crouch lean left
lean right twist` on the Walker), `wait 2 s`, speed (`slow`, `fast`, `speed 50%`) and `stop`. Words the body cannot
do get an honest answer ("The Rover has no arms."); anything else: "I didn't understand 'x'. Try: ...".

### Set up a model (optional)

Any OpenAI-compatible server on your own machine: the page calls `POST {address}/v1/chat/completions` with the tool
list, `tool_choice: "auto"`, no streaming. Open **Model settings** in the panel, enter the address and the model name,
press **Save**, then **Test connection**. Settings live in this browser's `localStorage`; there is no API key field.
The header always says what is in charge, for example `Model: qwen2.5:3b at localhost:11434 (this computer)` or
`No model: built-in parser`.

| Server | Steps | Address |
|---|---|---|
| **Ollama** | install, `ollama pull qwen2.5:3b`. A page opened from `localhost` works as is. For any other site origin, set `OLLAMA_ORIGINS` to that origin and restart Ollama | `http://localhost:11434` |
| **LM Studio** | load a model, **Developer** tab, **Start Server**, enable **CORS** | `http://localhost:1234` |
| **llama.cpp** | `llama-server --jinja -m model.gguf` (`--jinja` turns tool calling on) | `http://localhost:8080` |

Use an instruct model with tool calling, 3B or larger: Qwen2.5 3B / 7B Instruct, Llama 3.2 3B Instruct. Smaller models
often ignore the tools; the parser fallback covers that. The address must be `http(s)` on `localhost`, `127.0.0.1` or
`127.0.0.1` (Chrome does not accept `[::1]` in a CSP, so use one of those two); an "other hosts" box exists for self-hosted copies, but this site's Content-Security-Policy only allows
`connect-src 'self' http://localhost:* http://127.0.0.1:*`, so another host needs a policy you set
yourself. Answers are capped at 64 KB and 20 s; redirects, cookies, referrers and credentials are never sent.

### The tools a plan may use

Degrees, seconds, percent of **your** speed slider. Positive pan, turn and torso yaw mean **left**, positive tilt means
**up** (the twin's joint convention). Ranges come from the `BODIES` tables in `ax-proto.js`.

| Body | Tools |
|---|---|
| all | `wait(seconds 0.1-5)`, `say(text, 200 chars)`, `stop()` |
| Rover | `drive(direction forward/back/left/right/forward_left/forward_right, seconds 0.1-3, speed 10-100)`, `turn(degrees -180..180, speed)` (open loop: timed, so "about"), `look(pan -90..90, tilt -30..30)` |
| Desk | `set_joints(torso_yaw, head_pan, head_tilt, l/r_shoulder, l/r_elbow; each optional, clamped)`, `gesture(wave/nod/point/shrug/home)`, `look(pan, tilt)` |
| Walker | `pose(stand/crouch/lean left/lean right/twist)`, `torso(yaw -60..60)` |

There is **no** tool to arm, connect, configure, change limits or the speed setting, relax, or reach a URL.
A plan has at most 12 steps and 30 s in total, counted at your current speed setting (slow turns take longer, so fewer
fit). Model output is untrusted: it is validated against this table,
unknown tools and fields are dropped, numbers are clamped (NaN and strings are refused, not guessed), and `say` text is
shown as plain text under "Model says".

### Safety rules

- **The AI never arms the robot.** If it is latched, the plan is shown with an inactive **Run** and "Press ARM to let me
  move. I can't arm the robot." After you ARM, the plan still waits for **Run**.
- **Real robot (Bluetooth): every plan needs a Run click.** On the twin an armed plan runs by itself.
- **STOP always wins.** STOP, Space, Esc (Esc also works inside the chat box, where Space types), a hidden page or a
  closed page abort the plan first, then cancel gesture timers, then stop the loop; nothing resumes and the next move needs a new ARM.
- **A latch from the bridge** (watchdog, servo fault, low battery) or a lost link ends the plan and shows the reason.
- **You take the controls** (stick, keys, sliders, a gesture button) and the plan ends: "You took the controls."
- **A new message is an interruption:** the move stops at once, the robot **stays armed**, the old request is aborted
  and its late answer is ignored, and the model is told "step 2/3 (drive forward 2 s)" so it can re-plan.
- **Drives are leases.** The executor drives through `loop.holdFor(ms, x, y)`: at most 3 s, and the loop sends zero wheels
  in the first frame at or after the end, so a frozen page cannot leave the wheels running. The 250 ms stall check and
  the bridge's own watchdog stay. Joint moves wait `max|delta| / (90 deg/s x your speed) + 150 ms`.
- **Hard deadline.** No plan runs longer than 45 s of wall-clock time, whatever its estimates said: the plan ends, the
  wheels go to zero and the robot stays armed.
- **Real robot: losing window focus stops a running plan** (you could not reach STOP from another window).
- **The AI never takes a human's stick:** a drive lease is refused while you hold the controls.
- **A stale plan card cannot run:** Run only starts the plan it belongs to.
- **The speed slider is a ceiling.** A step's `speed` scales the stick inside your cap; the AI cannot change the cap.

### Privacy

Only these reach the model, and only the server you entered: the text you typed (and its short history, 6 messages at
most), the body name, joint names and limits, joint positions, the link state (armed / latched) and your speed cap.
Never the camera picture, the passkey, the device name, a wallet, the page address or anything from storage. Without a
model nothing leaves the page at all.

### Not verified yet

- Real behaviour of Ollama, LM Studio and llama.cpp (tool-call formats, CORS flags) was tested only against a fake
  OpenAI-style server. The `<tool_call>` and JSON-in-text fallbacks exist because small models differ.
- Chrome's Local Network Access prompt for a site calling a service on your device is not handled in code, and no
  `Permissions-Policy` token for it is set: the headers in `web/_headers` and `scripts/serve.mjs` are unchanged.
- The turn is open loop (a timed spin), so the angle is approximate; there is no feedback from the robot.

## 9b. AR twin ("AX-1 in your room")

`ar.html` puts the AX-1 Rover **twin** (never the real robot) in your room at real size (~23 cm) and drives it by voice
or chips through the same AI Pilot, built-in parser and drive loop as `pilot.html`. Model servers are not used here.

**Modes.** The page probes the phone and picks one:

| Mode | Where | What you get |
|---|---|---|
| **AR** | Android Chrome on ARCore phones (WebXR `immersive-ar`) | The twin anchored to the floor (hit-test, anchors, light estimation, shadow), obstacle sensing |
| **Camera view** | iPhone and browsers without WebXR AR | The twin drawn over the live camera; not anchored to the floor, no obstacle sensing (the page says both) |
| **Desktop** | No phone | "Open this on your phone" with the page address and a link to the 3D twin |

**Safety.** The same rules as §9a, plus:

- Only placing the Rover (a tap on the floor, or the **Place the Rover here** button for keyboard and screen-reader
  users) or the **ARM** button arms it, and only from a real tap or key press. Voice, chips and object requests never arm.
- STOP, Esc, voice "stop" anywhere in a sentence (also "halt", "freeze", "brake", "abort"), the page going to the
  background, the page being closed and the AR session ending all latch it; nothing resumes until ARM.
- A blurred AR session, an obstacle 5 cm ahead or the edge of the 3 m play area **hold** it: the wheels go to zero
  within one tick, the plan ends, the Rover stays armed.
- **Buttons:** a tap on Forward, Back, Left or Right is a short move; **holding** one keeps the Rover moving until the
  finger lifts (leases of 0.4 s renewed while held, through the same obstacle and edge checks; a frozen page stops by
  itself within one lease). Voice also reads "left", "right" and "spin" alone, like the buttons.
- **Microphone:** the browser's permission question is not shown inside AR, so the start card has **Enable
  microphone** (it shows "Microphone on" once allowed). Inside AR, without the permission, the mic button says
  "Microphone off" and explains instead of asking.
- **Obstacles** (AR mode, phones with the ARCore Depth API): the phone's depth is read along the twin's forward
  corridor (60 cm ahead, Rover width, 5–26 cm above the floor). An obstacle seen there is tracked after three frames
  ("Obstacle about 30 cm ahead"); the Rover drives on and stops about **5 cm** before it (it starts stopping 0.2 s of
  travel earlier, so the stop ends at the gap at any speed; between depth frames the odometry counts the distance
  closed). Then forward is refused; turns and backing up still work; eight clear frames unblock. Without depth a forward
  hit-test ray is used. When the corridor is out of view the chip says so and nothing is blocked. Most phones (a Galaxy
  S24 too) have no depth sensor and estimate depth from motion, which reads a plain floor several per cent short: every
  evaluation calibrates that error on the floor beside and behind the Rover, and a surface counts only when it stands
  clearly in front of the floor (5 cm or 6% of its distance). Things about 20 cm tall or more are found; lower ones only
  with the phone about a metre away or closer.

**Look around (optional, off by default).** Finds the 80 COCO object types (cup, chair, person, …) with MediaPipe
Tasks Vision 1.1.1 and the EfficientDet-Lite0 int8 model, both self-hosted under `vendor/mediapipe/` (Apache 2.0, the
model checked by sha256 at build). Turning it on downloads up to about 19 MB once (about 8 MB if the host compresses).
Requests: "what do you see", "go to the cup", "find the cup", "avoid the chair". Trips re-plan at most 5 times within
45 s and end when the Rover arrives, loses the object for 2 s, or you say anything else. Detection runs in a Web Worker
on 320 px frames, at most twice a second and one frame at a time (measured on a desktop: 105–125 ms per frame in the
worker, no main-thread task over 50 ms). If the worker cannot start it falls back to the main thread only while the Rover
is not armed, and turns itself off when the phone is too slow.

**Privacy.**

- Camera pictures never leave the phone: detection is on the device, and `ar.html` has `connect-src 'self'`.
- **MediaPipe telemetry is blocked.** MediaPipe 1.1.1 always starts a usage logger that posts to a Google logging
  endpoint and has no setting to turn it off. The worker (and the fallback) reject every `fetch`, `XMLHttpRequest` and
  `importScripts` to another origin locally, before the network, and remove `WebSocket`, `EventSource` and
  `sendBeacon`; the worker's own CSP header (`connect-src 'self'`) blocks it a second time.
- **Voice:** the browser's speech service turns your words into text. In Chrome the audio may be processed on Google's
  servers; in Safari, Apple's. The page says so next to the mic.

**Not verified yet.** Built and tested in desktop Chrome and with emulated phones only: no real ARCore phone or iPhone
yet. To check on hardware: the depth-buffer convention, stalls during placement and detection, the mic prompt inside an
AR session, select vs overlay taps, and the iPhone camera view. Thin, dark, glossy or moving obstacles are untested.

## 10. Limitations

- **iOS:** Safari and every iOS browser engine lack Web Bluetooth. iPhone users drive the twin, or try a
  BLE-capable browser such as Bluefy (not tested by us).
- **Firefox:** no Web Bluetooth.
- **Firmware:** written against Arduino-ESP32 3.x and NimBLE-Arduino 2.x, never compiled in our CI (no toolchain)
  and never run on hardware. Expect fixes at the first build. A C++ host test that replays the JSON vectors is the
  next step.
- Hobby servos are open loop: at the first ARM they jump to their last commanded angle (centre after boot).
- The Walker has no gait. Joint limits for the Walker are placeholders until a real frame exists.
- Web Bluetooth gives no reason when a write is rejected; the app infers ARM refusals from `AX_STATE`.

## 11. Hardware safety disclaimer

This is an open hobby design, provided as is, with no warranty (CC0). Motors, gears and lithium batteries can
pinch, cut, burn or start fires. Build and test on a bench with the wheels or limbs free, keep fingers, hair, pets
and children away, use a fused battery with a protection board and a kill switch within reach, never leave a
powered robot unattended, and charge lithium cells only with a proper charger on a non-flammable surface. The
software watchdogs reduce risk; they do not replace the kill switch. You are responsible for what you build.
