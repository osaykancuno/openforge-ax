// Runs in <head>, before the first paint: applies the theme the visitor picked (web/js/theme.js), so a dark page
// never flashes light. Light is the default; the OS setting alone never switches it.
try {
  if (localStorage.getItem("ofx-theme") === "dark") document.documentElement.dataset.theme = "dark";
} catch {} // storage blocked: light

// framed by another site (hosts that ignore web/_headers): show nothing, so no click can be stolen (clickjacking)
if (window.top !== window.self) {
  try {
    if (window.top.location.origin !== window.location.origin) throw 0;
  } catch {
    document.documentElement.style.display = "none";
  }
}
