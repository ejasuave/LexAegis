// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IProofOfReviewRegistry} from "./interfaces/IProofOfReviewRegistry.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice EIP-712 authorization and one-use nonces for review actions.
/// @dev EIP-712 binds a signature to this chain and registry but does not stop reuse; the stored
/// per-reviewer nonce does. `msg.sender` is only the executor and never stands in for the reviewer.
abstract contract ReviewAuthorization is EIP712, IProofOfReviewRegistry {
    bytes32 public constant REVIEW_ACTION_TYPEHASH = keccak256(
        "ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)"
    );

    /// @dev One counter per reviewer, starting at zero and shared by ISSUE, REVOKE and SUPERSEDE.
    mapping(address reviewer => uint256 nonce) private _nonces;

    constructor() EIP712("LexAegisProofOfReview", "1") {}

    /// @inheritdoc IProofOfReviewRegistry
    function hashAction(ReviewAction calldata action) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REVIEW_ACTION_TYPEHASH,
                    action.reviewer,
                    action.action,
                    action.commitment,
                    action.replacementCommitment,
                    action.nonce,
                    action.deadline
                )
            )
        );
    }

    /// @inheritdoc IProofOfReviewRegistry
    function nonceOf(address reviewer) public view returns (uint256) {
        return _nonces[reviewer];
    }

    /// @inheritdoc IProofOfReviewRegistry
    function invalidateNonce(uint256 expectedNonce) external {
        uint256 current = _nonces[msg.sender];
        if (expectedNonce != current) revert InvalidNonce(current);
        _advanceNonce(msg.sender, current);
        emit NonceInvalidated(msg.sender, current, current + 1, block.timestamp);
    }

    /// @dev Verifies that `action.reviewer` signed `action` for this chain and registry, then consumes
    /// the nonce. A later revert in the caller rolls the consumption back with everything else.
    /// Contract signers are queried with STATICCALL (ERC-1271), so validation cannot mutate state.
    /// @return consumedNonce The nonce the action carried.
    function _authorizeAndConsume(ReviewAction calldata action, bytes calldata signature)
        internal
        returns (uint256 consumedNonce)
    {
        address reviewer = action.reviewer;
        if (reviewer == address(0)) revert ZeroReviewer();

        consumedNonce = _nonces[reviewer];
        if (action.nonce != consumedNonce) revert InvalidNonce(consumedNonce);
        // The deadline is a coarse expiry in seconds; small validator timestamp drift is acceptable.
        // forge-lint: disable-next-line(block-timestamp)
        if (action.deadline == 0 || block.timestamp > action.deadline) revert AuthorizationExpired();
        if (!SignatureChecker.isValidSignatureNowCalldata(reviewer, hashAction(action), signature)) {
            revert InvalidSignature();
        }

        _advanceNonce(reviewer, consumedNonce);
    }

    function _advanceNonce(address reviewer, uint256 current) private {
        if (current == type(uint256).max) revert NonceExhausted();
        unchecked {
            _nonces[reviewer] = current + 1;
        }
    }
}
