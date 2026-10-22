// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The Chainalysis sanctions oracle interface (deployed on mainnets); `SanctionsOracle` mirrors it on testnets.
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}
