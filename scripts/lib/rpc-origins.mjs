// The RPC origins the site reads the chain from, as web/js/chain.js rpcUrls() picks them: deployment.json's rpcUrl when
// it has one, else config.js's default plus its Ethereum-mainnet fallbacks. The AR page's CSP lists exactly these
// (scripts/build-web.mjs, and scripts/prepare-site.mjs when it swaps the local demo's config for the public one).
// https only; loopback only for the local demo. Pure: the caller reads the files.

/**
 * @param {{ configJs: string, deployment?: { rpcUrl?: string, chainId?: number } | null, localDemo?: boolean }} o
 * @returns {string[]} unique origins, in the order the site tries them
 */
export function rpcOrigins({ configJs, deployment = null, localDemo = false }) {
  let rpcs = deployment?.rpcUrl ? [deployment.rpcUrl] : [];
  if (!rpcs.length) {
    rpcs = [(configJs.match(/rpcUrl:\s*"([^"]+)"/) || [])[1] || ""];
    const chainId = deployment?.chainId ?? Number((configJs.match(/chainId:\s*(\d+)/) || [])[1]);
    if (chainId === 1) rpcs.push(...[...((configJs.match(/rpcFallbacks:\s*\[([^\]]*)\]/) || [])[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  }
  const origins = rpcs.flatMap((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "https:" || (localDemo && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) ? [u.origin] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(origins)];
}

/** The AR page's connect-src for those origins. */
export const arConnectSrc = (origins) => `connect-src 'self'${origins.length ? ` ${origins.join(" ")}` : ""}`;
