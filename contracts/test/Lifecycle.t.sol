// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IProofOfReviewRegistry, ReviewActionCodes} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";
import {Vm} from "forge-std/Vm.sol";

contract LifecycleTest is RegistryTestBase {
    IProofOfReviewRegistry.ReceiptStatus internal constant NOT_FOUND =
    IProofOfReviewRegistry.ReceiptStatus.NotFound;
    IProofOfReviewRegistry.ReceiptStatus internal constant ACTIVE =
    IProofOfReviewRegistry.ReceiptStatus.Active;
    IProofOfReviewRegistry.ReceiptStatus internal constant REVOKED =
    IProofOfReviewRegistry.ReceiptStatus.Revoked;
    IProofOfReviewRegistry.ReceiptStatus internal constant SUPERSEDED =
    IProofOfReviewRegistry.ReceiptStatus.Superseded;

    uint256 internal constant T0 = START_TIME;
    uint256 internal constant T1 = START_TIME + 1 hours;
    uint256 internal constant T2 = START_TIME + 2 hours;

    // ---- ABI constants ------------------------------------------------------------------------

    function test_actionCodesAndStatusOrderAreTheV1Values() public pure {
        assertEq(ReviewActionCodes.ISSUE, 0);
        assertEq(ReviewActionCodes.REVOKE, 1);
        assertEq(ReviewActionCodes.SUPERSEDE, 2);
        assertEq(uint8(NOT_FOUND), 0);
        assertEq(uint8(ACTIVE), 1);
        assertEq(uint8(REVOKED), 2);
        assertEq(uint8(SUPERSEDED), 3);
    }

    function test_missingRecordIsNotFoundWithZeroMetadata() public view {
        _assertNotFound(reviewer, COMMITMENT_A);
        _assertNotFound(address(0), bytes32(0));
    }

    // ---- ISSUE --------------------------------------------------------------------------------

    function test_issueCreatesOneActiveReceiptWithNoPredecessor() public {
        vm.recordLogs();
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        _assertIssuedLog(logs[0], reviewer, COMMITMENT_A, bytes32(0), 0);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(reviewer, COMMITMENT_B);
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_duplicateIssueFailsForActiveRevokedAndSupersededRecords() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _expectAlreadyIssued(_issue(reviewer, COMMITMENT_A)); // Active

        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        _expectAlreadyIssued(_issue(reviewer, COMMITMENT_A)); // Superseded

        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_B));
        _expectAlreadyIssued(_issue(reviewer, COMMITMENT_B)); // Revoked

        assertEq(registry.nonceOf(reviewer), 3);
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T0);
        _assertReceipt(reviewer, COMMITMENT_B, REVOKED, COMMITMENT_A, bytes32(0), T0, T0);
    }

    function test_anotherReviewerMayUseIdenticalCommitmentBytes() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);
        _execute(otherKey, _issue(other, COMMITMENT_A));

        // Neither blocked nor overwrote the other.
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(other, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T1, T1);

        vm.warp(T2);
        _execute(otherKey, _revoke(other, COMMITMENT_A));
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(other, COMMITMENT_A, REVOKED, bytes32(0), bytes32(0), T1, T2);
    }

    function test_zeroCommitmentIsNeverIssued() public {
        _expectExecuteRevert(
            reviewerKey,
            _issue(reviewer, bytes32(0)),
            _selector(IProofOfReviewRegistry.ZeroCommitment.selector)
        );
        _expectExecuteRevert(
            reviewerKey,
            _revoke(reviewer, bytes32(0)),
            _selector(IProofOfReviewRegistry.ZeroCommitment.selector)
        );
        assertEq(registry.nonceOf(reviewer), 0);
    }

    // ---- REVOKE -------------------------------------------------------------------------------

    function test_revokeChangesOnlyStatusAndUpdatedAt() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);

        vm.recordLogs();
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_A));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        _assertRevokedLog(logs[0], reviewer, COMMITMENT_A, 1);
        _assertReceipt(reviewer, COMMITMENT_A, REVOKED, bytes32(0), bytes32(0), T0, T1);
    }

    function test_revokeAffectsOnlyTheAuthorizedReviewersActiveReceipt() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(otherKey, _issue(other, COMMITMENT_A));

        // Another reviewer's valid signature cannot reach this reviewer's record...
        _expectExecuteRevert(
            otherKey,
            _revoke(reviewer, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.InvalidSignature.selector)
        );
        // ...and their own REVOKE touches only their own namespace.
        _execute(otherKey, _revoke(other, COMMITMENT_A));
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        assertEq(uint8(registry.getReceipt(other, COMMITMENT_A).status), uint8(REVOKED));

        // A reviewer cannot revoke a commitment they never issued, even if someone else did.
        _execute(otherKey, _issue(other, COMMITMENT_B));
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_B), _transition(NOT_FOUND));
    }

    function test_revokeRequiresAnActiveReceipt() public {
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_A), _transition(NOT_FOUND));

        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_A));
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_A), _transition(REVOKED));

        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C));
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_B), _transition(SUPERSEDED));
    }

    // ---- SUPERSEDE ----------------------------------------------------------------------------

    function test_supersedeReplacesAtomicallyWithLinksAndOrderedEvents() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);

        vm.recordLogs();
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));

        // Exactly two logs, replacement issuance first, both carrying the one consumed nonce.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        _assertIssuedLog(logs[0], reviewer, COMMITMENT_B, COMMITMENT_A, 1);
        _assertSupersededLog(logs[1], reviewer, COMMITMENT_A, COMMITMENT_B, 1);
        assertEq(registry.nonceOf(reviewer), 2);

        // Old: terminal, linked forward, original issuance time kept. New: Active, linked back.
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, COMMITMENT_A, bytes32(0), T1, T1);
    }

    function test_supersedeRequiresAnActivePredecessor() public {
        // Missing.
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B), _transition(NOT_FOUND)
        );

        // Revoked.
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_A));
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B), _transition(REVOKED)
        );

        // Already superseded.
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C));
        _expectExecuteRevert(
            reviewerKey,
            _supersede(reviewer, COMMITMENT_B, keccak256("synthetic commitment D")),
            _transition(SUPERSEDED)
        );

        _assertNotFound(reviewer, keccak256("synthetic commitment D"));
        assertEq(registry.getReceipt(reviewer, COMMITMENT_B).successor, COMMITMENT_C);
    }

    function test_supersedeRejectsZeroEqualAndPreviouslyIssuedReplacements() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_C));
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_C));

        _expectExecuteRevert(
            reviewerKey,
            _supersede(reviewer, COMMITMENT_A, bytes32(0)),
            _selector(IProofOfReviewRegistry.ZeroCommitment.selector)
        );
        _expectExecuteRevert(
            reviewerKey,
            _supersede(reviewer, COMMITMENT_A, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.InvalidActionShape.selector)
        );
        // Replacement already Active, and replacement already Revoked.
        _expectAlreadyIssued(_supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        _expectAlreadyIssued(_supersede(reviewer, COMMITMENT_A, COMMITMENT_C));

        // Nothing moved: no partial supersession survived a failed replacement.
        assertEq(registry.nonceOf(reviewer), 4);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(reviewer, COMMITMENT_C, REVOKED, bytes32(0), bytes32(0), T0, T0);
    }

    function test_aCommitmentIssuedByAnotherReviewerIsStillAFreeReplacement() public {
        _execute(otherKey, _issue(other, COMMITMENT_B));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));

        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, COMMITMENT_A, bytes32(0), T0, T0);
        _assertReceipt(other, COMMITMENT_B, ACTIVE, bytes32(0), bytes32(0), T0, T0);
    }

    function test_revokingAReplacementNeverRestoresTheEarlierApproval() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        vm.warp(T2);
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_B));

        // Neither version is Active, and the links are intact.
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, REVOKED, COMMITMENT_A, bytes32(0), T1, T2);

        // The earlier approval cannot be brought back by any action.
        _expectAlreadyIssued(_issue(reviewer, COMMITMENT_A));
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_A), _transition(SUPERSEDED));
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_C), _transition(SUPERSEDED)
        );
        _expectExecuteRevert(
            reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C), _transition(REVOKED)
        );
    }

    function test_furtherSupersessionIsAllowedOnlyFromAnActiveReplacement() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        vm.warp(T1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        vm.warp(T2);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_B, COMMITMENT_C));

        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, T0, T1);
        _assertReceipt(reviewer, COMMITMENT_B, SUPERSEDED, COMMITMENT_A, COMMITMENT_C, T1, T2);
        _assertReceipt(reviewer, COMMITMENT_C, ACTIVE, COMMITMENT_B, bytes32(0), T2, T2);

        // A chain cannot loop back onto an earlier commitment.
        _expectAlreadyIssued(_supersede(reviewer, COMMITMENT_C, COMMITMENT_A));
    }

    // ---- Shape and value ----------------------------------------------------------------------

    function test_unexpectedReplacementValuesAreRejected() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        bytes memory shape = _selector(IProofOfReviewRegistry.InvalidActionShape.selector);

        _expectExecuteRevert(
            reviewerKey, _action(reviewer, ReviewActionCodes.ISSUE, COMMITMENT_B, COMMITMENT_C), shape
        );
        _expectExecuteRevert(
            reviewerKey, _action(reviewer, ReviewActionCodes.REVOKE, COMMITMENT_A, COMMITMENT_C), shape
        );
        assertEq(registry.nonceOf(reviewer), 1);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(reviewer, COMMITMENT_B);
        _assertNotFound(reviewer, COMMITMENT_C);
    }

    function test_unknownActionCodeNeverActsOnAnActiveReceipt() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        bytes memory shape = _selector(IProofOfReviewRegistry.InvalidActionShape.selector);

        // Whatever the replacement field holds, an unknown code is not treated as any known action.
        uint8[3] memory codes = [3, 4, type(uint8).max];
        for (uint256 i = 0; i < codes.length; ++i) {
            _expectExecuteRevert(reviewerKey, _action(reviewer, codes[i], COMMITMENT_A, bytes32(0)), shape);
            _expectExecuteRevert(reviewerKey, _action(reviewer, codes[i], COMMITMENT_A, COMMITMENT_B), shape);
            _expectExecuteRevert(reviewerKey, _action(reviewer, codes[i], COMMITMENT_B, bytes32(0)), shape);
        }
        assertEq(registry.nonceOf(reviewer), 1);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertNotFound(reviewer, COMMITMENT_B);
    }

    function testFuzz_unknownActionCodesAreRejected(
        uint8 code,
        bytes32 commitment,
        bytes32 replacement,
        bool unusedReplacement
    ) public {
        vm.assume(commitment != bytes32(0));
        if (unusedReplacement) replacement = bytes32(0);
        code = uint8(bound(code, 3, type(uint8).max));
        _expectExecuteRevert(
            reviewerKey,
            _action(reviewer, code, commitment, replacement),
            _selector(IProofOfReviewRegistry.InvalidActionShape.selector)
        );
        assertEq(registry.nonceOf(reviewer), 0);
    }

    function test_mutationEntryPointsRejectValue() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);
        vm.deal(relayer, 3 ether);

        vm.startPrank(relayer);
        (bool executed,) =
            address(registry).call{value: 1 wei}(abi.encodeCall(registry.execute, (action, signature)));
        (bool invalidated,) =
            address(registry).call{value: 1 wei}(abi.encodeCall(registry.invalidateNonce, (0)));
        (bool received,) = address(registry).call{value: 1 wei}("");
        vm.stopPrank();

        assertFalse(executed);
        assertFalse(invalidated);
        assertFalse(received);
        assertEq(address(registry).balance, 0);
        assertEq(registry.nonceOf(reviewer), 0);
        assertEq(registry.nonceOf(relayer), 0);
        _assertNotFound(reviewer, COMMITMENT_A);
    }

    function test_rejectedOperationsRollBackStorageNonceAndLogs() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        uint256 nonceBefore = registry.nonceOf(reviewer);

        // The authorization is valid and the old receipt is Active; only the replacement is taken.
        // The whole action must unwind, including the already-consumed nonce.
        vm.recordLogs();
        _expectAlreadyIssued(_supersede(reviewer, COMMITMENT_A, COMMITMENT_B));
        assertEq(vm.getRecordedLogs().length, 0);

        assertEq(registry.nonceOf(reviewer), nonceBefore);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        _assertReceipt(reviewer, COMMITMENT_B, ACTIVE, bytes32(0), bytes32(0), T0, T0);

        // The reviewer's next signature over the same nonce is still good.
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_C));
        assertEq(registry.nonceOf(reviewer), nonceBefore + 1);
    }

    // ---- Bounded fuzz -------------------------------------------------------------------------

    function testFuzz_issueThenRevoke(uint256 keySeed, bytes32 commitment, uint32 delay, address executor)
        public
    {
        vm.assume(commitment != bytes32(0));
        (address signer, uint256 key) = _fuzzSigner(keySeed);

        IProofOfReviewRegistry.ReviewAction memory issue = _issue(signer, commitment);
        bytes memory issueSignature = _sign(key, issue);
        vm.prank(executor);
        registry.execute(issue, issueSignature);
        _assertReceipt(signer, commitment, ACTIVE, bytes32(0), bytes32(0), T0, T0);

        vm.warp(T0 + delay);
        IProofOfReviewRegistry.ReviewAction memory revoke = _revoke(signer, commitment);
        bytes memory revokeSignature = _sign(key, revoke);
        vm.prank(executor);
        registry.execute(revoke, revokeSignature);

        _assertReceipt(signer, commitment, REVOKED, bytes32(0), bytes32(0), T0, T0 + delay);
        assertEq(registry.nonceOf(signer), 2);
    }

    function testFuzz_reviewerNamespacesAreIsolated(uint256 seedA, uint256 seedB, bytes32 commitment) public {
        vm.assume(commitment != bytes32(0));
        (address signerA, uint256 keyA) = _fuzzSigner(seedA);
        (address signerB, uint256 keyB) = _fuzzSigner(seedB);
        vm.assume(signerA != signerB);

        _execute(keyA, _issue(signerA, commitment));
        _assertNotFound(signerB, commitment);

        // B cannot act on A's receipt with B's own valid signature.
        _expectExecuteRevert(keyB, _revoke(signerB, commitment), _transition(NOT_FOUND));
        _expectExecuteRevert(
            keyB, _revoke(signerA, commitment), _selector(IProofOfReviewRegistry.InvalidSignature.selector)
        );

        _execute(keyB, _issue(signerB, commitment));
        _execute(keyB, _revoke(signerB, commitment));
        _assertReceipt(signerA, commitment, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        assertEq(registry.nonceOf(signerA), 1);
        assertEq(registry.nonceOf(signerB), 2);
    }

    function testFuzz_supersessionChainKeepsLinksAndTimes(uint8 lengthSeed, bytes32 salt) public {
        uint256 length = bound(lengthSeed, 2, 12);
        bytes32[] memory chain = new bytes32[](length);
        for (uint256 i = 0; i < length; ++i) {
            chain[i] = keccak256(abi.encode(salt, i));
        }

        _execute(reviewerKey, _issue(reviewer, chain[0]));
        for (uint256 i = 1; i < length; ++i) {
            vm.warp(T0 + i);
            _execute(reviewerKey, _supersede(reviewer, chain[i - 1], chain[i]));
        }

        // One nonce per action, exactly one Active head, and consistent links throughout.
        assertEq(registry.nonceOf(reviewer), length);
        for (uint256 i = 0; i < length; ++i) {
            bool head = i == length - 1;
            _assertReceipt(
                reviewer,
                chain[i],
                head ? ACTIVE : SUPERSEDED,
                i == 0 ? bytes32(0) : chain[i - 1],
                head ? bytes32(0) : chain[i + 1],
                T0 + i,
                head ? T0 + i : T0 + i + 1
            );
        }
    }

    function testFuzz_invalidOperationsNeverChangeState(
        uint8 code,
        bytes32 commitment,
        bytes32 replacement,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        IProofOfReviewRegistry.ReviewAction memory action = IProofOfReviewRegistry.ReviewAction({
            reviewer: reviewer,
            action: code,
            commitment: commitment,
            replacementCommitment: replacement,
            nonce: nonce,
            deadline: deadline
        });

        // Arbitrary bytes are never a valid signature for this reviewer.
        vm.recordLogs();
        vm.expectRevert();
        vm.prank(relayer);
        registry.execute(action, signature);

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(registry.nonceOf(reviewer), 1);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), T0, T0);
        if (commitment != COMMITMENT_A) _assertNotFound(reviewer, commitment);
        if (replacement != COMMITMENT_A) _assertNotFound(reviewer, replacement);
    }

    // ---- Helpers ------------------------------------------------------------------------------

    function _expectAlreadyIssued(IProofOfReviewRegistry.ReviewAction memory action) private {
        _expectExecuteRevert(
            reviewerKey, action, _selector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
        );
    }

    function _fuzzSigner(uint256 seed) private pure returns (address signer, uint256 key) {
        key = bound(seed, 1, SECP256K1_N - 1);
        signer = vm.addr(key);
    }
}
