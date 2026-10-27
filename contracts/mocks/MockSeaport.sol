// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @dev LOCAL TEST/DEMO ONLY. Settles a fixed-price ETH sale the way Seaport does and emits Seaport's exact
///      OrderFulfilled event, so the site's Market page reads local sales with the same code as mainnet ones.
///      The seller must approve this contract first. Royalty and marketplace fee are paid out as on OpenSea.
contract MockSeaport {
    struct SpentItem {
        uint8 itemType;
        address token;
        uint256 identifier;
        uint256 amount;
    }

    struct ReceivedItem {
        uint8 itemType;
        address token;
        uint256 identifier;
        uint256 amount;
        address payable recipient;
    }

    event OrderFulfilled(
        bytes32 orderHash,
        address indexed offerer,
        address indexed zone,
        address recipient,
        SpentItem[] offer,
        ReceivedItem[] consideration
    );

    error WrongPayment();

    uint256 public nonce;

    /// @notice The buyer pays `msg.value`; the seller gets it minus the royalty and the marketplace fee.
    function buy(address nft, uint256 id, address payable royaltyTo, uint256 royalty, address payable feeTo, uint256 fee)
        external
        payable
    {
        if (royalty + fee > msg.value) revert WrongPayment();
        address payable seller = payable(IERC721(nft).ownerOf(id));
        IERC721(nft).transferFrom(seller, msg.sender, id);

        SpentItem[] memory offer = new SpentItem[](1);
        offer[0] = SpentItem(2, nft, id, 1); // 2 = ERC721
        ReceivedItem[] memory consideration = new ReceivedItem[](3);
        consideration[0] = ReceivedItem(0, address(0), 0, msg.value - royalty - fee, seller); // 0 = native ETH
        consideration[1] = ReceivedItem(0, address(0), 0, royalty, royaltyTo);
        consideration[2] = ReceivedItem(0, address(0), 0, fee, feeTo);
        for (uint256 i; i < 3; i++) {
            if (consideration[i].amount > 0) {
                (bool ok,) = consideration[i].recipient.call{value: consideration[i].amount}("");
                if (!ok) revert WrongPayment();
            }
        }
        emit OrderFulfilled(keccak256(abi.encode(nft, id, nonce++)), seller, address(0), msg.sender, offer, consideration);
    }
}
