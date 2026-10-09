// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReviewAuthorization} from "./ReviewAuthorization.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "./interfaces/IProofOfReviewRegistry.sol";

/// @title ProofOfReviewRegistry
/// @notice Permissionless, non-upgradeable register of review receipts. There is no owner,
/// administrator, allowlist, token, payment or custody. Revoked and Superseded are terminal: a
/// commitment, once issued by a reviewer, is never reactivated, overwritten or deleted.
contract ProofOfReviewRegistry is ReviewAuthorization {
    /// @dev Keyed by reviewer first, so copying a public commitment cannot occupy another reviewer's record.
    mapping(address reviewer => mapping(bytes32 commitment => Receipt receipt)) private _receipts;

    /// @inheritdoc IProofOfReviewRegistry
    function protocolVersion() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IProofOfReviewRegistry
    function getReceipt(address reviewer, bytes32 commitment) external view returns (Receipt memory) {
        return _receipts[reviewer][commitment];
    }

    /// @inheritdoc IProofOfReviewRegistry
    function execute(ReviewAction calldata action, bytes calldata signature) external {
        uint8 code = action.action;
        bytes32 commitment = action.commitment;
        bytes32 replacement = action.replacementCommitment;

        if (code > ReviewActionCodes.SUPERSEDE) revert InvalidActionShape();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (code == ReviewActionCodes.SUPERSEDE) {
            if (replacement == bytes32(0)) revert ZeroCommitment();
            if (replacement == commitment) revert InvalidActionShape();
        } else if (replacement != bytes32(0)) {
            revert InvalidActionShape();
        }

        uint256 nonce = _authorizeAndConsume(action, signature);
        mapping(bytes32 => Receipt) storage receipts = _receipts[action.reviewer];

        // The only external call above is the ERC-1271 STATICCALL, during which no log can be emitted
        // and no state can change, so these events cannot be reordered or fabricated by reentrancy.
        // forge-lint: disable-start(reentrancy-events)
        if (code == ReviewActionCodes.ISSUE) {
            _create(receipts, commitment, bytes32(0));
            emit ReceiptIssued(action.reviewer, commitment, bytes32(0), nonce, block.timestamp);
        } else if (code == ReviewActionCodes.REVOKE) {
            _retire(receipts[commitment], ReceiptStatus.Revoked);
            emit ReceiptRevoked(action.reviewer, commitment, nonce, block.timestamp);
        } else {
            Receipt storage previous = receipts[commitment];
            _retire(previous, ReceiptStatus.Superseded);
            previous.successor = replacement;
            _create(receipts, replacement, commitment);
            emit ReceiptIssued(action.reviewer, replacement, commitment, nonce, block.timestamp);
            emit ReceiptSuperseded(action.reviewer, commitment, replacement, nonce, block.timestamp);
        }
        // forge-lint: disable-end(reentrancy-events)
    }

    /// @dev Existence is decided by status, never by a timestamp.
    function _create(mapping(bytes32 => Receipt) storage receipts, bytes32 commitment, bytes32 predecessor)
        private
    {
        Receipt storage receipt = receipts[commitment];
        if (receipt.status != ReceiptStatus.NotFound) revert ReceiptAlreadyIssued();
        receipt.status = ReceiptStatus.Active;
        receipt.predecessor = predecessor;
        receipt.issuedAt = block.timestamp;
        receipt.updatedAt = block.timestamp;
    }

    /// @dev Moves an Active receipt to a terminal status, keeping its issuance time and predecessor.
    function _retire(Receipt storage receipt, ReceiptStatus terminalStatus) private {
        ReceiptStatus current = receipt.status;
        if (current != ReceiptStatus.Active) revert InvalidLifecycleTransition(current);
        receipt.status = terminalStatus;
        receipt.updatedAt = block.timestamp;
    }
}
