// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {ReviewRegistryHandler} from "./handlers/ReviewRegistryHandler.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Stateful campaign against the unchanged registry, through `ReviewRegistryHandler` only.
/// @dev The Chapter 3 suite (`Invariants.t.sol`) is kept as it is. This suite adds a contract-account
/// reviewer, overlapping commitment bytes across namespaces, per-operation coverage and
/// reason-exact rejections. Reachable states and real signature validation only.
contract RegistryInvariantsTest is Test {
    ProofOfReviewRegistry internal registry;
    ReviewRegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ProofOfReviewRegistry();
        handler = new ReviewRegistryHandler(registry);

        // Only the intended handler operations are fuzzed: never the registry directly, the
        // contract-account fixture's setter, or a view.
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = ReviewRegistryHandler.issue.selector;
        selectors[1] = ReviewRegistryHandler.revoke.selector;
        selectors[2] = ReviewRegistryHandler.supersede.selector;
        selectors[3] = ReviewRegistryHandler.invalidate.selector;
        selectors[4] = ReviewRegistryHandler.rejectSignature.selector;
        selectors[5] = ReviewRegistryHandler.rejectShapeOrDeadline.selector;
        selectors[6] = ReviewRegistryHandler.rejectLifecycle.selector;
        selectors[7] = ReviewRegistryHandler.rejectNonce.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _succeeded(ReviewRegistryHandler.Op op) internal view returns (uint256) {
        return handler.totalOf(op).succeeded;
    }

    function _refused(ReviewRegistryHandler.Op op) internal view returns (uint256) {
        return handler.totalOf(op).expectedRejected;
    }

    /// @dev Runs after every campaign run. A run in which nothing meaningful happened, or in which
    /// everything reverted, is a failure: successful issue, supersede, revoke and invalidation
    /// calls must all have occurred, in more than one namespace, alongside refused ones.
    function afterInvariant() public view {
        assertGt(_succeeded(ReviewRegistryHandler.Op.Issue), 0, "no successful issue");
        assertGt(_succeeded(ReviewRegistryHandler.Op.Supersede), 0, "no successful supersession");
        assertGt(_succeeded(ReviewRegistryHandler.Op.Revoke), 0, "no successful revocation");
        assertGt(_succeeded(ReviewRegistryHandler.Op.Invalidate), 0, "no successful nonce invalidation");

        assertGt(_refused(ReviewRegistryHandler.Op.RejectSignature), 0, "no refused signature");
        assertGt(
            _refused(ReviewRegistryHandler.Op.RejectShape)
                + _refused(ReviewRegistryHandler.Op.RejectDeadline),
            0,
            "no refused shape or deadline"
        );
        assertGt(_refused(ReviewRegistryHandler.Op.RejectLifecycle), 0, "no refused lifecycle transition");
        assertGt(
            _refused(ReviewRegistryHandler.Op.RejectNonce)
                + _refused(ReviewRegistryHandler.Op.RejectInvalidation),
            0,
            "no refused nonce use"
        );

        uint256 namespaces = 0;
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            if (handler.successfulExecutes(handler.reviewerAt(r)) > 0) ++namespaces;
        }
        assertGe(namespaces, 3, "valid signatures were exercised in too few namespaces");
        assertGt(handler.sharedCommitmentIssues(), 0, "no identical commitment bytes across reviewers");
        assertEq(handler.unexpectedRejected(), 0, "a rejection had an unmodelled reason");
    }

    /// @dev Every refusal had exactly the reason the model predicted. (An unexpected revert of a
    /// valid action, or an unexpected success, already failed the run by escaping the handler.)
    function invariant_everyRejectionHadItsModelledReason() public view {
        assertEq(handler.unexpectedRejected(), 0, "a rejection had an unmodelled reason");
    }
}
