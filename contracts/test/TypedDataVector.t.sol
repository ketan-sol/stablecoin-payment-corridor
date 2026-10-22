// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {PaymentSig} from "./utils/PaymentSig.sol";

/// Cross-language check: the backend/frontend EIP-712 builder (packages/shared paymentTypedData, hashed with viem)
/// and the contracts agree on the digest for one fixed vector. backend/test/unit.test.ts asserts the same constant.
contract TypedDataVectorTest is Test {
    bytes32 constant TS_DIGEST = 0x793ad616e298d1c55d3432ad6165a19384d4bd83eaa04b644e66312155903035;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function test_digestMatchesTheTypeScriptBuilder() public {
        deployCodeTo("Permit2.sol:Permit2", PERMIT2); // real Permit2 at its canonical address, chain id 31337
        PaymentRouter router = new PaymentRouter(
            address(this), ISignatureTransfer(PERMIT2), ITokenMessengerV2(address(1)), address(2), address(3), 26
        );
        PaymentRouter.PaymentIntent memory intent = PaymentRouter.PaymentIntent(
            bytes32(0xabababababababababababababababababababababababababababababababab),
            0x5000000000000000000000000000000000000002,
            0x5000000000000000000000000000000000000001,
            3_000_000,
            26,
            bytes32(0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd)
        );
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(0x00000000000000000000000000000000000005dC, 1_003_000_000), 7, 1_800_000_000
        );
        bytes32 digest = PaymentSig.digest(
            PERMIT2, 0x0000000000000000000000000000000000007007, permit, router.hashIntent(intent), router.INTENT_WITNESS()
        );
        assertEq(block.chainid, 31337);
        assertEq(digest, TS_DIGEST);
    }
}
