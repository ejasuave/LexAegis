## Chapter 2 — Receipt Format, Canonical Hashing and Private Commitments

This chapter creates a precise record of what was reviewed. It fingerprints each file, binds the evidence and decisions together, and produces a randomized reference for the blockchain. It also detects changed or missing files. A shared JSON formatting scheme makes the review-package fingerprint reproducible across applications.

```text
📦 BUILD TASK #1: Existing protocol package and Chapter 1 dependencies
🛠️ ACTION TYPE: Validate

<execute_task>
Implement Chapter 2 only, executing these tasks sequentially through repository edits. Do not return a proposed implementation, architectural essay or JSON status report.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json and the relevant protocol/SDK source. Confirm the Chapter 1 workspace and shared schemas exist and compile. Repair small compatibility issues without replacing working infrastructure; if the foundation is absent, record that dependency and do not claim completion.

Preserve unrelated changes. Keep all protocol functions usable in browsers and Node.js without Next.js, Mera, Qwen, network access or a LexAegis backend.

This chapter implements private review packages, reproducible hashing and commitment-opening checks. It does not implement signatures, transaction replay protection, contracts, encryption, document extraction or legal correctness checks.

Consult primary specifications when implementing:
https://www.rfc-editor.org/rfc/rfc8785
https://www.rfc-editor.org/rfc/rfc7493
https://www.w3.org/TR/webcrypto/
Use maintained compatible libraries where appropriate and pin actual resolved dependencies. Do not invent cryptographic primitives.
</execute_task>

📦 BUILD TASK #2: packages/protocol/src/v1/constants.ts and primitives.ts
🛠️ ACTION TYPE: Create

<execute_task>
Define immutable protocol identifiers:
PACKAGE_SCHEMA = "lexaegis.review-package.v1"
REFERENCE_SCHEMA = "lexaegis.receipt-ref.v1"
OPENING_SCHEMA = "lexaegis.opening.v1"
PACKAGE_DOMAIN = "lexaegis:review-package:v1"
COMMITMENT_DOMAIN = "lexaegis:review-commitment:v1"

Create strict wire validators:
- UUID: lowercase UUIDv4.
- Address: lowercase 0x-prefixed 20-byte hexadecimal; reject the zero address for registry/reviewer fields.
- Digest and blinding nonce: lowercase 0x-prefixed 32-byte hexadecimal.
- Unsigned decimal string: "0" or a nonzero digit followed by digits; no leading zeros, signs, whitespace or exponent notation.
- Chain ID: positive unsigned decimal string <= 2^256 - 1.
- Timestamp: valid UTC date/time with exactly millisecond precision, YYYY-MM-DDTHH:mm:ss.sssZ.
- Profile ID: 1–80 lowercase ASCII letters, digits, dots or hyphens.
- Profile version: positive canonical decimal string.

These are protocol-specific refinements of Chapter 1 primitives. Do not silently lowercase, trim, fill defaults or coerce invalid imported values.

Apply shared limits:
- Manifest/opening JSON input: 1 MiB each.
- Nesting depth: 32.
- Artifacts: at most 128.
- Individual artifact: at most 10 MiB.
- Combined artifact bytes: at most 32 MiB.

Check limits before expensive parsing, copying or hashing. Return stable typed errors; never truncate content to fit.
</execute_task>

📦 BUILD TASK #3: ArtifactRefV1 and ReceiptReferenceV1 schemas
🛠️ ACTION TYPE: Create

<execute_task>
Create closed Zod schemas in packages/protocol/src/v1.

ArtifactRefV1 has exactly:
{id, role, mediaType, label, byteLength, sha256}

Use UUID IDs; label is null or a string <=256 characters; byteLength is an unsigned decimal string subject to the artifact limit; sha256 identifies the exact original artifact bytes. Validate a bounded lowercase MIME type.

Allowed roles:
source, extracted-text, evidence, analysis, calculation, rule-pack, checklist, agent-config, decision-log.

ReceiptReferenceV1 has exactly:
{
  schema: REFERENCE_SCHEMA,
  chainId,
  registryAddress,
  reviewerAddress,
  commitment
}

Use the strict validators from Task 2. The tuple chain/registry/reviewer/commitment identifies the intended receipt. Do not introduce a globally authoritative ID derived from commitment alone.

Only the explicit ReceiptReferenceV1 projection is suitable for public use. Artifact labels, plain content hashes and subsequent opening material remain private.

Do not add signatures, transaction receipts, block timestamps or claimed active status. This reference does not establish an actual receipt's existence.

Keep schemas closed and version-dispatched. Reject unsupported versions rather than stripping unfamiliar fields or interpreting them as v1.
</execute_task>

📦 BUILD TASK #4: ReviewPackageV1, CommitmentOpeningV1 and legal profile presence checks
🛠️ ACTION TYPE: Create

<execute_task>
Implement ReviewPackageV1 with exactly:
{
  schema: PACKAGE_SCHEMA,
  packageId: UUID,
  preparedAt: canonical UTC timestamp,
  profile: {id: profile ID, version: profile version},
  context: {
    chainId: chain ID,
    registryAddress: address,
    reviewerAddress: address
  },
  supersedes: ReceiptReferenceV1 or null,
  artifacts: ArtifactRefV1[],
  approval: {
    intent: "approve-review-package",
    scopeArtifactIds: UUID[],
    decisionLogArtifactId: UUID
  }
}

Require unique artifact IDs, at least one source and exactly one decision-log artifact. Require unique scope IDs covering every artifact exactly once. decisionLogArtifactId must resolve to the decision-log artifact. Reject dangling references. Preserve array order; it is committed data.

If supersedes is present, its chain, registry and reviewer must match context. This declares an intended predecessor; it does not establish that predecessor's existence or status.

Implement CommitmentOpeningV1 with exactly:
{
  schema: OPENING_SCHEMA,
  manifest: ReviewPackageV1,
  blindingNonce
}

Use Task 2 validators. The manifest, its unsalted hashes and the opening nonce are private opening material. preparedAt is a supplied application timestamp, not proof of when a review occurred.

Place the legal reference profile check in apps/web/src/domain/legal/profile.ts, outside the protocol core. For profile "lexaegis.employment-settlement.ew", version "1", require source, extracted-text, analysis, calculation, rule-pack, checklist, agent-config and decision-log roles. Evidence attachments may be absent when the checklist records missing evidence.

Treat this check as structural completeness only. Chapters 8–10 own artifact payload schemas, finding/decision relationships and human review controls. Hashing an artifact does not validate its business contents.

Keep legal rules out of the generic protocol. Exclude storage URLs, encryption keys, wallet secrets, transaction hashes and signature fields from ReviewPackageV1. Reject unknown fields and unsupported schema versions.
</execute_task>

📦 BUILD TASK #5: packages/protocol/src/v1/parse-json.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement strict raw JSON import before schema validation.

Decode UTF-8 with fatal error handling. Reject a byte-order mark, malformed UTF-8, duplicate property names within any object, comments, trailing commas, trailing content and excessive nesting.

Use a parser/tokenizer that exposes member names before duplicate information is lost. Microsoft jsonc-parser is acceptable when configured for strict JSON and every parse error is fatal. Inspect its documented API. Do not rely on JSON.parse alone or regular expressions to detect duplicate keys.

Reject unsafe integer literals and non-integer numeric tokens in protocol envelopes. Financial amounts, chain IDs and byte lengths use strings. Preserve decoded string contents exactly; reject lone UTF-16 surrogates.

For object-input APIs, accept only ordinary JSON data. Reject undefined, bigint, functions, symbols, non-finite numbers, negative zero, sparse arrays, cycles, accessors, custom prototypes and custom toJSON behavior. Reject prototype-manipulation property names.

Validate every object against the closed protocol schemas. Treat imported text and labels as inert data; never execute them or fetch embedded locations.

Return redaction-safe errors without echoing private payloads.
</execute_task>

📦 BUILD TASK #6: packages/protocol/src/v1/canonicalize.ts and hashes.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement canonicalizeReviewPackage using an RFC 8785 JSON Canonicalization Scheme implementation after strict validation.

Use recursive UTF-16 code-unit property ordering, preserve array order, preserve Unicode without normalization and emit UTF-8 without a byte-order mark. Do not substitute ordinary JSON.stringify, locale-dependent sorting or a top-level-only key sorter.

Define these exact byte operations:
artifactDigest = SHA256(originalArtifactBytes)
canonicalBytes = UTF8(JCS(validatedManifest))
packageDigest = SHA256(
  UTF8(PACKAGE_DOMAIN) || BYTE(0x00) || canonicalBytes
)

The symbol || means raw-byte concatenation. BYTE(0x00) is one zero byte. Do not hash hexadecimal text in place of decoded bytes.

Use Web Crypto SHA-256 through crypto.subtle.digest. Wire digests are lowercase 0x-prefixed hexadecimal; internal digests are 32-byte arrays. Fail explicitly when cryptographic APIs are unavailable.

Hash documents exactly as uploaded, without text extraction, line-ending changes or PDF rewriting. Structured artifacts are also verified against their exact stored bytes; do not reserialize them during verification.

Implement describeArtifact to compute byteLength and sha256 from actual bytes rather than accepting unverified caller claims.
</execute_task>

📦 BUILD TASK #7: packages/protocol/src/v1/commitment.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement this exact v1 commitment:
commitment = SHA256(
  UTF8(COMMITMENT_DOMAIN) ||
  BYTE(0x00) ||
  blindingNonceBytes32 ||
  packageDigestBytes32
)

Use exactly the domains and encoding from Tasks 2 and 6. Reject incorrect byte lengths. Do not replace SHA-256 with Keccak, hash a hex string, or use ambiguous string concatenation.

Generate each new production opening nonce with crypto.getRandomValues(new Uint8Array(32)). Never use Math.random, timestamps, document hashes, wallet signatures, Mera account keys or PRF outputs as the nonce.

The nonce blinds the commitment; it is not an encryption key, WebAuthn PRF namespace or transaction replay nonce.

Keep the opening nonce with the private package. Chapter 5 must preserve it inside encrypted storage before a later chapter publishes the receipt. Never put it in logs, analytics, URLs, public RPC requests or public receipt projections.

Reuse the same prepared package and nonce for retries of the same intended approval. Generate a fresh nonce when deliberately preparing a new approval.

Provide deterministic computation from an explicit nonce for opening verification and fixed test vectors. Do not expose a production configuration that switches random generation to a fixed seed.

This mechanism is a randomized hash commitment, not encryption, a zero-knowledge proof or a claim of anonymous chain activity.
</execute_task>

📦 BUILD TASK #8: packages/protocol/src/v1/prepare.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement prepareReviewPackage(manifestInput, artifactBytesById).

Validate the manifest and artifact limits. Require exactly the referenced artifact set: reject missing, duplicate and extra entries. Recompute every byte length and digest; reject discrepancies rather than rewriting the manifest to match supplied files.

Before the first asynchronous operation, capture independent copies of validated metadata and supplied bytes. Reject SharedArrayBuffer-backed input and handle detached buffers as invalid input. Prevent caller mutation during hashing from changing the prepared snapshot.

Canonicalize the captured manifest, calculate its package digest, generate a fresh blinding nonce and calculate the commitment. Construct ReceiptReferenceV1 from the captured context and commitment using an explicit field allowlist.

Return an encapsulated prepared snapshot containing the opening, package digest, public reference and captured artifacts. Deep-freeze ordinary metadata and expose defensive byte copies. TypeScript Readonly alone is insufficient; do not attempt to freeze nonempty typed arrays with Object.freeze.

The prepared snapshot is not an approved or issued receipt. Do not sign, publish, persist plaintext or change the application workflow to confirmed.

An edit to source bytes, findings, decisions, rule data, model configuration, scope or context requires a new preparation and later human approval. Subsequent signing code must consume the captured snapshot rather than reconstructing it from mutable UI state.
</execute_task>

📦 BUILD TASK #9: packages/protocol/src/v1/verify.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement verifyManifestOpening(openingInput, expectedReceiptReference) and verifyReviewPackage(openingInput, artifactBytesById, expectedReceiptReference).

Require an expected reference supplied by the caller. Compare manifest context with its chain, registry and reviewer, then recompute canonical bytes, package digest and commitment. Never trust a digest merely because an imported package declares it.

Manifest-only verification checks the opening against the expected commitment. It does not establish the contents or availability of omitted artifacts.

Full verification additionally checks every referenced artifact's actual byte length and digest. Missing files produce unknown artifact integrity with explicit missing-input errors; altered files produce mismatch. Reject uncommitted extra files instead of treating them as approved evidence.

Return separate typed fields:
- manifestIntegrity: match, mismatch or unknown.
- artifactIntegrity: match, mismatch or unknown.
- chainStatus: unknown.
- signerAcceptance: unknown.
- Safe issue codes and opaque affected artifact IDs when necessary.

Malformed inputs return typed failures. A context mismatch must never produce a successful manifest match. Do not collapse results into a generic valid=true flag.

No function in this chapter establishes signature authorization, receipt existence, current lifecycle state or professional identity. Those require later live chain reads and caller policy.

V1 supports full-package disclosure. Redacted bytes do not verify as the original artifact; redaction creates a different package requiring a new approval. Do not claim selective disclosure.

Perform no network access, automatic evidence download or legal-content evaluation.
</execute_task>

📦 BUILD TASK #10: Protocol exports, SDK interfaces and machine-readable schemas
🛠️ ACTION TYPE: Extend

<execute_task>
Export versioned schemas, types and implemented pure functions from packages/protocol. Extend packages/sdk to consume or re-export these implementations without duplicating hashing logic.

Replace Chapter 1 placeholders only for capabilities actually implemented here. Keep contract reads, signing, submission and lifecycle operations explicitly unavailable.

Generate JSON Schema draft 2020-12 artifacts from the source schemas for ReviewPackageV1, ArtifactRefV1, ReceiptReferenceV1 and CommitmentOpeningV1. Include stable identifiers and closed-object constraints. Preserve runtime refinements that JSON Schema cannot fully express; test them separately.

Create a compact machine-readable protocol descriptor recording domain strings, algorithm names, byte encodings, limits and schema versions. Derive constants from the implementation so the descriptor cannot silently drift.

Record compatibility rules:
- Storage location and ciphertext changes do not alter a commitment when recovered plaintext bytes and the opening remain identical.
- Any alteration of committed metadata or artifact bytes changes the committed package.
- Hashing or wire-format changes require a new protocol version.
- Unknown versions are rejected.
- Chain authorization and replay protection belong to Chapter 3, not this hash algorithm.

Keep browser bundles free of Node-only crypto imports, provider credentials and server dependencies. Do not enable the unfinished verifier UI or claim sponsor integrations are complete.
</execute_task>

📦 BUILD TASK #11: fixtures/protocol-v1 and protocol interoperability tests
🛠️ ACTION TYPE: Create

<execute_task>
Create small, clearly synthetic fixtures for:
- A generic review package.
- A structurally complete legal reference package.
- A revised document and a package declaring a predecessor.

Use test-only addresses, documents, review decisions and fixed opening nonces. Never describe fixtures as real lawyer approvals, Qwen runs or on-chain receipts.

Commit literal expected canonical UTF-8 bytes, artifact digests, package digests, commitments and public references. Obtain expected canonical output from an independent RFC 8785 implementation or independently checked literal examples; compute expected SHA-256 values with Node's crypto module in a fixture-generation utility. Do not generate expected results with the function under test or rewrite vectors during tests.

Implement meaningful tests covering:
- Object key insertion order does not change canonical package bytes.
- Array order and Unicode composition differences remain significant.
- Different nonces produce different commitments for an otherwise identical package.
- Changed document bytes, findings/decision artifacts, labels, scope, profile, model-config artifacts, rule-pack artifacts, predecessor or context invalidate the original opening/reference.
- Wrong or missing nonce, wrong chain/registry/reviewer, unsupported version and malformed hex are rejected.
- Duplicate/escaped-equivalent keys, unsafe numbers, lone surrogates, unknown fields, oversized input and excessive nesting fail closed.
- Artifact-set completeness, duplicate IDs and unresolved references are enforced.
- Mutation before/during hashing and mutation of returned byte copies cannot alter the captured snapshot.
- Manifest-only verification never claims artifact or chain verification.
- Public projection contains none of the opening nonce, document hashes, labels, manifest or package digest.
- Production nonce generation uses the cryptographic random API and has no predictable fallback.

Run shared vectors in Node.js and a real Chromium browser using a minimal Playwright protocol harness. Use the actual browser Web Crypto implementation, not a mock. Keep the harness outside production routes. Add a dedicated script for this focused interoperability check.
</execute_task>

📦 BUILD TASK #12: Chapter 2 validation, CI and build-state continuity
🛠️ ACTION TYPE: Validate

<execute_task>
Run actual lint, typecheck, protocol unit tests, browser interoperability tests and production builds for both applications. Add the focused protocol checks to CI without disabling Chapter 1 gates.

Resolve failures within this chapter. If the environment prevents a check, record the precise blocker and mark it unverified; do not simulate browser results or remove the requirement.

Confirm:
- Both runtimes reproduce the committed test vectors.
- All referenced bytes participate in the package commitment through validated artifact digests.
- Public receipt projection excludes private opening material.
- Pure verification cannot report chain authorization or active receipt status.
- Both applications still build while future integrations remain unavailable.
- The diff contains no credentials or real case material.

Update docs/build-state.json with the v1 schemas, exact commitment formula, public/private boundary, fixture locations, commands and observed results. Keep CLAUDE.md concise and point it to these records.

Record the later dependency: encrypted preservation of the exact opening and artifact bytes must precede receipt publication. Chapter 3 must authorize the reviewer, bind chain/registry/action, prevent replay and implement lifecycle rules; matching hashes alone do none of these.

Mark Chapter 2 complete only after its required checks pass. Keep remaining chapters pending. Stop here; do not deploy contracts, invoke models, publish receipts or begin Chapter 3.
</execute_task>
```
