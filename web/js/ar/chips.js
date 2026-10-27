// The seven tap-to-say chips of the AR page. A chip is a phrase the built-in parser already understands, spoken for the
// user: it goes through exactly the same path as a voice request (ar-parse -> plan card -> ARM gate -> executor), so a chip
// can never move a Rover that has not been armed. STOP is not a chip: it is its own big button.

export const CHIPS = [
  { id: "forward", label: "Forward", say: "forward 1 s" },
  { id: "back", label: "Back", say: "back 1 s" },
  { id: "left", label: "Left", say: "turn left 45" },
  { id: "right", label: "Right", say: "turn right 45" },
  { id: "spin", label: "Spin", say: "turn left 180 then turn left 180" },
  { id: "curious", label: "Curious", say: "look left then look right then look up then look center" },
  { id: "wiggle", label: "Wiggle", say: "turn left 30 then turn right 60 then turn left 30" },
];

/** The phrase of chip `id`, or null for an unknown id. */
export function chipText(id) {
  const c = typeof id === "string" ? CHIPS.find((x) => x.id === id) : null;
  return c ? c.say : null;
}
