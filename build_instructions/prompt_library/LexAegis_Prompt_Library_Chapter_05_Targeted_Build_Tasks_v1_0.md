## Chapter 5 — Encrypted Evidence Vault, Stateless Recovery and Portable Export

This chapter gives LexAegis a private place to keep documents, saved Aegis notes and the exact evidence behind each review. It encrypts files in the browser before storing them, restores access with the same passkey after browser storage is cleared, and adds controls to inspect, edit, remove and export saved case context. Users can export encrypted review files or deliberately download a readable package for independent verification. Unlocking the vault does not approve a review.

```text
📦 BUILD TASK #1: Vault dependencies and implementation boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute these tasks sequentially through repository edits. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Use closed schemas, deterministic encodings and stable typed errors. Cryptographic randomness remains mandatory.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and relevant Chapter 1–4 modules. Reuse EvidenceVault, protocol parsers/hashes, account-generation guards, the pinned-credential vault PRF bridge and requireAccountSession. Preserve completed work and unrelated changes.

Implement browser encryption, authenticated ciphertext storage/discovery, editable matter context, immutable review captures, recovery and bounded export/import. Keep cryptographic utilities framework-neutral in packages/vault; put Mera/UI integration in apps/web. Server storage modules must never receive a user key or PRF output.

Preserve Chapter 2 commitments and Chapter 3 receipts. Preserve Chapter 4's exact account derivation, rpId policy and VAULT_PRF_SALT = SHA256(UTF8("lexaegis:vault:root:v1")). Never substitute the account PRF output, wallet key, signature, credential ID or opening nonce for vault entropy.

Use current primary references and installed declarations:
https://www.w3.org/TR/webcrypto/
https://www.rfc-editor.org/rfc/rfc5869
https://mera.category.xyz/reference/get-passkey-prf-output/
https://mera.category.xyz/concepts/security-model/
https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html

Reuse compatible dependencies; add only a maintained S3 client if absent and update the real lockfile. Do not add another backend, password/recovery-seed system, KMS-held user key, document parser, model call or public-chain operation. Full intake, assistant execution and approval remain in Chapters 8–10.
</execute_task>

📦 BUILD TASK #2: packages/vault/src/v1/schemas.ts and encoding.ts
🛠️ ACTION TYPE: Create

<execute_task>
Define closed, version-dispatched Zod schemas outside the generic receipt protocol. Reuse compatible Chapter 2 UUID, address, timestamp, digest, strict-JSON and RFC 8785 JCS utilities without changing their protocol limits.

Freeze CRYPTO_PROFILE = "lexaegis.vault.hkdf-sha256.aes-256-gcm.v1".

VaultDescriptorV1 has exactly:
{schema:"lexaegis.vault-descriptor.v1", vaultId, ownerAddress, rpId, accountProfileId:"lexaegis.evm.bip32-prf.v1", cryptoProfileId:CRYPTO_PROFILE}

VaultObjectHeaderV1 has exactly:
{schema:"lexaegis.vault-object.v1", cryptoProfileId:CRYPTO_PROFILE, vaultId, objectId, ownerAddress, rpId, hkdfSalt, iv}

VaultObjectEnvelopeV1 has exactly:
{header:VaultObjectHeaderV1, ciphertext}

VaultObjectRefV1 has exactly:
{objectId, envelopeSha256, envelopeByteLength}

VaultHeadV1 has exactly:
{revision, catalog:VaultObjectRefV1}

IDs are lowercase UUIDv4; ownerAddress is a nonzero protocol address. rpId follows Chapter 4. revision is a canonical unsigned decimal string <= uint64 max. Lengths use canonical unsigned decimal strings. hkdfSalt, iv and ciphertext use canonical unpadded base64url; decode/re-encode must reproduce the input. Salt is 32 bytes, IV 12 bytes, ciphertext includes a 16-byte authentication tag.

Wire envelopes are exact UTF8(JCS(envelope)); envelopeSha256 hashes those complete bytes, not plaintext. Validate descriptor/header/request binding before decryption. Reject unknown fields, versions, duplicate JSON keys, invalid UTF-8, unsafe values and depth >32.

Bound plaintext artifacts to 10 MiB each; structured catalog/matter/opening/capture payloads to 1 MiB each; wire objects to 16 MiB. Preserve Chapter 2's 128 artifacts and 32 MiB combined artifact limit. Reject oversized input before allocation/decoding where possible; never truncate it.

Define application quotas separately: 16 matters, 2,048 stored/staged objects and 256 MiB stored/staged wire bytes per account vault. These are MVP storage limits, not changes to the receipt protocol. Keep legal names, content hashes, source metadata and package openings out of public headers.
</execute_task>

📦 BUILD TASK #3: packages/vault/src/crypto/browser-crypto.ts
🛠️ ACTION TYPE: Create

<execute_task>
Use browser Web Crypto exclusively for production vault cryptography. Import the trusted 32-byte vault PRF result as a non-extractable HKDF key with deriveKey usage. Keep that handle inside the private vault controller; clear caller-owned PRF buffers in finally. Do not derive or retain an exportable master/data key.

For each new immutable object, generate a fresh UUIDv4, 32-byte hkdfSalt and 12-byte IV using the CSPRNG. Define:
binding = {cryptoProfileId, vaultId, objectId, ownerAddress, rpId}
info = UTF8("lexaegis:vault-object-key:v1") || BYTE(0x00) || UTF8(JCS(binding))
aad = UTF8("lexaegis:vault-object-aad:v1") || BYTE(0x00) || UTF8(JCS(header))
key = HKDF-SHA256(vaultPrfKey, raw hkdfSalt, info), derived as a non-extractable AES-GCM key of 256 bits
ciphertext = AES-GCM(key, raw IV, plaintextBytes, additionalData=aad, tagLength=128)

Use SubtleCrypto.deriveKey/encrypt/decrypt with actual installed DOM types. The concatenation operator means raw bytes; never use hexadecimal text as key material. Store the returned ciphertext including its tag, encoded once as base64url.

Encrypt an owned snapshot of input bytes. Every changed value gets a new object/key derivation/IV. Network retries resend the existing serialized envelope; they never re-encrypt different bytes under an old object ID/key/IV. Production callers cannot supply deterministic randomness; inject test randomness only through test-only adapters.

On read, verify the expected envelope digest/length, header binding and schema, then authenticate/decrypt before exposing any plaintext. Wrong keys, altered headers, swapped objects and failed tags return one redaction-safe integrity/decryption error; do not guess the cause or return partial plaintext.

Release operation keys and clear owned temporary buffers. Non-extractability and best-effort zeroing are not protection against compromised same-origin JavaScript. Do not add custom ciphers, compression, deterministic encryption or plaintext-hash-based object names.
</execute_task>

📦 BUILD TASK #4: apps/web/src/features/vault/vault-controller.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement a tab-local vault controller using Chapter 4's trusted vault PRF bridge. An explicit Unlock vault gesture pins the currently verified credential and VAULT_PRF_SALT. Preload public configuration/discovery state before the gesture; do not trigger an unrelated network wait before WebAuthn.

Bind the controller to selected account, rpId, vault ID and account generation. Validate descriptor ownership against the actual authenticated account. A descriptor or cached address cannot establish ownership. Never offer arbitrary PRF salts or expose key handles to the agent, React stores, callbacks supplied by content or server routes.

Expose public states: unavailable, locked, unlocking, unlocked, saving, recovering and error. Keep backend sign-in, signing-session state, unsaved changes and receipt status separate. Unlocking the vault cannot create/extend a signing session, renew backend login or approve a package.

Use at most 10 minutes absolute and 5 minutes idle vault lifetime; deliberate user interaction alone updates idle activity. Apply Chapter 4 lock/sign-out/account-switch/expiry/page-lifecycle hooks. Recheck generation, cancellation and expiry before and after asynchronous work, including before displaying decrypted data or starting another request.

Lock releases keys, plaintext buffers, decrypted query caches, previews, object URLs, selected private matter data and pending authorisations. Stop active assistant/audio work through existing cancellation hooks when available. BFCache restoration starts locked. Keep sensitive stores out of persistence/devtool serializers; do not place CryptoKey objects in IndexedDB or worker messages.

Serialize mutation operations; invalidate stale results. An in-flight storage request may already have committed after local cancellation: retain no decrypted result, report an unknown save outcome and reconcile after a later explicit unlock. Never promise that Lock reverses remote writes or plaintext already sent to a provider.
</execute_task>

📦 BUILD TASK #5: apps/web/src/server/vault storage repositories and migrations
🛠️ ACTION TYPE: Create

<execute_task>
Extend the existing PostgreSQL layer with vault descriptors, head pointers and object metadata. Enforce one vault per authenticated address/rpId/account-profile tuple; chain ID does not enter vault key derivation or silently create another vault. Keep configured-chain authentication checks from Chapter 4.

Persist only public descriptors, opaque object IDs, owner relationships, ciphertext lengths/digests, revisions, bounded upload state and operational timestamps. Titles, document hashes, extracted text, context, opening nonces and review contents belong inside browser-encrypted objects. Use no plaintext search index.

Store exact wire envelopes in a private S3-compatible bucket via a server-only adapter. Generate storage keys from validated server ownership and opaque IDs; reject user-supplied bucket names, object paths, URLs and ACLs. Use fixed configured endpoints, TLS outside explicit local testing, no public ACLs and no provider credentials in the browser.

Make object writes immutable using conditional create If-None-Match:* or a verified equivalent. A duplicate ID is successful only when exact stored bytes/digest/length match; conflicting bytes fail. An ETag is not the application SHA-256 digest. Validate the chosen provider's actual conditional-write behaviour; do not silently fall back to overwrite.

Reserve quotas atomically in PostgreSQL before upload; account for concurrent and staged writes. Mark an object ready only after actual storage verification. Handle interrupted/uncertain writes idempotently. Do not hold a database transaction open across a network upload.

Advance a head only to a ready owned catalog object, using a database compare-and-swap on expected revision. Increment exactly once; recognise an already-applied identical update. Concurrency conflicts return 409. Create the initial vault/head without exposing a half-initialized vault; a losing creation race must never overwrite/delete the winner.

Fail closed when storage/database configuration or capabilities are missing. Process-local storage is test-only. Do not implement automatic destructive garbage collection or claim note removal erases retained ciphertext/backups. Apply the bounded quotas to unreachable objects too.
</execute_task>

📦 BUILD TASK #6: apps/web/src/app/api/vault routes and browser storage transport
🛠️ ACTION TYPE: Create

<execute_task>
Implement Node route handlers and a typed browser transport:
GET /api/vault — discover this authenticated account's descriptor/head or explicit absence.
POST /api/vault — create a descriptor plus encrypted initial catalog; no overwrite.
GET /api/vault/[vaultId]/head — read the current head.
PUT /api/vault/[vaultId]/head — compare-and-swap expectedRevision to an uploaded catalog reference.
GET /api/vault/[vaultId]/objects/[objectId] — return exact envelope bytes.
PUT /api/vault/[vaultId]/objects/[objectId] — upload one immutable envelope.

Call requireAccountSession on every route. Resolve ownership from the session and database on every resource access; body/header addresses must match but never authorise access. Treat an unknown ID and another account's ID uniformly. Never expose a global vault/object listing.

Preserve no-store responses and Chapter 4 request protections. Require configured Origin, application/json and X-LexAegis-Request:1 for POST/PUT; reject credentialed cross-origin access. Keep the 16 KiB limit for control JSON; use a separate 16 MiB streaming-counted limit for ciphertext-object/initial-catalog requests. Reject oversized chunked bodies too.

Validate raw canonical envelopes and ownership/header/path consistency before storage. Compute digest/length from received bytes. Bound response bodies, request duration and concurrent uploads; apply shared-store rate limits. Propagate AbortSignal where supported. Return closed typed success/error payloads without echoing private input.

Proxy ciphertext through these authenticated routes for this MVP. Do not expose bucket credentials, public objects, arbitrary fetches or long-lived download URLs. Record the 16 MiB route-body requirement for Chapter 13's hosting validation; unsupported hosting must not silently truncate files.

An expired backend session stops network access and offers explicit sign-in. Missing services report unavailable; an outage is never interpreted as an empty vault.
</execute_task>

📦 BUILD TASK #7: packages/vault/src/catalog.ts and immutable save transactions
🛠️ ACTION TYPE: Create

<execute_task>
Define encrypted VaultCatalogV1:
{schema:"lexaegis.vault-catalog.v1", vaultId, revision, previousCatalogDigest, matters:[{matterId, matter:VaultObjectRefV1}]}

Initial revision is "0" and previousCatalogDigest is null; subsequent catalogs increment revision and bind the preceding catalog envelope digest. Require unique matter IDs and validate all references. Catalogs contain no executable code or remote locations.

Create an empty encrypted catalog only after explicit Create vault and a successful authenticated absence check. A concurrent existing vault triggers recovery, never a replacement or automatic key change.

Implement copy-on-write: capture the current head, encrypt/upload changed leaf objects, then changed matter records, then a replacement catalog, then atomically update the head. Never mutate a previously stored object. Preserve the previous readable state until head commit succeeds.

Use complete schema validation and authenticated references when traversing catalog -> matter -> source/capture objects. Compare decrypted catalog revision/vaultId with the selected head/descriptor. Limit traversal, reject cycles, missing objects and inconsistent references, and never fetch imported URLs.

Track save state from actual acknowledgements. On a 409, preserve the local unsaved draft and offer reload/reapply; never silently overwrite another device's changes. On a timeout, inspect the authoritative head before retrying. Reuse captured envelope bytes and opening nonces for the same pending operation.

Detect regression against a head already observed in this session. The encrypted revision chain does not prove global freshness after all local state is lost: a malicious storage service can replay a complete older snapshot. Document that limitation; do not add a blockchain anchor or claim rollback-proof storage.
</execute_task>

📦 BUILD TASK #8: apps/web/src/features/matters encrypted records and Aegis context
🛠️ ACTION TYPE: Create

<execute_task>
Define a closed encrypted MatterRecordV1 containing schema/version, matterId, title, timestamps, source-version descriptors, working context and frozen-capture references. Keep source descriptors bounded and private: documentId, documentVersionId, artifactId, original byte length/hash, media type/label and encrypted object reference. Source bytes are immutable; new content receives a new version ID.

Implement encrypted create/list/open/update operations using Task 7. List decrypted titles only while unlocked. This chapter stores opaque original files and source-version bindings; it does not extract PDF/DOCX text or implement legal analysis.

Define bounded working context with user-confirmed facts, notes, source/version references and explicitly saved concise outcomes. Give entries stable IDs and revision/timestamps. Facts record explicit user confirmation; imported/model-proposed facts remain unconfirmed until accepted. Keep proposals out of confirmed-fact retrieval.

Implement inspect, add, correct, remove and save controls backed by actual encrypted writes. Preserve provenance: edits do not silently claim old confirmation or attach an outcome to another document version. Unresolved source references remain visibly unresolved. Raw chat and unsaved assistant output remain ephemeral by default.

Provide a matter-scoped browser context selector for Chapter 9 returning only requested confirmed entries and relevant version references. Bound an entry to 4 KiB UTF-8 and a selected context payload to 32 KiB; require deliberate selection instead of silently truncating or sending the entire vault. Reuse @lexaegis/agent/contracts where applicable without importing the runtime.

Switching account/matter clears active plaintext context and cancels stale work. A model result cannot write confirmed memory, approve a package or change a source automatically. Removing working context updates the current encrypted record; explain that earlier frozen reviews, exports and retained storage copies are unaffected.
</execute_task>

📦 BUILD TASK #9: packages/vault/src/frozen-review.ts and recoverable-capture gate
🛠️ ACTION TYPE: Create

<execute_task>
Accept only a validated Chapter 2 immutable capture: exact opening, intended ReceiptReferenceV1 and all original artifact bytes. Use its existing nonce/commitment; do not refreeze or regenerate randomness during retry. Validate ownership separately from the manifest's reviewer identity.

Encrypt the opening and artifacts; reuse an existing immutable encrypted artifact only after checking its decrypted exact bytes/hash against this capture. Never use backend plaintext-hash deduplication.

Create an encrypted FrozenReviewV1 with exactly:
{schema:"lexaegis.frozen-review.v1", packageId, receiptReference, opening:VaultObjectRefV1, artifacts:[{artifactId, object:VaultObjectRefV1}]}

Require exact one-to-one coverage of manifest artifact IDs, matching package/reference context and Chapter 2 limits. Save its object reference in the encrypted matter record. These references are immutable snapshots; working-context edits create new records without changing a frozen package.

Before committing the catalog, retrieve every required object through the real storage transport, verify envelope references, decrypt and run the Chapter 2 opening/full-package verification against the expected reference. Compare recovered artifact bytes with the captured manifest. Missing or modified data blocks readiness. After commit, re-read the head and verify the capture remains reachable; reconcile concurrent newer heads without overwriting them.

Expose a private controller-owned recoverable-capture result bound to account/vault generation, package digest, commitment and capture-object digest. Do not accept persisted=true or verified=true from model text, imported JSON or an HTTP caller. After reload/unlock, reconstruct readiness through retrieval and verification.

This gate records a successful persistence/read-back check, not perpetual availability, legal correctness, human approval or an active receipt. Later chapters must combine it with the live-chain and human-review gates before signing. Keep production review signing unavailable here.

Preserve pending capture identity after uncertain network outcomes; discover whether that exact capture committed before retrying. Do not automatically mint another commitment or leave a published receipt dependent on an unverified local-only opening.
</execute_task>

📦 BUILD TASK #10: apps/web/src/features/vault/recovery.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement the complete empty-browser-storage recovery flow:
1. Chapter 4 recovers the same existing passkey/account and authenticates the backend.
2. Discover its descriptor/head from authenticated storage without cached vault IDs or salts.
3. The user explicitly unlocks the vault through the pinned credential and fixed vault PRF namespace.
4. Validate/decrypt the catalog and requested matter objects; verify any requested frozen package before declaring it recovered.

Store every non-secret input needed for decryption with the descriptor/envelope. Do not depend on IndexedDB, localStorage, a previous device's random secret, an LLM, an administrator or the blockchain for private evidence recovery.

Display separate outcomes for unavailable storage, no vault, unsupported PRF, cancelled ceremony, wrong account/credential, unsupported format, missing objects and failed integrity. Authentication/decryption failures must never create a replacement vault or overwrite ciphertext.

A second device must use the same available synced credential under the same configured rpId and compatible PRF support. A new passkey or unrelated origin is not recovery. Account recovery and vault unlock may require separate ceremonies; do not add a one-prompt guarantee.

Allow explicit retry without prompt loops. Recover only requested matter data; do not decrypt the entire account eagerly. Browser caches are optional hints, never the only evidence copy. Keep live receipt status unknown until Chapter 6 supplies an authoritative chain check.
</execute_task>

📦 BUILD TASK #11: packages/vault/src/export.ts and portable bundle schemas
🛠️ ACTION TYPE: Create

<execute_task>
Implement three explicit, versioned JSON exports with strict limits and no network transmission:

EncryptedReviewExportV1:
{schema:"lexaegis.encrypted-review-export.v1", descriptor:VaultDescriptorV1, capture:VaultObjectRefV1, objects:VaultObjectEnvelopeV1[]}
Include exactly the reachable frozen-capture object, opening and artifact objects, deduplicated and sorted by objectId. Verify them before export. Limit to 130 objects and 64 MiB wire input/output. Preserve original ciphertext bytes through canonical encoding. This is an encrypted backup of one review, not of the whole workspace; it still requires the same credential/rpId for decryption.

ReviewExportV1:
{schema:"lexaegis.review-export.v1", receiptReference:ReceiptReferenceV1, opening:CommitmentOpeningV1, artifacts:[{artifactId, bytes}]}
bytes is canonical base64url of exact original bytes, in manifest artifact order. Include every artifact once. Enforce Chapter 2 limits and a 48 MiB encoded bundle limit. No wallet keys, PRF output, signing sessions or vault key material enters an export.

MatterContextExportV1:
{schema:"lexaegis.matter-context-export.v1", matterId, context}
Use the closed Task 8 context schema; cap the file at 1 MiB. Include saved context and its source references only, not raw conversation or document bytes. Make its limited scope explicit.

Readable review/context exports require a dedicated disclosure preview showing the selected contents and explicit Download confirmation. Explain that the file exposes private documents/notes and, for a review, the opening nonce and unsalted hashes; the recipient can copy them. Do not call a complete package selectively disclosed or silently redact it.

Generate files in the browser using safe generic UUID-based filenames. Never use document titles as paths, archive extraction, remote converters or automatic sharing. Revoke object URLs and release plaintext on lock/completion using safe download lifecycle handling. Cancellation prevents subsequent work but cannot recall a completed download.

Keep portable bundle readers framework-neutral. apps/verifier must be able to use the readable format without Mera, LexAegis login or the hosted backend; its full UI integration belongs to Chapter 11.
</execute_task>

📦 BUILD TASK #12: packages/vault/src/import.ts and preview/confirm controller
🛠️ ACTION TYPE: Create

<execute_task>
Parse imports as untrusted data with strict JSON, version, byte/count/depth and base64url limits before expensive work. Reject duplicates, extra/missing artifacts, embedded URLs, unknown fields and unsupported versions. Never execute content, unzip archives or auto-fetch referenced files.

For a readable review bundle, reconstruct exact artifact bytes and run Chapter 2 integrity verification. Distinguish consistency with the bundle's claimed reference from agreement with a separately supplied expected receipt reference. Neither establishes current on-chain status; preserve unknown until a live verifier is available.

For an encrypted bundle, require descriptor/header consistency and the same verified owner/rpId/credential context before using the vault key. Authenticate the capture and all referenced objects, validate the complete graph and then verify the recovered review. Reject unreferenced extras and duplicate object IDs.

Show an import preview; make no persistent changes until the user confirms. Re-encrypt imported data under fresh object IDs/salts/IVs for the destination vault and use the normal verified save/CAS flow. Do not copy ciphertext bound to a different vault into the destination as if it were valid there.

Preserve the original opening, manifest, artifact bytes and reviewer identity. Importing someone else's proof archives it; it does not transfer that reviewer's signing authority or permit approval under a substituted address. Foreign-review imports remain distinct from a newly prepared local review.

Context imports require explicit entry selection/confirmation. Treat imported facts as unconfirmed until the user accepts them, preserve provenance, and mark absent source/version references unresolved. Never silently merge or replace an existing matter, source version or frozen package.

A readable export may be imported/re-encrypted on another application origin using that destination's account. This is data portability, not recovery of the original passkey or signing identity. No key-export, password recovery or cross-origin WebAuthn bypass is implemented.
</execute_task>

📦 BUILD TASK #13: apps/web/src/features/vault Aegis HUD integration
🛠️ ACTION TYPE: Extend

<execute_task>
Connect the existing HUD to real vault/context controllers. Add Create vault, Unlock vault, Lock, Recover, Save context, encrypted review export, readable review export, context export and Import controls where relevant. Keep destructive replacement absent; removal applies only to selected working-context entries.

Use the left matter rail for decrypted matters, source versions and saved context. Provide an inspect/edit panel with confirmation/provenance labels and unresolved-reference states. Add a compact vault/recovery panel in both Command-centre and Review modes. Preserve selected document/clause across view switches while unlocked.

Render actual progress: Awaiting passkey, Unlocking vault, Saving encrypted files, Checking saved package, Saved, Unsaved changes, Conflict, Locked and Recovery failed. The orb reflects those controller events without inventing AI activity. Keep account, backend, vault, transaction and indexer indicators separate.

Show export disclosure previews and import contents before confirmation. Disable operations whose storage/authentication/lock prerequisites are missing. A frozen capture can display Saved and checked without displaying Approved or Confirmed. Do not expose a production signing button yet.

Preserve obsidian/cobalt/cyan styling, text/icon labels, keyboard focus, screen-reader announcements, reduced motion and mobile layout. Never render imported legal/model text as executable HTML. Mask private panels immediately on lock/account switch and clear their backing state.

Expose redaction-safe public state events to future Aegis integration. The assistant may explain a vault state and propose context changes; it cannot unlock, obtain keys, confirm a disclosure, persist a fact or approve a review. Defer voice/agent execution to Chapters 9–10.
</execute_task>

📦 BUILD TASK #14: Vault, storage, privacy and portability tests
🛠️ ACTION TYPE: Create

<execute_task>
Use Vitest, Playwright, real Web Crypto and synthetic fixtures. Validate the meaningful boundaries:
- Reproducible HKDF/AES-GCM synthetic vectors checked against an independent maintained implementation; exact encoding/AAD and full round-trip bytes.
- Wrong PRF, modified header/ciphertext/tag, swapped owner/vault/object, malformed base64url, unknown version and oversized input fail before plaintext release.
- Distinct account/vault namespaces; no random replacement keys; retries reuse an envelope and edits create new envelopes.
- Lock/expiry/BFCache/account switch cancel stale decryption, clear private UI/state and invalidate pending gates.
- Cross-account ID access, unauthenticated requests, origin spoofing and client-supplied ownership cannot read/write another vault.
- Actual PostgreSQL quota/CAS races and actual S3-compatible conditional-create behaviour; duplicate exact retry succeeds, changed-byte overwrite fails, outage/partial upload never becomes a saved capture.
- Concurrent device updates preserve the committed head; uncertain acknowledgements reconcile without regenerating a nonce or silently losing edits.
- Frozen opening/artifact round-trip reproduces the Chapter 2 commitment; working-context changes cannot alter that capture.
- Export/import preserves exact bytes, rejects incomplete/extra/tampered data, requires disclosure/import confirmation, and preserves foreign reviewer identity.
- Context isolation, confirmation/provenance, unresolved source links and ephemeral chat defaults.

Use secret/plaintext sentinels to inspect browser persistence, network requests, database/object contents, console and error telemetry: only ciphertext plus allowlisted public metadata reaches storage. Disclosed downloads are deliberate plaintext outputs. No PRF/key/CryptoKey persists. Keep test fixtures and mocks out of production entry points.

Run focused real database/object-store integration checks where services are available; record unavailable checks without relabelling mocks as live evidence. Do not broaden tests beyond unresolved risks or existing required gates.
</execute_task>

📦 BUILD TASK #15: Chapter validation, recovery demonstration and handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run relevant lint, typecheck, tests and production builds; repair Chapter 5 failures without changing the protocol/account derivation. Check browser/server import boundaries, actual object-body limits and truthful readiness when dependencies are missing.

With synthetic documents and available user-controlled supported hardware:
1. Sign in, explicitly unlock/create the vault, save a matter/context and a structurally valid synthetic frozen package. Do not label it a completed legal review or on-chain receipt.
2. Reload/lock; confirm private content is inaccessible until recovery/unlock.
3. Clear only this application's browser storage/cookies, keep the passkey, recover the same account and decrypt the saved matter and exact package from remote ciphertext.
4. Repeat on a supported second device/profile using the same synced credential where available; verify artifact bytes and commitment, not just the displayed address.
5. Export/import an encrypted review and a readable review; verify expected identity/integrity and demonstrate explicit disclosure controls.

Never delete the passkey or unrelated browser data. Record actual browser/OS/authenticator, account/vault ceremony counts, taps and elapsed times. A mock or fresh-profile test is not proof of a separate synced-device test; unavailable hardware/services remain explicitly unverified.

Update docs/build-state.json with implemented modules, schema/crypto profiles, resolved dependencies, evidence paths, actual results and remaining integration requirements. Update docs/assistant-ui-contract.md with working vault/context controls and later assistant/approval hooks. Keep CLAUDE.md <=450 words and the UI contract <=1,200 words.

Record concise privacy facts: stored evidence is browser-encrypted; the service still observes account/object sizes/timing; selected plaintext analysis later reaches the backend and Qwen only through its explicit consent flow; compromised same-origin code can access unlocked data; recovery needs the original usable credential/rpId and surviving ciphertext. Do not claim zero-knowledge AI, guaranteed erasure, global rollback resistance or completed security auditing.

Hand off the recoverable-capture gate to Chapters 6 and 10, source/context storage to Chapters 8–9, portable bundle contracts to Chapter 11 and real-device recovery evidence to Chapter 12. Stop after Chapter 5. Do not deploy, fund accounts, invoke Qwen or begin Chapter 6.
</execute_task>
```
