## Chapter 11 — Protocol SDK, Independent Verifier and Developer Integration

This chapter lets someone check a shared review package without logging into LexAegis or using Aegis, Qwen or a passkey. It checks whether the supplied files match the receipt, reads the receipt's recorded status and separately shows whether the signer meets the recipient's requirements. It also packages the reusable code and adds a small example showing how another application can use it.

```text
📦 BUILD TASK #1: Protocol, SDK and verifier integration boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#16 sequentially through repository edits. Throughout this chapter, produce clean code files, closed schemas, deterministic fixtures and compact factual build records. Omit conversational fluff, architectural essays, full-file echoes and terminal status-report payloads. Preserve unrelated changes.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json and relevant Chapter 2, 3, 5, 6 and 10 interfaces. Reuse existing preparation/hashing/verification functions, generated registry ABI, typed-data builders, live reader and readable export format. Do not redesign v1.

Complete framework-neutral SDK exports, bounded portable import, independent verification UI, a generic developer example and packaged-consumer checks. The verifier requires no LexAegis account/backend, Mera, Qwen, Envio or legal workspace. Generic protocol verification must not depend on employment-law rules.

Verify current installed APIs and primary references:
https://www.rfc-editor.org/rfc/rfc8785
https://eips.ethereum.org/EIPS/eip-712
https://eips.ethereum.org/EIPS/eip-1271
https://eips.ethereum.org/EIPS/eip-1898
https://viem.sh/docs/contract/readContract
https://docs.monad.xyz/developer-essentials/testnet
https://docs.monad.xyz/reference/json-rpc/overview

Keep chain observations dependent on an explicitly selected transport and deployment policy. This MVP does not implement a light client, zero-knowledge proofs, selective disclosure, professional credential checks, new chains, a registry marketplace or automatic evidence retrieval. Do not deploy contracts, publish packages or begin Chapter 12.
</execute_task>

📦 BUILD TASK #2: Framework-neutral ReviewExportV1 schema and portable decoder
🛠️ ACTION TYPE: Extend

<execute_task>
Reuse Chapter 5's exact readable envelope:
{schema:"lexaegis.review-export.v1", receiptReference:ReceiptReferenceV1, opening:CommitmentOpeningV1, artifacts:[{artifactId, bytes}]}

bytes is canonical base64url of original artifact bytes, in manifest artifact order. Preserve existing wire format, identifiers and limits. Do not add signatures, claimed status, provider URLs or trust-policy fields to the envelope.

If the generic readable schema/decoder currently lives inside the vault package, extract only that dependency-free functionality into @lexaegis/protocol/portable or its existing neutral equivalent. Keep compatibility re-exports and update callers. Encrypted backup formats, keys and vault controllers remain in packages/vault. Avoid SDK/vault dependency cycles.

Use the existing strict UTF-8/JSON parser with explicit portable-envelope limits. Reject duplicate and escaped-equivalent keys, malformed UTF-8, BOM, trailing content, unsupported versions, unknown fields, unsafe numbers, invalid prototypes and excessive nesting. Do not raise the existing manifest/opening limits when accepting a larger outer bundle.

Enforce 48 MiB encoded input, 1 MiB per manifest/opening, depth 32, 128 artifacts, 10 MiB per decoded artifact and 32 MiB total decoded artifacts. Bound declared and encoded lengths before allocation; reject noncanonical base64url, invalid trailing bits and duplicate/missing/extra IDs.

Decode each artifact once and retain exact bytes. Do not normalise documents, reorder committed arrays, repair metadata or recompute declarations to make supplied files match. Reject encrypted review backups and context-only exports with a specific wrong-format result. No ZIP extraction, URL import or network access.
</execute_task>

📦 BUILD TASK #3: packages/sdk public exports and dependency boundaries
🛠️ ACTION TYPE: Extend

<execute_task>
Finish @lexaegis/sdk as a typed, framework-neutral library using the existing package toolchain and engine policy. Preserve implemented exports and add explicit portable/verification entry points without duplicating cryptography.

Expose versioned schemas/types and existing functions:
prepareReviewPackage;
verifyManifestOpening;
verifyReviewPackage;
buildIssueAction;
buildRevokeAction;
buildSupersedeAction;
buildTypedData;
hashReviewAction;
validateReceiptBinding;
the generated registry ABI and verified live-reader interfaces.

Add thin parseReviewExport and verifyReceipt orchestration APIs with schema-derived signatures. Separate offline functions from network-enabled entry points. Importing either package must perform no network request, environment lookup, storage access, wallet connection or signing.

Keep protocol primitives browser/Node compatible with Uint8Array and existing Web Crypto adapters. Browser entry points cannot import Node-only modules, Next.js, React, Mera, Qwen, vault controllers, Alchemy credentials or a hosted-backend singleton.

Preparation returns an unapproved captured snapshot. Action builders return signing data only. They do not imply human review, consume a reference-app approval ticket, choose a nonce/deadline, sign or broadcast. External applications supply their own explicit approval interface, supported signer and transport.

Preserve uint256 values as canonical decimal strings at JSON boundaries and bigint internally. Reject unsupported adapter conversions instead of rounding through Number. SHA-256 package/artifact commitments and keccak256 EIP-712/runtime-code hashes retain their distinct existing purposes.
</execute_task>

📦 BUILD TASK #4: packages/sdk/src/verification/offline.ts
🛠️ ACTION TYPE: Create

<execute_task>
Compose the existing protocol verifiers into explicit reference-only, manifest-only and full-package modes. Require an expected ReceiptReferenceV1 argument for opening/package verification, as established in Chapter 2. Never silently replace a caller's expected reference with the bundle's declaration.

Compare the complete chain/registry/reviewer/commitment tuple, manifest context and opening against the expected reference. Recompute canonical manifest bytes, package digest, commitment and every supplied artifact length/hash through existing functions. The commitment alone is not a globally authoritative receipt identifier.

Reference-only mode leaves manifest/artifact integrity unknown. Manifest-only mode can establish manifest integrity but leaves artifact integrity unknown. Full-package mode requires the exact committed artifact set. Missing artifacts produce incomplete/unknown integrity; altered artifacts or conflicting references produce mismatch. Malformed input returns typed failure, never a partial success badge.

Keep imported reference provenance separate. A bundle can be internally consistent with its own declared reference without matching the receipt the recipient intended to inspect. The UI must identify a file-declared reference versus one independently supplied by the user. Do not claim that software can prove the origin of caller-provided expectations.

Reject caller mutation races using the existing defensive capture rules. Abort or discard stale work without mutating returned snapshots. Preserve stable issue ordering and opaque artifact identifiers in private diagnostics; never echo artifact bodies in errors.

Offline verification establishes byte/reference consistency only. It cannot establish issuance, active status, signer acceptance, evidence truth, actual human conduct or legal correctness. Unknown application profiles remain generically verifiable when the protocol envelope is supported; profile semantics are not evaluated.
</execute_task>

📦 BUILD TASK #5: VerificationReportV1 and caller-supplied trust policies
🛠️ ACTION TYPE: Create

<execute_task>
Define a closed, versioned VerificationReportV1 extending existing result concepts. Preserve separate fields for manifestIntegrity, artifactIntegrity, registryIdentity, receiptBinding, chainStatus and signerAcceptance, plus mode, expected reference, checkpoint, policy identifiers, observation time and typed issue codes. No generic valid=true field.

Use match|mismatch|unknown for integrity/binding checks; unknown|not_found|active|revoked|superseded for chainStatus; accepted|rejected|unknown for signerAcceptance. Keep unavailable, malformed and unsupported causes distinguishable through issue codes. Serialize large numeric observations as decimal strings.

Registry policy is trusted caller configuration: expected chain/genesis, registry, protocol version, deployment identity/runtime-code hash and checkpoint policy. A package cannot supply or change the authority used to validate itself. Do not create a global registry allowlist inside the protocol.

Signer policy is an explicit caller-owned rule over the public reviewer/reference and validated observations. Provide a minimal expected-address/set policy; absence of policy yields unknown, not automatic acceptance. Policy exceptions produce a typed unknown/error. Imported labels, account names, professional claims and transaction sender addresses are not acceptance policy.

Policy acceptance means the account meets the selected recipient rule; it does not certify professional qualification. Evaluate receipt binding only from a verified opening and trustworthy registry observation. Do not overwrite a manifest mismatch merely because an on-chain receipt exists.

Record actual observation time once in orchestration; pure verification stays deterministic. Reports are observations, not signed certificates. An earlier active result does not prove current status after later revocation or supersession. Include profileSemantics=not_evaluated for this generic MVP.
</execute_task>

📦 BUILD TASK #6: packages/sdk/src/registry independent RPC verification
🛠️ ACTION TYPE: Extend

<execute_task>
Reuse Chapter 6's framework-neutral live reader with a caller-supplied viem client/transport and explicit deployment policy. Remove any accidental dependency on the reference application's RPC proxy; do not change its Alchemy integration or expose its credentials.

For the default verifier, generate a secret-free public policy projection from the actual verified Monad Testnet deployment artifact: chain 10143, pinned genesis, registry address, deployment block/hash, protocolVersion and observed runtime-code keccak256. Missing pins mean live verification unavailable. Never invent an address or derive trusted deployment policy from an imported package.

Preserve Chapter 6's conservative confirmed execution checkpoint: select a concrete height at/after deployment and no newer than finalized height minus the validated execution-delay policy. Recheck current network/endpoint behaviour; an unsupported or changed policy remains unknown rather than silently weakening assurance.

Read code, protocolVersion and getReceipt at the same checkpoint. Use supported block-hash pinning with canonicality checks; otherwise pin the number and verify its hash before/after the read group. Reject mixed, regressing, missing or inconsistent observations. Never substitute latest while retaining a confirmed label.

Use generated ABI decoding and validate code identity/protocol version before accepting receipt state. not_found requires a successful decoded NotFound result at the verified deployment; RPC failure, empty code, wrong chain and unknown enum values remain unknown or mismatch.

Use explicit public HTTPS RPC configuration for the browser verifier, validated from current official network information and tested for required methods/CORS. Omit credentials/cookies and reject redirects. No secret-bearing default URL, hidden provider fallback, wallet provider or imported endpoint. Other SDK consumers may inject their own suitable transport/policy; isolated loopback Anvil is test-only.

Disable unintended CCIP-read/offchain URL resolution and unsupported implicit multicall behaviour. Send only required public RPC parameters; never transmit the opening, files or plain artifact hashes. Observations rely on the selected RPC and policy; they are not a consensus light-client proof.
</execute_task>

📦 BUILD TASK #7: Receipt lifecycle, predecessor binding and bounded orchestration
🛠️ ACTION TYPE: Create

<execute_task>
Implement verifyReceipt as an explicit composition of offline checks, optional live reads, validateReceiptBinding and caller signer policy. Network access requires caller opt-in with validated reference/policy; parsing a file alone cannot trigger it. Malformed or conflicting supplied inputs cannot produce an apparently complete combined result.

Require on-chain predecessor to match manifest.supersedes, or zero when absent. Validate status/link invariants. An unissued declaration is not issuance; an expired historical ReviewAction deadline does not expire an issued receipt. Revoking a successor never reactivates its predecessor.

Offer optional bounded successor inspection at the same checkpoint: at most eight links, visited-set cycle detection and exact chain/registry/reviewer scope. Validate reciprocal predecessor links. Limit exhaustion returns incomplete history. Do not mark successor package integrity verified without its own opening/files, or relabel the original Superseded receipt Active.

Treat the registry reviewer as the approving account; the transaction executor may differ. Retain support for receipts issued by supported EOAs and deployed ERC-1271 accounts. Current contract-signature validation can change with account state; do not revalidate an old ERC-1271 signature at latest state and use that to rewrite an already recorded receipt's lifecycle.

The readable export carries no approval signature. Do not invent one or require it to verify the registry record. Reuse existing typed-data builders for developer integrations; do not add counterfactual-account deployment or new signature schemes.

Bound a live check to 20 seconds, 64 underlying RPC attempts and four concurrent reads; each read has a 5-second timeout and at most one transient retry within the total budget. Accept AbortSignal, disable hidden transport retries and tag results with verification generation. Policy/reference/provider changes abort the active check. Preserve successful local integrity results when network verification fails.
</execute_task>

📦 BUILD TASK #8: apps/verifier/src/verification-worker.ts and local import lifecycle
🛠️ ACTION TYPE: Create

<execute_task>
Implement one dedicated local verification worker using the portable decoder and offline SDK functions. Bound file size before reading; transfer buffers where supported and avoid repeated base64/ArrayBuffer copies. Preserve the protocol's immutable-input guarantees.

Accept explicit file-picker/drop input for ReviewExportV1, or an opening plus separately supplied reference. Also support public reference-only inspection without files. Detect format by validated content, not extension alone. Encrypted backups and context-only exports receive actionable wrong-format messages.

Apply a 30-second local-job deadline with worker termination and generation invalidation; a Promise timeout alone must not leave parsing/hashing running. New input, Clear or cancellation terminates the prior job. Return actual parse/validation/hash progress counts rather than invented percentages.

Keep imported documents, opening nonce and private hashes in memory only. Do not persist them in localStorage, IndexedDB, service-worker caches, query strings, fragment URLs, analytics or error traces. No remote parser, converter, OCR or model call.

Use existing strict parsing before JSON object data loses duplicate-key information. Enforce envelope and decoded-byte bounds before expensive allocation. Treat labels and all artifact content as inert. Do not execute scripts, render supplied HTML/SVG or fetch links from an artifact.

Clear worker buffers/state on completion/cancellation as appropriate, revoke temporary object URLs and remove private views on Clear. Revalidate application state on page restoration. Report best-effort cleanup without promising guaranteed memory erasure. A local file check must work after initial app loading with network access blocked.
</execute_task>

📦 BUILD TASK #9: apps/verifier input, reference and policy interface
🛠️ ACTION TYPE: Extend

<execute_task>
Replace the verifier shell's placeholders with a complete, separately runnable Vite/React interface. Use the existing visual tokens and accessible components without importing the legal workspace, Aegis runtime or its application state.

Provide a concise workflow: choose input -> inspect public reference -> check files locally -> optionally check registry. Require no account creation, passkey, wallet connection or signature. Keep file checking usable when RPC configuration is unavailable.

Display the complete chain/registry/reviewer/commitment reference with copy controls. Clearly identify whether the expectation was supplied independently or taken from the imported file. Provide a separate expected-reference input; a mismatch cannot be resolved by silently replacing it with the file's reference.

Show the configured registry policy independently from imported data. The default policy comes from the genuine deployment artifact. An unrecognised registry remains unverified rather than silently becoming trusted. Other deployments are enabled through deliberate integrator configuration, not a package-provided trust override.

Provide optional recipient signer expectations using the local policy adapter. Display No signer policy selected when absent. Do not infer acceptance from the file's reviewer field or name. Policy changes invalidate affected results.

Check registry is an explicit action showing which RPC origin receives the selected public reference. Allow a validated user/integrator-selected public HTTPS endpoint without saving secrets; no automatic endpoint selection from files and no credentialed app-backend dependency. Unavailable CORS/methods produce an honest configuration error with local results retained.

Provide Cancel, Clear and explicit Refresh status. Keep current input stable during work or cancel it before replacement. Support keyboard operation, visible focus, mobile layouts and reduced motion; no fake successful verification demo state.
</execute_task>

📦 BUILD TASK #10: apps/verifier result panels and report export
🛠️ ACTION TYPE: Create

<execute_task>
Render independent result panels for manifest integrity, artifact integrity/completeness, registry identity, receipt binding/lifecycle and signer acceptance. Display mode, expected reference origin, policy, observation time and actual block/checkpoint. Use text/icons with colour; no single Valid agreement badge.

Use precise labels such as Files match supplied reference, Artifacts not supplied, Registry identity unverified, Active at block, Revoked, Superseded, Receipt not found and Signer not evaluated. An internally consistent file-declared reference is not an independently authenticated expectation.

Show a bounded artifact inventory with role, escaped label, byte count and individual check result. Put private digests and binding details behind a local-only technical disclosure. Missing bytes, changed bytes and unsupported input must remain distinguishable.

Display declared profile and that content/business semantics were not evaluated. An authentic package may contain incorrect analysis, untrue facts or unacceptable decisions. Do not generate legal conclusions, risk scores or professional identity claims from successful hashes or an active receipt.

Show successor references as separate observations, with links only to explicit public-reference checks. Never carry a predecessor's file-integrity result into a replacement package. Preserve incomplete-chain indicators and as-of status on refresh failures.

Implement an explicit Download verification result using a versioned public-field projection: reference, check statuses, safe issue codes, policy identifiers and checkpoint/observation data. Exclude openings, private digests, labels, artifact IDs/content, endpoint credentials and raw errors. Use a generic filename.

Label the downloaded result as an unsigned observation requiring fresh verification for current status. Do not accept that result file as a review package or treat it as a certificate. No automatic download or sharing.
</execute_task>

📦 BUILD TASK #11: LexAegis export handoff and verifier isolation
🛠️ ACTION TYPE: Extend

<execute_task>
Connect Chapter 10's Verify navigation to the configured independent verifier origin. Preserve the explicit readable-export disclosure and Download action. Open the verifier with noopener/noreferrer and no private payload, file URL, opening or case metadata in the destination.

Use Copy public receipt reference and an explicit paste/import workflow. Do not auto-upload the readable bundle, transfer it through postMessage, put it in local cross-origin caches or attempt passkey reuse. The recipient may open the verifier independently and supply their own exported file.

Keep the verifier's static build and configuration self-contained. Its trusted deployment metadata is a public build/configuration input, not a mandatory runtime fetch from apps/web. Do not import backend session, database, S3, account, vault-key or model configuration.

Restrict network activity to loaded app assets and explicitly selected public RPC/explorer interactions. No telemetry carrying imports, CDN-dependent document processing or generic RPC proxy. If existing security headers restrict RPC destinations, expose a deliberate allowed configuration instead of silently bypassing policy.

Prove local verification with the LexAegis API unavailable. Prove live verification through an independent configured RPC transport while the LexAegis backend, Qwen and Envio are unavailable. A provider outage may prevent live status but must not prevent local integrity checks.

The SDK, verifier and developer example may share public protocol code. Independence here means no required hosted LexAegis service or private application state; do not claim a separately authored cryptographic implementation or external adoption.
</execute_task>

📦 BUILD TASK #12: examples/document-review generic developer integration
🛠️ ACTION TYPE: Create

<execute_task>
Create one minimal TypeScript/Node example using only public protocol/SDK entry points. Use a non-legal profile such as example.document-review version 1, with synthetic source and decision-log bytes satisfying the generic role/scope rules. Do not import employment rules, Qwen, Mera or reference-app controllers.

Provide executable prepare and verify examples. Preparation hashes supplied bytes, captures a fresh production-style random opening and returns an explicitly unapproved package/reference. Fixed nonces remain test-only. Verification reads a readable bundle plus an explicit expected-reference file and emits the versioned report.

Live checking requires explicit RPC/deployment/signer-policy configuration; without it, report local integrity and unknown chain state. Keep credentials in operator environment/configuration, never command-line arguments, fixtures, generated reports or logs.

Demonstrate buildIssueAction/buildTypedData using explicit nonce/deadline inputs and the immutable prepared snapshot. Show a typed caller-owned signing handoff without executing it automatically. Do not add a default private key, automatic account unlock or a public-network broadcast path to the example.

Use real executable code, not TODO-only snippets. Keep filesystem access confined to the Node example; filenames/paths come from explicit local CLI arguments, never artifact labels or imported URLs. Validate bounded input before decoding and avoid printing private openings by default.

Add a concise README containing actual commands, public API usage, expected-reference/trust requirements and result meanings. State that the example demonstrates reuse, not a real external customer integration. Runtime CLI JSON is the example's output, not a substitute for implementing these chapter tasks.
</execute_task>

📦 BUILD TASK #13: packages/protocol and packages/sdk distributable artifacts
🛠️ ACTION TYPE: Extend

<execute_task>
Produce buildable package artifacts with explicit exports, declaration files, version metadata and only required runtime dependencies. Preserve existing compatible module/engine conventions; do not add multiple module systems solely for speculative consumers.

Include generated versioned JSON schemas, the compact protocol descriptor, required ABI and API declarations. Keep canonicalisation/domain/limit constants derived from the implementation. Preserve existing licence/notice metadata; do not invent release ownership or claim publication.

Exclude secrets, environment files, application bundles, real evidence, internal deployment credentials, test signing keys and private fixtures from package contents. Remove unintended imports of monorepo-only paths and browser-incompatible globals. Keep mock adapters outside production exports.

Use the package manager's pack operation and inspect actual tarball contents. Install the required tarballs into a clean temporary consumer without workspace aliases, repository source imports or inherited monorepo TypeScript paths. Resolve transitive workspace dependencies through actual packed artifacts.

Run the developer example against those installed packages. Compile a minimal browser consumer and exercise offline verification with real browser Web Crypto. A successful monorepo import alone is insufficient evidence of distributable compatibility.

Keep the public API documentation compact and executable. Reuse generated schemas and established v1 rules rather than writing another architecture guide. Do not upload to a registry, create a release, change an established licence or deploy a site in this chapter.
</execute_task>

📦 BUILD TASK #14: Protocol/SDK adversarial and interoperability tests
🛠️ ACTION TYPE: Create

<execute_task>
Reuse Chapter 2's independently checked literal vectors and Chapter 3's ABI/typed-data fixtures. Run shared cases in Node and a real browser; do not generate expected hashes with the function under test or rewrite golden values during tests.

Cover duplicate/escaped keys, malformed UTF-8/base64url, noncanonical numbers, excessive nesting, unknown fields/versions, size limits, array reordering, mutation races and exact artifact coverage. Verify portable round-trip preserves original bytes and existing exports remain compatible after any module extraction.

Test changed files with unchanged manifest; changed files plus rewritten manifest/opening; wrong chain/registry/reviewer; and a wholly replaced internally consistent bundle. The independently supplied original reference must catch substitution. Without that independent expectation, report the file-declared scope honestly.

Assert reference-only and manifest-only modes never claim full file verification. Assert active on-chain state cannot erase an integrity mismatch, absent signer policy stays unknown, rejected policy stays rejected and unknown profile semantics do not masquerade as validated legal content.

Exercise wrong/missing registry code, protocol version, chain/genesis, mixed checkpoints, changing block hashes, RPC errors, unsupported historical reads, quota/deadline cancellation and stale result generations. not_found must require a successful verified registry read.

Use isolated local Anvil to issue, revoke and supersede receipts through the real registry and read them through the SDK. Cover EOA and deployed ERC-1271 reviewers, permissionless executor different from reviewer, changed ERC-1271 validation after issuance, predecessor mismatch, successor revocation and bounded/cyclic-link fixtures. Never reactivate a predecessor.

Keep local chain keys and deterministic addresses test-only. Local fixture deployment is not a public Monad deployment or live sponsor evidence. Compare SDK reports against actual contract records, not hardcoded mock success.
</execute_task>

📦 BUILD TASK #15: Independent verifier browser and live integration evidence
🛠️ ACTION TYPE: Validate

<execute_task>
Use synthetic packages exported through the actual Chapter 10 flow. Verify the exact exported bytes in a fresh verifier browser context with no LexAegis cookies, account session, Mera state or provider credentials. Test file selection, separate expected reference, result panels, Clear, cancellation, keyboard operation and mobile layout.

Block all non-asset network traffic and demonstrate local verification. Then allow only the configured RPC and prove live checking sends no private bundle content, opening nonce, filenames, artifact hashes or case text. Malicious artifact URLs must never trigger a request.

Make the LexAegis backend, Qwen and Envio unavailable during the independence check. Verify live status directly through the selected RPC when reachable; record network/CORS/capability failures honestly. Do not turn a mock transport or cached result into live evidence.

When genuine Monad testnet deployment and synthetic issued-reference evidence exist, perform bounded read-only checks for available lifecycle examples. Reuse existing approved transactions; this task does not manufacture new approvals or broadcast mutations merely to populate screenshots.

Record observed chain, registry, public references, checkpoint, outcome and test provenance in compact synthetic evidence files. Use safe endpoint identifiers without credentials. Record absent lifecycle/live examples as unverified rather than inventing hashes or timestamps.

Demonstrate the generic example with the packaged SDK in the clean consumer. An internally authored example proves technical portability, not independent developer adoption, practitioner validation, production security or an award win.
</execute_task>

📦 BUILD TASK #16: Chapter 11 build gates and Chapter 12 handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected type/schema checks, lint, protocol/SDK/vault/verifier/web builds, literal-vector tests, local registry integration tests, clean-package consumer checks and focused browser tests. Fix concrete defects without weakening import validation, reference binding or chain-assurance requirements.

Confirm existing Chapter 5/10 readable exports still work unchanged and that generic verification does not import legal schemas/rules. Confirm verification is read-only and offline entry points remain free of network side effects. Verify runtime errors and generated artifacts do not expose secrets or private evidence.

Update docs/build-state.json with implemented public entry points, actual verification modes, package evidence, observed live capabilities and remaining blockers. Distinguish authored examples, scripted/local tests and live observations. Preserve other chapters' records.

Keep CLAUDE.md within 450 words and docs/assistant-ui-contract.md within 1,200 words by replacing stale statements. Record the now-working independent verifier handoff and its exact limits; do not claim that a receipt proves legal correctness or professional identity.

Hand Chapter 12 the full export-to-verifier journey, caller-policy boundaries, recovery/import cases, cancellation/error fixtures and package dependency checks for end-to-end privacy/security validation. Leave production deployment, public package publication and submission assets to Chapter 13.

Stop after Chapter 11. Deliver implementation through repository files; do not replace it with a terminal JSON summary or start the next chapter.
</execute_task>
```
