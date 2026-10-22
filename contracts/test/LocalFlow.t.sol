// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";

/// The plan's five-minute demo, plus net settlement, on one local chain through the same calls the
/// backend makes.
contract LocalFlowTest is CorridorTest {
    /// Demo 1–3: a business pays a supplier $1,000 from "Base" with one signature; the supplier is paid out.
    function test_demo_payThousandDollars() public {
        uint256 senderBefore = d.usdc.balanceOf(sender);
        bytes32 key = _escrowed("inv-1000", 1_000e6, 1e6); // relayer pays, then delivers the attested message

        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Escrowed));
        vm.prank(relayer);
        d.escrow.release(key, receiver);

        assertEq(d.usdc.balanceOf(receiver), 999e6);
        assertEq(d.usdc.balanceOf(address(d.feeVault)), 1e6);
        assertEq(d.usdc.balanceOf(sender), senderBefore - 1_000e6);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 0);
    }

    /// Demo 4: pay a sanctioned address; the payment cannot be released, compliance freezes it and two officers
    /// refund it.
    function test_demo_sanctionedReceiverIsFrozenAndRefunded() public {
        bytes32 key = _escrowed("inv-sanctioned", 500e6, 0);
        address[] memory hit = new address[](1);
        hit[0] = receiver;
        vm.prank(admin);
        d.oracle.addToSanctionsList(hit);

        vm.prank(relayer);
        vm.expectRevert(PaymentEscrow.NotAllowed.selector);
        d.escrow.release(key, receiver);

        vm.prank(admin);
        d.escrow.freeze(key); // ops queue
        _twoOfficers(d.escrow.refund, key);
        uint256 before = d.usdc.balanceOf(sender);
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        assertEq(d.usdc.balanceOf(sender), before + 500e6);
    }

    /// Demo 5: the off-ramp never pays out; after the window the sender is refunded automatically.
    function test_demo_offRampFailureRefundsAfterWindow() public {
        bytes32 key = _escrowed("inv-stuck", 200e6, 2e6);
        vm.warp(block.timestamp + d.escrow.refundWindow());
        d.escrow.claimRefundAfterTimeout(key); // a keeper or anyone
        uint256 before = d.usdc.balanceOf(sender);
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        assertEq(d.usdc.balanceOf(sender), before + 198e6, "net back; the fee stays with the treasury");

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.release(key, receiver);
    }

    /// Net settlement: one signature and one CCTP transfer pay three suppliers; each is released on its own.
    function test_netSettlement_batchPaysEachSupplier() public {
        PaymentRouter.Leg[] memory legs = _legs(3, 100e6);
        address[3] memory suppliers = [receiver, makeAddr("s2"), makeAddr("s3")];
        for (uint256 i = 1; i < 3; i++) {
            legs[i].receiver = suppliers[i];
            vm.prank(admin);
            d.registry.setAttestation(suppliers[i], keccak256(abi.encode(i)), uint64(block.timestamp + 30 days));
        }
        assertEq(_deliver(_payBatch(legs, 3e6, 1)), 3);

        vm.startPrank(relayer);
        for (uint256 i; i < 3; i++) {
            d.escrow.release(_key(legs[i].paymentId), suppliers[i]);
            assertEq(d.usdc.balanceOf(suppliers[i]), 100e6);
        }
        vm.stopPrank();
        assertEq(d.usdc.balanceOf(address(d.feeVault)), 3e6);
    }

    /// Every refund path completes exactly once, and nothing can be released after it.
    function test_refundPaths_exactlyOnce() public {
        bytes32 frozen = _escrowed("frozen", 300e6, 3e6);
        bytes32 stuck = _escrowed("stuck", 200e6, 2e6);

        vm.prank(admin);
        d.escrow.freeze(frozen);
        _twoOfficers(d.escrow.refund, frozen);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.refund(frozen);

        vm.warp(block.timestamp + d.escrow.refundWindow());
        d.escrow.claimRefundAfterTimeout(stuck);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.claimRefundAfterTimeout(stuck);

        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.release(frozen, receiver);
        vm.expectRevert(abi.encodeWithSelector(PaymentEscrow.BadStatus.selector, PaymentEscrow.Status.Refunded));
        d.escrow.release(stuck, receiver);
        vm.stopPrank();

        assertEq(d.escrow.refundable(address(d.usdc), sender), 297e6 + 198e6);
        vm.prank(sender);
        d.escrow.withdrawRefund(IERC20(address(d.usdc)));
        assertEq(d.usdc.balanceOf(sender), deployer.SENDER_FUNDS() - 5e6, "all back except the signed fees");
        assertEq(d.escrow.totalHeld(address(d.usdc)), 0);
        assertEq(d.usdc.balanceOf(address(d.escrow)), 0);
    }
}
