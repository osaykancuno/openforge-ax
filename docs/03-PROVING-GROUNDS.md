# The Proving Grounds — Design (MVP v0.2)

> Status: MVP implemented — `web/arena.html`, `web/js/sim/`, `scripts/proving-server.mjs`, `scripts/real/replay_so101.py`. v0.2 folds in the ECC architecture review.

A shared, browser-based simulation where holders pilot their agents through missions. It plays like a game, but every run is a **digital twin of a real robot task**: the recorded commands can be replayed on the physical robot, and verified runs feed the on-chain reputation.

## 1. Principles
| Principle | Consequence |
|---|---|
| **Sim ↔ real parity** | The Synth Arm *is* an SO-101 (LeRobot open-source arm): same 6 joints, `*.pos` feature names, degrees, position control at 30 fps. A run = a joint-command sequence a real SO-101 can execute. **Commands themselves** are limited to 6°/tick (real servos jump to targets at full speed), and the verifier rejects any run that breaks it. |
| **Server-authoritative** | The client only sends inputs. A deterministic sim core (same JS module in browser and server) replays the run; only the server's result counts. |
| **Simulated ≠ real** | Sim runs never touch the real reputation tiers: they have their own counters (`Sim Runs`, `Sim Successes`) and their own points. |
| **Beginner first** | Default "Easy" control moves the gripper in space (IK converts to joint commands); "Pro" control drives joints directly. |
| **No financial rewards** | Points, reputation, leaderboards and faction standings only. |

## 2. Mission MVP: `pick-place-cell`
Move the energy cell from the table into the charging dock within 60 s.
- Spawn positions are derived from a **server-issued seed** (no pre-computed runs).
- Success: cell released and resting inside the dock (radius 3 cm).
- Failure data that is still valuable: missed grasps, drops, table hits, pushes. Logged as events.

## 3. Robot model (SO-101 approximation)
| Joint | Range (°) | Notes |
|---|---|---|
| `shoulder_pan` | −110 … 110 | yaw around base |
| `shoulder_lift` | −100 … 100 | 0 = upper arm vertical |
| `elbow_flex` | −100 … 100 | relative |
| `wrist_flex` | −100 … 100 | relative |
| `wrist_roll` | −160 … 160 | |
| `gripper` | 0 … 100 | 0 closed, 100 open |

Links (m): base 0.06, upper arm 0.116, forearm 0.135, wrist→tip 0.10 (approximation; align with the official SO-101 URDF before Phase 2). Zero pose: pan 0 faces +x, lift 0 = upper arm vertical, elbow/wrist 0 = aligned with the previous link. Units are degrees **in this kinematic frame**, not LeRobot's normalized −100…100. Each physical arm needs a sign/offset/limit calibration file, applied by the bridge (§6).

## 4. Episode format `openforge.episode.v1`
Built by `web/js/sim/episode.js` (fields aligned with LeRobot `info.json`):
`format, sim, mission, task, robot_type: "so101_follower", units: "deg", fps: 30, tokenId, challengeId, seed, scene, features.action ["shoulder_pan.pos", …], actions`.
- `scene`: cell/dock poses in meters in the robot base frame, so a physical station can be set up from the file.
- `actions[t]`: joint commands (0.1° precision).
- **`dataHash` = keccak256 of the canonical JSON of the client episode.** Keys are sorted, there is no whitespace, and the server rebuilds the episode from the issued challenge. The signed hash and the attested hash are the same value.
- The server's result is a separate record (`outcome`, `quality`, `observation_state` per tick from the replay) keyed by `dataHash`.

## 5. Flow
1. **Challenge**: `GET /challenge?tokenId=N&owner=0x…` checks that `owner` currently owns the token and that it is a Synth Arm. It returns `{challengeId, seed, expiresAt}` (single use, 10 min, max 30/hour per wallet).
2. **Play** in `arena.html`; inputs are sampled to `actions` at 30 Hz.
3. **Submit**: the holder signs EIP-712 `Run{tokenId, challengeId, episodeHash, mission, sim, deadline}` (domain: chainId + reputation contract; free, no gas; ERC-1271 accepted for Safe/contract wallets), then `POST /episodes`. A run submitted faster than real time is rejected.
4. **Verify**: the server checks the signature against the current `ownerOf(N)` and the challenge owner. It validates the command limits, replays the run authoritatively, scores it and stores it.
5. **Attest in batches**: every few minutes, or every 20 runs, the attester calls `AgentReputation.attestSimBatch(...)`. That is one transaction for many runs, so gas stays low.
6. OpenSea refreshes the agent (ERC-4906). The new attributes "Sim Runs" and "Sim Successes" appear.

Guests (no wallet) can play the same mission; their runs are scored but never attested.

## 6. Real-world bridge
For most holders: **Robot Link** (`web/robot.html`, [05-ROBOT-LINK.md](05-ROBOT-LINK.md)), a guided in-browser wizard over Web Serial, with nothing to install. For LeRobot users:
`scripts/real/replay_so101.py run.json` (file from the arena's "Download run file") streams the joint targets to an SO-101 follower through LeRobot. Safety gates:
- dry run by default; `--execute` is required to move the arm;
- speed 0.5× by default;
- refuses runs that hit the table or throw the cell;
- checks the per-tick command step;
- uses the intersection of sim limits and the arm's calibrated limits;
- 2 s ease-in from the current pose and return to rest at the end;
- torque off on any exception or Ctrl+C;
- LeRobot `max_relative_target` set.

Sim success means "plausible trajectory", not guaranteed real success: contact and grasp physics differ. Phase 2 adds physical stations where real runs are attested at full weight.

## 7. Scoring (`quality`, 0–10,000)
- **Success**: 6,000 + speed bonus (≤2,500).
- **Failure**: 600 per *distinct* event type (grasp, miss, release, drop, push, table hit), capped at 3,000. Repeated flailing adds nothing.
- Runs with quality < 1,000 are stored as data but **not attested**. Trajectories that match one already stored at 1° resolution are not attested. Max 10 attested runs per agent per day, enforced both by the server and on-chain.
- A scripted planner can beat humans. That is acceptable: the reputation measures verified, replayable robot behaviour, not proof that a human was at the controls.

## 8. On-chain changes
- `AgentReputation.attestSimBatch(SimResult[] results, string uri)`, callable only by a **separate `isSimAttester` role** (the real-run attester cannot call it, and the reverse also holds). `SIM_DAILY_CAP = 10` per token per UTC day; a batch over the cap reverts. `SimResult = {tokenId, success, quality, dataHash}`. Updates the separate `simStatsOf(tokenId) → (runs, successes)` and `simPointsOf(tokenId)` (`quality / 100`, successful runs only); real Data Points are untouched. **Bad items never revert the batch**: they are skipped with `SimRejected(tokenId, dataHash, reason)` (1 quality, 2 empty hash, 3 duplicate, 4 unknown agent, 5 daily cap). Unique `(tokenId, dataHash)` as for real attestations.
- `AgentRenderer`: adds the attributes `Sim Runs` and `Sim Successes`, read with a gas-limited staticcall.

## 9. Out of scope for the MVP
Multi-agent shared sessions (live presence, co-op tasks), other classes' missions, autonomous (runtime-driven) attempts, IPFS pinning of episodes, decentralized verification. Each one plugs into the same episode format and attestation path.

## 10. Risks
| Risk | Mitigation |
|---|---|
| Bots farming reputation | Sim points are separate from real tiers; server seeds, owner signature, real-time rule, 1° duplicate filter, 10/day cap on-chain |
| Sim-to-real gap | SO-101 kinematics and limits, servo speed model, calibration in the bridge; real stations in Phase 2 |
| Attester key compromise | Separate `isSimAttester` hot key with minimal ETH, revocable via `setSimAttester`; it can only touch sim counters (≤10/token/day); every batch is auditable (`/batches/<id>`, events, stored episodes) |
| Float determinism across engines | Server result is authoritative; the client score is only a preview |
