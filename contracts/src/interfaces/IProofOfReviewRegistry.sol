// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Exact v1 action codes carried in `ReviewAction.action`.
library ReviewActionCodes {
    uint8 internal constant ISSUE = 0;
    uint8 internal constant REVOKE = 1;
    uint8 internal constant SUPERSEDE = 2;
}

/// @title Proof of Review registry, protocol version 1
/// @notice Permissionless register of opaque review commitments. Each reviewer controls only their
/// own receipts. The registry cannot inspect documents and does not prove that an opening is truthful.
/// @dev `bytes32(0)` is reserved: it marks an absent predecessor or successor and an unused
/// replacement field, and is never an issued commitment. Nothing private (evidence, document hashes,
/// labels, opening nonces, URLs, explanations) appears in storage, events or error arguments.
interface IProofOfReviewRegistry {
    /// @dev Order is part of the v1 ABI.
    enum ReceiptStatus {
        NotFound,
        Active,
        Revoked,
        Superseded
    }

    /// @notice A reviewer-signed instruction. `nonce` must equal `nonceOf(reviewer)`; `deadline` is the
    /// last Unix second at which it may execute and does not expire a receipt once issued.
    struct ReviewAction {
        address reviewer;
        uint8 action;
        bytes32 commitment;
        bytes32 replacementCommitment;
        uint256 nonce;
        uint256 deadline;
    }

    struct Receipt {
        ReceiptStatus status;
        bytes32 predecessor;
        bytes32 successor;
        uint256 issuedAt;
        uint256 updatedAt;
    }

    /// @notice A receipt became Active. `predecessor` is zero unless it replaces an earlier receipt.
    event ReceiptIssued(
        address indexed reviewer,
        bytes32 indexed commitment,
        bytes32 indexed predecessor,
        uint256 nonce,
        uint256 timestamp
    );

    event ReceiptRevoked(
        address indexed reviewer, bytes32 indexed commitment, uint256 nonce, uint256 timestamp
    );

    /// @notice Emitted after the replacement's `ReceiptIssued` in the same transaction, with the same nonce.
    /// The two logs describe one atomic action.
    event ReceiptSuperseded(
        address indexed reviewer,
        bytes32 indexed previousCommitment,
        bytes32 indexed replacementCommitment,
        uint256 nonce,
        uint256 timestamp
    );

    event NonceInvalidated(
        address indexed reviewer, uint256 previousNonce, uint256 newNonce, uint256 timestamp
    );

    /// @notice Unknown action code, or a replacement field that does not fit the action.
    error InvalidActionShape();
    error ZeroReviewer();
    /// @notice A commitment that would be issued or targeted is `bytes32(0)`.
    error ZeroCommitment();
    /// @notice The supplied nonce is not the reviewer's current nonce.
    error InvalidNonce(uint256 currentNonce);
    /// @notice The reviewer's nonce cannot advance any further.
    error NonceExhausted();
    /// @notice The deadline is zero or already in the past.
    error AuthorizationExpired();
    error InvalidSignature();
    /// @notice The commitment was already issued by this reviewer, whatever its current status.
    error ReceiptAlreadyIssued();
    /// @notice The targeted receipt is not Active.
    error InvalidLifecycleTransition(ReceiptStatus currentStatus);

    /// @notice Executes a signed action. Anyone may submit it; only the reviewer's signature authorizes it.
    function execute(ReviewAction calldata action, bytes calldata signature) external;

    /// @notice Cancels the caller's own outstanding signature by advancing their nonce.
    function invalidateNonce(uint256 expectedNonce) external;

    function nonceOf(address reviewer) external view returns (uint256);

    /// @notice Returns `NotFound` with zero metadata when the reviewer never issued the commitment.
    function getReceipt(address reviewer, bytes32 commitment) external view returns (Receipt memory);

    /// @notice EIP-712 digest a reviewer signs for `action` on this chain and registry.
    function hashAction(ReviewAction calldata action) external view returns (bytes32);

    function protocolVersion() external pure returns (uint256);
}
