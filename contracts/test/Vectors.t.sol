// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProofOfReviewRegistry} from "../src/ProofOfReviewRegistry.sol";
import {IProofOfReviewRegistry, ReviewActionCodes} from "../src/interfaces/IProofOfReviewRegistry.sol";
import {ERC1271OwnedAccount} from "./fixtures/ERC1271Fixtures.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Checks the registry against fixtures/registry-v1/vectors.json. Those literal values come
/// from a generator that shares no code with this contract or with the TypeScript SDK, which is
/// tested against the same file. The vectors are never rewritten to make this pass.
contract VectorsTest is Test {
    string internal constant PATH = "../fixtures/registry-v1/vectors.json";

    string internal json;
    uint256 internal signerKey;
    address internal signer;
    bytes internal registryCode;

    function setUp() public {
        json = vm.readFile(PATH);
        signerKey = uint256(vm.parseJsonBytes32(json, ".signer.privateKey"));
        signer = vm.parseJsonAddress(json, ".signer.address");
        registryCode = address(new ProofOfReviewRegistry()).code;
    }

    function test_fixtureMetadataMatchesTheContract() public {
        ProofOfReviewRegistry registry = new ProofOfReviewRegistry();
        (, string memory name, string memory version,,,,) = registry.eip712Domain();
        assertEq(name, vm.parseJsonString(json, ".eip712.domain.name"));
        assertEq(version, vm.parseJsonString(json, ".eip712.domain.version"));
        assertEq(registry.REVIEW_ACTION_TYPEHASH(), vm.parseJsonBytes32(json, ".eip712.typeHash"));
        assertEq(
            keccak256(bytes(vm.parseJsonString(json, ".eip712.typeString"))),
            vm.parseJsonBytes32(json, ".eip712.typeHash")
        );
        assertEq(vm.parseJsonUint(json, ".actionCodes.ISSUE"), ReviewActionCodes.ISSUE);
        assertEq(vm.parseJsonUint(json, ".actionCodes.REVOKE"), ReviewActionCodes.REVOKE);
        assertEq(vm.parseJsonUint(json, ".actionCodes.SUPERSEDE"), ReviewActionCodes.SUPERSEDE);
        assertEq(vm.addr(signerKey), signer);
    }

    function test_everyVectorReproducesDigestAndSignature() public {
        uint256 count = _vectorCount();
        assertEq(count, 7, "unexpected number of vectors");

        for (uint256 i = 0; i < count; ++i) {
            string memory path = string.concat(".vectors[", vm.toString(i), "]");
            IProofOfReviewRegistry.ReviewAction memory action = _action(path);
            ProofOfReviewRegistry registry = _registryFor(path);
            bytes32 digest = vm.parseJsonBytes32(json, string.concat(path, ".expected.digest"));
            bytes memory signature = vm.parseJsonBytes(json, string.concat(path, ".expected.signature"));

            // The contract's own digest on that chain and address equals the literal.
            assertEq(registry.hashAction(action), digest, _id(path));

            // The literal signature is exactly what the test key produces, and recovers to it.
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
            assertEq(abi.encodePacked(r, s, v), signature, _id(path));
            assertEq(ecrecover(digest, v, r, s), signer, _id(path));
        }
    }

    function test_literalSignaturesAuthorizeTheIssueVectors() public {
        uint256 count = _vectorCount();
        uint256 executed = 0;

        for (uint256 i = 0; i < count; ++i) {
            string memory path = string.concat(".vectors[", vm.toString(i), "]");
            IProofOfReviewRegistry.ReviewAction memory action = _action(path);
            if (action.action != ReviewActionCodes.ISSUE) continue;

            ProofOfReviewRegistry registry = _registryFor(path);
            if (action.reviewer != signer) {
                // Contract-account reviewer: a synthetic ERC-1271 account owned by the test key.
                vm.etch(action.reviewer, address(new ERC1271OwnedAccount(signer)).code);
                ERC1271OwnedAccount(action.reviewer).setOwner(signer);
            }

            vm.warp(action.deadline);
            registry.execute(action, vm.parseJsonBytes(json, string.concat(path, ".expected.signature")));

            IProofOfReviewRegistry.Receipt memory receipt =
                registry.getReceipt(action.reviewer, action.commitment);
            assertEq(uint8(receipt.status), uint8(IProofOfReviewRegistry.ReceiptStatus.Active), _id(path));
            assertEq(registry.nonceOf(action.reviewer), 1, _id(path));
            ++executed;
        }
        assertEq(executed, 4, "every ISSUE vector must execute");
    }

    /// @dev Places the registry's runtime code at the vector's address on the vector's chain. The
    /// domain separator is rebuilt for that address and chain ID. Earlier state there is cleared.
    function _registryFor(string memory path) private returns (ProofOfReviewRegistry registry) {
        vm.chainId(vm.parseJsonUint(json, string.concat(path, ".chainId")));
        address location = vm.parseJsonAddress(json, string.concat(path, ".registryAddress"));
        vm.etch(location, registryCode);
        registry = ProofOfReviewRegistry(location);
    }

    function _vectorCount() private view returns (uint256 count) {
        while (vm.keyExistsJson(json, string.concat(".vectors[", vm.toString(count), "]"))) {
            ++count;
        }
    }

    function _id(string memory path) private view returns (string memory) {
        return vm.parseJsonString(json, string.concat(path, ".id"));
    }

    function _action(string memory path) private view returns (IProofOfReviewRegistry.ReviewAction memory) {
        return IProofOfReviewRegistry.ReviewAction({
            reviewer: vm.parseJsonAddress(json, string.concat(path, ".action.reviewer")),
            action: uint8(vm.parseJsonUint(json, string.concat(path, ".action.action"))),
            commitment: vm.parseJsonBytes32(json, string.concat(path, ".action.commitment")),
            replacementCommitment: vm.parseJsonBytes32(
                json, string.concat(path, ".action.replacementCommitment")
            ),
            nonce: vm.parseJsonUint(json, string.concat(path, ".action.nonce")),
            deadline: vm.parseJsonUint(json, string.concat(path, ".action.deadline"))
        });
    }
}
