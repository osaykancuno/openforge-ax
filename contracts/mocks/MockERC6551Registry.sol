// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {IERC6551Registry} from "../interfaces/IERC6551.sol";

/// @dev TEST ONLY. Replicates the canonical registry layout (ERC-1167 proxy + footer
///      salt/chainId/tokenContract/tokenId) so AgentAccount reads its context the same way.
///      Production uses the already-deployed canonical registry.
contract MockERC6551Registry is IERC6551Registry {
    error InitializationFailed();

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address) {
        bytes memory code = _creationCode(implementation, salt, chainId, tokenContract, tokenId);
        address _account = _computeAddress(salt, chainId, tokenContract, tokenId, code);
        if (_account.code.length != 0) return _account;

        emit ERC6551AccountCreated(_account, implementation, salt, chainId, tokenContract, tokenId);

        bytes32 s = keccak256(abi.encode(salt, chainId, tokenContract, tokenId));
        address deployed;
        assembly {
            deployed := create2(0, add(code, 0x20), mload(code), s)
        }
        if (deployed == address(0)) revert InitializationFailed();
        return deployed;
    }

    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address)
    {
        bytes memory code = _creationCode(implementation, salt, chainId, tokenContract, tokenId);
        return _computeAddress(salt, chainId, tokenContract, tokenId, code);
    }

    function _computeAddress(bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId, bytes memory code)
        private
        view
        returns (address)
    {
        bytes32 s = keccak256(abi.encode(salt, chainId, tokenContract, tokenId));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, keccak256(code))))));
    }

    function _creationCode(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            hex"3d60ad80600a3d3981f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            abi.encode(salt, chainId, tokenContract, tokenId)
        );
    }
}
