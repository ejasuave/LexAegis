## Chapter 3 — Monad Registry, Approval Signatures and Receipt Lifecycle

This chapter builds the blockchain register for review receipts. It makes sure each action is authorized by the correct reviewer, prevents the same permission from being reused, and lets reviewers revoke or replace their receipts while preserving history. The signing format uses EIP-712, with a separate one-use counter to prevent replay.

```text
📦 BUILD TASK #1: Chapter 2 protocol and contract integration boundary
🛠️ ACTION TYPE: Validate

<execute_task>
Implement Chapter 3 only through sequential repository edits. Do not return a proposed implementation, architectural essay or JSON status report.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json and the Chapter 2 protocol/SDK modules. Confirm the canonicalization, commitments and opening-verification checks pass. Preserve unrelated work.

Keep the Chapter 2 SHA-256 commitment formula and private opening format unchanged. The registry stores opaque commitments; it cannot inspect documents or prove that an opening is truthful.

Build one permissionless, non-upgradeable ProofOfReviewRegistry. Each reviewer controls their own receipts. Add no owner, administrator override, trusted-professional list, token, payment or custody functionality.

Use EIP-712 for signed action authorization and maintained OpenZeppelin EIP712/SignatureChecker implementations. Support ordinary EVM account signatures and deployed ERC-1271 accounts without introducing another reference-app account provider.

Consult official specifications and current compatible dependency documentation:
https://eips.ethereum.org/EIPS/eip-712
https://eips.ethereum.org/EIPS/eip-1271
https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography
https://docs.monad.xyz/

Mera account integration belongs to Chapter 4. Alchemy and public Monad deployment belong to Chapter 6. Use only local test-chain execution in this chapter.
</execute_task>

📦 BUILD TASK #2: contracts/foundry.toml and pinned Solidity dependencies
🛠️ ACTION TYPE: Create

<execute_task>
Create or adapt the Foundry project under contracts without replacing existing work.

Pin compatible stable versions of Solidity, Foundry, forge-std and OpenZeppelin Contracts. Verify the chosen compiler/EVM target against current official Monad documentation and the installed dependency requirements. Record the exact versions and EVM target; do not rely on an implicit changing compiler default.

Configure source, test, script and output directories, dependency remappings, optimizer settings and deterministic build inputs. Preserve the repository's package-management conventions.

Add working root scripts for contract formatting checks, build and tests. Generated caches and broadcast output must not be treated as source.

Do not use upgradeable contract variants, custom signature recovery, custom cryptographic curves or experimental compiler settings to bypass a build problem.

Keep test keys isolated to fixtures and local test processes. Never require a real wallet key, sponsor credential or public RPC endpoint to compile and test the registry.
</execute_task>

📦 BUILD TASK #3: contracts/src/interfaces/IProofOfReviewRegistry.sol
🛠️ ACTION TYPE: Create

<execute_task>
Define the shared Solidity interface with exact v1 action codes:
ISSUE = 0
REVOKE = 1
SUPERSEDE = 2

Define ReceiptStatus in this order:
NotFound = 0
Active = 1
Revoked = 2
Superseded = 3

Define:
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

Declare:
execute(ReviewAction calldata action, bytes calldata signature) external;
invalidateNonce(uint256 expectedNonce) external;
nonceOf(address reviewer) external view returns (uint256);
getReceipt(address reviewer, bytes32 commitment) external view returns (Receipt memory);
hashAction(ReviewAction calldata action) external view returns (bytes32);
protocolVersion() external pure returns (uint256);

Declare these events:
ReceiptIssued(address indexed reviewer, bytes32 indexed commitment, bytes32 indexed predecessor, uint256 nonce, uint256 timestamp);
ReceiptRevoked(address indexed reviewer, bytes32 indexed commitment, uint256 nonce, uint256 timestamp);
ReceiptSuperseded(address indexed reviewer, bytes32 indexed previousCommitment, bytes32 indexed replacementCommitment, uint256 nonce, uint256 timestamp);
NonceInvalidated(address indexed reviewer, uint256 previousNonce, uint256 newNonce, uint256 timestamp);

Define custom errors for invalid action shape, zero reviewer/commitment, invalid or exhausted nonce, expired authorization, invalid signature, duplicate receipt and invalid lifecycle transition.

Reserve bytes32(0) for absent predecessor/successor and unused replacement fields. Never permit it as an issued commitment.

Do not add private evidence, document hashes, labels, opening nonces, URLs or explanations to storage fields, events or custom-error arguments.
</execute_task>

📦 BUILD TASK #4: contracts/src/ReviewAuthorization.sol
🛠️ ACTION TYPE: Create

<execute_task>
Implement an abstract authorization base using OpenZeppelin EIP712 and the shared interface.

Fix the EIP-712 domain:
name = "LexAegisProofOfReview"
version = "1"
chainId = current block.chainid
verifyingContract = this deployed registry address

Use this exact primary type string:
ReviewAction(address reviewer,uint8 action,bytes32 commitment,bytes32 replacementCommitment,uint256 nonce,uint256 deadline)

Calculate its type hash with keccak256. Hash fields with abi.encode in that exact order and obtain the final digest through OpenZeppelin's EIP-712 implementation. Never use abi.encodePacked, personal_sign or the Chapter 2 package hash as a substitute for the authorization digest.

Implement hashAction and nonceOf. Maintain one checked uint256 nonce per reviewer, starting at zero and shared across all three actions.

Implement an internal authorization-and-consumption function:
- Reject the zero reviewer.
- Require the supplied nonce to equal that reviewer's current nonce.
- Require deadline > 0 and block.timestamp <= deadline.
- Verify the signature for action.reviewer using the address-based SignatureChecker API.
- Reject malformed/invalid signatures.
- Increment the nonce exactly once with overflow protection.

EIP-712 does not supply replay protection; the stored nonce provides it. Any later revert must roll back nonce consumption and all receipt changes.

Implement invalidateNonce(expectedNonce) for msg.sender only. Require an exact current-nonce match, increment once and emit NonceInvalidated. Do not let a relayer invalidate another reviewer's nonce merely by naming that address.

Accept third-party submission of correctly signed actions. msg.sender is the transaction executor, not automatically the reviewer. Provide no signature-free execute shortcut.

Use static-call-based ERC-1271 validation. A contract signer must not be able to mutate the registry during validation. Preserve issued receipts when an ERC-1271 account subsequently changes its signature policy; future actions require authorization at their own execution time.
</execute_task>

📦 BUILD TASK #5: contracts/src/ProofOfReviewRegistry.sol
🛠️ ACTION TYPE: Create

<execute_task>
Implement the concrete registry using ReviewAuthorization.

Store receipts by reviewer AND commitment:
mapping(address => mapping(bytes32 => Receipt))

Implement getReceipt and protocolVersion=1. A missing record returns NotFound with zero metadata. Do not use a timestamp alone to determine existence.

Implement execute with strict action-shape checks and these transitions:

ISSUE:
- commitment is nonzero.
- replacementCommitment is zero.
- The reviewer's commitment has never been issued.
- Create Active with predecessor/successor zero and issuedAt=updatedAt=block.timestamp.
- Emit ReceiptIssued with predecessor zero.

REVOKE:
- commitment identifies an Active receipt for that reviewer.
- replacementCommitment is zero.
- Change only status to Revoked and updatedAt to block.timestamp.
- Preserve original issuance time and predecessor.
- Emit ReceiptRevoked.

SUPERSEDE:
- commitment identifies an Active old receipt for that reviewer.
- replacementCommitment is nonzero, differs from the old commitment and has never been issued for that reviewer.
- Atomically mark the old receipt Superseded with successor=new commitment.
- Create the new receipt Active with predecessor=old commitment.
- Preserve the old issuedAt; update its updatedAt.
- Set the new issuedAt and updatedAt to block.timestamp.
- Emit ReceiptIssued for the new receipt first, then ReceiptSuperseded linking old and new. Both events carry the same consumed authorization nonce.

Call the shared authorization path for every operation. Rejected actions must change no records, consume no nonce and leave no committed logs.

Revoked and Superseded are terminal states. Never reactivate, overwrite or delete a previously issued commitment. Revoking a replacement must not reactivate its predecessor. Allow further supersession only from an Active replacement.

Reject unknown action codes and invalid replacement fields. All mutation entry points are nonpayable; perform no fund transfers or arbitrary callbacks.

Use constant-time storage operations without traversing receipt history. Separate reviewer namespaces so copying a public commitment cannot occupy another reviewer's record.

A signed action's deadline limits when it may execute. It does not automatically expire an already issued receipt.
</execute_task>

📦 BUILD TASK #6: packages/sdk/src/registry/typed-data.ts and action-builders.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement strict TypeScript schemas and pure builders matching the Solidity action, domain and field order exactly. Reuse protocol addresses, digests and canonical unsigned decimal-string validators.

Serialize nonce, deadline and chain ID as decimal strings at JSON boundaries. Enforce uint256 bounds, allow nonce zero and require positive chain ID/deadline. Convert to bigint only for ABI/EIP-712 processing; never pass through JavaScript Number. Deadline and contract timestamps use Unix epoch seconds, not JavaScript milliseconds.

Expose:
- buildIssueAction(preparedSnapshot, nonce, deadline).
- buildRevokeAction(receiptReference, nonce, deadline).
- buildSupersedeAction(previousReference, preparedSnapshot, nonce, deadline).
- buildTypedData(action, chainId, registryAddress).
- hashReviewAction(typedData).

Use fixed action codes and require nonzero target commitments. Populate unused replacement fields with bytes32(0). Reject extra fields and unsupported protocol versions.

For ISSUE, require the captured manifest's supersedes field to be null.

For SUPERSEDE, require the captured manifest's supersedes reference to exactly match previousReference. Require reviewer/chain/registry consistency across the predecessor, prepared snapshot and signing domain.

For every action, bind reviewer and commitments to their supplied references/snapshot. Never reconstruct package contents from mutable UI state or regenerate its blinding nonce.

Take nonce and deadline explicitly; do not guess chain state, auto-increment a stale nonce or silently re-sign. Record a reference-app default deadline of current Unix seconds plus 600 for later UI integration. The contract still enforces the actual signed deadline.

These functions prepare signing data only. They must not unlock Mera, sign, broadcast, approve a review or expose private opening material.
</execute_task>

📦 BUILD TASK #7: Generated registry ABI and SDK receipt-state decoding
🛠️ ACTION TYPE: Extend

<execute_task>
Generate the registry ABI from the compiled Solidity artifact and expose it as a typed SDK export. Do not maintain an independently handwritten ABI.

Implement strict decoding for Receipt, the four event types and known custom errors. Preserve chain/registry/reviewer context and use bigint or canonical decimal strings for integer values.

Map successfully decoded contract status:
NotFound -> not_found
Active -> active
Revoked -> revoked
Superseded -> superseded

An RPC error, missing contract code, empty response or unknown enum value is not NotFound. Keep those outcomes unknown or typed failures. Chapter 6 owns live network acquisition and block-context validation.

Add a pure validateReceiptBinding helper that compares a verified opening/reference with an observed registry record:
- Match the selected chain, registry, reviewer and commitment.
- Require the record's predecessor to match manifest.supersedes, or zero when supersedes is null.
- Treat unexpected links or impossible status/link combinations as a binding mismatch.
- Never infer that a Superseded receipt became Active again because its successor was later revoked.

Keep file integrity, registry lifecycle and signer acceptance separate. Successful decoding does not establish a trustworthy RPC source or a professional credential.

For Envio's later implementation, record the exact supersession event order and that its ReceiptIssued and ReceiptSuperseded logs describe one atomic action. Do not count the new receipt twice.
</execute_task>

📦 BUILD TASK #8: contracts/test/Authorization.t.sol and ERC-1271 fixtures
🛠️ ACTION TYPE: Create

<execute_task>
Add Foundry tests using synthetic keys and local contracts.

Test:
- Correct EOA signature and third-party submission.
- Wrong signer, zero reviewer, empty/malformed signature and ECDSA malleability rejection.
- Changed action, commitment, replacement, reviewer, nonce or deadline invalidates authorization.
- Wrong chain ID, registry address, domain name or version invalidates authorization.
- Domain separation updates correctly if the test chain ID changes.
- Exact deadline boundary succeeds; a later timestamp fails; zero deadline fails.
- Replay fails after a successful operation.
- Failed signatures and failed lifecycle operations leave the nonce unchanged.
- Nonces are isolated per reviewer and shared across action types.
- invalidateNonce prevents the cancelled signature from executing.
- Stale nonce-invalidation requests fail without affecting newer state.
- Nonce exhaustion cannot wrap to zero.

Create ERC-1271 fixtures for a valid account, invalid magic value, malformed return, reverting account and attempted state-changing reentrancy.

Confirm a valid contract account can authorize actions. Invalid or adversarial validation must fail without state changes.

After a valid receipt is issued, change the fixture account's signature policy. Confirm the historical receipt remains issued while new authorization follows the current policy.

Use the actual pinned SignatureChecker behavior; do not substitute a test-only signature validator in the registry.
</execute_task>

📦 BUILD TASK #9: contracts/test/Lifecycle.t.sol and registry invariant tests
🛠️ ACTION TYPE: Create

<execute_task>
Test all valid and invalid lifecycle transitions, exact stored fields and exact event sequences.

Cover:
- ISSUE creates one Active receipt with no predecessor.
- Duplicate ISSUE fails for Active, Revoked and Superseded records.
- Another reviewer may use identical commitment bytes without overwriting or blocking the first reviewer.
- REVOKE affects only the authorized reviewer's Active receipt.
- SUPERSEDE creates a new Active receipt and terminally supersedes the old one atomically.
- Missing/terminal predecessors, zero/equal replacements and previously issued replacements fail.
- Old/new links agree and the original issuance timestamp remains intact.
- Revoking a replacement never restores an earlier approval.
- Invalid action codes, unexpected replacement values and nonzero msg.value fail.
- Rejected operations roll back both storage changes and nonce consumption.

Add bounded fuzz tests and stateful invariant tests with a handler that actually executes successful operations and exercises failures.

Check that:
- Receipt state never returns to Active after becoming terminal.
- Each superseded receipt has exactly one successor.
- Every replacement points back to its predecessor under the same reviewer.
- Chains cannot cycle because replacements must be previously unissued.
- A successful execute consumes exactly one nonce, including supersession.
- Unauthorized callers cannot alter another reviewer's state without that reviewer's valid authorization.

Do not rely on invariants that pass only because every generated operation reverts. Track successful executions and fail the test setup if no meaningful transitions occurred.
</execute_task>

📦 BUILD TASK #10: SDK–Solidity compatibility tests on local Anvil
🛠️ ACTION TYPE: Create

<execute_task>
Create a bounded integration test that starts a local Anvil instance, deploys the compiled registry and uses real viem signing/encoding with test-only accounts.

Compare Solidity hashAction with the TypeScript EIP-712 digest for fixed vectors. Check ABI encoding, signature verification, errors and event decoding across both runtimes.

Use Chapter 2 synthetic artifact fixtures to prepare a new package bound to the actual local registry, test chain ID and test reviewer. Prepare it before signing; do not edit an already frozen opening.

Execute this sequence:
1. Issue a receipt from a signed ISSUE action.
2. Verify its private opening against the resulting public reference.
3. Alter a source artifact and confirm package verification fails.
4. Prepare a fresh replacement package whose supersedes reference names the original.
5. Execute SUPERSEDE and verify old/new lifecycle and predecessor binding.
6. Revoke the replacement and confirm neither version is Active.
7. Replay an earlier signed action and confirm rejection.

Have an unrelated test executor submit a valid signed action first. Confirm it produces exactly the signer's authorized result; a second submission fails without changing that result.

Use caller-supplied local transports. Never contact public networks or place test signer implementations in production browser/account code.

Shut down only test processes started by the harness. Record these as local compatibility results, not Monad deployment or sponsor-integration evidence.
</execute_task>

📦 BUILD TASK #11: Contract deployment script and build artifacts
🛠️ ACTION TYPE: Create

<execute_task>
Create a minimal Foundry deployment script for ProofOfReviewRegistry with no administrator or privileged constructor account.

Keep deployment configuration separate from contract logic. Read any future deployer credential through the permitted runtime environment; never embed it in source, logs or generated manifests.

Provide a local-only deployment/smoke command that refuses non-loopback RPC targets. Do not broadcast to Monad testnet or mainnet in this chapter.

Generate:
- The compiled ABI consumed by the SDK.
- EIP-712 domain/type metadata and fixed cross-language test vectors.
- Compiler, optimizer, EVM-target and dependency-version metadata.
- A reproducible deployment-artifact template for Chapter 6.

A deployment artifact must distinguish local/testnet/mainnet and include observed chain ID, contract address, transaction hash, deployment block and runtime-code hash only when a deployment actually occurred. Leave unknown values absent, not fabricated or zero-filled.

Label all local evidence as local. Do not add placeholder Monad addresses to application configuration or mark readiness verified.

Keep machine-readable artifacts concise. Do not generate an engineering playbook or public deployment instructions.
</execute_task>

📦 BUILD TASK #12: Contract gates, continuity and Chapter 3 completion
🛠️ ACTION TYPE: Validate

<execute_task>
Run contract formatting checks, compilation, authorization/lifecycle tests, bounded fuzz/invariant tests and local Anvil integration tests. Run existing TypeScript checks, Chapter 2 protocol vectors and production application builds.

Add the required contract and compatibility checks to CI using pinned toolchain versions. Do not remove existing gates, skip failing suites or replace verification with successful placeholder commands.

Inspect the final contract surface:
- No owner, upgrade proxy, administrator override or trusted-reviewer allowlist.
- Every execute path requires the correct action signature and current nonce.
- Every mutation is confined to the authorized reviewer.
- No private opening material appears in ABI payloads, events or storage.
- Terminal history remains intact.
- Invalid operations revert atomically.
- The registry and SDK use identical action/domain encodings.

Update docs/build-state.json with contract paths, ABI exports, exact action codes/type string, domain, event order, lifecycle rules, nonce-cancellation behavior, observed checks and blockers. Keep CLAUDE.md compact.

Record integration requirements for later chapters:
- Preserve the encrypted opening before publication.
- Bind explicit human approval to the prepared snapshot and exact typed action.
- Obtain current nonce and chain state before signing; do not blindly resubmit after a race.
- Verify current registry state at an identified block.
- Treat a mined receipt as authorization accepted at execution time; current ERC-1271 policy changes do not retroactively rewrite it.
- Envio must reduce the defined events without double counting and reconcile current status with live reads.

If a toolchain or browser/environment prerequisite blocks a required check, record the limitation without claiming a pass. Mark Chapter 3 complete only after its required checks pass.

Keep public deployment, Mera signing sessions and all remaining chapters pending. Stop here; do not begin Chapter 4.
</execute_task>
```
