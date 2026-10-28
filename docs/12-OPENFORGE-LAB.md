# 12 · OpenForge Lab: the pivot

Status: approved direction (user, 2026-10-26). This document replaces the cyberpunk/voxel direction for the site.
The contracts, Proving Grounds and Robot Link stay. What changes is the look, the home, and the goal.

## 1. The goal in one line

**OpenForge is an open digital robotics lab: learn how each robot works, test it in the browser, then build a real one cheaply, with your phone as its brain.**

The NFT collection is the membership and identity layer of the lab, not the product. Each agent is one robot class that maps to a real, buildable, open-source platform. Its on-chain record comes from lab missions (simulated) and from real runs (hardware).

## 2. What we keep, change and retire

| Area | Decision |
|---|---|
| Contracts (ERC-721 + ERC-6551, reveal, reputation, SeaDrop) | Keep. Not deployed on mainnet, so the trait names can still change (phase 2, §8). |
| Proving Grounds, verifier, batch attestations | Keep. They become the "Test" step of the SO-101 bench. |
| Robot Link (Web Serial, STS3215 driver) | Keep. Its `sts-bus.js` is reused by the phone-brain bridge. |
| Codex (3D pop-up book) | Keep, restyle to the new palette. It matches the new direction already. |
| Voxel lab home, voxel avatars, voxel NFT art | **Retire.** Replaced by clean, lit 3D models (§4). |
| Neo-Forge voxel world | **Retire from navigation.** Code stays in the repo; no new work. |
| Cyberpunk palette, neon, scanlines, Orbitron, glitch | **Retire everywhere.** |

## 3. The product, in four verbs

1. **Learn** — `bench.html`, the Workbench. One robot at a time, explained in 6–7 clickable stages, like a lab plate: *Unfold → Take it apart → Sensors → Brain → Move → Test → Build it*. Each stage animates the 3D model and updates a strip of spec chips.
2. **Test** — missions with levels on the same bench. Every robot class has 3 levels, scored by a deterministic in-browser sim (pass / fail plus a time or accuracy score). Progress is saved locally; signed results feed the existing verifier only where a server-authoritative replay exists (today: SO-101).
3. **Build** — each robot has a "Build it" stage with the real bill of materials, price range, license and a link to the upstream project. The flagship is our own **OpenForge AX-1** (§5).
4. **Pilot** — `pilot.html`, the **Phone Brain** app. Opened on a phone, it uses the camera, IMU and touch to drive the robot. With no robot it drives the 3D twin, so everyone can try it.

The home (`index.html`) is the lab itself: a bright 3D room with benches. Each bench is a station: Workbench, Phone Brain, Proving Grounds, Robot Link, The Codex, Gallery, My agents, Mint.

## 4. Visual system (lab notebook)

Inspired by the three posts the user shared: an illustrated isometric explainer of a drone, a 3D pop-up book, and a motion lab with plain numbers.

- **Paper, not night.** Warm off-white background, charcoal ink, one terracotta accent. Soft daylight, soft contact shadows. No neon, no glow, no scanlines.
- **Plates.** Every 3D view is framed like a figure in a lab notebook: `FIG. 03 · SO-101` top left, the stage list on the left, spec chips under the model, a one-paragraph "The big idea" footer.
- **Clean models.** Rounded boxes, cylinders and lathe shapes with matte plastic and brushed-aluminium materials. Exploded views and orthographic, slightly isometric cameras. Real proportions where we know them.
- **Motion with a purpose.** Each animation explains one thing (a joint, a sensor, a signal). Respect `prefers-reduced-motion`: stages jump to their end pose.

Tokens (CSS custom properties in `web/css/style.css`):

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f4efe6` | page |
| `--paper-2` | `#ebe4d6` | wells, floors |
| `--card` | `#fbf8f2` | panels |
| `--ink` | `#23211e` | text, outlines |
| `--muted` | `#6b655c` | secondary text (≥ 4.5:1 on paper) |
| `--line` | `#d8cfbf` | rules, borders |
| `--accent` | `#b4472f` | terracotta: primary action, highlights (5.4:1 under white text; 3D models use the lighter `#c8553d`) |
| `--accent-ink` | `#9e3d28` | accent text on paper (AA) |
| `--sage` `--sky` `--sun` `--plum` | `#5f8a6e` `#4f7ea8` `#e2b04a` `#8a6a9e` | category colours (classes, CW/CCW, sensors) |

Type: Inter Tight (display, 700–800), Inter (body), JetBrains Mono (labels, numbers). Dark mode: same hues on `#1c1a17`.

## 5. OpenForge AX-1, the phone-brain robot

One brain, one bridge, three bodies. The phone does perception and decisions; a ~$8 ESP32 board does the real-time servo loop. This split is the same architecture as UCLA's PhoneBot (phone → Wi-Fi → SBC → servo bus) and OpenBot (phone → USB → Arduino → motors), but AX-1 is our own design, released CC0.

```
Phone (pilot.html, PWA)                ESP32 bridge (firmware/ax-bridge)          Body
camera, IMU, touch, voice  ── BLE ──▶  GATT service "AX-1"            ── TTL ─▶ STS3215 bus servos
on-device vision (later)   ◀─ BLE ──   watchdog 300 ms → torque off    ── PWM ─▶ DC motors (Rover)
```

- **Link:** Web Bluetooth (Chrome on Android, desktop Chrome/Edge). iOS Safari has no Web Bluetooth: iPhone users drive the twin, or use a BLE-capable browser. Web Serial over USB is the fallback on desktop.
- **Semantic bridge, not a pass-through.** The phone sends joint targets and drive commands; the firmware owns the servo bus loop. A BLE round trip (30–60 ms) is too slow for raw bus packets. `web/js/robot/sts-bus.js` is reused for golden test vectors of the firmware encoder and for the desktop Web Serial fallback, not over BLE.
- **The phone link is untrusted, so safety lives in the firmware** (the app's checks are UX only):
  - staged watchdog: no valid command for 250 ms → **hold** (goal = present position, DC motors brake); 3 s → torque off only after a fault or on request. Either stage sets a STOP latch, and motion never resumes on its own: the user must re-ARM with a gesture (same rule as Robot Link: STOP freezes, it never drops the arm);
  - joint limits stored in the bridge (NVS), a 90 °/s rate limit per joint, RAM-only register writes with ACCEL/VELOCITY/TORQUE_LIMIT resent every cycle, the STS3215 model/mode boot check, goal = present before torque on, low-voltage cutoff, fatal servo error → hold, motor-driver standby pulled low at boot;
  - a physical kill switch on servo power is part of every BOM.
- **Pairing:** LE Secure Connections with a 6-digit passkey printed on the board; writes need an encrypted, authenticated link; bonding only inside a 60 s window opened by a long press; one connection at a time. A random nearby phone cannot drive someone else's robot.
- **Protocol** (spec in `docs/13-PHONE-BRAIN.md`, pure codec in `web/js/pilot/ax-proto.js`, mirror in `firmware/ax-bridge/ax_proto.h`, shared test vectors): `AX_INFO` (versions, body, joint count, limits hash), `AX_CMD` (write-without-response, `seq`, joint mask, targets in 0.1°, or a DRIVE frame), `AX_STOP`, `AX_ARM` (after a gesture), `AX_STATE` (10 Hz notify: state, latch reason, faults, battery, last seq, positions). Stale or replayed `seq` values are dropped. The phone keeps one latest-wins slot on a 33 ms timer and sends STOP when hidden.
- **Status:** the firmware is **experimental and untested on hardware** until the team's first AX-1 Rover build (phase 3). A Node loopback bridge emulates its state machine for CI.
- **Bridge board:** recommended Waveshare *General Driver for Robots* (~$28: ESP32 with BLE, STS bus port, DC-motor driver, IMU, 7–13 V input), or any original ESP32 dev board + a half-duplex bus adapter. Use the original ESP32 (not S3/C3) if Bluetooth-Classic Web Serial is wanted.
- **Bodies (without the phone; sources and the verified share of each total are in `docs/research/open-robot-catalog.md`):**
  - **AX-1 Rover** — two geared DC motors, 2 servos for a phone pan/tilt head. The first build, about $100–115.
  - **AX-1 Desk** — a pan/tilt neck and two 2-DoF arms on STS3215 servos; a desk companion that looks, points and waves. About $150–170.
  - **AX-1 Walker** — a 12–13 servo biped on STS3215s, the long-term community build. About $250–270. Walking needs a learned policy; it ships only when one runs in sim and on a real unit. No permissively licensed STS3215 biped exists today, so this fills a real gap.

## 6. The collection, tied to real hardware

Every class maps to a real open platform, and the Workbench links to it. Mapping and licenses come from `docs/research/open-robot-catalog.md`. Rules:

- Link to non-commercial (NC) designs, never copy them into CC0 assets (PhoneBot's CAD is CC BY-NC 4.0).
- Our own models, art and firmware stay CC0.
- Third-party sim assets (NVIDIA SimReady, Google Scanned Objects, MuJoCo Menagerie) are used only if their own license allows it, credited on the page, and never baked into token art.

### Proving Grounds: every robot

The Proving Grounds (`arena.html`) tests all 11 robots. The Synth Arm keeps its Energy Cell mission (`arm-sim.js`). Every robot, the Synth Arm included, also has three **lab trials**: the Workbench missions (`web/js/bench/missions/*`), run by the same `mission-runner.js` as the Workbench Test stage. Progress is shared between the two pages.

- **Guests** fly any robot. Runs stay in the browser.
- **Agents** fly their own class robot, and every agent flies the three AX-1 bodies (AX-1 Rover, Desk and Walker are also on-chain classes 8-10).
  1. The verifier issues the mission (`GET /lab/challenge`). The seed is fixed per agent, level, day and missions used: asking again returns the same layout, and a layout that an idle run would pass is never issued.
  2. The holder signs the EIP-712 `Run` (free). Its `mission` is `lab/<robot>/<level>` and its `sim` is `openforge-lab-sim@1`, so a signature for one mission or kind never counts for another.
  3. The server replays the run (`web/js/sim/lab-episode.js`) and refuses padding: only each robot's action fields, nothing after the run ends.
  4. Passes are attested in the same `attestSimBatch` batches, with quality = score × 100. Caps: at most 5 lab passes per agent per day, and 1 per level. The rest of the contract's shared cap of 10 stays free for the Energy Cell.
  5. Only attested lab episodes are kept on disk.
- The arm leaderboard stays arm-only. Lab leaderboards are per robot and level (`GET /lab/leaderboard`).
- A lab pass is lab data, not proof of a real robot. The page says so.

## 7. Engineering rules

- Same site rules as before: no third-party scripts (three.js vendored), CSP via `npm run web:build`, `esc()` for chain/server data, `site:check` before publishing.
- New modules are pure where possible and tested with `npx hardhat test` (mocha): the BLE protocol encoder/decoder, the mission scorers and the bridge limits.
- Every 3D page has a no-WebGL / reduced-motion path and keyboard access to every stage and control.
- Phone Brain asks for camera and motion permission only on a user gesture, and works without either.

### Files and ownership

| Path | What |
|---|---|
| `web/js/models/` | Procedural three.js robot models (`robots.js`), shared look (`look.js`). One source for home, bench and pilot. |
| `web/index.html`, `web/js/home.js`, `web/js/lab/lab-view.js` | The 3D lab home. |
| `web/bench.html`, `web/js/bench/` | Workbench: stages, spec chips, missions and levels. |
| `web/pilot.html`, `web/js/pilot/` | Phone Brain app. |
| `firmware/ax-bridge/` | ESP32 bridge firmware (Arduino), CC0. |
| `docs/13-PHONE-BRAIN.md` | AX-1 build and protocol guide. |

## 8. Phases

1. **Now:** new look, lab home, Workbench (8 classes + AX-1), Phone Brain with twin mode and BLE bridge, firmware, docs.
2. **Done (phase 2):** 11 on-chain classes (the 8 generic names kept, "inspired by" only off-chain; AX-1 Rover / Desk / Walker added, 31% of the collection); token art drawn from the `web/js/models/` robots (`art/token-render.mjs`); since 2026-10-28 each token is also an animated GIF (the metadata's `image`): a short gesture per class from `art/token/motion.mjs`, then a pause on the still pose, with no new trait; provenance hash covers those files. Still to do: redo the Sepolia rehearsal.
3. **Then:** first physical AX-1 Rover build by the team, then publish the measured BOM; the Desk body; signed mission results for more classes in the verifier.
4. **Later:** AX-1 Walker policy (MuJoCo training, community-run), on-device vision and voice on the phone.
