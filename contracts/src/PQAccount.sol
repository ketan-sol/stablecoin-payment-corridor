// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title PQAccount
/// @notice A smart account whose only key is post-quantum: Winternitz one-time signatures (w = 16, keccak256) under a
///         Merkle tree of 2^height keys, as in XMSS. Security rests on keccak256 alone, so it works on any EVM chain
///         today, with no precompile.
///         - `execute`: anyone may submit (the submitter only pays gas); the signature authorises the call. Use it to
///           hold Corridor roles: admin, compliance officer, relayer, payout operator, freezer.
///         - `isValidSignature` (ERC-1271): pay through Permit2 and the PaymentRouter from this account.
/// @dev Each leaf signs ONCE; a second signature with the same leaf leaks enough to forge. `execute` burns its leaf
///      on-chain, but an ERC-1271 check is a view and cannot, so the signer must keep state and never reuse a leaf
///      (also after a failed or expired `execute`). Leaves burnt by `execute` are rejected by `isValidSignature`.
contract PQAccount {
    uint256 internal constant DIGITS = 64; // 256-bit message in base 16
    uint256 internal constant CHAINS = 67; // + 3 checksum digits (max checksum 64 * 15 = 960 < 16^3)
    bytes32 internal constant EXECUTE = keccak256("PQAccount.execute");
    bytes32 internal constant ERC1271 = keccak256("PQAccount.erc1271");
    bytes4 internal constant MAGIC = 0x1626ba7e;

    uint256 public immutable height;
    /// Public per-tree tweak, so a hash attack on one tree does not carry over to another.
    bytes32 public seed;
    bytes32 public root;
    mapping(bytes32 root => mapping(uint256 leaf => bool)) public spent;

    struct Signature {
        uint256 leaf;
        bytes32[67] wots; // CHAINS
        bytes32[] path; // Merkle siblings, leaf to root
    }

    event Executed(uint256 indexed leaf, address indexed to);
    event Rotated(bytes32 root, bytes32 seed);

    error BadHeight();
    error BadSignature();
    error Expired();
    error LeafSpent(uint256 leaf);
    error OnlySelf();

    constructor(bytes32 root_, bytes32 seed_, uint256 height_) {
        if (height_ == 0 || height_ > 20) revert BadHeight();
        (root, seed, height) = (root_, seed_, height_);
    }

    /// @notice Runs `to.call(data)` if signed by an unspent leaf before `deadline`. A failing call reverts the whole
    ///         execution, so the leaf stays unburnt but the signature can only ever replay this exact call until the
    ///         deadline.
    function execute(address to, bytes calldata data, uint256 deadline, Signature calldata sig)
        external
        returns (bytes memory)
    {
        if (block.timestamp > deadline) revert Expired();
        bytes32 r = root;
        if (spent[r][sig.leaf]) revert LeafSpent(sig.leaf);
        if (!_verify(executeDigest(to, data, deadline), sig)) revert BadSignature();
        spent[r][sig.leaf] = true;
        emit Executed(sig.leaf, to);
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    /// @notice ERC-1271. `signature` is `abi.encode(Signature)` over `erc1271Digest(hash)`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        Signature memory sig = abi.decode(signature, (Signature));
        if (spent[root][sig.leaf] || !_verify(erc1271Digest(hash), sig)) return 0xffffffff;
        return MAGIC;
    }

    /// @notice New key tree, once the old one runs low or is suspected. Only through `execute`, signed by the old one.
    function rotate(bytes32 newRoot, bytes32 newSeed) external {
        if (msg.sender != address(this)) revert OnlySelf();
        (root, seed) = (newRoot, newSeed);
        emit Rotated(newRoot, newSeed);
    }

    /// What the signer signs for `execute`: bound to this chain and account, so it cannot replay elsewhere.
    function executeDigest(address to, bytes calldata data, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(EXECUTE, block.chainid, address(this), to, keccak256(data), deadline));
    }

    function erc1271Digest(bytes32 hash) public view returns (bytes32) {
        return keccak256(abi.encode(ERC1271, block.chainid, address(this), hash));
    }

    // ---------------------------------------------------------------- verification

    function _verify(bytes32 m, Signature memory sig) internal view returns (bool) {
        uint256 h = height;
        if (sig.leaf >> h != 0 || sig.path.length != h) return false;
        bytes32 node = keccak256(abi.encodePacked(_publicKey(m, sig.leaf, sig.wots)));
        uint256 idx = sig.leaf;
        for (uint256 i; i < h; i++) {
            node = idx & 1 == 0 ? keccak256(abi.encode(node, sig.path[i])) : keccak256(abi.encode(sig.path[i], node));
            idx >>= 1;
        }
        return node == root;
    }

    /// Finishes each chain from the signed digit to the top. Lowering a message digit to forge needs a hash
    /// preimage; raising one lowers the checksum, which needs a preimage too.
    function _publicKey(bytes32 m, uint256 leaf, bytes32[67] memory s) internal view returns (bytes32[67] memory pk) {
        bytes32 sd = seed;
        uint256 checksum;
        for (uint256 i; i < DIGITS; i++) {
            uint256 d = (uint256(m) >> (252 - 4 * i)) & 15;
            checksum += 15 - d;
            pk[i] = _chain(sd, s[i], (leaf << 16) | (i << 8), d);
        }
        for (uint256 i; i < CHAINS - DIGITS; i++) {
            pk[DIGITS + i] = _chain(sd, s[DIGITS + i], (leaf << 16) | ((DIGITS + i) << 8), (checksum >> (8 - 4 * i)) & 15);
        }
    }

    /// Step j of a chain: x = keccak256(seed, tweak | j, x), from step `from` up to 15. Uses memory past the free
    /// pointer as scratch, so the ~1,000 hashes of a verification allocate nothing.
    function _chain(bytes32 sd, bytes32 x, uint256 tweak, uint256 from) internal pure returns (bytes32 r) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, sd)
            r := x
            for { let j := from } lt(j, 15) { j := add(j, 1) } {
                mstore(add(p, 0x20), or(tweak, j))
                mstore(add(p, 0x40), r)
                r := keccak256(p, 0x60)
            }
        }
    }
}
