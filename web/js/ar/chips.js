// The tap-to-say chips of the AR page, per body. A chip is a phrase the built-in parser already understands for that body,
// said for the user: it goes through exactly the same path as any request (ar-parse -> plan card -> ARM gate -> executor),
// so a chip can never move a twin that has not been armed. STOP is not a chip: it is its own big button.
// `hold: true`: holding the chip keeps the Rover or the Walker moving (controller.press). The Walker's Forward, Back,
// Left and Right are walk leases in the controller (its twin walks; the bridge has no walking command), not phrases.
// The Desk's joints are absolute and bounded: a tap is the whole move.

export const CHIPS_BY_BODY = Object.freeze({
  rover: Object.freeze([
    { id: "forward", label: "Forward", say: "forward 1 s", hold: true },
    { id: "back", label: "Back", say: "back 1 s", hold: true },
    { id: "left", label: "Left", say: "turn left 45", hold: true },
    { id: "right", label: "Right", say: "turn right 45", hold: true },
    { id: "spin", label: "Spin", say: "turn left 180 then turn left 180" },
    { id: "curious", label: "Curious", say: "look left then look right then look up then look center" },
    { id: "wiggle", label: "Wiggle", say: "turn left 30 then turn right 60 then turn left 30" },
  ]),
  desk: Object.freeze([
    { id: "wave", label: "Wave", say: "wave" },
    { id: "nod", label: "Nod", say: "nod" },
    { id: "point", label: "Point", say: "point" },
    { id: "shrug", label: "Shrug", say: "shrug" },
    { id: "left", label: "Turn left", say: "turn left 45" },
    { id: "right", label: "Turn right", say: "turn right 45" },
    { id: "curious", label: "Curious", say: "look left then look right then look up then look center" },
    { id: "home", label: "Home", say: "home" },
  ]),
  walker: Object.freeze([
    { id: "forward", label: "Forward", say: "walk forward", hold: true },
    { id: "back", label: "Back", say: "walk back", hold: true },
    { id: "left", label: "Left", say: "turn left on the spot", hold: true },
    { id: "right", label: "Right", say: "turn right on the spot", hold: true },
    { id: "stand", label: "Stand", say: "stand" },
    { id: "crouch", label: "Crouch", say: "crouch" },
    { id: "lean-left", label: "Lean left", say: "lean left" },
    { id: "lean-right", label: "Lean right", say: "lean right" },
    { id: "twist", label: "Twist", say: "twist" },
  ]),
});

/** The Rover's chips (the page's default body). */
export const CHIPS = CHIPS_BY_BODY.rover;

/** The chips of body `key` ("rover" | "desk" | "walker"); the Rover's for anything else. */
export function chipsFor(key) {
  return typeof key === "string" && Object.hasOwn(CHIPS_BY_BODY, key) ? CHIPS_BY_BODY[key] : CHIPS;
}

/** The phrase of chip `id` for body `bodyKey`, or null for an unknown id. */
export function chipText(id, bodyKey = "rover") {
  const c = typeof id === "string" ? chipsFor(bodyKey).find((x) => x.id === id) : null;
  return c ? c.say : null;
}
