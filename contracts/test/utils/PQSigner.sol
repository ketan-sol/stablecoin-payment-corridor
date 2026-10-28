// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PQAccount} from "../../src/PQAccount.sol";

/// Off-chain side of PQAccount, for tests: keys from a secret, the Merkle tree, and signing. The backend's signer
/// must produce exactly these bytes.
library PQSigner {
    struct Key {
        bytes32 secret;
        bytes32 seed;
        uint256 height;
    }

    function secretChain(Key memory k, uint256 leaf, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode(k.secret, leaf, i));
    }

    /// Steps [from, to) of chain `i` of `leaf`, the same hash as PQAccount._chain.
    function chain(Key memory k, bytes32 x, uint256 leaf, uint256 i, uint256 from, uint256 to)
        internal
        pure
        returns (bytes32)
    {
        for (uint256 j = from; j < to; j++) {
            x = keccak256(abi.encode(k.seed, (leaf << 16) | (i << 8) | j, x));
        }
        return x;
    }

    function digits(bytes32 m) internal pure returns (uint256[67] memory d) {
        uint256 checksum;
        for (uint256 i; i < 64; i++) {
            d[i] = (uint256(m) >> (252 - 4 * i)) & 15;
            checksum += 15 - d[i];
        }
        for (uint256 i; i < 3; i++) {
            d[64 + i] = (checksum >> (8 - 4 * i)) & 15;
        }
    }

    function leafHash(Key memory k, uint256 leaf) internal pure returns (bytes32) {
        bytes32[67] memory pk;
        for (uint256 i; i < 67; i++) {
            pk[i] = chain(k, secretChain(k, leaf, i), leaf, i, 0, 15);
        }
        return keccak256(abi.encodePacked(pk));
    }

    /// Every level of the tree, leaves first.
    function tree(Key memory k) internal pure returns (bytes32[][] memory levels) {
        levels = new bytes32[][](k.height + 1);
        levels[0] = new bytes32[](1 << k.height);
        for (uint256 i; i < levels[0].length; i++) {
            levels[0][i] = leafHash(k, i);
        }
        for (uint256 l = 1; l <= k.height; l++) {
            levels[l] = new bytes32[](levels[l - 1].length / 2);
            for (uint256 i; i < levels[l].length; i++) {
                levels[l][i] = keccak256(abi.encode(levels[l - 1][2 * i], levels[l - 1][2 * i + 1]));
            }
        }
    }

    function root(Key memory k) internal pure returns (bytes32) {
        return tree(k)[k.height][0];
    }

    function sign(Key memory k, bytes32[][] memory levels, uint256 leaf, bytes32 m)
        internal
        pure
        returns (PQAccount.Signature memory sig)
    {
        sig.leaf = leaf;
        uint256[67] memory d = digits(m);
        for (uint256 i; i < 67; i++) {
            sig.wots[i] = chain(k, secretChain(k, leaf, i), leaf, i, 0, d[i]);
        }
        sig.path = new bytes32[](k.height);
        for (uint256 l; l < k.height; l++) {
            sig.path[l] = levels[l][(leaf >> l) ^ 1];
        }
    }
}
