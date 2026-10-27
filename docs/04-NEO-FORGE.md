# Neo-Forge — Shared Voxel World (MVP v0.2)

> Status: MVP implemented — `web/world.html`, `web/js/world/`, `scripts/world-server.mjs`, `scripts/world/core.mjs`. v0.2 folds in the ECC architecture review.

The social layer of OpenForge AX. Holders walk their agents through a voxel city, meet other agents, and enter **stations** where real-robot missions run (the Proving Grounds). This is the "shared space between holders" in the project vision; the Proving Grounds are its first activity.

## 1. Principles
| Principle | Consequence |
|---|---|
| **The avatar is the NFT** | Appearance is generated deterministically from the on-chain traits (class, finish, core, augment, faction). The server resolves traits from `AgentRenderer`; clients cannot fake another agent's look. |
| **World ≠ simulator** | The voxel world handles presence and navigation only. Physics that must transfer to real robots lives inside stations (`openforge-arm-sim`), so the sim-to-real claim stays credible. |
| **Frictionless** | It runs in the browser on desktop and mobile. Guests walk as a "Visitor" drone. Holders sign once on entry (free, no gas) to appear as their agent. |
| **Safe by design** | No free-text chat in the MVP, only preset emotes, so there is nothing to moderate. No land sales, no in-world tokens. |

## 2. MVP scope
- **District:** Rust Docks (from the `District` trait). Docks, water channel, cranes, container stacks, neon signs, and the **Proving Grounds station**.
- **Avatars:** voxel models for all 8 classes, coloured by Finish and Core, with an Augment overlay and a faction badge. Legendary 1/1s get a gold finish and a crown halo. The nameplate shows the callsign (`AX-0009 // Iron Dragonfly`).
- **Multiplayer:** live presence, movement and 4 emotes (wave, spin, ping, GG). Rooms cap at 40 avatars; overflow opens new instances (`rust-docks#2`).
- **Station:** walking into the terminal zone shows "Enter the Proving Grounds"; this opens `arena.html` with the agent preselected.
- **Out of scope:** other districts, co-op missions, voice/text chat, persistence of world state, NPCs.

## 3. Architecture
```
browser (web/world.html)                     world server (scripts/world-server.mjs, WebSocket)
 ├─ voxel-avatar.js  traits -> voxels         ├─ join: guest | holder (EIP-712 signature + ownerOf)
 ├─ district.js      seeded Rust Docks map    ├─ traits from AgentRenderer.traitsOf (cached)
 ├─ world.js         input, camera, net       ├─ rooms per district, cap 40, instances
 └─ three.js InstancedMesh rendering          └─ 10 Hz snapshots, speed/bounds checks, emote rate limit
```
- **Protocol v1** (JSON over WebSocket, `maxPayload` 512 B, version field in `hello`):
  - server → client on connect: `challenge{nonce, district, expiresAt}`; `hello` must arrive within 5 s
  - client → server: `hello{mode: guest | holder{tokenId, owner, deadline, signature} | resume{token}}`, `move{x, z, yaw}`, `emote{e}`
  - server → client: `welcome{you, room, resumeToken, players}`, `join`, `leave`, `snap{k, ps[[id, x_cm, z_cm, yaw_u8]]}` (10 Hz, changed players only, keyframe every 2 s), `emote`, `correct{x, z}`, `kicked{reason}`, `error{code}`
- **Holder join:** EIP-712 `WorldJoin{tokenId, owner, district, nonce, deadline ≤ 5 min}`. The `nonce` is issued on this connection and consumed before any RPC call, so a captured signature can't be replayed. Checks run cheapest first: schema → deadline → signature → `ownerOf` → ERC-1271. For a Safe, `owner` is the Safe address. Each RPC call has a 5 s timeout.
- **Sessions:** one per agent; a newer *verified* join replaces the old one (`kicked{session_replaced}`, no auto-reconnect). The `resumeToken` keeps the slot for 30 s, so mobile reconnects don't need a new signature. `ownerOf` is re-checked every 60 s, and a sold agent is kicked.
- **Authority:** the server keeps the last accepted position. It uses server receive time for `dt`, clamps to 4 m/s, and collides against the same walkability grid as the client (`district.js`). It sends `correct` only when drift exceeds 0.6 m.
- **Abuse limits:** token bucket of 15 msg/s per connection (disconnect after repeated floods), 4 connections per IP, 500 global, guests ≤ 50% of a room, emotes ≤ 1/s, heartbeat ping 15 s, slow clients skip snapshots (`bufferedAmount` > 64 KB), Origin allowlist (`ALLOWED_ORIGINS`). Socket errors never crash the process (covered by a test).
- **Station handoff:** `arena.html?pilot=<tokenId>`. Only the id travels in the URL; the arena re-establishes identity through the wallet.

## 4. Path to the full world
1. **Co-op missions:** Synth Arm + Street Rover logistics, Sky Drone scouting. Multi-robot runs are verified with the same replay + batch-attestation pipeline and produce multi-agent coordination data.
2. **All 6 districts.** The home district comes from the trait and gives faction/district standings and seasons.
3. **Agent runtime presence.** In Assisted/Autonomous mode an agent can stay in the world when its owner is offline.
4. **Physical stations.** Real SO-101 cells mirrored in the world, with live telemetry on screen.

## 5. Risks
| Risk | Mitigation |
|---|---|
| Empty-world syndrome | Anchor the world in missions, factions and leaderboards; show live player counts |
| Server cost | Lightweight presence only (no physics server); 10 Hz snapshots; rooms capped |
| Griefing/abuse | No chat in the MVP; emote rate limit; server-side speed/bounds; per-IP connection cap |
| Impersonation | Holder identity requires an owner signature; traits come from the chain, not from the client |
| Mobile performance | Instanced voxels, low draw calls, capped pixel ratio, LOD by distance later |
