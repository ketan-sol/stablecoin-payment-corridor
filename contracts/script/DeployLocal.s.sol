// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {SanctionsOracle} from "../src/SanctionsOracle.sol";
import {MockStablecoin} from "../test/utils/Mocks.sol";
import {LocalCCTP} from "../test/utils/LocalCCTP.sol";

/// Everything on one Anvil chain, wired and seeded for local development:
///   anvil
///   forge build && forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
/// Addresses go to deployments/local.json.
/// Accounts (Anvil's default mnemonic):
///   0 admin (also treasury, pauser, compliance officer A)   1 relayer   2 sender (business)   3 receiver (supplier)
///   4 compliance officer B (second approver)                 5 market maker   6 off-ramp (mock bank)
contract DeployLocal is Script {
    string constant MNEMONIC = "test test test test test test test test test test test junk";
    uint32 public constant SOURCE_DOMAIN = 6; // plays Base
    uint32 public constant SETTLEMENT_DOMAIN = 26; // plays Arc
    uint256 public constant SENDER_FUNDS = 1_000_000e6;
    uint256 public constant MARKET_MAKER_FUNDS = 1_000_000e6;
    uint64 public constant KYB_VALID_FOR = 365 days;

    struct Deployment {
        MockStablecoin usdc;
        address permit2;
        LocalCCTP cctp;
        SanctionsOracle oracle;
        ComplianceRegistry registry;
        PaymentEscrow escrow;
        FeeVault feeVault;
        PaymentRouter router;
    }

    function run() external {
        Deployment memory d = deploy();
        string memory j = "local";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "sourceDomain", SOURCE_DOMAIN);
        vm.serializeUint(j, "settlementDomain", SETTLEMENT_DOMAIN);
        vm.serializeAddress(j, "usdc", address(d.usdc));
        vm.serializeAddress(j, "permit2", d.permit2);
        // One contract plays both CCTP roles locally.
        vm.serializeAddress(j, "tokenMessenger", address(d.cctp));
        vm.serializeAddress(j, "messageTransmitter", address(d.cctp));
        vm.serializeAddress(j, "sanctionsOracle", address(d.oracle));
        vm.serializeAddress(j, "registry", address(d.registry));
        vm.serializeAddress(j, "escrow", address(d.escrow));
        vm.serializeAddress(j, "feeVault", address(d.feeVault));
        vm.serializeAddress(j, "router", address(d.router));
        vm.serializeAddress(j, "admin", actor(0));
        vm.serializeAddress(j, "relayer", actor(1));
        vm.serializeAddress(j, "sender", actor(2));
        vm.serializeAddress(j, "receiver", actor(3));
        vm.serializeAddress(j, "officerB", actor(4));
        vm.serializeAddress(j, "marketMaker", actor(5));
        string memory out = vm.serializeAddress(j, "offRamp", actor(6));
        vm.createDir("deployments", true);
        vm.writeJson(out, "deployments/local.json");
        console.log("wrote deployments/local.json");
    }

    function deploy() public returns (Deployment memory d) {
        vm.startBroadcast(key(0));
        d.usdc = new MockStablecoin("USDC");
        d.permit2 = deployCode("Permit2.sol:Permit2");
        d.cctp = new LocalCCTP(SOURCE_DOMAIN);
        _settlement(d);
        _source(d);
        vm.stopBroadcast();
        _seedAccounts(d);
    }

    // Arc side: oracle, registry and escrow behind UUPS proxies, roles, KYB for the demo parties.
    function _settlement(Deployment memory d) private {
        address admin = actor(0);
        d.oracle = new SanctionsOracle(admin);
        d.registry = ComplianceRegistry(
            address(
                new ERC1967Proxy(
                    address(new ComplianceRegistry()),
                    abi.encodeCall(ComplianceRegistry.initialize, (admin, ISanctionsList(address(d.oracle))))
                )
            )
        );
        d.escrow = PaymentEscrow(
            address(
                new ERC1967Proxy(
                    address(new PaymentEscrow()),
                    abi.encodeCall(
                        PaymentEscrow.initialize,
                        (
                            admin,
                            d.registry,
                            d.cctp,
                            address(d.cctp),
                            IERC20(address(d.usdc)),
                            uint64(vm.envOr("REFUND_WINDOW", uint256(72 hours)))
                        )
                    )
                )
            )
        );
        d.escrow.grantRole(d.escrow.RELAYER(), actor(1));
        d.escrow.grantRole(d.escrow.PAYOUT_OPERATOR(), actor(1));
        d.escrow.grantRole(d.escrow.COMPLIANCE_OFFICER(), admin);
        d.escrow.grantRole(d.escrow.COMPLIANCE_OFFICER(), actor(4));
        d.escrow.grantRole(d.escrow.FREEZER(), actor(1)); // the backend's automatic hold
        d.escrow.setOffRamp(actor(6), true); // the mock bank's settlement account
        d.escrow.grantRole(d.escrow.MARKET_MAKER(), actor(5));
        d.registry.grantRole(d.registry.COMPLIANCE_OFFICER(), actor(1)); // the backend writes KYB results
        d.registry.grantRole(d.registry.COMPLIANCE_OFFICER(), admin);
        uint64 until = uint64(block.timestamp + KYB_VALID_FOR);
        d.registry.setAttestation(actor(2), keccak256("kyb:sender"), until);
        d.registry.setAttestation(actor(3), keccak256("kyb:receiver"), until);
    }

    // Source side: fee vault and router; the escrow trusts the router's burns.
    function _source(Deployment memory d) private {
        address admin = actor(0);
        d.feeVault = new FeeVault(admin);
        d.feeVault.grantRole(d.feeVault.TREASURY(), admin);
        d.feeVault.grantRole(d.feeVault.PAUSER(), admin);
        d.router = new PaymentRouter(
            admin,
            ISignatureTransfer(d.permit2),
            ITokenMessengerV2(address(d.cctp)),
            address(d.feeVault),
            address(d.escrow),
            SETTLEMENT_DOMAIN
        );
        d.router.grantRole(d.router.RELAYER(), actor(1));
        d.router.grantRole(d.router.PAUSER(), admin);
        d.escrow.setRouter(SOURCE_DOMAIN, address(d.router), true);
    }

    // The sender's one-time Permit2 approval and the market maker's (liquidity provider's) float.
    function _seedAccounts(Deployment memory d) private {
        vm.startBroadcast(key(0));
        d.usdc.mint(actor(2), SENDER_FUNDS);
        d.usdc.mint(actor(5), MARKET_MAKER_FUNDS);
        vm.stopBroadcast();

        vm.startBroadcast(key(2));
        d.usdc.approve(d.permit2, type(uint256).max);
        vm.stopBroadcast();

        vm.startBroadcast(key(5));
        d.usdc.approve(address(d.escrow), type(uint256).max);
        vm.stopBroadcast();
    }

    function key(uint32 i) public pure returns (uint256) {
        return vm.deriveKey(MNEMONIC, i);
    }

    function actor(uint32 i) public pure returns (address) {
        return vm.addr(key(i));
    }
}
