# AX-1 bridge firmware (ESP32)

> **Experimental and untested on hardware.** The logic is tested in simulation (`web/js/pilot/bridge-sim.js`,
> `npx hardhat test test/PilotBridge.test.js`), not on a real robot. Build on a bench, wheels off the table,
> servo power on a kill switch you can reach.

The bridge turns phone commands (Bluetooth LE) into motor and servo motion and owns every safety rule:
watchdog, joint limits, rate limit, low-voltage cutoff, fault hold. The full guide, wiring and protocol are in
[`docs/13-PHONE-BRAIN.md`](../../docs/13-PHONE-BRAIN.md).

| File | What |
|---|---|
| `ax-bridge.ino` | The sketch: state machine, BLE service, STS3215 bus loop, TB6612 + hobby servos |
| `ax_proto.h` | Protocol codec and STS frames, pure C++ (mirror of `web/js/pilot/ax-proto.js`) |
| `config.h` | Body, passkey, pins, calibration. **Edit this.** |
| `test/ax-vectors.json`, `test/sts-vectors.json` | Byte-exact vectors generated from the JS codec; a C++ host test must reproduce them |

## Flash it (Arduino IDE 2)

1. **Board support:** *File → Preferences → Additional boards manager URLs*, add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then *Tools → Board → Boards Manager*,
   install **esp32 by Espressif Systems** (version 3.x).
2. **Library:** *Tools → Manage Libraries*, install **NimBLE-Arduino** by h2zero (version 2.x).
3. Open `ax-bridge.ino`. In `config.h`:
   - set `AX_BODY` to `ax::BODY_ROVER`, `ax::BODY_DESK` or `ax::BODY_WALKER`;
   - set `AX_PASSKEY` to your own six digits (100000–999999). The sketch refuses to compile with the placeholder 0.
     Write the number on a sticker on the robot;
   - check every pin against your board and wiring.
4. *Tools → Board → ESP32 Dev Module*, pick the USB port, press **Upload**. Open the Serial Monitor at 115200 baud:
   it prints the body, the joint count and the boot check result.

## Pair a phone

1. Hold **BOOT** on the ESP32 for 2 seconds: a 60-second pairing window opens.
2. On the phone, open `pilot.html` in Chrome (Android) or Chrome/Edge (desktop), choose *Real robot*, press
   *Connect* and pick **AX-1**. Type the passkey when the phone asks.
3. Later connections need no passkey. Hold BOOT for 10 seconds to forget every paired phone.

Outside the window, only paired phones can connect. After five failed attempts the robot refuses every connection
for 60 seconds. A link that is not authenticated within 10 seconds (45 while the window is open) is dropped.

## Buttons

| BOOT press | Effect |
|---|---|
| 2–10 s | Pairing window, 60 s |
| ≥ 10 s | Clear all bonds |
| 3 short presses within 2 s | Enter or leave config mode (only when stopped with torque off): joint limits can be narrowed over `AX_CONFIG` and saved to NVS |

Do not hold BOOT while powering on: that starts the ESP32 bootloader.
