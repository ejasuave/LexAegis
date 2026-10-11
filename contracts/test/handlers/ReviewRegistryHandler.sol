// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../../src/interfaces/IProofOfReviewRegistry.sol";
import {ERC1271OwnedAccount} from "../fixtures/ERC1271Fixtures.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title Stateful model of the unchanged registry (Chapter 17)
/// @notice TEST ONLY. Drives the real `ProofOfReviewRegistry` through `execute` and `invalidateNonce`
/// with real EIP-712 signatures, and keeps an independent ghost model of every reviewer namespace.
/// @dev Rules this handler follows:
///  - Expected values come from the ghost model's pre-state and the intended transition. The model is
///    updated only after the registry call returned; nothing read back from the registry is copied
///    into an expected answer. Action nonces come from the ghost nonce, never from `nonceOf`.
///  - A constructed valid action is called WITHOUT try/catch, so an unexpected revert escapes and
///    fails the campaign (`fail_on_revert = true`).
///  - A deliberately invalid action is called with try/catch. Success reverts with
///    `UnexpectedSuccess`. A revert with different data than the model predicts is counted in
///    `unexpectedRejected`, which the invariants require to be zero. A state change across any
///    tracked namespace reverts with `StateChangedByRejectedCall`.
///  - Four separate nonces exist in this system and are not interchangeable: this registry nonce,
///    an account's transaction nonce, an authentication challenge, and a private opening's blinding
///    nonce. Only the first is modelled here.
/// Every key is synthetic and derived from a label inside the test process.
contract ReviewRegistryHandler is Test {
    enum Op {
        Issue,
        Revoke,
        Supersede,
        Invalidate,
        RejectSignature,
        RejectShape,
        RejectDeadline,
        RejectLifecycle,
        RejectNonce,
        RejectInvalidation
    }

    struct Counts {
        uint256 attempted;
        uint256 succeeded;
        uint256 expectedRejected;
        uint256 unexpectedRejected;
    }

    struct Ghost {
        IProofOfReviewRegistry.ReceiptStatus status;
        bytes32 predecessor;
        bytes32 successor;
        uint256 issuedAt;
        uint256 updatedAt;
    }

    struct SignedAction {
        IProofOfReviewRegistry.ReviewAction action;
        bytes signature;
    }

    error UnexpectedSuccess(Op op);
    error StateChangedByRejectedCall(Op op);
    error LogMismatch(Op op, uint256 index);
    error ModelError(string reason);
    error NonceWentBackwards(address account);

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ACTION_TYPEHASH = keccak256(
        "ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)"
    );
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 public constant EOA_REVIEWERS = 4;
    uint256 public constant EXECUTORS = 3;
    /// @dev The same commitment bytes are offered to every reviewer, so namespaces overlap.
    uint256 public constant POOL = 24;
    uint256 internal constant REPLAY_SLOTS = 16;
    uint256 internal constant OP_COUNT = 10;

    ProofOfReviewRegistry public immutable REGISTRY;
    ERC1271OwnedAccount public immutable CONTRACT_REVIEWER;

    address[] internal _reviewers;
    address[] internal _executors;
    address[] internal _accounts;
    bytes32[] internal _pool;
    mapping(address reviewer => uint256 key) internal _key;
    uint256[2] internal _contractOwnerKeys;
    uint256 internal _contractOwnerIndex;

    // ---- Ghost model ---------------------------------------------------------------------------
    mapping(address reviewer => mapping(bytes32 commitment => Ghost)) internal _ghost;
    mapping(address reviewer => bytes32[] commitments) internal _issued;
    mapping(address account => uint256 nonce) internal _nonce;
    mapping(address reviewer => mapping(bytes32 commitment => bool)) public everTerminal;
    mapping(address reviewer => mapping(bytes32 commitment => uint256)) public firstIssuedAt;
    mapping(address account => uint256) public successfulExecutes;
    mapping(address account => uint256) public successfulInvalidations;

    // ---- Observations (from logs and reads; never used as expected values) ----------------------
    mapping(address reviewer => mapping(bytes32 commitment => uint256)) public issuedEvents;
    mapping(address reviewer => mapping(bytes32 commitment => uint256)) public supersededEvents;
    mapping(address account => uint256) internal _observedNonce;

    // ---- Coverage ------------------------------------------------------------------------------
    mapping(Op => mapping(address reviewer => Counts)) internal _counts;
    mapping(Op => Counts) internal _totals;
    mapping(Op => uint256) public skipped;
    uint256 public prerequisiteIssues;
    /// @dev Issuances of bytes that some other reviewer had already issued.
    uint256 public sharedCommitmentIssues;
    /// @dev Supersessions whose previous receipt was itself a replacement (a chain of length >= 3).
    uint256 public chainedSupersessions;
    uint256 public unexpectedRejected;
    bytes public lastUnexpectedRevert;
    uint256 public contractOwnerRotations;

    SignedAction[] internal _executed;
    uint256 internal _executedCursor;

    constructor(ProofOfReviewRegistry registry) {
        REGISTRY = registry;
        for (uint256 i = 0; i < EOA_REVIEWERS; ++i) {
            (address reviewer, uint256 key) =
                makeAddrAndKey(string.concat("synthetic stateful reviewer ", vm.toString(i)));
            _reviewers.push(reviewer);
            _key[reviewer] = key;
        }
        (address ownerA, uint256 ownerKeyA) = makeAddrAndKey("synthetic contract-account owner A");
        (, uint256 ownerKeyB) = makeAddrAndKey("synthetic contract-account owner B");
        _contractOwnerKeys = [ownerKeyA, ownerKeyB];
        CONTRACT_REVIEWER = new ERC1271OwnedAccount(ownerA);
        _reviewers.push(address(CONTRACT_REVIEWER));
        _key[address(CONTRACT_REVIEWER)] = ownerKeyA;

        for (uint256 i = 0; i < EXECUTORS; ++i) {
            _executors.push(makeAddr(string.concat("synthetic stateful executor ", vm.toString(i))));
        }
        for (uint256 i = 0; i < _reviewers.length; ++i) {
            _accounts.push(_reviewers[i]);
        }
        for (uint256 i = 0; i < EXECUTORS; ++i) {
            _accounts.push(_executors[i]);
        }
        for (uint256 i = 0; i < POOL; ++i) {
            _pool.push(keccak256(abi.encode("synthetic stateful commitment", i)));
        }
    }

    // ============================================================================================
    // Operations that must succeed
    // ============================================================================================

    function issue(uint256 reviewerSeed, uint256 pickSeed, uint256 senderSeed, uint256 timeSeed) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        // Half of the issues take the lowest free pool entry, so reviewers collide on the same bytes.
        (bool found, bytes32 commitment) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed % 2 == 0 ? 0 : pickSeed);
        if (!found) {
            ++skipped[Op.Issue];
            return;
        }
        _issue(reviewer, commitment, senderSeed, timeSeed);
        _observeNonces();
    }

    function revoke(uint256 reviewerSeed, uint256 pickSeed, uint256 senderSeed, uint256 timeSeed) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        (bool found, bytes32 commitment) = _activeOrIssue(reviewer, pickSeed, senderSeed, timeSeed);
        if (!found) {
            ++skipped[Op.Revoke];
            return;
        }
        _advance(timeSeed >> 16);
        IProofOfReviewRegistry.ReviewAction memory action =
            _build(reviewer, ReviewActionCodes.REVOKE, commitment, bytes32(0), _validDeadline(timeSeed));
        Vm.Log[] memory logs = _executeValid(Op.Revoke, action, senderSeed);

        if (logs.length != 1) revert LogMismatch(Op.Revoke, logs.length);
        _expectLog(
            Op.Revoke,
            logs[0],
            _topics(IProofOfReviewRegistry.ReceiptRevoked.selector, reviewer, commitment),
            abi.encode(action.nonce, vm.getBlockTimestamp())
        );
        Ghost storage ghost = _ghost[reviewer][commitment];
        ghost.status = IProofOfReviewRegistry.ReceiptStatus.Revoked;
        ghost.updatedAt = vm.getBlockTimestamp();
        everTerminal[reviewer][commitment] = true;
        _observeNonces();
    }

    function supersede(uint256 reviewerSeed, uint256 pickSeed, uint256 senderSeed, uint256 timeSeed)
        external
    {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        (bool hasActive, bytes32 previous) = _activeOrIssue(reviewer, pickSeed, senderSeed, timeSeed);
        (bool hasFree, bytes32 replacement) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed >> 8);
        if (!hasActive || !hasFree) {
            ++skipped[Op.Supersede];
            return;
        }
        _advance(timeSeed >> 16);
        IProofOfReviewRegistry.ReviewAction memory action =
            _build(reviewer, ReviewActionCodes.SUPERSEDE, previous, replacement, _validDeadline(timeSeed));
        Vm.Log[] memory logs = _executeValid(Op.Supersede, action, senderSeed);

        _checkSupersedeLogs(logs, reviewer, previous, replacement, action.nonce);
        _applySupersede(reviewer, previous, replacement);
        _observeNonces();
    }

    /// @dev The reviewer's own, signature-free cancellation. It advances that caller's nonce by one.
    function invalidate(uint256 reviewerSeed, uint256 timeSeed) external {
        _advance(timeSeed);
        _invalidateValid(_reviewer(reviewerSeed));
        _observeNonces();
    }

    // ============================================================================================
    // Operations that must be rejected (each violates exactly one precondition where possible)
    // ============================================================================================

    function rejectSignature(
        uint256 reviewerSeed,
        uint256 pickSeed,
        uint256 mode,
        uint256 senderSeed,
        uint256 timeSeed
    ) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        (bool found, IProofOfReviewRegistry.ReviewAction memory action) =
            _otherwiseValid(reviewer, pickSeed, timeSeed);
        if (!found) {
            ++skipped[Op.RejectSignature];
            return;
        }
        bytes memory signature = _badSignature(reviewer, action, mode % 9, pickSeed);
        // Altered after signing: still a valid deadline, no longer the signed one.
        if (mode % 9 == 1) {
            action.deadline = action.deadline == type(uint256).max ? action.deadline - 1 : action.deadline + 1;
        }
        _expectRejection(
            Op.RejectSignature,
            reviewer,
            action,
            signature,
            _sender(reviewer, senderSeed),
            _one(abi.encodeWithSelector(IProofOfReviewRegistry.InvalidSignature.selector))
        );
        _observeNonces();
    }

    function rejectShapeOrDeadline(
        uint256 reviewerSeed,
        uint256 pickSeed,
        uint256 mode,
        uint256 senderSeed,
        uint256 timeSeed
    ) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        (bool built, Op op, IProofOfReviewRegistry.ReviewAction memory action, bytes[] memory acceptable) =
            _malformed(reviewer, pickSeed, mode, _validDeadline(timeSeed));
        if (!built) {
            ++skipped[Op.RejectShape];
            return;
        }
        _expectRejection(
            op,
            reviewer,
            action,
            _signature(_key[reviewer], _digest(action)),
            _sender(reviewer, senderSeed),
            acceptable
        );
        _observeNonces();
    }

    /// @dev Correctly signed, current nonce, valid deadline: only the lifecycle rule is broken.
    function rejectLifecycle(
        uint256 reviewerSeed,
        uint256 pickSeed,
        uint256 mode,
        uint256 senderSeed,
        uint256 timeSeed
    ) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        (bool built, IProofOfReviewRegistry.ReviewAction memory action, bytes memory expected) =
            _lifecycleViolation(reviewer, pickSeed, mode % 6, _validDeadline(timeSeed));
        if (!built) {
            ++skipped[Op.RejectLifecycle];
            return;
        }
        _expectRejection(
            Op.RejectLifecycle,
            reviewer,
            action,
            _signature(_key[reviewer], _digest(action)),
            _sender(reviewer, senderSeed),
            _one(expected)
        );
        _observeNonces();
    }

    /// @dev Replays, stale and future nonces, and invalidation attempts that must not move a nonce.
    function rejectNonce(
        uint256 reviewerSeed,
        uint256 pickSeed,
        uint256 mode,
        uint256 senderSeed,
        uint256 timeSeed
    ) external {
        _advance(timeSeed);
        address reviewer = _reviewer(reviewerSeed);
        uint256 kind = mode % 5;
        if (kind == 0 && _executed.length == 0) kind = 1;
        if (kind == 2 && _nonce[reviewer] == 0) kind = 1;

        if (kind == 0) {
            _replay(pickSeed, senderSeed);
        } else if (kind == 1 || kind == 2) {
            (bool hasFree, bytes32 free) =
                _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed);
            if (!hasFree) {
                ++skipped[Op.RejectNonce];
                return;
            }
            IProofOfReviewRegistry.ReviewAction memory action =
                _build(reviewer, ReviewActionCodes.ISSUE, free, bytes32(0), _validDeadline(timeSeed));
            action.nonce = kind == 1 ? action.nonce + 1 + (pickSeed % 3) : action.nonce - 1;
            _expectRejection(
                Op.RejectNonce,
                reviewer,
                action,
                _signature(_key[reviewer], _digest(action)),
                _sender(reviewer, senderSeed),
                _one(_invalidNonce(_nonce[reviewer]))
            );
        } else if (kind == 3) {
            // Someone else names the reviewer's nonce. The call acts only for its own sender.
            address stranger = _executors[senderSeed % EXECUTORS];
            _invalidateAs(reviewer, stranger, _nonce[reviewer]);
        } else {
            // The reviewer's own call with a value that is not current.
            uint256 current = _nonce[reviewer];
            _invalidateAs(reviewer, reviewer, pickSeed % 2 == 0 || current == 0 ? current + 1 : current - 1);
        }
        _observeNonces();
    }

    // ============================================================================================
    // Views for the invariants
    // ============================================================================================

    function reviewerCount() external view returns (uint256) {
        return _reviewers.length;
    }

    function reviewerAt(uint256 index) external view returns (address) {
        return _reviewers[index];
    }

    function accountCount() external view returns (uint256) {
        return _accounts.length;
    }

    function accountAt(uint256 index) external view returns (address) {
        return _accounts[index];
    }

    function poolAt(uint256 index) external view returns (bytes32) {
        return _pool[index];
    }

    function issuedCount(address reviewer) external view returns (uint256) {
        return _issued[reviewer].length;
    }

    function issuedAt(address reviewer, uint256 index) external view returns (bytes32) {
        return _issued[reviewer][index];
    }

    function ghostOf(address reviewer, bytes32 commitment) external view returns (Ghost memory) {
        return _ghost[reviewer][commitment];
    }

    function ghostNonce(address account) external view returns (uint256) {
        return _nonce[account];
    }

    function countsOf(Op op, address reviewer) external view returns (Counts memory) {
        return _counts[op][reviewer];
    }

    function totalOf(Op op) external view returns (Counts memory) {
        return _totals[op];
    }

    function executedCount() external view returns (uint256) {
        return _executed.length;
    }

    /// @dev A readable per-operation summary for the recorded campaign.
    function coverage()
        external
        view
        returns (
            uint256[OP_COUNT] memory attempted,
            uint256[OP_COUNT] memory succeeded,
            uint256[OP_COUNT] memory expectedRejected
        )
    {
        for (uint256 i = 0; i < OP_COUNT; ++i) {
            Counts storage total = _totals[Op(i)];
            attempted[i] = total.attempted;
            succeeded[i] = total.succeeded;
            expectedRejected[i] = total.expectedRejected;
        }
    }

    // ============================================================================================
    // Internals: valid paths
    // ============================================================================================

    function _issue(address reviewer, bytes32 commitment, uint256 senderSeed, uint256 timeSeed) internal {
        IProofOfReviewRegistry.ReviewAction memory action =
            _build(reviewer, ReviewActionCodes.ISSUE, commitment, bytes32(0), _validDeadline(timeSeed));
        Vm.Log[] memory logs = _executeValid(Op.Issue, action, senderSeed);
        if (logs.length != 1) revert LogMismatch(Op.Issue, logs.length);
        _expectLog(
            Op.Issue,
            logs[0],
            _topics(IProofOfReviewRegistry.ReceiptIssued.selector, reviewer, commitment, bytes32(0)),
            abi.encode(action.nonce, vm.getBlockTimestamp())
        );
        ++issuedEvents[reviewer][commitment];
        for (uint256 i = 0; i < _reviewers.length; ++i) {
            address other = _reviewers[i];
            if (
                other != reviewer
                    && _ghost[other][commitment].status != IProofOfReviewRegistry.ReceiptStatus.NotFound
            ) {
                ++sharedCommitmentIssues;
                break;
            }
        }
        _create(reviewer, commitment, bytes32(0));
    }

    /// @dev Submits a constructed valid action. No try/catch: an unexpected revert fails the campaign.
    function _executeValid(Op op, IProofOfReviewRegistry.ReviewAction memory action, uint256 senderSeed)
        internal
        returns (Vm.Log[] memory logs)
    {
        address reviewer = action.reviewer;
        bytes memory signature = _signature(_key[reviewer], _digest(action));
        ++_counts[op][reviewer].attempted;
        ++_totals[op].attempted;

        vm.recordLogs();
        vm.prank(_sender(reviewer, senderSeed));
        REGISTRY.execute(action, signature);
        logs = vm.getRecordedLogs();

        ++_counts[op][reviewer].succeeded;
        ++_totals[op].succeeded;
        ++successfulExecutes[reviewer];
        // The intended transition consumed exactly the nonce the action carried.
        _nonce[reviewer] = action.nonce + 1;
        _remember(action, signature);
    }

    function _invalidateValid(address account) internal {
        uint256 current = _nonce[account];
        ++_counts[Op.Invalidate][account].attempted;
        ++_totals[Op.Invalidate].attempted;

        vm.recordLogs();
        vm.prank(account);
        REGISTRY.invalidateNonce(current);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        if (logs.length != 1) revert LogMismatch(Op.Invalidate, logs.length);
        if (
            logs[0].emitter != address(REGISTRY) || logs[0].topics.length != 2
                || logs[0].topics[0] != IProofOfReviewRegistry.NonceInvalidated.selector
                || logs[0].topics[1] != bytes32(uint256(uint160(account)))
                || keccak256(logs[0].data)
                    != keccak256(abi.encode(current, current + 1, vm.getBlockTimestamp()))
        ) revert LogMismatch(Op.Invalidate, 0);

        ++_counts[Op.Invalidate][account].succeeded;
        ++_totals[Op.Invalidate].succeeded;
        ++successfulInvalidations[account];
        _nonce[account] = current + 1;
    }

    /// @dev An Active commitment of `reviewer`, issuing one first when none exists.
    function _activeOrIssue(address reviewer, uint256 pickSeed, uint256 senderSeed, uint256 timeSeed)
        internal
        returns (bool, bytes32)
    {
        (bool found, bytes32 commitment) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.Active, pickSeed);
        if (found) return (true, commitment);
        (found, commitment) = _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, 0);
        if (!found) return (false, bytes32(0));
        _issue(reviewer, commitment, senderSeed, timeSeed);
        ++prerequisiteIssues;
        return (true, commitment);
    }

    function _create(address reviewer, bytes32 commitment, bytes32 predecessor) internal {
        Ghost storage ghost = _ghost[reviewer][commitment];
        if (ghost.status != IProofOfReviewRegistry.ReceiptStatus.NotFound) {
            revert ModelError("the model issued one commitment twice");
        }
        ghost.status = IProofOfReviewRegistry.ReceiptStatus.Active;
        ghost.predecessor = predecessor;
        ghost.issuedAt = vm.getBlockTimestamp();
        ghost.updatedAt = vm.getBlockTimestamp();
        firstIssuedAt[reviewer][commitment] = vm.getBlockTimestamp();
        _issued[reviewer].push(commitment);
    }

    // ============================================================================================
    // Internals: rejected paths
    // ============================================================================================

    function _expectRejection(
        Op op,
        address reviewer,
        IProofOfReviewRegistry.ReviewAction memory action,
        bytes memory signature,
        address sender,
        bytes[] memory acceptable
    ) internal {
        bytes32 before = _fingerprint(action.commitment, action.replacementCommitment);
        ++_counts[op][reviewer].attempted;
        ++_totals[op].attempted;

        vm.recordLogs();
        vm.prank(sender);
        try REGISTRY.execute(action, signature) {
            revert UnexpectedSuccess(op);
        } catch (bytes memory data) {
            _classify(op, reviewer, data, acceptable);
        }
        // A reverted transaction leaves no receipt log and no committed change in any namespace.
        if (vm.getRecordedLogs().length != 0) revert StateChangedByRejectedCall(op);
        if (_fingerprint(action.commitment, action.replacementCommitment) != before) {
            revert StateChangedByRejectedCall(op);
        }
    }

    /// @dev `caller` calls invalidateNonce(expected). The model decides the outcome from the caller's
    /// own ghost nonce: it can never act on `reviewer`'s nonce unless the caller is that reviewer.
    function _invalidateAs(address reviewer, address caller, uint256 expected) internal {
        if (expected == _nonce[caller]) {
            // A legitimate cancellation of the caller's OWN nonce, even when it names another's value.
            _invalidateValid(caller);
            return;
        }
        bytes32 before = _fingerprint(bytes32(0), bytes32(0));
        ++_counts[Op.RejectInvalidation][reviewer].attempted;
        ++_totals[Op.RejectInvalidation].attempted;

        vm.recordLogs();
        vm.prank(caller);
        try REGISTRY.invalidateNonce(expected) {
            revert UnexpectedSuccess(Op.RejectInvalidation);
        } catch (bytes memory data) {
            _classify(Op.RejectInvalidation, reviewer, data, _one(_invalidNonce(_nonce[caller])));
        }
        if (vm.getRecordedLogs().length != 0) revert StateChangedByRejectedCall(Op.RejectInvalidation);
        if (_fingerprint(bytes32(0), bytes32(0)) != before) {
            revert StateChangedByRejectedCall(Op.RejectInvalidation);
        }
    }

    function _replay(uint256 pickSeed, uint256 senderSeed) internal {
        SignedAction storage signed = _executed[pickSeed % _executed.length];
        IProofOfReviewRegistry.ReviewAction memory action = signed.action;
        address reviewer = action.reviewer;
        // The consumed nonce is always a reason. Depending on which check runs first, an expired
        // deadline or the lifecycle rule may be reported instead; each is derived from the model.
        bytes[] memory acceptable = new bytes[](3);
        acceptable[0] = _invalidNonce(_nonce[reviewer]);
        acceptable[1] = vm.getBlockTimestamp() > action.deadline
            ? abi.encodeWithSelector(IProofOfReviewRegistry.AuthorizationExpired.selector)
            : acceptable[0];
        acceptable[2] = action.action == ReviewActionCodes.ISSUE
            ? abi.encodeWithSelector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
            : _transition(_ghost[reviewer][action.commitment].status);
        _expectRejection(
            Op.RejectNonce, reviewer, action, signed.signature, _sender(reviewer, senderSeed), acceptable
        );
    }

    function _lifecycleViolation(address reviewer, uint256 pickSeed, uint256 kind, uint256 deadline)
        internal
        view
        returns (bool built, IProofOfReviewRegistry.ReviewAction memory action, bytes memory expected)
    {
        if (kind == 0) {
            (built, action, expected) = _reissue(reviewer, pickSeed, deadline);
        } else if (kind == 2) {
            (built, action, expected) = _revokeTerminal(reviewer, pickSeed, deadline);
        } else if (kind == 3) {
            (built, action, expected) = _supersedeFromInactive(reviewer, pickSeed, deadline);
        } else if (kind == 4) {
            (built, action, expected) = _supersedeOntoIssued(reviewer, pickSeed, deadline);
        } else if (kind == 5) {
            (built, action, expected) = _revokeAnothersReceipt(reviewer, pickSeed, deadline);
        }
        if (built) return (built, action, expected);

        // Always available while the pool has room: revoke something never issued.
        (bool hasFree, bytes32 free) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed);
        if (!hasFree) return (false, action, expected);
        return (
            true,
            _build(reviewer, ReviewActionCodes.REVOKE, free, bytes32(0), deadline),
            _transition(IProofOfReviewRegistry.ReceiptStatus.NotFound)
        );
    }

    /// @dev Issue something this reviewer already issued, whatever its status now.
    function _reissue(address reviewer, uint256 pickSeed, uint256 deadline)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action, bytes memory)
    {
        uint256 count = _issued[reviewer].length;
        if (count == 0) return (false, action, "");
        return (
            true,
            _build(
                reviewer, ReviewActionCodes.ISSUE, _issued[reviewer][pickSeed % count], bytes32(0), deadline
            ),
            abi.encodeWithSelector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
        );
    }

    function _revokeTerminal(address reviewer, uint256 pickSeed, uint256 deadline)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action, bytes memory)
    {
        (bool hasTerminal, bytes32 terminal) = _pickTerminal(reviewer, pickSeed);
        if (!hasTerminal) return (false, action, "");
        return (
            true,
            _build(reviewer, ReviewActionCodes.REVOKE, terminal, bytes32(0), deadline),
            _transition(_ghost[reviewer][terminal].status)
        );
    }

    /// @dev Supersede from a receipt that is not Active: terminal when one exists, else never issued.
    function _supersedeFromInactive(address reviewer, uint256 pickSeed, uint256 deadline)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action, bytes memory)
    {
        (bool hasFree, bytes32 free) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed);
        if (!hasFree) return (false, action, "");
        (bool hasTerminal, bytes32 from) = _pickTerminal(reviewer, pickSeed);
        if (!hasTerminal) {
            from = _other(free, pickSeed);
            if (_ghost[reviewer][from].status != IProofOfReviewRegistry.ReceiptStatus.NotFound) {
                return (false, action, "");
            }
        }
        return (
            true,
            _build(reviewer, ReviewActionCodes.SUPERSEDE, from, free, deadline),
            _transition(_ghost[reviewer][from].status)
        );
    }

    /// @dev Supersede an Active receipt onto a commitment this reviewer already issued.
    function _supersedeOntoIssued(address reviewer, uint256 pickSeed, uint256 deadline)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action, bytes memory)
    {
        (bool hasActive, bytes32 active) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.Active, pickSeed);
        uint256 count = _issued[reviewer].length;
        if (!hasActive || count < 2) return (false, action, "");
        bytes32 taken = _issued[reviewer][pickSeed % count];
        if (taken == active) taken = _issued[reviewer][addmod(pickSeed, 1, count)];
        return (
            true,
            _build(reviewer, ReviewActionCodes.SUPERSEDE, active, taken, deadline),
            abi.encodeWithSelector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector)
        );
    }

    /// @dev Bytes that are Active under ANOTHER reviewer are still unknown in this namespace.
    function _revokeAnothersReceipt(address reviewer, uint256 pickSeed, uint256 deadline)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action, bytes memory)
    {
        for (uint256 i = 0; i < _reviewers.length; ++i) {
            address other = _reviewers[addmod(pickSeed, i, _reviewers.length)];
            if (other == reviewer) continue;
            (bool theirs, bytes32 commitment) =
                _pick(other, IProofOfReviewRegistry.ReceiptStatus.Active, pickSeed);
            if (
                theirs && _ghost[reviewer][commitment].status == IProofOfReviewRegistry.ReceiptStatus.NotFound
            ) {
                return (
                    true,
                    _build(reviewer, ReviewActionCodes.REVOKE, commitment, bytes32(0), deadline),
                    _transition(IProofOfReviewRegistry.ReceiptStatus.NotFound)
                );
            }
        }
        return (false, action, "");
    }

    /// @dev A correctly signed action with one malformed field, or one unusable deadline.
    function _malformed(address reviewer, uint256 pickSeed, uint256 mode, uint256 deadline)
        internal
        view
        returns (bool, Op op, IProofOfReviewRegistry.ReviewAction memory action, bytes[] memory acceptable)
    {
        (bool hasFree, bytes32 free) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed);
        if (!hasFree) return (false, op, action, acceptable);
        (bool hasActive, bytes32 active) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.Active, pickSeed);
        uint256 kind = mode % 10;
        // The REVOKE and SUPERSEDE shapes need an Active target so that only the shape is wrong.
        if (!hasActive && kind >= 3 && kind <= 5) kind = 2;

        action = _build(reviewer, ReviewActionCodes.ISSUE, free, bytes32(0), deadline);
        bytes4 expected = IProofOfReviewRegistry.InvalidActionShape.selector;
        op = Op.RejectShape;
        if (kind == 0) {
            action.action = uint8(3 + (mode >> 8) % 253);
        } else if (kind == 1) {
            action.commitment = bytes32(0);
            expected = IProofOfReviewRegistry.ZeroCommitment.selector;
        } else if (kind == 2) {
            action.replacementCommitment = _other(free, pickSeed);
        } else if (kind == 3) {
            action = _build(reviewer, ReviewActionCodes.REVOKE, active, free, deadline);
        } else if (kind == 4) {
            action = _build(reviewer, ReviewActionCodes.SUPERSEDE, active, bytes32(0), deadline);
            expected = IProofOfReviewRegistry.ZeroCommitment.selector;
        } else if (kind == 5) {
            action = _build(reviewer, ReviewActionCodes.SUPERSEDE, active, active, deadline);
        } else if (kind == 6) {
            // Nobody can sign for the zero address, whoever signs.
            action.reviewer = address(0);
            action.nonce = 0;
            expected = IProofOfReviewRegistry.ZeroReviewer.selector;
        } else {
            op = Op.RejectDeadline;
            expected = IProofOfReviewRegistry.AuthorizationExpired.selector;
            uint256 nowTime = vm.getBlockTimestamp();
            if (kind == 7) action.deadline = 0;
            else if (kind == 8) action.deadline = nowTime - 1;
            else action.deadline = nowTime - bound(mode >> 8, 2, 30 days);
        }
        acceptable = _one(abi.encodeWithSelector(expected));
        if (kind == 5) {
            // A replacement equal to its predecessor is malformed AND already issued: either answer
            // is a correct refusal, whichever check runs first.
            acceptable = new bytes[](2);
            acceptable[0] = abi.encodeWithSelector(expected);
            acceptable[1] = abi.encodeWithSelector(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector);
        }
        return (true, op, action, acceptable);
    }

    function _checkSupersedeLogs(
        Vm.Log[] memory logs,
        address reviewer,
        bytes32 previous,
        bytes32 replacement,
        uint256 nonce
    ) internal {
        // One atomic action: the replacement's issuance first, then the link, sharing one nonce.
        if (logs.length != 2) revert LogMismatch(Op.Supersede, logs.length);
        bytes memory data = abi.encode(nonce, vm.getBlockTimestamp());
        _expectLog(
            Op.Supersede,
            logs[0],
            _topics(IProofOfReviewRegistry.ReceiptIssued.selector, reviewer, replacement, previous),
            data
        );
        _expectLog(
            Op.Supersede,
            logs[1],
            _topics(IProofOfReviewRegistry.ReceiptSuperseded.selector, reviewer, previous, replacement),
            data
        );
        // The pair of logs is ONE issuance of the replacement, not two.
        ++issuedEvents[reviewer][replacement];
        ++supersededEvents[reviewer][previous];
    }

    function _applySupersede(address reviewer, bytes32 previous, bytes32 replacement) internal {
        Ghost storage old = _ghost[reviewer][previous];
        if (old.predecessor != bytes32(0)) ++chainedSupersessions;
        old.status = IProofOfReviewRegistry.ReceiptStatus.Superseded;
        old.successor = replacement;
        old.updatedAt = vm.getBlockTimestamp();
        everTerminal[reviewer][previous] = true;
        _create(reviewer, replacement, previous);

        // Immediately after the transition: the old member is Superseded and the replacement Active.
        if (REGISTRY.getReceipt(reviewer, previous).status != IProofOfReviewRegistry.ReceiptStatus.Superseded)
        {
            revert ModelError("old receipt is not Superseded right after supersession");
        }
        if (REGISTRY.getReceipt(reviewer, replacement).status != IProofOfReviewRegistry.ReceiptStatus.Active)
        {
            revert ModelError("replacement is not Active right after supersession");
        }
    }

    /// @dev An action whose every precondition holds, for isolating a signature failure.
    function _otherwiseValid(address reviewer, uint256 pickSeed, uint256 timeSeed)
        internal
        view
        returns (bool, IProofOfReviewRegistry.ReviewAction memory action)
    {
        uint256 deadline = _validDeadline(timeSeed);
        (bool hasFree, bytes32 free) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.NotFound, pickSeed);
        (bool hasActive, bytes32 active) =
            _pick(reviewer, IProofOfReviewRegistry.ReceiptStatus.Active, pickSeed);
        if (hasActive && hasFree && pickSeed % 3 == 0) {
            return (true, _build(reviewer, ReviewActionCodes.SUPERSEDE, active, free, deadline));
        }
        if (hasActive && pickSeed % 3 == 1) {
            return (true, _build(reviewer, ReviewActionCodes.REVOKE, active, bytes32(0), deadline));
        }
        if (hasFree) return (true, _build(reviewer, ReviewActionCodes.ISSUE, free, bytes32(0), deadline));
        if (hasActive) {
            return (true, _build(reviewer, ReviewActionCodes.REVOKE, active, bytes32(0), deadline));
        }
        return (false, action);
    }

    function _badSignature(
        address reviewer,
        IProofOfReviewRegistry.ReviewAction memory action,
        uint256 kind,
        uint256 seed
    ) internal returns (bytes memory) {
        uint256 key = _key[reviewer];
        uint256 chainId = vm.getChainId();
        if (kind == 0) {
            // Another tracked reviewer's key: a real key, for the wrong account.
            address other = _reviewers[addmod(seed, 1, EOA_REVIEWERS)];
            if (other == reviewer) other = _reviewers[addmod(seed, 2, EOA_REVIEWERS)];
            return _signature(_key[other], _digest(action));
        }
        if (kind == 1) return _signature(key, _digest(action)); // the caller alters a field afterwards
        if (kind == 2) {
            return
                _signature(
                    key, _digestIn("LexAegisProofOfReview", "1", chainId + 1, address(REGISTRY), action)
                );
        }
        if (kind == 3) {
            return _signature(key, _digestIn("LexAegisProofOfReview", "1", chainId, address(this), action));
        }
        if (kind == 4) return "";
        if (kind == 5) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(action));
            // The other valid point for the same r: accepted by raw ecrecover, refused as malleable.
            return abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        }
        if (kind == 6) {
            return
                _signature(key, _digestIn("LexAegisProofOfReview", "2", chainId, address(REGISTRY), action));
        }
        if (kind == 7) {
            return
                _signature(key, _digestIn("LexAegisProofOfRevieW", "1", chainId, address(REGISTRY), action));
        }
        // kind 8: the contract account changes its signing policy; the previous owner's signature
        // is no longer accepted. For an EOA reviewer this is an unrelated fresh key.
        if (reviewer == address(CONTRACT_REVIEWER)) {
            uint256 previousKey = _contractOwnerKeys[_contractOwnerIndex];
            _contractOwnerIndex = 1 - _contractOwnerIndex;
            uint256 nextKey = _contractOwnerKeys[_contractOwnerIndex];
            CONTRACT_REVIEWER.setOwner(vm.addr(nextKey));
            _key[reviewer] = nextKey;
            ++contractOwnerRotations;
            return _signature(previousKey, _digest(action));
        }
        return _signature(
            uint256(keccak256(abi.encode("synthetic unrelated key", seed))) % (SECP256K1_N - 1) + 1,
            _digest(action)
        );
    }

    function _classify(Op op, address reviewer, bytes memory data, bytes[] memory acceptable) internal {
        bytes32 observed = keccak256(data);
        for (uint256 i = 0; i < acceptable.length; ++i) {
            if (observed == keccak256(acceptable[i])) {
                ++_counts[op][reviewer].expectedRejected;
                ++_totals[op].expectedRejected;
                return;
            }
        }
        ++_counts[op][reviewer].unexpectedRejected;
        ++_totals[op].unexpectedRejected;
        ++unexpectedRejected;
        lastUnexpectedRevert = data;
    }

    /// @dev Every tracked nonce and receipt in every namespace, plus the two commitments a call
    /// names under every reviewer. Read from the registry: it detects change, it predicts nothing.
    function _fingerprint(bytes32 extraA, bytes32 extraB) internal view returns (bytes32 digest) {
        digest = bytes32(REGISTRY.nonceOf(address(0)));
        for (uint256 i = 0; i < _accounts.length; ++i) {
            digest = keccak256(abi.encode(digest, REGISTRY.nonceOf(_accounts[i])));
        }
        for (uint256 r = 0; r < _reviewers.length; ++r) {
            address reviewer = _reviewers[r];
            bytes32[] storage issued = _issued[reviewer];
            for (uint256 i = 0; i < issued.length; ++i) {
                digest = keccak256(abi.encode(digest, REGISTRY.getReceipt(reviewer, issued[i])));
            }
            digest = keccak256(
                abi.encode(
                    digest, REGISTRY.getReceipt(reviewer, extraA), REGISTRY.getReceipt(reviewer, extraB)
                )
            );
        }
        digest = keccak256(
            abi.encode(
                digest, REGISTRY.getReceipt(address(0), extraA), REGISTRY.getReceipt(address(0), extraB)
            )
        );
    }

    // ============================================================================================
    // Internals: helpers
    // ============================================================================================

    function _reviewer(uint256 seed) internal view returns (address) {
        return _reviewers[seed % _reviewers.length];
    }

    /// @dev An unrelated executor, the reviewer itself, or another reviewer acting as executor.
    function _sender(address reviewer, uint256 seed) internal view returns (address) {
        uint256 choice = seed % (EXECUTORS + 2);
        if (choice < EXECUTORS) return _executors[choice];
        if (choice == EXECUTORS) return reviewer;
        address other = _reviewers[(seed >> 8) % _reviewers.length];
        return other;
    }

    /// @dev Bounded so the campaign terminates: at most 30 minutes and one block per step.
    function _advance(uint256 seed) internal {
        vm.warp(vm.getBlockTimestamp() + bound(seed, 0, 30 minutes));
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev Always acceptable: exactly now (equality succeeds), one second ahead, minutes ahead, or far.
    function _validDeadline(uint256 seed) internal view returns (uint256) {
        uint256 nowTime = vm.getBlockTimestamp();
        uint256 kind = seed % 4;
        if (kind == 0) return nowTime;
        if (kind == 1) return nowTime + 1;
        if (kind == 2) return nowTime + bound(seed >> 8, 2, 600);
        return type(uint256).max;
    }

    function _pick(address reviewer, IProofOfReviewRegistry.ReceiptStatus status, uint256 seed)
        internal
        view
        returns (bool, bytes32)
    {
        for (uint256 i = 0; i < POOL; ++i) {
            bytes32 candidate = _pool[addmod(seed, i, POOL)];
            if (_ghost[reviewer][candidate].status == status) return (true, candidate);
        }
        return (false, bytes32(0));
    }

    function _pickTerminal(address reviewer, uint256 seed) internal view returns (bool, bytes32) {
        bytes32[] storage issued = _issued[reviewer];
        for (uint256 i = 0; i < issued.length; ++i) {
            bytes32 candidate = issued[addmod(seed, i, issued.length)];
            if (everTerminal[reviewer][candidate]) return (true, candidate);
        }
        return (false, bytes32(0));
    }

    /// @dev A pool entry different from `commitment`.
    function _other(bytes32 commitment, uint256 seed) internal view returns (bytes32) {
        bytes32 candidate = _pool[seed % POOL];
        return candidate == commitment ? _pool[addmod(seed, 1, POOL)] : candidate;
    }

    function _build(address reviewer, uint8 code, bytes32 commitment, bytes32 replacement, uint256 deadline)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return IProofOfReviewRegistry.ReviewAction({
            reviewer: reviewer,
            action: code,
            commitment: commitment,
            replacementCommitment: replacement,
            nonce: _nonce[reviewer],
            deadline: deadline
        });
    }

    /// @dev EIP-712 computed here by hand for this chain and registry, not by `hashAction`.
    function _digest(IProofOfReviewRegistry.ReviewAction memory action) internal view returns (bytes32) {
        return _digestIn("LexAegisProofOfReview", "1", vm.getChainId(), address(REGISTRY), action);
    }

    function _digestIn(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifier,
        IProofOfReviewRegistry.ReviewAction memory action
    ) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifier)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                action.reviewer,
                action.action,
                action.commitment,
                action.replacementCommitment,
                action.nonce,
                action.deadline
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }

    function _signature(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _remember(IProofOfReviewRegistry.ReviewAction memory action, bytes memory signature) internal {
        SignedAction memory signed = SignedAction({action: action, signature: signature});
        if (_executed.length < REPLAY_SLOTS) {
            _executed.push(signed);
        } else {
            _executed[_executedCursor] = signed;
            _executedCursor = (_executedCursor + 1) % REPLAY_SLOTS;
        }
    }

    /// @dev A nonce that ever decreases is a registry fault, whatever the model believes.
    function _observeNonces() internal {
        for (uint256 i = 0; i < _accounts.length; ++i) {
            address account = _accounts[i];
            uint256 current = REGISTRY.nonceOf(account);
            if (current < _observedNonce[account]) revert NonceWentBackwards(account);
            _observedNonce[account] = current;
        }
    }

    function _expectLog(Op op, Vm.Log memory log, bytes32[] memory topics, bytes memory data) internal view {
        bool ok = log.emitter == address(REGISTRY) && log.topics.length == topics.length
            && keccak256(log.data) == keccak256(data);
        for (uint256 i = 0; ok && i < topics.length; ++i) {
            ok = log.topics[i] == topics[i];
        }
        if (!ok) revert LogMismatch(op, 0);
    }

    function _topics(bytes32 signature, address reviewer, bytes32 second)
        internal
        pure
        returns (bytes32[] memory topics)
    {
        topics = new bytes32[](3);
        topics[0] = signature;
        topics[1] = bytes32(uint256(uint160(reviewer)));
        topics[2] = second;
    }

    function _topics(bytes32 signature, address reviewer, bytes32 second, bytes32 third)
        internal
        pure
        returns (bytes32[] memory topics)
    {
        topics = new bytes32[](4);
        topics[0] = signature;
        topics[1] = bytes32(uint256(uint160(reviewer)));
        topics[2] = second;
        topics[3] = third;
    }

    function _one(bytes memory data) internal pure returns (bytes[] memory list) {
        list = new bytes[](1);
        list[0] = data;
    }

    function _invalidNonce(uint256 current) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IProofOfReviewRegistry.InvalidNonce.selector, current);
    }

    function _transition(IProofOfReviewRegistry.ReceiptStatus status) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IProofOfReviewRegistry.InvalidLifecycleTransition.selector, status);
    }
}
