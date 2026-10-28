// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PQAccount} from "../src/PQAccount.sol";
import {CorridorTest} from "./utils/CorridorTest.sol";
import {PaymentSig} from "./utils/PaymentSig.sol";
import {PQSigner} from "./utils/PQSigner.sol";

contract PQAccountHarness is PQAccount {
    constructor(bytes32 r, bytes32 s, uint256 h) PQAccount(r, s, h) {}

    function verify(bytes32 m, Signature memory sig) external view returns (bool) {
        return _verify(m, sig);
    }
}

contract PQAccountTest is CorridorTest {
    PQSigner.Key k = PQSigner.Key("secret", "seed", 3);
    PQAccountHarness acct;
    address submitter = makeAddr("anySubmitter"); // pays gas only; holds no role

    function setUp() public override {
        super.setUp();
        acct = new PQAccountHarness(PQSigner.root(k), k.seed, k.height);
    }

    function _sig(PQSigner.Key memory key, uint256 leaf, bytes32 m) internal pure returns (PQAccount.Signature memory) {
        return PQSigner.sign(key, PQSigner.tree(key), leaf, m);
    }

    function _exec(uint256 leaf, address to, bytes memory data) internal returns (bytes memory) {
        uint256 deadline = block.timestamp + 1 hours;
        PQAccount.Signature memory sig = _sig(k, leaf, acct.executeDigest(to, data, deadline));
        vm.prank(submitter);
        return acct.execute(to, data, deadline, sig);
    }

    // ------------------------------------------------------------ as a role holder

    /// Officer B is a post-quantum account: the second approval of a refund needs no ECDSA key at all.
    function test_complianceOfficer_secondApprovalRefunds() public {
        bytes32 officer = d.escrow.COMPLIANCE_OFFICER();
        vm.prank(admin);
        d.escrow.grantRole(officer, address(acct));
        bytes32 key = _escrowed("inv-1", 100e6, 1e6);
        vm.startPrank(admin);
        d.escrow.freeze(key);
        d.escrow.refund(key); // officer A proposes
        vm.stopPrank();

        bytes memory data = abi.encodeCall(PaymentEscrow.refund, (key));
        uint256 deadline = block.timestamp + 1 hours;
        PQAccount.Signature memory sig = _sig(k, 0, acct.executeDigest(address(d.escrow), data, deadline));
        vm.prank(submitter);
        uint256 g = gasleft();
        acct.execute(address(d.escrow), data, deadline, sig);
        emit log_named_uint("gas: PQ officer approval incl. refund", g - gasleft());
        assertEq(uint8(_status(key)), uint8(PaymentEscrow.Status.Refunded));

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(PQAccount.LeafSpent.selector, 0));
        acct.execute(address(d.escrow), data, deadline, sig);
    }

    function test_withoutTheRole_callReverts() public {
        bytes32 key = _escrowed("inv-1", 100e6, 1e6);
        bytes memory data = abi.encodeCall(PaymentEscrow.freeze, (key));
        uint256 deadline = block.timestamp + 1 hours;
        PQAccount.Signature memory sig = _sig(k, 0, acct.executeDigest(address(d.escrow), data, deadline));
        vm.expectRevert(); // AccessControlUnauthorizedAccount(acct, FREEZER)
        acct.execute(address(d.escrow), data, deadline, sig);
        assertFalse(acct.spent(acct.root(), 0), "failed call leaves the leaf unburnt");
    }

    // ------------------------------------------------------------ as a sender (ERC-1271 through Permit2)

    function test_sender_paysThroughPermit2() public {
        d.usdc.mint(address(acct), 100e6);
        _exec(0, address(d.usdc), abi.encodeWithSignature("approve(address,uint256)", d.permit2, type(uint256).max));

        PaymentRouter.PaymentIntent memory intent = PaymentRouter.PaymentIntent("pq-1", receiver, address(acct), 1e6, ARC, TRH);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit(100e6, 1);
        bytes32 digest = PaymentSig.digest(d.permit2, address(d.router), permit, d.router.hashIntent(intent), d.router.INTENT_WITNESS());
        bytes memory sig = abi.encode(_sig(k, 1, acct.erc1271Digest(digest)));
        emit log_named_uint("signature bytes", sig.length);
        assertEq(acct.isValidSignature(digest, sig), bytes4(0x1626ba7e));
        assertEq(acct.isValidSignature(keccak256("other"), sig), bytes4(0xffffffff));

        vm.recordLogs();
        vm.prank(relayer);
        uint256 g = gasleft();
        d.router.pay(intent, permit, address(acct), sig);
        emit log_named_uint("gas: router.pay with PQ signature", g - gasleft());
        bytes memory m = _lastMessage();
        assertEq(d.usdc.balanceOf(address(acct)), 0);
        assertEq(uint256(_word(m, 148 + 68)), 99e6);

        // leaf 0 was burnt by execute, so it no longer validates either
        bytes memory burnt = abi.encode(_sig(k, 0, acct.erc1271Digest(digest)));
        assertEq(acct.isValidSignature(digest, burnt), bytes4(0xffffffff));
    }

    // ------------------------------------------------------------ the signature binds everything

    function test_rejects_otherCallDeadlineAndBadPaths() public {
        bytes memory data = abi.encodeCall(PQAccount.rotate, (bytes32(0), bytes32(0)));
        uint256 deadline = block.timestamp + 1 hours;
        PQAccount.Signature memory sig = _sig(k, 2, acct.executeDigest(address(acct), data, deadline));

        vm.expectRevert(PQAccount.BadSignature.selector); // another call
        acct.execute(address(acct), abi.encodeCall(PQAccount.rotate, (bytes32(uint256(1)), bytes32(0))), deadline, sig);
        vm.expectRevert(PQAccount.BadSignature.selector); // another deadline
        acct.execute(address(acct), data, deadline + 1, sig);

        PQAccount.Signature memory bad = sig;
        bad.leaf = 3; // the path belongs to leaf 2
        vm.expectRevert(PQAccount.BadSignature.selector);
        acct.execute(address(acct), data, deadline, bad);
        bad.leaf = 8; // outside the tree
        vm.expectRevert(PQAccount.BadSignature.selector);
        acct.execute(address(acct), data, deadline, bad);
        bad = sig;
        bad.path = new bytes32[](2);
        vm.expectRevert(PQAccount.BadSignature.selector);
        acct.execute(address(acct), data, deadline, bad);

        vm.warp(deadline + 1);
        vm.expectRevert(PQAccount.Expired.selector);
        acct.execute(address(acct), data, deadline, sig);
    }

    /// Raising a digit means hashing its chain forward, which anyone can do; the checksum digits then drop, and
    /// those would need a preimage.
    function test_checksumStopsForgingByHashingForward() public view {
        bytes32 m = bytes32(uint256(0x3) << 252 | 0x1234);
        PQAccount.Signature memory sig = _sig(k, 4, m);
        assertTrue(acct.verify(m, sig));

        bytes32 raised = bytes32(uint256(m) + (1 << 252)); // first digit 3 -> 4
        sig.wots[0] = PQSigner.chain(k, sig.wots[0], 4, 0, 3, 4);
        assertFalse(acct.verify(raised, sig));
    }

    function testFuzz_signVerify(bytes32 m, uint8 leaf) public view {
        PQAccount.Signature memory sig = _sig(k, leaf % 8, m);
        assertTrue(acct.verify(m, sig));
        assertFalse(acct.verify(m ^ bytes32(uint256(1)), sig));
    }

    // ------------------------------------------------------------ key rotation

    function test_rotate_onlyThroughASignedExecute() public {
        vm.expectRevert(PQAccount.OnlySelf.selector);
        acct.rotate(bytes32(0), bytes32(0));

        PQSigner.Key memory k2 = PQSigner.Key("secret2", "seed2", 3);
        _exec(5, address(acct), abi.encodeCall(PQAccount.rotate, (PQSigner.root(k2), k2.seed)));
        assertEq(acct.root(), PQSigner.root(k2));

        bytes32 m = acct.erc1271Digest(keccak256("x"));
        assertEq(acct.isValidSignature(keccak256("x"), abi.encode(_sig(k, 6, m))), bytes4(0xffffffff), "old tree");
        assertEq(acct.isValidSignature(keccak256("x"), abi.encode(_sig(k2, 6, m))), bytes4(0x1626ba7e), "new tree");
    }

    function test_constructorRejectsBadHeight() public {
        vm.expectRevert(PQAccount.BadHeight.selector);
        new PQAccount(bytes32(0), bytes32(0), 0);
        vm.expectRevert(PQAccount.BadHeight.selector);
        new PQAccount(bytes32(0), bytes32(0), 21);
    }
}
