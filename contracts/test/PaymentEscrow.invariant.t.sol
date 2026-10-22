// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {DeployLocal} from "../script/DeployLocal.s.sol";

/// Random sequences over the real local deployment: CCTP payments (single and batch), rogue burns, market-maker
/// funding, release, freeze, two-officer unfreeze and refund, timeouts, pulls, donations and sweeps.
contract EscrowHandler is Test {
    uint32 constant BASE = 6;
    DeployLocal.Deployment d;
    address admin;
    address relayer;
    address sender;
    address receiver;
    address officerB;
    address marketMaker;

    bytes32[] public keys;
    mapping(bytes32 key => bool) public wasReleased;
    mapping(bytes32 key => bool) public wasRefunded;
    uint256 nonce; // payment IDs
    uint256 messages; // CCTP nonces, separate so a reused ID still gets a fresh message
    uint256 public totalIn; // attributed to payments
    uint256 public totalReleased;
    uint256 public totalWithdrawn;

    constructor(DeployLocal deployer, DeployLocal.Deployment memory d_) {
        d = d_;
        (admin, relayer, sender, receiver) = (deployer.actor(0), deployer.actor(1), deployer.actor(2), deployer.actor(3));
        (officerB, marketMaker) = (deployer.actor(4), deployer.actor(5));
    }

    // ------------------------------------------------------------ intake

    function receiveSingle(uint64 amount) external {
        amount = uint64(bound(amount, 1, 1_000_000e6));
        PaymentRouter.Leg[] memory legs = new PaymentRouter.Leg[](1);
        legs[0] = PaymentRouter.Leg(bytes32(++nonce), receiver, amount, bytes32(0));
        _deliver(address(d.router), legs, amount);
    }

    function receiveBatch(uint8 n, uint64 each) external {
        n = uint8(bound(n, 2, 8));
        each = uint64(bound(each, 1, 100_000e6));
        PaymentRouter.Leg[] memory legs = new PaymentRouter.Leg[](n);
        for (uint256 i; i < n; i++) {
            legs[i] = PaymentRouter.Leg(bytes32(++nonce), receiver, each, bytes32(0));
        }
        _deliver(address(d.router), legs, uint256(n) * each);
    }

    /// A burn that did not come from the trusted router, or reuses an ID: funds arrive, no payment appears.
    function rogueOrDuplicate(uint64 amount, bool rogue) external {
        amount = uint64(bound(amount, 1, 1_000_000e6));
        PaymentRouter.Leg[] memory legs = new PaymentRouter.Leg[](1);
        bytes32 id = rogue || nonce == 0 ? bytes32(++nonce) : bytes32(nonce); // the last ID again
        legs[0] = PaymentRouter.Leg(id, receiver, amount, bytes32(0));
        uint256 before = keys.length;
        _deliver(rogue ? makeAddr("rogue") : address(d.router), legs, amount);
        require(keys.length == before || !rogue, "rogue burn attributed");
    }

    function fund(uint64 amount) external {
        amount = uint64(bound(amount, 1, 1_000_000e6));
        d.usdc.mint(marketMaker, amount);
        bytes32 id = bytes32(++nonce);
        vm.prank(marketMaker);
        bytes32 key = d.escrow.fundFromLiquidity(
            PaymentEscrow.Funding(id, sender, receiver, sender, address(d.usdc), amount, bytes32(0))
        );
        keys.push(key);
        totalIn += amount;
    }

    // ------------------------------------------------------------ outcomes

    function release(uint256 seed) external {
        (bytes32 key, uint128 amount, PaymentEscrow.Status s) = _pick(seed);
        if (s != PaymentEscrow.Status.Escrowed || !d.registry.isAllowed(sender, receiver)) return;
        vm.prank(relayer);
        d.escrow.release(key, receiver);
        wasReleased[key] = true;
        totalReleased += amount;
    }

    function freeze(uint256 seed) external {
        (bytes32 key,, PaymentEscrow.Status s) = _pick(seed);
        if (s != PaymentEscrow.Status.Escrowed) return;
        vm.prank(admin);
        d.escrow.freeze(key);
    }

    function unfreeze(uint256 seed) external {
        (bytes32 key,, PaymentEscrow.Status s) = _pick(seed);
        if (s != PaymentEscrow.Status.Frozen) return;
        vm.prank(admin);
        d.escrow.unfreeze(key);
        vm.prank(officerB);
        d.escrow.unfreeze(key);
    }

    function refund(uint256 seed, bool oneOfficerOnly) external {
        (bytes32 key,, PaymentEscrow.Status s) = _pick(seed);
        if (s != PaymentEscrow.Status.Escrowed && s != PaymentEscrow.Status.Frozen) return;
        vm.prank(admin);
        d.escrow.refund(key);
        if (oneOfficerOnly) return; // a lone officer must never complete a refund
        vm.prank(officerB);
        d.escrow.refund(key);
        wasRefunded[key] = true;
    }

    function timeout(uint256 seed) external {
        (bytes32 key,, PaymentEscrow.Status s) = _pick(seed);
        if (s != PaymentEscrow.Status.Escrowed) return;
        vm.warp(block.timestamp + d.escrow.refundWindow());
        d.escrow.claimRefundAfterTimeout(key);
        wasRefunded[key] = true;
    }

    function withdraw() external {
        uint256 owed = d.escrow.refundable(address(d.usdc), sender);
        if (owed == 0) return;
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        totalWithdrawn += owed;
    }

    function donate(uint64 amount) external {
        d.usdc.mint(address(d.escrow), amount);
    }

    function sweep() external {
        vm.prank(admin);
        d.escrow.sweepUnattributed(IERC20(address(d.usdc)), admin);
    }

    // ------------------------------------------------------------ helpers

    function keysLength() external view returns (uint256) {
        return keys.length;
    }

    function _deliver(address from, PaymentRouter.Leg[] memory legs, uint256 amount) internal {
        d.usdc.mint(address(d.cctp), amount);
        bytes32 e = bytes32(uint256(uint160(address(d.escrow))));
        bytes memory m = d.cctp.formatMessage(
            BASE, 26, bytes32(++messages), e, 2000, address(d.usdc), e, amount, from,
            abi.encode(sender, sender, legs)
        );
        vm.prank(relayer);
        uint256 recorded = d.escrow.receivePayment(m, "");
        if (recorded == 0) return;
        for (uint256 i; i < legs.length; i++) {
            keys.push(d.escrow.paymentKey(BASE, legs[i].paymentId));
        }
        totalIn += amount;
    }

    function _pick(uint256 seed) internal view returns (bytes32 key, uint128 amount, PaymentEscrow.Status s) {
        if (keys.length == 0) return (bytes32(0), 0, PaymentEscrow.Status.None);
        key = keys[seed % keys.length];
        (,,,, amount,, s) = d.escrow.payments(key);
    }
}

contract PaymentEscrowInvariantTest is Test {
    DeployLocal.Deployment d;
    EscrowHandler handler;
    address sender;

    function setUp() public {
        DeployLocal deployer = new DeployLocal();
        d = deployer.deploy();
        sender = deployer.actor(2);
        handler = new EscrowHandler(deployer, d);
        targetContract(address(handler));
    }

    /// The escrow always holds at least what it owes.
    function invariant_solvent() public view {
        assertGe(d.usdc.balanceOf(address(d.escrow)), d.escrow.totalHeld(address(d.usdc)));
    }

    /// Owed = open payments + refunds credited but not yet pulled.
    function invariant_heldMatchesOpenPaymentsAndRefunds() public view {
        uint256 open;
        for (uint256 i; i < handler.keysLength(); i++) {
            (,,,, uint128 amount,, PaymentEscrow.Status s) = d.escrow.payments(handler.keys(i));
            if (s == PaymentEscrow.Status.Escrowed || s == PaymentEscrow.Status.Frozen) open += amount;
        }
        assertEq(d.escrow.totalHeld(address(d.usdc)), open + d.escrow.refundable(address(d.usdc), sender));
    }

    /// Everything attributed is still owed, released, or pulled back by the sender: nothing created or lost.
    function invariant_conservation() public view {
        assertEq(
            handler.totalIn(), d.escrow.totalHeld(address(d.usdc)) + handler.totalReleased() + handler.totalWithdrawn()
        );
    }

    /// A payment is released or refunded, never both, and its status agrees.
    function invariant_releasedOrRefundedNeverBoth() public view {
        for (uint256 i; i < handler.keysLength(); i++) {
            bytes32 key = handler.keys(i);
            (,,,,,, PaymentEscrow.Status s) = d.escrow.payments(key);
            assertFalse(handler.wasReleased(key) && handler.wasRefunded(key));
            if (handler.wasReleased(key)) assertEq(uint8(s), uint8(PaymentEscrow.Status.Released));
            if (handler.wasRefunded(key)) assertEq(uint8(s), uint8(PaymentEscrow.Status.Refunded));
        }
    }
}
