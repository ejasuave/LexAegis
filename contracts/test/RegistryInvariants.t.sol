// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";
import {ERC1271OwnedAccount} from "./fixtures/ERC1271Fixtures.sol";
import {ReviewRegistryHandler} from "./handlers/ReviewRegistryHandler.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice The model-versus-registry checks, shared by the campaign and by its negative controls.
abstract contract RegistryModelChecks is Test {
    error Violation(string reason);

    ProofOfReviewRegistry internal registry;
    ReviewRegistryHandler internal handler;

    function _deploy() internal {
        vm.warp(1_800_000_000);
        registry = new ProofOfReviewRegistry();
        handler = new ReviewRegistryHandler(registry);
    }

    /// @dev Properties 1, 2, 6 and 7 over EVERY (reviewer, pool commitment) pair, issued or not.
    /// Storage equals the independent model, so only successful authorised actions changed it; a
    /// pair never issued is NotFound with zero metadata even when another reviewer issued the same
    /// bytes; an ever-terminal receipt is neither Active nor NotFound; the original issuance time
    /// is unchanged; and each commitment was issued exactly once (a supersession's two logs count
    /// as one issuance of the replacement).
    function checkEveryNamespaceEqualsTheModel() public view {
        bytes32[] memory pool = handler.pool();
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            uint256 issuedHere = 0;
            ReviewRegistryHandler.Expected[] memory expected = handler.expectedFor(reviewer);
            for (uint256 i = 0; i < pool.length; ++i) {
                if (_assertPair(registry.getReceipt(reviewer, pool[i]), expected[i])) ++issuedHere;
            }
            if (issuedHere != handler.issuedCount(reviewer)) revert Violation("ever-issued count");
        }
    }

    /// @dev Plain comparisons instead of cheatcode assertions: this runs for 120 pairs after
    /// every call of the campaign. A violation reverts, which fails the invariant with its reason.
    /// @return issued Whether the model says this pair was ever issued.
    function _assertPair(
        IProofOfReviewRegistry.Receipt memory actual,
        ReviewRegistryHandler.Expected memory expected
    ) internal pure returns (bool issued) {
        if (actual.status != expected.ghost.status) {
            revert Violation("status differs from the model");
        }
        if (actual.predecessor != expected.ghost.predecessor) revert Violation("predecessor differs");
        if (actual.successor != expected.ghost.successor) revert Violation("successor differs");
        if (actual.issuedAt != expected.ghost.issuedAt) revert Violation("issuedAt differs");
        if (actual.updatedAt != expected.ghost.updatedAt) revert Violation("updatedAt differs");

        if (expected.issuedEvents != (expected.issued ? 1 : 0)) revert Violation("not issued exactly once");
        if (!expected.issued) {
            if (actual.status != IProofOfReviewRegistry.ReceiptStatus.NotFound) {
                revert Violation("a never-issued pair is not NotFound");
            }
            if (actual.issuedAt != 0 || actual.updatedAt != 0) revert Violation("never-issued metadata");
            return false;
        }
        if (actual.status == IProofOfReviewRegistry.ReceiptStatus.NotFound) {
            revert Violation("an issuance was erased");
        }
        if (actual.issuedAt != expected.firstIssuedAt) revert Violation("the issuance time changed");
        if (actual.issuedAt > actual.updatedAt) revert Violation("updated before issued");
        bool superseded = actual.status == IProofOfReviewRegistry.ReceiptStatus.Superseded;
        if (
            expected.everTerminal && !superseded
                && actual.status != IProofOfReviewRegistry.ReceiptStatus.Revoked
        ) revert Violation("a terminal receipt left its terminal status");
        if (expected.supersededEvents != (superseded ? 1 : 0)) {
            revert Violation("not superseded exactly once");
        }
        return true;
    }

    /// @dev Property 3. Each successful execute or invalidateNonce consumed exactly one nonce, and
    /// nothing else moved one: not a failed action, not another account's call. (The handler also
    /// reverts if any observed nonce ever decreases.)
    function checkNoncesAreExactlyAccountedFor() public view {
        for (uint256 i = 0; i < handler.accountCount(); ++i) {
            address account = handler.accountAt(i);
            uint256 actual = registry.nonceOf(account);
            assertEq(actual, handler.ghostNonce(account), "nonce differs from the model");
            assertEq(
                actual,
                handler.successfulExecutes(account) + handler.successfulInvalidations(account),
                "a nonce moved without a successful operation"
            );
        }
        assertEq(registry.nonceOf(address(0)), 0, "the zero address has no nonce");
        assertEq(address(registry).balance, 0);
    }

    /// @dev Properties 4 and 5. Links agree within one namespace; a superseded receipt has exactly
    /// one successor; successors are never reused; chains terminate. It does NOT require a reviewer
    /// to have one Active receipt, nor a pair to keep one forever: a replacement may later be
    /// revoked or superseded, leaving neither member Active.
    function checkSupersessionLinksAgreeAndChainsTerminate() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            // One read of every issued receipt of this namespace, taken from the registry.
            bytes32[] memory issued = handler.issuedOf(reviewer);
            IProofOfReviewRegistry.Receipt[] memory receipts =
                new IProofOfReviewRegistry.Receipt[](issued.length);
            for (uint256 i = 0; i < issued.length; ++i) {
                receipts[i] = registry.getReceipt(reviewer, issued[i]);
            }
            for (uint256 i = 0; i < issued.length; ++i) {
                _assertLinks(issued, receipts, i);
            }
        }
    }

    function _indexOf(bytes32[] memory issued, bytes32 commitment) internal pure returns (uint256) {
        for (uint256 i = 0; i < issued.length; ++i) {
            if (issued[i] == commitment) return i;
        }
        return type(uint256).max;
    }

    function _assertLinks(
        bytes32[] memory issued,
        IProofOfReviewRegistry.Receipt[] memory receipts,
        uint256 index
    ) internal pure {
        bytes32 commitment = issued[index];
        IProofOfReviewRegistry.Receipt memory receipt = receipts[index];

        uint256 pointingHere = 0;
        for (uint256 j = 0; j < issued.length; ++j) {
            if (receipts[j].predecessor == commitment) ++pointingHere;
        }
        if (receipt.status == IProofOfReviewRegistry.ReceiptStatus.Superseded) {
            if (pointingHere != 1) revert Violation("a superseded receipt has exactly one successor");
            if (receipt.successor == bytes32(0) || receipt.successor == commitment) {
                revert Violation("missing or self successor");
            }
            uint256 next = _indexOf(issued, receipt.successor);
            if (next == type(uint256).max) revert Violation("the successor is not an issued receipt here");
            if (receipts[next].predecessor != commitment) revert Violation("successor does not point back");
            if (receipts[next].issuedAt != receipt.updatedAt) {
                revert Violation("the pair changed in two steps");
            }
            if (receipts[next].issuedAt < receipt.issuedAt) revert Violation("successor issued earlier");
        } else {
            if (pointingHere != 0) revert Violation("only a superseded receipt has a successor");
            if (receipt.successor != bytes32(0)) revert Violation("a successor without supersession");
        }
        if (receipt.predecessor != bytes32(0)) {
            uint256 previous = _indexOf(issued, receipt.predecessor);
            if (previous == type(uint256).max) {
                revert Violation("the predecessor is not an issued receipt here");
            }
            if (receipts[previous].status != IProofOfReviewRegistry.ReceiptStatus.Superseded) {
                revert Violation("a predecessor that is not Superseded");
            }
            if (receipts[previous].successor != commitment) {
                revert Violation("predecessor does not point forward");
            }
        }

        // Replacements must be previously unissued, so walking predecessors always terminates.
        bytes32 cursor = receipt.predecessor;
        uint256 steps = 0;
        while (cursor != bytes32(0)) {
            uint256 position = _indexOf(issued, cursor);
            if (position == type(uint256).max) revert Violation("a chain leaves the namespace");
            cursor = receipts[position].predecessor;
            if (++steps >= issued.length) revert Violation("a predecessor chain does not terminate");
        }
    }
}

/// @notice Stateful campaign against the unchanged registry, through `ReviewRegistryHandler` only.
/// @dev The Chapter 3 suite (`Invariants.t.sol`) is kept as it is. This suite adds a contract-account
/// reviewer, overlapping commitment bytes across namespaces, per-operation coverage and
/// reason-exact rejections. Reachable states and real signature validation only.
contract RegistryInvariantsTest is RegistryModelChecks {
    function setUp() public {
        _deploy();

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

    function invariant_everyNamespaceEqualsTheModel() public view {
        checkEveryNamespaceEqualsTheModel();
    }

    function invariant_noncesAreExactlyAccountedFor() public view {
        checkNoncesAreExactlyAccountedFor();
    }

    function invariant_supersessionLinksAgreeAndChainsTerminate() public view {
        checkSupersessionLinksAgreeAndChainsTerminate();
    }
}

/// @notice Negative controls for the invariants, outside any campaign.
/// @dev LOCAL BOUNDARY TESTS. They write the local registry's storage with a cheatcode to create a
/// state the registry itself never reaches, and show each invariant reports it. No campaign uses a
/// storage cheatcode, and nothing here is evidence about a deployed registry.
contract RegistryInvariantControlsTest is RegistryModelChecks {
    function setUp() public {
        _deploy();
    }

    /// @dev The first storage slot `getReceipt` reads for a pair: its status word.
    function _statusSlot(address reviewer, bytes32 commitment) internal returns (bytes32) {
        vm.record();
        registry.getReceipt(reviewer, commitment);
        (bytes32[] memory reads,) = vm.accesses(address(registry));
        return reads[0];
    }

    function _nonceSlot(address account) internal returns (bytes32) {
        vm.record();
        registry.nonceOf(account);
        (bytes32[] memory reads,) = vm.accesses(address(registry));
        return reads[0];
    }

    function test_negativeControl_aReactivatedTerminalReceiptIsReported() public {
        handler.issue(0, 0, 0, 1);
        handler.revoke(0, 0, 0, 2);
        address reviewer = handler.reviewerAt(0);
        bytes32 commitment = handler.poolAt(0);
        this.checkEveryNamespaceEqualsTheModel();

        bytes32 slot = _statusSlot(reviewer, commitment);
        assertEq(
            uint256(vm.load(address(registry), slot)), uint256(IProofOfReviewRegistry.ReceiptStatus.Revoked)
        );
        vm.store(address(registry), slot, bytes32(uint256(IProofOfReviewRegistry.ReceiptStatus.Active)));

        vm.expectRevert(abi.encodeWithSelector(Violation.selector, "status differs from the model"));
        this.checkEveryNamespaceEqualsTheModel();
    }

    function test_negativeControl_anErasedIssuanceInAnotherNamespaceIsReported() public {
        // Two reviewers hold the same bytes; one record is wiped behind the model's back.
        handler.issue(0, 0, 0, 1);
        handler.issue(1, 0, 0, 2);
        bytes32 slot = _statusSlot(handler.reviewerAt(1), handler.poolAt(0));
        vm.store(address(registry), slot, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Violation.selector, "status differs from the model"));
        this.checkEveryNamespaceEqualsTheModel();
    }

    function test_negativeControl_aWriteToANeverIssuedPairIsReported() public {
        handler.issue(0, 0, 0, 1);
        // Reviewer 1 never issued these bytes; a stray record appears in that namespace.
        bytes32 slot = _statusSlot(handler.reviewerAt(1), handler.poolAt(0));
        vm.store(address(registry), slot, bytes32(uint256(IProofOfReviewRegistry.ReceiptStatus.Active)));
        vm.expectRevert(abi.encodeWithSelector(Violation.selector, "status differs from the model"));
        this.checkEveryNamespaceEqualsTheModel();
    }

    function test_negativeControl_aNonceThatMovedWithoutAnOperationIsReported() public {
        handler.issue(2, 0, 0, 1);
        address reviewer = handler.reviewerAt(2);
        this.checkNoncesAreExactlyAccountedFor();
        vm.store(address(registry), _nonceSlot(reviewer), bytes32(uint256(0)));
        vm.expectRevert();
        this.checkNoncesAreExactlyAccountedFor();
    }

    function test_negativeControl_aBrokenSuccessorLinkIsReported() public {
        handler.issue(0, 0, 0, 1);
        handler.supersede(0, 0, 0, 2);
        this.checkSupersessionLinksAgreeAndChainsTerminate();
        // The replacement's predecessor word is the second word of its record.
        bytes32 slot = bytes32(uint256(_statusSlot(handler.reviewerAt(0), handler.poolAt(1))) + 1);
        assertEq(vm.load(address(registry), slot), handler.poolAt(0));
        vm.store(address(registry), slot, bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(Violation.selector, "a superseded receipt has exactly one successor")
        );
        this.checkSupersessionLinksAgreeAndChainsTerminate();
    }
}

/// @notice Explicit lifecycle transitions: atomicity, event order, history and nonce races.
/// @dev Local ERC-1271 fixtures say nothing about any production wallet or a mainnet deployment.
contract RegistryTransitionsTest is RegistryTestBase {
    IProofOfReviewRegistry.ReceiptStatus internal constant ACTIVE =
    IProofOfReviewRegistry.ReceiptStatus.Active;
    IProofOfReviewRegistry.ReceiptStatus internal constant REVOKED =
    IProofOfReviewRegistry.ReceiptStatus.Revoked;
    IProofOfReviewRegistry.ReceiptStatus internal constant SUPERSEDED =
    IProofOfReviewRegistry.ReceiptStatus.Superseded;

    uint256 internal constant T0 = START_TIME;
    uint256 internal constant T1 = START_TIME + 1 hours;
    uint256 internal constant T2 = START_TIME + 2 hours;
    bytes32 internal constant COMMITMENT_D = keccak256("synthetic commitment D");

    function test_issueThenSupersedeThenRevokeTheReplacementKeepsHistory() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));

        // Immediately after: the old member is Superseded and exactly the replacement is Active.
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, COMMITMENT_A, bytes32(0), T1, T1);

        vm.warp(T2);
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_B));
        // Later: neither member is Active. The old one never reactivates and every link survives.
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, REVOKED, COMMITMENT_A, bytes32(0), T1, T2);
        assertEq(registry.nonceOf(reviewer), 3);

        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_A), _transition(SUPERSEDED));
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_C), _transition(SUPERSEDED)
        );
        _expectExecuteRevert(
            reviewerKey,
            _issue(reviewer, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
        );
    }

    function test_issueThenSupersedeTwiceKeepsEveryLinkTerminalStatusAndTime() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        vm.warp(T2);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C));

        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, SUPERSEDED, COMMITMENT_A, COMMITMENT_C, T1, T2);
        _assertReceipt(reviewer, COMMITMENT_C, ACTIVE, COMMITMENT_B, bytes32(0), T2, T2);

        // A chain cannot loop back onto a commitment it already used, in either direction.
        bytes memory alreadyIssued = _selector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector);
        _expectExecuteRevert(reviewerKey, _supersede(reviewer, COMMITMENT_C, COMMITMENT_A), alreadyIssued);
        _expectExecuteRevert(reviewerKey, _supersede(reviewer, COMMITMENT_C, COMMITMENT_B), alreadyIssued);
        _assertReceipt(reviewer, COMMITMENT_C, ACTIVE, COMMITMENT_B, bytes32(0), T2, T2);
    }

    /// @dev A reviewer may hold several Active receipts: "exactly one Active" is a statement about
    /// one superseded pair right after its transition, never about a reviewer as a whole.
    function test_aReviewerMayHoldSeveralActiveReceiptsAtOnce() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_C));
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_B).status), uint8(ACTIVE));
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_C).status), uint8(ACTIVE));
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_A).status), uint8(SUPERSEDED));
    }

    function test_supersessionByAContractAccountEmitsIssuedThenSupersededWithOneNonce() public {
        ERC1271OwnedAccount account = new ERC1271OwnedAccount(reviewer);
        address signer = address(account);
        _execute(reviewerKey, _issue(signer, COMMITMENT_A));
        vm.warp(T1);

        IProofOfReviewRegistry.ReviewAction memory action = _supersede(signer, COMMITMENT_A, COMMITMENT_B);
        bytes memory signature = _sign(reviewerKey, action);
        vm.recordLogs();
        vm.prank(other); // an unrelated account pays for and submits it
        registry.execute(action, signature);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "one issuance log and one link log, nothing else");
        _assertIssuedLog(logs[0], signer, COMMITMENT_B, COMMITMENT_A, 1);
        _assertSupersededLog(logs[1], signer, COMMITMENT_A, COMMITMENT_B, 1);
        // Two logs, ONE consumed authorisation and ONE new receipt.
        assertEq(registry.nonceOf(signer), 2);
        _assertReceipt(signer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(signer, COMMITMENT_B, ACTIVE, COMMITMENT_A, bytes32(0), T1, T1);
        // The submitter gained nothing and its own namespace is untouched.
        assertEq(registry.nonceOf(other), 0);
        _assertNotFound(other, COMMITMENT_B);
    }

    /// @dev A reverted transaction commits nothing: no status, link, time, nonce or receipt log.
    /// (Inside the reverted call the registry did write and emit; that is a trace-level
    /// observation, not committed state, and it is not what a reader of the chain sees.)
    function test_aRevertedSupersessionCommitsNoLifecycleChangeAndNoLogs() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_B));
        vm.warp(T1);
        uint256 nonceBefore = registry.nonceOf(reviewer);

        vm.recordLogs();
        // The old receipt is Active and the signature valid: the replacement alone is unusable,
        // so the failure happens AFTER the old receipt was retired inside the call.
        _expectExecuteRevert(
            reviewerKey,
            _supersede(reviewer, COMMITMENT_A, COMMITMENT_B),
            _selector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
        );
        // The previous receipt is not Active: nothing is created either.
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C), _transition(REVOKED)
        );
        assertEq(vm.getRecordedLogs().length, 0, "a reverted transaction leaves no receipt log");

        assertEq(registry.nonceOf(reviewer), nonceBefore);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(reviewer, COMMITMENT_B, REVOKED, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(reviewer, COMMITMENT_C);
    }

    /// @dev Two different, validly signed actions carry the same nonce. Submitted one after the
    /// other, exactly one wins; the loser authorises nothing, whoever submits it and however often.
    function test_twoSignedActionsRacingForOneNonceHaveExactlyOneWinner() public {
        IProofOfReviewRegistry.ReviewAction memory first = _issue(reviewer, COMMITMENT_A);
        IProofOfReviewRegistry.ReviewAction memory second = _issue(reviewer, COMMITMENT_B);
        assertEq(first.nonce, second.nonce);
        bytes memory firstSignature = _sign(reviewerKey, first);
        bytes memory secondSignature = _sign(reviewerKey, second);

        vm.prank(relayer);
        registry.execute(first, firstSignature);

        vm.recordLogs();
        address[3] memory submitters = [other, relayer, reviewer];
        for (uint256 i = 0; i < submitters.length; ++i) {
            vm.expectRevert(_invalidNonce(1));
            vm.prank(submitters[i]);
            registry.execute(second, secondSignature);
            // The winner's own signature is spent as well.
            vm.expectRevert(_invalidNonce(1));
            vm.prank(submitters[i]);
            registry.execute(first, firstSignature);
        }
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(registry.nonceOf(reviewer), 1, "one winner consumed the nonce once");
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(reviewer, COMMITMENT_B);
    }

    function test_identicalBytesUnderTwoReviewersEvolveIndependently() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(otherKey, _issue(other, COMMITMENT_A));
        vm.warp(T1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));

        // The other reviewer's record with the same bytes has no successor and is still Active.
        _assertReceipt(other, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(other, COMMITMENT_B);
        assertEq(registry.nonceOf(other), 1);

        vm.warp(T2);
        _execute(otherKey, _revoke(other, COMMITMENT_A));
        _execute(otherKey, _issue(other, COMMITMENT_D));
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, COMMITMENT_A, bytes32(0), T1, T1);
        _assertNotFound(reviewer, COMMITMENT_D);
        assertEq(registry.nonceOf(reviewer), 2);

        // A reviewer cannot act on the other namespace even with a perfectly valid own signature.
        IProofOfReviewRegistry.ReviewAction memory foreign = _revoke(other, COMMITMENT_D);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        vm.prank(reviewer);
        registry.execute(foreign, _sign(reviewerKey, foreign));
        _assertReceipt(other, COMMITMENT_D, ACTIVE, bytes32(0), bytes32(0), T2, T2);
    }
}
