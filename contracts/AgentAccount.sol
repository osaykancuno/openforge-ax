// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC6551Account, IERC6551Executable} from "./interfaces/IERC6551.sol";

interface INonceSource {
    function transferNonce(uint256 tokenId) external view returns (uint256);
}

/// @title AgentAccount
/// @notice ERC-6551 agent wallet of an OpenForge Agent, with an autonomy policy engine.
///
/// Autonomy modes (whitepaper 3.3):
///   L1 Manual: the operator (agent runtime key) can only PROPOSE; the holder approves each call.
///   L2 Assisted: the operator executes alone, only on exact (target, selector) pairs the holder allowed, within a
///      per-period ETH cap. The ARGUMENTS are the operator's: allow only functions that cannot send value elsewhere.
///   L3 Autonomous: FULL TRUST. The operator may call any contract. The cap covers ETH only, so through DeFi,
///      routers, vaults or Permit2 an L3 operator CAN move the agent's tokens and NFTs. Use only with an operator
///      you trust like yourself. The holder keeps an emergency pause and can revoke at any time.
///
/// Guarantees (all levels):
///   - The holder (NFT owner) can always execute, except during a sale lock (it binds the WALLET, whoever holds it).
///   - The operator can never call the common asset-moving functions directly (see _isAssetMove, a denylist:
///     defence in depth, not a security boundary for L3), never call this account, and never control another
///     agent account owned by this one (nested ERC-6551 accounts).
///   - Each policy is bound to the holder who set it: on NFT transfer the previous policy
///     (operator, whitelist, proposals) lapses automatically (epoch).
///   - lock(): the holder freezes the WALLET (execution, proposals, approvals and signatures) for up to 30 days. The
///     lock follows the wallet, not the person: after a transfer it still binds every holder (the seller, a second
///     address, the buyer) until it expires. Nobody can shorten or cancel it; any holder may extend it. It does NOT
///     revoke approvals the account granted earlier: a seller must revoke them before listing.
///   - isValidSignature validates the raw hash against the holder's key without binding it to this account (same
///     as the ERC-6551 reference). A signature the holder's EOA made for another purpose (e.g. a Permit2-style
///     message whose "owner" field is checked against ecrecover) can be replayed with owner = this account if the
///     account approved that protocol. Do not approve Permit2-like spenders from the account unless you accept it.
///   - CALL only, no delegatecall. No ownership cycles (the account cannot own its own NFT).
contract AgentAccount is
    IERC6551Account,
    IERC6551Executable,
    IERC1271,
    IERC721Receiver,
    IERC1155Receiver,
    ReentrancyGuard
{
    uint8 public constant OP_CALL = 0;
    uint64 public constant MAX_LOCK = 30 days;
    uint256 public constant MAX_OPEN_PROPOSALS = 50;

    // --- ERC-6551 state ---
    uint256 public state;

    // --- policy ---
    address public operator;
    address public configuredFor; // holder the policy is valid for
    uint256 public configuredNonce; // NFT transferNonce at configuration time
    address public lockOwner; // who last set or extended the lock (informational: the lock binds the wallet)
    uint8 private _level; // 1..3 (0 = never configured -> L1)
    bool public paused; // emergency pause
    uint64 public lockedUntil;
    uint256 public policyEpoch;

    uint128 public periodLimit; // wei per period
    uint64 public periodLength;
    uint64 public periodStart;
    uint128 public spentInPeriod;

    mapping(uint256 epoch => mapping(address target => mapping(bytes4 selector => bool))) private _allowed;

    struct Proposal {
        address to;
        uint96 epoch;
        uint256 value;
        bytes data;
        bool done;
    }

    Proposal[] private _proposals;
    mapping(uint256 epoch => uint256) private _openProposals;

    // --- events / errors ---
    event PolicyConfigured(address indexed owner, address indexed operator, uint8 level, uint128 periodLimit, uint64 periodLength);
    event PermissionSet(address indexed target, bytes4 indexed selector, bool allowed);
    event Paused(bool paused);
    event Locked(uint64 until);
    event OperatorExecuted(address indexed to, uint256 value, bytes4 selector);
    event Proposed(uint256 indexed id, address indexed to, uint256 value, bytes data);
    event ProposalApproved(uint256 indexed id);
    event ProposalRejected(uint256 indexed id);

    error NotOwner();
    error NotOperator();
    error NotAuthorized();
    error UnsupportedOperation();
    error AccountLocked();
    error InvalidLevel();
    error InvalidParams();
    error OperatorInactive();
    error TargetNotAllowed(address target, bytes4 selector);
    error SpendLimitExceeded();
    error ProposalInvalid();
    error CallFailed(bytes reason);
    error OwnershipCycle();
    error AssetMoveForbidden(bytes4 selector);
    error NestedAccountForbidden(address target);
    error TooManyProposals();

    modifier onlyOwner() {
        if (msg.sender != owner()) revert NotOwner();
        _;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ ERC-6551

    function token() public view returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        bytes memory footer = new bytes(0x60);
        assembly {
            extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        address o = IERC721(tokenContract).ownerOf(tokenId);
        if (o == address(this)) return address(0);
        return o;
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        return _isValidSigner(signer) ? IERC6551Account.isValidSigner.selector : bytes4(0);
    }

    /// @dev Raw-hash check against the holder's key, as in the ERC-6551 reference: the hash is not bound to this
    ///      account. See the class note on replay of signatures the holder's EOA made elsewhere.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        // Only the holder signs off-chain (Seaport, permit...). The operator must NOT sign arbitrary hashes:
        // a signature would bypass the whitelist and spend cap.
        if (_isLocked()) return bytes4(0xffffffff);
        address o = owner();
        if (o != address(0) && SignatureChecker.isValidSignatureNow(o, hash, signature)) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0xffffffff);
    }

    // ------------------------------------------------------------------ policy (holder only)

    /// @notice Sets operator, level and spend cap. A new holder starts from a clean whitelist and proposals.
    function configure(address operator_, uint8 level, uint128 limit, uint64 periodLen) external onlyOwner {
        if (level < 1 || level > 3) revert InvalidLevel();
        if (operator_ == address(0) || operator_ == address(this) || periodLen < 1 hours) revert InvalidParams();
        if (!_policyValid()) paused = false;
        // every configure() starts from an empty whitelist (new epoch): no leftover permissions
        unchecked {
            ++policyEpoch;
        }
        configuredFor = msg.sender;
        configuredNonce = _transferNonce();
        operator = operator_;
        _level = level;
        periodLimit = limit;
        periodLength = periodLen;
        periodStart = uint64(block.timestamp);
        spentInPeriod = 0;
        _bump();
        emit PolicyConfigured(msg.sender, operator_, level, limit, periodLen);
    }

    /// @dev exact (target, selector) pairs only: there is no wildcard.
    function setPermission(address target, bytes4 selector, bool ok) external onlyOwner {
        if (!_policyValid()) revert OperatorInactive(); // configure first
        if (target == address(0) || target == address(this)) revert InvalidParams();
        _allowed[policyEpoch][target][selector] = ok;
        _bump();
        emit PermissionSet(target, selector, ok);
    }

    /// @notice Emergency pause: blocks all operator actions (the operator never signs for the account anyway).
    function setPaused(bool p) external onlyOwner {
        paused = p;
        _bump();
        emit Paused(p);
    }

    /// @notice Sale lock: freezes the WALLET (execution, proposals, approvals and signatures) until `until` (max 30
    ///         days from now). It binds every holder until it expires, the seller after a transfer, a second address
    ///         and the buyer alike. Extend-only: while locked, `until` must be later than the current `lockedUntil`,
    ///         so nobody (including a new holder) can shorten or cancel it; a new holder may extend it.
    function lock(uint64 until) external onlyOwner {
        if (until <= block.timestamp || until > block.timestamp + MAX_LOCK) revert InvalidParams();
        if (block.timestamp < lockedUntil && until <= lockedUntil) revert InvalidParams();
        lockedUntil = until;
        lockOwner = msg.sender;
        _bump();
        emit Locked(until);
    }

    function revokeOperator() external onlyOwner {
        operator = address(0);
        unchecked {
            ++policyEpoch;
        }
        _bump();
        emit PolicyConfigured(msg.sender, address(0), 0, 0, 0);
    }

    // ------------------------------------------------------------------ levels

    /// @notice Effective level (1 if the policy is not valid for the current holder, or if there is no operator).
    function autonomyLevel() public view returns (uint8) {
        if (_level == 0 || operator == address(0) || !_policyValid()) return 1; // no operator (revoked or never set): Manual
        return _level;
    }

    /// @dev the policy holds only for the holder who set it and only if the NFT has not been transferred since
    ///      (A -> B -> A also resets it).
    function _policyValid() internal view returns (bool) {
        address o = owner();
        return o != address(0) && configuredFor == o && configuredNonce == _transferNonce();
    }

    function _transferNonce() internal view returns (uint256) {
        (, address tokenContract, uint256 tokenId) = token();
        return INonceSource(tokenContract).transferNonce(tokenId);
    }

    /// @dev the lock binds the wallet, not a person: it holds for every holder (seller, second address, buyer, and
    ///      A -> B -> A) until `lockedUntil`. The buyer of a locked agent waits for expiry (30 days at most).
    function _isLocked() internal view returns (bool) {
        return block.timestamp < lockedUntil;
    }

    /// @dev selectors that move or grant assets directly (ERC20/721/1155, permits, Permit2, ERC-777/1363, ownership,
    ///      nested ERC-6551 execute): forbidden to the operator at every level. A denylist cannot be complete
    ///      (see the L3 note above); it removes the obvious paths.
    function _isAssetMove(bytes4 s) internal pure returns (bool) {
        return s == 0x095ea7b3 // approve
            || s == 0xa9059cbb // transfer
            || s == 0x23b872dd // transferFrom
            || s == 0x42842e0e // safeTransferFrom(address,address,uint256)
            || s == 0xb88d4fde // safeTransferFrom(address,address,uint256,bytes)
            || s == 0xa22cb465 // setApprovalForAll
            || s == 0x39509351 // increaseAllowance
            || s == 0xd505accf // permit
            || s == 0xf242432a // ERC1155 safeTransferFrom
            || s == 0x2eb2c2d6 // ERC1155 safeBatchTransferFrom
            || s == 0xe3ee160e // transferWithAuthorization (EIP-3009)
            || s == 0x87517c45 // Permit2 approve
            || s == 0x2b67b570 // Permit2 permit (single)
            || s == 0x2a2d80d1 // Permit2 permit (batch)
            || s == 0x8fcbaf0c // DAI-style permit
            || s == 0x4000aea0 // transferAndCall(address,uint256,bytes) (ERC-1363 / ERC-677)
            || s == 0x1296ee62 // transferAndCall(address,uint256)
            || s == 0xc1d34b89 // transferFromAndCall
            || s == 0xcae9ca51 // approveAndCall
            || s == 0x9bd9bbc6 // ERC-777 send
            || s == 0x62ad1b83 // ERC-777 operatorSend
            || s == 0x959b8c3f // ERC-777 authorizeOperator
            || s == 0x8fcb4e5b // stETH transferShares
            || s == 0x8b72a2ec // CryptoPunks transferPunk
            || s == 0xf2fde38b // transferOwnership
            || s == 0x2f2ff15d // grantRole
            || s == 0x51945447; // ERC-6551 execute (another account)
    }

    /// @dev true if `target` is an ERC-6551 account whose NFT this account owns: its owner() is this account,
    ///      so an operator call would bypass the child's own policy, cap and lock.
    function _isOwnedAccount(address target) internal view returns (bool) {
        if (target.code.length == 0) return false;
        (bool ok, bytes memory ret) = target.staticcall{gas: 30_000}(abi.encodeCall(IERC6551Account.token, ()));
        if (!ok || ret.length != 96) return false;
        (uint256 chainId, address tokenContract, uint256 tokenId) = abi.decode(ret, (uint256, address, uint256));
        if (chainId != block.chainid || tokenContract.code.length == 0) return false;
        (ok, ret) = tokenContract.staticcall{gas: 50_000}(abi.encodeCall(IERC721.ownerOf, (tokenId)));
        return ok && ret.length == 32 && abi.decode(ret, (address)) == address(this);
    }

    function isAllowed(address target, bytes4 selector) public view returns (bool) {
        return _allowed[policyEpoch][target][selector];
    }

    // ------------------------------------------------------------------ execution

    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        nonReentrant
        returns (bytes memory result)
    {
        if (operation != OP_CALL) revert UnsupportedOperation();
        if (_isLocked()) revert AccountLocked();

        if (msg.sender != owner()) {
            if (!_operatorActive(2) || msg.sender != operator) revert NotAuthorized();
            if (to == address(this)) revert InvalidParams();
            if (data.length != 0 && data.length < 4) revert InvalidParams();
            bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
            if (_isAssetMove(sel)) revert AssetMoveForbidden(sel);
            if (_isOwnedAccount(to)) revert NestedAccountForbidden(to);
            if (autonomyLevel() == 2 && !isAllowed(to, sel)) revert TargetNotAllowed(to, sel);
            _spend(value);
            emit OperatorExecuted(to, value, sel);
        }

        _bump();
        result = _call(to, value, data);
    }

    /// @notice L1: the operator proposes an action; the holder approves it via `approve`.
    function propose(address to, uint256 value, bytes calldata data) external returns (uint256 id) {
        if (!_operatorActive(1) || msg.sender != operator) revert NotOperator();
        if (to == address(this)) revert InvalidParams();
        if (_isLocked()) revert AccountLocked();
        if (_openProposals[policyEpoch] >= MAX_OPEN_PROPOSALS) revert TooManyProposals();
        unchecked {
            ++_openProposals[policyEpoch];
        }
        id = _proposals.length;
        _proposals.push(Proposal({to: to, epoch: uint96(policyEpoch), value: value, data: data, done: false}));
        emit Proposed(id, to, value, data);
    }

    function approve(uint256 id) external onlyOwner nonReentrant returns (bytes memory) {
        if (_isLocked()) revert AccountLocked();
        Proposal storage p = _proposals[id];
        if (p.done || p.epoch != policyEpoch || !_policyValid()) revert ProposalInvalid();
        p.done = true;
        _closeProposal(p.epoch);
        _bump();
        emit ProposalApproved(id);
        return _call(p.to, p.value, p.data);
    }

    function reject(uint256 id) external onlyOwner {
        Proposal storage p = _proposals[id];
        if (p.done) revert ProposalInvalid();
        p.done = true;
        _closeProposal(p.epoch);
        emit ProposalRejected(id);
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    function proposalAt(uint256 id) external view returns (address to, uint256 value, bytes memory data, bool done, bool valid) {
        Proposal storage p = _proposals[id];
        return (p.to, p.value, p.data, p.done, !p.done && p.epoch == policyEpoch && _policyValid());
    }

    function _closeProposal(uint256 epoch) private {
        if (_openProposals[epoch] > 0) {
            unchecked {
                --_openProposals[epoch];
            }
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev only the holder: the operator is policy-limited, and protocols read "valid signer" as full authority.
    function _isValidSigner(address signer) internal view returns (bool) {
        return !_isLocked() && signer != address(0) && signer == owner();
    }

    /// @dev operator is active with level >= minLevel (L1 only needs to propose).
    function _operatorActive(uint8 minLevel) internal view returns (bool) {
        if (operator == address(0) || paused) return false;
        if (!_policyValid()) return false;
        return _level >= minLevel;
    }

    /// @dev fixed window: up to 2x the limit can be spent across a window boundary (documented in the UI).
    function _spend(uint256 value) internal {
        if (value == 0) return;
        if (block.timestamp >= uint256(periodStart) + periodLength) {
            periodStart = uint64(block.timestamp);
            spentInPeriod = 0;
        }
        uint256 total = uint256(spentInPeriod) + value;
        if (total > periodLimit) revert SpendLimitExceeded();
        spentInPeriod = uint128(total);
    }

    function _call(address to, uint256 value, bytes memory data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);
    }

    function _bump() internal {
        state = uint256(keccak256(abi.encode(state, msg.data)));
    }

    // ------------------------------------------------------------------ asset receiving

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external view returns (bytes4) {
        (uint256 chainId, address tokenContract, uint256 ownTokenId) = token();
        if (chainId == block.chainid && msg.sender == tokenContract && tokenId == ownTokenId) revert OwnershipCycle();
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(IERC165).interfaceId || id == type(IERC6551Account).interfaceId
            || id == type(IERC6551Executable).interfaceId || id == type(IERC1155Receiver).interfaceId
            || id == type(IERC721Receiver).interfaceId || id == type(IERC1271).interfaceId;
    }
}
