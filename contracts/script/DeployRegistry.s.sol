// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {Script} from "forge-std/Script.sol";

/// @notice Deploys the registry. It takes no constructor arguments and has no owner or privileged
/// account, so the deployer gains nothing by deploying it.
/// @dev The broadcasting account is supplied by the caller at run time (an unlocked local node, a
/// keystore account or a hardware wallet). No key is read, embedded or logged here.
contract DeployRegistry is Script {
    function run() external returns (ProofOfReviewRegistry registry) {
        vm.startBroadcast();
        registry = new ProofOfReviewRegistry();
        vm.stopBroadcast();
    }
}
