// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Shared helpers. Every key is synthetic and derived from a label inside the test process.
/// Digests are computed here by hand, independently of the registry's own `hashAction`.
abstract contract RegistryTestBase is Test {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ACTION_TYPEHASH = keccak256(
        "ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)"
    );
    string internal constant DOMAIN_NAME = "LexAegisProofOfReview";
    string internal constant DOMAIN_VERSION = "1";
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant START_TIME = 1_800_000_000;
    uint256 internal constant VALIDITY = 600;

    bytes32 internal constant COMMITMENT_A = keccak256("synthetic commitment A");
    bytes32 internal constant COMMITMENT_B = keccak256("synthetic commitment B");
    bytes32 internal constant COMMITMENT_C = keccak256("synthetic commitment C");

    ProofOfReviewRegistry internal registry;
    address internal reviewer;
    uint256 internal reviewerKey;
    address internal other;
    uint256 internal otherKey;
    address internal relayer;

    function setUp() public virtual {
        vm.warp(START_TIME);
        registry = new ProofOfReviewRegistry();
        (reviewer, reviewerKey) = makeAddrAndKey("synthetic reviewer");
        (other, otherKey) = makeAddrAndKey("synthetic other reviewer");
        relayer = makeAddr("synthetic relayer");
    }

    // ---- EIP-712, computed independently ----------------------------------------------------

    function _domainSeparator(string memory name, string memory version, uint256 chainId, address verifier)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, verifier)
        );
    }

    function _structHash(IProofOfReviewRegistry.ReviewAction memory action) internal pure returns (bytes32) {
        return keccak256(
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
    }

    function _digestIn(bytes32 domainSeparator, IProofOfReviewRegistry.ReviewAction memory action)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, _structHash(action)));
    }

    function _digest(IProofOfReviewRegistry.ReviewAction memory action) internal view returns (bytes32) {
        return
            _digestIn(
                _domainSeparator(DOMAIN_NAME, DOMAIN_VERSION, vm.getChainId(), address(registry)), action
            );
    }

    function _signDigest(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sign(uint256 key, IProofOfReviewRegistry.ReviewAction memory action)
        internal
        view
        returns (bytes memory)
    {
        return _signDigest(key, _digest(action));
    }

    // ---- Action builders ----------------------------------------------------------------------

    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + VALIDITY;
    }

    function _action(address signer, uint8 code, bytes32 commitment, bytes32 replacement)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return IProofOfReviewRegistry.ReviewAction({
            reviewer: signer,
            action: code,
            commitment: commitment,
            replacementCommitment: replacement,
            nonce: registry.nonceOf(signer),
            deadline: _deadline()
        });
    }

    function _issue(address signer, bytes32 commitment)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return _action(signer, ReviewActionCodes.ISSUE, commitment, bytes32(0));
    }

    function _revoke(address signer, bytes32 commitment)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return _action(signer, ReviewActionCodes.REVOKE, commitment, bytes32(0));
    }

    function _supersede(address signer, bytes32 previous, bytes32 replacement)
        internal
        view
        returns (IProofOfReviewRegistry.ReviewAction memory)
    {
        return _action(signer, ReviewActionCodes.SUPERSEDE, previous, replacement);
    }

    /// @dev Signs with `key` and submits from the unrelated relayer account.
    function _execute(uint256 key, IProofOfReviewRegistry.ReviewAction memory action) internal {
        bytes memory signature = _sign(key, action);
        vm.prank(relayer);
        registry.execute(action, signature);
    }

    function _expectExecuteRevert(
        uint256 key,
        IProofOfReviewRegistry.ReviewAction memory action,
        bytes memory revertData
    ) internal {
        bytes memory signature = _sign(key, action);
        vm.expectRevert(revertData);
        vm.prank(relayer);
        registry.execute(action, signature);
    }

    function _transition(IProofOfReviewRegistry.ReceiptStatus status) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IProofOfReviewRegistry.InvalidLifecycleTransition.selector, status);
    }

    function _invalidNonce(uint256 currentNonce) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IProofOfReviewRegistry.InvalidNonce.selector, currentNonce);
    }

    function _selector(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    // ---- Assertions ---------------------------------------------------------------------------

    function _assertReceipt(
        address signer,
        bytes32 commitment,
        IProofOfReviewRegistry.ReceiptStatus status,
        bytes32 predecessor,
        bytes32 successor,
        uint256 issuedAt,
        uint256 updatedAt
    ) internal view {
        IProofOfReviewRegistry.Receipt memory receipt = registry.getReceipt(signer, commitment);
        assertEq(uint8(receipt.status), uint8(status), "status");
        assertEq(receipt.predecessor, predecessor, "predecessor");
        assertEq(receipt.successor, successor, "successor");
        assertEq(receipt.issuedAt, issuedAt, "issuedAt");
        assertEq(receipt.updatedAt, updatedAt, "updatedAt");
    }

    function _assertNotFound(address signer, bytes32 commitment) internal view {
        _assertReceipt(
            signer, commitment, IProofOfReviewRegistry.ReceiptStatus.NotFound, bytes32(0), bytes32(0), 0, 0
        );
    }

    /// @dev Asserts one log's emitter, topics and data exactly.
    function _assertLog(Vm.Log memory log, bytes32[] memory topics, bytes memory data) internal view {
        assertEq(log.emitter, address(registry), "emitter");
        assertEq(log.topics.length, topics.length, "topic count");
        for (uint256 i = 0; i < topics.length; ++i) {
            assertEq(log.topics[i], topics[i], "topic");
        }
        assertEq(log.data, data, "data");
    }

    function _assertIssuedLog(
        Vm.Log memory log,
        address signer,
        bytes32 commitment,
        bytes32 predecessor,
        uint256 nonce
    ) internal view {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = IProofOfReviewRegistry.ReceiptIssued.selector;
        topics[1] = bytes32(uint256(uint160(signer)));
        topics[2] = commitment;
        topics[3] = predecessor;
        _assertLog(log, topics, abi.encode(nonce, vm.getBlockTimestamp()));
    }

    function _assertRevokedLog(Vm.Log memory log, address signer, bytes32 commitment, uint256 nonce)
        internal
        view
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = IProofOfReviewRegistry.ReceiptRevoked.selector;
        topics[1] = bytes32(uint256(uint160(signer)));
        topics[2] = commitment;
        _assertLog(log, topics, abi.encode(nonce, vm.getBlockTimestamp()));
    }

    function _assertSupersededLog(
        Vm.Log memory log,
        address signer,
        bytes32 previous,
        bytes32 replacement,
        uint256 nonce
    ) internal view {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = IProofOfReviewRegistry.ReceiptSuperseded.selector;
        topics[1] = bytes32(uint256(uint160(signer)));
        topics[2] = previous;
        topics[3] = replacement;
        _assertLog(log, topics, abi.encode(nonce, vm.getBlockTimestamp()));
    }
}
