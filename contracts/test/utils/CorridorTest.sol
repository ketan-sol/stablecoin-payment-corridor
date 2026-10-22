// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {PaymentRouter} from "../../src/PaymentRouter.sol";
import {PaymentEscrow} from "../../src/PaymentEscrow.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {PaymentSig} from "./PaymentSig.sol";

/// Shared fixture: the full local deployment (DeployLocal) plus helpers that sign, pay, deliver and inspect,
/// the way the backend will.
abstract contract CorridorTest is Test {
    DeployLocal deployer;
    DeployLocal.Deployment d;

    address admin; // also treasury, pauser and compliance officer A
    address relayer;
    address sender;
    address receiver;
    address officerB;
    address marketMaker;
    uint256 senderKey;

    uint32 constant BASE = 6;
    uint32 constant ARC = 26;
    bytes32 constant TRH = keccak256("ivms101");

    function setUp() public virtual {
        deployer = new DeployLocal();
        d = deployer.deploy();
        (admin, relayer, sender, receiver) = (deployer.actor(0), deployer.actor(1), deployer.actor(2), deployer.actor(3));
        (officerB, marketMaker) = (deployer.actor(4), deployer.actor(5));
        senderKey = deployer.key(2);
    }

    // ------------------------------------------------------------ building and signing

    function _intent(bytes32 id, uint256 fee) internal view returns (PaymentRouter.PaymentIntent memory) {
        return PaymentRouter.PaymentIntent(id, receiver, sender, fee, ARC, TRH);
    }

    function _permit(uint256 amount, uint256 nonce) internal view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(address(d.usdc), amount), nonce, block.timestamp + 1 hours
        );
    }

    function _sign(PaymentRouter.PaymentIntent memory intent, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
        return PaymentSig.sign(
            d.permit2, address(d.router), permit, d.router.hashIntent(intent), d.router.INTENT_WITNESS(), senderKey
        );
    }

    function _signBatch(PaymentRouter.BatchIntent memory batch, ISignatureTransfer.PermitTransferFrom memory permit)
        internal
        view
        returns (bytes memory)
    {
        return PaymentSig.sign(
            d.permit2, address(d.router), permit, d.router.hashBatch(batch), d.router.BATCH_WITNESS(), senderKey
        );
    }

    function _legs(uint256 n, uint256 each) internal view returns (PaymentRouter.Leg[] memory legs) {
        legs = new PaymentRouter.Leg[](n);
        for (uint256 i; i < n; i++) {
            legs[i] = PaymentRouter.Leg(bytes32(i + 1), receiver, each, keccak256(abi.encode("ivms101", i)));
        }
    }

    // ------------------------------------------------------------ paying and delivering

    /// Sender signs, relayer submits; returns the CCTP message the attestation poller would fetch.
    function _pay(bytes32 id, uint256 gross, uint256 fee) internal returns (bytes memory) {
        PaymentRouter.PaymentIntent memory intent = _intent(id, fee);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(gross, uint256(keccak256(abi.encode(id))));
        bytes memory sig = _sign(intent, permit);
        vm.recordLogs();
        vm.prank(relayer);
        d.router.pay(intent, permit, sender, sig);
        return _lastMessage();
    }

    function _payBatch(PaymentRouter.Leg[] memory legs, uint256 fee, uint256 nonce) internal returns (bytes memory) {
        PaymentRouter.BatchIntent memory batch = PaymentRouter.BatchIntent(legs, sender, fee, ARC);
        uint256 net;
        for (uint256 i; i < legs.length; i++) {
            net += legs[i].amount;
        }
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(net + fee, nonce);
        bytes memory sig = _signBatch(batch, permit);
        vm.recordLogs();
        vm.prank(relayer);
        d.router.payBatch(batch, permit, sender, sig);
        return _lastMessage();
    }

    function _deliver(bytes memory message) internal returns (uint256 recorded) {
        vm.prank(relayer);
        recorded = d.escrow.receivePayment(message, "");
    }

    /// Pay and deliver one payment; returns its escrow key.
    function _escrowed(bytes32 id, uint256 gross, uint256 fee) internal returns (bytes32 key) {
        assertEq(_deliver(_pay(id, gross, fee)), 1);
        key = _key(id);
    }

    function _lastMessage() internal view returns (bytes memory) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].emitter == address(d.cctp) && logs[i - 1].topics[0] == keccak256("MessageSent(bytes)")) {
                return abi.decode(logs[i - 1].data, (bytes));
            }
        }
        revert("no MessageSent");
    }

    // ------------------------------------------------------------ liquidity-provider funding

    function _fund(bytes32 id, uint256 amount) internal returns (bytes32 key) {
        PaymentEscrow.Funding memory f = PaymentEscrow.Funding(id, sender, receiver, sender, address(d.usdc), amount, TRH);
        vm.prank(marketMaker);
        key = d.escrow.fundFromLiquidity(f);
    }

    // ------------------------------------------------------------ compliance

    function _twoOfficers(function(bytes32) external action, bytes32 key) internal {
        vm.prank(admin);
        action(key);
        vm.prank(officerB);
        action(key);
    }

    // ------------------------------------------------------------ reads

    function _key(bytes32 id) internal view returns (bytes32) {
        return d.escrow.paymentKey(BASE, id);
    }

    function _status(bytes32 key) internal view returns (PaymentEscrow.Status s) {
        (,,,,,, s) = d.escrow.payments(key);
    }

    function _amount(bytes32 key) internal view returns (uint128 a) {
        (,,,, a,,) = d.escrow.payments(key);
    }

    function _word(bytes memory b, uint256 offset) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(b, 32), offset))
        }
    }

    function _poke(bytes memory b, uint256 offset, bytes32 value) internal pure {
        assembly {
            mstore(add(add(b, 32), offset), value)
        }
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
