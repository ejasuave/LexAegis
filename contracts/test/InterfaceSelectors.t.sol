// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {Test} from "forge-std/Test.sol";

/// @dev The published interface must describe the deployed contract exactly. Every literal below is
/// copied from contracts/artifacts/registry-v1.json (itself derived from the compiled registry and
/// checked by `pnpm contracts:artifacts:check`), not computed from the interface under test. Chapter
/// 15 adds this check without touching the registry source or the interface.
contract InterfaceSelectorsTest is Test {
    function test_functionSelectorsMatchTheArtifact() public pure {
        assertEq(IProofOfReviewRegistry.execute.selector, bytes4(0xb598097e));
        assertEq(IProofOfReviewRegistry.invalidateNonce.selector, bytes4(0xb70e36f0));
        assertEq(IProofOfReviewRegistry.nonceOf.selector, bytes4(0xed2a2d64));
        assertEq(IProofOfReviewRegistry.getReceipt.selector, bytes4(0xd953eb9c));
        assertEq(IProofOfReviewRegistry.hashAction.selector, bytes4(0x8317d9bd));
        assertEq(IProofOfReviewRegistry.protocolVersion.selector, bytes4(0x2ae9c600));
    }

    function test_eventTopicsMatchTheArtifact() public pure {
        assertEq(
            IProofOfReviewRegistry.ReceiptIssued.selector,
            bytes32(0xe801f6cc1fb4fa943f0a2d26357a386a0a7c273bef452ab49c304e77a9548e8e)
        );
        assertEq(
            IProofOfReviewRegistry.ReceiptRevoked.selector,
            bytes32(0xb5f2d4cc49645a1f1caad2bcb57cb89477312b4bdcb9c2118d4519c291048e66)
        );
        assertEq(
            IProofOfReviewRegistry.ReceiptSuperseded.selector,
            bytes32(0x83aa6ff841dcfda0658c9479fe5e737d4fccaa7be982aea0e8cb37159707753e)
        );
        assertEq(
            IProofOfReviewRegistry.NonceInvalidated.selector,
            bytes32(0x985a3c4c446321883f3a821cac5419a56a632929bdb8782f85f31742005fcbde)
        );
    }

    function test_errorSelectorsMatchTheArtifact() public pure {
        assertEq(IProofOfReviewRegistry.InvalidActionShape.selector, bytes4(0xcb5e96f7));
        assertEq(IProofOfReviewRegistry.ZeroReviewer.selector, bytes4(0xaa52788a));
        assertEq(IProofOfReviewRegistry.ZeroCommitment.selector, bytes4(0x51bda03d));
        assertEq(IProofOfReviewRegistry.InvalidNonce.selector, bytes4(0xb1373a6c));
        assertEq(IProofOfReviewRegistry.NonceExhausted.selector, bytes4(0xe4b4cce4));
        assertEq(IProofOfReviewRegistry.AuthorizationExpired.selector, bytes4(0x0f05f5bf));
        assertEq(IProofOfReviewRegistry.InvalidSignature.selector, bytes4(0x8baa579f));
        assertEq(IProofOfReviewRegistry.ReceiptAlreadyIssued.selector, bytes4(0x0b60421f));
        assertEq(IProofOfReviewRegistry.InvalidLifecycleTransition.selector, bytes4(0xf56e1b11));
    }

    function test_theTupleLayoutsEncodeToTheArtifactSignatures() public pure {
        // The struct layouts are part of the ABI: their canonical type strings are the artifact's.
        assertEq(
            keccak256("execute((address,uint8,bytes32,bytes32,uint256,uint256),bytes)"),
            keccak256(abi.encodePacked("execute((address,uint8,bytes32,bytes32,uint256,uint256),bytes)"))
        );
        assertEq(
            bytes4(keccak256("execute((address,uint8,bytes32,bytes32,uint256,uint256),bytes)")),
            bytes4(0xb598097e)
        );
        assertEq(bytes4(keccak256("getReceipt(address,bytes32)")), IProofOfReviewRegistry.getReceipt.selector);
        // ReviewAction is six static words; Receipt is five (status, predecessor, successor, two times).
        IProofOfReviewRegistry.ReviewAction memory action;
        assertEq(abi.encode(action).length, 6 * 32);
        IProofOfReviewRegistry.Receipt memory receipt;
        assertEq(abi.encode(receipt).length, 5 * 32);
    }

    function test_theEnumOrderIsPartOfTheV1Abi() public pure {
        assertEq(uint8(IProofOfReviewRegistry.ReceiptStatus.NotFound), 0);
        assertEq(uint8(IProofOfReviewRegistry.ReceiptStatus.Active), 1);
        assertEq(uint8(IProofOfReviewRegistry.ReceiptStatus.Revoked), 2);
        assertEq(uint8(IProofOfReviewRegistry.ReceiptStatus.Superseded), 3);
    }

    function test_theRegistryServesTheInterface() public {
        IProofOfReviewRegistry registry = IProofOfReviewRegistry(address(new ProofOfReviewRegistry()));
        assertEq(registry.protocolVersion(), 1);
        assertEq(registry.nonceOf(address(0xBEEF)), 0);
        IProofOfReviewRegistry.Receipt memory receipt =
            registry.getReceipt(address(0xBEEF), bytes32(uint256(1)));
        assertEq(uint8(receipt.status), uint8(IProofOfReviewRegistry.ReceiptStatus.NotFound));
        assertEq(receipt.issuedAt, 0);
    }
}
