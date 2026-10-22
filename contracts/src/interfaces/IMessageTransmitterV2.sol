// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Circle CCTP V2 MessageTransmitter surface used by the escrow.
interface IMessageTransmitterV2 {
    /// @dev Reverts unless `msg.sender` is the message's destinationCaller (when set) and the nonce is unused.
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);
}
