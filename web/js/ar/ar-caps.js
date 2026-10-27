// What this phone can do for "AX-1 in your room", decided once before the Start card is shown. Nothing here opens the
// camera or the microphone: it only asks the browser what it has.
//   xr       WebXR immersive-ar (Android Chrome with ARCore): the Rover stands on your real floor.
//   camera   no WebXR AR (iPhone, Firefox...): the camera is the background and the Rover is placed in front of it.
//   desktop  not a phone: the page shows its address to open on one.
//   none     a phone, but with neither WebXR AR nor a camera API, or the page is not HTTPS.
// `nav` and `win` are injectable so Node tests can fake a phone.

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;
const IOS_UA = /iPhone|iPad|iPod/i;

/** probeAr({ nav, win }) -> { mode, secure, ios, voice, orientationNeedsPermission, why }. Never throws. */
export async function probeAr({ nav = globalThis.navigator, win = globalThis.window } = {}) {
  nav = nav || {};
  win = win || {};
  const ua = String(nav.userAgent || "");
  const touch = Number(nav.maxTouchPoints) || 0;
  const macTouch = /Macintosh/i.test(ua) && touch > 1; // iPadOS says Mac
  const ios = IOS_UA.test(ua) || macTouch;
  let coarse = false;
  try {
    coarse = !!(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
  } catch {}
  const mobile = MOBILE_UA.test(ua) || macTouch || (coarse && touch > 0);
  const secure = win.isSecureContext === true;
  const voice = !!(win.SpeechRecognition || win.webkitSpeechRecognition);
  const orientationNeedsPermission = !!(win.DeviceOrientationEvent && typeof win.DeviceOrientationEvent.requestPermission === "function");
  const out = (mode, why) => ({ mode, secure, ios, voice, orientationNeedsPermission, why });

  if (!mobile) return out("desktop", "This page is made for a phone. Open it on your phone to see the AX-1 Rover twin in your room.");
  if (!secure) return out("none", "AR and the camera need a secure page (HTTPS). Open this page from its https:// address.");

  let xr = false;
  try {
    xr = !!(nav.xr && typeof nav.xr.isSessionSupported === "function" && (await nav.xr.isSessionSupported("immersive-ar")));
  } catch {
    xr = false; // a browser that throws here has no AR for us
  }
  if (xr) return out("xr", "Your browser can place the Rover on your real floor.");

  const camera = !!(nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function");
  if (camera) return out("camera", "Your browser has no AR mode, so the camera view is used: the Rover stands in front of what your camera sees, but it is not anchored to your floor.");
  return out("none", "This browser offers neither AR nor camera access, so the Rover cannot be shown in your room.");
}
