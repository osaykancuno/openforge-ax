# Robot Link: play your agent's runs on a real SO-101

> Status: v0.1 implemented, `web/robot.html` + `web/js/robot/` (38 Node tests on an emulated servo bus, browser-checked with the virtual arm). **Not yet run on physical hardware**: a team member must do the first real run at 0.25× before the feature is announced. v0.1 folds in the ECC architecture review, an ECC security review (2 critical, 3 high and 8 medium findings fixed, each with a regression test) and a final ECC code review (1 high and 7 medium fixed). The Python bridge (`scripts/real/replay_so101.py`) stays for LeRobot users.

## 1. Goal
A holder with an SO-101 follower arm, but no Python, LeRobot or terminal experience, replays a Proving Grounds run on the physical arm in about 10 minutes. The page guides each step and has safety built in. Nothing to install: a Chromium desktop browser (Chrome, Edge, Opera) talks to the servos over **Web Serial**. Without an arm, the same wizard runs on a **virtual arm**.

Non-goals for v0.1:
- recording real runs on-chain (Phase 2 real stations);
- teleoperation with a leader arm;
- LeRobot dataset export or calibration import;
- setting servo IDs. The page detects factory IDs and points to LeRobot's motor setup;
- Firefox, Safari and mobile (no Web Serial). These users get the virtual arm or the Python bridge.

## 2. User flow
Each step shows one instruction, one primary button and the 3D twin. The twin either shows the pose or motion to copy, or mirrors the real arm live once it is calibrated.

| # | Step | The user | The page |
|---|---|---|---|
| 1 | Run | Picks their last Proving Grounds run (the arena's "Play on my real robot" button), uploads a file, or picks "Demo run" | Validates the run and re-simulates it with the shared sim. Unsafe runs are refused, with the reason in plain English. |
| 2 | Connect | Plugs in power and USB, clicks **Connect**, picks the port | Finds servos 1–6 and refuses anything that is not an STS3215 in position mode. Shows the voltage. Explains missing joints and factory IDs. A known arm skips straight to step 5. |
| 3 | Calibrate | Turns torque off while holding the arm, poses it like the twin, then moves one joint at a time the way the twin does and to both ends | Captures the pose after a countdown, once the arm has been still for 1 s. Records each joint's direction and range. **Next** unlocks only when the range covers the rest pose; the hint says "keep going the other way too". Wrist roll needs a direction only. |
| 4 | Check | Folds the arm to rest, hands off; answers "Did it move like the twin?" for each joint | Turns torque on and nudges each joint ±8° (gripper ±25 %), driven by the servos. "No" reverses that joint's direction. The calibration is saved, marked `verified`, only when every joint passes. Until then, only these nudges can move the arm. |
| 5 | Set up | Puts the cell, then the dock, right under the gripper | The arm points 7 cm above each spot, so objects land where *this* arm thinks they are; this absorbs calibration error. Distances are also shown in cm. |
| 6 | Play | Picks a speed (0.25–1×, default 0.5×), ticks "space is clear", presses **Play** | The first play of each run, on each calibration, is **always** a rehearsal 5 cm above the table. Then the real run. STOP is always visible and focused, and **Return to rest** / **Relax** are offered afterwards. |

The calibration is saved in `localStorage` (per-browser convenience) and treated as untrusted. It is reused only when all of these hold:
- it is well formed and within bounds;
- its safe ranges recompute from its own measurements, so editing `safe` is useless;
- it was recorded on servos with the same EEPROM limits;
- each joint reads inside its measured range;
- with the arm folded to rest by hand, the four main joints read within 15° of rest (a different arm, or a re-mounted servo, is far off).

## 3. Hardware protocol (Feetech STS3215, LeRobot conventions)
- **Packet:** `FF FF id len instr params… chk`, with `len = params + 2` and `chk = ~(id + len + instr + Σparams) & 0xFF`.
- **Values:** 16-bit, little-endian. Positions are **sign-magnitude, bit 15** (arms calibrated with LeRobot can read below zero).
- **Instructions:** PING `0x01`, READ `0x02`, SYNC_READ `0x82`, SYNC_WRITE `0x83`. Writes always use SYNC_WRITE, which gets no reply.
- **Registers written:** RAM only, never EEPROM.
  - Torque_Enable 40: only 0 or 1.
  - Acceleration 41: ×100 steps/s².
  - Goal_Position 42.
  - Goal_Time 44: always 0.
  - Goal_Velocity 46: steps/s, 1 step = 0.088°.
  - Torque_Limit 48: 0–1000.
- **Registers read:** Model 3 (must be 777), Min/Max_Position_Limit 9/11, Max/Min voltage 14/15, Operating_Mode 33 (must be 0), Present_Position/Velocity/Load 56–61, voltage 62.
- **Pitfall:** Goal_Velocity 0 and Acceleration 0 both mean *unlimited*, and they reset on a brown-out. So **every command resends registers 41–49 in one SYNC_WRITE**, with velocity ≥ 1 and acceleration 100.

## 4. Calibration model
- **Joints 0–4:** `raw = zero[j] + sign[j] · deg · 4096/360`.
- **Gripper:** linear from the closed raw value (taken in the pose) to the opposite end of its range minus 5° (0 = closed, 100 = open).
- **Pose:** `[0, 0, 90, 90, 0, 0]`: upper arm up, forearm forward, gripper down and closed.
- **Safe range per joint:** (measured range shrunk by 5°) ∩ the servo's EEPROM limits ∩ the sim's `LIMITS`.
- **Wrist roll:** fixed ±100° window, because it has no hard ends.
- **Refused:**
  - a range that wraps the servo's zero (a jump of more than half a turn between samples): "servo not centred";
  - too little travel;
  - a rest pose outside the range.
- **Each error names the step to repeat.**

## 5. Safety
- **Run check (`motionProblems`, also enforced inside the player):**
  - `validateActions`;
  - the tip, wrist and elbow stay ≥ 8 mm above the table in **every** frame. The sim stops checking when the mission ends, so a run could append anything after docking;
  - no jitter: more than 4 direction reversals of more than 1° per joint within any 1 s is refused;
  - then a local replay (cell not lost) and every frame inside the calibrated range.
- **Speed ceiling:** whatever the file or the speed setting, the run plays slower if needed so that no arm joint exceeds 90°/s (`effectiveSpeed`). Every servo speed command is clamped to 1…108°/s. A NaN or 0 speed can never be sent, because 0 means unlimited. Goals are clamped into the safe range at the write layer.
- **Torque on (`holdHere`):**
  1. wait until no joint moves more than 1° for 0.5 s (hands off);
  2. goal = present, with the limits, then enable;
  3. check that nothing moved by more than 2°, otherwise turn torque off again.

  No goal is written while torque is off.
- **Limits:**
  - per-servo speed cap at 1.5× the plan's peak speed at the chosen playback speed;
  - acceleration 100;
  - torque limit 80 % on the arm joints and 50 % on the gripper.
- **Timing:** commands go out at a fixed 30 Hz, interpolated along the timeline (route in, run, route out). Frames are indexed by tick, so a slow browser plays slower and never catches up. A gap of more than 250 ms between ticks freezes the arm.
- **Routes:** every move the run does not define (route in, route out, return to rest, nudges, pointing) follows a route that forward kinematics checks:
  - the wrist and the tip stay ≥ 2 cm above the table, or no lower than the move's own endpoints, and never below 5 mm;
  - if the straight line dips, the route goes through a raised pose.

  Route frames inside a run are timed for ≤ 30°/s. Return to rest, nudges and pointing are **driven by the servos** (one goal per waypoint, with per-joint speeds so all joints arrive together); browser timers only watch. They freeze the arm if it falls more than 12° behind the expected straight-line progress, or if its load stays above 95 %, for 0.3 s.
- **STOP freezes the arm** (goal = present, torque stays on). The triggers:
  - the button (focused while moving), Space or Esc;
  - the tab hidden or the window blurred;
  - a timer stall;
  - page close.

  Nothing moves after a STOP until the user presses **Return to rest**.
- **Blocked arm:**
  - triggers: a joint other than the gripper stays more than 12° away from all of the last 6 commanded poses, or its load stays above 95 %, for 0.3 s; or any servo reports an overload, heat or power fault;
  - result: the arm freezes, and the page explains what happened.

  **Relax** (torque off) asks for confirmation and says "support the arm" first.
- **Any error once torque is on** (lost connection, glitch, internal check): the arm is frozen first. Torque goes off only if freezing fails. UI callback errors cannot break the safety loop. **Relax** reads torque back from every servo; if that cannot be confirmed, the page says to unplug the power supply.
- **Page hardening:** a CSP (`script-src 'self'` + jsDelivr + the importmap hash, `object-src 'none'`, `base-uri 'none'`). Self-hosting three.js with SRI is still open.
- **Honest copy:** "a sim success means a plausible path; the real grasp may still miss."

## 6. Modules (pure ES modules, Node-tested except the Web Serial adapter)
- `sts-bus.js`: packets, stream parser (fragments, noise, echo), request queue with timeouts and retries.
- `serial-transport.js`: Web Serial adapter. Filters on WCH/FTDI/CP210x, with a "Show all ports" fallback, and reuses a port already granted.
- `virtual-arm.js`: six emulated STS3215 servos. Models torque-on driving to Goal, the speed cap, sign-magnitude values, load and faults, and blocking.
- `calibration.js`: range trackers, `buildCalibration`, `jointStatus`, `flipJoint`, sim ↔ raw conversion, `clampSafe`, `matchesArm`.
- `player.js`: `scan`, `holdHere`, `freeze`, `relax`, `safeRoute`, `moveSafely`, `checkRun`, `inTheAir`, `createPlayer`.

## 7. Open items
- First physical run by the team, starting at 0.25× and in the air. Confirm the pose is comfortable to hold, the default torque limit holds the arm, and the blocked-arm thresholds work on real servos.
- Measure the SO-101 joint signs once and ship them as defaults (the nudge test stays as a check).
- Optional, opt-in "centre this servo" step (Homing_Offset, an EEPROM write) for kits whose range crosses the seam.
- Import a LeRobot calibration file; export to the `replay_so101.py` format.
- Self-host three.js (or add SRI) so the page with USB access loads no third-party script without integrity checks.
- Browser verification note: when the app window is not in view, Chrome throttles the page's timers and playback freezes by design. Full playback in the browser was verified while the window was visible; later fixes are covered by Node tests.
