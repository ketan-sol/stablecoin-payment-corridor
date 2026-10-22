// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../src/interfaces/IMessageTransmitterV2.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {SanctionsOracle} from "../src/SanctionsOracle.sol";

/// Testnet deployment, in order (`node scripts/testnet.mjs keys` writes contracts/.env, which forge loads):
///   0. (optional) timelock for DEFAULT_ADMIN, on each chain:  --sig "timelock()"
///   1. Arc:            forge script script/Deploy.s.sol --sig "settlement()" --rpc-url $ARC_RPC_URL --broadcast
///   2. Each source:    forge script script/Deploy.s.sol --sig "source()" --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
///                      (CREATE2: FeeVault and PaymentRouter get the same addresses on every source chain)
///   3. Arc, per chain: forge script script/Deploy.s.sol --sig "trustRouter()" --rpc-url $ARC_RPC_URL --broadcast
/// The broadcaster must be ADMIN for the role grants; hand DEFAULT_ADMIN to the timelock or Safe afterwards.
contract Deploy is Script {
    bytes32 constant SALT = keccak256("corridor.v3");

    // ---------------------------------------------------------------- 1. settlement chain

    function settlement() external {
        address admin = vm.envAddress("ADMIN");
        address relayer = vm.envAddress("RELAYER");

        vm.startBroadcast();
        // The Chainalysis oracle only exists on mainnets; testnets get the stand-in unless SANCTIONS_ORACLE is set.
        address oracle = vm.envOr("SANCTIONS_ORACLE", address(0));
        if (oracle == address(0)) oracle = address(new SanctionsOracle(admin));

        ComplianceRegistry registry = ComplianceRegistry(
            address(
                new ERC1967Proxy(
                    address(new ComplianceRegistry()),
                    abi.encodeCall(ComplianceRegistry.initialize, (admin, ISanctionsList(oracle)))
                )
            )
        );
        PaymentEscrow escrow = PaymentEscrow(
            address(
                new ERC1967Proxy(
                    address(new PaymentEscrow()),
                    abi.encodeCall(
                        PaymentEscrow.initialize,
                        (
                            admin,
                            registry,
                            IMessageTransmitterV2(vm.envAddress("MESSAGE_TRANSMITTER")),
                            vm.envAddress("TOKEN_MESSENGER"),
                            IERC20(vm.envAddress("USDC")),
                            uint64(vm.envOr("REFUND_WINDOW", uint256(72 hours)))
                        )
                    )
                )
            )
        );
        escrow.grantRole(escrow.RELAYER(), relayer);
        escrow.grantRole(escrow.PAYOUT_OPERATOR(), vm.envOr("PAYOUT_OPERATOR", relayer));
        escrow.grantRole(escrow.COMPLIANCE_OFFICER(), vm.envAddress("OFFICER_A"));
        escrow.grantRole(escrow.COMPLIANCE_OFFICER(), vm.envAddress("OFFICER_B"));
        escrow.grantRole(escrow.FREEZER(), relayer); // automatic hold on a sanctions or KYB hit
        escrow.setOffRamp(vm.envAddress("OFF_RAMP"), true); // the bank partner's settlement account
        registry.grantRole(registry.COMPLIANCE_OFFICER(), relayer); // the backend writes KYB results
        vm.stopBroadcast();

        console.log("SanctionsOracle   ", oracle);
        console.log("ComplianceRegistry", address(registry));
        console.log("PaymentEscrow     ", address(escrow));

        string memory j = "settlement";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "sanctionsOracle", oracle);
        vm.serializeAddress(j, "registry", address(registry));
        _write(vm.serializeAddress(j, "escrow", address(escrow)), "settlement");
    }

    // ---------------------------------------------------------------- 2. each source chain

    function source() external {
        address admin = vm.envAddress("ADMIN");
        vm.startBroadcast();
        // Same arguments on every chain (Permit2 and the testnet TokenMessengerV2 share addresses), so CREATE2 through
        // the standard deployer gives one FeeVault and one router address everywhere.
        FeeVault vault = new FeeVault{salt: SALT}(admin);
        PaymentRouter router = new PaymentRouter{salt: SALT}(
            admin,
            ISignatureTransfer(vm.envAddress("PERMIT2")),
            ITokenMessengerV2(vm.envAddress("TOKEN_MESSENGER")),
            address(vault),
            vm.envAddress("ESCROW"),
            uint32(vm.envUint("SETTLEMENT_DOMAIN"))
        );
        router.grantRole(router.RELAYER(), vm.envAddress("RELAYER"));
        router.grantRole(router.PAUSER(), admin);
        vault.grantRole(vault.TREASURY(), vm.envOr("TREASURY", admin));
        vault.grantRole(vault.PAUSER(), admin);
        vm.stopBroadcast();

        console.log("FeeVault     ", address(vault));
        console.log("PaymentRouter", address(router));

        string memory j = "source";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "feeVault", address(vault));
        _write(vm.serializeAddress(j, "router", address(router)), "source");
    }

    /// deployments/<role>-<chainId>.json, read by scripts/testnet.mjs to fill backend/.env.
    function _write(string memory json, string memory role) internal {
        string memory path = string.concat("deployments/", role, "-", vm.toString(block.chainid), ".json");
        vm.createDir("deployments", true);
        vm.writeJson(json, path);
        console.log("wrote", path);
    }

    // ---------------------------------------------------------------- 3. back on the settlement chain

    /// Only burns from a trusted router become payments (env: ESCROW, SOURCE_DOMAIN, ROUTER).
    function trustRouter() external {
        vm.startBroadcast();
        PaymentEscrow(vm.envAddress("ESCROW")).setRouter(uint32(vm.envUint("SOURCE_DOMAIN")), vm.envAddress("ROUTER"), true);
        vm.stopBroadcast();
    }

    // ---------------------------------------------------------------- 0. optional: timelock for DEFAULT_ADMIN

    /// A TimelockController with a Safe (or EOA) as proposer and executor. Then grant DEFAULT_ADMIN_ROLE to it on
    /// each contract and renounce it from the deployer (env: SAFE, TIMELOCK_DELAY seconds).
    function timelock() external {
        address[] memory safe = new address[](1);
        safe[0] = vm.envAddress("SAFE");
        vm.startBroadcast();
        TimelockController t = new TimelockController(vm.envOr("TIMELOCK_DELAY", uint256(2 days)), safe, safe, address(0));
        vm.stopBroadcast();
        console.log("TimelockController", address(t));
    }
}
