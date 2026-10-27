// Public RPCs are load-balanced: right after a confirmed tx, another backend may still report the old nonce
// ("nonce too low"). This shim assigns every outgoing transaction's nonce itself: the highest of what the RPC
// reports and what this process has already sent. Sends from one address are serialised, and a failed send
// forgets the local value so a dropped or rejected tx can never leave a gap. Safe to require more than once.
const { network } = require("hardhat");

if (!network.provider.__nonceGuard) {
  const next = new Map(); // lowercase address -> next nonce this process will use
  const queue = new Map(); // lowercase address -> tail of its send chain
  const inner = network.provider.request.bind(network.provider);
  const max = (a, b) => (a > b ? a : b);

  async function send(args) {
    const tx = { ...args.params[0] };
    const from = String(tx.from).toLowerCase();
    const remote = BigInt(await inner({ method: "eth_getTransactionCount", params: [tx.from, "pending"] }));
    const nonce = tx.nonce !== undefined ? BigInt(tx.nonce) : max(remote, next.get(from) ?? 0n);
    tx.nonce = "0x" + nonce.toString(16);
    try {
      const result = await inner({ ...args, params: [tx, ...args.params.slice(1)] });
      next.set(from, max(nonce + 1n, next.get(from) ?? 0n));
      return result;
    } catch (e) {
      next.delete(from); // e.g. "nonce too high" after a dropped tx: fall back to what the network reports
      throw e;
    }
  }

  network.provider.request = async (args) => {
    if (args.method === "eth_sendTransaction" && args.params?.[0]) {
      const from = String(args.params[0].from).toLowerCase();
      const run = (queue.get(from) || Promise.resolve()).then(() => send(args));
      queue.set(from, run.catch(() => {}));
      return run;
    }
    if (args.method === "eth_getTransactionCount") {
      const remote = BigInt(await inner(args));
      return "0x" + max(remote, next.get(String(args.params[0]).toLowerCase()) ?? 0n).toString(16);
    }
    return inner(args);
  };
  // hardhat-ethers calls the legacy send(method, params), which bypasses request(): route it through the guard
  network.provider.send = (method, params) => network.provider.request({ method, params });
  network.provider.__nonceGuard = true;
}
