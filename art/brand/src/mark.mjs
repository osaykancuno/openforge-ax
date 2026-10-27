// The AX-1 mark: a landscape phone for a head (charcoal), two warm eyes, a terracotta mouth, clamp "ears", a chin bar.
// One source for the logo, the favicon and the site header. Pure string, usable in Node and the browser. CC0.
export const INK = "#23211e";
export const PAPER = "#f4efe6";
export const TERRA = "#c8553d";

/**
 * @param {object} o
 * @param {number} [o.size] pixel size (viewBox is always 100×100)
 * @param {string|null} [o.bg] background fill, null = transparent
 * @param {"square"|"round"|"circle"} [o.shape] background shape
 * @param {[number, number]} [o.look] eye offset, -1..1 each
 * @param {"idle"|"happy"} [o.mood] "happy" (arched, smiling eyes) is THE logo (user decision, 2026-10-27); "idle" = open eyes
 */
export function markSVG({ size = 100, bg = PAPER, shape = "round", look = [0, 0], mood = "happy" } = {}) {
  const [lx, ly] = look;
  const ex = lx * 3, ey = ly * 2.5;
  const back =
    bg === null ? "" :
    shape === "circle" ? `<circle cx="50" cy="50" r="50" fill="${bg}"/>` :
    `<rect width="100" height="100" rx="${shape === "round" ? 22 : 0}" fill="${bg}"/>`;
  const eyes = mood === "happy"
    ? [38, 62].map((x) => `<path d="M${x - 6 + ex} ${50 + ey} q6 -8 12 0" fill="none" stroke="${PAPER}" stroke-width="3.6" stroke-linecap="round"/>`).join("")
    : [38, 62].map((x) => `<ellipse cx="${x + ex}" cy="${46 + ey}" rx="5.4" ry="7.4" fill="${PAPER}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="AX-1">${back}` +
    `<rect x="6" y="40" width="10" height="20" rx="3.5" fill="${INK}"/><rect x="84" y="40" width="10" height="20" rx="3.5" fill="${INK}"/>` +
    `<rect x="13" y="26" width="74" height="48" rx="11" fill="${INK}"/>` +
    eyes +
    `<rect x="44" y="61" width="12" height="3.6" rx="1.8" fill="${TERRA}"/>` +
    `<rect x="35" y="79" width="30" height="6" rx="3" fill="${TERRA}"/>` +
    `</svg>`;
}
