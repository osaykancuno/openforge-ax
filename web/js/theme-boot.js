// Runs in <head>, before the first paint: applies the theme the visitor picked (web/js/theme.js), so a dark page
// never flashes light. Light is the default; the OS setting alone never switches it.
try {
  if (localStorage.getItem("ofx-theme") === "dark") document.documentElement.dataset.theme = "dark";
} catch {} // storage blocked: light

// framed by any other page (hosts that ignore web/_headers): show nothing and stop the page, so no click can be stolen
// (clickjacking) and no wallet prompt can fire in a hidden frame. Nothing on this site frames itself, so same-origin is blocked too.
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try {
    window.stop(); // no more scripts or requests
    document.documentElement.replaceChildren(); // and nothing left to run
  } catch {}
}
