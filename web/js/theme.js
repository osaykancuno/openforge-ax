// Theme: light paper by default on every page; the visitor can switch to dark, remembered in this browser.
// The choice lives on <html data-theme="dark"> (set before paint by theme-boot.js); CSS tokens and the 3D views
// (web/js/models/look.js onThemeChange) follow the "ofx-theme" event.
const KEY = "ofx-theme";

export const getTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function setTheme(theme) {
  const dark = theme === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    if (dark) localStorage.setItem(KEY, "dark");
    else localStorage.removeItem(KEY);
  } catch {} // storage blocked: the choice lasts for this page only
  paintBar();
  window.dispatchEvent(new Event("ofx-theme"));
}
/** The browser bar (theme-color) follows the page: paper in light, the dark paper in dark. */
function paintBar() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getTheme() === "dark" ? "#1c1a17" : "#f4efe6";
}
if (typeof document !== "undefined") paintBar();

/** A toggle button (aria-pressed = dark on). `className` styles it for the page it sits in. */
export function themeButton(className = "btn sm ghost theme-btn") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.setAttribute("aria-label", "Dark mode");
  const sync = () => {
    const dark = getTheme() === "dark";
    b.setAttribute("aria-pressed", String(dark)); // the state lives in aria-pressed; name and glyph stay the same
    b.innerHTML = '<span aria-hidden="true">☾</span><span class="nav-txt">Dark mode</span>';
    b.title = "Dark mode";
  };
  b.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));
  window.addEventListener("ofx-theme", sync);
  sync();
  return b;
}
