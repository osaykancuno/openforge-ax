# AR bodies blueprint: AX-1 Desk and Walker twins next to the Rover

Plan for the next AR step (user request, 2026-10-28), written by `ecc:architect` from the code as of `3eaccd4` plus the
uncommitted voice removal, reverse obstacles and low-light work. Line numbers drift: search for the names. Not built yet.

Fixed decisions: no voice on the AR page for now; the Rover keeps everything it has (5 cm stop ahead and behind,
hold-to-drive, odometry, low-light sensing); **the Walker has no gait: poses only, never claim walking**; the Desk has no
wheels; arming only from a real gesture (place or ARM), STOP always wins; every motion through the executor / drive loop
with the existing validation; TWIN label; real scale; `web/js/models/robots.js` is a frozen provenance file (import only).

## 1. UX
- **Start card:** a "Choose a body" fieldset above the steps, three radio cards (`name="arBody"`, ≥ 48 px, Rover
  checked): Rover "drives on the floor"; Desk "sits on a table and waves, no wheels"; Walker "holds poses, it does not
  walk". The lead and steps 2–3 follow the choice (textContent). Look around shows for the Rover only in v1 (the vision
  intents already answer null for other bodies). The body is fixed per session: Exit, pick again, Start. Radios are
  disabled while starting or live.
- **Chips** (tap = short action; only the Rover's four direction chips can be held):

| Body | Chips (id → phrase) | Hold |
|---|---|---|
| Rover | unchanged | forward, back, left, right |
| Desk | wave, nod, point, shrug, `turn left 45`, `turn right 45`, curious (look L/R/up/center), home | none |
| Walker | stand, crouch, `lean left`, `lean right`, twist, torso left/right (`turn left 30` / `turn right 30`), sway (`lean left then lean right then stand`) | none |

  Desk and Walker joints are absolute and bounded, so a hold would need a new joint-lease path: not in v1.
- **HUD:** the link chip names the body ("Place the Desk", "Desk · Armed"); the obstacle slot says "Stays where you put
  it" (Desk) or "Poses only · it does not walk" (Walker); the Desk placing hint says "Aim at a table or the floor, then
  tap"; the Place button reads "Place the {Name} here".

## 2. Code
- **`chips.js`:** keep `CHIPS` (Rover); add `CHIPS_BY_BODY = { rover, desk, walker }`, `chipsFor(key)`, a `hold: true`
  flag on the Rover's four direction chips, `chipText(id, bodyKey = "rover")`. `spokenAliases` stays Rover-only.
- **`ar-controller.js`:** replace the `ROVER` constant with session variables `body`, `bodyKey`, `drives =
  P.BODIES[body].drive`, `name`. `start(mode, key = "rover")` refuses an unknown key before connecting, passes the body to
  `makeTransport(body)` and `getBodyKey: () => bodyKey`. `obstacleAhead` returns Infinity, `sensing()` returns `{ level:
  "none" }`, and `obstacle()`, `press()` and `frame()` odometry do nothing when `!drives`. Messages and `hint()` use the
  name. `view` gains `body`, `drives`, `chips`; add a `body` getter; `ended()` clears it. The guard proxy stays as is
  (`holdFor` already refuses bodies without wheels). `.arm(` stays only in `place()` and `arm()`.
- **`ar-view.js`:** `setBody(key)` before any session (throws if `view.mode` is set): dispose the old rig, `buildRobot(
  "ax1-" + key)`, swap the reticle footprint (Rover rectangle, Desk circle r 0.11, Walker ±0.075 × ±0.05), shadow box
  half-size 0.4 / 0.4 / 0.5 and key-light target height 0.1 / 0.15 / 0.25, `senses = drives`. Walker: keep its feet on the
  floor through `bounds()` when the joints change (as `pilot.js` does), never by editing the model. `sense()` only when
  `senses`. Hints use the body name. The warm-up compile already covers the right rig when `setBody` runs first.
- **`ar.js`:** no `ROVER`; `makeTransport: (b) => createTwinTransport({ body: b, … })`; `applyTwinState(rig, snap,
  controller.body, …)`; radio change → `view.setBody`, `buildChips(key)` (hold behaviour only where `c.hold`), card text;
  `onStart` → `controller.start(mode, key)`; obstacle chip/announcements only when `model.drives`; name-aware texts,
  canvas `aria-label` and meta descriptions.
- **`ar.css`:** `.ar-bodies` (3 columns, 1 under 360 px), `.ar-body input:checked + span`, compact short-landscape layout.

## 3. Tests
- `ArTwin`: the rig helper takes a `body`. Chips: unique ids per body; every Desk/Walker phrase parses fully for its body
  (steps > 0, nothing unknown or rejected); no `drive`/`turn` steps for Desk/Walker; `hold` only on the Rover's four;
  `CHIPS` deep-equals `chipsFor("rover")`. Controller: `start("xr", "desk")` connects a Desk twin with `drives` false and
  sensing "none"; an unknown key returns false and makes no transport; a Desk chip while LATCHED waits and moves nothing;
  after `place()`, wave moves `r_shoulder`; STOP mid-gesture latches and freezes for 60 s; Desk/Walker `press()` false and
  obstacle updates ignored; `frame()` keeps the pose at 0 for 5 s; Walker "walk forward" gives no steps and a "can't walk"
  note, crouch reaches its knee angle; `ended()` then `start("xr", "walker")` uses a fresh Walker transport, not placed.
- `ArPage`: three `arBody` radios, Rover checked, the Walker label says it does not walk; no "Walker … walks" text in
  html/js; no `HOLDABLE` literal; `controller.start(` takes the body; `setBody(` never after `startXr(`; ar-view has no
  hard-coded `"ax1-rover"`, `setBody` throws when a mode is set, `sense(` gated by `senses`; `robots.js` unchanged.
- **Docs:** docs/13 §9b ("Rover, Desk or Walker twin", a Bodies paragraph: Desk no wheels and can sit on a table; Walker
  poses only, feet kept on the floor by the drawing, not by balance; obstacle sensing and hold-to-drive Rover-only; Desk
  and Walker not yet run on a phone); docs/18 a row "Desk and Walker twins in AR, poses and gestures" (say "it does not
  walk"; measure the sizes with `bounds()` before publishing: estimates Desk ~28 cm, Walker ~41 cm).

## 4. Risks
- Frozen `robots.js`: the Walker's feet sit ~1 cm below y = 0 standing and lower when crouching; ground it with
  `bounds()` in the view.
- Switching body mid-session is impossible by design (`setBody` throws while live; radios hidden/disabled): a switch is
  always `ended()` → new `start` (LATCHED) → place / ARM.
- Walker claims: no chip, hint, label or doc may say "walk" (the grammar already refuses it).
- Shader compile stall: `setBody` must run before the session starts, so the warm-up compile covers the right rig. The
  Walker has more draw calls: check frame time on the S24 with `?debug`.
- The Desk on a table: the 3 m play area and edge rule do not apply (it does not drive); phones find tables less
  reliably than floors.
