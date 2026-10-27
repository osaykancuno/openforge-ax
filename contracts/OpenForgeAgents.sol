// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC6551Registry} from "./interfaces/IERC6551.sol";
import {INonFungibleSeaDropToken} from "./seadrop/INonFungibleSeaDropToken.sol";
import {ISeaDropTokenContractMetadata} from "./seadrop/ISeaDropTokenContractMetadata.sol";
import {ISeaDrop} from "./seadrop/ISeaDrop.sol";
import {
    AllowListData,
    PublicDrop,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "./seadrop/SeaDropStructs.sol";

interface IAgentRenderer {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    function locked() external view returns (bool);
    function agents() external view returns (address);
}

interface IAgentAccountToken {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
}

/// @title OpenForge Agents (AX)
/// @notice ERC-721 collection where each token is an embodied agent with an ERC-6551 agent wallet.
///  - Minted on OpenSea via SeaDrop (pricing, stages and allowlists are managed in OpenSea Studio).
///  - The agent wallet is created at mint time, with no extra step for the user.
///  - Traits are derived on-chain from a future block's RANDAO (commit -> reveal) after the sale.
///  - Dynamic metadata comes from an on-chain renderer that can be swapped until freeze.
contract OpenForgeAgents is ERC721, Ownable2Step, ReentrancyGuard, INonFungibleSeaDropToken {
    // ---------------------------------------------------------------- immutables
    uint256 public immutable MAX_SUPPLY_CAP;
    uint256 public immutable TEAM_RESERVE;
    IERC6551Registry public immutable registry;
    address public immutable accountImplementation;
    bytes32 public constant ACCOUNT_SALT = bytes32(0);

    // ---------------------------------------------------------------- state
    uint256 public totalSupply;
    uint256 public reserveMinted;
    uint256 private _maxTotal; // total supply incl. reserve; can only decrease
    mapping(address => uint256) public numberMinted; // SeaDrop mints per wallet

    mapping(address => bool) private _allowedSeaDrop;
    mapping(address => bool) private _initialSeaDrop; // the allowed set can only shrink: no owner-added minters
    address[] private _enumeratedAllowedSeaDrop;
    uint96 public constant MAX_ROYALTY_BPS = 1000;
    uint256 public constant MIN_SALE_WINDOW = 1 days;
    uint256 public constant MAX_DEADLINE_EXTENSION = 90 days; // over the constructor's deadline, in total
    uint64 public immutable LATEST_REVEAL_DEADLINE;

    mapping(uint256 tokenId => uint256) public transferNonce;

    address public renderer;
    address public reputation;
    string private _baseURIValue;
    string private _contractURIValue;
    bytes32 private _provenanceHash;
    bool public metadataFrozen;

    RoyaltyInfo private _royalty;

    bytes32 public seed;
    uint64 public revealBlock;
    uint64 public revealDeadline;

    // ---------------------------------------------------------------- events / errors
    event SeedCommitted(uint256 revealBlock);
    event RevealDeadlineExtended(uint64 revealDeadline);
    event SeedRevealed(bytes32 seed);
    event MetadataFrozen();
    event RendererSet(address renderer);
    event ReputationSet(address reputation);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906

    error SoldOut();
    error ReserveExceeded();
    error MintClosed();
    error NotRevealable();
    error AlreadyRevealed();
    error RevealExpired();
    error MetadataIsFrozen();
    error OwnershipCycle();
    error NotAuthorized();
    error InvalidParams();
    error UnsafeString();

    constructor(
        address initialOwner,
        address royaltyReceiver,
        address registry_,
        address accountImplementation_,
        uint256 maxSupply_,
        uint256 teamReserve_,
        uint64 revealDeadline_,
        uint96 royaltyBps,
        address[] memory allowedSeaDrop
    ) ERC721("OpenForge Agents", "AX") Ownable(initialOwner) {
        // <= 1024 keeps callsigns unique (32x32 permutation in the renderer)
        if (maxSupply_ == 0 || maxSupply_ > 1024 || teamReserve_ > maxSupply_) revert InvalidParams();
        if (royaltyReceiver == address(0)) revert InvalidParams();
        if (registry_.code.length == 0 || accountImplementation_.code.length == 0) revert InvalidParams();
        // anyone may commit the reveal after the deadline, which closes minting for good
        if (revealDeadline_ < block.timestamp + MIN_SALE_WINDOW) revert InvalidParams();
        MAX_SUPPLY_CAP = maxSupply_;
        _maxTotal = maxSupply_;
        TEAM_RESERVE = teamReserve_;
        registry = IERC6551Registry(registry_);
        accountImplementation = accountImplementation_;
        revealDeadline = revealDeadline_;
        LATEST_REVEAL_DEADLINE = uint64(revealDeadline_ + MAX_DEADLINE_EXTENSION);
        if (royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyaltyBasisPoints(royaltyBps);
        _royalty = RoyaltyInfo(royaltyReceiver, royaltyBps);
        for (uint256 i = 0; i < allowedSeaDrop.length; i++) {
            if (allowedSeaDrop[i].code.length == 0) revert InvalidParams();
            _allowedSeaDrop[allowedSeaDrop[i]] = true;
            _initialSeaDrop[allowedSeaDrop[i]] = true;
        }
        _enumeratedAllowedSeaDrop = allowedSeaDrop;
    }

    // ================================================================ MINT (SeaDrop)

    function mintSeaDrop(address minter, uint256 quantity) external override nonReentrant {
        if (!_allowedSeaDrop[msg.sender]) revert OnlyAllowedSeaDrop();
        if (revealBlock != 0) revert MintClosed();
        if (totalSupply + quantity > maxSupply()) revert SoldOut();
        numberMinted[minter] += quantity; // updated before minting (see SeaDrop note)
        _mintBatch(minter, quantity);
    }

    /// @notice Reserved mint (team, community, robot builders). Capped by TEAM_RESERVE.
    function reserveMint(address to, uint256 qty) external onlyOwner nonReentrant {
        if (revealBlock != 0) revert MintClosed();
        if (reserveMinted + qty > TEAM_RESERVE || totalSupply + qty > _maxTotal) revert ReserveExceeded();
        reserveMinted += qty;
        _mintBatch(to, qty);
    }

    /// @dev Mints and immediately creates each agent's ERC-6551 wallet.
    function _mintBatch(address to, uint256 qty) private {
        uint256 id = totalSupply;
        for (uint256 i = 0; i < qty; i++) {
            if (to == accountOf(id + 1)) revert OwnershipCycle(); // an NFT owned by its own wallet is lost forever
            _mint(to, ++id);
            registry.createAccount(accountImplementation, ACCOUNT_SALT, block.chainid, address(this), id);
            _checkNoCycle(to, id); // agent `id` must not end up owned (through nested wallets) by its own wallet
        }
        totalSupply = id;
    }

    function getMintStats(address minter)
        external
        view
        override
        returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply_)
    {
        return (numberMinted[minter], totalSupply, maxSupply());
    }

    /// @notice Supply mintable via SeaDrop: total minus the unminted reserve.
    function maxSupply() public view override returns (uint256) {
        return _maxTotal - (TEAM_RESERVE - reserveMinted);
    }

    // ================================================================ TBA

    function accountOf(uint256 tokenId) public view returns (address) {
        return registry.account(accountImplementation, ACCOUNT_SALT, block.chainid, address(this), tokenId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) {
            // a self-transfer is not a change of holder: it must not reset the operator policy
            if (from != to) transferNonce[tokenId]++;
            if (to == accountOf(tokenId)) revert OwnershipCycle();
            _checkNoCycle(to, tokenId);
        }
    }

    /// @dev walks the wallet -> NFT -> wallet chain (max 8 hops) and rejects ownership cycles.
    function _checkNoCycle(address holder, uint256 tokenId) private view {
        for (uint256 i = 0; i < 8; i++) {
            if (holder.code.length == 0) return;
            (bool ok, bytes memory ret) = holder.staticcall{gas: 30_000}(abi.encodeCall(IAgentAccountToken.token, ()));
            if (!ok || ret.length != 96) return;
            (, address tc, uint256 tid) = abi.decode(ret, (uint256, address, uint256));
            if (tc != address(this)) return;
            if (tid == tokenId) revert OwnershipCycle();
            holder = _ownerOf(tid);
        }
        revert OwnershipCycle();
    }

    // ================================================================ REVEAL

    /// @notice Step 1 (anyone): at sold out or after `revealDeadline`, closes minting and fixes a future block.
    ///         If the reveal missed its block, anyone may commit again.
    function commitReveal() external {
        if (seed != bytes32(0)) revert AlreadyRevealed();
        if (revealBlock != 0 && block.number <= uint256(revealBlock) + 1) revert NotRevealable();
        if (totalSupply < _maxTotal && block.timestamp < revealDeadline) revert NotRevealable();
        revealBlock = uint64(block.number + 5);
        emit SeedCommitted(revealBlock);
    }

    /// @notice If the sale slips (OpenSea setup, stages), the owner can move the deadline later, never earlier,
    ///         only while minting is open, and at most to LATEST_REVEAL_DEADLINE (so the reveal cannot be stalled).
    function extendRevealDeadline(uint64 newDeadline) external onlyOwner {
        if (revealBlock != 0) revert MintClosed();
        if (newDeadline <= revealDeadline || newDeadline > LATEST_REVEAL_DEADLINE) revert InvalidParams();
        revealDeadline = newDeadline;
        emit RevealDeadlineExtended(newDeadline);
    }

    /// @notice Step 2 (anyone), only in block revealBlock + 1: seed from that block's RANDAO (prevrandao), the
    ///         chain, the supply and this contract. blockhash(revealBlock) is NOT used: a proposer that builds its
    ///         own block could grind it through extraData. One fixed block means the caller cannot pick among
    ///         outcomes by timing. The bias that remains: the proposer of revealBlock can propose or skip it (1 bit),
    ///         and the proposer of revealBlock + 1 can censor the call (forcing a re-commit), so reveal with a high
    ///         priority fee. This is NOT provably fair; for full unbiasability use VRF.
    function revealSeed() external {
        if (seed != bytes32(0)) revert AlreadyRevealed();
        uint256 rb = revealBlock;
        if (rb == 0 || block.number <= rb) revert NotRevealable();
        if (block.number > rb + 1) revert RevealExpired();
        seed = keccak256(abi.encode(block.prevrandao, block.chainid, totalSupply, address(this)));
        emit SeedRevealed(seed);
        if (totalSupply > 0) emit BatchMetadataUpdate(1, totalSupply);
    }

    // ================================================================ METADATA

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return IAgentRenderer(renderer).tokenURI(tokenId);
    }

    function baseURI() external view override returns (string memory) {
        return _baseURIValue;
    }

    function contractURI() external view override returns (string memory) {
        return _contractURIValue;
    }

    function provenanceHash() external view override returns (bytes32) {
        return _provenanceHash;
    }

    function royaltyInfo(uint256, uint256 salePrice) external view override returns (address, uint256) {
        return (_royalty.royaltyAddress, Math.mulDiv(salePrice, _royalty.royaltyBps, 10_000));
    }

    function royaltyAddress() external view override returns (address) {
        return _royalty.royaltyAddress;
    }

    function royaltyBasisPoints() external view override returns (uint256) {
        return _royalty.royaltyBps;
    }

    // ================================================================ ADMIN: metadata (ISeaDropTokenContractMetadata)

    function setBaseURI(string calldata newBaseURI) external override onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        _requireJsonSafe(newBaseURI);
        _baseURIValue = newBaseURI;
        if (totalSupply > 0) emit BatchMetadataUpdate(1, totalSupply);
    }

    function setContractURI(string calldata newContractURI) external override onlyOwner {
        _contractURIValue = newContractURI;
        emit ContractURIUpdated(newContractURI);
    }

    /// @notice Can only lower supply (never below minted + remaining reserve, never back up), and only before reveal.
    function setMaxSupply(uint256 newMaxSupply) external override onlyOwner {
        if (revealBlock != 0) revert MintClosed();
        if (newMaxSupply > _maxTotal) revert CannotExceedMaxSupplyOfUint64(newMaxSupply);
        uint256 floor = totalSupply + (TEAM_RESERVE - reserveMinted);
        if (newMaxSupply < floor) revert NewMaxSupplyCannotBeLessThenTotalMinted(newMaxSupply, floor);
        _maxTotal = newMaxSupply;
        emit MaxSupplyUpdated(maxSupply());
    }

    function setProvenanceHash(bytes32 newProvenanceHash) external override onlyOwner {
        if (totalSupply > 0) revert ProvenanceHashCannotBeSetAfterMintStarted();
        emit ProvenanceHashUpdated(_provenanceHash, newProvenanceHash);
        _provenanceHash = newProvenanceHash;
    }

    function setRoyaltyInfo(RoyaltyInfo calldata newInfo) external override onlyOwner {
        if (newInfo.royaltyAddress == address(0)) revert RoyaltyAddressCannotBeZeroAddress();
        if (newInfo.royaltyBps > MAX_ROYALTY_BPS) revert InvalidRoyaltyBasisPoints(newInfo.royaltyBps);
        _royalty = newInfo;
        emit RoyaltyInfoUpdated(newInfo.royaltyAddress, newInfo.royaltyBps);
    }

    function emitBatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId) external onlyOwner {
        emit BatchMetadataUpdate(fromTokenId, toTokenId);
    }

    function setRenderer(address r) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        if (r.code.length == 0) revert InvalidParams();
        renderer = r;
        emit RendererSet(r);
        if (totalSupply > 0) emit BatchMetadataUpdate(1, totalSupply);
    }

    function setReputation(address rep) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen(); // the reputation feeds the displayed stats
        if (rep.code.length == 0) revert InvalidParams();
        reputation = rep;
        emit ReputationSet(rep);
    }

    /// @notice Permanently freezes the image base URI, the renderer and the reputation source (dynamic attributes
    ///         stay live on-chain). The renderer's own presentation must be locked first (AgentRenderer.lock).
    function freezeMetadata() external onlyOwner {
        if (bytes(_baseURIValue).length == 0 || seed == bytes32(0) || renderer == address(0)) revert InvalidParams();
        if (reputation == address(0)) revert InvalidParams(); // otherwise reputation would be off forever
        if (!IAgentRenderer(renderer).locked() || IAgentRenderer(renderer).agents() != address(this)) revert InvalidParams();
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @notice Called by the reputation registry so OpenSea refreshes the token metadata (ERC-4906).
    function refreshMetadata(uint256 tokenId) external {
        if (msg.sender != reputation && msg.sender != owner()) revert NotAuthorized();
        emit MetadataUpdate(tokenId);
    }

    // ================================================================ ADMIN: SeaDrop (also configurable from OpenSea Studio)

    function updateAllowedSeaDrop(address[] calldata allowedSeaDrop) external override onlyOwner {
        // only a subset of the constructor's list: the owner can disable SeaDrop, never add a minter
        for (uint256 i = 0; i < allowedSeaDrop.length; i++) {
            if (!_initialSeaDrop[allowedSeaDrop[i]]) revert OnlyAllowedSeaDrop();
        }
        for (uint256 i = 0; i < _enumeratedAllowedSeaDrop.length; i++) {
            _allowedSeaDrop[_enumeratedAllowedSeaDrop[i]] = false;
        }
        for (uint256 i = 0; i < allowedSeaDrop.length; i++) {
            _allowedSeaDrop[allowedSeaDrop[i]] = true;
        }
        _enumeratedAllowedSeaDrop = allowedSeaDrop;
        emit AllowedSeaDropUpdated(allowedSeaDrop);
    }

    function updatePublicDrop(address seaDropImpl, PublicDrop calldata publicDrop) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updatePublicDrop(publicDrop);
    }

    function updateAllowList(address seaDropImpl, AllowListData calldata allowListData) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updateAllowList(allowListData);
    }

    function updateTokenGatedDrop(address seaDropImpl, address allowedNftToken, TokenGatedDropStage calldata dropStage)
        external
        override
        onlyOwner
    {
        ISeaDrop(_seaDrop(seaDropImpl)).updateTokenGatedDrop(allowedNftToken, dropStage);
    }

    function updateDropURI(address seaDropImpl, string calldata dropURI) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updateDropURI(dropURI);
    }

    function updateCreatorPayoutAddress(address seaDropImpl, address payoutAddress) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updateCreatorPayoutAddress(payoutAddress);
    }

    function updateAllowedFeeRecipient(address seaDropImpl, address feeRecipient, bool allowed)
        external
        override
        onlyOwner
    {
        ISeaDrop(_seaDrop(seaDropImpl)).updateAllowedFeeRecipient(feeRecipient, allowed);
    }

    function updateSignedMintValidationParams(
        address seaDropImpl,
        address signer,
        SignedMintValidationParams memory signedMintValidationParams
    ) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updateSignedMintValidationParams(signer, signedMintValidationParams);
    }

    function updatePayer(address seaDropImpl, address payer, bool allowed) external override onlyOwner {
        ISeaDrop(_seaDrop(seaDropImpl)).updatePayer(payer, allowed);
    }

    function _seaDrop(address s) private view returns (address) {
        if (!_allowedSeaDrop[s]) revert OnlyAllowedSeaDrop();
        return s;
    }

    // ================================================================ misc

    function _requireJsonSafe(string memory str) private pure {
        bytes memory b = bytes(str);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\" || uint8(c) < 0x20 || uint8(c) == 0x7f) revert UnsafeString();
        }
    }

    function renounceOwnership() public pure override {
        revert InvalidParams(); // prevents an orphaned collection
    }

    /// @notice Recovers ETH sent here by mistake (mint proceeds go straight to the SeaDrop payout address).
    function withdraw(address payable to) external onlyOwner {
        Address.sendValue(to, address(this).balance);
    }

    function supportsInterface(bytes4 id) public view override(ERC721, IERC165) returns (bool) {
        return id == type(INonFungibleSeaDropToken).interfaceId || id == type(IERC2981).interfaceId
            || id == type(ISeaDropTokenContractMetadata).interfaceId || id == bytes4(0x49064906)
            || super.supportsInterface(id);
    }
}
