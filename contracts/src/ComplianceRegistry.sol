// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ISanctionsList} from "./interfaces/ISanctionsList.sol";

/// @title ComplianceRegistry (Arc, UUPS proxy)
/// @notice On-chain view of compliance: KYB attestations written by the backend after the vendor check, plus a
///         sanctions oracle. `PaymentEscrow` asks `isAllowed(sender, receiver)` before every release.
/// @dev An attestation stores the EAS attestation UID (or the vendor's reference) and an expiry, so a lapsed KYB
///      stops payouts without anyone acting. If the oracle call reverts, `isAllowed` reverts: compliance fails closed.
contract ComplianceRegistry is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant COMPLIANCE_OFFICER =
        keccak256("COMPLIANCE_OFFICER");

    struct Attestation {
        bytes32 uid;
        uint64 expiresAt;
    }

    mapping(address account => Attestation) public attestations;
    ISanctionsList public sanctionsOracle;

    event AttestationSet(
        address indexed account,
        bytes32 indexed uid,
        uint64 expiresAt
    );
    event AttestationRevoked(address indexed account);
    event SanctionsOracleSet(address indexed oracle);

    error ZeroValue();
    error AlreadyExpired();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        ISanctionsList oracle
    ) external initializer {
        if (admin == address(0)) revert ZeroValue();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setSanctionsOracle(oracle);
    }

    // ---------------------------------------------------------------- KYB

    /// @notice Record a passed KYB check. `uid` is the EAS attestation UID (or vendor reference) for the audit trail.
    function setAttestation(
        address account,
        bytes32 uid,
        uint64 expiresAt
    ) external onlyRole(COMPLIANCE_OFFICER) {
        if (account == address(0) || uid == bytes32(0)) revert ZeroValue();
        if (expiresAt <= block.timestamp) revert AlreadyExpired();
        attestations[account] = Attestation(uid, expiresAt);
        emit AttestationSet(account, uid, expiresAt);
    }

    function revokeAttestation(
        address account
    ) external onlyRole(COMPLIANCE_OFFICER) {
        delete attestations[account];
        emit AttestationRevoked(account);
    }

    // ---------------------------------------------------------------- reads

    function isVerified(address account) public view returns (bool) {
        Attestation memory a = attestations[account];
        return a.uid != bytes32(0) && a.expiresAt > block.timestamp;
    }

    function isSanctioned(address account) public view returns (bool) {
        return sanctionsOracle.isSanctioned(account);
    }

    /// @notice Both parties KYB-verified and neither sanctioned.
    function isAllowed(address from, address to) external view returns (bool) {
        return
            isVerified(from) &&
            isVerified(to) &&
            !isSanctioned(from) &&
            !isSanctioned(to);
    }

    // ---------------------------------------------------------------- admin

    function setSanctionsOracle(
        ISanctionsList oracle
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSanctionsOracle(oracle);
    }

    function _setSanctionsOracle(ISanctionsList oracle) private {
        if (address(oracle) == address(0)) revert ZeroValue();
        sanctionsOracle = oracle;
        emit SanctionsOracleSet(address(oracle));
    }

    function _authorizeUpgrade(
        address
    ) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
