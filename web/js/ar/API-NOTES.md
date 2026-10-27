# AR logic: API notes from Builder A (additions and exact semantics; no signature from the blueprint was renamed)

## ar-controller.js
- `createArController({ clock, makeTransport, voice, wake, parse, extensions, onChange, createAi, radius })`: two additions to
  the blueprint list: `extensions` (array of ar-parse extensions, read on every request, so the page may push into it later)
  and a default `makeTransport` (Rover twin, 15 ms). Without `parse` the controller builds `createArParser(...)` itself with
  its own obstacle state; pass `parse` only to replace it completely.
- States: `ready` -> `starting` -> `placing` -> `armed` <-> `latched`; `ended()` goes back to `ready`. The page owns the
  checking / desktop screens. `STATES` is exported.
- `place(opts)` needs `opts.gesture === true` (anything else returns false and writes nothing). First call (state `placing`)
  arms; later calls only reset the odometry to 0 (and never while a plan runs: returns false). After a STOP a tap moves the
  Rover but does not arm: only the ARM button does.
- `arm()` works only in `latched` after the Rover was placed.
- `stop(reason)` returns the loop.stop promise; `hold(reason)` interrupts the plan and zeroes the wheels, state stays `armed`.
- Added `visibility(s)`: `"hidden"` -> stop, `"visible-blurred"` -> hold, `"visible"` -> nothing. Page hidden / pagehide /
  Esc / STOP button: call `stop(reason)`. XR end / Exit: `ended(reason)`.
- `seek` is a get/set property: assign an object with `cancel()` and STOP will call it (after `ai.cancel`, before `loop.stop`).
- `frame(dt)` returns a reused object `{ x, z, yaw, clamped }` (do not keep it). `pose` is the live local odometry.
- `snapshot` is the live drive-loop snapshot (fresh object per read). `_loop` is the real loop, for tests only.
- `obstacle(update)` is ignored in camera mode (no sensing there). Pass the tracker result unchanged.
- `view`: `{ state, mode, link, armed, placed, message, notice, heard, hint, canPlace, canArm, canStop, listening,
  voiceSupported, voiceNote, sensing: { level: off|clear|blocked|blind, text }, radius, chips, odometry, ai }` where `ai` is the
  AI Pilot view (`state, running, busy, messages, plan, progress`). `heard` is `"I heard: ..."` for voice/typed requests.
- The AI gets a Proxy over the loop: `holdFor` refuses forward drives into an obstacle or past the edge (and interrupts the
  plan with the message); `arm`, `connect`, `disconnect`, `setSpeed` do nothing for it.

## twin-pose.js
- `applyTwinState(rig, snap, body, pose, dt, { radius })` returns true when the pose hit the edge. With `dt = 0` it only writes
  the pose (this is how ar.js applies the pose the controller already advanced: do NOT also step it there).
- `stepPose` returns true only when a step pushed against the edge (a pure turn at the edge is not an edge hit).

## obstacle.js
- `corridorSamples(worldPose, opts)` -> array of `{ x, y, z }`; `worldPose.y` is the floor height. `project` / `unproject`
  take points as `[x, y, z]` or `{ x, y, z }`; `unproject` returns `[x, y, z]`. Depth is the distance along the view axis.
- `evaluateRays(distancesM)`: distances are from the Rover's CENTRE along the ray (the bumper offset is subtracted inside).
  Any valid plane inside the look-ahead counts as MIN_HITS (one platform plane is already a confirmed detection).
- Tracker: `update(null)` or `{ source: "off" }` -> `{ state: "off" }` and resets. Hits >= MIN_HITS always count, even when
  most of the corridor is out of view. While `blocked`, frames that cannot see the corridor change nothing (still blocked).
- Exports `BLIND_MESSAGE`.

## ar-parse.js
- Extension results are validated again; `say` of an extension result is cleaned to 600 characters. An extension that throws
  or returns something without a `steps` array is skipped. `filterBlocked(steps, blocked) -> { steps, note }`.
