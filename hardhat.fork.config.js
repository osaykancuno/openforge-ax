// Mainnet-fork config: runs against the REAL ERC-6551 registry and SeaDrop (local tests use mocks).
//   npm run test:fork
// MAINNET_RPC_URL (archive) + FORK_BLOCK pin the fork for reproducible runs. Without them the public
// non-archive RPC is used at the latest block, which only serves state for ~128 blocks: keep runs short.
const base = require("./hardhat.config");

const { MAINNET_RPC_URL, FORK_BLOCK } = process.env;

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      chainId: 1, // block.chainid must match mainnet: it is part of every agent wallet address
      forking: {
        url: MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
        ...(MAINNET_RPC_URL && FORK_BLOCK ? { blockNumber: Number(FORK_BLOCK) } : {}),
      },
    },
  },
  mocha: { timeout: 300_000 },
};
