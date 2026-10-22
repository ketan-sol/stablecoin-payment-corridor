// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ComplianceRegistry} from "../src/ComplianceRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";

contract ComplianceRegistryV2 is ComplianceRegistry {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// ComplianceRegistry, SanctionsOracle and FeeVault.
contract ComplianceTest is CorridorTest {
    address supplier2 = makeAddr("supplier2");

    // ------------------------------------------------------------ registry

    function test_attestation_allowsUntilExpiryOrRevoke() public {
        uint256 t0 = block.timestamp; // via-IR may cache block.timestamp across vm.warp, so keep our own clock
        assertFalse(d.registry.isAllowed(sender, supplier2));
        vm.prank(relayer); // the backend's key holds COMPLIANCE_OFFICER on the registry
        d.registry.setAttestation(supplier2, keccak256("eas-uid"), uint64(t0 + 30 days));
        assertTrue(d.registry.isAllowed(sender, supplier2));

        vm.warp(t0 + 30 days);
        assertFalse(d.registry.isVerified(supplier2), "expired");

        vm.prank(relayer);
        d.registry.setAttestation(supplier2, keccak256("eas-uid-2"), uint64(t0 + 60 days));
        vm.prank(relayer);
        d.registry.revokeAttestation(supplier2);
        assertFalse(d.registry.isAllowed(sender, supplier2));
    }

    function test_attestation_inputChecksAndRole() public {
        vm.startPrank(relayer);
        vm.expectRevert(ComplianceRegistry.ZeroValue.selector);
        d.registry.setAttestation(supplier2, bytes32(0), uint64(block.timestamp + 1));
        vm.expectRevert(ComplianceRegistry.AlreadyExpired.selector);
        d.registry.setAttestation(supplier2, keccak256("uid"), uint64(block.timestamp));
        vm.stopPrank();

        vm.prank(sender);
        vm.expectRevert();
        d.registry.setAttestation(sender, keccak256("self-attest"), uint64(block.timestamp + 1));
    }

    function test_sanctionsOracle_blocksEitherParty() public {
        assertTrue(d.registry.isAllowed(sender, receiver));
        address[] memory hit = new address[](1);
        hit[0] = sender;
        vm.prank(admin);
        d.oracle.addToSanctionsList(hit);
        assertFalse(d.registry.isAllowed(sender, receiver));
        assertFalse(d.registry.isAllowed(receiver, sender));

        vm.prank(admin);
        d.oracle.removeFromSanctionsList(hit);
        assertTrue(d.registry.isAllowed(sender, receiver));

        vm.prank(sender);
        vm.expectRevert();
        d.oracle.addToSanctionsList(hit);
    }

    function test_brokenOracleFailsClosed() public {
        vm.prank(admin);
        d.registry.setSanctionsOracle(ISanctionsList(makeAddr("noCode")));
        vm.expectRevert();
        d.registry.isAllowed(sender, receiver);
    }

    function test_registryUpgrade_onlyAdmin_keepsState() public {
        address v2 = address(new ComplianceRegistryV2());
        vm.prank(relayer);
        vm.expectRevert();
        d.registry.upgradeToAndCall(v2, "");

        vm.prank(admin);
        d.registry.upgradeToAndCall(v2, "");
        assertEq(ComplianceRegistryV2(address(d.registry)).version(), 2);
        assertTrue(d.registry.isAllowed(sender, receiver));
    }

    function test_registryInitializeOnce() public {
        vm.expectRevert();
        d.registry.initialize(sender, d.oracle);
    }

    // ------------------------------------------------------------ fee vault

    function test_feeVault_onlyTreasuryWithdraws() public {
        _pay("inv-1", 100e6, 3e6);
        assertEq(d.usdc.balanceOf(address(d.feeVault)), 3e6);

        vm.prank(relayer);
        vm.expectRevert();
        d.feeVault.withdraw(IERC20(address(d.usdc)), relayer, 3e6);

        vm.prank(admin);
        d.feeVault.withdraw(IERC20(address(d.usdc)), makeAddr("ops"), 3e6);
        assertEq(d.usdc.balanceOf(makeAddr("ops")), 3e6);
    }

    function test_feeVault_pauseAndZeroChecks() public {
        _pay("inv-1", 100e6, 3e6);
        vm.startPrank(admin);
        vm.expectRevert(FeeVault.ZeroValue.selector);
        d.feeVault.withdraw(IERC20(address(d.usdc)), address(0), 1);
        d.feeVault.pause();
        vm.expectRevert();
        d.feeVault.withdraw(IERC20(address(d.usdc)), admin, 1);
        d.feeVault.unpause();
        d.feeVault.withdraw(IERC20(address(d.usdc)), admin, 1);
        vm.stopPrank();
    }
}
