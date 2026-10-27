# Open Robot Catalog: real robots behind the OpenForge AX classes

Research date: 2026-10-26. Sources are primary where possible (GitHub repo pages, LICENSE files, vendor shops, Chrome/MDN docs). Anything not confirmed from a source is marked **unverified**. Prices are list prices on the date checked, before shipping and tax. This is engineering research, not legal advice.

## How to read the CC0 verdict

OpenForge AX is CC0, so nothing it ships *as CC0* can carry upstream obligations. Each item gets three answers:

- **(a) Link:** can the CC0 site link to it and describe it? (Always yes. Linking needs no licence.)
- **(b) Ship derived CAD/meshes inside CC0 assets:** yes only if the upstream is CC0 or public domain. Permissive licences (Apache-2.0, MIT, BSD, CC BY) allow redistribution **with their notice kept**. They can sit on the site under their own licence with credits, but they cannot be relabelled CC0 or baked into CC0 token assets. Copyleft (GPL, CC BY-SA) and NC licences: no.
- **(c) Build a compatible original design:** we can make an original part that mates with the same servos, bus protocol or mounting pattern, provided we do not copy the upstream CAD geometry. Functional compatibility is generally not protected by copyright. Patents are **unverified** for every item.

Rule applied throughout: **NC licences are link-only.**

---

## 1. Arms and mobile manipulators

| Item | What | Repo | Software lic. | HW/CAD lic. | BOM (USD) | Actuators / electronics | Phone as brain? | CC0 (a/b/c) |
|---|---|---|---|---|---|---|---|---|
| **SO-101** (SO-ARM100 repo) | 6-DOF 3D-printed arm, leader + follower teleop pair; the LeRobot reference arm | github.com/TheRobotStudio/SO-ARM100 | Apache-2.0 (repo LICENSE) | Apache-2.0. The repo has a single LICENSE and no separate CAD licence. | $121.94 follower only; $229.88 for two arms (README BOM, US) | 6× Feetech STS3215 7.4 V per arm (gears 1/345, 1/191, 1/147) at $13.89 each from Alibaba; 1 "Motor Control Board" (Waveshare bus adapter) at $10.60; $10 PSU | Yes. Phone runs the browser lab and talks to the bus over Web Serial (USB OTG) or through an ESP32 bridge. We already have a Web Serial driver. | a ✅ b ⚠️ (Apache: notice required, so not CC0) c ✅ |
| **Koch v1.1** | Dynamixel-based leader/follower arm | github.com/jess-moss/koch-v1-1 | Apache-2.0 | Apache-2.0 (single repo licence) | Leader $199, follower $278 (README, US) | Follower: 2× XL430-W250-T + 4× XL330-M288-T; leader: 6× XL330-M077-T; U2D2 or Waveshare board | Possible but costly. Uses Dynamixel protocol, not our STS bus. | a ✅ b ⚠️ c ✅ |
| Low-cost robot (Koch v1.0) | Original version of Koch | github.com/AlexanderKoch-Koch/low_cost_robot | MIT | MIT (single licence) | About $430 for the pair ($258 follower + $183 leader) | Same Dynamixel mix; Waveshare bus board at about $10 | As above | a ✅ b ⚠️ (MIT notice) c ✅ |
| **LeKiwi** | 3-omni-wheel base that carries an SO-101 | github.com/SIGRobotics-UIUC/LeKiwi | Apache-2.0 | Apache-2.0 (single licence; no separate CAD statement) | $184 wired base; $482 for the 12 V kit and $499 for the 5 V kit, both including the SO-101 teleop set (BOM.md) | 3× STS3215 in wheel mode, 3× 4" omni wheels at $9.99 each, Waveshare board, Raspberry Pi 5 at $60 | Yes in principle: replace the Pi with a phone and an ESP32 bus bridge. | a ✅ b ⚠️ c ✅ |

## 2. Phone-brain robots

| Item | What | Repo / site | Software lic. | HW/CAD lic. | BOM | Actuators / electronics | Phone integration | CC0 (a/b/c) |
|---|---|---|---|---|---|---|---|---|
| **OpenBot** | Wheeled car with a smartphone as the brain (Intel Labs origin, now ob-f) | github.com/ob-f/OpenBot | MIT | MIT (single repo licence, covers body STL/STEP) | "about $50" body (README); the DIY BOM gives no prices | DIY body: 4× TT motors, L298N or custom PCB, 3× 18650, Arduino Nano. RTR bodies use ESP32. 3D-printed phone mount. | Android app only (README). The phone connects to the MCU over USB serial; on ESP32 there is also a Bluetooth link to the phone (firmware README). | a ✅ b ⚠️ (MIT notice) c ✅ |
| **PhoneBot** (UCLA RoMeLa) | 48.3 cm, 1.8 kg biped humanoid whose torso holds a phone | phonebot.dev; arXiv 2610.08737 (Hou, Wang, Koh, Hong, submitted 2026-10-06) | Code link on site but **no licence stated**; repo URL not found (**unverified**) | **CC BY-NC 4.0** (CAD, exports, BOM, assembly docs) | About $400 excluding the phone (site) | 13× Dynamixel XL430-W250-T (6 per leg + torso yaw), U2D2 TTL bus, onboard SBC, 3S battery | Phone ↔ SBC over Wi-Fi with no wired link; phone supplies IMU, camera, compute and UI. | a ✅ **b ❌ (NC)** c ✅ (original design only; do not trace its CAD) |

## 3. Quadrupeds ("Cyber Hound")

| Item | Repo | Software lic. | HW/CAD lic. | Price / BOM | Actuators / electronics | Phone as brain? | CC0 (a/b/c) |
|---|---|---|---|---|---|---|---|
| **Stanford Pupper v3** | pupper-v3-documentation.readthedocs.io; code github.com/Nate711/pupperv3-monorepo | GPL-3.0 (monorepo) | **unverified** (no CAD licence found) | DIY about $2,000 (docs home page); third-party kits $1,320–1,450 for actuators only (AIFITLAB) | 12 SteadyWin actuators (per kit listing), Raspberry Pi 5, custom PCBs, BNO086 IMU | No; it uses a Pi 5. | a ✅ b ❌ c ✅ |
| **Mini Pupper 2** (MangDang) | github.com/mangdangroboticsclub/mini_pupper | Apache-2.0 | **unverified** | $605–756 pre-assembled at RobotShop; $429 Kickstarter base kit (Hackster) | 12 proprietary MangDang servos (MD-300C-150 mentioned), Raspberry Pi CM4 + ESP32 | Not natively. | a ✅ b ❌ (HW unverified) c ✅ |
| **Petoi Bittle X / OpenCat** | github.com/PetoiCamp/OpenCat | MIT | **unverified** (repo says "open hardware" but names no licence) | Bittle X V2: $319 kit / $339 assembled (lite servos); $379 / $399 with alloy servos (RobotShop) | Petoi servos (repo says up to 12; Bittle count **unverified**); NyBoard (ATmega328P) or BiBoard (ESP32) | Partly: the BiBoard ESP32 has BLE, and Petoi offers mobile apps. | a ✅ b ❌ c ✅ |
| Spot Micro | github.com/mike4192/spotMicro | MIT (code) | Frame on Thingiverse by KDY0523; licence **unverified** | not stated | 12× PDI-HV5523MG, PCA9685, Raspberry Pi 3B | No | a ✅ b ❌ c ✅ |
| Waveshare ST3215 12-DOF dog | waveshare.com/st3215-servo.htm (resource section) | **unverified** | **unverified** | not stated | 12× ST3215 bus servos | Yes with an ESP32 bus bridge | a ✅ b ❌ c ✅ |

No cheap, permissively licensed quadruped built on STS3215 servos was found. That is a gap OpenForge can fill with an original design.

## 4. Hands and grippers ("Ghost Hand")

| Item | Repo | Software lic. | HW/CAD lic. | BOM | Actuators | Phone? | CC0 (a/b/c) |
|---|---|---|---|---|---|---|---|
| **AmazingHand** (Pollen / Hugging Face) | github.com/pollen-robotics/AmazingHand | Apache-2.0 | **CC BY 4.0** (mechanical design) | "<200 €" plus the control board (README); full BOM in a Google Sheet | 8× Feetech SCS0009 (2 per finger, 4 fingers, 8 DOF); Waveshare serial bus driver or Arduino + Feetech TTL linker | Yes. It is on the Feetech bus and works with the same ESP32 bridge. | a ✅ b ⚠️ (CC BY: credit on the site, not in CC0 token assets) c ✅ |
| **LEAP Hand** | github.com/leap-hand/LEAP_Hand_API | MIT | **CC BY-NC-SA** (version not stated) | not stated | Dynamixel (XC330-M288 manual linked) | Not on our bus | a ✅ **b ❌** c ✅ |
| SO-101 gripper | SO-ARM100 | Apache-2.0 | Apache-2.0 | 1 STS3215 ($13.89) | STS3215 | Yes | a ✅ b ⚠️ c ✅ |

## 5. Hexapods ("Spider Mech")

| Item | Repo | Lic. | BOM | Actuators / electronics | Phone? | CC0 (a/b/c) |
|---|---|---|---|---|---|---|
| **Bob The Hexapod** | github.com/Papouc/Bob-The-Hexapod | MIT (repo LICENSE.txt; STEP in docs/3D) | not totalled; BOM in docs/Parts. Servos alone: 18 × $5.95 SG92R or 18 × $2.59 MG90S (see §10). | 18× SG90, Raspberry Pi Pico | Yes, if the Pico is swapped for an ESP32 bridge | a ✅ b ⚠️ (MIT notice) c ✅ |
| Dr.QP | github.com/Dr-QP/Dr.QP | MIT | not stated (A1-16 servos are expensive) | 18× XYZrobot A1-16 | No | a ✅ b ⚠️ c ✅ |
| shark/hexapod | git.deck.sh/shark/hexapod | GPL (STL, PCB, code) | not stated | 18× TowerPro MG92B | — | a ✅ b ❌ c ✅ |

## 6. Drones ("Sky Drone")

| Item | Repo | Software lic. | HW lic. | Hardware | Phone control | CC0 (a/b/c) |
|---|---|---|---|---|---|---|
| **ESP-Drone** (Espressif) | github.com/espressif/esp-drone | GPL-3.0 (core derived from Crazyflie) | **unverified** (schematic PDF published, no licence named) | ESP32-S2 (Drone V1.2) + MPU6050; S3 configurations listed; BOM/price **unverified** | Drone is a Wi-Fi AP; iOS and Android apps; ESP-NOW joystick; cfclient | a ✅ b ❌ c ✅ |
| **Crazyflie 2.1+** (Bitcraze) | github.com/bitcraze/crazyflie-firmware | Conflicting: sidebar GPL-3.0, README "LGPL-3.0" (**verify the LICENSE file**) | Schematics and KiCad deck template published; licence **unverified** | STM32F405 + nRF51822, BLE, Crazyradio | BLE with iOS and Android clients | a ✅ b ❌ c ✅ |

## 7. Humanoids and desk robots ("Replicant")

| Item | Repo | Software lic. | HW/CAD lic. | Price / BOM | Actuators | Phone? | CC0 (a/b/c) |
|---|---|---|---|---|---|---|---|
| **Reachy Mini** (HF / Pollen) | github.com/pollen-robotics/reachy_mini | Apache-2.0 | **CC BY-SA-NC** (version not stated) | Launch: Lite $299, Wireless $449 (several outlets). The HF blog snapshot shows $399 / $499 plus tax; the current price is **unverified**. | 9 DOF per reseller listing (**unverified**); motor model **unverified**. Wireless uses a Pi CM4 (repo) or Pi 5 (CNX); sources disagree. | No (Pi / PC) | a ✅ **b ❌** c ✅ |
| **Berkeley Humanoid Lite** | github.com/HybridRobotics/Berkeley-Humanoid-Lite | MIT | **CC BY-SA 4.0** ("other assets") | "sub-$5,000" | 3D-printed gearboxes; DOF and controller not stated on README | No | a ✅ b ❌ (SA) c ✅ |
| **ToddlerBot** (Stanford) | github.com/hshi74/toddlerbot | MIT | **CC BY-NC-SA 4.0** (Onshape + STL) | "under 6,000 USD" (paper / MakerWorld) | Dynamixel; ROBOTIS bundle lists 24 motors + U2D2 | No | a ✅ **b ❌** c ✅ |
| PhoneBot | see §2 | — | CC BY-NC 4.0 | ~$400 | 13× XL430 | **Yes** | a ✅ b ❌ c ✅ |

No open biped built on STS3215 servos with a clear licence was found. Zowi (bqlabs) is a CC BY-SA 4.0 biped, but it uses only 4 Futaba-class servos.

## 8. Fabrication ("Fab Rig")

| Item | Repo | Licence | Notes | CC0 (a/b/c) |
|---|---|---|---|---|
| **Voron 2.4** | github.com/VoronDesign/Voron-2 | GPL-3.0 (repo, covers CAD) | Fully open, community BOM; price varies by kit | a ✅ b ❌ (copyleft) c ✅ |
| Prusa CORE One | prusa3d.com (OCL) | Prusa **Open Community License**: personal use allowed; selling machines or remixes is prohibited without an agreement | MK4/MK4S: schematics and printable parts released; manufacturing data and full CAD not released | a ✅ b ❌ c ✅ |

Voron is the better "Fab Rig" because it is genuinely open and community-built.

## 9. Components for the phone-brain robot

| Part | Source | Price (USD) | Notes |
|---|---|---|---|
| Feetech STS3215 7.4 V (19.5 kg·cm) | SO-ARM100 BOM (Alibaba) | **$13.89** | Feedback on position, load, speed and voltage (Waveshare) |
| ST3215 (Waveshare-branded, 7.4 V or 12 V) | waveshare.com/st3215-servo.htm | **$16.99–21.99** | 12 V version: 30 kg·cm, runs 6–12.6 V. The page does not map price to variant. |
| STS3215 12 V (C018, 30 kg·cm) | OpenELAB | €27.78 (7.4 V C001: €24.70) | EU reference price |
| Waveshare **Bus Servo Adapter (A)** | waveshare.com/bus-servo-adapter-a.htm | **$4.99** | USB-C + UART, ST/SC bus, up to 253 servos, 9–12.6 V input. **No MCU and no wireless.** |
| Waveshare **Servo Driver with ESP32** | waveshare.com/servo-driver-with-esp32.htm | **$15.99** | ESP32-WROOM-32, Wi-Fi + Bluetooth + ESP-NOW, ST/SC bus, 6–12 V |
| Waveshare **General Driver for Robots** | waveshare.com/general-driver-for-robots.htm | **$27.99** | ESP32-WROOM-32UE, ST3215 bus, **TB6612FNG** DC-motor driver, 9-axis IMU (QMI8658C + AK09918C), 7–13 V (2S/3S), Wi-Fi + Bluetooth + ESP-NOW |
| ESP32-S3-DevKitC-1 (N32R16) | Adafruit #5364 | $19.95 | **BLE only, no Bluetooth Classic** (ESP-IDF docs) |
| ESP32-C3 (QT Py) | Adafruit #5405 | $9.95 | BLE only; USB-serial/JTAG |
| SG92R micro servo | Adafruit #169 | $5.95 | 2.5 kg·cm, PWM |
| MG90S metal-gear micro servo | Waveshare | $2.59 | 2.0–2.8 kg·cm, PWM |
| Feetech SC09 bus micro servo | waveshare.com/sc09-servo.htm | $8.99 | 2.3 kg·cm at 6 V, servo or motor mode, same bus as STS. Good for the head and hands. |
| TT gear motor 200 RPM | Adafruit #3777 | $2.95 | 3–6 V |
| N20 micro gear motor | — | **unverified** | Pololu micro-metal gearmotors are pricier; generic N20 pricing was not verified |
| TB6612 driver breakout | Adafruit #2448 | $6.95 | Already on the General Driver board |
| 5 V 3.2 A buck (D36V28F5) | Pololu #3782 | $23.95 | 5.3–50 V input. Cheap generic bucks exist (**unverified** price). |
| 32×7 mm wheels (pair) | Pololu #1088 | $4.45 | For N20-class motors |
| 2S Li-ion pack (2×18650 + BMS) | — | **unverified** | 7.4 V nominal matches STS3215 7.4 V directly |
| Phone clamp | — | **unverified** | Prefer an original 3D-printed clamp (CC0) |

### Budget tiers (servos at the $13.89 Alibaba price; Waveshare retail adds about $3–8 per servo)

| Tier | Contents | Verified subtotal | Unverified extras | Est. total |
|---|---|---|---|---|
| **Rover** (wheels + head pan/tilt) | General Driver ($27.99) + 4× TT ($11.80) + 2× STS3215 pan/tilt ($27.78) | **$67.57** | wheels, 2S pack, clamp, filament (~$30–45) | **~$100–115** |
| **Desk companion** (neck + two 2-DOF arms) | General Driver ($27.99) + 7× STS3215 (3 neck + 4 arms, $97.23) | **$125.22** | 7.4 V PSU ($10 per SO-ARM BOM) or 2S pack, clamp, filament | **~$150–170** |
| **Walker** (biped, 13 servos) | General Driver ($27.99) + 13× STS3215 ($180.57) | **$208.56** | high-current 2S pack, frame screws, filament (~$40–60) | **~$250–270** (vs ~$400 for PhoneBot on Dynamixel) |

## 10. Phone-side technology feasibility

| Capability | Status (Oct 2026) | Source |
|---|---|---|
| **Web Bluetooth** | Chrome, Edge, Opera and Samsung Internet; Chrome Android 156 supported. **No Safari or iOS, no Firefox.** | caniuse web-bluetooth |
| **Web Serial on Android** | Bluetooth **RFCOMM** shipped first (intent-to-ship est. Chrome 137). The Chrome 148 release notes state Web Serial "is supported on Android", covering USB and Bluetooth serial devices. caniuse lists Chrome Android as supported. The 2025 intent deferred **wired USB** until Android gained system support; wired USB OTG behaviour on real devices is **unverified** and must be tested. Fallback: WebUSB + the serial polyfill. | blink-dev intent; Chrome 148 release notes; developer.chrome.com/docs/capabilities/serial |
| RFCOMM caveat | RFCOMM (Classic SPP) needs an **original ESP32**. ESP32-S3 and C3 are **BLE-only**, so use Web Bluetooth GATT with them. | ESP-IDF Bluetooth overview (S3) |
| **DeviceMotion / DeviceOrientation** | iOS Safari requires `DeviceMotionEvent.requestPermission()` called from a user gesture (transient activation) over HTTPS. Feature-detect it, because other browsers do not define it. | MDN |
| **getUserMedia** in a PWA | Works in secure contexts (HTTPS) on Android Chrome and iOS Safari; needs a user permission prompt | MDN (standard) |
| **Wake Lock** (screen) | Chrome Android supported; iOS Safari from 16.4; Firefox from 126 | caniuse wake-lock |
| **MediaPipe Tasks for Web** | Apache-2.0 (google-ai-edge/mediapipe). The WASM root (`FilesetResolver.forVisionTasks(path)`) and `modelAssetPath` are plain paths, so they can be vendored and self-hosted rather than served from jsDelivr. Licences of individual `.task` model files are per model card (**verify** per model). | developers.google.com hand_landmarker web_js; GitHub |
| **TensorFlow.js** | Apache-2.0 | github.com/tensorflow/tfjs |
| **ONNX Runtime Web** | MIT | github.com/microsoft/onnxruntime |

Implication: the AX lab should treat **Android Chrome as the robot-brain platform**. iOS can be a viewer or remote: it has camera, IMU and wake lock, but no Web Bluetooth and no Web Serial.

## 11. Simulation assets

| Asset set | Licence | Format | Inside CC0 token assets? | On the CC0 site with credits? |
|---|---|---|---|---|
| **Poly Haven** (HDRIs, textures, models) | **CC0** | glTF/blend/EXR | ✅ | ✅ (credit not needed) |
| **Kenney** | **CC0** | glTF/FBX/OBJ | ✅ | ✅ |
| NVIDIA **SimReady**: PhysicalAI-SimReady-Warehouse-01 (HF) | **CC-BY-4.0**, 753 assets | OpenUSD (USDPhysics colliders, no rigid bodies) | ❌ | ✅ with attribution; needs USD-to-glTF conversion for the web |
| NVIDIA **SimReady Central** (announced 2026-10-21, 2,000+ assets) | **Per dataset**. NVIDIA requires permissive licences such as CC-BY-4.0 for China and browser distribution. Some third-party SimReady sets are CC BY-NC 4.0 (e.g. Aperdata kitchen). | OpenUSD | ❌ | Only the CC-BY ones; filter by licence |
| **Google Scanned Objects** | CC BY 4.0 (secondary sources; official Fuel pages not fetched) | SDF/OBJ | ❌ | ✅ with attribution |
| **YCB** | CC BY 4.0 (AWS Open Data registry, Habitat LICENSE); official page not fetched | meshes | ❌ | ✅ with attribution |
| **MuJoCo Menagerie** | Per model. Apache-2.0: SO101, SO-ARM100, Low-Cost Robot Arm, Skydio X2, Franka, Shadow Hand, and others. BSD-3: Berkeley Humanoid, Unitree, Spot. MIT: ToddlerBot, LEAP Hand, Crazyflie 2. No NC or CC-BY models listed. | MJCF + meshes | ❌ (notices required) | ✅ with the per-model LICENSE |

Caution: Menagerie relicenses some models (ToddlerBot, LEAP) under MIT even though their upstream CAD is NC. For OpenForge use, prefer models whose upstream is permissive too (SO101, Low-Cost Arm).

---

## Recommended mapping

| NFT class | Best real platform | Why | Upstream licence | How AX uses it |
|---|---|---|---|---|
| **Synth Arm** | **SO-101** | STS3215 bus, LeRobot ecosystem, Apache-2.0, ~$122 per follower arm, Menagerie model (Apache) | Apache-2.0 | Link to it, use the existing Web Serial driver, show the Menagerie model with its notice |
| **Street Rover** | **OpenBot** (phone-brain reference); **LeKiwi** for a STS-bus omni base | OpenBot is the canonical phone-as-brain car (MIT, ~$50) | MIT / Apache-2.0 | Link to both; build an original AX rover on the STS bus |
| **Cyber Hound** | **Petoi Bittle X** (buyable, MIT code) and an **original 12× STS3215 AX hound** | No permissively licensed STS quadruped exists | MIT code, HW unverified | Link only; original design |
| **Ghost Hand** | **AmazingHand** | Feetech bus (SCS0009), <200 €, Apache-2.0 + CC BY 4.0 | Apache-2.0 / CC BY 4.0 | Link and credit; same ESP32 bridge drives it |
| **Spider Mech** | **Bob The Hexapod** | MIT, 18× SG90, Pico; the cheapest permissive hexapod found | MIT | Link; optional original STS/SC09 variant |
| **Sky Drone** | **ESP-Drone** (Crazyflie as the premium reference) | ESP32, Wi-Fi app control, phone-controllable | GPL-3.0 code | Link only (copyleft) |
| **Fab Rig** | **Voron 2.4** | Truly open printer, prints every AX part | GPL-3.0 | Link only |
| **Replicant** | **PhoneBot** as the concept reference; **original AX walker** as the build | PhoneBot proves the phone-brain biped, but it is CC BY-NC (link only) | CC BY-NC 4.0 | Link; original 13× STS3215 design |

### Flagship: OpenForge AX-1 (phone-brain)

- **Form factor:** a desk companion on wheels. A phone "head" on a 2-DOF neck, two 2-DOF arms, and a 2-wheel differential base. It is stable (no balance risk), demonstrates vision and IMU features, and grows into a walker later (AX-2).
- **Servos:** 8× Feetech STS3215 7.4 V on **one TTL bus**: 2 neck (pan/tilt), 4 arms, and 2 drive wheels in continuous-rotation (wheel) mode. The LeKiwi base already runs STS3215 as wheels. Optional SC09 micro servos (same bus) for a gripper or antennas.
- **Bus and bridge:** Waveshare **General Driver for Robots** ($27.99). Its original ESP32 supports **both BLE** (Web Bluetooth GATT) **and Classic SPP** (Web Serial over RFCOMM on Android Chrome). It also has a ST3215 bus port, a TB6612 for cheap TT/N20 motors as an alternative drive, an onboard IMU, and a 2S/3S input. USB-C fallback: Web Serial or WebUSB over OTG (**test per device**). Minimal alternative: Bus Servo Adapter (A) at $4.99 + an ESP32 at $9.95–15.99.
- **Power:** a 2S Li-ion pack (7.4 V nominal) feeding the bus directly, with a 5 V buck for accessories. The phone runs on its own battery.
- **Phone role:** Android Chrome PWA. Camera + MediaPipe (self-hosted WASM and models), DeviceMotion for head stabilisation, Wake Lock, and the BLE or RFCOMM link to the ESP32 running a thin firmware that relays the STS protocol. This reuses the browser-side SO-101 STS3215 driver unchanged.
- **Budget:** 8 × $13.89 = $111.12 for servos, plus $27.99 for the board, giving **$139.11 verified**. Battery, buck, wheels/tyres, clamp and filament are **unverified**, about $40–60. **Target ≈ $180–200 without the phone.**
- **Licence:** all AX-1 CAD, firmware and docs original and CC0. Only link to NC or copyleft projects; credit CC BY and Apache assets on the site and never bundle them into token assets.

---

## Sources

- SO-ARM100 / SO-101: https://github.com/TheRobotStudio/SO-ARM100 ; LICENSE https://raw.githubusercontent.com/TheRobotStudio/SO-ARM100/main/LICENSE
- Koch v1.1: https://github.com/jess-moss/koch-v1-1 ; Low-cost robot: https://github.com/AlexanderKoch-Koch/low_cost_robot
- LeKiwi: https://github.com/SIGRobotics-UIUC/LeKiwi ; BOM https://github.com/SIGRobotics-UIUC/LeKiwi/blob/main/BOM.md
- OpenBot: https://github.com/ob-f/OpenBot ; firmware https://github.com/ob-f/OpenBot/tree/master/firmware ; DIY body https://github.com/ob-f/OpenBot/tree/master/body/diy
- PhoneBot: https://phonebot.dev ; https://arxiv.org/abs/2610.08737
- Pupper v3: https://pupper-v3-documentation.readthedocs.io/en/latest/ ; https://github.com/Nate711/pupperv3-monorepo ; https://aifitlab.com/products/pupper-v3-stanford-open-source-robotics-dog
- Mini Pupper: https://github.com/mangdangroboticsclub/mini_pupper ; https://www.robotshop.com/products/mangdang-mini-pupper-2-legs-pre-assembled-kit-open-source-ros-robot-dog-kit ; https://www.hackster.io/news/the-hobbyist-s-best-friend-40874f254c3d
- Petoi OpenCat: https://github.com/PetoiCamp/OpenCat ; https://www.robotshop.com/products/petoi-bittle-x-v2-lite-servo-pre-assembled
- Spot Micro: https://github.com/mike4192/spotMicro
- AmazingHand: https://github.com/pollen-robotics/AmazingHand ; LEAP Hand: https://github.com/leap-hand/LEAP_Hand_API
- Hexapods: https://github.com/Papouc/Bob-The-Hexapod ; https://drqp.readthedocs.io/en/stable/ ; https://git.deck.sh/shark/hexapod
- ESP-Drone: https://github.com/espressif/esp-drone ; https://docs.espressif.com/projects/espressif-esp-drone/en/latest/gettingstarted.html
- Crazyflie: https://github.com/bitcraze/crazyflie-firmware ; https://www.bitcraze.io/products/crazyflie-2-1-plus/
- Reachy Mini: https://github.com/pollen-robotics/reachy_mini ; https://huggingface.co/blog/reachy-mini ; https://www.cnx-software.com/2026/03/24/hugging-face-reachy-mini-open-source-ai-robot-computer-raspberry-pi-5/
- Berkeley Humanoid Lite: https://github.com/HybridRobotics/Berkeley-Humanoid-Lite
- ToddlerBot: https://github.com/hshi74/toddlerbot ; https://arxiv.org/html/2502.00893v4 ; https://www.robotis.us/toddlerbot-bundle-kit/
- Zowi: https://github.com/bqlabs/zowi
- Voron: https://github.com/VoronDesign/Voron-2 ; Prusa: https://www.prusa3d.com/page/open-source-at-prusa-research_236812/ ; https://www.3printr.com/prusa-releases-core-one-cad-files-under-new-open-community-license-5685885/
- Waveshare: https://www.waveshare.com/st3215-servo.htm ; https://www.waveshare.com/bus-servo-adapter-a.htm ; https://www.waveshare.com/servo-driver-with-esp32.htm ; https://www.waveshare.com/general-driver-for-robots.htm ; https://www.waveshare.com/sc09-servo.htm ; https://www.waveshare.com/MG90S-Servo.htm
- STS3215 EU price: https://openelab.io/collections/feetech-motor
- Adafruit: https://www.adafruit.com/product/169 ; https://www.adafruit.com/product/2448 ; https://www.adafruit.com/product/5364 ; https://www.adafruit.com/product/5405 ; https://www.adafruit.com/product/3777
- Pololu: https://www.pololu.com/product/3782 ; https://www.pololu.com/product/1088
- ESP32-S3 BLE-only: https://docs.espressif.com/projects/esp-idf/en/v5.3/esp32s3/api-guides/bluetooth.html
- Web Serial: https://developer.chrome.com/docs/capabilities/serial ; https://groups.google.com/a/chromium.org/g/blink-dev/c/BqUGCcurReE/m/XbuAYkRxEQAJ ; https://chromestatus.com/feature/5139978918821888 ; https://developer.chrome.com/release-notes/148 ; https://caniuse.com/web-serial
- Web Bluetooth: https://caniuse.com/web-bluetooth ; Wake Lock: https://caniuse.com/wake-lock
- DeviceMotion permission: https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static
- MediaPipe: https://github.com/google-ai-edge/mediapipe ; https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- TensorFlow.js: https://github.com/tensorflow/tfjs ; ONNX Runtime: https://github.com/microsoft/onnxruntime
- SimReady: https://huggingface.co/datasets/nvidia/PhysicalAI-SimReady-Warehouse-01 ; https://docs.omniverse.nvidia.com/simready/latest/simready-central.html ; https://huggingface.co/datasets/Aperdata-tech/Aperdata-SimReady-Kitchen-01
- MuJoCo Menagerie: https://github.com/google-deepmind/mujoco_menagerie
- Google Scanned Objects: https://arxiv.org/abs/2204.11918v1 ; https://research.google/blog/scanned-objects-by-google-research-a-dataset-of-3d-scanned-common-household-items/
- YCB: https://registry.opendata.aws/ycb-benchmarks ; https://huggingface.co/datasets/ai-habitat/ycb/blob/main/LICENSE.txt
- Poly Haven: https://polyhaven.com/license ; Kenney: https://kenney.nl/support
