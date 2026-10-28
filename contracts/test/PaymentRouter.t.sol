// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";
import {PaymentSig} from "./utils/PaymentSig.sol";

contract PaymentRouterTest is CorridorTest {
    // ------------------------------------------------------------ happy paths

    function test_pay_feeToVault_netBurnedToEscrowWithHookData() public {
        uint256 senderBefore = d.usdc.balanceOf(sender);
        bytes memory m = _pay("inv-1", 1_000e6, 5e6);

        assertEq(d.usdc.balanceOf(sender), senderBefore - 1_000e6);
        assertEq(d.usdc.balanceOf(address(d.feeVault)), 5e6);
        assertEq(d.usdc.balanceOf(address(d.router)), 0);

        // CCTP V2 message: destination, caller and mint recipient are the escrow; hook data carries the payment.
        assertEq(uint32(bytes4(_word(m, 8))), ARC, "destinationDomain");
        assertEq(_word(m, 108), _b32(address(d.escrow)), "destinationCaller");
        assertEq(_word(m, 148 + 36), _b32(address(d.escrow)), "mintRecipient");
        assertEq(uint256(_word(m, 148 + 68)), 995e6, "amount");
        assertEq(_word(m, 148 + 100), _b32(address(d.router)), "messageSender");

        (address s, address refundTo, PaymentRouter.Leg[] memory legs) = _hook(m);
        assertEq(s, sender);
        assertEq(refundTo, sender);
        assertEq(legs.length, 1);
        assertEq(legs[0].paymentId, bytes32("inv-1"));
        assertEq(legs[0].receiver, receiver);
        assertEq(legs[0].amount, 995e6);
        assertEq(legs[0].travelRuleHash, TRH);
    }

    function test_payBatch_oneBurnForManySuppliers() public {
        PaymentRouter.Leg[] memory legs = _legs(3, 100e6);
        legs[1].receiver = makeAddr("supplier2");
        bytes memory m = _payBatch(legs, 2e6, 1);

        assertEq(d.usdc.balanceOf(address(d.feeVault)), 2e6);
        assertEq(uint256(_word(m, 148 + 68)), 300e6, "one net burn");
        (, , PaymentRouter.Leg[] memory got) = _hook(m);
        assertEq(got.length, 3);
        assertEq(got[1].receiver, makeAddr("supplier2"));
        assertEq(got[2].amount, 100e6);
    }

    function test_pay_neverSweepsPreexistingBalance() public {
        d.usdc.mint(address(d.router), 777e6);
        bytes memory m = _pay("inv-1", 100e6, 1e6);
        assertEq(uint256(_word(m, 148 + 68)), 99e6);
        assertEq(d.usdc.balanceOf(address(d.router)), 777e6);
    }

    /// A contract-wallet sender (e.g. a post-quantum smart account): Permit2 asks the wallet via ERC-1271 instead of
    /// ecrecover, so a signature of any scheme and size pays through the unchanged router.
    function test_pay_fromContractWallet_viaERC1271() public {
        ApprovingWallet w = new ApprovingWallet();
        d.usdc.mint(address(w), 100e6);
        vm.prank(address(w));
        d.usdc.approve(d.permit2, type(uint256).max);

        PaymentRouter.PaymentIntent memory intent = PaymentRouter.PaymentIntent("pq-1", receiver, address(w), 1e6, ARC, TRH);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 1);
        bytes32 digest = PaymentSig.digest(d.permit2, address(d.router), permit, d.router.hashIntent(intent), d.router.INTENT_WITNESS());
        bytes memory sig = new bytes(2420); // ML-DSA-44 signature size
        sig[0] = 0x01;
        w.approve(digest, sig);

        vm.prank(relayer);
        vm.expectRevert(); // Permit2 InvalidContractSignature: the wallet rejects any other signature
        d.router.pay(intent, permit, address(w), new bytes(2420));

        vm.recordLogs();
        vm.prank(relayer);
        d.router.pay(intent, permit, address(w), sig);
        bytes memory m = _lastMessage();

        assertEq(d.usdc.balanceOf(address(w)), 0);
        assertEq(uint256(_word(m, 148 + 68)), 99e6, "net burned");
        (address s, address refundTo, ) = _hook(m);
        assertEq(s, address(w));
        assertEq(refundTo, address(w));
    }

    // ------------------------------------------------------------ the signature binds everything

    function test_revert_tamperedFields() public {
        PaymentRouter.PaymentIntent memory intent = _intent("inv-1", 1e6);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 7);
        bytes memory sig = _sign(intent, permit);

        PaymentRouter.PaymentIntent[5] memory tampered;
        for (uint256 i; i < 5; i++) {
            tampered[i] = intent;
        }
        tampered[0].fee = 50e6;
        tampered[1].receiver = makeAddr("attacker");
        tampered[2].refundTo = makeAddr("attacker");
        tampered[3].travelRuleHash = bytes32(0);
        tampered[4].paymentId = "inv-2";
        for (uint256 i; i < 5; i++) {
            vm.prank(relayer);
            vm.expectRevert();
            d.router.pay(tampered[i], permit, sender, sig);
        }

        permit.permitted.amount = 200e6; // and the amount
        vm.prank(relayer);
        vm.expectRevert();
        d.router.pay(intent, permit, sender, sig);
    }

    function test_revert_tamperedBatchLeg() public {
        PaymentRouter.BatchIntent memory batch = PaymentRouter.BatchIntent(_legs(2, 50e6), sender, 0, ARC);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 1);
        bytes memory sig = _signBatch(batch, permit);

        batch.legs[1].receiver = makeAddr("attacker");
        vm.prank(relayer);
        vm.expectRevert();
        d.router.payBatch(batch, permit, sender, sig);
    }

    function test_revert_replaySameNonce() public {
        PaymentRouter.PaymentIntent memory intent = _intent("inv-1", 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 7);
        bytes memory sig = _sign(intent, permit);
        vm.startPrank(relayer);
        d.router.pay(intent, permit, sender, sig);
        vm.expectRevert(); // Permit2 InvalidNonce
        d.router.pay(intent, permit, sender, sig);
        vm.stopPrank();
    }

    function test_revert_wrongSignerAndExpired() public {
        PaymentRouter.PaymentIntent memory intent = _intent("inv-1", 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 7);
        bytes memory sig = _sign(intent, permit);

        vm.prank(relayer);
        vm.expectRevert();
        d.router.pay(intent, permit, makeAddr("notTheSigner"), sig);

        vm.warp(permit.deadline + 1);
        vm.prank(relayer);
        vm.expectRevert();
        d.router.pay(intent, permit, sender, sig);
    }

    // ------------------------------------------------------------ input checks

    function test_revert_wrongDomainZeroAddressesFee() public {
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 7);
        PaymentRouter.PaymentIntent memory intent = _intent("inv-1", 0);
        vm.startPrank(relayer);

        intent.destinationDomain = 0;
        vm.expectRevert(PaymentRouter.WrongDomain.selector);
        d.router.pay(intent, permit, sender, "");

        intent = _intent("inv-1", 0);
        intent.refundTo = address(0);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        d.router.pay(intent, permit, sender, "");

        intent = _intent("inv-1", 100e6);
        vm.expectRevert(PaymentRouter.FeeTooHigh.selector);
        d.router.pay(intent, permit, sender, "");
        vm.stopPrank();
    }

    function test_revert_badBatches() public {
        vm.startPrank(relayer);
        PaymentRouter.BatchIntent memory batch = PaymentRouter.BatchIntent(new PaymentRouter.Leg[](0), sender, 0, ARC);
        vm.expectRevert(PaymentRouter.BadBatch.selector);
        d.router.payBatch(batch, _permit(0, 1), sender, "");

        batch.legs = _legs(d.router.MAX_LEGS() + 1, 1e6);
        vm.expectRevert(PaymentRouter.BadBatch.selector);
        d.router.payBatch(batch, _permit(51e6, 1), sender, "");

        batch.legs = _legs(2, 10e6);
        vm.expectRevert(PaymentRouter.AmountMismatch.selector); // legs + fee must equal the permitted amount
        d.router.payBatch(batch, _permit(25e6, 1), sender, "");

        batch.legs[0].amount = 0;
        vm.expectRevert(PaymentRouter.BadBatch.selector);
        d.router.payBatch(batch, _permit(10e6, 1), sender, "");
        vm.stopPrank();
    }

    function test_onlyRelayerAndPause() public {
        PaymentRouter.PaymentIntent memory intent = _intent("inv-1", 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 7);
        bytes memory sig = _sign(intent, permit);

        vm.expectRevert(); // not RELAYER
        d.router.pay(intent, permit, sender, sig);

        vm.prank(admin);
        d.router.pause();
        vm.prank(relayer);
        vm.expectRevert();
        d.router.pay(intent, permit, sender, sig);

        vm.prank(admin);
        d.router.unpause();
        vm.prank(relayer);
        d.router.pay(intent, permit, sender, sig);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        new PaymentRouter(admin, ISignatureTransfer(d.permit2), ITokenMessengerV2(address(d.cctp)), address(0), address(1), ARC);
    }

    // ------------------------------------------------------------ hashing matches EIP-712 by hand

    function test_typehashesMatchTheirTypeStrings() public view {
        assertEq(
            d.router.INTENT_TYPEHASH(),
            keccak256(
                "PaymentIntent(bytes32 paymentId,address receiver,address refundTo,uint256 fee,uint32 destinationDomain,bytes32 travelRuleHash)"
            )
        );
        PaymentRouter.Leg[] memory legs = _legs(2, 5e6);
        bytes32 leg0 = keccak256(abi.encode(d.router.LEG_TYPEHASH(), legs[0].paymentId, receiver, 5e6, legs[0].travelRuleHash));
        bytes32 leg1 = keccak256(abi.encode(d.router.LEG_TYPEHASH(), legs[1].paymentId, receiver, 5e6, legs[1].travelRuleHash));
        bytes32 want = keccak256(
            abi.encode(d.router.BATCH_TYPEHASH(), keccak256(abi.encodePacked(leg0, leg1)), sender, uint256(1), ARC)
        );
        assertEq(d.router.hashBatch(PaymentRouter.BatchIntent(legs, sender, 1, ARC)), want);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_feePlusNetEqualsGross(uint96 gross, uint96 fee) public {
        gross = uint96(bound(gross, 1, d.usdc.balanceOf(sender)));
        fee = uint96(bound(fee, 0, gross - 1));
        bytes memory m = _pay("fuzz", gross, fee);
        assertEq(d.usdc.balanceOf(address(d.feeVault)) + uint256(_word(m, 148 + 68)), gross);
        assertEq(d.usdc.balanceOf(address(d.router)), 0);
    }

    function testFuzz_batchBurnsSumOfLegs(uint8 n, uint64 each, uint64 fee) public {
        n = uint8(bound(n, 1, d.router.MAX_LEGS()));
        each = uint64(bound(each, 1, 10_000e6));
        fee = uint64(bound(fee, 0, 1_000e6));
        bytes memory m = _payBatch(_legs(n, each), fee, 1);
        assertEq(uint256(_word(m, 148 + 68)), uint256(n) * each);
        assertEq(d.usdc.balanceOf(address(d.feeVault)), fee);
    }

    // ------------------------------------------------------------ helpers

    function _hook(bytes memory m) internal pure returns (address, address, PaymentRouter.Leg[] memory) {
        bytes memory hook = new bytes(m.length - 148 - 228);
        for (uint256 i; i < hook.length; i++) {
            hook[i] = m[148 + 228 + i];
        }
        return abi.decode(hook, (address, address, PaymentRouter.Leg[]));
    }
}

/// Stand-in for a post-quantum smart wallet: accepts exactly one (digest, signature) pair, of any length.
contract ApprovingWallet {
    bytes32 digest;
    bytes32 sigHash;

    function approve(bytes32 d, bytes calldata sig) external {
        (digest, sigHash) = (d, keccak256(sig));
    }

    function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
        return h == digest && keccak256(sig) == sigHash ? this.isValidSignature.selector : bytes4(0xffffffff);
    }
}
