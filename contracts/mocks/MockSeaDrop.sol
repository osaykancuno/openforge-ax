// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {
    AllowListData,
    PublicDrop,
    TokenGatedDropStage,
    SignedMintValidationParams
} from "../seadrop/SeaDropStructs.sol";
import {INonFungibleSeaDropToken} from "../seadrop/INonFungibleSeaDropToken.sol";

/// @dev LOCAL TEST/DEMO ONLY. Simulates SeaDrop's public mint path
///      (price, time window, per-wallet limit, supply, OpenSea fee + creator payout).
contract MockSeaDrop {
    mapping(address nft => PublicDrop) public publicDrops;
    mapping(address nft => address) public creatorPayout;
    mapping(address nft => bytes32) public allowListRoot;
    mapping(address nft => mapping(address => bool)) public allowedFeeRecipient;
    mapping(address nft => string) public dropURI;

    error NotActive();
    error WrongPayment();
    error WalletLimit();
    error SupplyExceeded();
    error FeeRecipientNotAllowed();

    function updatePublicDrop(PublicDrop calldata d) external {
        publicDrops[msg.sender] = d;
    }

    /// @dev Same getter as SeaDrop: the site's Market page reads the mint price and window through it.
    function getPublicDrop(address nft) external view returns (PublicDrop memory) {
        return publicDrops[nft];
    }

    function updateAllowList(AllowListData calldata a) external {
        allowListRoot[msg.sender] = a.merkleRoot;
    }

    function updateTokenGatedDrop(address, TokenGatedDropStage calldata) external {}

    function updateDropURI(string calldata u) external {
        dropURI[msg.sender] = u;
    }

    function updateCreatorPayoutAddress(address p) external {
        creatorPayout[msg.sender] = p;
    }

    function updateAllowedFeeRecipient(address r, bool ok) external {
        allowedFeeRecipient[msg.sender][r] = ok;
    }

    function updateSignedMintValidationParams(address, SignedMintValidationParams calldata) external {}

    function updatePayer(address, bool) external {}

    function mintPublic(address nft, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable {
        PublicDrop memory d = publicDrops[nft];
        if (block.timestamp < d.startTime || block.timestamp > d.endTime) revert NotActive();
        if (d.restrictFeeRecipients && !allowedFeeRecipient[nft][feeRecipient]) revert FeeRecipientNotAllowed();
        if (msg.value != uint256(d.mintPrice) * quantity) revert WrongPayment();
        address minter = minterIfNotPayer == address(0) ? msg.sender : minterIfNotPayer;
        (uint256 minted, uint256 supply, uint256 max) = INonFungibleSeaDropToken(nft).getMintStats(minter);
        if (minted + quantity > d.maxTotalMintableByWallet) revert WalletLimit();
        if (supply + quantity > max) revert SupplyExceeded();

        uint256 fee = (msg.value * d.feeBps) / 10_000;
        if (fee > 0) payable(feeRecipient).transfer(fee);
        if (msg.value - fee > 0) payable(creatorPayout[nft]).transfer(msg.value - fee);
        INonFungibleSeaDropToken(nft).mintSeaDrop(minter, quantity);
    }
}
