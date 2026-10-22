// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../../src/interfaces/IMessageTransmitterV2.sol";

/// @notice Single-chain stand-in for CCTP V2 on Anvil: TokenMessengerV2 and MessageTransmitterV2 in one.
///         `depositForBurnWithHook` locks the tokens and emits a message in the real V2 byte layout;
///         `receiveMessage` pays `amount - feeExecuted` to the mint recipient, once per nonce, enforcing
///         destinationCaller like the real transmitter.
/// @dev Local only. Attestations are ignored (there is no attester) and burns are locks, not burns, so a test can
///      fund this contract and deliver a hand-made message to play another source chain (`formatMessage`).
contract LocalCCTP is ITokenMessengerV2, IMessageTransmitterV2 {
    using SafeERC20 for IERC20;

    uint32 constant VERSION = 1;

    /// Same event as MessageTransmitterV2, so off-chain code reads it the same way.
    event MessageSent(bytes message);

    uint32 public immutable localDomain;
    uint256 public nextNonce;
    mapping(bytes32 nonce => uint256) public usedNonces;

    constructor(uint32 localDomain_) {
        localDomain = localDomain_;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        require(hookData.length > 0, "Hook data is empty");
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);
        emit MessageSent(
            formatMessage(
                localDomain,
                destinationDomain,
                bytes32(++nextNonce),
                destinationCaller,
                minFinalityThreshold,
                burnToken,
                mintRecipient,
                amount,
                msg.sender,
                hookData
            )
        );
    }

    function receiveMessage(bytes calldata message, bytes calldata) external virtual returns (bool) {
        bytes32 nonce = bytes32(message[12:44]);
        require(usedNonces[nonce] == 0, "Nonce already used");
        usedNonces[nonce] = 1;
        bytes32 caller = bytes32(message[108:140]);
        require(caller == bytes32(0) || caller == _b32(msg.sender), "Invalid caller for message");

        bytes calldata body = message[148:];
        address token = address(uint160(uint256(bytes32(body[4:36]))));
        address recipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 feeExecuted = uint256(bytes32(body[164:196]));
        IERC20(token).safeTransfer(recipient, amount - feeExecuted);
        return true;
    }

    /// MessageV2 header (version, sourceDomain, destinationDomain, nonce, sender, recipient, destinationCaller,
    /// minFinalityThreshold, finalityThresholdExecuted) around a BurnMessageV2 body (version, burnToken,
    /// mintRecipient, amount, messageSender, maxFee, feeExecuted, expirationBlock, hookData).
    function formatMessage(
        uint32 sourceDomain,
        uint32 destinationDomain,
        bytes32 nonce,
        bytes32 destinationCaller,
        uint32 finality,
        address burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        address messageSender,
        bytes memory hookData
    ) public view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            VERSION,
            _b32(burnToken),
            mintRecipient,
            amount,
            _b32(messageSender),
            uint256(0), // maxFee
            uint256(0), // feeExecuted
            uint256(0), // expirationBlock
            hookData
        );
        return abi.encodePacked(
            VERSION,
            sourceDomain,
            destinationDomain,
            nonce,
            _b32(address(this)), // sender: the source TokenMessenger
            _b32(address(this)), // recipient: the destination TokenMessenger
            destinationCaller,
            finality,
            finality,
            body
        );
    }

    function _b32(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
