// Site config. Addresses are overridden by /deployment.json (written by the deploy scripts),
// so normally only the OpenSea link needs changing here.
export const CONFIG = {
  chainId: 1,
  chainName: "Ethereum",
  rpcUrl: "https://ethereum-rpc.publicnode.com",
  explorer: "https://etherscan.io",
  openseaDropUrl: "https://opensea.io/collection/openforge-agents/overview",
  openseaItemUrl: (contract, id) => `https://opensea.io/item/ethereum/${contract}/${id}`,
  ipfsGateway: "https://ipfs.io/ipfs/",
  agents: "0x0000000000000000000000000000000000000000",
  renderer: "0x0000000000000000000000000000000000000000",
  reputation: "0x0000000000000000000000000000000000000000",
  // default operator for Assisted/Autonomous modes (OpenForge runtime key)
  defaultOperator: "",
  fromBlock: 0,
  social: { x: "https://x.com/", discord: "https://discord.gg/" },
};
