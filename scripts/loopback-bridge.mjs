// Loopback bridge: runs the AX-1 firmware state machine (web/js/pilot/bridge-sim.js) against the real phone drive
// loop (web/js/pilot/drive-loop.js) in Node, with real timers and a simulated radio hop, and checks the safety
// story end to end: connect -> latched, ARM, drive, watchdog hold on a stalled phone, STOP, link loss + reconnect.
// Usage: node scripts/loopback-bridge.mjs [rover|desk|walker] [--latency 20] [--quiet]   (exit code 1 on failure)
import * as P from "../web/js/pilot/ax-proto.js";
import { createDriveLoop, LINK } from "../web/js/pilot/drive-loop.js";
import { createTwinTransport, realTimers } from "../web/js/pilot/twin-transport.js";

const args = process.argv.slice(2);
const bodyKey = args.find((a) => ["rover", "desk", "walker"].includes(a)) || "rover";
const latencyMs = Number(args[args.indexOf("--latency") + 1]) || (args.includes("--latency") ? 0 : 20);
const quiet = args.includes("--quiet");
const body = P.bodyByKey(bodyKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => quiet || console.log(`${String(Date.now() - t0).padStart(5)} ms`, ...a);

let failures = 0;
function expect(ok, what) {
  if (ok) log(`  ok   ${what}`);
  else {
    failures++;
    console.error(`  FAIL ${what}`);
  }
}

const tr = createTwinTransport({ body, clock: realTimers, latencyMs });
const br = tr.bridge;
const loop = createDriveLoop({ transport: tr, clock: realTimers, onChange: (s) => s.message && log(`app: ${s.link} · ${s.message}`) });
const bstate = () => br.snapshot;

log(`AX-1 ${bodyKey}, simulated radio hop ${latencyMs} ms`);
await loop.connect();
expect(loop.link === LINK.LATCHED, "connect leaves the robot latched");
expect(bstate().torque === false, "torque is off after boot");

await loop.arm();
expect(loop.link === LINK.ARMED && bstate().state === P.STATE.ARMED, "ARM (user gesture) arms both sides");
loop.setSpeed(100);
if (P.BODIES[body].drive) {
  loop.setHeld(true);
  loop.setStick(0, 1);
} else loop.setJoint(P.BODIES[body].joints[0].name, 45);
await sleep(700);
expect(bstate().state === P.STATE.ARMED, "33 ms sender keeps the 250 ms watchdog fed");
if (P.BODIES[body].drive) expect(bstate().drive[0] === 1000, `wheels at full output (${bstate().drive})`);
else expect(bstate().present[0] > 0 && bstate().present[0] <= 450, `joint 0 moving, rate-limited (${bstate().present[0] / 10} deg)`);

// the phone's JS thread freezes for 400 ms (busy page, background throttling)
const freezeUntil = Date.now() + 400;
while (Date.now() < freezeUntil); // eslint-disable-line no-empty
await sleep(50);
expect(bstate().state === P.STATE.LATCHED, `bridge held on its own (latch: ${P.LATCH_TEXT[bstate().latch]})`);
expect(bstate().drive.every((d) => d === 0), "wheel outputs are zero and braking");
await sleep(400);
expect(bstate().state === P.STATE.LATCHED, "nothing resumes without a new ARM");

await loop.arm();
loop.setHeld(true);
loop.setStick(0.4, 0.6);
await sleep(300);
await loop.stop("loopback STOP");
await sleep(100);
expect(bstate().latch === P.LATCH.USER_STOP && loop.link === LINK.LATCHED, "STOP latches both sides");

await loop.arm();
await sleep(100);
tr.dropLink();
expect(bstate().latch === P.LATCH.LINK_LOST, "link loss -> bridge holds (LINK_LOST)");
await sleep(900);
expect(loop.link === LINK.LATCHED, "app reconnected after backoff and stays latched");
expect(bstate().state === P.STATE.LATCHED, "bridge still latched until ARM");

await loop.disconnect();
console.log(failures ? `\nloopback: ${failures} check(s) FAILED` : "\nloopback: all checks passed");
process.exit(failures ? 1 : 0);
