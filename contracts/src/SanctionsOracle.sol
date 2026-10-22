// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    Ownable2Step,
    Ownable
} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";

/// @title SanctionsOracle (testnets only)
/// @notice Stand-in for the Chainalysis sanctions oracle, which only exists on mainnets. Same read interface and
///         the same admin function names, so `ComplianceRegistry` points at the real oracle without changes.
contract SanctionsOracle is ISanctionsList, Ownable2Step {
    mapping(address => bool) private sanctioned;

    event SanctionedAddressesAdded(address[] addrs);
    event SanctionedAddressesRemoved(address[] addrs);

    constructor(address owner_) Ownable(owner_) {}

    function addToSanctionsList(address[] calldata addrs) external onlyOwner {
        for (uint256 i; i < addrs.length; i++) {
            sanctioned[addrs[i]] = true;
        }
        emit SanctionedAddressesAdded(addrs);
    }

    function removeFromSanctionsList(
        address[] calldata addrs
    ) external onlyOwner {
        for (uint256 i; i < addrs.length; i++) {
            sanctioned[addrs[i]] = false;
        }
        emit SanctionedAddressesRemoved(addrs);
    }

    function isSanctioned(address addr) external view returns (bool) {
        return sanctioned[addr];
    }
}
