## Chapter 12 — End-to-End Recovery, Privacy and Security Validation

This chapter checks the complete journey: recovering your files, using Aegis, approving a review, recording it on Monad and checking it independently. It adds tests for wrong accounts, tampered files, interrupted transactions and accidental data leaks. It keeps automated results separate from real-device checks, protects saved login details in test evidence, and records exactly what still needs fixing. Passing these checks is not an independent security audit.

```text
📦 BUILD TASK #1: docs/build-state.json and Chapter 12 integration contract
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#16 sequentially through repository edits. Produce executable tests, minimal corrective code, closed schemas and compact factual evidence. Omit conversational fluff, engineering playbooks, full-file echoes and terminal JSON status-report payloads. Preserve unrelated changes.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and the relevant implemented interfaces from Chapters 2–11. Reuse existing Vitest, Playwright, Foundry/Anvil, PostgreSQL and S3-compatible test tooling. Extend existing tests instead of creating a second validation framework.

Preserve protocol v1, account derivation, PRF namespaces, vault formats, explicit disclosure, human approval, transaction policies and independent-verifier trust distinctions. Missing prerequisites remain blocked; never implement a mock success path to make the integrated journey pass.

Inspect installed APIs and consult current primary guidance only where needed:
https://playwright.dev/docs/auth
https://playwright.dev/docs/network
https://www.w3.org/TR/webauthn-3/#prf-extension
https://nextjs.org/docs/app/guides/content-security-policy
https://owasp.org/projects/asvs
https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
https://github.com/OWASP/www-project-top-10-for-large-language-model-applications/blob/main/2_0_vulns/LLM01_PromptInjection.md

Target the existing MVP's concrete trust boundaries, not an exhaustive compliance programme. No new authentication system, model/provider, cryptography, chain, product feature or infrastructure service. Do not deploy, publish packages, submit bounty materials or begin Chapter 13.
</execute_task>

📦 BUILD TASK #2: tests/system harness, safety guards and case manifest
🛠️ ACTION TYPE: Create

<execute_task>
Create a thin system-test harness in the repository's established test location. Use synthetic matters/accounts, existing literal protocol vectors and deterministic provider/RPC fault adapters. Run actual application controllers, routes, cryptography and registry code wherever those boundaries are under test.

Default to isolated local services and an explicit loopback Anvil deployment. Validate endpoint, database/bucket test namespace, actual chain identity and test mode before setup or cleanup. Refuse public-chain mutations, production datasets, wildcard deletion and user-browser cleanup in default tests. Do not inherit unrelated credentials or start a public-network fork.

Give each run/worker an isolated namespace; serialize tests that deliberately share an account or nonce. Cleanup may remove only exact resources created and recorded by that run. Never delete passkeys, unrelated cookies, user files or an entire shared database/bucket. Missing services produce a typed blocked result, not an in-memory production fallback.

Define a closed SystemCaseV1 manifest with stable case ID, owning test, invariant, required evidence class and required-for-MVP flag. Define result records with case ID, pass|fail|blocked|not_run, unit|local_integration|browser_scripted|live_read|live_human evidence class, observed configuration/version, actual times, safe evidence paths and issue codes.

Separate per-case status from environment readiness. Missing/skipped/blocked required cases cannot become pass. Store synthetic evidence under a dedicated ignored output directory; generate only sanitised summaries for durable build records.

Use controlled clocks and explicit asynchronous barriers for race tests; use bounded condition polling rather than long sleeps. Network faults belong in test-only adapters/proxies, never production query flags. Keep deterministic randomness and synthetic signing adapters excluded from production exports. Never demand deterministic model text or replace production CSPRNG output with a seed.
</execute_task>

📦 BUILD TASK #3: tests/system/full-review-journey.spec.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement one complete synthetic browser journey using the real web application, local storage services, local registry, SDK and independently served verifier. Reuse Chapter 8's source/fact fixtures and Chapter 9's scripted provider; label that provider and any authenticator adapter as simulated.

Exercise: account access -> explicit vault unlock -> select source/version -> inspect disclosure -> Send to Aegis -> open an exact citation -> confirm required facts -> run deterministic checks -> record human dispositions -> freeze -> encrypted save/read-back -> exact action approval -> exact fee confirmation -> local broadcast -> confirmed observation -> readable export -> independent verification.

Perform review and confirmation through rendered controls. Do not prepopulate approval tickets, set approved/persisted flags, call private signing functions from page evaluation or replace UI gates with direct API writes. A test authenticator adapter may supply credential behaviour but must not manufacture human-review state.

Assert original artifact bytes, manifest, opening and complete receipt reference remain consistent across capture, storage, transaction and export. Independently supplied expected references must drive verifier assertions. Check displayed calculation values against the existing integer arithmetic oracle, not assistant prose.

Verify every prerequisite transition: saved is not approved; signed is not issued; broadcast is not confirmed; confirmed issue is not proof of current Active lifecycle; indexed is not live-verified. Assert Aegis, human decisions and public receipts occupy their correct activity views.

Exercise both Command-centre and Review modes without losing the selected source while unlocked. Capture only synthetic, sanitised UI evidence. A local journey proves integrated behaviour, not Mera hardware support, Monad timing, live Qwen quality or sponsor eligibility.
</execute_task>

📦 BUILD TASK #4: tests/system/account-and-vault-recovery.spec.ts
🛠️ ACTION TYPE: Create

<execute_task>
Extend account/vault recovery tests around the unchanged lexaegis.evm.bip32-prf.v1 profile, account/vault PRF salts, derivation path and configured rpId. Confirm no chain, registry or cached address enters key derivation. No new recovery secret or credential substitution.

Save synthetic matter context and an exact frozen review through real encrypted storage. End the application session; clear only the test origin's browser storage/cookies while retaining the test credential. Recover through discoverable credential selection, fresh backend authentication and explicit vault unlock without cached vault IDs, salts, object references or transaction state.

Require the same derived reviewer, authenticated owner, decrypted artifact bytes and original commitment. A matching displayed address alone is insufficient. Reconstruct recoverable-capture authority through retrieval/decryption/verification; never restore an old approval ticket.

Test wrong credential/account/rpId, absent or unsupported PRF, cancelled ceremonies, corrupted cached hints, missing ciphertext, failed authentication tags, expired backend sessions and storage outage. No failure may create a replacement vault, overwrite ciphertext, silently register another passkey or display an outage as an empty vault.

Check separate signing/vault 10-minute absolute and 5-minute idle limits, and 15-minute backend expiry without silent renewal. Test suspension, clock anomalies, BFCache restoration and late callbacks. Background polling cannot renew user activity; a recovered browser requires new explicit authorisations.

Verify regression detection against a head already observed in the active session. A completely replayed valid old snapshot after all local state is lost may remain undetectable; record that limitation instead of expecting impossible rollback protection.

Scripted or virtual-authenticator tests demonstrate controller logic only. A new browser context is not proof of authenticator synchronisation. Keep same-credential real-device and second-device evidence in Task #15; never export an authenticator secret to manufacture that evidence.
</execute_task>

📦 BUILD TASK #5: packages/vault/tests and storage integration tests
🛠️ ACTION TYPE: Extend

<execute_task>
Extend existing vault/storage tests with real browser Web Crypto, PostgreSQL compare-and-swap and the configured local S3-compatible conditional-write adapter. Reuse independently checked HKDF/AES-GCM vectors; do not derive expected answers with the implementation under test.

Tamper with descriptor/header ownership, rpId, object ID, salt, IV, ciphertext, tag, length and envelope digest. Swap valid encrypted objects between owners/vaults. Assert authentication/binding failure before plaintext reaches a view, model request or import preview. Errors must not echo secret material.

Inject failures before/after leaf upload, capture upload, read-back, catalog upload and head commit. Include a lost acknowledgement after a successful commit. Retry must reconcile the authoritative head and reuse exact envelopes/opening/commitment for the pending operation; no duplicate logical review or silent overwrite.

Race two device sessions, repeated identical uploads, conflicting bytes at one object ID, quota reservations and head revisions. Assert immutable writes, bounded staged-object accounting, 409 conflict handling, preserved unsaved drafts and no success before complete read-back plus reachability verification.

Exercise missing, swapped and corrupt capture/opening/artifact objects; partial storage outage; restart during a save; and lock during decryption. Interrupted work cannot release stale plaintext or controller-owned readiness. Working-context edits must not change previously frozen bytes.

Round-trip encrypted review, readable review and context-only exports through their existing preview/confirm flows. Reject malformed/duplicate/unreferenced objects, oversize data and foreign-key bindings. Foreign readable proofs retain their reviewer; imported facts remain unconfirmed. No persistent import changes before explicit confirmation.

Verify fresh destination encryption without changing the original readable package identity. Encrypted single-review backup still requires the original usable credential/rpId; context export is not a document backup. Removing a working note does not erase historic captures, downloaded copies or retained storage objects.
</execute_task>

📦 BUILD TASK #6: apps/web authentication and resource-ownership tests
🛠️ ACTION TYPE: Extend

<execute_task>
Create two isolated authenticated synthetic accounts and one unauthenticated client. Exercise the actual auth, vault, assistant, transaction-operation and funding routes. Resolve authority through server sessions, never caller-supplied owner fields.

Test exact stored EIP-4361 message validation, configured domain/URI/chain, pre-auth cookie binding, nonce expiry, consumed challenges and concurrent challenge verification. At most one verification may create a session. Test login swapping, session replacement/logout, expired sessions and spoofed forwarding headers without leaking session tokens.

Attempt cross-account descriptor/head/object access, assistant status/cancellation, operation inspection/submission and funding-recipient substitution. Unknown and foreign IDs must not reveal ownership/existence. Tampered cached addresses or request bodies cannot authorise access. Public receipt reads remain intentionally public and bounded.

Check HttpOnly/Secure/SameSite/host-only cookie policy in the intended HTTPS configuration, authenticated no-store responses, configured Origin, content type and required application header. Test missing/null/foreign origins, credentialed CORS, framing and oversized streaming/chunked bodies. An Origin check is not a replacement for authentication/ownership.

Preserve route-specific body limits: 16 KiB control requests, 16 MiB vault wire-object/initial-catalog requests and 128 KiB assistant starts. Preserve the 4 KiB raw-transaction limit. Validate limit+1 rejection before expensive work; do not globally raise parser limits.

Test shared-store admission, rate limits and operation ownership with two application instances. Failure of PostgreSQL/authentication must disable protected work, not enable a demo bypass. Exercise intended unauthenticated verifier/public-read routes separately.

Use bounded local requests only; this chapter does not authorise scanning or attacking sponsor/public infrastructure. Schema validation, EOA login and account ownership do not attest professional identity, actual biometric use or human review of legal content.
</execute_task>

📦 BUILD TASK #7: tests/privacy/disclosure-boundaries.spec.ts
🛠️ ACTION TYPE: Create

<execute_task>
Build a small test-only disclosure matrix using distinct synthetic canaries for document text, title, notes, selected/unselected excerpts, opening nonce, plain artifact hashes, PRF/key material, authentication tokens and provider credentials. Distinguish public receipt fields from private hashes and envelope ciphertext digests.

Assert allowed destinations explicitly: storage receives ciphertext plus approved public metadata; assistant backend/provider receives only the selected consent-bound plaintext required by the run; RPC/indexer receives public chain data; readable download contains the deliberately disclosed package. Never assert that all network traffic must be ciphertext.

Observe browser requests, workers and relevant server outbound adapters. Browser interception alone cannot prove what the backend sent to Qwen or S3. Block service workers in interception-based fixtures so they cannot hide network events; separately inspect the normal application for unexpected registrations/caches. Record unobservable infrastructure/provider layers as unverified.

Inspect browser persistence, server-rendered HTML, URLs/referrers, database rows, object bytes, application logs, metrics/error payloads and generated reports for prohibited canaries. Check plain, JSON-escaped, URL/base64/hex representations where applicable. Canary absence is a bounded regression test, not proof against every encoding or side channel.

Prove no assistant request without explicit Send, no unselected-source expansion and renewed consent when disclosure changes. Test failure/retry/cancellation paths and provider errors. Logging must use allowlisted operational fields rather than serialising whole requests/errors. Selected text already sent cannot be recalled by Stop.

Permit only existing narrowly scoped exceptions: opaque backend cookies, transient approval signatures for simulation/submission and the service funder's signed outbox. Do not persist user action signatures/raw transactions, PRF outputs, user keys or provider credentials as test evidence.

Disable screenshots, DOM snapshots, traces, HAR and body logging around real credentials/signatures or non-synthetic data. Synthetic runs must still sanitise operational secrets. Exclude saved authentication state from commits/uploads; provide explicit safe evidence projections instead of assuming a test reporter redacts them.
</execute_task>

📦 BUILD TASK #8: packages/agent/tests and Aegis integration tests
🛠️ ACTION TYPE: Extend

<execute_task>
Extend Chapter 9's scripted-provider and real-controller tests. Inject hostile instructions through source text, artifact labels, saved/imported notes, prior conversation and tool output. Include requests to disclose unselected content, fetch URLs, change rules, confirm facts, sign, fund, submit or disable validation.

Assert actual capability boundaries regardless of model wording: only the six existing read-only tools can execute; arguments remain within the consented snapshot; no arbitrary network/filesystem access, vault unlock, confirmed-memory write, decision record, approval ticket or transaction is produced. Do not rely on an instruction saying ignore malicious text as the sole control.

Test forged tool/system roles, unknown/cross-run source handles, changed source versions, invalid offsets/quotes, forged calculations/status, malicious Markdown/HTML and malformed structured outputs. Browser verification must resolve citations to the actual selected artifact bytes; partial server excerpts cannot prove full-document integrity or semantic correctness.

Use the existing GBP oracle: 2400000-(1000000+1200000)=200000. A simulated second instalment of 1400000 must not change actual confirmed inputs or the real discrepancy. Facts require explicit user confirmation and a new snapshot/run; demo_draft rules remain visibly draft.

Assert actual run ceilings: six provider attempts including repairs/retries, eight tools, 120 seconds total, per-attempt timeout and existing input/output reservation limits. Test maximum+1, malformed output repair, missing usage, duplicate admission, lease expiry and cross-replica cancellation. No automatic model/provider fallback or untracked background continuation.

Exercise partial SSE frames, duplicate/gapped sequence numbers, disconnect, completion/cancel races and worker restart. Require one real terminal outcome; stopping is not cancelled before acknowledgement. Late output cannot repopulate a locked or changed matter.

Assertions concern schemas, citations, arithmetic, authority and side effects, not exact model prose. Scripted success does not validate live Qwen behaviour, legal advice quality or universal prompt-injection immunity. No paid model calls in default CI.
</execute_task>

📦 BUILD TASK #9: tests/system/approval-races.spec.ts
🛠️ ACTION TYPE: Create

<execute_task>
Test Chapter 10's real decision, freeze and approval controllers through UI and focused unit/integration seams. Reject model/voice/imported approved flags, preselected acceptance, unsupported dispositions and missing reasons. Technical integrity failures cannot be waived by a human decision.

Bind decisions to exact source/fact/rule/result revisions. Change each dependency independently and require fresh review where affected. Preserve the original unresolved finding when a reviewer acknowledges a concern; acknowledgement cannot turn mismatch into match or certify a draft rule pack.

Verify the decision log avoids circular hashes, the package includes the exact required artifacts/scope and the freeze captures owned immutable bytes. Alter or remove an object after upload but before read-back; approval must remain unavailable. Reconstruct readiness after reload instead of trusting serialized booleans.

Use controlled barriers before/after preflight, hashing, save, action signing, simulation, outer signing and submission. Change account/generation, package, predecessor, replacement, registry/chain, registry nonce, deadline or cancellation state at each relevant boundary. No stale completion may release a new signature or broadcast.

Exercise duplicate clicks and rejection at each human step. One explicit action confirmation consumes one private action ticket; one explicit Send consumes one quote-bound transaction ticket. Changed ReviewAction fields require new action approval; changed fee/transaction fields require new Send approval. Preserve 15-second preflight freshness, 600-second action deadline and 30-second quote lifetime.

Check exact EIP-712 domain/action and parsed outer transaction identity on both client and server. Reject different destination/selector, trailing calldata, nonzero value, contract creation, delegation/authorisation-list transactions and fee-cap bypass. Never expose a general signing method for tests through production code.

An action signature becomes executable when disclosed, including remote simulation. Stop, lock, closing a dialog and quote expiry cannot retract it. A controller-scoped EOA key is not hardware-isolated or an on-chain session key; these tests establish application behaviour, not protection against compromised same-origin JavaScript.
</execute_task>

📦 BUILD TASK #10: Registry, transaction monitor and Envio integration tests
🛠️ ACTION TYPE: Extend

<execute_task>
Run the real registry/SDK against isolated Anvil for ISSUE, REVOKE, SUPERSEDE, replay and nonce invalidation. Reuse fault transports for receipt lag, inconsistent checkpoints and replacements. Anvil is not evidence of Monad's gas charging, execution delay or Alchemy capabilities.

Inject failure before durable operation recording, before broadcast, after accepted broadcast with response lost, during monitoring and after browser/server restart. Assert public transaction identity is recorded before sending; reconciliation preserves exact bytes/hash/intent when available. Lost bytes plus unknown outcome must not trigger automatic re-signing, fee bump, funding or a new commitment.

Keep backend challenge nonce, opening nonce, registry nonce and EOA transaction nonce distinct. Race duplicate requests and a separate executor of the disclosed action. Confirm action execution separately from this account's transaction result; an unrelated replacement is not success.

Verify execution receipt, exact fields/events, configured registry, canonical block and established execution checkpoint before confirmation. Test wrong chain/genesis/code/version, changing block hashes, missing historical data and RPC outage. No failed read becomes not_found; no latest-state fallback retains a confirmed label.

Check atomic supersession event ordering and predecessor/successor binding. Revoking a successor cannot reactivate its predecessor. A reverted outer transaction and a successfully consumed registry nonce have different consequences. Nonce invalidation requires its own explicit fee-paying confirmation and may lose a race; Stop must not submit it.

Test funding cooldown/global value-plus-fee reservations, funder nonce serialization and crash recovery with a local service key only. One unresolved outbox cannot become two grants; retry identical bytes. No automatic public faucet use, mainnet funding or live service-budget reset.

Feed real local event output through existing Envio handler/integration fixtures. Exercise duplicate logs, pagination, out-of-order observations, lag and supported reorganisation handling. Preserve indexed/live provenance; history cannot override verified live lifecycle. If actual indexer runtime behaviour is not exercised, label that part simulated or blocked.
</execute_task>

📦 BUILD TASK #11: apps/verifier/tests and packaged-SDK checks
🛠️ ACTION TYPE: Extend

<execute_task>
Use the exact readable bundle downloaded from the full journey. Open the standalone verifier in a fresh isolated context without LexAegis cookies, Mera, Qwen, Envio or backend access. Supply the original expected receipt reference independently.

Block all network traffic after initial asset loading and assert local manifest/artifact verification still works. Enable only an explicitly configured test RPC for chain checks; observe that no document/opening/plain artifact hash is transmitted. Local files must never supply their own endpoint or trusted deployment policy.

Mutate a file, manifest, nonce, reference field and entire internally consistent bundle. The independently supplied original reference must catch substitution. In file-declared mode, the UI must disclose that weaker expectation provenance rather than claim independently authenticated origin.

Check missing/extra artifacts, encrypted/context-only/wrong-version inputs, count/depth/size limits and worker cancellation. Reference-only and manifest-only modes cannot claim full artifact verification. Unknown signer policy remains unknown; rejected policy stays rejected even with an Active receipt.

Test untrusted registry identity, failed RPC, mixed checkpoints, status refresh failure, revoked/superseded receipts and bounded successor traversal. A successor's package remains unverified without its own files/opening. Public report download must contain no private digest, opening, label, artifact content or endpoint credential.

Verify export preview/confirmation and explicit navigation/import handoff: no automatic upload, private URL fields, cross-origin postMessage transfer or credential reuse. Clearing/locking the originating app cannot retract an already downloaded readable file.

Reuse Chapter 11's actual packed-package consumer and browser Web Crypto checks. Do not build another SDK or duplicate golden vectors. Passing the internally authored example demonstrates portability, not independent adoption or a separately authored cryptographic verifier.
</execute_task>

📦 BUILD TASK #12: apps/web Aegis lifecycle, voice and accessibility tests
🛠️ ACTION TYPE: Extend

<execute_task>
Run focused browser tests for lock, sign-out, account/matter/version switch, session expiry, pagehide/pageshow, interrupted network and component teardown during assistant work, decryption, approval and verification. Stale callbacks must not restore private panes, signing authority or success indicators.

Verify Stop cancels assistant work through its acknowledgement contract, aborts dictation, cancels read-aloud and invalidates unused tickets without sending a transaction. Preserve read-only reconciliation for a possibly disclosed/broadcast action. Different operations retain distinct outcomes; do not label an entire matter cancelled.

Test local speech through capability adapters: unavailable PRF is unrelated to speech support; unavailable speech must retain complete text functionality. Require verified on-device recognition/local synthesis, explicit start/play, no cloud fallback, transcript editing and explicit Send. Spoken yes/approve cannot authorise facts or transactions.

Exercise permission denial, missing language pack, local-voice disappearance, 30-second capture limit, 4,000-character playback bound, manual-edit races and late results. No background listening, automatic restart or fake listening/speaking state. Mock tests do not prove OS/browser speech locality.

Check Command-centre and Review modes at 1440x900, 1024x768, 390x844 and 320 CSS-pixel reflow. Include keyboard-only source navigation, dialogs, disclosure, approval, retry/cancel and export. Verify focus containment/restoration, visible labels, non-colour status, readable contrast and reduced motion.

Inspect real synthetic screenshots and the accessible control tree; correct clipped/hidden confirmations, inaccessible error messages and overlays. Escape never confirms. Automated accessibility checks are evidence for the tested controls, not WCAG certification.

After lock/BFCache restoration, verify private DOM, decrypted caches, object URLs and active voice/output are cleared or inaccessible before rendering resumes. State cleanup is best effort; do not claim JavaScript can guarantee physical memory erasure or recall external disclosures.
</execute_task>

📦 BUILD TASK #13: Production-build boundaries, security headers and dependency checks
🛠️ ACTION TYPE: Validate

<execute_task>
Build web, verifier, agent, protocol, SDK and vault in production mode with synthetic/non-secret configuration. Inspect actual emitted bundles and package tarballs for server-only imports, credential exposure, test signers, auth bypasses, mock-success flags and unintended private fixtures.

Verify the installed Next.js-compatible CSP against the running production build, including nonce/hash propagation and required workers. Block untrusted scripts, framing and object embedding without disabling legitimate account/parser features. Keep development-only exceptions out of production; do not fix failures with blanket unsafe-inline/unsafe-eval or wildcard credentialed CORS.

Exercise inert rendering of filenames, imported metadata, extracted text and model output. Reject executable HTML/Markdown, unsafe URL schemes, arbitrary backend fetch targets and redirect-based endpoint substitution. Do not add a server proxy to bypass verifier CORS restrictions.

Verify authenticated no-store responses, safe referrer policy, intended Permissions-Policy and absence of private service-worker/SSR caches. Inspect response headers from the actual local production server, not configuration files alone. Deployed edge/header behaviour remains a Chapter 13 check.

Run existing dependency/advisory and secret scans against the actual lockfile/source/build outputs. Add only a small maintained scanner if necessary. Use current vendor advisories for relevant findings; make minimal compatible fixes and rerun affected tests. Do not run force-upgrade commands or rewrite unrelated dependencies.

Keep scanner output redacted. Missing scanner/network access is blocked, not zero vulnerabilities. Do not suppress a reachable high/critical finding to pass a gate; record any disputed reachability with concrete evidence and retain unresolved items as blockers.

Exclude authentication state, secrets, raw signatures, traces with credentials and private evidence from commits, CI uploads and public packages. Passing scans is not proof that the application has no vulnerabilities or that same-origin JavaScript cannot access unlocked material.
</execute_task>

📦 BUILD TASK #14: scripts/validate-mvp.ts and reproducible CI gates
🛠️ ACTION TYPE: Create

<execute_task>
Add one bounded validation entry point using the existing package manager and CI conventions. Reuse existing lint/type/schema/unit/contract/build/pack commands and the focused system tests above; do not add an independent pipeline or paid live-service requirement.

Default CI runs synthetic local tests without sponsor secrets. Provision only isolated existing PostgreSQL/S3-compatible/Anvil dependencies. Set explicit per-job/test deadlines, cancel orphaned child processes and cap concurrency to prevent shared account/nonce collisions. Missing mandatory local dependencies fail the gate with a useful code.

Run deterministic security cases without pass-hiding retries. If diagnostics rerun a failure, preserve the failing result with a flaky-result issue code until the cause is repaired. Never update hash vectors, snapshots or expected authority merely to match a broken implementation.

Prove the critical assertions are non-vacuous with small test-only negative controls: tampered artifact, cross-account request, forged approval flag, prohibited outbound canary and inconsistent chain observation. Each control must be detected by the owning test. Do not add a broad mutation-testing platform or ship fault switches.

Generate a versioned closed validation report from real runner outcomes and the case manifest. Bind results to commit when available, dirty-worktree state, tested non-secret source identity, lockfile/schema/prompt/config digests and fixture versions. Hash only allowlisted non-secret inputs; never hash credentials or private evidence into a public report.

Record actual status/duration/evidence class and safe artifact references. Treat missing results, required skips and blocked prerequisites as non-passing. Validate report schema, completeness and paths; never infer success from an existing report file or a zero exit code with no selected tests.

Run artifact sanitisation before any optional CI upload. Keep private raw logs local/ephemeral; retain a small synthetic evidence set and sanitised machine-readable summary. A report is build evidence, not permission to publish or deploy.
</execute_task>

📦 BUILD TASK #15: User-controlled device recovery and bounded live evidence
🛠️ ACTION TYPE: Validate

<execute_task>
Provide a small executable/manual-assisted validation harness for capabilities automation cannot establish. Use dedicated synthetic accounts/documents and existing configured integrations. Default to read-only live checks; never drive a real authenticator ceremony without the user's action or interpret missing interaction as success.

On a supported user-controlled device, verify real Mera account creation/recovery, explicit vault unlock, encrypted save/read-back and application-storage-cleared recovery using the same credential/rpId. Obtain specific confirmation before clearing only that test origin's data; preserve the passkey and unrelated browser state.

Repeat with the same available synced credential on a genuinely separate supported device when available. Verify the derived reviewer and exact decrypted bytes/commitment. Record browser/OS/authenticator class, rpId, ceremony counts and measured times without credential IDs or secrets. Unsupported/unavailable configurations remain unverified, not failures concealed by a fresh passkey.

Reuse existing genuine Monad testnet references for bounded read-only Alchemy/live-reader, Envio-history and independent public-RPC checks. Record actual deployment/reference/checkpoint and lag separately. No scanner load tests or adversarial traffic against public providers.

If live Qwen or new testnet lifecycle evidence is still required, expose a separate explicit opt-in run with synthetic disclosure, existing per-run/spending limits and genuine human approval/Send controls. No automatic inference, funding, deployment or transaction merely to fill an evidence table. Missing permission, credentials or funds leave those cases not_run/blocked.

Measure actual source-to-answer, recovery, signing, broadcast and confirmed-observation stages separately. Do not derive user experience from SDK call counts or marketing latency. Test real local dictation/read-aloud only where capability is verified; otherwise retain the tested text fallback and mark voice-device evidence unavailable.

Store only sanitised observations and synthetic/public evidence. Keep local/scripted, live read, human-observed device and paid-model observations distinct. Do not claim that an automated harness can prove sponsor-side retention, genuine practitioner validation, external adoption or legal accuracy.
</execute_task>

📦 BUILD TASK #16: docs/build-state.json and Chapter 13 readiness handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run the complete bounded gate from Task #14 and collect Task #15 observations that are actually available. Fix concrete defects with regression tests; rerun affected and end-to-end checks without weakening authority, privacy, hashing or chain-assurance rules.

Maintain compact versioned findings/readiness records alongside docs/build-state.json. Each finding records severity, invariant, safe reproduction case, affected module, remediation/result and remaining evidence. Never include attack payloads containing real secrets or confidential documents.

Block MVP readiness on unauthorised access/signing, key/plaintext leakage, corrupted/lost recoverable evidence, bypassed human gates, incorrect deterministic calculations, false confirmed/verified states, reachable unresolved high/critical vulnerabilities or missing required core-flow evidence. Required blocked/not_run cases cannot be waived by an assistant-authored success summary.

Separate local software gates from live capability evidence and deployment readiness. Missing real-device recovery or core sponsor integration evidence must be visible. Optional voice support may remain unavailable with a working text fallback; any cross-device or bounty claim requires its corresponding real evidence. No blanket production-ready badge before Chapter 13's hosting checks.

Update existing privacy/limitations text concisely: ciphertext protects stored content, not selected plaintext sent for inference; the service sees public account/size/timing metadata; receipts bind bytes/account actions, not truth or legal validity; same-origin compromise remains a risk; credential loss or missing ciphertext may prevent recovery; fresh-state rollback detection is limited; disclosures/public chain history cannot be recalled by local deletion.

Preserve earlier chapters' build records. Keep CLAUDE.md within 450 words and docs/assistant-ui-contract.md within 1,200 words by replacing stale statements. Do not claim an independent audit, legal compliance certification or zero-knowledge AI from these tests.

Hand Chapter 13 the exact tested revision/configuration, sanitised evidence paths, unresolved blockers, supported real-device matrix, deployment identity and hosting requirements: stable HTTPS origin/rpId, verified ciphertext-body limits, bounded assistant stream duration, security headers, private storage and correct secret separation. Record requirements only; do not perform deployment or publish submission assets here.

Stop after Chapter 12. Deliver executable tests, fixes and evidence through repository files. Do not substitute a terminal JSON summary or start the next chapter.
</execute_task>
```
