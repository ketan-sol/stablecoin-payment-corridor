// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {ComplianceRegistry} from "./ComplianceRegistry.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";

/// @title PaymentEscrow (Arc, UUPS proxy)
/// @notice Holds each payment until compliance clears, then releases it to the supplier or an approved off-ramp, or
///         refunds it. Every payment ends Released or Refunded, exactly once.
///
///         Funds arrive two ways:
///         - `receivePayment` (RELAYER): delivers an attested CCTP message and records the payments in the router's
///           hook data. The router makes this escrow the message's destination caller, so this is the only way in.
///         - `fundFromLiquidity` (MARKET_MAKER): a liquidity provider pays a whitelisted stablecoin (USDC, PYUSD,
///           USDG...) from its own wallet, for funding legs CCTP does not cover. This keeps the escrow token-agnostic.
///
///         Compliance: one officer can freeze; unfreezing or refunding needs a second, different officer.
///         Refunds are pull-based: they credit the refund address, which calls `withdrawRefund`.
/// @dev Payments are keyed by `paymentKey(sourceDomain, paymentId)`, because IDs are only unique per source router.
contract PaymentEscrow is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER = keccak256("RELAYER");
    bytes32 public constant MARKET_MAKER = keccak256("MARKET_MAKER");
    bytes32 public constant PAYOUT_OPERATOR = keccak256("PAYOUT_OPERATOR");
    bytes32 public constant COMPLIANCE_OFFICER =
        keccak256("COMPLIANCE_OFFICER");
    /// Can only freeze (the backend's automatic hold on a sanctions or KYB hit). Never an approver.
    bytes32 public constant FREEZER = keccak256("FREEZER");

    /// Source domain used for payments the market maker funds (no CCTP domain uses it).
    uint32 public constant LIQUIDITY_DOMAIN = type(uint32).max;

    enum Status {
        None,
        Escrowed,
        Frozen,
        Released,
        Refunded
    }

    /// What a frozen payment's two officers agree on.
    enum Action {
        None,
        Unfreeze,
        Refund
    }

    struct Payment {
        address token;
        address sender;
        address receiver;
        address refundTo;
        uint128 amount;
        uint64 escrowedAt;
        Status status;
    }

    /// Same layout as `PaymentRouter.Leg`.
    struct Leg {
        bytes32 paymentId;
        address receiver;
        uint256 amount;
        bytes32 travelRuleHash;
    }

    /// A payment funded by a liquidity provider rather than CCTP.
    struct Funding {
        bytes32 paymentId;
        address sender; // the business that paid the liquidity provider
        address receiver;
        address refundTo;
        address token;
        uint256 amount;
        bytes32 travelRuleHash;
    }

    struct Proposal {
        address officer;
        Action action;
    }

    // CCTP V2 message layout (MessageV2 header, then BurnMessageV2 body).
    uint256 private constant SOURCE_DOMAIN = 4;
    uint256 private constant NONCE = 12;
    uint256 private constant RECIPIENT = 76;
    uint256 private constant BODY = 148;
    uint256 private constant MESSAGE_SENDER = 100; // within the body
    uint256 private constant HOOK_DATA = 228; // within the body

    ComplianceRegistry public registry;
    IMessageTransmitterV2 public transmitter;
    address public tokenMessenger; // local TokenMessengerV2: recipient of every genuine burn message
    IERC20 public usdc; // what CCTP mints here
    uint64 public refundWindow;

    mapping(bytes32 key => Payment) public payments;
    /// Owed per token: open payments plus refunds not yet withdrawn.
    mapping(address token => uint256) public totalHeld;
    mapping(address token => mapping(address account => uint256))
        public refundable;
    mapping(uint32 domain => mapping(bytes32 router => bool))
        public trustedRouter;
    mapping(address offRamp => bool) public approvedOffRamp;
    mapping(address token => bool) public allowedToken;
    mapping(bytes32 key => Proposal) public proposals;

    event Received(
        bytes32 indexed key,
        bytes32 indexed paymentId,
        uint32 indexed sourceDomain,
        address token,
        address sender,
        address receiver,
        address refundTo,
        uint256 amount,
        bytes32 travelRuleHash
    );
    event Unattributed(
        uint32 indexed sourceDomain,
        bytes32 indexed cctpNonce,
        uint256 amount
    );
    event Released(bytes32 indexed key, address indexed to, uint256 amount);
    event Frozen(bytes32 indexed key);
    event Proposed(bytes32 indexed key, address indexed officer, Action action);
    event Unfrozen(bytes32 indexed key);
    event Refunded(
        bytes32 indexed key,
        address indexed refundTo,
        uint256 amount
    );
    event RefundWithdrawn(
        address indexed token,
        address indexed account,
        uint256 amount
    );
    event RouterTrusted(
        uint32 indexed domain,
        bytes32 indexed router,
        bool trusted
    );
    event OffRampApproved(address indexed offRamp, bool approved);
    event TokenAllowed(address indexed token, bool allowed);
    event RefundWindowSet(uint64 window);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error BadStatus(Status current);
    error ZeroValue();
    error NotABurnMessage();
    error NothingReceived();
    error ReceiveFailed();
    error TokenNotAllowed();
    error AmountMismatch();
    error NotAllowed();
    error BadPayoutAddress();
    error RefundWindowOpen();
    error NothingToWithdraw();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        ComplianceRegistry registry_,
        IMessageTransmitterV2 transmitter_,
        address tokenMessenger_,
        IERC20 usdc_,
        uint64 refundWindow_
    ) external initializer {
        if (
            admin == address(0) ||
            address(registry_) == address(0) ||
            address(transmitter_) == address(0) ||
            tokenMessenger_ == address(0) ||
            address(usdc_) == address(0) ||
            refundWindow_ == 0
        ) revert ZeroValue();
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuardTransient_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        registry = registry_;
        transmitter = transmitter_;
        tokenMessenger = tokenMessenger_;
        usdc = usdc_;
        refundWindow = refundWindow_;
        allowedToken[address(usdc_)] = true;
        emit TokenAllowed(address(usdc_), true);
    }

    function paymentKey(
        uint32 sourceDomain,
        bytes32 paymentId
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceDomain, paymentId));
    }

    // ---------------------------------------------------------------- intake

    /// @notice Delivers an attested CCTP message and records the payments in its hook data (one, or a net-settlement
    ///         batch). Returns how many payments were recorded.
    /// @dev Never reverts after delivery for a reason the sender could not fix: a burn from an untrusted sender, an
    ///      amount mismatch or a reused key keeps the funds unattributed (admin-sweepable), so a message is never stuck.
    function receivePayment(
        bytes calldata message,
        bytes calldata attestation
    )
        external
        nonReentrant // amounts are a balance delta; a nested delivery must not be counted twice
        onlyRole(RELAYER)
        whenNotPaused
        returns (uint256 recorded)
    {
        // Only the TokenMessenger accepts a message from a registered remote TokenMessenger, so this check makes the
        // burn body, and its messageSender, genuine.
        if (_address(message, RECIPIENT) != tokenMessenger)
            revert NotABurnMessage();
        uint256 received = _deliver(message, attestation);

        uint32 sourceDomain = uint32(bytes4(_word(message, SOURCE_DOMAIN)));
        bytes calldata body = message[BODY:];
        if (trustedRouter[sourceDomain][_word(body, MESSAGE_SENDER)]) {
            (address sender, address refundTo, Leg[] memory legs) = abi.decode(
                body[HOOK_DATA:],
                (address, address, Leg[])
            );
            if (_recordable(sourceDomain, legs, received)) {
                for (uint256 i; i < legs.length; i++) {
                    _record(
                        sourceDomain,
                        address(usdc),
                        sender,
                        refundTo,
                        legs[i]
                    );
                }
                return legs.length;
            }
        }
        emit Unattributed(sourceDomain, _word(message, NONCE), received);
        return 0;
    }

    /// @notice A liquidity provider pays `f.amount` of a whitelisted stablecoin from its own wallet for a payment it
    ///         was funded for off-CCTP (net of its spread).
    function fundFromLiquidity(
        Funding calldata f
    )
        external
        nonReentrant
        onlyRole(MARKET_MAKER)
        whenNotPaused
        returns (bytes32 key)
    {
        if (!allowedToken[f.token]) revert TokenNotAllowed();
        if (
            f.sender == address(0) ||
            f.receiver == address(0) ||
            f.refundTo == address(0) ||
            f.amount == 0
        ) {
            revert ZeroValue();
        }
        key = paymentKey(LIQUIDITY_DOMAIN, f.paymentId);
        if (payments[key].status != Status.None)
            revert BadStatus(payments[key].status);

        IERC20 token = IERC20(f.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), f.amount);
        if (token.balanceOf(address(this)) - before != f.amount)
            revert AmountMismatch();
        _record(
            LIQUIDITY_DOMAIN,
            f.token,
            f.sender,
            f.refundTo,
            Leg(f.paymentId, f.receiver, f.amount, f.travelRuleHash)
        );
    }

    // ---------------------------------------------------------------- payout

    /// @notice Release to the supplier's wallet or an approved off-ramp, only if compliance clears at this moment.
    function release(
        bytes32 key,
        address payoutTo
    ) external nonReentrant onlyRole(PAYOUT_OPERATOR) whenNotPaused {
        Payment storage p = _expect(key, Status.Escrowed);
        if (payoutTo != p.receiver && !approvedOffRamp[payoutTo])
            revert BadPayoutAddress();
        if (!registry.isAllowed(p.sender, p.receiver)) revert NotAllowed();
        p.status = Status.Released;
        totalHeld[p.token] -= p.amount;
        IERC20(p.token).safeTransfer(payoutTo, p.amount);
        emit Released(key, payoutTo, p.amount);
    }

    // ---------------------------------------------------------------- compliance (works while paused)

    /// @notice A compliance officer, or the FREEZER (backend), stops a payment; only two officers can undo it.
    function freeze(bytes32 key) external {
        if (!hasRole(COMPLIANCE_OFFICER, msg.sender) && !hasRole(FREEZER, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, FREEZER);
        }
        _expect(key, Status.Escrowed).status = Status.Frozen;
        delete proposals[key];
        emit Frozen(key);
    }

    /// @notice Second approver required: the first officer's call proposes, a different officer's call executes.
    ///         The payment goes back to Escrowed with a fresh refund window, ready for the payout operator.
    function unfreeze(bytes32 key) external onlyRole(COMPLIANCE_OFFICER) {
        Payment storage p = _expect(key, Status.Frozen);
        if (_approved(key, Action.Unfreeze)) {
            p.status = Status.Escrowed;
            p.escrowedAt = uint64(block.timestamp);
            emit Unfrozen(key);
        }
    }

    /// @notice Second approver required, as for `unfreeze`. Credits the signed refund address.
    function refund(bytes32 key) external onlyRole(COMPLIANCE_OFFICER) {
        Payment storage p = payments[key];
        if (p.status != Status.Escrowed && p.status != Status.Frozen)
            revert BadStatus(p.status);
        if (_approved(key, Action.Refund)) _refund(key, p);
    }

    /// @notice Anyone can push a refund once a non-frozen payment sat in escrow past the window (e.g. the off-ramp
    ///         never paid out). Frozen payments stay with compliance; a pause stops this until incidents are reviewed.
    function claimRefundAfterTimeout(bytes32 key) external whenNotPaused {
        Payment storage p = _expect(key, Status.Escrowed);
        if (block.timestamp < p.escrowedAt + refundWindow)
            revert RefundWindowOpen();
        _refund(key, p);
    }

    /// @notice Pull a credited refund.
    function withdrawRefund(
        IERC20 token
    ) external nonReentrant whenNotPaused returns (uint256 amount) {
        amount = refundable[address(token)][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        refundable[address(token)][msg.sender] = 0;
        totalHeld[address(token)] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit RefundWithdrawn(address(token), msg.sender, amount);
    }

    function pause() external onlyRole(COMPLIANCE_OFFICER) {
        _pause();
    }

    // ---------------------------------------------------------------- admin (behind a timelock or multisig)

    /// @notice Only burns from a trusted router become payments. Keep a rotated-out router trusted until its
    ///         in-flight messages have landed.
    function setRouter(
        uint32 domain,
        address router,
        bool trusted
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 r = bytes32(uint256(uint160(router)));
        trustedRouter[domain][r] = trusted;
        emit RouterTrusted(domain, r, trusted);
    }

    function setOffRamp(
        address offRamp,
        bool approved
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        approvedOffRamp[offRamp] = approved;
        emit OffRampApproved(offRamp, approved);
    }

    /// @notice The regulated stablecoins the market maker may fund in (USDC, PYUSD, USDG...).
    function setAllowedToken(
        address token,
        bool allowed
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroValue();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setRefundWindow(
        uint64 window
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (window == 0) revert ZeroValue();
        refundWindow = window;
        emit RefundWindowSet(window);
    }

    /// @notice Move funds nothing owns (untrusted burns, mismatches, duplicates, donations). Never touches `totalHeld`.
    function sweepUnattributed(
        IERC20 token,
        address to
    ) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroValue();
        uint256 amount = token.balanceOf(address(this)) -
            totalHeld[address(token)];
        token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _authorizeUpgrade(
        address
    ) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ---------------------------------------------------------------- internal

    /// Calls the CCTP transmitter and returns what it minted here (amount - feeExecuted).
    function _deliver(
        bytes calldata message,
        bytes calldata attestation
    ) private returns (uint256 received) {
        uint256 before = usdc.balanceOf(address(this));
        // Reverts on a bad attestation, a replay or a wrong caller.
        if (!transmitter.receiveMessage(message, attestation))
            revert ReceiveFailed();
        received = usdc.balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived(); // minted to someone else
    }

    /// The legs must account for exactly what arrived, and every key must be new (also within the batch).
    /// A single payment takes whatever arrived, so a CCTP fee never strands it.
    function _recordable(
        uint32 sourceDomain,
        Leg[] memory legs,
        uint256 received
    ) private view returns (bool) {
        if (legs.length == 0) return false;
        if (legs.length == 1) legs[0].amount = received;
        uint256 sum = 0;
        for (uint256 i; i < legs.length; i++) {
            if (legs[i].receiver == address(0) || legs[i].amount == 0)
                return false;
            if (
                payments[paymentKey(sourceDomain, legs[i].paymentId)].status !=
                Status.None
            ) return false;
            for (uint256 j; j < i; j++) {
                if (legs[j].paymentId == legs[i].paymentId) return false;
            }
            sum += legs[i].amount;
        }
        return sum == received;
    }

    function _record(
        uint32 sourceDomain,
        address token,
        address sender,
        address refundTo,
        Leg memory leg
    ) private {
        bytes32 key = paymentKey(sourceDomain, leg.paymentId);
        totalHeld[token] += leg.amount;
        payments[key] = Payment(
            token,
            sender,
            leg.receiver,
            refundTo,
            SafeCast.toUint128(leg.amount),
            uint64(block.timestamp),
            Status.Escrowed
        );
        emit Received(
            key,
            leg.paymentId,
            sourceDomain,
            token,
            sender,
            leg.receiver,
            refundTo,
            leg.amount,
            leg.travelRuleHash
        );
    }

    /// First call (or a call for a different action) proposes; a different officer asking for the same action executes.
    function _approved(bytes32 key, Action action) private returns (bool) {
        Proposal memory pr = proposals[key];
        if (
            pr.action == action &&
            pr.officer != address(0) &&
            pr.officer != msg.sender
        ) {
            delete proposals[key];
            return true;
        }
        proposals[key] = Proposal(msg.sender, action);
        emit Proposed(key, msg.sender, action);
        return false;
    }

    /// Effects only: the money stays here, owed to the refund address until it withdraws.
    function _refund(bytes32 key, Payment storage p) private {
        p.status = Status.Refunded;
        refundable[p.token][p.refundTo] += p.amount;
        delete proposals[key];
        emit Refunded(key, p.refundTo, p.amount);
    }

    function _expect(
        bytes32 key,
        Status want
    ) private view returns (Payment storage p) {
        p = payments[key];
        if (p.status != want) revert BadStatus(p.status);
    }

    function _word(
        bytes calldata data,
        uint256 offset
    ) private pure returns (bytes32) {
        return bytes32(data[offset:offset + 32]);
    }

    function _address(
        bytes calldata data,
        uint256 offset
    ) private pure returns (address) {
        return address(uint160(uint256(_word(data, offset))));
    }
}
