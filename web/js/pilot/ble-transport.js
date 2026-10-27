// Web Bluetooth transport to the AX-1 ESP32 bridge. Same interface as twin-transport.js.
// Chrome on Android and desktop Chrome/Edge only (no iOS Safari, no Firefox). Pairing (6-digit passkey) is
// triggered by the OS the first time the app touches an encrypted characteristic (AX_STATE notifications).
import { UUID } from "./ax-proto.js";

export const bleSupported = () => typeof navigator !== "undefined" && !!navigator.bluetooth && typeof navigator.bluetooth.requestDevice === "function";

const toBytes = (dv) => new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));

export function createBleTransport() {
  let device = null;
  let ch = null;
  let notifyCb = null;
  let discCb = null;
  let cmdBusy = false;
  let closing = false;
  let chain = Promise.resolve(); // writes with response, one at a time

  const onValue = (e) => notifyCb && notifyCb(toBytes(e.target.value));
  const onGattDisconnected = () => {
    ch = null;
    cmdBusy = false;
    if (!closing && discCb) discCb();
  };

  async function attach() {
    const server = await device.gatt.connect();
    try {
      const svc = await server.getPrimaryService(UUID.SERVICE);
      const get = (u) => svc.getCharacteristic(u);
      const [info, cmd, stop, arm, state] = await Promise.all([get(UUID.INFO), get(UUID.CMD), get(UUID.STOP), get(UUID.ARM), get(UUID.STATE)]);
      state.removeEventListener("characteristicvaluechanged", onValue);
      state.addEventListener("characteristicvaluechanged", onValue);
      await state.startNotifications(); // encrypted: the OS asks for the passkey here on first use
      ch = { info, cmd, stop, arm, state };
    } catch (e) {
      // half-open link (pairing refused, service missing): close it quietly so the bridge's one slot is free
      ch = null;
      closing = true;
      if (device.gatt.connected) device.gatt.disconnect();
      throw e;
    }
  }

  const need = () => {
    if (!ch) throw new Error("not connected");
    return ch;
  };
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  return {
    kind: "ble",
    get name() {
      return device && device.name ? device.name : "AX-1 bridge"; // untrusted: the UI shows it with textContent only
    },
    get connected() {
      return !!ch;
    },
    async connect() {
      closing = false;
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.SERVICE] }] });
      device.removeEventListener("gattserverdisconnected", onGattDisconnected);
      device.addEventListener("gattserverdisconnected", onGattDisconnected);
      await attach();
    },
    /** Reuses the BluetoothDevice the user picked: no new chooser. */
    async reconnect() {
      if (!device) throw new Error("no device");
      closing = false;
      await attach();
    },
    async disconnect() {
      closing = true;
      ch = null;
      if (device && device.gatt.connected) device.gatt.disconnect();
    },
    async readInfo() {
      return toBytes(await need().info.readValue());
    },
    async readState() {
      return toBytes(await need().state.readValue());
    },
    /** Latest wins: if the previous frame is still in the radio queue, this one is dropped (a newer one follows in 33 ms). */
    async sendCmd(bytes) {
      const c = need();
      if (cmdBusy) return;
      cmdBusy = true;
      try {
        await c.cmd.writeValueWithoutResponse(bytes);
      } finally {
        cmdBusy = false;
      }
    },
    writeStop(bytes) {
      return serial(() => need().stop.writeValueWithResponse(bytes));
    },
    writeArm(bytes) {
      return serial(() => need().arm.writeValueWithResponse(bytes));
    },
    onNotify(cb) {
      notifyCb = cb;
    },
    onDisconnect(cb) {
      discCb = cb;
    },
  };
}
