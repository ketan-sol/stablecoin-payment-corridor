// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Circle CCTP V2 TokenMessenger surface used by the router.
interface ITokenMessengerV2 {
    /// @dev `hookData` must be non-empty. CCTP only carries it; the destination never executes it.
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
