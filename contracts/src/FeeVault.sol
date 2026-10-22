// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title FeeVault (source chains)
/// @notice Collects the fees routers take from each payment. Only the treasury role can withdraw.
/// @dev Constructor args are the same on every chain, so a CREATE2 deploy gives the same address everywhere.
contract FeeVault is AccessControl, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant TREASURY = keccak256("TREASURY");
    bytes32 public constant PAUSER = keccak256("PAUSER");

    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroValue();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroValue();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function withdraw(
        IERC20 token,
        address to,
        uint256 amount
    ) external nonReentrant onlyRole(TREASURY) whenNotPaused {
        if (to == address(0) || amount == 0) revert ZeroValue();
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    function pause() external onlyRole(PAUSER) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
