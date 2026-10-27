require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { PRIVATE_KEY, SEPOLIA_PRIVATE_KEY, MAINNET_RPC_URL, SEPOLIA_RPC_URL, ETHERSCAN_API_KEY } = process.env;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];
// a separate test-only key for Sepolia, so the mainnet deploy key is never used for rehearsals
const sepoliaAccounts = SEPOLIA_PRIVATE_KEY ? [SEPOLIA_PRIVATE_KEY] : []; // never falls back to the mainnet key

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },    // public RPCs by default (no account needed); set your own provider URL in .env for reliability
    // Sepolia's base fee is near zero; Hardhat's default tip would waste test ETH, so use a fixed 0.1 gwei
    sepolia: { url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", accounts: sepoliaAccounts, gasPrice: Number(process.env.SEPOLIA_GAS_PRICE_WEI || 100_000_000) },
    mainnet: { url: MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com", accounts },
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
};
