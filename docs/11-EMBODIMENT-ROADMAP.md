# Embodiment roadmap: a real robot for every class

> Source: a post listing 18 open-source robots with 3D models (Techniahqrobot on X, 2026-10-24). Checked against what OpenForge AX uses today. Verify each project's repository, hardware and licence before building on it.

## Where we are

Only **1 of the 8 open-platform classes** has a real-world body today: **Synth Arm**, the digital twin of the **SO-101**, which is the successor of the SO-ARM100 in that list. It comes with:
- Robot Link (Web Serial, Feetech STS3215 servos);
- the replay script;
- the Proving Grounds mission.

The three AX-1 classes (31% of agents) have a CC0 design, a twin and an experimental bridge firmware, untested on hardware until our first build. The other 7 open-platform classes are art and lore only, and the arena already says that "other classes get their missions soon". Turning that sentence into a plan is the single biggest upgrade to the "the NFT is the agent" story.

## Class → reference robot

| Class (share) | Open-source bodies from the list | First target | Why |
| --- | --- | --- | --- |
| **Synth Arm** (15%) | SO-ARM100 / **SO-101** ✅, RoArm-M2, OpenMANIPULATOR-X | SO-101 (done) | Already supported end to end |
| **Street Rover** (12%) | **LeKiwi**, TurtleBot3 Burger, OpenBot, Duckiebot | **LeKiwi** | LeRobot's mobile manipulator: an SO-101 arm on an omni-wheel base, built from the same STS3215 servos, so our servo bus, calibration and safety code carry over. Mission idea: drive to the cell, pick it, dock it |
| **Cyber Hound** (9%) | **Petoi Bittle**, Mini Pupper, Stanford Doggo, SpotMicro, OpenQuadruped, Puguette | Petoi Bittle | Cheapest ready-made quadruped with a documented serial command protocol, a good fit for Web Serial. Mission idea: trot a course, recover from a fall (failures are data) |
| **Replicant** (4%) | Poppy Humanoid, MiniLoong, Microban, pib, Otto DIY | Otto DIY (entry), Poppy (advanced) | Otto is the friendliest first humanoid. Keep Replicant rare in real life too |
| **Ghost Hand** (9%) | pib (it has hands) | later | Hands are hard; start with a gripper-only mission on the SO-101 |
| **Spider Mech** (8%) | not in the list | later | Look at open hexapods separately |
| **Sky Drone** (7%) | not in the list | later | Look at open micro-drones separately; flying adds safety and regulation work |
| **Fab Rig** (5%) | not in the list | later | 3D printers and CNC: a "fabricate a part" mission later |
| **AX-1 Rover / Desk / Walker** (14% / 11% / 6%) | our own CC0 design | AX-1 Rover | The phone is the brain; first team build planned. The Walker has no gait yet |

With the first three targets (SO-101, LeKiwi, Bittle), **36% of all agents** (Synth Arm, Street Rover and Cyber Hound) get a buildable body; with the AX-1 Rover and Desk builds, 61%.

## What else we can take from it

1. **One engineering step covers a second class.** LeKiwi reuses the SO-101 arm and servo family, so most of `web/js/robot/*` (bus, calibration, safety, Film mode) carries over. The new parts are wheel kinematics, a rover twin in the sim and one mission. This is the cheapest next real-world class.
2. **LeRobot dataset export (done).** Verified runs become a LeRobot dataset (format v3.0) that builders can push to the Hugging Face Hub under CC0:
   ```
   node scripts/lerobot-prep.mjs --data data/proving --attested --trials   # replay + check every run → lerobot-src.jsonl
   pip install lerobot
   python scripts/real/export_lerobot.py lerobot-src.jsonl --repo-id <hf-user>/openforge-proving-grounds [--only-success] [--push]
   ```
   Step 1 re-checks each episode's hash and replays it with the site's own simulator, recording measured joint states. Step 2 writes `action` and `observation.state` (`<joint>.pos`, degrees, gripper 0–100, 30 fps, `so101_follower`) with the official library, and keeps provenance in `meta/openforge.json`: data hash, agent, outcome, attestation. Failures are kept by default. `--push` needs `huggingface-cli login`. The episodes are simulated twin runs, labelled as such, not real-robot recordings.
3. **"Failure is data too."** The same account's previous post, on AGIBOT World physical-reasoning data, makes the point our on-chain record already shows ("failures logged"). That is a strong marketing hook, and it is backed by the product today.
4. **Licences are mixed.** Some 3D models are CC BY-NC-SA or CC BY-SA, for example Microban and Poppy. They **cannot** go into our CC0 art or assets. Keep our voxel bodies original, and link to the official repositories instead of copying models.
5. **Content and community.** That post's question, "Which robot would you build first?", is good engagement. Add a series to the marketing plan: "Build your agent's body: one class, one open robot, one mission".

## The phone as a body (second source)

A second post (Brian Roemmele on X, 2026-10-23, "The phone that becomes a robot…") shows a phone turned into a robot. Only the title and a frame were readable without signing in to X; the idea is what matters here, and **OpenBot** from the list above is its open-source form: a smartphone on a cheap wheeled chassis, where the phone provides the camera, sensors and compute.

Why it matters for us: it is the lowest possible barrier to a real body. Most holders already own the "brain", the chassis kit is cheap, and an SO-101 costs a few hundred euros.

1. **Entry body for Street Rover.** Two tiers:
   - "phone rover" (OpenBot-style): almost no cost; drive missions;
   - LeKiwi: drive and pick, more engineering, reuses the SO-101 code.
2. **The agent "rides" the phone.** The site already runs on phones. A phone-rover mission would stream the run as a normal episode, verified and attested like the Synth Arm runs, so holders can grow their agent's record with hardware they already have.
3. **Content for free.** Film mode records from the phone camera. A phone driving itself with the agent's twin on screen is a short, shareable clip.
4. **Check before building.**
   - Browser access to the chassis from a phone depends on the platform: Web Serial support on mobile browsers is limited, while Bluetooth or a small companion app are the usual routes.
   - Keep sensor data that leaves the phone to the run itself: no location, no background camera.

## Proposed order (after the launch)

1. ~~LeRobot dataset export~~: built (see above). Next: publish a first dataset from the Sepolia/launch runs.
2. Street Rover in two tiers: a "phone rover" (OpenBot-style, the cheapest body), then LeKiwi (reuses the SO-101 stack).
3. A Petoi Bittle profile for Cyber Hound.
4. Show a "Real body" line in each class's lore: reference robot, status (supported, planned, research), and a link.

None of this changes the contracts: classes are already on-chain traits, and missions are verified off-chain and attested with the existing sim pipeline.
