# Threat model

What could trick LexAegis or make it leak, what is implemented against each case, and **which test
shows it**. This is an engineering record, not an audit. Passing tests show that a named behaviour
held for the tested source state; they do not show the absence of other faults.

- Scope: the code in this repository and the one Monad testnet registry in
  [`DEPLOYMENTS.md`](./DEPLOYMENTS.md). The hosted demonstration is unaudited, uses synthetic matters
  and is not for client data.
- Hashes bind **bytes**. They do not bind factual truth, completeness or legal correctness.
- Every test reference below is checked by `pnpm threat:check` (the file exists and contains that
  test name). Results are those of the suites in [Observed results](#observed-results).
- `NO TEST YET` means no test exists. `not_run`, `blocked` and `fail` are used when a test exists but
  did not pass. A mitigation marked _planned_ is not implemented.

## Assets

| ID  | Asset                                         | Where it lives                                                                    |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | Private package (documents, facts, decisions) | Browser memory while unlocked; ciphertext in storage                              |
| A2  | Commitment opening (manifest, blinding nonce) | Browser memory while unlocked; ciphertext in storage; a readable export           |
| A3  | Vault key (from the passkey PRF, vault salt)  | Browser memory only, non-extractable                                              |
| A4  | Signing key and signing-session authority     | Browser memory only, for at most ten minutes                                      |
| A5  | Receipt namespace (reviewer, commitment)      | Public registry storage                                                           |
| A6  | Authentication state                          | An opaque HttpOnly session cookie; server session table                           |
| A7  | Provider credentials (Qwen, RPC, storage)     | Server environment only                                                           |
| A8  | Frozen approval snapshot                      | A `RecoverableCapture` rebuilt and verified in this unlock                        |
| A9  | Deployment configuration                      | `contracts/deployments/monad-testnet.json`, generated verifier policy, server env |

## Actors

Reviewer; authorised recipient (verifier); malicious author of a document, package or agent card;
unauthorised caller; executor (anyone who submits a signed action); application operator; compromised
same-origin script or dependency; model provider (Qwen); RPC provider; indexer (Envio).

## Trust boundaries

| Boundary             | Holds                                                                                  | Trusts                                                                        |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Browser, unlocked    | A1–A4, A8 in memory                                                                    | The page origin and every script it runs                                      |
| Browser persistence  | A public account profile and non-secret recovery metadata only                         | Nothing secret may be written                                                 |
| Backend              | A6, A7, session and ciphertext metadata; **selected plaintext during an analysis run** | The operator                                                                  |
| Qwen                 | The selected, consented excerpt of a run                                               | The provider; its logs are outside this repository and unverified             |
| Ciphertext storage   | Encrypted objects and approved metadata                                                | Nothing: content is user-encrypted, but an old snapshot can be served again   |
| Public registry      | A5: reviewer, commitment, status, links, times                                         | Chain consensus, read through an RPC endpoint                                 |
| Envio indexer        | A derived copy of public events                                                        | Nothing: display only, never a source of approval state                       |
| Independent verifier | The files a recipient loads, in memory, locally                                        | **The caller's own** chain, genesis and registry policy, never the file's own |

Two different things are both called "private" and must not be confused. **User-held encryption**
protects stored objects from the operator and the storage provider. **Plaintext intentionally
disclosed for analysis** (the selected excerpt, after an explicit Send) is visible to the backend and
to Qwen for that run. Encryption does not undo that disclosure.

## Abuse cases

Suite tags: **F** Foundry, **U** unit (Vitest), **A** local Anvil integration, **B** scripted browser
check (virtual authenticator, scripted provider and chain).

### Authorisation

#### TM-A01 Replayed signature

- Asset / boundary: A5, registry.
- Preconditions: an attacker holds an action signature that already executed.
- Impact: a second, unapproved transition.
- Mitigation (implemented): one per-reviewer nonce shared by every action; consumed on success.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_replayFailsAfterASuccessfulOperation [F]
  - `contracts/test/Invariants.t.sol` :: invariant_eachSuccessConsumesExactlyOneNonce [F]
  - `contracts/integration/chapter6.anvil.test.ts` :: replaying the signed action is rejected before any signature or fee [A]
- Result: pass.
- Residual risk: none known for the same registry. A signature is public once broadcast.

#### TM-A02 Altered signed field

- Asset / boundary: A5, registry.
- Preconditions: an executor changes the action after the reviewer signed it.
- Impact: a different commitment, action or deadline than was approved.
- Mitigation (implemented): EIP-712 digest over every field; the signature is checked against it.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_changingAnySignedFieldInvalidatesTheAuthorization [F]
  - `contracts/integration/chapter6.anvil.test.ts` :: rejects a changed destination, calldata, fee ceiling, gas limit, digest and an expired quote [A]
- Result: pass.
- Residual risk: none known.

#### TM-A03 Wrong signer, chain, registry or domain

- Asset / boundary: A5, registry.
- Preconditions: a signature made by another key, or for another chain, registry, name or version.
- Impact: cross-deployment or cross-account replay.
- Mitigation (implemented): the domain separator binds name, version, chain and registry address.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_wrongSignerIsRejected [F]
  - `contracts/test/Authorization.t.sol` :: test_wrongDomainInvalidatesTheAuthorization [F]
  - `contracts/test/Authorization.t.sol` :: test_signatureForAnotherRegistryIsNotAccepted [F]
  - `contracts/test/Authorization.t.sol` :: test_domainSeparationFollowsAChainIdChange [F]
  - `apps/web/src/integration/account-flow.test.ts` :: checks review typed data against account, chain, registry and deadline at signing time [U]
- Result: pass.
- Residual risk: none known.

#### TM-A04 Stale nonce or deadline

- Asset / boundary: A5, registry.
- Preconditions: an old or expired authorisation is submitted.
- Impact: an action the reviewer no longer intends.
- Mitigation (implemented): `nonce` must equal the current value; `deadline` must be nonzero and not
  in the past (equality succeeds). Expiry of an instruction never expires an issued receipt.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_exactDeadlineSucceedsAndALaterTimestampFails [F]
  - `contracts/test/Authorization.t.sol` :: test_zeroDeadlineFails [F]
  - `contracts/test/Authorization.t.sol` :: test_anExpiredDeadlineDoesNotExpireAnIssuedReceipt [F]
  - `contracts/test/Authorization.t.sol` :: test_staleInvalidationFailsWithoutAffectingNewerState [F]
  - `apps/web/src/integration/review-signing.test.ts` :: enforces a positive, unexpired deadline no further out than 600 seconds [U]
- Result: pass.
- Residual risk: a signature stays usable until its deadline (at most 600 s in the app) unless the
  reviewer invalidates the nonce.

#### TM-A05 Malicious ERC-1271 validation

- Asset / boundary: A5, registry.
- Preconditions: the reviewer is a contract whose validator reverts, lies, returns malformed data or
  tries to reenter.
- Impact: a forged authorisation or a state change during validation.
- Mitigation (implemented): OpenZeppelin `SignatureChecker` over STATICCALL; only the exact magic
  value is accepted.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_invalidOrAdversarialErc1271ValidationFailsWithoutStateChanges [F]
  - `contracts/test/Authorization.t.sol` :: test_reentrantValidationCannotMutateTheRegistry [F]
  - `contracts/test/Authorization.t.sol` :: test_aSignatureMadeBeforeAPolicyChangeStopsWorkingAfterIt [F]
- Result: pass.
- Residual risk: a contract account authorises whatever its own code accepts; that policy is the
  account's, not the registry's. Local fixtures say nothing about any production wallet.

#### TM-A06 Executor submissions

- Asset / boundary: A5, registry.
- Preconditions: someone other than the reviewer submits a transaction.
- Impact: an unsigned or modified action would be a forgery. **An unrelated executor submitting an
  unchanged, validly signed action is permitted by design and is not a forgery.**
- Mitigation (implemented): `msg.sender` carries no authority; only the reviewer's signature does.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_eoaSignatureAuthorizesAThirdPartySubmission [F]
  - `contracts/test/Authorization.t.sol` :: test_thereIsNoSignatureFreeShortcutForTheReviewer [F]
  - `contracts/test/Authorization.t.sol` :: test_emptyAndMalformedSignaturesAreRejected [F]
  - `contracts/integration/chapter6.anvil.test.ts` :: rejects wrong sender, extra calldata, value, recipient, EIP-7702, fee-cap bypass and wrong nonce [A]
- Result: pass.
- Residual risk: an executor chooses **when** (before the deadline) and **whether** to submit.

#### TM-A07 Nonce-invalidation misuse

- Asset / boundary: A5, registry.
- Preconditions: a caller tries to advance another reviewer's nonce.
- Impact: cancelling someone else's outstanding approval.
- Mitigation (implemented): `invalidateNonce` acts only for `msg.sender` and needs the current value.
- Tests:
  - `contracts/test/Authorization.t.sol` :: test_aRelayerCannotInvalidateAnotherReviewersNonce [F]
  - `contracts/test/Authorization.t.sol` :: test_invalidateNonceCancelsAnOutstandingSignature [F]
  - `contracts/test/Authorization.t.sol` :: test_nonceExhaustionCannotWrapToZero [F]
- Result: pass.
- Residual risk: invalidation is a fee-paying transaction from the reviewer's own account.

### Lifecycle

#### TM-L01 Duplicate commitment

- Asset / boundary: A5.
- Preconditions: a commitment is issued twice by one reviewer.
- Impact: overwritten issuance history.
- Mitigation (implemented): existence is decided by status; a non-`NotFound` record cannot be created.
- Tests:
  - `contracts/test/Lifecycle.t.sol` :: test_duplicateIssueFailsForActiveRevokedAndSupersededRecords [F]
- Result: pass.
- Residual risk: none known.

#### TM-L02 Terminal-state reactivation

- Asset / boundary: A5.
- Preconditions: a revoked or superseded receipt is targeted again.
- Impact: a withdrawn approval appears active.
- Mitigation (implemented): only an Active receipt can change; terminal statuses never leave.
- Tests:
  - `contracts/test/Lifecycle.t.sol` :: test_revokingAReplacementNeverRestoresTheEarlierApproval [F]
  - `contracts/test/Lifecycle.t.sol` :: test_revokeRequiresAnActiveReceipt [F]
  - `contracts/test/Invariants.t.sol` :: invariant_terminalReceiptsNeverReturnToActive [F]
- Result: pass.
- Residual risk: none known.

#### TM-L03 Partial supersession

- Asset / boundary: A5.
- Preconditions: a supersession fails part-way.
- Impact: an old receipt retired without a replacement, or two active members of one pair.
- Mitigation (implemented): one transaction, one nonce, two ordered events; any revert undoes all.
- Tests:
  - `contracts/test/Lifecycle.t.sol` :: test_supersedeReplacesAtomicallyWithLinksAndOrderedEvents [F]
  - `contracts/test/Lifecycle.t.sol` :: test_rejectedOperationsRollBackStorageNonceAndLogs [F]
  - `contracts/test/Invariants.t.sol` :: invariant_supersessionLinksAgree [F]
- Result: pass.
- Residual risk: a plain ISSUE of a package that declares a predecessor is accepted by the chain;
  only verification reports `PREDECESSOR_MISMATCH` (SPEC discrepancy D3).

#### TM-L04 Cross-reviewer namespace change

- Asset / boundary: A5.
- Preconditions: reviewer B uses reviewer A's public commitment bytes.
- Impact: squatting on or altering A's record.
- Mitigation (implemented): storage is keyed by reviewer first.
- Tests:
  - `contracts/test/Lifecycle.t.sol` :: test_anotherReviewerMayUseIdenticalCommitmentBytes [F]
  - `contracts/test/Lifecycle.t.sol` :: testFuzz_reviewerNamespacesAreIsolated [F]
- Result: pass.
- Residual risk: none known.

### Packages and the vault

#### TM-P01 Tampered or substituted package

- Asset / boundary: A1, A2; verifier.
- Preconditions: a recipient is handed changed files, or a wholly rebuilt bundle.
- Impact: the recipient believes different bytes were approved.
- Mitigation (implemented): every artifact's exact bytes are hashed into the manifest; the manifest
  opens the commitment; the reference is supplied independently.
- Tests:
  - `packages/protocol/src/v1/verify.test.ts` :: detects altered bytes in any artifact and names only its opaque ID [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: a changed file with a rewritten, internally consistent manifest does not match the original reference [U]
  - `packages/sdk/src/verification/export.test.ts` :: a bundle rewritten consistently is caught only by the independent reference [U]
  - `apps/verifier/src/verification-job.test.ts` :: uses an independently supplied reference and catches a wholly replaced bundle [U]
  - `contracts/integration/sdk-readme.anvil.test.ts` :: a substituted bundle is caught by the independent reference on the real chain [A]
- Result: pass.
- Residual risk: none for byte identity. Content truth is out of scope.

#### TM-P02 Incomplete evidence

- Asset / boundary: A1; verifier.
- Preconditions: files are missing, extra or reordered.
- Impact: a partial package is read as the approved one.
- Mitigation (implemented): missing is `unknown`, never a match; extra files are rejected.
- Tests:
  - `packages/protocol/src/v1/verify.test.ts` :: treats missing files as unknown, not as a mismatch and not as a match [U]
  - `packages/protocol/src/v1/verify.test.ts` :: rejects uncommitted extra files instead of treating them as approved evidence [U]
  - `packages/protocol/src/portable/review-export.test.ts` :: rejects a missing, extra, duplicate or reordered artifact entry [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: reference-only and manifest-only can never report artifact integrity as a match [U]
- Result: pass.
- Residual risk: a reviewer can approve a package that omits a relevant document. Completeness of the
  underlying matter is not provable.

#### TM-P03 Untrusted expected reference

- Asset / boundary: verifier.
- Preconditions: the only reference is the one inside the file being checked.
- Impact: a self-consistent forgery passes.
- Mitigation (implemented): results say whether the reference was `independent` or `file-declared`;
  the trusted chain, genesis and registry come from caller configuration.
- Tests:
  - `packages/protocol/src/v1/verify.test.ts` :: requires the caller’s expected reference and never trusts the opening’s own claims [U]
  - `apps/verifier/src/controller.test.ts` :: keeps the independent reference separate; a mismatch is never resolved by the file [U]
  - `apps/verifier/src/components/ResultSection.test.tsx` :: states that a file-declared reference is not an independent expectation [U]
  - `contracts/integration/cli.anvil.test.ts` :: exit 20: wrong chain, wrong registry code and an empty registry are identity failures, never statuses [A]
- Result: pass.
- Residual risk: a recipient who skips the independent reference gets a self-check only, and is told.

#### TM-P04 Vault corruption

- Asset / boundary: A1, A2, A8; ciphertext storage.
- Preconditions: storage returns modified, swapped or truncated objects.
- Impact: a corrupted capture is signed, or plaintext is partly accepted.
- Mitigation (implemented): AES-256-GCM with binding to owner, vault, rpId and object ID; read-back
  before the catalog moves; a capture is ready only after retrieval and verification in this unlock.
- Tests:
  - `packages/vault/src/crypto/browser-crypto.test.ts` :: a flipped ciphertext or tag byte fails [U]
  - `packages/vault/src/crypto/browser-crypto.test.ts` :: swapped owner, vault, rpId and object ID are caught by the binding [U]
  - `packages/vault/src/vault.test.ts` :: a modified or swapped object blocks readiness [U]
  - `apps/web/src/integration/vault-flow.test.ts` :: damage after upload is caught by the read-back before the catalog moves [U]
- Result: pass.
- Residual risk: availability. Storage can withhold or delete ciphertext.

#### TM-P05 Vault rollback

- Asset / boundary: A1, A2; ciphertext storage.
- Preconditions: storage serves an older, validly encrypted snapshot.
- Impact: later edits or decisions silently disappear.
- Mitigation (implemented): revisions chain to the previous digest; regression against a head this
  session already observed is detected.
- Tests:
  - `packages/vault/src/vault.test.ts` :: detects regression against a head already observed [U]
  - `apps/web/src/integration/vault-flow.test.ts` :: detects storage serving an older head than one already observed [U]
- Result: pass.
- Residual risk: **a fresh browser that has never seen the newer head cannot detect a replayed old
  snapshot.** No external monotonic counter exists.

### Model and context

#### TM-M01 Prompt injection in a document

- Asset / boundary: A1, A8; backend and Qwen.
- Preconditions: a document contains text written as instructions.
- Impact: the assistant approves, signs, discloses or changes review state.
- Mitigation (implemented): the model proposes, code decides. No tool approves, signs, fetches a URL
  or confirms a fact; document text is data.
- Tests:
  - `apps/web/src/features/documents/pipeline.test.ts` :: prompt-injection text in a PDF is plain data and confirms nothing [U]
  - `apps/web/src/features/assistant/controller.test.ts` :: an injected instruction in the selected text changes no approval, vault or review state [U]
  - `apps/web/src/server/assistant/scripted-http.test.ts` :: refuses the signing tool an injected instruction asks for, and changes nothing [U]
  - `packages/agent/src/runtime/run-agent.hardening.test.ts` :: cannot obtain signing, URL fetching, rule changes, secrets or fact confirmation as a tool [U]
- Result: pass. The provider in these tests is scripted; no claim is made about live model behaviour.
- Residual risk: injected text can still bias the **wording** of an answer the reviewer reads.

#### TM-M02 Injection through tool output or arguments

- Asset / boundary: backend.
- Preconditions: tool output or model-chosen arguments try to widen a tool.
- Impact: access to another account, matter, URL or secret.
- Mitigation (implemented): closed tool schemas; an allowlist per intent; prose is never a tool call.
- Tests:
  - `packages/agent/src/runtime/run-agent.hardening.test.ts` :: cannot widen a real tool: arguments naming a URL, account, rule state or confirmation are refused [U]
  - `packages/agent/src/runtime/run-agent.hardening.test.ts` :: does not treat prose or pseudo-XML that describes a tool call as a tool call [U]
  - `packages/agent/src/runtime/tools.test.ts` :: rejects arguments that try to choose an account, matter, URL or secret [U]
- Result: pass.
- Residual risk: as TM-M01.

#### TM-M03 Unselected-source disclosure

- Asset / boundary: A1; backend and Qwen.
- Preconditions: a run sends more than the reviewer selected.
- Impact: plaintext disclosed without consent.
- Mitigation (implemented): consent is bound to the exact disclosure and provider; excerpts are read
  only through `read_sources` from the consented catalog; a change needs renewed consent.
- Tests:
  - `apps/web/src/features/assistant/selected-context.test.ts` :: sends only the selected excerpt for an explanation, with no facts or client status [U]
  - `apps/web/src/features/assistant/selected-context.test.ts` :: needs renewed consent after a fact, source, provider or vault change [U]
  - `packages/agent/src/runtime/run-agent.test.ts` :: rejects a request whose consent does not cover its exact content or provider [U]
  - `packages/agent/src/runtime/tools.test.ts` :: read_sources returns only consented catalog excerpts with coverage [U]
  - `tooling/scripts/assistant-browser-check.ts` :: the request carried the selected excerpt and consent, and not the rest of the document [B]
- Result: pass.
- Residual risk: what was selected and sent **is** disclosed, and Stop cannot recall it.

#### TM-M04 Cross-matter context leakage

- Asset / boundary: A1; browser and backend.
- Preconditions: a late or misbound event from another matter, version or account arrives.
- Impact: one matter's content shown or saved in another.
- Mitigation (implemented): events carry run, matter, version, snapshot and sequence; mismatches are
  dropped; consent is matter-bound.
- Tests:
  - `apps/web/src/features/assistant/controller.test.ts` :: drops events bound to another snapshot, generation, matter or version [U]
  - `packages/agent/src/contracts/assistant.test.ts` :: requires consent bound to the same matter and version, and never invents a document [U]
  - `apps/web/src/features/review/decisions.test.ts` :: clears everything on a matter change and ignores a disposition made for another account [U]
- Result: pass.
- Residual risk: none known in this code path. Provider-side retention is unverified.

### Same-origin compromise and rendering

#### TM-W01 XSS or a compromised dependency reaching an unlocked session

- Asset / boundary: A1–A4, A8; browser, unlocked.
- Preconditions: attacker script runs on the application origin while the vault or signing session is
  unlocked.
- Impact: **full access to unlocked material: it can read plaintext and use the live signer.**
- Mitigation (implemented): a nonce-based CSP with `strict-dynamic`, no inline or eval scripts,
  `connect-src 'self'`, no framing; keys in memory only and non-extractable; short sessions.
- Tests:
  - `tooling/scripts/account-browser-check.ts` :: CSP uses a nonce with strict-dynamic and no unsafe-inline or unsafe-eval [B]
  - `packages/vault/src/crypto/browser-crypto.test.ts` :: keeps the key non-extractable and never exposes a handle [U]
  - `apps/web/src/integration/account-flow.test.ts` :: exposes no signer, session or raw signing method on the controller or its snapshot [U]
- Result: pass for the controls named. **NO TEST YET** for a dependency-compromise scenario.
- Residual risk: **not mitigated.** These controls reduce injection; they do not isolate memory. An
  application session is not hardware isolation.

#### TM-W02 Malicious filenames and labels

- Asset / boundary: browser, verifier, CLI.
- Preconditions: a filename, title or artifact label carries markup, a path or control characters.
- Impact: script execution, a misleading display or a path write.
- Mitigation (implemented): labels are rendered as escaped text; export names never come from titles.
- Tests:
  - `apps/verifier/src/components/ResultSection.test.tsx` :: renders untrusted labels as inert escaped text, with no link or markup [U]
  - `packages/vault/src/vault.test.ts` :: safe file names never come from titles or paths [U]
  - `packages/cli/src/output.test.ts` :: escapes control, format and bidirectional characters [U]
  - `packages/vault/src/ports.test.ts` :: rejects content hashes, titles or filenames smuggled into public metadata [U]
- Result: pass.
- Residual risk: visually confusable characters that are neither control nor bidirectional.

#### TM-W03 Model output rendered as markup

- Asset / boundary: browser.
- Preconditions: model output contains HTML, links or instructions.
- Impact: script execution or a deceptive control.
- Mitigation (implemented): output is validated into typed blocks and shown as plain text.
- Tests:
  - `packages/agent/src/runtime/validate-output.test.ts` :: keeps generated text as inert plain text [U]
  - `packages/agent/src/runtime/run-agent.hardening.test.ts` :: cannot smuggle approval, persistence or an unlisted action through the final answer [U]
- Result: pass.
- Residual risk: persuasive but wrong prose. The reviewer's own disposition is still required.

#### TM-W04 Malicious agent card (Chapter 16, implemented branch)

- Asset / boundary: verifier CLI, application card route.
- Preconditions: the registered card address points at a private host, redirects, is oversized or
  carries markup.
- Impact: server-side request forgery, resource exhaustion or a deceptive display.
- Mitigation (implemented): opt-in only; https; caller allowlist; no redirects; 5 s and 32 KiB while
  reading; private and reserved hosts refused; the CLI connects to the validated address; inert
  projection.
- Tests:
  - `packages/sdk/src/agent-identity/card.test.ts` :: refuses loopback, private, link-local, metadata, reserved and mapped forms [U]
  - `packages/sdk/src/agent-identity/card.test.ts` :: refuses redirects and failure statuses with no hidden second request [U]
  - `packages/sdk/src/agent-identity/card.test.ts` :: enforces the size limit while reading, regardless of what a header claimed [U]
  - `packages/sdk/src/agent-identity/card.test.ts` :: treats markup and instructions as inert text, caps display and marks truncation [U]
  - `packages/cli/src/identity-sidecar.test.ts` :: fetches the card only when asked, only from the allowed origin, and a card failure leaves the registry observation [U]
- Result: pass. **These are transport-stub tests. No live card was fetched and no agent is registered.**
- Residual risk: card contents are self-declared and never verified.

### Chain reads and the indexer

#### TM-C01 False RPC response

- Asset / boundary: A5, A9; RPC provider.
- Preconditions: the endpoint returns invented or inconsistent data.
- Impact: a wrong lifecycle status is shown.
- Mitigation (implemented): chain ID, genesis hash, deployment block and runtime code hash are checked
  before a status is read; reads use one checkpoint (finalized minus the delay) and its hash is
  rechecked.
- Tests:
  - `packages/sdk/src/verification/adversarial.test.ts` :: a block whose hash changes between reads is rejected, not accepted [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: an unknown status enum value is unknown, never active or not_found [U]
  - `packages/sdk/src/registry/live-reader.test.ts` :: is unknown when the selected block changes during the read group (reorganisation) [U]
- Result: pass.
- Residual risk: **a single endpoint that lies consistently is believed.** Reads are not light-client
  proofs.

#### TM-C02 Unavailable RPC

- Asset / boundary: RPC provider.
- Preconditions: the endpoint is down, slow or refuses historical reads.
- Impact: "not found" shown for a receipt that exists.
- Mitigation (implemented): a failed read is `unknown`; `not_found` needs a validated record.
- Tests:
  - `packages/sdk/src/registry/live-reader.test.ts` :: never reports not_found when the read failed or the deployment does not match [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: a node that refuses historical reads leaves the status unknown instead of falling back to latest [U]
  - `packages/sdk/src/verification/export.test.ts` :: keeps local integrity results when the RPC is unavailable and never reads unknown as not_found [U]
- Result: pass.
- Residual risk: availability.

#### TM-C03 Wrong deployment identity

- Asset / boundary: A9.
- Preconditions: a look-alike contract, another chain, or a registry address taken from the file.
- Impact: status read from an attacker's contract.
- Mitigation (implemented): the deployment policy is caller-supplied and pinned to genesis and code.
- Tests:
  - `packages/sdk/src/registry/live-reader.test.ts` :: refuses a reference for a different registry [U]
  - `packages/sdk/src/registry/live-reader.test.ts` :: is unknown, not a fallback, without a finalized block, on the wrong chain or before deployment [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: a wrong protocol version is an identity mismatch [U]
  - `contracts/integration/interface-abi.test.ts` :: the runtime bytecode and ABI hashes equal both recorded baselines (metadata included) [A]
- Result: pass. Source-to-bytecode comparison of the live registry is recorded in
  [`DEPLOYMENTS.md`](./DEPLOYMENTS.md).
- Residual risk: as TM-C01.

#### TM-C04 Indexer lag or reorganisation

- Asset / boundary: Envio.
- Preconditions: the index is behind, wrong or rolled back.
- Impact: stale history read as current approval state.
- Mitigation (implemented): history is display only, labelled with availability, freshness and
  consistency; approval reads the registry directly.
- Tests:
  - `apps/web/src/features/history/controller.test.ts` :: cannot affect any transaction state: it exposes no write capability [U]
  - `apps/web/src/features/history/controller.test.ts` :: labels every indexer state in text [U]
  - `apps/web/src/server/history/history.test.ts` :: separates a rollback inside the window from one beyond it [U]
  - `contracts/integration/indexer-rollback.anvil.test.ts` :: removes an orphaned ISSUE and restores nonce and counters when another branch wins [A]
- Result: pass.
- Residual risk: a reader who ignores the freshness label.

#### TM-C05 Stale success indicator

- Asset / boundary: browser.
- Preconditions: an earlier result is still on screen after the input, policy or account changed.
- Impact: a result is attributed to the wrong input.
- Mitigation (implemented): results carry a generation; late results are dropped; saved, signed,
  confirmed, indexed and active are separate readings.
- Tests:
  - `packages/sdk/src/verification/adversarial.test.ts` :: a result for an older generation is distinguishable from the current one [U]
  - `apps/verifier/src/local-job.test.ts` :: turns a worker crash into a typed failure and ignores results for another generation [U]
  - `apps/web/src/features/workspace/readiness.test.ts` :: keeps indexer and lifecycle separate from approval readiness [U]
- Result: pass.
- Residual risk: none known.

### Human approval

#### TM-H01 Misleading approval screen

- Asset / boundary: A4, A8; browser.
- Preconditions: the screen shows one action while another is signed.
- Impact: the reviewer signs something they did not see.
- Mitigation (implemented): the preview is built from the verified capture; signing consumes exactly
  the previewed action; a changed nonce invalidates the preview.
- Tests:
  - `apps/web/src/integration/approval-flow.test.ts` :: previews the exact action from the verified package and signs only on a trusted approval [U]
  - `apps/web/src/integration/approval-flow.test.ts` :: invalidates the preview when the nonce changes before approval; nothing is signed [U]
  - `apps/web/src/integration/review-signing.test.ts` :: signs exactly the previewed action with the Mera-backed account [U]
  - `tooling/scripts/hud-browser-check.ts` :: the preview names account, network, registry, commitment, scope and the reviewer’s own words [B]
- Result: pass.
- Residual risk: TM-W01: a same-origin script can draw anything.

#### TM-H02 Mutable bytes after freeze

- Asset / boundary: A8.
- Preconditions: package bytes change between freeze and signing.
- Impact: the commitment signed differs from the files reviewed.
- Mitigation (implemented): the capture is immutable and rebuilt by read-back; inputs are copied.
- Tests:
  - `apps/web/src/integration/vault-flow.test.ts` :: later working-context edits cannot change the frozen capture [U]
  - `apps/web/src/integration/review-signing.test.ts` :: copies inputs: mutating the request after confirming cannot change what is signed [U]
  - `packages/vault/src/vault.test.ts` :: the recoverable-capture gate cannot be forged, replayed under another account, or serialized [U]
  - `apps/web/src/integration/approval-flow.test.ts` :: refuses without a capture verified in this unlock, or for a commitment it never saw [U]
- Result: pass.
- Residual risk: none known.

#### TM-H03 Session misuse

- Asset / boundary: A3, A4, A6.
- Preconditions: a vault unlock or a backend session is used as signing authority, or a session
  outlives its limits.
- Impact: signing without a fresh, intended approval.
- Mitigation (implemented): vault unlock is not a signing session; one-use tickets; idle and absolute
  limits checked at signing time; lock ends signing.
- Tests:
  - `apps/web/src/integration/review-signing.test.ts` :: consumes a ticket once [U]
  - `apps/web/src/integration/review-signing.test.ts` :: rejects a look-alike ticket, a copy and a caller-supplied approved flag [U]
  - `apps/web/src/integration/review-signing.test.ts` :: dies with lock, cancel, account switch and expiry [U]
  - `apps/web/src/integration/account-flow.test.ts` :: checks limits at signing time, not only on timers (resume after suspension) [U]
- Result: pass.
- Residual risk: TM-W01 within a live session.

#### TM-H04 Cancelled or stale callbacks

- Asset / boundary: browser.
- Preconditions: a ceremony, read or tool finishes after Cancel, lock or an input change.
- Impact: a late result acts as if still wanted.
- Mitigation (implemented): generation checks; results after cancellation are discarded.
- Tests:
  - `apps/web/src/integration/account-flow.test.ts` :: discards a ceremony that finishes after Cancel [U]
  - `apps/web/src/integration/approval-flow.test.ts` :: discards the signature if the account locks while signing [U]
  - `packages/agent/src/runtime/tools.test.ts` :: does nothing once cancelled and discards a result finished after cancellation [U]
  - `apps/web/src/features/workspace/stop.test.ts` :: stops every active part and nothing else [U]
- Result: pass.
- Residual risk: none known.

#### TM-H05 Already disclosed signatures and broadcasts

- Asset / boundary: A4, A5.
- Preconditions: the reviewer presses Stop after a signature left the device or a transaction was
  sent.
- Impact: belief that the action was undone.
- Mitigation (implemented): the interface never claims to retract; cancelling is the separate,
  fee-paying nonce invalidation.
- Tests:
  - `apps/web/src/features/workspace/stop.test.ts` :: does not claim to cancel a transaction that may already be sent [U]
  - `apps/web/src/features/workspace/stop.test.ts` :: keeps a signed approval signature rather than pretending to retract it [U]
  - `apps/web/src/features/transactions/controller.test.ts` :: Stop before sending cancels and kills tickets; after sending it cannot cancel the transaction [U]
- Result: pass.
- Residual risk: **Stop cannot recall disclosed plaintext or signatures, and cannot reverse a
  broadcast transaction.**

### Disclosure

#### TM-D01 Plaintext or secrets in bundles

- Asset / boundary: A7; browser assets and packages.
- Preconditions: a server secret, test signer or private fixture is bundled for the browser or packed
  into a published package.
- Impact: credential or private-data exposure to every visitor.
- Mitigation (implemented): public configuration is an allowlist; a production-exclusion scan over
  built output and import graphs; a secret scan.
- Tests:
  - `apps/web/src/config/public.test.ts` :: exposes only the allowlisted values and never spreads the environment [U]
  - `tooling/src/exclusion.test.ts` :: rejects a production entry that imports the test signer or the replay provider [U]
  - `tooling/src/exclusion.test.ts` :: catches a caller-supplied literal such as the registry fixture key, without echoing it [U]
  - `tooling/scripts/hud-browser-check.ts` :: client bundles hold no provider credential, server secret or injected-wallet code [B]
- Result: pass. Canary-based checks of the built assets: see Task 9 in
  [`security/privacy-checks.md`](./security/privacy-checks.md).
- Residual risk: a secret in an encoding the scans do not look for.

#### TM-D02 Secrets or plaintext in persistence

- Asset / boundary: A1–A4; browser persistence.
- Preconditions: code writes a key, PRF output or matter text to browser storage.
- Impact: exposure to later scripts, other users of the device and backups.
- Mitigation (implemented): keys, PRF outputs and sessions stay in memory; storage holds a public
  profile and non-secret recovery metadata.
- Tests:
  - `apps/web/src/integration/account-flow.test.ts` :: keeps PRF output and key material out of snapshots, hints, tab messages, requests and responses [U]
  - `tooling/scripts/account-browser-check.ts` :: browser storage holds only the public account profile [B]
  - `tooling/scripts/vault-browser-check.ts` :: browser storage holds no matter text [B]
  - `tooling/scripts/assistant-browser-check.ts` :: nothing of the conversation is in localStorage, sessionStorage, IndexedDB, caches or service workers [B]
- Result: pass.
- Residual risk: memory inspection on a compromised device; browser crash dumps.

#### TM-D03 Plaintext or secrets in logs and telemetry

- Asset / boundary: A1, A7; backend.
- Preconditions: a request, response or error is logged with its content.
- Impact: plaintext in operator logs.
- Mitigation (implemented): logs carry event names and codes only; credential-bearing URLs are
  redacted.
- Tests:
  - `apps/web/src/server/assistant/routes.test.ts` :: logs event names and codes only, never request or response content [U]
  - `apps/web/src/server/chain/chain.test.ts` :: redacts the path and query that carry the API key [U]
  - `apps/web/src/server/env.test.ts` :: rejects malformed supplied values and reports names only [U]
- Result: pass.
- Residual risk: **provider, hosting and infrastructure logs are outside this repository and are
  unverified.**

#### TM-D04 Private data in URLs

- Asset / boundary: A1, A2.
- Preconditions: private values are placed in a path or query.
- Impact: leakage through history, referrers and access logs.
- Mitigation (implemented): private data travels only in same-origin POST bodies; RPC endpoints with
  credentials, queries or fragments are refused.
- Tests:
  - `apps/web/src/features/assistant/api-client.test.ts` :: sends private data only in a same-origin POST body, never in a URL [U]
  - `apps/web/src/features/history/controller.test.ts` :: puts only public values in URLs [U]
  - `packages/sdk/src/registry/rpc-client.test.ts` :: accepts a public HTTPS endpoint and nothing that could carry a credential [U]
  - `tooling/scripts/assistant-browser-check.ts` :: private data never travels in a URL [B]
- Result: pass.
- Residual risk: none known.

#### TM-D05 Exports

- Asset / boundary: A1, A2.
- Preconditions: an export is produced without the reviewer understanding what it contains.
- Impact: unintended disclosure of the whole package and its opening.
- Mitigation (implemented): a disclosure preview, then one explicit Download; nothing is uploaded.
- Tests:
  - `apps/web/src/integration/vault-flow.test.ts` :: shows a disclosure preview first and releases the readable file only on confirmation, once [U]
  - `packages/vault/src/vault.test.ts` :: context export is limited to saved context, and imports arrive unconfirmed with provenance [U]
- Result: pass.
- Residual risk: **a readable export is plaintext. Whoever receives it can read and forward it.**

#### TM-D06 Unintended network destinations

- Asset / boundary: A1, A2; browser, verifier, CLI.
- Preconditions: code contacts a host other than the ones the user chose.
- Impact: private data or metadata reaches a third party.
- Mitigation (implemented): `connect-src 'self'` in the application; the verifier's CSP lists only
  the selected registry endpoints; the SDK calls fetch only in its RPC transport.
- Tests:
  - `packages/sdk/src/boundaries.test.ts` :: calls fetch only from the explicit RPC transport [U]
  - `apps/verifier/src/independence.test.ts` :: calls no LexAegis API, reads no backend configuration and uses no persistent storage [U]
  - `tooling/scripts/verifier-browser-check.ts` :: every attempted request went only to the verifier origin or the selected RPC [B]
  - `tooling/scripts/verifier-browser-check.ts` :: a malicious URL in the file never triggered a request [B]
  - `tooling/scripts/vault-browser-check.ts` :: requests to the vault carry no plaintext [B]
- Result: pass.
- Residual risk: what the **server** sends to Qwen is asserted against a scripted provider, not
  observed at the real one.

### Public linkability

#### TM-X01 Address, timing and receipt-history linkability

- Asset / boundary: A5; public registry.
- Preconditions: anyone reads the chain.
- Impact: a reviewer's account, activity times, count of receipts and replacement links are public
  and permanent.
- Mitigation (implemented): only the commitment and lifecycle are public; the blinding nonce hides
  package contents; nothing private is in storage, events or errors.
- Tests:
  - `apps/web/src/features/history/controller.test.ts` :: copies only the five public reference fields [U]
  - `packages/sdk/src/verification/adversarial.test.ts` :: reports opaque identifiers and codes only [U]
- Result: pass for what is published. **NO TEST YET**, and none planned, for unlinkability: it is not
  a property of this design.
- Residual risk: **not mitigated.** One account links all of a reviewer's receipts.

#### TM-X02 Full-package disclosure to a verification recipient

- Asset / boundary: A1, A2.
- Preconditions: a reviewer gives a recipient the export so they can verify it.
- Impact: the recipient sees every file and the opening.
- Mitigation (implemented): none beyond the disclosure preview (TM-D05). Selective disclosure and
  redaction proofs are non-goals of v1.
- Tests:
  - `packages/protocol/src/v1/verify.test.ts` :: redacted bytes do not verify as the original artifact [U]
- Result: pass (this shows redaction breaks verification, which is the limitation).
- Residual risk: **not mitigated.** Verification of files requires disclosing them.

### Agent identity (Chapter 16, implemented branch only)

#### TM-I01 Identity mistaken for authority, and the disabled state

- Asset / boundary: A5 is unaffected; application, verifier, CLI.
- Preconditions: a reader treats an ERC-8004 record as proof of who reviewed, of the model, or of a
  qualification; or the optional path is off or unavailable.
- Impact: misplaced trust; or a blocked core path.
- Mitigation (implemented): identity is a separate, read-only sidecar that never changes a proof
  result or exit code; with the feature off there is no control and no request; no code path
  registers or gives feedback.
- Tests:
  - `apps/verifier/src/identity.test.ts` :: is inert when the feature is off: no check is possible and no request is made [U]
  - `apps/verifier/src/identity.test.ts` :: malformed identity data in hash-correct bytes leaves the proof result untouched [U]
  - `packages/cli/src/identity-sidecar.test.ts` :: without the option the JSON is exactly the Chapter 15 document; with it, a versioned envelope around the unchanged core [U]
  - `apps/web/src/features/identity/no-feedback.test.ts` :: no runtime source can submit feedback, register, or call a write method of the registries [U]
  - `packages/sdk/src/agent-identity/agent-identity.test.ts` :: sends only public parameters over RPC and only read methods [U]
- Result: pass. **No agent is registered and no card is hosted; registry answers in these tests come
  from a scripted node.** The only live observations are the read-only probes in
  [`erc8004-availability.md`](./erc8004-availability.md).
- Residual risk: a registry record is discovery only. It is not the approving reviewer, not the model
  identity and not a legal qualification.

## Residual risks, stated plainly

1. A script running on the application origin can read unlocked plaintext and use a live signing
   session. An application session is not hardware isolation.
2. Stop cannot recall plaintext already sent to the backend or Qwen, a signature already disclosed,
   or a transaction already broadcast.
3. A single RPC endpoint can lie consistently. Registry reads are not consensus proofs.
4. An encrypted old vault snapshot can be replayed to a browser that never saw a newer one.
5. Public receipt activity is linkable to one account and is permanent.
6. Verifying files means disclosing them to the recipient.
7. Selected plaintext is visible to the analysis backend and to Qwen for that run.
8. A passkey is bound to its origin and authenticator. Losing every authenticator loses the account
   and the vault key.
9. Hashes bind bytes, not factual truth, completeness or legal correctness. Approval is by a signing
   account, not proof of a professional qualification.

## Observed results

Filled in from the runs recorded in `docs/build-state.json` (`chapter17.checks`).

| Suite | Command                                                                                                                  | Observed             | Outcome |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------- |
| F     | `pnpm contracts:test`                                                                                                    | 2026-10-11, 1f1c185  | pass    |
| U     | `pnpm test`                                                                                                              | 2026-10-11, 342b491  | pass    |
| A     | `pnpm test:contracts:integration`                                                                                        | NOT YET this chapter | not_run |
| B     | `pnpm test:account:browser`, `test:vault:browser`, `test:assistant:browser`, `test:hud:browser`, `test:verifier:browser` | NOT YET this chapter | not_run |
