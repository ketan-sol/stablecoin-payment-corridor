// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../../src/interfaces/IMessageTransmitterV2.sol";
import {ISanctionsList} from "../../src/interfaces/ISanctionsList.sol";
import {PaymentRouter} from "../../src/PaymentRouter.sol";
import {PaymentEscrow} from "../../src/PaymentEscrow.sol";
import {ComplianceRegistry} from "../../src/ComplianceRegistry.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {SanctionsOracle} from "../../src/SanctionsOracle.sol";
import {PaymentSig} from "../utils/PaymentSig.sol";

/// Against the real Circle CCTP V2, Permit2 and USDC on testnet forks. Skipped unless the RPC URL is set:
///   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org ARC_RPC_URL=https://rpc.testnet.arc.io forge test --match-path test/fork/*
contract CctpForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant MESSAGE_TRANSMITTER = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint32 constant ARC = 26;

    address escrow = makeAddr("escrowOnArc");
    address relayer = makeAddr("relayer");
    address receiver = makeAddr("supplier");
    uint256 senderKey = 0xA11CE;
    address sender = vm.addr(senderKey);

    function _forkOrSkip(string memory envVar) internal returns (bool) {
        string memory url = vm.envOr(envVar, string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        return true;
    }

    /// The source half on Base Sepolia: Permit2 pull, fee to the vault, burn with hook data via the real messenger.
    function test_baseSepolia_payBurnsThroughRealCctp() public {
        if (!_forkOrSkip("BASE_SEPOLIA_RPC_URL")) return;
        FeeVault vault = new FeeVault(address(this));
        PaymentRouter router = new PaymentRouter(
            address(this), ISignatureTransfer(PERMIT2), ITokenMessengerV2(TOKEN_MESSENGER), address(vault), escrow, ARC
        );
        router.grantRole(router.RELAYER(), relayer);

        deal(BASE_SEPOLIA_USDC, sender, 1_000e6);
        vm.prank(sender);
        IERC20(BASE_SEPOLIA_USDC).approve(PERMIT2, type(uint256).max);

        PaymentRouter.PaymentIntent memory intent =
            PaymentRouter.PaymentIntent("fork-1", receiver, sender, 1e6, ARC, keccak256("ivms101"));
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(BASE_SEPOLIA_USDC, 100e6), 42, block.timestamp + 1 hours
        );
        bytes memory sig = PaymentSig.sign(
            PERMIT2, address(router), permit, router.hashIntent(intent), router.INTENT_WITNESS(), senderKey
        );

        vm.recordLogs();
        vm.prank(relayer);
        router.pay(intent, permit, sender, sig);

        bytes memory m = _messageSent(vm.getRecordedLogs());
        bytes32 e = bytes32(uint256(uint160(escrow)));
        assertEq(uint32(bytes4(_word(m, 4))), 6, "source domain: Base");
        assertEq(uint32(bytes4(_word(m, 8))), ARC, "destination domain: Arc");
        assertEq(_word(m, 108), e, "destinationCaller");
        assertEq(_word(m, 148 + 36), e, "mintRecipient");
        assertEq(uint256(_word(m, 148 + 68)), 99e6, "amount");
        assertEq(_word(m, 148 + 100), bytes32(uint256(uint160(address(router)))), "messageSender");
        assertEq(_word(m, 148 + 228), bytes32(uint256(uint160(sender))), "hookData starts with the sender");
        assertEq(IERC20(BASE_SEPOLIA_USDC).balanceOf(address(vault)), 1e6);
    }

    /// The settlement half on Arc: the escrow is wired to the real transmitter, which rejects an unattested message.
    function test_arc_realTransmitterRejectsForgedMessage() public {
        if (!_forkOrSkip("ARC_RPC_URL")) return;
        SanctionsOracle oracle = new SanctionsOracle(address(this));
        ComplianceRegistry registry = ComplianceRegistry(
            address(
                new ERC1967Proxy(
                    address(new ComplianceRegistry()),
                    abi.encodeCall(ComplianceRegistry.initialize, (address(this), ISanctionsList(address(oracle))))
                )
            )
        );
        PaymentEscrow e = PaymentEscrow(
            address(
                new ERC1967Proxy(
                    address(new PaymentEscrow()),
                    abi.encodeCall(
                        PaymentEscrow.initialize,
                        (
                            address(this),
                            registry,
                            IMessageTransmitterV2(MESSAGE_TRANSMITTER),
                            TOKEN_MESSENGER,
                            IERC20(ARC_USDC),
                            72 hours
                        )
                    )
                )
            )
        );
        e.grantRole(e.RELAYER(), relayer);

        bytes32 eb = bytes32(uint256(uint160(address(e))));
        bytes memory forged = abi.encodePacked(
            uint32(1), uint32(6), ARC, bytes32(uint256(123)), bytes32(uint256(uint160(TOKEN_MESSENGER))),
            bytes32(uint256(uint160(TOKEN_MESSENGER))), eb, uint32(2000), uint32(2000),
            abi.encodePacked(uint32(1), bytes32(0), eb, uint256(1e6), bytes32(0), uint256(0), uint256(0), uint256(0))
        );
        vm.prank(relayer);
        vm.expectRevert(); // bad attestation
        e.receivePayment(forged, hex"00");
    }

    function _messageSent(Vm.Log[] memory logs) internal pure returns (bytes memory) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == MESSAGE_TRANSMITTER && logs[i].topics[0] == keccak256("MessageSent(bytes)")) {
                return abi.decode(logs[i].data, (bytes));
            }
        }
        revert("no MessageSent from the real transmitter");
    }

    function _word(bytes memory b, uint256 offset) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(b, 32), offset))
        }
    }
}
