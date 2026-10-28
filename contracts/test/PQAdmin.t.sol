// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {PQAccount} from "../src/PQAccount.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";
import {PQSigner} from "./utils/PQSigner.sol";

/// DEFAULT_ADMIN held by a timelock whose only proposer is a post-quantum account: every admin action is signed with
/// a hash-based key and waits out the delay, during which it can be seen and cancelled.
contract PQAdminTest is CorridorTest {
    PQSigner.Key k = PQSigner.Key("admin-secret", "admin-seed", 3);
    PQAccount pq;
    TimelockController timelock;
    uint256 constant DELAY = 2 days;
    address offRamp = makeAddr("newOffRamp");

    function setUp() public override {
        super.setUp();
        pq = new PQAccount(PQSigner.root(k), k.seed, k.height);
        address[] memory proposers = new address[](1);
        proposers[0] = address(pq);
        address[] memory executors = new address[](1); // address(0): anyone executes once the delay has passed
        timelock = new TimelockController(DELAY, proposers, executors, address(0));

        // The handover Deploy.handover() does: grant to the timelock, then the deployer renounces.
        bytes32 adminRole = d.escrow.DEFAULT_ADMIN_ROLE();
        vm.startPrank(admin);
        d.escrow.grantRole(adminRole, address(timelock));
        d.escrow.renounceRole(adminRole, admin);
        vm.stopPrank();
    }

    function _pqCall(uint256 leaf, address to, bytes memory data) internal {
        uint256 deadline = block.timestamp + 1 hours;
        PQAccount.Signature memory sig = PQSigner.sign(k, PQSigner.tree(k), leaf, pq.executeDigest(to, data, deadline));
        pq.execute(to, data, deadline, sig);
    }

    function _schedule(uint256 leaf, bytes memory call, bytes32 salt) internal {
        _pqCall(leaf, address(timelock), abi.encodeCall(TimelockController.schedule, (address(d.escrow), 0, call, 0, salt, DELAY)));
    }

    function test_adminAction_signedPQ_waitsOutTheDelay() public {
        bytes memory call = abi.encodeCall(PaymentEscrow.setOffRamp, (offRamp, true));
        _schedule(0, call, "1");

        vm.expectRevert(); // TimelockUnexpectedOperationState: not ready yet
        timelock.execute(address(d.escrow), 0, call, 0, "1");

        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(d.escrow), 0, call, 0, "1"); // any account; no key needed
        assertTrue(d.escrow.approvedOffRamp(offRamp));
    }

    function test_oldEcdsaAdminHasNoPowerLeft() public {
        bytes32 adminRole = d.escrow.DEFAULT_ADMIN_ROLE();
        assertFalse(d.escrow.hasRole(adminRole, admin));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, adminRole));
        d.escrow.setOffRamp(offRamp, true);
    }

    function test_onlyThePQProposerSchedules() public {
        bytes memory call = abi.encodeCall(PaymentEscrow.setOffRamp, (offRamp, true));
        vm.prank(admin);
        vm.expectRevert(); // AccessControlUnauthorizedAccount(admin, PROPOSER_ROLE)
        timelock.schedule(address(d.escrow), 0, call, 0, "1", DELAY);
    }

    /// A suspicious pending action (say, scheduled with a stolen leaf) is cancelled before it can run.
    function test_pendingActionCanBeCancelled() public {
        bytes memory call = abi.encodeCall(PaymentEscrow.setOffRamp, (offRamp, true));
        _schedule(0, call, "1");
        bytes32 id = timelock.hashOperation(address(d.escrow), 0, call, 0, "1");
        _pqCall(1, address(timelock), abi.encodeCall(TimelockController.cancel, (id)));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert();
        timelock.execute(address(d.escrow), 0, call, 0, "1");
        assertFalse(d.escrow.approvedOffRamp(offRamp));
    }

    /// Incident response is not delayed: an officer still pauses at once, and freezes keep working.
    function test_pauseAndFreezeStayImmediate() public {
        bytes32 key = _escrowed("inv-1", 100e6, 1e6);
        vm.prank(officerB);
        d.escrow.pause();
        assertTrue(d.escrow.paused());
        vm.prank(officerB);
        d.escrow.freeze(key);
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Frozen));
    }

    /// The script step itself: grant to the timelock, renounce from the broadcaster, refuse a non-timelock.
    function test_deployHandover_movesAdminAndRenounces() public {
        FeeVault a = new FeeVault(DEFAULT_SENDER);
        FeeVault b = new FeeVault(DEFAULT_SENDER);
        vm.setEnv("TIMELOCK", vm.toString(address(timelock)));
        vm.setEnv("ADMIN_CONTRACTS", string.concat(vm.toString(address(a)), ",", vm.toString(address(b))));
        new Deploy().handover();
        for (uint256 i; i < 2; i++) {
            FeeVault v = i == 0 ? a : b;
            assertTrue(v.hasRole(0x00, address(timelock)));
            assertFalse(v.hasRole(0x00, DEFAULT_SENDER));
        }

        vm.setEnv("TIMELOCK", vm.toString(address(pq))); // not a timelock
        Deploy dep = new Deploy();
        vm.expectRevert();
        dep.handover();
    }
}
