// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IProofOfReviewRegistry} from "../../src/interfaces/IProofOfReviewRegistry.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev TEST FIXTURES ONLY. Synthetic contract accounts for exercising ERC-1271 authorization.
/// None of these is an account implementation and none may be deployed outside local tests.

/// @notice Accepts a signature made by its current owner key. The owner can be replaced freely so
/// tests can change the account's signature policy.
contract ERC1271OwnedAccount is IERC1271 {
    address public owner;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function setOwner(address newOwner) external {
        owner = newOwner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError outcome,) = ECDSA.tryRecoverCalldata(hash, signature);
        bool accepted = outcome == ECDSA.RecoverError.NoError && recovered == owner;
        return accepted ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// @notice Always answers with a value that is not the ERC-1271 magic value.
contract ERC1271WrongMagic is IERC1271 {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

/// @notice Always reverts.
contract ERC1271Reverting is IERC1271 {
    error Refused();

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert Refused();
    }
}

/// @notice Answers every call with deliberately malformed return data.
contract ERC1271MalformedReturn {
    enum Shape {
        Empty,
        FourBytes,
        DirtyWord
    }

    Shape public immutable SHAPE;

    constructor(Shape shape) {
        SHAPE = shape;
    }

    fallback() external {
        Shape shape = SHAPE;
        bytes4 magic = IERC1271.isValidSignature.selector;
        assembly ("memory-safe") {
            switch shape
            case 0 { return(0x00, 0x00) }
            case 1 {
                // The magic value alone, not padded to a full word.
                mstore(0x00, magic)
                return(0x00, 0x04)
            }
            default {
                // The magic value followed by non-zero padding.
                mstore(0x00, or(magic, 0x01))
                return(0x00, 0x20)
            }
        }
    }
}

/// @notice Tries to change registry state while its signature is being validated.
/// @dev `isValidSignature` is intentionally not `view`. When `SWALLOW_FAILURE` is set the account
/// hides the failed attempt and still answers with the magic value.
contract ERC1271Reentrant {
    IProofOfReviewRegistry public immutable REGISTRY;
    bool public immutable SWALLOW_FAILURE;

    constructor(IProofOfReviewRegistry registry, bool swallowFailure) {
        REGISTRY = registry;
        SWALLOW_FAILURE = swallowFailure;
    }

    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        uint256 nonce = REGISTRY.nonceOf(address(this));
        if (SWALLOW_FAILURE) {
            try REGISTRY.invalidateNonce(nonce) {} catch {}
        } else {
            REGISTRY.invalidateNonce(nonce);
        }
        return IERC1271.isValidSignature.selector;
    }
}
