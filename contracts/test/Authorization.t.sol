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
