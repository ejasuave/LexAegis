// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../../src/interfaces/IProofOfReviewRegistry.sol";
import {ReviewRegistryHandler} from "./ReviewRegistryHandler.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Exposes two deliberately wrong uses of the handler, to prove it does not swallow failures.
contract FaultyHandler is ReviewRegistryHandler {
    constructor(ProofOfReviewRegistry registry) ReviewRegistryHandler(registry) {}

    /// @dev Declares a perfectly valid action "invalid": the handler must refuse to count it.
    function expectRejectionOfAValidAction() external {
        address reviewer = _reviewers[0];
        IProofOfReviewRegistry.ReviewAction memory action =
            _build(reviewer, ReviewActionCodes.ISSUE, _pool[0], bytes32(0), type(uint256).max);
        _expectRejection(
            Op.RejectSignature,
            reviewer,
            action,
            _signature(_key[reviewer], _digest(action)),
            _executors[0],
            _one(abi.encodeWithSelector(IProofOfReviewRegistry.InvalidSignature.selector))
        );
    }

    /// @dev Desynchronises the model, so the next "valid" action is not valid on the registry.
    function corruptModelNonce() external {
        _nonce[_reviewers[0]] = 7;
    }

    /// @dev A rejection for a reason the model did not predict.
    function expectTheWrongReason() external {
        address reviewer = _reviewers[0];
        IProofOfReviewRegistry.ReviewAction memory action =
            _build(reviewer, ReviewActionCodes.ISSUE, _pool[0], bytes32(0), 0);
        _expectRejection(
            Op.RejectDeadline,
            reviewer,
            action,
            _signature(_key[reviewer], _digest(action)),
            _executors[0],
            _one(abi.encodeWithSelector(IProofOfReviewRegistry.InvalidSignature.selector))
        );
    }
}

/// @notice Deterministic checks of the stateful handler itself: it reaches every meaningful state
/// with real signatures, counts what happened, and fails loudly when an outcome is not the modelled one.
contract ReviewRegistryHandlerTest is Test {
    ProofOfReviewRegistry internal registry;
    ReviewRegistryHandler internal handler;

    IProofOfReviewRegistry.ReceiptStatus internal constant NOT_FOUND =
    IProofOfReviewRegistry.ReceiptStatus.NotFound;
    IProofOfReviewRegistry.ReceiptStatus internal constant ACTIVE =
    IProofOfReviewRegistry.ReceiptStatus.Active;
    IProofOfReviewRegistry.ReceiptStatus internal constant REVOKED =
    IProofOfReviewRegistry.ReceiptStatus.Revoked;
    IProofOfReviewRegistry.ReceiptStatus internal constant SUPERSEDED =
    IProofOfReviewRegistry.ReceiptStatus.Superseded;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ProofOfReviewRegistry();
        handler = new ReviewRegistryHandler(registry);
    }

    function _succeeded(ReviewRegistryHandler.Op op) internal view returns (uint256) {
        return handler.totalOf(op).succeeded;
    }

    function _rejected(ReviewRegistryHandler.Op op) internal view returns (uint256) {
        return handler.totalOf(op).expectedRejected;
    }

    function _status(address reviewer, bytes32 commitment)
        internal
        view
        returns (IProofOfReviewRegistry.ReceiptStatus)
    {
        return registry.getReceipt(reviewer, commitment).status;
    }

    function test_theModelHasFourEoaReviewersOneContractReviewerAndDistinctExecutors() public view {
        assertEq(handler.reviewerCount(), 5);
        assertEq(handler.EOA_REVIEWERS(), 4);
        address contractReviewer = address(handler.CONTRACT_REVIEWER());
        assertGt(contractReviewer.code.length, 0, "the fifth reviewer is a deployed ERC-1271 account");
        assertEq(handler.reviewerAt(4), contractReviewer);
        // Reviewers first, then executors: all distinct.
        assertEq(handler.accountCount(), 8);
        for (uint256 i = 0; i < handler.accountCount(); ++i) {
            if (i < 4) assertEq(handler.accountAt(i).code.length, 0, "EOA reviewer");
            for (uint256 j = i + 1; j < handler.accountCount(); ++j) {
                assertTrue(handler.accountAt(i) != handler.accountAt(j), "accounts must be distinct");
            }
        }
        assertEq(address(handler.REGISTRY()), address(registry), "the real registry, not a stand-in");
    }

    /// @dev Fixed inputs: every operation kind succeeds or is rejected exactly as modelled, in more
    /// than one namespace, and the registry ends in the states the sequence intends.
    function test_deterministicProgressionReachesEveryMeaningfulState() public {
        bytes32 first = handler.poolAt(0);
        bytes32 second = handler.poolAt(1);
        bytes32 third = handler.poolAt(2);

        // Every reviewer, the contract account included, issues the SAME bytes (pick seed 0 = lowest free).
        for (uint256 r = 0; r < 5; ++r) {
            handler.issue(r, 0, r, 60);
            assertEq(uint8(_status(handler.reviewerAt(r), first)), uint8(ACTIVE));
        }
        assertEq(_succeeded(ReviewRegistryHandler.Op.Issue), 5);
        assertEq(handler.sharedCommitmentIssues(), 4, "four issuances reused bytes another reviewer holds");

        // Reviewer 0: issue -> supersede -> supersede again (a chain of three).
        handler.supersede(0, 0, 3, 61);
        handler.supersede(0, 0, 4, 62);
        address zero = handler.reviewerAt(0);
        assertEq(uint8(_status(zero, first)), uint8(SUPERSEDED));
        assertEq(uint8(_status(zero, second)), uint8(SUPERSEDED));
        assertEq(uint8(_status(zero, third)), uint8(ACTIVE));
        assertEq(handler.chainedSupersessions(), 1);

        // Reviewer 1: issue -> supersede -> revoke the replacement. Neither member is Active afterwards.
        handler.supersede(1, 0, 0, 63);
        handler.revoke(1, 0, 1, 64);
        address one = handler.reviewerAt(1);
        assertEq(uint8(_status(one, first)), uint8(SUPERSEDED));
        assertEq(uint8(_status(one, second)), uint8(REVOKED));

        // The contract account supersedes, and reviewer 2 cancels an outstanding nonce directly.
        handler.supersede(4, 0, 2, 65);
        handler.invalidate(2, 66);
        assertEq(_succeeded(ReviewRegistryHandler.Op.Supersede), 4);
        assertEq(_succeeded(ReviewRegistryHandler.Op.Revoke), 1);
        assertEq(_succeeded(ReviewRegistryHandler.Op.Invalidate), 1);
        assertEq(registry.nonceOf(handler.reviewerAt(2)), 2, "one issue, one invalidation");

        // Every rejection class, across modes, with the real signature checker.
        for (uint256 mode = 0; mode < 30; ++mode) {
            handler.rejectSignature(mode, mode * 7, mode, mode, 67);
            handler.rejectShapeOrDeadline(mode, mode * 5, mode, mode, 68);
            handler.rejectLifecycle(mode, mode * 3, mode, mode, 69);
            handler.rejectNonce(mode, mode * 11, mode, mode, 70);
        }
        // The contract account changes its signing policy: the previous owner's signature is refused,
        // and the account's next valid action is signed by the new owner.
        handler.rejectSignature(4, 0, 8, 0, 71);
        handler.issue(4, 1, 0, 72);
        assertEq(_rejected(ReviewRegistryHandler.Op.RejectSignature), 31);
        assertGt(_rejected(ReviewRegistryHandler.Op.RejectShape), 0);
        assertGt(_rejected(ReviewRegistryHandler.Op.RejectDeadline), 0);
        assertEq(
            _rejected(ReviewRegistryHandler.Op.RejectShape)
                + _rejected(ReviewRegistryHandler.Op.RejectDeadline),
            30
        );
        assertEq(_rejected(ReviewRegistryHandler.Op.RejectLifecycle), 30);
        assertGt(_rejected(ReviewRegistryHandler.Op.RejectNonce), 0);
        assertGt(_rejected(ReviewRegistryHandler.Op.RejectInvalidation), 0);
        assertGt(handler.contractOwnerRotations(), 0, "the contract account changed its signing policy");
        assertEq(handler.unexpectedRejected(), 0, "a rejection had an unmodelled reason");

        // The registry is exactly where the valid operations left it: no rejected call moved anything.
        assertEq(uint8(_status(zero, third)), uint8(ACTIVE));
        assertEq(uint8(_status(one, second)), uint8(REVOKED));
        for (uint256 i = 0; i < handler.accountCount(); ++i) {
            address account = handler.accountAt(i);
            assertEq(registry.nonceOf(account), handler.ghostNonce(account), "nonce");
            assertEq(
                registry.nonceOf(account),
                handler.successfulExecutes(account) + handler.successfulInvalidations(account)
            );
        }
    }

    function test_countsAreKeptPerOperationAndPerReviewer() public {
        handler.issue(3, 0, 0, 1);
        handler.rejectLifecycle(3, 0, 0, 0, 2);
        address reviewer = handler.reviewerAt(3);
        ReviewRegistryHandler.Counts memory issued =
            handler.countsOf(ReviewRegistryHandler.Op.Issue, reviewer);
        assertEq(issued.attempted, 1);
        assertEq(issued.succeeded, 1);
        assertEq(issued.expectedRejected, 0);
        ReviewRegistryHandler.Counts memory rejected =
            handler.countsOf(ReviewRegistryHandler.Op.RejectLifecycle, reviewer);
        assertEq(rejected.attempted, 1);
        assertEq(rejected.succeeded, 0);
        assertEq(rejected.expectedRejected, 1);
        assertEq(rejected.unexpectedRejected, 0);
        // Nothing was attributed to anyone else.
        assertEq(handler.countsOf(ReviewRegistryHandler.Op.Issue, handler.reviewerAt(0)).attempted, 0);
        (uint256[10] memory attempted, uint256[10] memory succeeded, uint256[10] memory refused) =
            handler.coverage();
        assertEq(attempted[uint256(ReviewRegistryHandler.Op.Issue)], 1);
        assertEq(succeeded[uint256(ReviewRegistryHandler.Op.Issue)], 1);
        assertEq(refused[uint256(ReviewRegistryHandler.Op.RejectLifecycle)], 1);
    }

    function test_aStrangerNamingAReviewersNonceActsOnlyForItself() public {
        // Reviewer 0 is at nonce 1; executor 0 is at 0. Naming 1 is refused for the executor.
        handler.issue(0, 0, 0, 1);
        address reviewer = handler.reviewerAt(0);
        handler.rejectNonce(0, 0, 3, 0, 2);
        assertEq(_rejected(ReviewRegistryHandler.Op.RejectInvalidation), 1);
        assertEq(registry.nonceOf(reviewer), 1);

        // Reviewer 1 is at nonce 0, the same value as executor 1: the call is the executor's own
        // legitimate cancellation and still cannot touch the reviewer.
        address stranger = handler.accountAt(5 + 1);
        handler.rejectNonce(1, 0, 3, 1, 3);
        assertEq(registry.nonceOf(stranger), 1, "the caller advanced its own nonce");
        assertEq(registry.nonceOf(handler.reviewerAt(1)), 0, "the named reviewer is untouched");
        assertEq(handler.successfulInvalidations(stranger), 1);
    }

    // ---- Negative controls: the handler cannot pass by swallowing a failure -----------------------

    function test_aValidActionDeclaredInvalidEscapesAsUnexpectedSuccess() public {
        FaultyHandler faulty = new FaultyHandler(registry);
        vm.expectRevert(
            abi.encodeWithSelector(
                ReviewRegistryHandler.UnexpectedSuccess.selector, ReviewRegistryHandler.Op.RejectSignature
            )
        );
        faulty.expectRejectionOfAValidAction();
    }

    function test_anUnexpectedRevertOfAConstructedValidActionEscapesTheHandler() public {
        FaultyHandler faulty = new FaultyHandler(registry);
        faulty.corruptModelNonce();
        // No try/catch around valid actions: the registry's own error reaches the caller.
        vm.expectRevert(abi.encodeWithSelector(IProofOfReviewRegistry.InvalidNonce.selector, 0));
        faulty.issue(0, 0, 0, 1);
    }

    function test_aRejectionForAnUnmodelledReasonIsCountedNotAccepted() public {
        FaultyHandler faulty = new FaultyHandler(registry);
        faulty.expectTheWrongReason();
        assertEq(faulty.unexpectedRejected(), 1);
        assertEq(faulty.totalOf(ReviewRegistryHandler.Op.RejectDeadline).expectedRejected, 0);
        assertEq(
            faulty.lastUnexpectedRevert(),
            abi.encodeWithSelector(IProofOfReviewRegistry.AuthorizationExpired.selector)
        );
    }
}
