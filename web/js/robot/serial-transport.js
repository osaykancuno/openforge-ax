// Web Serial adapter for the STS bus (Chrome, Edge, Opera on desktop). Same interface as the virtual arm's transport.
// USB bridge chips used by SO-101 bus boards: WCH CH340/CH343 (most common), FTDI, Silicon Labs CP210x.
const FILTERS = [{ usbVendorId: 0x1a86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x10c4 }];
export const BAUD = 1_000_000;

export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

/** A port this site was already allowed to use (no picker), if any: only from a known USB bridge (FILTERS), never an arbitrary device. */
export async function rememberedPort() {
  const ports = (await navigator.serial.getPorts()).filter((p) => FILTERS.some((f) => f.usbVendorId === p.getInfo?.().usbVendorId));
  return ports.length === 1 ? ports[0] : null;
}

export async function pickPort({ all = false } = {}) {
  return navigator.serial.requestPort(all ? {} : { filters: FILTERS });
}

export async function openTransport(port, onLost = () => {}) {
  await port.open({ baudRate: BAUD, bufferSize: 4096 });
  let listener = () => {};
  let reader = null;
  let closed = false;
  const writer = port.writable.getWriter();
  (async () => {
    while (!closed && port.readable) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) listener(value);
        }
      } catch {
        if (!closed) onLost();
        break;
      } finally {
        reader.releaseLock();
      }
    }
  })();
  return {
    write: (bytes) => writer.write(bytes),
    onData: (cb) => (listener = cb),
    async close() {
      closed = true;
      await reader?.cancel().catch(() => {});
      writer.releaseLock();
      await port.close().catch(() => {});
    },
  };
}
