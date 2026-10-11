// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";
import {
    ERC1271MalformedReturn,
    ERC1271OwnedAccount,
    ERC1271Reentrant,
    ERC1271Reverting,
    ERC1271WrongMagic
} from "./fixtures/ERC1271Fixtures.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Vm} from "forge-std/Vm.sol";

contract AuthorizationTest is RegistryTestBase {
    using stdStorage for StdStorage;

    IProofOfReviewRegistry.ReceiptStatus internal constant ACTIVE =
    IProofOfReviewRegistry.ReceiptStatus.Active;
    IProofOfReviewRegistry.ReceiptStatus internal constant REVOKED =
    IProofOfReviewRegistry.ReceiptStatus.Revoked;
    IProofOfReviewRegistry.ReceiptStatus internal constant NOT_FOUND =
    IProofOfReviewRegistry.ReceiptStatus.NotFound;

    // ---- Domain and digest --------------------------------------------------------------------

    function test_domainIsFixedAndBoundToThisChainAndRegistry() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = registry.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "LexAegisProofOfReview");
        assertEq(version, "1");
        assertEq(chainId, vm.getChainId());
        assertEq(verifyingContract, address(registry));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
        assertEq(registry.protocolVersion(), 1);
    }

    function test_typeHashIsTheExactPrimaryTypeString() public view {
        assertEq(registry.REVIEW_ACTION_TYPEHASH(), ACTION_TYPEHASH);
        assertEq(
            ACTION_TYPEHASH,
            keccak256(
                bytes(
                    "ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)"
                )
            )
        );
    }

    function test_hashActionMatchesAnIndependentEip712Digest() public view {
        IProofOfReviewRegistry.ReviewAction memory action = _supersede(reviewer, COMMITMENT_A, COMMITMENT_B);
        assertEq(registry.hashAction(action), _digest(action));
    }

    function testFuzz_hashActionMatchesAnIndependentEip712Digest(
        IProofOfReviewRegistry.ReviewAction memory action
    ) public view {
        assertEq(registry.hashAction(action), _digest(action));
    }

    // ---- Signatures ---------------------------------------------------------------------------

    function test_eoaSignatureAuthorizesAThirdPartySubmission() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);

        vm.prank(relayer);
        registry.execute(action, signature);

        // The relayer only executed: the receipt belongs to the signer and the relayer has none.
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);
        _assertNotFound(relayer, COMMITMENT_A);
        assertEq(registry.nonceOf(reviewer), 1);
        assertEq(registry.nonceOf(relayer), 0);
    }

    function test_reviewerMaySubmitTheirOwnSignedAction() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);
        vm.prank(reviewer);
        registry.execute(action, signature);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);
    }

    function test_thereIsNoSignatureFreeShortcutForTheReviewer() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        vm.prank(reviewer);
        registry.execute(action, "");
        _assertUntouched();
    }

    function test_wrongSignerIsRejected() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        _expectExecuteRevert(otherKey, action, _selector(IProofOfReviewRegistry.InvalidSignature.selector));
        _assertUntouched();
    }

    function test_zeroReviewerIsRejected() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(address(0), COMMITMENT_A);
        _expectExecuteRevert(reviewerKey, action, _selector(IProofOfReviewRegistry.ZeroReviewer.selector));
        // A signature that fails to recover yields the zero address; it must not authorize it.
        vm.expectRevert(IProofOfReviewRegistry.ZeroReviewer.selector);
        registry.execute(action, new bytes(65));
    }

    function test_emptyAndMalformedSignaturesAreRejected() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reviewerKey, _digest(action));

        bytes[] memory malformed = new bytes[](7);
        malformed[0] = "";
        malformed[1] = abi.encodePacked(r, s); // 64 bytes: v missing
        malformed[2] = abi.encodePacked(r, s, v, uint8(0)); // 66 bytes
        malformed[3] = abi.encodePacked(r, s, uint8(v - 27)); // v as 0/1
        malformed[4] = abi.encodePacked(r, s, uint8(v + 2)); // v out of range
        malformed[5] = abi.encodePacked(r, bytes32(uint256(s) ^ 1), v); // altered s
        malformed[6] = new bytes(65); // all zero

        for (uint256 i = 0; i < malformed.length; ++i) {
            vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
            registry.execute(action, malformed[i]);
        }
        _assertUntouched();

        // The untouched signature is still usable afterwards.
        registry.execute(action, abi.encodePacked(r, s, v));
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_erc2098CompactSignatureIsRejected() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        (bytes32 r, bytes32 vs) = vm.signCompact(reviewerKey, _digest(action));
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, abi.encodePacked(r, vs));
        _assertUntouched();
    }

    function test_malleableHighSSignatureIsRejected() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes32 digest = _digest(action);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reviewerKey, digest);

        // The mirrored signature recovers to the same signer under raw ecrecover...
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), reviewer);

        // ...and the registry still refuses it.
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, abi.encodePacked(r, highS, flippedV));
        _assertUntouched();
    }

    // ---- Every signed field is bound ----------------------------------------------------------

    function test_changingAnySignedFieldInvalidatesTheAuthorization() public {
        // An Active receipt lets REVOKE and SUPERSEDE shapes reach signature verification.
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        (address third,) = makeAddrAndKey("synthetic third reviewer");

        IProofOfReviewRegistry.ReviewAction memory signed = _supersede(reviewer, COMMITMENT_A, COMMITMENT_B);
        bytes memory signature = _sign(reviewerKey, signed);

        IProofOfReviewRegistry.ReviewAction memory changed = _copy(signed);
        changed.action = ReviewActionCodes.REVOKE;
        changed.replacementCommitment = bytes32(0);
        _expectInvalidSignature(changed, signature);

        changed = _copy(signed);
        changed.commitment = COMMITMENT_C;
        _expectInvalidSignature(changed, signature);

        changed = _copy(signed);
        changed.replacementCommitment = COMMITMENT_C;
        _expectInvalidSignature(changed, signature);

        changed = _copy(signed);
        changed.reviewer = third;
        changed.nonce = registry.nonceOf(third);
        _expectInvalidSignature(changed, signature);

        changed = _copy(signed);
        changed.deadline = signed.deadline + 1;
        _expectInvalidSignature(changed, signature);

        // Nonce: a signature over nonce + 1 cannot be presented with the current nonce.
        IProofOfReviewRegistry.ReviewAction memory future = _copy(signed);
        future.nonce = signed.nonce + 1;
        _expectInvalidSignature(signed, _sign(reviewerKey, future));

        // Changing only the action code (ISSUE and REVOKE share a shape) is also caught.
        IProofOfReviewRegistry.ReviewAction memory revoke = _revoke(reviewer, COMMITMENT_A);
        bytes memory revokeSignature = _sign(reviewerKey, revoke);
        changed = _copy(revoke);
        changed.action = ReviewActionCodes.ISSUE;
        _expectInvalidSignature(changed, revokeSignature);

        assertEq(registry.nonceOf(reviewer), 1);
        registry.execute(signed, signature);
        assertEq(registry.nonceOf(reviewer), 2);
    }

    function test_wrongDomainInvalidatesTheAuthorization() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        address self = address(registry);
        uint256 chain = vm.getChainId();

        bytes32[] memory wrongDomains = new bytes32[](4);
        wrongDomains[0] = _domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, chain + 1, self);
        wrongDomains[1] = _domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, chain, address(0xBEEF));
        wrongDomains[2] = _domainSeparator("LexAegisProofOfReviews", DOMAIN_VERSION, chain, self);
        wrongDomains[3] = _domainSeparator(DOMAIN_NAME, "2", chain, self);

        for (uint256 i = 0; i < wrongDomains.length; ++i) {
            _expectInvalidSignature(action, _signDigest(reviewerKey, _digestIn(wrongDomains[i], action)));
        }
        // A bare struct hash and an eth_sign style prefix are not substitutes either.
        _expectInvalidSignature(action, _signDigest(reviewerKey, _structHash(action)));
        _expectInvalidSignature(
            action,
            _signDigest(
                reviewerKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _digest(action)))
            )
        );
        _assertUntouched();
    }

    function test_signatureForAnotherRegistryIsNotAccepted() public {
        ProofOfReviewRegistry second = new ProofOfReviewRegistry();
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes32 secondDomain = _domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, vm.getChainId(), address(second));
        bytes memory signature = _signDigest(reviewerKey, _digestIn(secondDomain, action));

        _expectInvalidSignature(action, signature);
        second.execute(action, signature);
        assertEq(uint8(second.getReceipt(reviewer, COMMITMENT_A).status), uint8(ACTIVE));
        _assertUntouched();
    }

    function test_domainSeparationFollowsAChainIdChange() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        uint256 originalChain = vm.getChainId();
        bytes32 originalDigest = registry.hashAction(action);
        bytes memory originalSignature = _sign(reviewerKey, action);

        vm.chainId(10_143);
        assertNotEq(vm.getChainId(), originalChain);

        bytes32 newDigest = registry.hashAction(action);
        assertNotEq(newDigest, originalDigest);
        assertEq(
            newDigest,
            _digestIn(_domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, 10_143, address(registry)), action)
        );
        (,,, uint256 reportedChain,,,) = registry.eip712Domain();
        assertEq(reportedChain, 10_143);

        // A signature made for the old chain is dead; one for the new chain works.
        _expectInvalidSignature(action, originalSignature);
        registry.execute(action, _sign(reviewerKey, action));
        assertEq(registry.nonceOf(reviewer), 1);
    }

    // ---- Deadline -----------------------------------------------------------------------------

    function test_exactDeadlineSucceedsAndALaterTimestampFails() public {
        IProofOfReviewRegistry.ReviewAction memory first = _issue(reviewer, COMMITMENT_A);
        bytes memory firstSignature = _sign(reviewerKey, first);
        vm.warp(first.deadline);
        registry.execute(first, firstSignature);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), first.deadline, first.deadline);

        IProofOfReviewRegistry.ReviewAction memory second = _issue(reviewer, COMMITMENT_B);
        bytes memory secondSignature = _sign(reviewerKey, second);
        vm.warp(second.deadline + 1);
        vm.expectRevert(IProofOfReviewRegistry.AuthorizationExpired.selector);
        registry.execute(second, secondSignature);
        _assertNotFound(reviewer, COMMITMENT_B);
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_zeroDeadlineFails() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        action.deadline = 0;
        _expectExecuteRevert(
            reviewerKey, action, _selector(IProofOfReviewRegistry.AuthorizationExpired.selector)
        );
        _assertUntouched();
    }

    function test_zeroDeadlineFailsEvenAtTimestampZero() public {
        // A zero deadline is never "not yet passed", even where the block time is itself zero.
        vm.warp(0);
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        action.deadline = 0;
        _expectExecuteRevert(
            reviewerKey, action, _selector(IProofOfReviewRegistry.AuthorizationExpired.selector)
        );
        _assertUntouched();
    }

    function test_anExpiredDeadlineDoesNotExpireAnIssuedReceipt() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        _execute(reviewerKey, action);
        vm.warp(action.deadline + 365 days);
        _assertReceipt(reviewer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);
    }

    // ---- Nonces -------------------------------------------------------------------------------

    function test_replayFailsAfterASuccessfulOperation() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);
        registry.execute(action, signature);

        vm.expectRevert(_invalidNonce(1));
        registry.execute(action, signature);

        // Revoking does not make the consumed ISSUE signature usable again.
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_A));
        vm.expectRevert(_invalidNonce(2));
        registry.execute(action, signature);
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_A).status), uint8(REVOKED));
    }

    function test_failedSignatureLeavesTheNonceUnchanged() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        _expectExecuteRevert(otherKey, action, _selector(IProofOfReviewRegistry.InvalidSignature.selector));
        assertEq(registry.nonceOf(reviewer), 0);
        _execute(reviewerKey, action);
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_failedLifecycleOperationLeavesTheNonceUnchanged() public {
        // Correctly signed, but there is nothing to revoke.
        _expectExecuteRevert(reviewerKey, _revoke(reviewer, COMMITMENT_A), _transition(NOT_FOUND));
        assertEq(registry.nonceOf(reviewer), 0);

        // The same nonce then authorizes a valid action.
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        assertEq(action.nonce, 0);
        _execute(reviewerKey, action);
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_noncesAreIsolatedPerReviewerAndSharedAcrossActionTypes() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A)); // nonce 0
        assertEq(registry.nonceOf(reviewer), 1);
        _execute(reviewerKey, _supersede(reviewer, COMMITMENT_A, COMMITMENT_B)); // nonce 1
        assertEq(registry.nonceOf(reviewer), 2);
        _execute(reviewerKey, _revoke(reviewer, COMMITMENT_B)); // nonce 2
        assertEq(registry.nonceOf(reviewer), 3);
        assertEq(registry.nonceOf(other), 0);

        // The other reviewer starts from zero regardless.
        IProofOfReviewRegistry.ReviewAction memory otherAction = _issue(other, COMMITMENT_A);
        assertEq(otherAction.nonce, 0);
        _execute(otherKey, otherAction);
        assertEq(registry.nonceOf(other), 1);
        assertEq(registry.nonceOf(reviewer), 3);

        // One counter serves all three actions: an old nonce is dead for every action type.
        for (uint8 code = ReviewActionCodes.ISSUE; code <= ReviewActionCodes.SUPERSEDE; ++code) {
            IProofOfReviewRegistry.ReviewAction memory stale = _action(
                reviewer, code, COMMITMENT_C, code == ReviewActionCodes.SUPERSEDE ? COMMITMENT_A : bytes32(0)
            );
            stale.nonce = 1;
            _expectExecuteRevert(reviewerKey, stale, _invalidNonce(3));
        }
    }

    function test_invalidateNonceCancelsAnOutstandingSignature() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);

        vm.recordLogs();
        vm.prank(reviewer);
        registry.invalidateNonce(0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = IProofOfReviewRegistry.NonceInvalidated.selector;
        topics[1] = bytes32(uint256(uint160(reviewer)));
        _assertLog(logs[0], topics, abi.encode(uint256(0), uint256(1), vm.getBlockTimestamp()));
        assertEq(registry.nonceOf(reviewer), 1);

        vm.expectRevert(_invalidNonce(1));
        registry.execute(action, signature);
        _assertNotFound(reviewer, COMMITMENT_A);
    }

    function test_aRelayerCannotInvalidateAnotherReviewersNonce() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);

        // The call only ever touches the caller's own counter.
        vm.prank(relayer);
        registry.invalidateNonce(0);
        assertEq(registry.nonceOf(relayer), 1);
        assertEq(registry.nonceOf(reviewer), 0);

        registry.execute(action, signature);
        assertEq(registry.nonceOf(reviewer), 1);
    }

    function test_staleInvalidationFailsWithoutAffectingNewerState() public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        IProofOfReviewRegistry.ReviewAction memory pending = _revoke(reviewer, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, pending);

        vm.expectRevert(_invalidNonce(1));
        vm.prank(reviewer);
        registry.invalidateNonce(0);

        vm.expectRevert(_invalidNonce(1));
        vm.prank(reviewer);
        registry.invalidateNonce(2);

        assertEq(registry.nonceOf(reviewer), 1);
        registry.execute(pending, signature);
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_A).status), uint8(REVOKED));
    }

    function test_nonceExhaustionCannotWrapToZero() public {
        uint256 max = type(uint256).max;
        stdstore.target(address(registry))
            .sig(registry.nonceOf.selector)
            .with_key(reviewer)
            .checked_write(max);
        assertEq(registry.nonceOf(reviewer), max);

        _expectExecuteRevert(
            reviewerKey,
            _issue(reviewer, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.NonceExhausted.selector)
        );
        vm.expectRevert(IProofOfReviewRegistry.NonceExhausted.selector);
        vm.prank(reviewer);
        registry.invalidateNonce(max);

        assertEq(registry.nonceOf(reviewer), max);
        _assertNotFound(reviewer, COMMITMENT_A);
    }

    function test_theLastUsableNonceStillWorksExactlyOnce() public {
        uint256 last = type(uint256).max - 1;
        stdstore.target(address(registry))
            .sig(registry.nonceOf.selector)
            .with_key(reviewer)
            .checked_write(last);
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        assertEq(registry.nonceOf(reviewer), type(uint256).max);
        _expectExecuteRevert(
            reviewerKey,
            _issue(reviewer, COMMITMENT_B),
            _selector(IProofOfReviewRegistry.NonceExhausted.selector)
        );
    }

    // ---- ERC-1271 contract accounts -----------------------------------------------------------

    function test_erc1271AccountCanAuthorizeActions() public {
        ERC1271OwnedAccount account = new ERC1271OwnedAccount(reviewer);
        address signer = address(account);

        _execute(reviewerKey, _issue(signer, COMMITMENT_A));
        _execute(reviewerKey, _supersede(signer, COMMITMENT_A, COMMITMENT_B));
        _execute(reviewerKey, _revoke(signer, COMMITMENT_B));

        assertEq(registry.nonceOf(signer), 3);
        assertEq(uint8(registry.getReceipt(signer, COMMITMENT_B).status), uint8(REVOKED));
        // The key that signed holds no receipt of its own.
        _assertNotFound(reviewer, COMMITMENT_A);
        assertEq(registry.nonceOf(reviewer), 0);
    }

    function test_erc1271AccountRejectsAKeyThatIsNotItsOwner() public {
        address signer = address(new ERC1271OwnedAccount(reviewer));
        _expectExecuteRevert(
            otherKey,
            _issue(signer, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.InvalidSignature.selector)
        );
        assertEq(registry.nonceOf(signer), 0);
        _assertNotFound(signer, COMMITMENT_A);
    }

    function test_invalidOrAdversarialErc1271ValidationFailsWithoutStateChanges() public {
        address[] memory signers = new address[](6);
        signers[0] = address(new ERC1271WrongMagic());
        signers[1] = address(new ERC1271Reverting());
        signers[2] = address(new ERC1271MalformedReturn(ERC1271MalformedReturn.Shape.Empty));
        signers[3] = address(new ERC1271MalformedReturn(ERC1271MalformedReturn.Shape.FourBytes));
        signers[4] = address(new ERC1271MalformedReturn(ERC1271MalformedReturn.Shape.DirtyWord));
        signers[5] = address(new ERC1271Reentrant(registry, false));

        for (uint256 i = 0; i < signers.length; ++i) {
            IProofOfReviewRegistry.ReviewAction memory action = _issue(signers[i], COMMITMENT_A);
            vm.recordLogs();
            _expectExecuteRevert(
                reviewerKey, action, _selector(IProofOfReviewRegistry.InvalidSignature.selector)
            );
            assertEq(vm.getRecordedLogs().length, 0);
            assertEq(registry.nonceOf(signers[i]), 0);
            _assertNotFound(signers[i], COMMITMENT_A);
        }
    }

    function test_reentrantValidationCannotMutateTheRegistry() public {
        // This account hides its failed attempt and still answers with the magic value.
        address signer = address(new ERC1271Reentrant(registry, true));
        IProofOfReviewRegistry.ReviewAction memory action = _issue(signer, COMMITMENT_A);

        vm.recordLogs();
        _execute(reviewerKey, action);

        // Exactly one nonce was consumed and exactly one log exists: the attempted
        // invalidateNonce inside validation changed nothing.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        _assertIssuedLog(logs[0], signer, COMMITMENT_A, bytes32(0), 0);
        assertEq(registry.nonceOf(signer), 1);
        _assertReceipt(signer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);
    }

    function test_issuedReceiptSurvivesAnErc1271PolicyChange() public {
        ERC1271OwnedAccount account = new ERC1271OwnedAccount(reviewer);
        address signer = address(account);
        _execute(reviewerKey, _issue(signer, COMMITMENT_A));

        vm.warp(START_TIME + 1 days);
        account.setOwner(other);

        // History is untouched by the new policy.
        _assertReceipt(signer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);
        assertEq(registry.nonceOf(signer), 1);

        // New actions follow the policy in force when they execute.
        IProofOfReviewRegistry.ReviewAction memory revoke = _revoke(signer, COMMITMENT_A);
        _expectExecuteRevert(reviewerKey, revoke, _selector(IProofOfReviewRegistry.InvalidSignature.selector));
        _assertReceipt(signer, COMMITMENT_A, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);

        _execute(otherKey, revoke);
        _assertReceipt(signer, COMMITMENT_A, REVOKED, bytes32(0), bytes32(0), START_TIME, START_TIME + 1 days);
    }

    function test_aSignatureMadeBeforeAPolicyChangeStopsWorkingAfterIt() public {
        ERC1271OwnedAccount account = new ERC1271OwnedAccount(reviewer);
        IProofOfReviewRegistry.ReviewAction memory action = _issue(address(account), COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);

        account.setOwner(other);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, signature);
        _assertNotFound(address(account), COMMITMENT_A);
    }

    // ---- Helpers ------------------------------------------------------------------------------

    function _copy(IProofOfReviewRegistry.ReviewAction memory action)
        private
        pure
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return IProofOfReviewRegistry.ReviewAction({
            reviewer: action.reviewer,
            action: action.action,
            commitment: action.commitment,
            replacementCommitment: action.replacementCommitment,
            nonce: action.nonce,
            deadline: action.deadline
        });
    }

    function _expectInvalidSignature(
        IProofOfReviewRegistry.ReviewAction memory action,
        bytes memory signature
    ) private {
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        vm.prank(relayer);
        registry.execute(action, signature);
    }

    function _assertUntouched() private view {
        assertEq(registry.nonceOf(reviewer), 0);
        _assertNotFound(reviewer, COMMITMENT_A);
    }
}

/// @notice Chapter 17 boundary cases: fuzzed deadlines, signer, chain, registry, domain and field
/// changes, replays after every kind of operation, and executor races.
/// @dev Each rejection keeps every unrelated precondition valid, so the reason is the one named.
contract AuthorizationBoundaryTest is RegistryTestBase {
    IProofOfReviewRegistry.ReceiptStatus internal constant ACTIVE =
    IProofOfReviewRegistry.ReceiptStatus.Active;
    IProofOfReviewRegistry.ReceiptStatus internal constant REVOKED =
    IProofOfReviewRegistry.ReceiptStatus.Revoked;
    IProofOfReviewRegistry.ReceiptStatus internal constant SUPERSEDED =
    IProofOfReviewRegistry.ReceiptStatus.Superseded;

    // ---- Deadlines ----------------------------------------------------------------------------

    /// @dev One valid shaped action, executed at deadline - 1, at the deadline and at deadline + 1,
    /// each from the same starting state. Under v1 `timestamp <= deadline` is required: equality
    /// succeeds. The deadline is generated so that neither neighbour overflows.
    function testFuzz_deadlineBoundaryForEveryActionShape(uint256 deadlineSeed, uint8 codeSeed) public {
        uint8 code = codeSeed % 3;
        if (code != ReviewActionCodes.ISSUE) _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        uint256 deadline = bound(deadlineSeed, vm.getBlockTimestamp() + 1, type(uint64).max - 1);

        IProofOfReviewRegistry.ReviewAction memory action = _action(
            reviewer, code, COMMITMENT_A, code == ReviewActionCodes.SUPERSEDE ? COMMITMENT_B : bytes32(0)
        );
        action.deadline = deadline;
        bytes memory signature = _sign(reviewerKey, action);
        uint256 nonceBefore = registry.nonceOf(reviewer);

        uint256 start = vm.snapshotState();
        vm.warp(deadline - 1);
        vm.prank(relayer);
        registry.execute(action, signature);
        assertEq(registry.nonceOf(reviewer), nonceBefore + 1, "one second before the deadline");

        vm.revertToState(start);
        vm.warp(deadline);
        vm.prank(relayer);
        registry.execute(action, signature);
        assertEq(registry.nonceOf(reviewer), nonceBefore + 1, "exactly at the deadline");
        // The instruction's expiry is not the receipt's: long after, the result still stands.
        IProofOfReviewRegistry.ReceiptStatus settled = registry.getReceipt(reviewer, COMMITMENT_A).status;
        vm.warp(deadline + 1);
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_A).status), uint8(settled));

        vm.revertToState(start);
        vm.warp(deadline + 1);
        vm.expectRevert(IProofOfReviewRegistry.AuthorizationExpired.selector);
        vm.prank(relayer);
        registry.execute(action, signature);
        assertEq(registry.nonceOf(reviewer), nonceBefore, "one second after the deadline");
    }

    function test_theLargestDeadlineIsUsableAndNeverOverflows() public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        action.deadline = type(uint256).max;
        _execute(reviewerKey, action);
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_A).status), uint8(ACTIVE));
    }

    /// @dev Zero is tested apart from the boundary: it is never valid, at any block time.
    function testFuzz_zeroDeadlineNeverAuthorizes(uint64 time) public {
        vm.warp(time);
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        action.deadline = 0;
        _expectExecuteRevert(
            reviewerKey, action, _selector(IProofOfReviewRegistry.AuthorizationExpired.selector)
        );
        assertEq(registry.nonceOf(reviewer), 0);
    }

    // ---- Signer, chain, registry and domain ------------------------------------------------------

    function testFuzz_anyOtherKeyIsRejectedForAnEoaAndForAContractAccount(uint256 keySeed, bytes32 commitment)
        public
    {
        vm.assume(commitment != bytes32(0));
        uint256 wrongKey = bound(keySeed, 1, SECP256K1_N - 1);
        if (wrongKey == reviewerKey) wrongKey = otherKey;

        _expectExecuteRevert(
            wrongKey,
            _issue(reviewer, commitment),
            _selector(IProofOfReviewRegistry.InvalidSignature.selector)
        );
        address account = address(new ERC1271OwnedAccount(reviewer));
        _expectExecuteRevert(
            wrongKey, _issue(account, commitment), _selector(IProofOfReviewRegistry.InvalidSignature.selector)
        );
        assertEq(registry.nonceOf(reviewer) + registry.nonceOf(account), 0);

        // The right key still works for both, so only the signer was wrong.
        _execute(reviewerKey, _issue(reviewer, commitment));
        _execute(reviewerKey, _issue(account, commitment));
    }

    function testFuzz_aSignatureForAnotherChainIsRejected(uint64 chainSeed, bytes32 commitment) public {
        vm.assume(commitment != bytes32(0));
        uint256 home = vm.getChainId();
        uint256 foreign = uint256(chainSeed) == home ? home + 1 : uint256(chainSeed);
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, commitment);
        bytes32 foreignDomain = _domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, foreign, address(registry));
        bytes memory foreignSignature = _signDigest(reviewerKey, _digestIn(foreignDomain, action));

        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, foreignSignature);

        // The same contract on the other chain id accepts it; a home signature is refused there.
        bytes memory homeSignature = _sign(reviewerKey, action);
        uint256 start = vm.snapshotState();
        vm.chainId(foreign);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, homeSignature);
        registry.execute(action, foreignSignature);
        assertEq(registry.nonceOf(reviewer), 1);

        // Restore the chain context: nothing leaks into later assertions.
        vm.revertToState(start);
        vm.chainId(home);
        assertEq(vm.getChainId(), home);
        assertEq(registry.nonceOf(reviewer), 0);
        registry.execute(action, homeSignature);
    }

    /// @dev Two real local registries. A signature for one is a valid signature that the other
    /// refuses, in both directions, and each registry's nonce and records stay its own.
    function testFuzz_aSignatureCannotBeReplayedOnASecondRegistry(bytes32 commitment, address executor)
        public
    {
        vm.assume(commitment != bytes32(0));
        ProofOfReviewRegistry second = new ProofOfReviewRegistry();
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, commitment);
        bytes memory forFirst = _sign(reviewerKey, action);
        bytes memory forSecond = _signDigest(
            reviewerKey,
            _digestIn(_domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, vm.getChainId(), address(second)), action)
        );

        vm.startPrank(executor);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        second.execute(action, forFirst);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, forSecond);

        registry.execute(action, forFirst);
        assertEq(registry.nonceOf(reviewer), 1);
        assertEq(second.nonceOf(reviewer), 0, "the second registry saw nothing");
        assertEq(uint8(second.getReceipt(reviewer, commitment).status), 0);

        // Still not replayable there after it executed here.
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        second.execute(action, forFirst);
        second.execute(action, forSecond);
        vm.stopPrank();
        assertEq(second.nonceOf(reviewer), 1);
    }

    function testFuzz_anyOtherDomainNameOrVersionIsRejected(string calldata name, string calldata version)
        public
    {
        bool sameName = keccak256(bytes(name)) == keccak256(bytes(DOMAIN_NAME));
        bool sameVersion = keccak256(bytes(version)) == keccak256(bytes(DOMAIN_VERSION));
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        uint256 chain = vm.getChainId();

        if (!sameName) {
            bytes32 domain = _domainSeparator(name, DOMAIN_VERSION, chain, address(registry));
            vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
            registry.execute(action, _signDigest(reviewerKey, _digestIn(domain, action)));
        }
        if (!sameVersion) {
            bytes32 domain = _domainSeparator(DOMAIN_NAME, version, chain, address(registry));
            vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
            registry.execute(action, _signDigest(reviewerKey, _digestIn(domain, action)));
        }
        assertEq(registry.nonceOf(reviewer), 0);
        registry.execute(action, _sign(reviewerKey, action));
    }

    // ---- One altered signed field at a time ------------------------------------------------------

    /// @dev The reviewer signs a valid SUPERSEDE of an Active receipt. One field is then changed to
    /// another value that would itself be acceptable, so the only failing check is the signature.
    function testFuzz_eachIndividuallyAlteredFieldInvalidatesTheSignature(uint8 field, uint256 salt) public {
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_A));
        _execute(reviewerKey, _issue(reviewer, COMMITMENT_B));
        // `other` is brought to the same nonce with the same Active commitment, so swapping the
        // reviewer leaves nonce, shape and lifecycle valid.
        _execute(otherKey, _issue(other, COMMITMENT_A));
        _execute(otherKey, _issue(other, COMMITMENT_B));

        IProofOfReviewRegistry.ReviewAction memory signed = _supersede(reviewer, COMMITMENT_A, COMMITMENT_C);
        bytes memory signature = _sign(reviewerKey, signed);
        IProofOfReviewRegistry.ReviewAction memory changed = _supersede(reviewer, COMMITMENT_A, COMMITMENT_C);

        uint256 which = field % 4;
        if (which == 0) {
            changed.reviewer = other;
        } else if (which == 1) {
            changed.commitment = COMMITMENT_B; // also Active
        } else if (which == 2) {
            bytes32 fresh = keccak256(abi.encode("synthetic altered replacement", salt));
            changed.replacementCommitment = fresh;
        } else {
            changed.deadline = bound(salt, vm.getBlockTimestamp(), type(uint256).max);
            if (changed.deadline == signed.deadline) changed.deadline += 1;
        }

        vm.recordLogs();
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        vm.prank(relayer);
        registry.execute(changed, signature);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(registry.nonceOf(reviewer), 2);
        assertEq(registry.nonceOf(other), 2);

        // The altered action is itself acceptable when its own reviewer signs it...
        uint256 start = vm.snapshotState();
        _execute(which == 0 ? otherKey : reviewerKey, changed);
        vm.revertToState(start);
        // ...and the untouched action still executes with the original signature.
        vm.prank(relayer);
        registry.execute(signed, signature);
        assertEq(uint8(registry.getReceipt(reviewer, COMMITMENT_C).status), uint8(ACTIVE));
    }

    /// @dev The nonce is a signed field too: a signature over any other nonce is not a signature
    /// over the current one.
    function testFuzz_aSignatureOverAnotherNonceDoesNotAuthorizeTheCurrentOne(uint256 signedNonce) public {
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, COMMITMENT_A);
        vm.assume(signedNonce != action.nonce);
        IProofOfReviewRegistry.ReviewAction memory elsewhere = _issue(reviewer, COMMITMENT_A);
        elsewhere.nonce = signedNonce;

        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(action, _sign(reviewerKey, elsewhere));
        // Presenting the nonce that was signed is refused as not current.
        vm.expectRevert(_invalidNonce(0));
        registry.execute(elsewhere, _sign(reviewerKey, elsewhere));
        assertEq(registry.nonceOf(reviewer), 0);
    }

    // ---- Replay and executor races ---------------------------------------------------------------

    function test_replayFailsAfterIssueRevokeSupersedeAndInvalidation() public {
        IProofOfReviewRegistry.ReviewAction[] memory actions = new IProofOfReviewRegistry.ReviewAction[](4);
        bytes[] memory signatures = new bytes[](4);

        actions[0] = _issue(reviewer, COMMITMENT_A);
        signatures[0] = _sign(reviewerKey, actions[0]);
        registry.execute(actions[0], signatures[0]);

        actions[1] = _supersede(reviewer, COMMITMENT_A, COMMITMENT_B);
        signatures[1] = _sign(reviewerKey, actions[1]);
        registry.execute(actions[1], signatures[1]);

        actions[2] = _revoke(reviewer, COMMITMENT_B);
        signatures[2] = _sign(reviewerKey, actions[2]);
        registry.execute(actions[2], signatures[2]);

        // Signed but never executed: cancelled by the reviewer's own invalidation.
        actions[3] = _issue(reviewer, COMMITMENT_C);
        signatures[3] = _sign(reviewerKey, actions[3]);
        vm.prank(reviewer);
        registry.invalidateNonce(3);

        address[3] memory executors = [relayer, other, reviewer];
        vm.recordLogs();
        for (uint256 e = 0; e < executors.length; ++e) {
            for (uint256 i = 0; i < actions.length; ++i) {
                vm.expectRevert(_invalidNonce(4));
                vm.prank(executors[e]);
                registry.execute(actions[i], signatures[i]);
            }
        }
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(registry.nonceOf(reviewer), 4);
        _assertReceipt(reviewer, COMMITMENT_A, SUPERSEDED, bytes32(0), COMMITMENT_B, START_TIME, START_TIME);
        _assertReceipt(reviewer, COMMITMENT_B, REVOKED, COMMITMENT_A, bytes32(0), START_TIME, START_TIME);
        _assertNotFound(reviewer, COMMITMENT_C);

        // A stale expectedNonce cannot be used to cancel again, by anyone.
        vm.expectRevert(_invalidNonce(4));
        vm.prank(reviewer);
        registry.invalidateNonce(3);
        vm.expectRevert(_invalidNonce(0));
        vm.prank(relayer);
        registry.invalidateNonce(4);
    }

    /// @dev Anyone may submit an unchanged, validly signed action. Whoever is first produces exactly
    /// the authorised result; the duplicate from a second executor authorises nothing more.
    function testFuzz_anUnrelatedExecutorSubmittingFirstGetsExactlyTheAuthorisedResult(
        address first,
        address second,
        bytes32 commitment
    ) public {
        vm.assume(commitment != bytes32(0));
        IProofOfReviewRegistry.ReviewAction memory action = _issue(reviewer, commitment);
        bytes memory signature = _sign(reviewerKey, action);

        vm.recordLogs();
        vm.prank(first);
        registry.execute(action, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        _assertIssuedLog(logs[0], reviewer, commitment, bytes32(0), 0);
        _assertReceipt(reviewer, commitment, ACTIVE, bytes32(0), bytes32(0), START_TIME, START_TIME);

        vm.expectRevert(_invalidNonce(1));
        vm.prank(second);
        registry.execute(action, signature);

        // The executors gained no record and no nonce movement of their own.
        if (first != reviewer) {
            assertEq(registry.nonceOf(first), 0);
            _assertNotFound(first, commitment);
        }
        assertEq(registry.nonceOf(reviewer), 1);
    }

    /// @dev A valid signature that reaches an invalid lifecycle transition unwinds completely, for
    /// an EOA and for a contract account: the nonce it consumed inside the call is restored.
    function test_aValidSignatureReachingAnInvalidTransitionRollsBackForBothAccountKinds() public {
        address account = address(new ERC1271OwnedAccount(reviewer));
        address[2] memory signers = [reviewer, account];
        for (uint256 i = 0; i < signers.length; ++i) {
            address signer = signers[i];
            _execute(reviewerKey, _issue(signer, COMMITMENT_A));
            _execute(reviewerKey, _revoke(signer, COMMITMENT_A));

            vm.recordLogs();
            _expectExecuteRevert(reviewerKey, _revoke(signer, COMMITMENT_A), _transition(REVOKED));
            _expectExecuteRevert(
                reviewerKey, _supersede(signer, COMMITMENT_A, COMMITMENT_B), _transition(REVOKED)
            );
            _expectExecuteRevert(
                reviewerKey,
                _issue(signer, COMMITMENT_A),
                _selector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
            );
            assertEq(vm.getRecordedLogs().length, 0);
            assertEq(registry.nonceOf(signer), 2);
            _assertNotFound(signer, COMMITMENT_B);
            // The same nonce is still good for a valid action.
            _execute(reviewerKey, _issue(signer, COMMITMENT_B));
            assertEq(registry.nonceOf(signer), 3);
        }
    }

    // ---- Pinned OpenZeppelin behaviour for contract accounts --------------------------------------

    function test_aContractAccountAlsoRefusesMalformedAndHighSSignatures() public {
        address account = address(new ERC1271OwnedAccount(reviewer));
        IProofOfReviewRegistry.ReviewAction memory action = _issue(account, COMMITMENT_A);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reviewerKey, _digest(action));

        bytes[] memory refused = new bytes[](5);
        refused[0] = "";
        refused[1] = abi.encodePacked(r, s);
        refused[2] = abi.encodePacked(r, s, v, uint8(0));
        refused[3] = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        refused[4] = new bytes(65);
        for (uint256 i = 0; i < refused.length; ++i) {
            vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
            registry.execute(action, refused[i]);
        }
        assertEq(registry.nonceOf(account), 0);
        registry.execute(action, abi.encodePacked(r, s, v));
        assertEq(registry.nonceOf(account), 1);
    }

    /// @dev The account tries to change the registry while being asked to validate, swallows the
    /// failure and answers with the magic value. STATICCALL made the nested mutation fail, so the
    /// outer action is authorised by that answer and succeeds once. It is not replayable, and a
    /// validation that does NOT swallow the failure authorises nothing.
    function test_aSwallowedNestedMutationLetsTheOuterActionSucceedExactlyOnce() public {
        address swallowing = address(new ERC1271Reentrant(registry, true));
        IProofOfReviewRegistry.ReviewAction memory action = _issue(swallowing, COMMITMENT_A);
        bytes memory signature = _sign(reviewerKey, action);

        vm.recordLogs();
        registry.execute(action, signature);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "no NonceInvalidated log: the nested call changed nothing");
        _assertIssuedLog(logs[0], swallowing, COMMITMENT_A, bytes32(0), 0);
        assertEq(registry.nonceOf(swallowing), 1, "exactly the outer action's nonce was consumed");

        vm.expectRevert(_invalidNonce(1));
        registry.execute(action, signature);

        address strict = address(new ERC1271Reentrant(registry, false));
        IProofOfReviewRegistry.ReviewAction memory refused = _issue(strict, COMMITMENT_A);
        vm.expectRevert(IProofOfReviewRegistry.InvalidSignature.selector);
        registry.execute(refused, _sign(reviewerKey, refused));
        assertEq(registry.nonceOf(strict), 0);
    }
}

/// @notice LOCAL BOUNDARY FIXTURE for nonce exhaustion.
/// @dev The registry cannot reach a nonce near 2^256 by execution: these tests place a local
/// registry there with a storage cheatcode. They change no production source, are not part of any
/// stateful campaign, and are not evidence about a deployed registry's reachable states.
contract NonceExhaustionBoundaryTest is RegistryTestBase {
    using stdStorage for StdStorage;

    function _placeNonce(address account, uint256 value) internal {
        stdstore.target(address(registry))
            .sig(registry.nonceOf.selector)
            .with_key(account)
            .checked_write(value);
    }

    function test_localBoundary_theLastInvalidationWorksOnceThenTheNonceIsExhausted() public {
        uint256 last = type(uint256).max - 1;
        _placeNonce(reviewer, last);
        vm.prank(reviewer);
        registry.invalidateNonce(last);
        assertEq(registry.nonceOf(reviewer), type(uint256).max);

        vm.expectRevert(IProofOfReviewRegistry.NonceExhausted.selector);
        vm.prank(reviewer);
        registry.invalidateNonce(type(uint256).max);
        _expectExecuteRevert(
            reviewerKey,
            _issue(reviewer, COMMITMENT_A),
            _selector(IProofOfReviewRegistry.NonceExhausted.selector)
        );
        assertEq(registry.nonceOf(reviewer), type(uint256).max, "it never wraps to zero");
        _assertNotFound(reviewer, COMMITMENT_A);
    }

    function test_localBoundary_exhaustionOfOneAccountDoesNotAffectAnother() public {
        _placeNonce(reviewer, type(uint256).max);
        _execute(otherKey, _issue(other, COMMITMENT_A));
        assertEq(registry.nonceOf(other), 1);
        // A consumed value of the exhausted account cannot authorise anything, even freshly signed.
        IProofOfReviewRegistry.ReviewAction memory stale = _issue(reviewer, COMMITMENT_A);
        stale.nonce = 0;
        _expectExecuteRevert(reviewerKey, stale, _invalidNonce(type(uint256).max));
    }
}
