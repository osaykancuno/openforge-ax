// Neo-Forge wire protocol shared by client and server. Pure, no deps.
export const PROTOCOL = 1;
export const EMOTES = ["wave", "spin", "ping", "gg"];
export const ROOM_CAP = 40;
export const GUEST_CAP = 20; // guests never take more than half a room
export const RESUME_SECONDS = 30;

/** EIP-712 join proof. `nonce` is single-use and issued by the server on this connection. */
export function joinTypedData({ chainId, verifyingContract, tokenId, owner, district, nonce, deadline }) {
  return {
    domain: { name: "OpenForge Neo-Forge", version: "1", chainId, verifyingContract },
    types: {
      WorldJoin: [
        { name: "tokenId", type: "uint256" },
        { name: "owner", type: "address" },
        { name: "district", type: "string" },
        { name: "nonce", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    value: { tokenId, owner, district, nonce, deadline },
  };
}

// positions travel as integer centimeters, yaw as a byte
export const qPos = (v) => Math.round(v * 100);
export const qYaw = (y) => ((Math.round((y / (2 * Math.PI)) * 256) % 256) + 256) % 256;
export const dqYaw = (b) => (b / 256) * 2 * Math.PI;
