// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ReentrancyGuardTransientUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {MockStablecoin} from "./utils/Mocks.sol";
import {LocalCCTP} from "./utils/LocalCCTP.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";

/// A transmitter that runs code mid-delivery: it delivers a second message from inside the first.
contract ReentrantCCTP is LocalCCTP {
    MockStablecoin immutable usdc;
    PaymentEscrow public escrow;
    bytes inner;

    constructor(MockStablecoin usdc_) LocalCCTP(6) {
        usdc = usdc_;
    }

    function arm(PaymentEscrow escrow_, bytes memory inner_) external {
        (escrow, inner) = (escrow_, inner_);
    }

    function receiveMessage(bytes calldata, bytes calldata) external override returns (bool) {
        usdc.mint(address(escrow), 100e6);
        if (inner.length > 0) {
            bytes memory m = inner;
            delete inner;
            escrow.receivePayment(m, "");
        }
        return true;
    }
}

/// V2 for the upgrade test.
contract PaymentEscrowV2 is PaymentEscrow {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract PaymentEscrowTest is CorridorTest {
    // ------------------------------------------------------------ CCTP intake

    function test_receive_recordsWhatTheRouterSigned() public {
        bytes memory m = _pay("inv-1", 100e6, 1e6);
        vm.expectEmit(address(d.escrow));
        emit PaymentEscrow.Received(_key("inv-1"), "inv-1", BASE, address(d.usdc), sender, receiver, sender, 99e6, TRH);
        assertEq(_deliver(m), 1);

        (address token, address s, address r, address rt, uint128 amount,, PaymentEscrow.Status st) =
            d.escrow.payments(_key("inv-1"));
        assertEq(token, address(d.usdc));
        assertEq(s, sender);
        assertEq(r, receiver);
        assertEq(rt, sender);
        assertEq(amount, 99e6);
        assertEq(uint8(st), uint8(PaymentEscrow.Status.Escrowed));
        assertEq(d.escrow.totalHeld(address(d.usdc)), 99e6);
    }

    function test_receive_batchRecordsEveryLeg() public {
        PaymentRouter.Leg[] memory legs = _legs(5, 20e6);
        assertEq(_deliver(_payBatch(legs, 1e6, 1)), 5);
        for (uint256 i; i < 5; i++) {
            assertEq(uint8(_status(_key(legs[i].paymentId))), uint8(PaymentEscrow.Status.Escrowed));
            assertEq(_amount(_key(legs[i].paymentId)), 20e6);
        }
        assertEq(d.escrow.totalHeld(address(d.usdc)), 100e6);
    }

    function test_receive_onlyRelayerAndOnlyThroughEscrow() public {
        bytes memory m = _pay("inv-1", 100e6, 0);
        vm.expectRevert(); // not RELAYER
        d.escrow.receivePayment(m, "");
        vm.expectRevert("Invalid caller for message"); // destinationCaller is the escrow
        d.cctp.receiveMessage(m, "");
    }

    function test_receive_messageOnce() public {
        bytes memory m = _pay("inv-1", 100e6, 0);
        _deliver(m);
        vm.prank(relayer);
        vm.expectRevert("Nonce already used");
        d.escrow.receivePayment(m, "");
    }

    function test_receive_untrustedSenderStaysUnattributed() public {
        vm.prank(admin);
        d.escrow.setRouter(BASE, address(d.router), false);
        bytes memory m = _pay("inv-1", 100e6, 0);
        vm.expectEmit(address(d.escrow));
        emit PaymentEscrow.Unattributed(BASE, _word(m, 12), 100e6);
        assertEq(_deliver(m), 0);
        assertEq(uint8(_status(_key("inv-1"))), uint8(PaymentEscrow.Status.None));
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 100e6);
    }

    function test_receive_duplicateKeyStaysUnattributed() public {
        _escrowed("inv-1", 100e6, 0);
        PaymentRouter.Leg[] memory legs = _legs(1, 7e6);
        legs[0].paymentId = "inv-1"; // same ID again from the same domain
        assertEq(_deliver(_payBatch(legs, 0, 1)), 0);
        assertEq(_amount(_key("inv-1")), 100e6);
        assertEq(d.escrow.totalHeld(address(d.usdc)), 100e6);
    }

    function test_receive_duplicateWithinBatchStaysUnattributed() public {
        PaymentRouter.Leg[] memory legs = _legs(3, 10e6);
        legs[2].paymentId = legs[0].paymentId;
        assertEq(_deliver(_payBatch(legs, 0, 1)), 0);
        assertEq(uint8(_status(_key(legs[1].paymentId))), uint8(PaymentEscrow.Status.None)); // all or nothing
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);
    }

    function test_receive_sameIdOnTwoSourceChains() public {
        _escrowed("inv-1", 100e6, 0);
        // The same router address on Ethereum (domain 0), as CREATE2 gives: a hand-made message plays that chain.
        vm.prank(admin);
        d.escrow.setRouter(0, address(d.router), true);
        bytes memory m = _message(0, address(d.router), abi.encode(sender, sender, _legs(1, 50e6)), 50e6); // ID 0x..01
        assertEq(_deliver(m), 1);
        assertEq(uint8(_status(d.escrow.paymentKey(0, bytes32(uint256(1))))), uint8(PaymentEscrow.Status.Escrowed));
        assertEq(d.escrow.totalHeld(address(d.usdc)), 150e6);
    }

    function test_receive_singlePaymentAbsorbsCctpFee() public {
        bytes memory m = _pay("inv-1", 100e6, 0);
        _poke(m, 148 + 164, bytes32(uint256(1e6))); // feeExecuted
        assertEq(_deliver(m), 1);
        assertEq(_amount(_key("inv-1")), 99e6);
    }

    function test_receive_batchWithCctpFeeStaysUnattributed() public {
        bytes memory m = _payBatch(_legs(2, 50e6), 0, 1);
        _poke(m, 148 + 164, bytes32(uint256(1e6))); // legs no longer add up to what arrived
        assertEq(_deliver(m), 0);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 99e6);
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);
    }

    function test_receive_rejectsNonBurnAndMintElsewhere() public {
        bytes memory m = _pay("inv-1", 100e6, 0);
        bytes memory notBurn = bytes.concat(m);
        _poke(notBurn, 76, _b32(makeAddr("someOtherHandler")));
        vm.prank(relayer);
        vm.expectRevert(PaymentEscrow.NotABurnMessage.selector);
        d.escrow.receivePayment(notBurn, "");

        _poke(m, 148 + 36, _b32(makeAddr("elsewhere")));
        vm.prank(relayer);
        vm.expectRevert(PaymentEscrow.NothingReceived.selector);
        d.escrow.receivePayment(m, "");
    }

    function test_receive_nestedDeliveryReverts() public {
        ReentrantCCTP evil = new ReentrantCCTP(d.usdc);
        PaymentEscrow e = _freshEscrow(address(evil));
        bytes32 eb = _b32(address(e));
        bytes memory hook = abi.encode(sender, sender, _legs(1, 100e6));
        bytes memory outer = evil.formatMessage(BASE, ARC, bytes32(uint256(1)), eb, 2000, address(d.usdc), eb, 100e6, address(d.router), hook);
        evil.arm(e, evil.formatMessage(BASE, ARC, bytes32(uint256(2)), eb, 2000, address(d.usdc), eb, 100e6, address(d.router), hook));
        vm.prank(relayer);
        vm.expectRevert(ReentrancyGuardTransientUpgradeable.ReentrancyGuardReentrantCall.selector);
        e.receivePayment(outer, "");
    }

    // ------------------------------------------------------------ liquidity-provider funding (token-agnostic intake)

    function test_fundFromLiquidity_pullsFromMarketMaker() public {
        uint256 before = d.usdc.balanceOf(marketMaker);
        bytes32 key = _fund("lp-1", 250e6);
        assertEq(key, d.escrow.paymentKey(d.escrow.LIQUIDITY_DOMAIN(), "lp-1"));
        assertEq(d.usdc.balanceOf(marketMaker), before - 250e6);
        assertEq(_amount(key), 250e6);
        assertEq(d.escrow.totalHeld(address(d.usdc)), 250e6);
    }

    function test_fundFromLiquidity_whitelistRoleAndOnce() public {
        MockStablecoin pyusd = new MockStablecoin("PYUSD");
        pyusd.mint(marketMaker, 10e6);
        vm.prank(marketMaker);
        pyusd.approve(address(d.escrow), type(uint256).max);
        PaymentEscrow.Funding memory f = PaymentEscrow.Funding("t", sender, receiver, sender, address(pyusd), 10e6, TRH);

        vm.prank(marketMaker);
        vm.expectRevert(PaymentEscrow.TokenNotAllowed.selector);
        d.escrow.fundFromLiquidity(f);

        vm.prank(admin);
        d.escrow.setAllowedToken(address(pyusd), true); // token-agnostic escrow: PYUSD whitelisted
        vm.prank(marketMaker);
        d.escrow.fundFromLiquidity(f);
        assertEq(d.escrow.totalHeld(address(pyusd)), 10e6);

        vm.prank(marketMaker);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Escrowed));
        d.escrow.fundFromLiquidity(f);

        vm.expectRevert(); // not MARKET_MAKER
        d.escrow.fundFromLiquidity(f);
    }

    // ------------------------------------------------------------ release

    function test_release_toSupplierOrApprovedOffRampOnly() public {
        bytes32 a = _escrowed("a", 100e6, 0);
        bytes32 b = _escrowed("b", 100e6, 0);
        address ramp = makeAddr("offRamp");
        vm.prank(admin);
        d.escrow.setOffRamp(ramp, true);

        vm.startPrank(relayer);
        vm.expectRevert(PaymentEscrow.BadPayoutAddress.selector);
        d.escrow.release(a, makeAddr("attacker"));
        d.escrow.release(a, receiver);
        d.escrow.release(b, ramp);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Released));
        d.escrow.release(a, receiver);
        vm.stopPrank();

        assertEq(d.usdc.balanceOf(receiver), 100e6);
        assertEq(d.usdc.balanceOf(ramp), 100e6);
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);
    }

    function test_release_blockedBySanctionsOracle() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        address[] memory hit = new address[](1);
        hit[0] = receiver;
        vm.prank(admin);
        d.oracle.addToSanctionsList(hit);
        vm.prank(relayer);
        vm.expectRevert(PaymentEscrow.NotAllowed.selector);
        d.escrow.release(key, receiver);
    }

    function test_release_blockedByExpiredKyb() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.warp(block.timestamp + deployer.KYB_VALID_FOR());
        vm.prank(relayer);
        vm.expectRevert(PaymentEscrow.NotAllowed.selector);
        d.escrow.release(key, receiver);
    }

    function test_release_onlyPayoutOperator() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.prank(officerB);
        vm.expectRevert();
        d.escrow.release(key, receiver);
    }

    // ------------------------------------------------------------ freeze and the second approver

    function test_freeze_thenUnfreezeNeedsTwoOfficers() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.prank(admin);
        d.escrow.freeze(key);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Frozen));
        d.escrow.release(key, receiver);

        vm.startPrank(admin);
        d.escrow.unfreeze(key);
        d.escrow.unfreeze(key); // the same officer twice is still one approval
        vm.stopPrank();
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Frozen));

        vm.prank(officerB);
        d.escrow.unfreeze(key);
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Escrowed));
        vm.prank(relayer);
        d.escrow.release(key, receiver);
    }

    function test_refundNeedsTwoOfficersAndAgreement() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.prank(admin);
        d.escrow.freeze(key);

        vm.prank(admin);
        d.escrow.refund(key);
        vm.prank(officerB);
        d.escrow.unfreeze(key); // a different action replaces the proposal instead of executing it
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Frozen));

        vm.prank(admin);
        d.escrow.refund(key);
        vm.prank(officerB);
        d.escrow.refund(key);
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Refunded));
        assertEq(d.escrow.refundable(address(d.usdc), sender), 100e6);
    }

    function test_freezer_canOnlyFreeze() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.startPrank(relayer); // holds FREEZER
        d.escrow.freeze(key);
        vm.expectRevert();
        d.escrow.unfreeze(key);
        vm.expectRevert();
        d.escrow.refund(key);
        vm.stopPrank();
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Frozen));

        bytes32 other = _escrowed("b", 100e6, 0);
        vm.prank(sender);
        vm.expectRevert();
        d.escrow.freeze(other);
    }

    function test_freezeClearsAPendingProposal() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.prank(admin);
        d.escrow.refund(key); // proposed on an Escrowed payment
        vm.prank(officerB);
        d.escrow.freeze(key);
        vm.prank(officerB);
        d.escrow.refund(key); // starts over instead of completing the old proposal
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Frozen));
    }

    // ------------------------------------------------------------ refunds: timeout and pull

    function test_timeoutRefund_thenPullOnce() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.expectRevert(PaymentEscrow.RefundWindowOpen.selector);
        d.escrow.claimRefundAfterTimeout(key);

        vm.warp(block.timestamp + d.escrow.refundWindow());
        d.escrow.claimRefundAfterTimeout(key); // anyone may push it
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.claimRefundAfterTimeout(key);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 100e6, "owed, not yet pulled");
        assertEq(d.escrow.totalHeld(address(d.usdc)), 100e6);

        vm.expectRevert(PaymentEscrow.NothingToWithdraw.selector); // only the refund address can pull
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));

        uint256 before = d.usdc.balanceOf(sender);
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        assertEq(d.usdc.balanceOf(sender), before + 100e6);
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);

        vm.prank(sender);
        vm.expectRevert(PaymentEscrow.NothingToWithdraw.selector);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
    }

    function test_timeoutRefund_notForFrozen() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.prank(admin);
        d.escrow.freeze(key);
        vm.warp(block.timestamp + d.escrow.refundWindow());
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Frozen));
        d.escrow.claimRefundAfterTimeout(key);
    }

    function test_unfreezeRestartsTheRefundWindow() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        vm.warp(block.timestamp + d.escrow.refundWindow());
        vm.prank(admin);
        d.escrow.freeze(key);
        _twoOfficers(d.escrow.unfreeze, key);
        vm.expectRevert(PaymentEscrow.RefundWindowOpen.selector);
        d.escrow.claimRefundAfterTimeout(key);
    }

    // ------------------------------------------------------------ pause

    function test_pause_stopsMoneyMovingButNotCompliance() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        bytes memory next = _pay("b", 50e6, 0);
        vm.warp(block.timestamp + d.escrow.refundWindow());
        vm.prank(admin);
        d.escrow.pause();

        vm.startPrank(relayer);
        vm.expectRevert();
        d.escrow.receivePayment(next, "");
        vm.expectRevert();
        d.escrow.release(key, receiver);
        vm.stopPrank();
        vm.expectRevert();
        d.escrow.claimRefundAfterTimeout(key);

        vm.prank(admin);
        d.escrow.freeze(key); // compliance still works while paused
        _twoOfficers(d.escrow.refund, key);
        vm.prank(sender);
        vm.expectRevert(); // but the pull waits for the unpause
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));

        vm.prank(admin);
        d.escrow.unpause();
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        assertEq(_deliver(next), 1); // the waiting message still lands
    }

    // ------------------------------------------------------------ admin

    function test_sweep_onlyUnattributed() public {
        _escrowed("a", 100e6, 0);
        d.usdc.mint(address(d.escrow), 5e6); // a donation
        vm.prank(admin);
        d.escrow.sweepUnattributed(IERC20(address(d.usdc)), makeAddr("treasury"));
        assertEq(d.usdc.balanceOf(makeAddr("treasury")), 5e6);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 100e6);

        vm.prank(officerB);
        vm.expectRevert();
        d.escrow.sweepUnattributed(IERC20(address(d.usdc)), officerB);
    }

    function test_upgrade_onlyAdmin_keepsState() public {
        bytes32 key = _escrowed("a", 100e6, 0);
        address v2 = address(new PaymentEscrowV2());

        vm.prank(officerB);
        vm.expectRevert();
        d.escrow.upgradeToAndCall(v2, "");

        vm.prank(admin);
        d.escrow.upgradeToAndCall(v2, "");
        assertEq(PaymentEscrowV2(address(d.escrow)).version(), 2);
        assertEq(_amount(key), 100e6);
    }

    function test_initializeOnce_andImplementationLocked() public {
        vm.expectRevert();
        d.escrow.initialize(admin, d.registry, d.cctp, address(d.cctp), IERC20(address(d.usdc)), 1);
        PaymentEscrow impl = new PaymentEscrow();
        vm.expectRevert();
        impl.initialize(admin, d.registry, d.cctp, address(d.cctp), IERC20(address(d.usdc)), 1);
    }

    // ------------------------------------------------------------ helpers

    /// A hand-made CCTP message (another source chain); the local CCTP pays it out of what it holds.
    function _message(uint32 domain, address from, bytes memory hook, uint256 amount) internal returns (bytes memory) {
        d.usdc.mint(address(d.cctp), amount);
        bytes32 e = _b32(address(d.escrow));
        return d.cctp.formatMessage(domain, ARC, keccak256(hook), e, 2000, address(d.usdc), e, amount, from, hook);
    }

    function _freshEscrow(address cctp) internal returns (PaymentEscrow e) {
        e = PaymentEscrow(
            address(
                new ERC1967Proxy(
                    address(new PaymentEscrow()),
                    abi.encodeCall(
                        PaymentEscrow.initialize, (address(this), d.registry, LocalCCTP(cctp), cctp, IERC20(address(d.usdc)), 1 days)
                    )
                )
            )
        );
        e.grantRole(e.RELAYER(), relayer);
        e.setRouter(BASE, address(d.router), true);
    }
}
