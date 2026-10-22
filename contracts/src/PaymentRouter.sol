// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

/// @title PaymentRouter (source chains)
/// @notice One Permit2 witness signature pays a supplier (`pay`) or a batch of suppliers in one net transfer
///         (`payBatch`): pull the token, send the signed fee to the FeeVault, burn the rest via CCTP into the escrow
///         on the settlement chain, with every payment in the hook data.
/// @dev Immutable and stateless apart from roles and the pause switch: every constructor argument is the same on each
///      chain, so a CREATE2 deploy gives one router address everywhere. Replays are stopped by Permit2 nonces, and
///      payment IDs are unique per source domain in the escrow. The burn token comes from the signed permit, and
///      CCTP reverts for anything it cannot burn, so no token list is stored here.
contract PaymentRouter is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER = keccak256("RELAYER");
    bytes32 public constant PAUSER = keccak256("PAUSER");

    /// Largest batch: each leg costs the escrow one payment record when the message lands.
    uint256 public constant MAX_LEGS = 50;
    /// CCTP V2 "standard" finality: wait for hard finality on the source chain.
    uint32 public constant STANDARD_FINALITY = 2000;

    struct PaymentIntent {
        bytes32 paymentId;
        address receiver;
        address refundTo; // on the settlement chain; a contract-wallet sender may not control its own address there
        uint256 fee;
        uint32 destinationDomain;
        bytes32 travelRuleHash; // hash of the encrypted IVMS101 payload kept off-chain
    }

    /// One supplier payment inside a net-settlement batch.
    struct Leg {
        bytes32 paymentId;
        address receiver;
        uint256 amount;
        bytes32 travelRuleHash;
    }

    struct BatchIntent {
        Leg[] legs;
        address refundTo;
        uint256 fee;
        uint32 destinationDomain;
    }

    bytes32 public constant INTENT_TYPEHASH =
        keccak256(
            "PaymentIntent(bytes32 paymentId,address receiver,address refundTo,uint256 fee,uint32 destinationDomain,bytes32 travelRuleHash)"
        );
    bytes32 public constant LEG_TYPEHASH =
        keccak256(
            "Leg(bytes32 paymentId,address receiver,uint256 amount,bytes32 travelRuleHash)"
        );
    bytes32 public constant BATCH_TYPEHASH =
        keccak256(
            "BatchIntent(Leg[] legs,address refundTo,uint256 fee,uint32 destinationDomain)Leg(bytes32 paymentId,address receiver,uint256 amount,bytes32 travelRuleHash)"
        );
    /// Permit2 appends these to "PermitWitnessTransferFrom(...,"; referenced types are in alphabetical order (EIP-712).
    string public constant INTENT_WITNESS =
        "PaymentIntent witness)PaymentIntent(bytes32 paymentId,address receiver,address refundTo,uint256 fee,uint32 destinationDomain,bytes32 travelRuleHash)TokenPermissions(address token,uint256 amount)";
    string public constant BATCH_WITNESS =
        "BatchIntent witness)BatchIntent(Leg[] legs,address refundTo,uint256 fee,uint32 destinationDomain)Leg(bytes32 paymentId,address receiver,uint256 amount,bytes32 travelRuleHash)TokenPermissions(address token,uint256 amount)";

    ISignatureTransfer public immutable permit2;
    ITokenMessengerV2 public immutable messenger;
    address public immutable feeVault;
    address public immutable escrow; // on the settlement chain
    uint32 public immutable settlementDomain;

    event PaymentInitiated(
        bytes32 indexed paymentId,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        address refundTo,
        bytes32 travelRuleHash
    );
    /// Emitted once per transfer, after its PaymentInitiated events; `net` is what was burned.
    event Burned(
        address indexed sender,
        address indexed token,
        uint256 net,
        uint256 fee,
        uint256 payments
    );

    error ZeroAddress();
    error WrongDomain();
    error FeeTooHigh();
    error BadBatch();
    error AmountMismatch();

    constructor(
        address admin,
        ISignatureTransfer permit2_,
        ITokenMessengerV2 messenger_,
        address feeVault_,
        address escrow_,
        uint32 settlementDomain_
    ) {
        if (
            admin == address(0) ||
            address(permit2_) == address(0) ||
            address(messenger_) == address(0) ||
            feeVault_ == address(0) ||
            escrow_ == address(0)
        ) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        permit2 = permit2_;
        messenger = messenger_;
        feeVault = feeVault_;
        escrow = escrow_;
        settlementDomain = settlementDomain_;
    }

    // ---------------------------------------------------------------- pay

    function pay(
        PaymentIntent calldata intent,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address sender,
        bytes calldata signature
    ) external onlyRole(RELAYER) whenNotPaused {
        if (intent.destinationDomain != settlementDomain) revert WrongDomain();
        if (intent.receiver == address(0) || intent.refundTo == address(0))
            revert ZeroAddress();
        if (intent.fee >= permit.permitted.amount) revert FeeTooHigh();

        _pull(permit, sender, hashIntent(intent), INTENT_WITNESS, signature);
        uint256 net = permit.permitted.amount - intent.fee;

        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(
            intent.paymentId,
            intent.receiver,
            net,
            intent.travelRuleHash
        );
        _settle(
            permit.permitted.token,
            sender,
            intent.refundTo,
            intent.fee,
            net,
            legs
        );
    }

    /// @notice Net settlement: one signature and one CCTP transfer for up to `MAX_LEGS` supplier payments.
    ///         The permitted amount must equal the legs plus the fee.
    function payBatch(
        BatchIntent calldata batch,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address sender,
        bytes calldata signature
    ) external onlyRole(RELAYER) whenNotPaused {
        if (batch.destinationDomain != settlementDomain) revert WrongDomain();
        if (batch.refundTo == address(0)) revert ZeroAddress();
        uint256 net = _checkLegs(batch.legs);
        if (net + batch.fee != permit.permitted.amount) revert AmountMismatch();

        _pull(permit, sender, hashBatch(batch), BATCH_WITNESS, signature);
        _settle(
            permit.permitted.token,
            sender,
            batch.refundTo,
            batch.fee,
            net,
            batch.legs
        );
    }

    // ---------------------------------------------------------------- hashing

    function hashIntent(
        PaymentIntent calldata intent
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    INTENT_TYPEHASH,
                    intent.paymentId,
                    intent.receiver,
                    intent.refundTo,
                    intent.fee,
                    intent.destinationDomain,
                    intent.travelRuleHash
                )
            );
    }

    function hashBatch(
        BatchIntent calldata batch
    ) public pure returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](batch.legs.length);
        for (uint256 i; i < legHashes.length; i++) {
            Leg calldata l = batch.legs[i];
            legHashes[i] = keccak256(
                abi.encode(
                    LEG_TYPEHASH,
                    l.paymentId,
                    l.receiver,
                    l.amount,
                    l.travelRuleHash
                )
            );
        }
        return
            keccak256(
                abi.encode(
                    BATCH_TYPEHASH,
                    keccak256(abi.encodePacked(legHashes)),
                    batch.refundTo,
                    batch.fee,
                    batch.destinationDomain
                )
            );
    }

    // ---------------------------------------------------------------- admin

    function pause() external onlyRole(PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- internal

    /// Pulls exactly the permitted amount; the balance snapshot rules out fee-on-transfer surprises, and nothing else
    /// sitting in the router is ever forwarded.
    function _pull(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address sender,
        bytes32 witness,
        string memory witnessType,
        bytes calldata signature
    ) private {
        IERC20 token = IERC20(permit.permitted.token);
        if (address(token) == address(0)) revert ZeroAddress();
        uint256 before = token.balanceOf(address(this));
        permit2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            sender,
            witness,
            witnessType,
            signature
        );
        if (token.balanceOf(address(this)) - before != permit.permitted.amount)
            revert AmountMismatch();
    }

    function _checkLegs(
        Leg[] calldata legs
    ) private pure returns (uint256 net) {
        if (legs.length == 0 || legs.length > MAX_LEGS) revert BadBatch();
        for (uint256 i; i < legs.length; i++) {
            if (legs[i].receiver == address(0)) revert ZeroAddress();
            if (legs[i].amount == 0) revert BadBatch();
            net += legs[i].amount;
        }
    }

    /// Fee in the permitted token to the vault, then one burn whose hook data the escrow decodes:
    /// abi.encode(sender, refundTo, Leg[]).
    function _settle(
        address token,
        address sender,
        address refundTo,
        uint256 fee,
        uint256 net,
        Leg[] memory legs
    ) private {
        if (fee != 0) IERC20(token).safeTransfer(feeVault, fee);
        _burn(token, net, abi.encode(sender, refundTo, legs));
        for (uint256 i; i < legs.length; i++) {
            emit PaymentInitiated(
                legs[i].paymentId,
                sender,
                legs[i].receiver,
                token,
                legs[i].amount,
                refundTo,
                legs[i].travelRuleHash
            );
        }
        emit Burned(sender, token, net, fee, legs.length);
    }

    /// The escrow is both mint recipient and the only allowed destination caller, so the message can only be
    /// delivered through `PaymentEscrow.receivePayment`. maxFee = 0: standard transfers carry no CCTP fee today.
    function _burn(address token, uint256 net, bytes memory hookData) private {
        IERC20(token).forceApprove(address(messenger), net);
        bytes32 to = bytes32(uint256(uint160(escrow)));
        messenger.depositForBurnWithHook(
            net,
            settlementDomain,
            to,
            token,
            to,
            0,
            STANDARD_FINALITY,
            hookData
        );
    }
}
