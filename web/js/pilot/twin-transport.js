// Twin transport: the same byte-level interface as ble-transport.js, but the "robot" is bridge-sim.js running
// in the page (or in Node). Every command takes the real protocol path: encode -> bridge state machine -> AX_STATE
// notify -> decode. No DOM, so the loopback bridge and the tests use it too.
import { BODIES, CONTROL_MS, ERR, ProtoError } from "./ax-proto.js";
import { createBridge } from "./bridge-sim.js";

export const realTimers = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

const errName = (code) => Object.keys(ERR).find((k) => ERR[k] === code) || String(code);

/**
 * createTwinTransport({ body, clock, latencyMs, bridgeOpts })
 * latencyMs simulates the BLE hop for CMD writes and notifications (0 = synchronous, for tests).
 */
export function createTwinTransport({ body, clock = realTimers, latencyMs = 0, bridgeOpts = {} } = {}) {
  const bridge = createBridge({ body, now: clock.now(), ...bridgeOpts });
  bridge.pressBoot(2000); // the twin is always in its pairing window
  let notifyCb = null;
  let discCb = null;
  let timer = null;
  let up = false;
  const later = (fn) => (latencyMs > 0 ? clock.setTimeout(fn, latencyMs) : fn());
  const run = () => bridge.tick(clock.now());
  bridge.onNotify = (bytes) => later(() => up && notifyCb && notifyCb(bytes));

  function open() {
    run();
    const r = bridge.connect({ id: "twin", mtu: 247 });
    if (!r.ok) throw new Error(`The twin refused the connection (${r.err}).`);
    up = true;
    timer = clock.setInterval(run, CONTROL_MS);
  }
  function close() {
    up = false;
    if (timer !== null) clock.clearInterval(timer);
    timer = null;
    run();
    bridge.disconnect();
  }
  // Writes with response cross the hop both ways in the same FIFO queue as notifications, so ordering matches BLE (ATT is ordered).
  const withResponse = (write, bytes) =>
    new Promise((resolve, reject) => {
      if (!up) return reject(new Error("not connected"));
      later(() => {
        if (!up) return reject(new Error("not connected"));
        run();
        const code = write(bytes);
        // the response rides back over the same hop, behind any notification the bridge sent before it
        later(() => (code === ERR.OK ? resolve() : reject(new ProtoError(code, `The bridge refused the write (${errName(code)}).`))));
      });
    });

  return {
    kind: "twin",
    name: `${BODIES[body].name} twin`,
    bridge,
    get connected() {
      return up;
    },
    async connect() {
      open();
    },
    async reconnect() {
      if (!up) open();
    },
    async disconnect() {
      close();
    },
    async readInfo() {
      run();
      return bridge.infoBytes();
    },
    async readState() {
      run();
      return bridge.stateBytes();
    },
    /** Write without response: no error reaches the phone, exactly like BLE. */
    sendCmd(bytes) {
      later(() => {
        if (!up) return;
        run();
        bridge.writeCmd(bytes);
      });
      return Promise.resolve();
    },
    writeStop: (bytes) => withResponse((b) => bridge.writeStop(b), bytes),
    writeArm: (bytes) => withResponse((b) => bridge.writeArm(b), bytes),
    onNotify(cb) {
      notifyCb = cb;
    },
    onDisconnect(cb) {
      discCb = cb;
    },
    /** Simulates the radio link dropping (out of range): the bridge holds, the app sees a disconnect. */
    dropLink() {
      if (!up) return;
      close();
      if (discCb) discCb();
    },
  };
}
