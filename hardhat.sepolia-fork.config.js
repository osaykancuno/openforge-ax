// Sepolia fork: rehearses the launch against the real SeaDrop and ERC-6551 registry, with no funds.
//   npm run rehearsal:fork
const base = require("./hardhat.config");

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      chainId: 11155111,
      forking: { url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
    },
  },
  mocha: { timeout: 300_000 },
};
