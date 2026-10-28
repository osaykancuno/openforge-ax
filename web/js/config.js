// Site config. Addresses are overridden by /deployment.json (written by the deploy scripts),
// so normally only the OpenSea link needs changing here.
export const CONFIG = {
  chainId: 1,
  chainName: "Ethereum",
  rpcUrl: "https://ethereum-rpc.publicnode.com",
  // Ethereum mainnet only: free public RPCs tried when the one above is slow or down (first answer wins)
  rpcFallbacks: ["https://eth.drpc.org", "https://1rpc.io/eth"],
  explorer: "https://etherscan.io",
  openseaDropUrl: "https://opensea.io/collection/openforge-agents/overview",
  openseaItemUrl: (contract, id) => `https://opensea.io/item/ethereum/${contract}/${id}`,
  ipfsGateway: "https://ipfs.io/ipfs/",
  agents: "0x0000000000000000000000000000000000000000",
  renderer: "0x0000000000000000000000000000000000000000",
  reputation: "0x0000000000000000000000000000000000000000",
  seaDrop: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5", // OpenSea SeaDrop (same address on Ethereum and Sepolia): mint price and window
  // default operator for Assisted/Autonomous modes (OpenForge runtime key)
  defaultOperator: "",
  fromBlock: 0,
  social: { x: "https://x.com/", discord: "https://discord.gg/" },
};
