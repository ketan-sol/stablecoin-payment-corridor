// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Compiles the real Uniswap Permit2 so tests can deploy it with vm.deployCode.
import {Permit2} from "permit2/src/Permit2.sol";
