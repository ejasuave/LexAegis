// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Drives the registry with correctly signed actions that really execute, and with replays,
/// forged signatures and lifecycle-invalid actions that must fail. It keeps an independent model of
/// every receipt. An outcome that differs from the model is recorded as a violation instead of
/// reverting, so the invariant run can never pass merely because calls reverted.
contract RegistryHandler is Test {
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant REVIEWER_COUNT = 3;

    struct SignedAction {
        IProofOfReviewRegistry.ReviewAction action;
        bytes signature;
    }

    ProofOfReviewRegistry public immutable REGISTRY;

    address[] internal _reviewers;
    mapping(address reviewer => uint256 key) internal _keys;
    mapping(address reviewer => bytes32[] commitments) internal _commitments;
    mapping(address reviewer => mapping(bytes32 commitment => IProofOfReviewRegistry.Receipt)) internal
        _model;
    mapping(address reviewer => mapping(bytes32 commitment => bool)) public everTerminal;
    mapping(address reviewer => uint256) public successfulExecutes;
    mapping(address reviewer => uint256) public invalidations;
    SignedAction[] internal _executed;

    uint256 public issued;
    uint256 public revoked;
    uint256 public superseded;
    uint256 public rejected;
    uint256 public violations;
    uint256 internal _fresh;

    constructor(ProofOfReviewRegistry registry) {
        REGISTRY = registry;
        for (uint256 i = 0; i < REVIEWER_COUNT; ++i) {
            (address reviewer, uint256 key) =
                makeAddrAndKey(string.concat("synthetic invariant reviewer ", vm.toString(i)));
            _reviewers.push(reviewer);
            _keys[reviewer] = key;
        }
    }

    // ---- Views for the invariants -------------------------------------------------------------

    function reviewerCount() external view returns (uint256) {
        return _reviewers.length;
    }

    function reviewerAt(uint256 index) external view returns (address) {
        return _reviewers[index];
    }

    function commitmentCount(address reviewer) external view returns (uint256) {
        return _commitments[reviewer].length;
    }

    function commitmentAt(address reviewer, uint256 index) external view returns (bytes32) {
        return _commitments[reviewer][index];
    }

    function modelOf(address reviewer, bytes32 commitment)
        external
        view
        returns (IProofOfReviewRegistry.Receipt memory)
    {
        return _model[reviewer][commitment];
    }

    // ---- Operations that must succeed ---------------------------------------------------------

    function issue(uint256 reviewerSeed, uint256 timeSeed, address executor) external {
        _advanceTime(timeSeed);
        _issue(_pickReviewer(reviewerSeed), executor);
    }

    function revoke(uint256 reviewerSeed, uint256 pickSeed, uint256 timeSeed, address executor) external {
        _advanceTime(timeSeed);
        address reviewer = _pickReviewer(reviewerSeed);
        bytes32 commitment = _activeOrIssue(reviewer, pickSeed, executor);
        _advanceTime(timeSeed);

        if (_submit(reviewer, ReviewActionCodes.REVOKE, commitment, bytes32(0), executor)) {
            IProofOfReviewRegistry.Receipt storage receipt = _model[reviewer][commitment];
            receipt.status = IProofOfReviewRegistry.ReceiptStatus.Revoked;
            receipt.updatedAt = vm.getBlockTimestamp();
            everTerminal[reviewer][commitment] = true;
            ++revoked;
        } else {
            ++violations;
        }
    }

    function supersede(uint256 reviewerSeed, uint256 pickSeed, uint256 timeSeed, address executor) external {
        _advanceTime(timeSeed);
        address reviewer = _pickReviewer(reviewerSeed);
        bytes32 previous = _activeOrIssue(reviewer, pickSeed, executor);
        bytes32 replacement = _freshCommitment();
        _advanceTime(timeSeed);

        if (_submit(reviewer, ReviewActionCodes.SUPERSEDE, previous, replacement, executor)) {
            IProofOfReviewRegistry.Receipt storage old = _model[reviewer][previous];
            old.status = IProofOfReviewRegistry.ReceiptStatus.Superseded;
            old.successor = replacement;
            old.updatedAt = vm.getBlockTimestamp();
            everTerminal[reviewer][previous] = true;
            _record(reviewer, replacement, previous);
            ++superseded;
        } else {
            ++violations;
        }
    }

    function invalidate(uint256 reviewerSeed) external {
        address reviewer = _pickReviewer(reviewerSeed);
        uint256 nonce = REGISTRY.nonceOf(reviewer);
        vm.prank(reviewer);
        try REGISTRY.invalidateNonce(nonce) {
            ++invalidations[reviewer];
        } catch {
            ++violations;
        }
    }

    // ---- Operations that must fail ------------------------------------------------------------

    /// @dev Re-submits a signed action that already executed.
    function replay(uint256 pickSeed, address executor) external {
        if (_executed.length == 0) return;
        SignedAction storage signed = _executed[pickSeed % _executed.length];
        _expectFailure(signed.action, signed.signature, executor);
    }

    /// @dev A well-formed action for a tracked reviewer, signed by someone else's key.
    function forgeSignature(uint256 reviewerSeed, uint256 pickSeed, uint256 keySeed, address executor)
        external
    {
        address reviewer = _pickReviewer(reviewerSeed);
        uint256 wrongKey = bound(keySeed, 1, SECP256K1_N - 1);
        if (vm.addr(wrongKey) == reviewer) return;

        bytes32[] storage known = _commitments[reviewer];
        IProofOfReviewRegistry.ReviewAction memory action = known.length == 0
            ? _action(reviewer, ReviewActionCodes.ISSUE, _freshCommitment(), bytes32(0))
            : _action(reviewer, ReviewActionCodes.REVOKE, known[pickSeed % known.length], bytes32(0));
        _expectFailure(action, _sign(wrongKey, action), executor);
    }

    /// @dev Correctly signed by the reviewer, but not allowed by the lifecycle rules.
    function invalidTransition(uint256 reviewerSeed, uint256 pickSeed, uint8 mode, address executor)
        external
    {
        address reviewer = _pickReviewer(reviewerSeed);
        bytes32[] storage known = _commitments[reviewer];
        if (known.length == 0) return;
        bytes32 target = known[pickSeed % known.length];
        bool active = _model[reviewer][target].status == IProofOfReviewRegistry.ReceiptStatus.Active;

        IProofOfReviewRegistry.ReviewAction memory action;
        if (mode % 3 == 0) {
            // Re-issue something that already exists, whatever its status.
            action = _action(reviewer, ReviewActionCodes.ISSUE, target, bytes32(0));
        } else if (mode % 3 == 1) {
            // Supersede onto a commitment that already exists (or onto itself).
            bytes32 taken = known[(pickSeed / 7) % known.length];
            action = _action(reviewer, ReviewActionCodes.SUPERSEDE, target, taken);
        } else {
            // Revoke a terminal receipt.
            if (active) return;
            action = _action(reviewer, ReviewActionCodes.REVOKE, target, bytes32(0));
        }
        _expectFailure(action, _sign(_keys[reviewer], action), executor);
    }

    /// @dev An unrelated account advancing its own nonce must not affect any reviewer.
    function strangerInvalidates(address stranger) external {
        for (uint256 i = 0; i < _reviewers.length; ++i) {
            if (stranger == _reviewers[i]) return;
        }
        uint256 nonce = REGISTRY.nonceOf(stranger);
        vm.prank(stranger);
        try REGISTRY.invalidateNonce(nonce) {}
        catch {
            ++violations;
        }
    }

    // ---- Internals ----------------------------------------------------------------------------

    function _pickReviewer(uint256 seed) internal view returns (address) {
        return _reviewers[seed % _reviewers.length];
    }

    function _advanceTime(uint256 seed) internal {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 0, 1 days));
    }

    function _freshCommitment() internal returns (bytes32) {
        return keccak256(abi.encode("synthetic invariant commitment", ++_fresh));
    }

    function _action(address reviewer, uint8 code, bytes32 commitment, bytes32 replacement)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return IProofOfReviewRegistry.ReviewAction({
            reviewer: reviewer,
            action: code,
            commitment: commitment,
            replacementCommitment: replacement,
            nonce: REGISTRY.nonceOf(reviewer),
            deadline: vm.getBlockTimestamp() + 600
        });
    }

    function _sign(uint256 key, IProofOfReviewRegistry.ReviewAction memory action)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, REGISTRY.hashAction(action));
        return abi.encodePacked(r, s, v);
    }

    function _submit(address reviewer, uint8 code, bytes32 commitment, bytes32 replacement, address executor)
        internal
        returns (bool)
    {
        IProofOfReviewRegistry.ReviewAction memory action = _action(reviewer, code, commitment, replacement);
        bytes memory signature = _sign(_keys[reviewer], action);
        vm.prank(executor);
        try REGISTRY.execute(action, signature) {
            ++successfulExecutes[reviewer];
            _executed.push(SignedAction({action: action, signature: signature}));
            return true;
        } catch {
            return false;
        }
    }

    function _expectFailure(
        IProofOfReviewRegistry.ReviewAction memory action,
        bytes memory signature,
        address executor
    ) internal {
        vm.prank(executor);
        try REGISTRY.execute(action, signature) {
            ++violations;
        } catch {
            ++rejected;
        }
    }

    function _issue(address reviewer, address executor) internal returns (bytes32 commitment) {
        commitment = _freshCommitment();
        if (_submit(reviewer, ReviewActionCodes.ISSUE, commitment, bytes32(0), executor)) {
            _record(reviewer, commitment, bytes32(0));
            ++issued;
        } else {
            ++violations;
        }
    }

    function _record(address reviewer, bytes32 commitment, bytes32 predecessor) internal {
        _commitments[reviewer].push(commitment);
        _model[reviewer][commitment] = IProofOfReviewRegistry.Receipt({
            status: IProofOfReviewRegistry.ReceiptStatus.Active,
            predecessor: predecessor,
            successor: bytes32(0),
            issuedAt: vm.getBlockTimestamp(),
            updatedAt: vm.getBlockTimestamp()
        });
    }

    /// @dev Returns an Active commitment of `reviewer`, issuing one when none exists.
    function _activeOrIssue(address reviewer, uint256 pickSeed, address executor) internal returns (bytes32) {
        bytes32[] storage known = _commitments[reviewer];
        uint256 count = known.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 candidate = known[addmod(pickSeed, i, count)];
            if (_model[reviewer][candidate].status == IProofOfReviewRegistry.ReceiptStatus.Active) {
                return candidate;
            }
        }
        return _issue(reviewer, executor);
    }
}

contract RegistryInvariantTest is Test {
    ProofOfReviewRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new ProofOfReviewRegistry();
        handler = new RegistryHandler(registry);
        targetContract(address(handler));
    }

    /// @dev Runs after every campaign: a run in which nothing meaningful happened is a failure.
    function afterInvariant() public view {
        assertGt(handler.issued(), 0, "no receipt was issued");
        assertGt(handler.revoked() + handler.superseded(), 0, "no receipt reached a terminal status");
        assertGt(handler.rejected(), 0, "no invalid operation was exercised");
        assertEq(handler.violations(), 0, "an operation had an unexpected outcome");
    }

    function invariant_everyOperationHadItsExpectedOutcome() public view {
        assertEq(handler.violations(), 0);
    }

    /// @dev Storage equals the independent model: only authorized, successful actions changed it.
    function invariant_registryMatchesTheModel() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            for (uint256 i = 0; i < handler.commitmentCount(reviewer); ++i) {
                bytes32 commitment = handler.commitmentAt(reviewer, i);
                IProofOfReviewRegistry.Receipt memory actual = registry.getReceipt(reviewer, commitment);
                IProofOfReviewRegistry.Receipt memory expected = handler.modelOf(reviewer, commitment);
                assertEq(uint8(actual.status), uint8(expected.status), "status");
                assertEq(actual.predecessor, expected.predecessor, "predecessor");
                assertEq(actual.successor, expected.successor, "successor");
                assertEq(actual.issuedAt, expected.issuedAt, "issuedAt");
                assertEq(actual.updatedAt, expected.updatedAt, "updatedAt");
            }
        }
    }

    function invariant_terminalReceiptsNeverReturnToActive() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            for (uint256 i = 0; i < handler.commitmentCount(reviewer); ++i) {
                bytes32 commitment = handler.commitmentAt(reviewer, i);
                IProofOfReviewRegistry.ReceiptStatus status = registry.getReceipt(reviewer, commitment).status;
                assertTrue(status != IProofOfReviewRegistry.ReceiptStatus.NotFound, "issued receipt vanished");
                if (handler.everTerminal(reviewer, commitment)) {
                    assertTrue(
                        status != IProofOfReviewRegistry.ReceiptStatus.Active, "terminal became active"
                    );
                }
            }
        }
    }

    /// @dev A superseded receipt has exactly one successor, and that successor points back to it
    /// under the same reviewer. Nothing else has a successor.
    function invariant_supersessionLinksAgree() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            uint256 count = handler.commitmentCount(reviewer);
            for (uint256 i = 0; i < count; ++i) {
                bytes32 commitment = handler.commitmentAt(reviewer, i);
                IProofOfReviewRegistry.Receipt memory receipt = registry.getReceipt(reviewer, commitment);

                uint256 successors = 0;
                for (uint256 j = 0; j < count; ++j) {
                    bytes32 candidate = handler.commitmentAt(reviewer, j);
                    if (registry.getReceipt(reviewer, candidate).predecessor == commitment) ++successors;
                }

                if (receipt.status == IProofOfReviewRegistry.ReceiptStatus.Superseded) {
                    assertEq(successors, 1, "superseded receipt must have exactly one successor");
                    assertTrue(receipt.successor != bytes32(0), "missing successor link");
                    assertEq(registry.getReceipt(reviewer, receipt.successor).predecessor, commitment);
                } else {
                    assertEq(successors, 0, "only a superseded receipt has a successor");
                    assertEq(receipt.successor, bytes32(0));
                }

                if (receipt.predecessor != bytes32(0)) {
                    IProofOfReviewRegistry.Receipt memory previous =
                        registry.getReceipt(reviewer, receipt.predecessor);
                    assertEq(uint8(previous.status), uint8(IProofOfReviewRegistry.ReceiptStatus.Superseded));
                    assertEq(previous.successor, commitment);
                    assertLe(previous.issuedAt, receipt.issuedAt);
                }
            }
        }
    }

    /// @dev Replacements must be previously unissued, so walking predecessors always terminates.
    function invariant_chainsCannotCycle() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            uint256 count = handler.commitmentCount(reviewer);
            for (uint256 i = 0; i < count; ++i) {
                bytes32 cursor = handler.commitmentAt(reviewer, i);
                uint256 steps = 0;
                while (cursor != bytes32(0)) {
                    cursor = registry.getReceipt(reviewer, cursor).predecessor;
                    ++steps;
                    assertLe(steps, count, "predecessor chain does not terminate");
                }
            }
        }
    }

    /// @dev Every successful execute, supersession included, and every invalidation consumes one nonce.
    function invariant_eachSuccessConsumesExactlyOneNonce() public view {
        for (uint256 r = 0; r < handler.reviewerCount(); ++r) {
            address reviewer = handler.reviewerAt(r);
            assertEq(
                registry.nonceOf(reviewer),
                handler.successfulExecutes(reviewer) + handler.invalidations(reviewer)
            );
        }
        assertEq(address(registry).balance, 0);
    }
}
