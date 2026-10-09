## Chapter 17 — Security Hardening and Verified Deployment

This chapter checks where LexAegis could be tricked or leak private information. It puts the receipt register through longer, less predictable tests, checks that cancelled or replaced approvals stay that way, and compares the deployed contract with the code used to build it. It also checks that private files and signing secrets do not appear in the wrong places.

The prompts build on the existing tests and record what actually passed, failed or could not be checked. They do not change the receipt format or replace the deployed contract. Passing these checks is not an independent security audit, and an explorer’s “verified” label does not mean the application is safe for real client data.

```text
📦 BUILD TASK #1: docs/build-state.json and Chapter 17 compatibility contract
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#12 sequentially through actual repository edits and checks. Produce executable tests, bounded scripts, compact evidence and factual blockers. Omit conversational filler, architecture essays, full-file echoes and standalone terminal JSON status summaries. Machine-readable files and script output required by existing tooling remain permitted.

Read applicable repository instructions, CLAUDE.md, docs/assistant-ui-contract.md, docs/build-state.json, the v3 brief, the Chapters 14–19 amendment, Chapter 3's registry contract and Chapter 12's validation plan/results. Inspect current repository paths and commands before each task. Extend existing modules and suites; preserve unrelated changes; do not spawn agents.

Mapping to the amendment: #2 = 17.1 [Should]; #3–5 = 17.2 [Must]; #6 = 17.3 [Should]; #7–8 = 17.4 [Must]; #9–10 = 17.5 [Should]; #11 = 17.6 [Should]. Tasks #1/#12 establish compatibility and consolidate evidence. Complete available tasks in order; a missing prerequisite blocks its dependent work without fabricating a replacement implementation.

Preserve manifest, opening, receipt-reference and export schemas; digest/commitment construction; EIP-712 domain/types; ProofOfReviewRegistry and inherited production contract source, ABI and deployed bytecode; compiler settings and deployed dependency versions; account derivation, PRF separation, vault formats, SDK report semantics and CLI exit codes. Reuse Chapters 14–15 protected baselines and unchanged Chapter 2 vectors. Never regenerate expected values to conceal a regression.

Use the actual v1 ABI: execute(ReviewAction,bytes) carries ISSUE/REVOKE/SUPERSEDE; invalidateNonce(uint256 expectedNonce) acts for msg.sender. There are no separate issue/revoke/supersede methods to invent. Confirm repository implementation matches this boundary before adding tests.

Test locally with synthetic accounts and isolated services. Public-network work here consists of read-only inspection and source verification of the existing Monad testnet registry. Do not deploy a replacement, fund accounts, submit review transactions, switch to mainnet or enable optional product features. Explorer source publication for that existing registry is in scope; publishing applications/packages or starting Chapters 18–19 is not.

Read installed-tool documentation and current primary sources where needed: Monad's Foundry verification guide at https://docs.monad.xyz/guides/verify-smart-contract/foundry; Foundry invariant guidance at https://getfoundry.sh/forge/invariant-testing; Solidity metadata/contracts documentation for the pinned compiler; and Slither at https://github.com/crytic/slither. Record consulted URLs and dates. Do not copy tutorial compiler settings over the deployment settings.

Use existing evidence schemas/writers. Record command, UTC date, tool versions, commit, dirty-worktree state, non-secret source/configuration identity, outcome and sanitised evidence path. Distinguish local tests, scripted browser checks, live reads and explorer verification. Generated prompts, old report files and an exited process without selected tests are not completion evidence. Missing results remain NOT YET.

Acceptance: dependencies, source-to-task mapping, protected inputs and existing coverage are identified; no protected change or live deployment is made.
</execute_task>

📦 BUILD TASK #2: docs/THREAT-MODEL.md
🛠️ ACTION TYPE: Create

<execute_task>
Create or extend docs/THREAT-MODEL.md from implemented boundaries. Identify assets: private package and opening, vault keys, signing-session authority, receipt namespace, authentication state, provider credentials, frozen approval snapshot and deployment configuration. Identify actors: reviewer, authorised recipient, malicious document/package/card author, unauthorised caller, executor, application operator, compromised same-origin script, model provider, RPC provider and indexer.

Map browser/unlocked memory, persistent storage, backend, Qwen, ciphertext storage, public registry, Envio and independent verifier. Distinguish user-held encryption from plaintext intentionally disclosed for analysis. The verifier's trusted chain/registry policy must come from caller configuration, not imported evidence.

For each abuse case record a stable ID, asset/boundary, preconditions, impact, implemented mitigation, exact test path and test name, observed test result, residual risk and any blocker. Cover at least:
- Replayed signatures; altered signed fields; wrong signer, chain or registry; stale nonce/deadline; malicious ERC-1271 validation.
- Unsigned/modified executor submissions and nonce-invalidation misuse. An unrelated executor submitting an unchanged valid action is permitted and must not be described as a forgery.
- Duplicate commitments, terminal-state reactivation, partial supersession and cross-reviewer namespace changes.
- Tampered/substituted packages, incomplete evidence, untrusted expected references and vault corruption/rollback.
- Document/tool-output prompt injection, unselected-source disclosure and cross-matter context leakage.
- XSS or compromised dependencies reaching an unlocked vault/signing session; malicious filenames, model output and optional agent cards.
- False or unavailable RPC responses, wrong deployment identity, indexer lag/reorganisation and stale success indicators.
- Misleading approval screens, mutable bytes after freeze, session misuse, cancelled/stale callbacks and already disclosed action signatures.
- Plaintext or secrets in bundles, persistence, logs, telemetry, URLs, exports and unintended network destinations.
- Public address/timing/receipt-history linkability and full-package disclosure to a verification recipient.

Include the implemented Chapter 16 branch only. If identity is disabled/unavailable, describe the guarded boundary and actual disabled-state tests; do not imply live card fetching or registration was tested. Keep identity discovery separate from reviewer authority and legal qualification.

State residual risks plainly: same-origin compromise can access unlocked material; application sessions do not create hardware isolation; Stop cannot recall disclosed plaintext/signatures or reverse broadcast transactions; a single RPC can lie; encrypted old snapshots may be replayed; public receipt activity is linkable. Hashes bind bytes, not factual truth or legal correctness.

Mark absent tests NO TEST YET. A test that exists but has not passed gets its actual not_run/blocked/fail state. Keep planned mitigations distinct from implemented controls. Refresh links/results after Tasks #3–10 rather than claiming coverage now.

Acceptance: every coverage claim resolves to an existing passing test for the identified source state; uncovered cases and residual risks remain visible.
</execute_task>

📦 BUILD TASK #3: contracts/test/handlers/ReviewRegistryHandler.sol
🛠️ ACTION TYPE: Extend

<execute_task>
Inspect Chapter 3's invariant handler and reuse its path. Create the named handler only if no equivalent exists. Add a bounded stateful model around the unchanged deployed-registry implementation; do not substitute a simplified registry or signature checker.

Use at least four synthetic EOA reviewer identities, one local deployed ERC-1271 reviewer and distinct executor identities. Derive only test keys. Generate valid ISSUE, REVOKE and SUPERSEDE actions through execute and direct reviewer-owned invalidateNonce calls. Use actual EIP-712 signing for the current local registry/chain, and call through unrelated executors as well as reviewers.

Mix successful transitions with deliberately invalid signatures, shapes, lifecycle states, deadlines, replayed nonces and unauthorised invalidation attempts. Maintain bounded pools containing never-issued, active, revoked and superseded commitments. Exercise identical commitment bytes under different reviewers and multi-step successor chains. Do not filter away all failures with vm.assume or generate mostly meaningless reverts.

Track an independent ghost model keyed by reviewer/commitment: ever-issued membership/count, status, predecessor/successor, issuance time and expected nonce. Update it from the pre-state and intended transition only after observed execution succeeds. Do not copy queried registry state into expected answers. Snapshot affected and other tracked namespaces before rejected calls.

Treat successful reviewer-owned invalidation as its own authorised operation without an EIP-712 signature. It advances that caller's current nonce by exactly one. Keep registry nonce, EOA transaction nonce, authentication challenge and private opening nonce conceptually separate.

Catch only intentionally expected target reverts. An unexpected failure of a constructed valid action or a failed assertion must escape the handler and fail the suite. Configure targeting to exercise intended handler selectors, not arbitrary setters, mocks or the registry directly. Use fail_on_revert=true where compatible with the pinned Foundry version and this expected-revert design.

Expose attempted/successful/expected-rejected/unexpected-rejected counts per operation and reviewer. Add a deterministic progression check and campaign coverage checks proving successful issue, supersede, revoke and invalidation calls occurred; count random campaign activity separately from setup. An all-reverting campaign must not pass.

Bound tracked sets and time advancement so the suite terminates. Do not manipulate production storage during stateful campaigns. If nonce-exhaustion testing needs a storage cheatcode, isolate it in a clearly named local boundary test and keep it out of live evidence.

Acceptance: the handler reaches meaningful states, exercises multiple namespaces and valid signatures, and reports failures without silently swallowing them.
</execute_task>

📦 BUILD TASK #4: contracts/test/RegistryInvariants.t.sol
🛠️ ACTION TYPE: Extend

<execute_task>
Extend the existing invariant suite using Task #3's handler. Preserve Chapter 3 assertions and combine related checks against a coherent model state. Derive expected transitions from the approved lifecycle, not implementation internals.

Assert these properties across tracked reviewers and commitments:
1. An ever-revoked or ever-superseded receipt never returns to Active or NotFound; previous issuance cannot be erased or overwritten.
2. Each commitment is issued at most once per reviewer. SUPERSEDE creates one replacement; its ReceiptIssued plus ReceiptSuperseded events do not count as two issuances.
3. A reviewer's nonce is monotonic. Each successful execute or invalidateNonce consumes exactly the current value and increments once. Failed actions leave it unchanged; consumed values cannot authorise another operation or wrap to zero.
4. Immediately after successful supersession, the old receipt is Superseded and exactly the replacement of that pair is Active. Later revocation/supersession may leave neither member Active; the old member never reactivates. Do not require exactly one Active receipt forever or only one Active receipt globally per reviewer.
5. Predecessor/successor links agree within the same namespace; a terminal superseded receipt has one immutable successor; successor chains cannot cycle or reuse previously issued commitments. Original issuance timestamps remain unchanged.
6. No receipt or nonce changes after failed authorisation or a rejected lifecycle operation. Successful nonce invalidation requires the reviewer's own call; successful execute requires the action's valid current authorisation.
7. One reviewer's operation cannot mutate another reviewer's records, links or nonce, including when the commitment bytes are identical.

Add explicit transition assertions for atomicity and event order. A successful supersession emits ReceiptIssued for the replacement before ReceiptSuperseded, sharing one consumed authorisation nonce. A reverted transaction leaves no committed lifecycle change or receipt logs; distinguish this from internal trace/debug observations.

Exercise issue -> supersede -> revoke replacement and issue -> supersede -> supersede again. Keep historical links and terminal statuses intact. Exercise racing reuse of the same nonce through sequential executions: one valid winner consumes it; the second attempt cannot create another authorised transition.

Use reachable states and real signature validation. Coverage of local ERC-1271 fixtures does not establish Mera behaviour or a mainnet deployment's safety.

Acceptance: invariants and lifecycle assertions pass against the unchanged registry with nonzero meaningful coverage. On a reproducible registry failure, preserve the minimised sequence/seed, mark the gate failed and stop dependent sign-off. Do not edit the contract or weaken the assertion; report requires redeploy decision.
</execute_task>

📦 BUILD TASK #5: contracts/test/Authorization.t.sol and docs/security/invariants.md
🛠️ ACTION TYPE: Extend

<execute_task>
Extend existing authorisation fuzz tests and ERC-1271 fixtures, covering gaps only. For valid shaped actions, exercise timestamps at deadline-1, deadline and deadline+1 with overflow-safe generation. Under v1, deadline>0 and timestamp<=deadline are required; equality succeeds. Test zero deadline separately. Expiry of an unexecuted instruction must not expire an already issued receipt.

Generate wrong-signer, wrong-chain, wrong-registry, wrong-domain-name/version and individually altered signed-field cases. Keep unrelated preconditions valid when isolating signature rejection. Deploy a second local registry for wrong-registry replay and restore chain context after chain-ID tests. Preserve fixed SDK/Solidity digest vectors.

Test replay after issue, revoke, supersede and nonce invalidation; stale expectedNonce; duplicate actions submitted by different executors; and rollback after a valid signature reaches an invalid lifecycle transition. An unchanged valid signature submitted first by an unrelated executor must succeed with exactly the authorised result.

Cover actual pinned OpenZeppelin behaviour for malformed EOA signatures, high-s malleability, invalid ERC-1271 magic, malformed return data and reverting validators. A validation attempt cannot mutate registry state under STATICCALL. If a mock catches a failed nested mutation and legitimately returns the valid magic value, the outer authorised action may succeed once; do not assert that every attempted nested call makes the outer signature invalid.

Change an ERC-1271 fixture's signing policy after issue. Historical receipt state stays intact; new actions use the current policy. Exercise nonce exhaustion in a separate local boundary fixture without changing production source or asserting an unreachable state was generated naturally.

Add a test-only security profile that preserves every bytecode-affecting build setting. Target at least 1,000 invariant runs at depth 256 and 10,000 cases per fuzz property for the recorded security campaign. Run a recorded seed and an additional distinct recorded seed. Read the pinned Foundry CLI/configuration before choosing flags; do not assume unsupported options.

Keep routine CI bounded, for example 256 invariant runs at depth 128 and 1,000 fuzz cases per property. State actual effective counts, seeds, timeouts and selected suites. If resources prevent the full campaign, preserve smaller-run evidence but mark the full target NOT YET; never relabel it as completed. Retain/replay found counterexamples before fresh random campaigns.

Write docs/security/invariants.md with source identity, toolchain, exact commands, runs/depth, case counts, operation coverage, durations, outcomes and sanitised reproduction instructions. Do not commit private keys, raw signatures or sensitive runner traces. A harness defect may be fixed with evidence; a registry defect requires the protected-source decision from Task #4.

Acceptance: existing regression tests, new boundary cases and both full campaigns pass with recorded coverage; otherwise the report names the precise failed or blocked requirement.
</execute_task>

📦 BUILD TASK #6: docs/security/static-analysis.md and Solidity analysis checks
🛠️ ACTION TYPE: Validate

<execute_task>
Run the repository's existing contract linter and a maintained Solidity static analyser, preferably a pinned compatible Slither version. Use an isolated development environment and the actual Foundry project/compiler/dependencies. Do not upgrade the deployed Solidity/OpenZeppelin stack or rewrite compiler settings to make the analyser run.

Record tool versions, executable commands, relevant configuration, analysed contract/source scope, exclusions and raw finding identifiers. Keep a sanitised machine-readable output where useful. Analyse production registry code and its inheritance; do not claim broad coverage from analysing test fixtures alone. Report separately if only a formatting check exists and no contract linter is configured.

Triage every finding in docs/security/static-analysis.md. Include detector, location, severity/confidence, applicability, reasoning, evidence and disposition. Use fixed only after a permitted fix and rerun; accepted only with a concrete bounded residual-risk justification; false positive only with supporting reasoning. An unresolved finding stays open and cannot be forced into an accepted category.

For any finding requiring a change to registry source, inherited logic or deployed dependencies, retain requires redeploy decision as an open blocker. Do not modify those files, suppress a reachable serious issue or report the problem as fixed. Small fixes to chapter-owned tests, scripts or analysis configuration are permitted when they preserve the target under analysis.

Retain the full unfiltered finding inventory alongside justified exclusions. Do not use broad ignore lists, hidden triage databases, empty inputs or successful wrapper exits to make the tool appear clean. Distinguish detected findings from tool execution/compilation failure.

If installation, compiler support or environment access prevents execution, write NOT YET with the concrete error category and a reproducible next command. A linter pass is not a substitute for an unavailable analyser. No automatic external scan or source upload to an unapproved service.

Acceptance: available checks run against the correct source identity; all findings are accounted for; unavailable tools and unresolved changes remain explicit. The report makes no audit or vulnerability-free claim.
</execute_task>

📦 BUILD TASK #7: scripts/verify-deployment.ts and runtime-bytecode comparison tests
🛠️ ACTION TYPE: Create

<execute_task>
Create or extend the read-only deployment checker and expose pnpm verify:deployment. Reuse the Chapter 6 deployment manifest, trusted network configuration, caller-controlled transport and existing error/report conventions. Loading the module must not make requests or load a signer. Never accept the trusted registry, artifact or RPC endpoint from an imported review package.

Require an actual configured Monad testnet deployment and its reproducible build artifact. Validate observed chain ID and existing network-identity policy before interpreting code. Fetch nonempty runtime bytecode at an identified canonical block/hash with the existing finality policy. Recheck checkpoint consistency; failed reads, wrong chain, missing code, malformed results and unreproducible artifacts are non-passing outcomes.

Rebuild with the recorded deployment compiler, optimizer, viaIR, EVM target, metadata settings, remappings, source paths and dependency revisions. Compare deployedBytecode, not constructor/creation bytecode. Preserve the production build profile. Keep any isolated build/replay output separate from the tracked deployment artifact.

Handle compiler-declared linkReferences and immutableReferences explicitly. OpenZeppelin EIP-712 inheritance can embed deployment-specific immutable values. Resolve expected values from pinned source and authenticated deployment context, using deterministic local constructor replay if needed. Do not copy observed bytes into expected slots, zero-mask differences or strip immutable ranges. Unresolved values mean verification incomplete, not a match.

Attempt exact runtime comparison first. For the amendment's metadata-insensitive comparison, recognise Solidity's optional trailing CBOR using its final two-byte length and a bounded decoder. Validate trailer boundaries and expected compiler metadata structure on both sides. Strip only validated compiler trailers; never chop a fixed suffix, search for a magic prefix or let malformed lengths remove executable bytes. If metadata was disabled, compare the complete runtime. Keep compiler/version and build-provenance checks separate from ignored metadata bytes.

Compare every remaining executable byte, resolved immutable value and linked address. Record full and normalised byte lengths/hashes, checkpoint and exact-match versus metadata-only-match status. A normalised match is not a claim of exact source/metadata identity; unexplained executable differences fail. Preserve stronger existing trusted-code pins rather than replacing them with a weaker normalised hash.

Use stable documented nonzero exits for mismatch, invalid configuration/artifact and unavailable network/evidence; zero requires a successful comparison under the documented policy. Produce redacted diagnostics without credential-bearing URLs or environment dumps. Bound calls to 10 seconds, one transient retry and a 60-second total live-check budget, subject to stricter existing limits.

Add tests for exact and valid metadata-only matches; one-byte executable, immutable and link changes; truncated/oversized/malformed CBOR; metadata-disabled output; wrong network/address; empty code; unavailable RPC; inconsistent checkpoints; missing artifact; and unresolved immutables. Use local deployment evidence to exercise real EIP-712 immutable resolution. Stub network responses only in explicitly labelled unit cases. Assert no signing or submission methods are called.

Acceptance: comparator tests pass, including deliberate mismatches. The command reports actual live evidence when run; unit/local success alone cannot satisfy testnet deployment verification.
</execute_task>

📦 BUILD TASK #8: docs/DEPLOYMENTS.md and existing-registry explorer verification
🛠️ ACTION TYPE: Extend

<execute_task>
Extend docs/DEPLOYMENTS.md without overwriting Chapter 6 deployment records or Chapter 16 identity observations. Keep registry deployment, optional agent registration, local tests and explorer verification in distinct records.

Recover real deployment evidence: chain ID, registry address, deployment transaction hash, transaction sender/deployer, contract-creation mechanism, block number/hash, compiler full version, optimizer/settings, dependency revisions, source/build hashes and the deployment source commit when actually known. Identify the current verification commit separately. A current HEAD is not evidence of the historical deployment commit; missing provenance stays NOT YET.

Read back the actual transaction/receipt and contract address through configured read-only access. Check successful execution and consistency with the deployment manifest. If a factory was used, identify transaction sender and creating contract separately from observed evidence. Never infer unknown fields, substitute tutorial addresses or manufacture a transaction hash.

Run pnpm verify:deployment against the real Monad testnet registry using Task #7. Record command, result, checkpoint, safe provider identifier and code comparison. Prefer the existing Alchemy path; an independently configured public read endpoint may corroborate observations without exposing credentials. RPC observations remain trust-dependent, not consensus proofs.

Recheck https://docs.monad.xyz/guides/verify-smart-contract/foundry for the current TESTNET source-verification route. As checked for this chapter on 2026-10-06, Monad documents Foundry/Sourcify and Monadscan routes for testnet. Resolve current endpoints, supported tooling and credentials at execution time; never copy a mainnet command or example address.

Submit the exact existing registry source and original compilation inputs through the supported explorer verification route. Use standard build information where supported; do not flatten/reformat source or change metadata settings to force acceptance. A tutorial's newer Foundry/compiler defaults do not override the recorded deployment build. Isolate compatible verification tooling if required.

Scan the outgoing source/build-info allowlist first. Include only required public Solidity sources, dependencies and compilation settings; exclude environment files, keys, private artifacts, broadcast credentials and unrelated repository contents. Pass any verification API credential through the supported secret channel without printing it. No deployer key, wallet signature or new blockchain transaction is required by this task.

Check the final verification response and exact chain/address explorer page. Record the link, checked time, verifier and reported match level. Submission accepted/pending is not verified. An existing address page alone is not a source-verification result. Bound polling to five minutes; record pending/unavailable with the actual reason if it cannot finish.

Keep bytecode comparison and explorer publication outcomes separate. A passing read-only comparison can coexist with a blocked explorer service, but the explorer claim stays NOT YET. An explorer badge cannot override a bytecode mismatch. Do not deploy a replacement to resolve either failure.

Acceptance: pnpm verify:deployment passes on the real target; documented deployment fields are evidence-backed; explorer verification has a checked result/link or an explicit blocker. Describe source verification as code correspondence, never a security audit.
</execute_task>

📦 BUILD TASK #9: tests/privacy/disclosure-boundaries.spec.ts and production leak checks
🛠️ ACTION TYPE: Extend

<execute_task>
Read Chapter 12's privacy matrix, harness and results before editing. Extend existing bundle/storage/log/network checks only where coverage is missing. If the later full Chapter 12 run has not occurred, reuse the available Chapter 14 smoke harness and record that distinction; do not mark Chapter 12 complete or invent its results.

Create distinct synthetic canaries for selected/unselected document text, filenames, matter notes, monetary fields, opening nonce, private artifact hashes, PRF output, signing/vault keys, signing-session secret and provider credentials. Use test-owned browser profiles, accounts, buckets and databases. Never instrument a user's real credential or expose actual secrets to make assertions possible.

Inspect the actual production browser assets, reachable source maps, emitted HTML and packed browser entry points. Reject server-only environment-variable names/imports, synthetic credential values, test signing adapters and known private fixtures. Scan key-shaped/high-entropy candidates, then distinguish documented public addresses, commitments, code hashes and public keys from secrets; do not suppress an entire directory or treat every hash as a leak. Inspect server bundles separately for embedded literal secrets without treating legitimate runtime server configuration access as a client leak.

Observe localStorage, sessionStorage, cookies, IndexedDB and application caches before, during and after the full synthetic journey, including unlock, save, approval, submission, failure, expiry, lock and reload. Detect persistent CryptoKey objects as well as plain/hex/base64/JSON-encoded secret values. Non-extractable keys in IndexedDB still violate the memory-only user-key rule. Intercept test-context storage writes as well as taking snapshots so transient write/delete leaks are visible.

Permit the existing opaque backend-authentication cookie and documented non-secret recovery metadata in their intended stores. Never permit a user signing key, raw PRF result, unwrapped vault key or signing-session secret there. Ciphertext may contain encrypted private package/opening data. Do not conflate an authentication cookie with the distinct prohibited signing-session secret.

Capture synthetic application/server/worker logs, telemetry/error outputs and available local storage metadata across success, provider failure, malformed input and cancellation. Reject document text, filenames, private monetary fields, keys, raw user signatures and credential-bearing URLs. Use contextual field/canary checks for amounts rather than matching every ordinary number. Inspect raw captured output before sanitising the retained report; sanitisation must not hide a failing assertion.

Apply an explicit destination-and-field disclosure matrix. Selected, consent-bound case input may reach the analysis backend and its Qwen call; corresponding authorised results may return to the requesting browser. Unselected material, private openings and user keys may not. Storage receives ciphertext and approved metadata; RPC/indexer receives the existing public transaction/receipt fields; the standalone verifier processes evidence locally. Explicit readable export is a user-directed disclosure, not an automatic upload.

Allow required authentication traffic and transient action signatures only on existing authorised routes. This is not permission to log/persist signatures or send case content to RPC. Check browser, worker and server outbound boundaries; browser interception alone cannot establish what the server sent to Qwen. Do not add a second analysis request or widen consent to satisfy a test.

Reuse real consent/Send, immutable capture, signing and transaction controllers through rendered controls. Assert no case disclosure before Send, no unselected-source expansion, renewed consent for changed disclosure, and no new tool dispatch after acknowledged cancellation. Label scripted providers/authenticators as simulated; uncontrolled provider/infrastructure logs remain unverified.

Acceptance: the complete local synthetic run satisfies the established disclosure matrix with no prohibited canaries. Missing observation layers or prerequisites are reported explicitly; these bounded tests do not prove absence of every encoding, side channel or same-origin compromise.
</execute_task>

📦 BUILD TASK #10: tests/privacy negative controls and existing CI security gates
🛠️ ACTION TYPE: Extend

<execute_task>
Prove each Task #9 check detects its intended failure. Use an isolated disposable worktree or equivalent test copy containing the tested source state. Preserve the user's working tree and unrelated changes. Use only synthetic markers, local services and test-only adapters; never introduce a real secret or public-network leak.

Introduce one fault at a time through the actual owning path:
- Include a fake server secret/name in a browser-reachable production module; the built-asset check fails.
- Persist a synthetic signing/PRF/vault/session secret through each monitored storage API, including write-then-delete and a test CryptoKey object; the owning persistence checks fail.
- Log a synthetic document/filename/amount/secret through the application logger and error path; the log check fails.
- Send unselected case content to a local forbidden receiver from browser and server paths; the network checks fail even without analysis consent. Also show a consented request with an extra unselected field fails.

Keep fault execution local. The test harness must intercept/reject unintended destinations before they can leave the isolated environment. Verify the failure identifies the correct boundary/case; a generic crash, compile error or unreachable server is not successful leak detection. Remove each fault and rerun the owning check to demonstrate recovery.

Preserve compact sanitised negative-control results: fault ID, affected boundary, expected detector, observed failure and restored clean outcome. Do not commit fault switches, modified runtime source, synthetic private-key literals or raw credential-bearing artifacts to shipped entry points. Remove only the temporary resources created by this task.

Connect existing contract, invariant/fuzz, static-analysis, comparator-unit and privacy commands to the current CI/evidence pipeline. Reuse Chapter 12/14 validators; do not build a parallel security framework. CI uses pinned tools, bounded jobs and isolated synthetic local dependencies without live signing, sponsor secrets or paid model calls.

Keep live deployment checks as a separately labelled read-only gate when network configuration is available. A skipped/unavailable live check cannot satisfy verified-deployment readiness. Record the reduced CI campaign separately from Task #5's full campaigns. Missing selected tests, ignored failures and incomplete required cases fail the applicable gate.

Fix confirmed leaks minimally in the responsible existing logging, rendering, storage, consent or transport module, with a regression test. Preserve protocol/account/vault boundaries. Any required change to a protected contract, derivation or wire format remains a blocker for an explicit design/redeployment decision.

Acceptance: each synthetic fault is detected by its intended check, the restored implementation passes, production outputs exclude fault machinery, and CI reports failures and unavailable evidence truthfully.
</execute_task>

📦 BUILD TASK #11: SECURITY.md
🛠️ ACTION TYPE: Create

<execute_task>
Create or extend SECURITY.md using implemented behaviour, docs/SPEC.md, docs/THREAT-MODEL.md and the actual deployment records. Describe the supported protocol/deployment/application versions separately. Use existing release tags/commits where available; do not invent a supported release or imply every fork is maintained.

State that the hosted testnet demonstration is unaudited, uses synthetic matters and is not for client data. Explain that local tests, invariant campaigns, static analysis and explorer source verification are different evidence types and none is an independent audit or legal certification.

Document the limits: public account/timing/history linkability; full supplied-package disclosure to verification recipients; selected plaintext visible to the analysis backend and Qwen; hashes binding bytes rather than truth/completeness; approval by a signing account rather than professional qualification or settlement signature; same-origin compromise of unlocked material; passkey origin/recovery limitations; RPC trust; and irreversible external disclosures.

Describe scope using actual components: registry, protocol/SDK, verifier/CLI, account/vault integration, analysis/approval boundary and deployed reference application. Optional agent identity is discovery only; its presence or absence does not change receipt validity. Document current severe/unresolved issues without publishing secrets or weaponised details.

Use a confirmed existing private security reporting channel if one is configured. Verify the repository's actual reporting URL/contact; do not invent an email address, enable an external feature or promise response times, rewards or legal safe harbour. If no private route is configured, mark private reporting contact NOT YET and request that reporters avoid placing sensitive details in public issues until a channel is supplied.

Ask for affected version/environment, impact and a minimal synthetic reproduction. Tell reporters not to include client documents, openings, keys, session tokens or usable signatures. Do not require testing against other users or causing disruption to demonstrate a report.

Acceptance: limitations and support claims match the specification and observed build state; the reporting channel is real or visibly pending; no audit, legal-advice or production-readiness claim is added.
</execute_task>

📦 BUILD TASK #12: docs/build-state.json and Chapter 17 handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected checks against the final implementation state. Reuse valid evidence for unchanged inputs and rerun checks invalidated by edits. Execute protected Chapter 2 vectors and existing SDK/Solidity authorisation compatibility checks unchanged. Confirm production registry/inherited source, ABI, compiler/dependency inputs, account derivation and vault/protocol formats still match the baseline.

Complete contract regression and meaningful invariant/fuzz coverage, static-analysis triage, deployment-comparator tests, the real read-only deployment check, production leak scans and the negative-control matrix. Run existing lint/type/build checks for changed modules and the Chapter 14 T0 smoke path. Keep optional identity/reputation flags in their existing states; a disabled/unavailable optional integration must not block the core path.

Do not reinterpret a failed check as success because another suite passed. Distinguish blocked/not_run checks, reduced campaigns, simulated integration, actual live observations and explorer outcomes. The amendment permits an explicit explorer-verification blocker; it does not permit a missing bytecode comparison to be called verified deployment.

Refresh docs/THREAT-MODEL.md test references/results, docs/security/invariants.md, docs/security/static-analysis.md, docs/DEPLOYMENTS.md and SECURITY.md. Preserve all previous deployment and chapter records. Validate evidence paths, result schemas and source identities; report dirty state without pretending HEAD represents uncommitted tested bytes. Hash only allowlisted non-secret source/configuration inputs.

Record each actual command/date/commit/outcome through the existing docs/build-state.json writer. A registry counterexample, executable-byte mismatch or unresolved serious leak remains a blocker. Missing prerequisites remain NOT YET. Keep NO TEST YET on genuinely uncovered threat cases; do not remove limitations to make the readiness report appear complete.

Record these scope clarifications in the existing discrepancy/decision record: lifecycle actions use execute; supersession's exactly-one-active condition applies immediately after the transition; valid third-party execution is permitted; nonce invalidation is a separate reviewer-owned action; deployment immutables require explicit resolution; and leak checks follow Chapter 12's narrow disclosure exceptions rather than rejecting all legitimate plaintext/authentication traffic.

Update CLAUDE.md and docs/assistant-ui-contract.md within their existing size budgets with actual security commands, protected boundaries, observed deployment status and remaining blockers. Add no new HUD badges claiming audited, secure, legally correct or professionally verified.

Finish with actual edits and concise factual check/discrepancy evidence. Prompt generation is not implementation evidence, and a completed report with blocked checks is not a fully passed chapter. Stop after Chapter 17; do not begin Chapter 18, Chapter 19, a replacement deployment or public application publication.
</execute_task>
```
