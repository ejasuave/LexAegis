## Chapter 4 — Mera Passkeys, Signing Sessions and Account Recovery

This chapter gives LexAegis working passkey accounts, secure sign-in and temporary signing sessions. It connects account creation, recovery, locking and sign-out to the Aegis interface. Users can recover the same account after clearing browser storage, provided they still have the same working passkey. Approving a review remains a separate action.

```text
📦 BUILD TASK #1: Chapter dependencies and account integration boundary
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute these tasks sequentially through repository edits. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Use strict schemas at data boundaries and compact factual repository records.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and relevant Chapter 1–3 modules. Confirm the v2.2 assistant/UI requirements are present; reconcile missing additive interfaces without rebuilding working modules. Preserve unrelated changes and completed work.

Keep Chapter 2 package schemas and SHA-256 commitments, Chapter 3 ABI, EIP-712 domain and receipt lifecycle unchanged. Mera is the reference application's only account provider. Its derived EVM account uses the registry's existing EOA signature path; do not add a smart account, bundler, paymaster, P-256 contract or alternate wallet.

Implement account creation/recovery, memory-only signing sessions, authenticated backend access, restricted review signing and account UI. Chapter 5 owns vault encryption and evidence recovery; Chapter 6 owns public Monad transactions/funding; Chapters 9–10 own assistant execution and complete review approval.

Use current primary references and installed package declarations:
https://github.com/category-labs/mera
https://mera.category.xyz/recipes/create-passkey-accounts/
https://mera.category.xyz/reference/create-passkey-with-prf-output/
https://mera.category.xyz/reference/get-passkey-prf-output/
https://mera.category.xyz/reference/to-viem-account/
https://mera.category.xyz/concepts/security-model/
https://github.com/paulmillr/scure-bip32
https://eips.ethereum.org/EIPS/eip-4361

Do not invent SDK methods, dependency versions, compatibility results or account-recovery guarantees.
</execute_task>

📦 BUILD TASK #2: Mera dependencies and relying-party configuration
🛠️ ACTION TYPE: Create

<execute_task>
Install compatible pinned versions of @category-labs/mera and @scure/bip32; reuse viem. Use maintained SIWE parsing/verification helpers from compatible existing dependencies or the official siwe package. Update the genuine lockfile. Record exact resolved versions and API evidence in docs/build-state.json. Mera is a preview dependency; do not label it independently audited or silently follow a moving version.

Place the browser account implementation under apps/web/src/features/account. Keep it out of server imports and the framework-neutral SDK. Reuse the AccountProvider port from Chapter 1.

Validate the configured application origin, WEBAUTHN_RP_ID and intended chain. Require HTTPS outside explicit localhost development. For this MVP, use the exact application hostname as rpId; reject wildcard/parent-domain expansion and an origin mismatch. Include ports in origin comparisons, never in rpId.

Use a stable configured production origin. Keep localhost/test credentials separate; do not claim a credential created for an ephemeral preview domain will recover on the final domain. No domain changes or deployment are performed here.

Check secure context, navigator.credentials, PublicKeyCredential and required Web Crypto capabilities. Feature detection is preliminary: only a successful ceremony establishes usable PRF support. Preserve passkey-provider choice; do not force a platform authenticator or reject a valid external/synced credential based on a platform-only probe.

Expose structured unsupported, cancelled, failed and available states. Never fall back to a server-held key, random replacement account, seed phrase, extension wallet or email/OTP flow.
</execute_task>

📦 BUILD TASK #3: apps/web/src/features/account/derivation-profile.ts
🛠️ ACTION TYPE: Create

<execute_task>
Freeze this application-owned v1 recovery profile:
PROFILE_ID = "lexaegis.evm.bip32-prf.v1"
ACCOUNT_PRF_SALT = SHA256(UTF8("lexaegis:account:evm:v1"))
VAULT_PRF_SALT = SHA256(UTF8("lexaegis:vault:root:v1"))
EVM_PATH = "m/44'/60'/0'/0/0"

Salts are exactly 32 raw bytes. ACCOUNT_PRF_SALT is supplied explicitly on both creation and recovery. Reserve VAULT_PRF_SALT for Chapter 5's separate encryption namespace. These public salts are distinct from Chapter 2's random private blinding nonce.

Resolve validated configuration and public salt bytes before a user's click so the passkey ceremony begins directly from the gesture, without an unrelated network wait.

The derivation is: account PRF output -> BIP-32 master seed -> EVM_PATH -> secp256k1 key. Use the 32-byte PRF output directly as HDKey.fromMasterSeed input. Do not insert BIP-39 conversion, derive from an address/credential ID, reinterpret hex text as seed bytes, or change the path between sessions. This is LexAegis's specified scheme, not a claim about Mera's default derivation.

Define a closed versioned PublicAccountProfile schema containing only schema/profile ID, rpId, canonical credentialId, optional authenticator transports and derived lowercase EVM address. Bound strings and arrays; reject unknown fields and unsupported profiles. Reuse protocol address validation.

An optional browser cache may contain this public profile only. Treat it as an untrusted discovery hint, never proof of account control. Recovery must not require the cache, a cached random salt, a remembered user ID or backend availability.

No chain ID, registry address, display label or backend database ID enters the private-key derivation. Runtime signing still validates its own chain/domain. Future derivation changes require an explicit new profile; never change v1 in place.
</execute_task>

📦 BUILD TASK #4: apps/web/src/features/account/mera-passkeys.ts
🛠️ ACTION TYPE: Create

<execute_task>
Wrap the actual Mera APIs:
- createPasskeyWithPrfOutput from @category-labs/mera.
- getPasskeyPrfOutput from @category-labs/mera.

Create only after the user chooses Create account. Supply the configured relying party, non-sensitive account labels and ACCOUNT_PRF_SALT. Let Mera generate the credential's user handle; do not reuse a fixed handle. Validate the returned credential metadata, evaluated salt and 32-byte PRF output.

Recover/unlock using getPasskeyPrfOutput with the same rpId and salt. When a known account is selected, pass its credential metadata and reject an unexpected credential. When recovering after storage clearance, omit that restriction and allow discoverable credential selection. Do not automatically create an account when recovery fails.

Serialize ceremonies: double clicks must not create concurrent requests. Use a generation counter so late results after cancellation, account switch, navigation or sign-out are discarded and sensitive buffers cleared. Use documented cancellation support where available; never claim cancellation removed a credential already created by the authenticator.

Creation may internally require an additional assertion when create-time PRF evaluation is unavailable. Do not add an unnecessary assertion when creation already returned usable output. Record actual behaviour rather than promising one prompt on every device.

Map installed Mera error codes, including PRF_UNAVAILABLE, PASSKEY_OPERATION_FAILED, INPUT_INVALID and CRYPTO_UNAVAILABLE, into redaction-safe application errors. Distinguish confirmed cancellation from unknown failure; do not infer the precise cause from a broad SDK error code.

A failed creation may leave a passkey behind. Offer an explicit recovery attempt and an explanation; never loop account creation silently. Keep PRF output out of logs, errors, React state, network payloads and storage.
</execute_task>

📦 BUILD TASK #5: apps/web/src/features/account/derive-account.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement the fixed Task 3 derivation using @scure/bip32. Pass the derived private-key bytes to createSecp256k1SigningSession from @category-labs/mera. Use getEvmAddress(session.publicKey), and adapt signing through toViemAccount from @category-labs/mera/viem.

Verify the Mera and viem views yield the same address. Normalize newly derived addresses for protocol storage; use the format required by the maintained SIWE formatter when constructing login messages.

Keep the raw Mera session and viem account private to the account controller. UI consumers receive public identity/status and narrowly scoped operations, never a raw signer, private key or arbitrary signDigest method.

After Mera copies the key, clear caller-owned private-key/PRF buffers in finally blocks. Wipe owned HD nodes using the installed library's supported method and clear caller-owned byte copies. Never serialize an HDKey, extended private key, seed or chain code. Drop all secret references on failure.

Test derivation with committed synthetic input/output vectors. Real user secret material never enters fixtures. Invalid derivation fails explicitly; never substitute a random key or silently increment the path.

Buffer wiping reduces exposure; JavaScript does not guarantee erasure of every engine/library copy. Treat same-origin scripts and dependencies as capable of accessing software keys. Do not describe this session as a hardware-isolated wallet key.
</execute_task>

📦 BUILD TASK #6: apps/web/src/features/account/session-controller.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement a tab-local memory-only controller with explicit account/ceremony/session states. Publish immutable public snapshots; keep key-bearing objects outside React stores, persisted state, globals and developer-tool serializers.

Default session limits: 10 minutes absolute lifetime and 5 minutes without a deliberate user interaction. Do not extend the absolute limit or refresh activity from background polling. Check limits before every signature and after asynchronous work; timers alone are insufficient after suspension. Detect clock rollback/resume anomalies conservatively.

End the Mera session on explicit Lock, Sign out, account switch, expired session and page teardown. Handle pagehide/pageshow so a back-forward-cache restore cannot revive an old signing session. Clear pending authorisations and release controller references. Signing after end must fail and require a fresh passkey ceremony.

Every asynchronous request captures the controller generation. Recheck generation, account, cancellation and expiry before releasing a signature; discard late results after a lock or account change. Serialize signing operations so duplicate UI actions cannot race.

Permit only application-controlled login signing and exact registry-action signing. Scope checks are enforced by LexAegis code around an ordinary EOA key; they are not on-chain session-key restrictions or protection against a compromised page.

Keep local signer state, backend authentication, vault lock and blockchain receipt state separate. Lock clears local signing authority and emits a hook for Chapter 5 to clear vault material. Sign out also revokes the backend session when reachable. Report an offline revocation failure honestly; local locking must still succeed.

Cross-tab messages may contain public invalidation notifications only, never keys or signatures. Another tab starts without a signer and must unlock independently. Revalidate backend identity after account/session changes; do not merge two accounts' working context.
</execute_task>

📦 BUILD TASK #7: apps/web/src/server/auth/store.ts and PostgreSQL auth migration
🛠️ ACTION TYPE: Create

<execute_task>
Create minimal persistent authentication storage using the existing PostgreSQL conventions. Reuse the database layer if present; otherwise add one small maintained driver and a reproducible migration. Do not introduce another backend framework or Redis.

Store only:
- Pending sign-in challenges: unpredictable ID, intended address/chain, exact canonical message, expiry, pre-auth binding hash and consumption state.
- Login sessions: hash of a random bearer token, authenticated address/chain, creation/expiry and revocation state.

Use CSPRNG nonces with at least 128 bits of entropy; use 256-bit random session tokens. Bound challenge lifetime to 5 minutes and backend session lifetime to 15 minutes without silent renewal. Store session-token hashes, never plaintext bearer tokens. These backend sessions are not Mera signing sessions and contain no user signing/decryption material.

Consume a challenge and create its session atomically after successful signature validation. Concurrent verification of one challenge must produce at most one authenticated session. Expired, consumed or mismatched challenges fail without issuing a token.

Bind challenges to a server-issued pre-auth browser cookie to prevent login swapping. Support bounded cleanup of expired records and shared-store rate limiting for challenge/verification attempts. Do not rely on process-local maps for deployed authentication state.

Provide an injectable test store only in tests. Missing database configuration leaves protected endpoints unavailable; it never enables a development bypass in production. Keep process liveness independent from authentication readiness.
</execute_task>

📦 BUILD TASK #8: apps/web/src/app/api/auth and account login client
🛠️ ACTION TYPE: Create

<execute_task>
Implement POST /api/auth/challenge, POST /api/auth/verify, GET /api/auth/me and POST /api/auth/logout using Node route handlers and Task 7 storage.

Use EIP-4361 Sign-In with Ethereum for backend authentication. The server constructs the message using the configured domain/origin URI, version 1, selected derived address, allowed chain, unique nonce, issued-at and expiry. The statement authorises signing in only. Never derive domain/origin from untrusted forwarding headers or accept a client-defined message as the authoritative challenge.

After an explicit Create account and sign in, or Recover and sign in action, the controller validates the received message against configuration, selected account and time limits, then signs those exact bytes through the private Mera-backed viem account using the maintained EIP-191 message-signing path. Do not show another passkey prompt while its session remains active. Reject arbitrary text or unexpected login scope.

Verify the exact stored message, valid EIP-4361 fields, pre-auth binding, nonce, expiry and EOA signature with maintained helpers. This proves control of the derived address; it does not independently attest a biometric, passkey provider or professional identity. Backend login does not consume the registry's action nonce.

Issue a rotated opaque session cookie with HttpOnly, Secure in HTTPS environments, SameSite=Strict, Path=/ and no Domain attribute. Use __Host- naming in HTTPS environments; isolate any localhost-only exception. Return only public session metadata. Do not put bearer tokens in JSON, localStorage or URLs.

Require the exact configured Origin, application/json and X-LexAegis-Request: 1 on JSON POST routes; reject missing/mismatched origins and credentialed cross-origin access. Keep the pre-auth binding check on verification. Apply no-store responses, closed request schemas, 16 KiB authentication body limits, uniform errors and redaction-safe logging. Clear/revoke login state on logout and session replacement.

Expose a server-only requireAccountSession helper. Future matter/vault/agent operations derive ownership from it, never from an address supplied in a request body. A known cached address alone must never authenticate a user.
</execute_task>

📦 BUILD TASK #9: apps/web/src/features/account/review-signing.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement a restricted bridge to the Chapter 3 SDK typed-data builders. Do not expose the raw viem account to UI components, the agent, network messages or arbitrary callback code.

Accept only the exact ReviewAction schema and EIP-712 domain:
name = "LexAegisProofOfReview"
version = "1"
chainId = configured/validated target chain
verifyingContract = configured/validated registry

Revalidate reviewer equals the selected derived address, action/replacement shape, nonce, positive unexpired deadline and intended chain/registry. Preserve the Chapter 3 600-second action-expiry policy. Use maintained viem signing; do not sign a digest as a personal message or hand-encode ECDSA signatures.

Implement an immutable preview ticket owned by the review UI controller. Bind it to the SDK action digest, selected account, controller generation, package/reference identity and expiry. Explicit confirmation consumes it once. Reject caller-supplied approved=true flags and instructions originating in assistant text, voice transcripts, tool output or documents.

Changing the package, action, reviewer, predecessor/replacement, nonce, deadline, chain or registry invalidates the preview and requires a new explicit confirmation. Lock, account switch and cancellation invalidate unused tickets. Copy inputs before asynchronous work; recheck the captured digest before releasing a signature.

Chapter 6 supplies trustworthy live chain/nonce checks; Chapters 5 and 8–10 supply recoverable frozen evidence and the complete human-review gate. Keep the production review-signing control unavailable until those prerequisites exist. Tests may supply explicit synthetic fixtures; never add a production bypass or demo approval flag.

Return a typed signed-action result to the submission controller only. Do not broadcast here or present a signature as a confirmed receipt. An ended local session does not revoke signatures already released; their deadline/nonce and Chapter 3 invalidation rules remain authoritative.
</execute_task>

📦 BUILD TASK #10: Account recovery and the Chapter 5 vault boundary
🛠️ ACTION TYPE: Extend

<execute_task>
Implement recovery with an empty browser cache: discover the existing credential under the configured rpId, evaluate ACCOUNT_PRF_SALT, reproduce the v1 address and establish a fresh signing/backend session. Account derivation itself must work before any backend profile lookup.

When restoring a known account, compare the derived address with the selected public profile and authenticated backend identity. A mismatch ends the candidate session and presents an explicit account choice. In discovery mode, display the selected derived account before loading its data. Never silently attach a different credential to an existing account or overwrite its recovery profile.

Allow forgetting an invalid local hint and retrying credential discovery. Cached credential IDs, transports and claimed addresses are untrusted. Only public metadata may be cached. Do not fetch another account's data before backend authentication succeeds.

Provide a narrowly scoped browser bridge for Chapter 5 to obtain PRF material using VAULT_PRF_SALT and the currently verified credential. Pin that credential, require an explicit vault-unlock gesture and reject a changed account generation or returned credential. Supply bytes only to the trusted vault consumer and clear them in finally. Do not expose a general arbitrary-salt PRF API to the assistant or HTTP routes.

Do not evaluate or retain the vault PRF during account-only onboarding. A later vault unlock may need another ceremony; measure it separately. Reserve the exact vault namespace now, but leave encryption, ciphertext discovery, saved matter context and portable export to Chapter 5.

Explain recovery precisely: clearing browser storage is recoverable when the same passkey remains accessible under the same rpId. A different/new passkey, deleted credential, unavailable sync account or unrelated origin is not equivalent recovery. No account rotation, administrator recovery or private-key export is implemented in this chapter. Do not claim a future evidence export restores a lost signing identity.
</execute_task>

📦 BUILD TASK #11: apps/web/src/components/account — Aegis account controls
🛠️ ACTION TYPE: Extend

<execute_task>
Connect the Chapter 1 HUD to real account/controller/auth state. Implement accessible Create account and sign in, Recover account, Unlock signing, Lock and Sign out controls. Explain the scope before starting a ceremony; provide a visible cancellation path without duplicate requests.

Show separate labels for selected account, signing-session lock/expiry, backend sign-in, vault availability and chain connectivity. Derive readiness from actual results. An unlocked account must not turn the receipt indicator green or imply that the vault is decrypted.

Use the established obsidian/cobalt/cyan design and text/icon status labels. The orb may show Awaiting passkey, Account ready, Locked or Account unavailable from real events; do not label a browser ceremony as AI analysis. Preserve Command-centre/Review selection, keyboard focus, reduced motion and mobile navigation.

Handle cancelled prompts, PRF unsupported, wrong credential, session expiry, backend outage and recovery mismatch with specific useful next actions. Link compatibility guidance to https://mera.category.xyz/authenticator-support/. A retry is explicit; avoid repeated automatic browser prompts.

Keep sensitive account internals outside props and public stores. Account changes clear selected private matter context and cancel pending work through existing hooks. Reserve vault cleanup for its Chapter 5 implementation; do not claim it ran while unavailable.

Expose only public account/status events to the future Aegis assistant. It may explain an account state but cannot create approval tickets, unlock itself, request PRF bytes or invoke a signer. Full assistant, voice and review-package UI remain in Chapters 9–10.
</execute_task>

📦 BUILD TASK #12: Browser security policy and secret-handling boundaries
🛠️ ACTION TYPE: Modify

<execute_task>
Apply a production Content Security Policy compatible with the installed Next.js version using its official nonce/hash approach:
https://nextjs.org/docs/app/guides/content-security-policy

Restrict scripts and connections to the application's actual needs, block framing/object embedding and avoid third-party script injection on account routes. Use correct dynamic rendering/nonce propagation rather than a blanket script-src unsafe-inline or unsafe-eval exemption. Isolate any required development-only policy.

Keep provider traffic and credentials behind server routes. Render future assistant/document content as inert text or sanitised structured content; never executable HTML. Prevent sensitive route/service-worker caching. Keep cookies, login signatures, PRF bytes, derived keys and legal content out of logs, traces, analytics and error reports.

Add import/export restrictions so account/key modules cannot be imported by packages/agent, server modules or the independent verifier. The verifier remains usable without Mera or LexAegis login.

No private user key, PRF output, raw HD node or Mera session may enter localStorage, sessionStorage, IndexedDB, cookies, database rows, API payloads, worker messages or URLs. The opaque backend session cookie is permitted because it cannot sign or decrypt; distinguish it explicitly from a signing session.

Security headers and private closures do not isolate secrets from a compromised same-origin application. Record that limitation concisely; do not market session scoping or buffer zeroing as a hardware guarantee.
</execute_task>

📦 BUILD TASK #13: Account, authentication and signing integration tests
🛠️ ACTION TYPE: Create

<execute_task>
Use Vitest, existing Foundry/Anvil tooling and focused browser checks. Use synthetic keys and deterministic injected clocks/ceremony adapters in automated tests. Do not create real credentials from unit tests.

Test these meaningful boundaries:
- Fixed PRF input/profile reproduces the expected EVM address; changed input/salt/path does not silently restore it.
- Recovery succeeds without cached metadata; tampered hints and unexpected credentials are rejected.
- Create-time PRF and SDK fallback paths, unsupported PRF, cancellation, partial creation failure and stale ceremony completion.
- Duplicate clicks, account switching and concurrent sign requests cannot mix sessions.
- Hard expiry, idle expiry, lock, sign-out, page lifecycle and late signature completion prevent further signature release.
- Separate account/vault salt values and credential pinning; cleanup occurs on consumer failure.
- Valid SIWE login; wrong address/domain/URI/chain, altered message, expired challenge, wrong pre-auth binding and replay fail.
- Concurrent challenge verification creates at most one session using the real PostgreSQL repository, not just its mock.
- Session rotation/logout/expiry, missing database, unauthenticated resource access and client-supplied ownership spoofing.
- Exact registry action succeeds through the real Mera signing-session/viem adapter against the Chapter 3 local contract. Changed fields, reused preview tickets, cancellation and wrong account/domain fail.
- Production review signing remains unavailable without the later evidence/live-state gates.
- Public snapshots, persistence, responses and error paths exclude secret sentinel values; browser imports exclude server credentials.
- Account HUD states, keyboard interaction and reduced motion reflect actual controller outcomes.

Keep mocks clearly test-only. Do not treat emulator success as proof of real PRF support, one-prompt onboarding or synced cross-device recovery. No test may weaken verification to manufacture a pass.
</execute_task>

📦 BUILD TASK #14: Chapter validation, recovery evidence and handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run the relevant lint, typecheck, unit/integration tests, contract integration checks and production build. Verify browser/server boundaries and protected endpoints. Repair failures within this chapter; preserve earlier protocol behaviour.

Perform real passkey checks on available supported hardware with synthetic account data and user-controlled authenticator interaction:
1. Create an account; record the public address and actual browser/authenticator flow.
2. Complete backend sign-in and verify a bounded test signature without an unnecessary second unlock.
3. Lock or expire the session; confirm signing fails until a fresh ceremony.
4. Clear this application's browser storage/cookies, reload, select the same existing passkey and reproduce the address.
5. Where a second supported device/profile and the same synced credential are available, repeat recovery and verify control of the same address.

Do not delete the passkey or unrelated browser data. Do not substitute a newly created passkey in the recovery demonstration. If hardware, database or stable origin is unavailable, record the exact unverified check and continue all independent validation; never fabricate a successful live test.

Record actual taps, observable ceremony count and elapsed time with browser/OS/authenticator context. SDK invocation count alone does not prove the number of authenticator prompts. A test signature is not a confirmed Monad transaction. Public transaction timing belongs to Chapter 6; encrypted cross-device evidence recovery belongs to Chapters 5 and 12.

Update docs/build-state.json with implemented modules, resolved dependencies, fixed derivation profile, verified checks and remaining prerequisites. Update docs/assistant-ui-contract.md with implemented account events and deferred assistant/vault integrations. Keep CLAUDE.md compact.

Hand off to Chapter 5: public account identity, trusted credential selection, distinct vault PRF namespace, backend ownership guard, lock/cleanup hooks and validated recovery behaviour. Keep unfinished capabilities unavailable. Stop after Chapter 4; do not deploy contracts, fund accounts or begin Chapter 5.
</execute_task>
```
