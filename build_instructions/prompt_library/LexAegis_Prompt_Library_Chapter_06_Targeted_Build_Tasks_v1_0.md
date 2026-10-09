## Chapter 6 — Alchemy Transactions, Testnet Funding and Live Verification

This chapter connects LexAegis to the real Monad test network through Alchemy. It adds limited test funds, sends transactions signed by the user's Mera account, and checks what actually happened on-chain. Aegis gains clear funding, fee, pending, confirmed and failure states. Documents stay in the encrypted vault; only the public receipt information reaches the blockchain. The complete legal-review approval screen remains in Chapter 10.

```text
📦 BUILD TASK #1: Transaction dependencies and chapter boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute these tasks sequentially through repository edits. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Use closed schemas, compact factual repository records and real integration results.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and relevant Chapter 2–5 modules. Reuse the generated registry ABI, SDK builders/decoders, Mera account controller, authenticated backend guard and recoverable-capture gate. Preserve unrelated changes.

Implement Alchemy RPC access, guarded Monad testnet deployment, bounded service-funded test MON, restricted user transaction signing/submission, confirmation, live receipt verification and HUD integration. Use the existing Next.js/viem/PostgreSQL stack; no additional wallet provider, backend framework, token, paymaster, bundler or smart account.

Preserve all package/commitment formats, registry transitions and account/vault derivation profiles. Extend Chapter 4's application-enforced signing scope only with the exact registry transactions defined here. Do not expose arbitrary transaction signing or an EIP-7702 authorisation path.

Keep ISSUE/SUPERSEDE production approval unavailable until Chapters 8–10 supply the complete human-review gate. An encrypted package, funded account or live RPC connection cannot substitute for that gate. Use explicit synthetic fixtures in tests only.

Consult current official documentation and installed declarations:
https://docs.monad.xyz/ai/current-facts
https://docs.monad.xyz/developer-essentials/testnet
https://docs.monad.xyz/developer-essentials/gas-pricing
https://docs.monad.xyz/developer-essentials/reserve-balance
https://docs.monad.xyz/monad-arch/consensus/block-states
https://docs.monad.xyz/reference/json-rpc/api
https://www.alchemy.com/docs/reference/monad-api-quickstart
https://mera.category.xyz/reference/to-viem-account/
https://viem.sh/docs

Use Monad's current network semantics over stale Ethereum assumptions or old provider examples. Record unresolved provider capabilities; never fabricate support or silently switch providers.
</execute_task>

📦 BUILD TASK #2: Monad testnet configuration and transaction schemas
🛠️ ACTION TYPE: Extend

<execute_task>
Configure the reference application for Monad Testnet: chain ID 10143, native currency MON, 18 decimals. Recheck those facts against current official documentation. Reject mainnet chain ID 143 and every other public chain in this chapter's deployment, funding and application mutation paths. Preserve isolated loopback Anvil configurations for tests.

Keep ALCHEMY_MONAD_RPC_URL server-only. Reuse existing environment validation. Add explicit testnet-only deployment/funding credentials, enabled state and bounded fee/funding settings with empty secret examples. Never read unrelated credentials or expose authenticated RPC URLs through public chain definitions, logs or error messages.

Use the actual Chapter 3 deployment artifact, extended with observed genesis hash and runtime-code keccak256 when available. Publish only chain ID, registry address, deployment block/hash, protocol version and safe explorer configuration. Unknown deployment fields remain absent; no placeholder address enables readiness.

Record Monad's documented execution-delay parameter in the chain policy, currently 3 blocks, with the documentation/network revision used to validate it. Do not infer execution assurance from a fixed millisecond sleep. Refuse stronger assurance if this policy cannot be established.

Define closed application schemas for ChainCheckpoint, ActionPreflight, TransactionQuote, SubmissionRecord and FundingResult. Reuse ReceiptReferenceV1 and ReviewAction unchanged. Keep transaction outcome, receipt lifecycle, package integrity and signer acceptance separate.

Serialize wei values, gas quantities, nonces, block numbers and timestamps as validated canonical decimal strings; use bigint internally. Transaction/block/action hashes are lowercase 32-byte hex. Only the validated small chain ID may cross a library Number boundary. Use integer unit formatting for MON; no floating-point fee arithmetic.

Distinguish registry action nonce, EOA transaction nonce, backend login nonce and private opening nonce everywhere. None is interchangeable.
</execute_task>

📦 BUILD TASK #3: apps/web/src/server/chain/alchemy-client.ts
🛠️ ACTION TYPE: Create

<execute_task>
Create one server-only viem public client with an explicit Alchemy HTTP transport. Do not allow a default transport to silently use a chain definition's public RPC. Reuse the pinned compatible viem version and update the genuine lockfile only if required.

Validate the configured HTTPS endpoint as the intended Alchemy Monad testnet endpoint. Never accept a client-supplied RPC URL, method name or upstream header. Redact URL paths/query strings that may contain credentials.

Probe eth_chainId, genesis/block reads, eth_getCode, eth_call, gas/fee estimation, account transaction counts and transaction/receipt reads. Verify finalized-tag and historical-state behaviour required by Task 5 against the actual endpoint. Record capabilities as observed, not inferred from a package import.

Use bounded timeouts, response sizes, concurrency and backoff. Retry transient read failures at most twice; honour rate-limit responses. Disable automatic transport retries for broadcasts and other application mutations; reconcile their identity explicitly.

Keep liveness independent from chain readiness. Missing credentials, wrong chain/genesis, RPC lag, unsupported methods, missing registry or mismatched code return typed unavailable/unknown states. Never report not_found merely because an RPC request failed.

Use only necessary standard RPC operations. No traces, arbitrary storage inspection, Alchemy account abstraction, token APIs or extra sponsor integrations enter this MVP. Provider configuration alone is not evidence of a live integration.
</execute_task>

📦 BUILD TASK #4: contracts deployment script and verified deployment artifact
🛠️ ACTION TYPE: Extend

<execute_task>
Extend the Chapter 3 Foundry deployment script with an explicit Monad-testnet command. Preserve the local-only command. Recheck compiler/EVM-target compatibility; do not alter the registry ABI, authorisation scheme or lifecycle to make deployment pass.

Before any broadcast, require passing local contract tests, live chain ID 10143, the intended genesis, a configured testnet deployer, sufficient test balance and an explicit bounded deployment fee policy. For the first deployment, establish and record genesis from the configured endpoint after network checks; subsequent runs must match that pin. The deployer is an operator-owned testnet account, separate from users' Mera keys and the funding account. Keep its key out of command-line arguments, source, logs and generated files.

Estimate deployment cost through Alchemy. Never silently switch to another network/provider, buy tokens or use a production account. Perform the public deployment in Task 15 after the chapter's local checks pass, when the required credentials/funds exist.

Record actual deployment transaction, address, block/hash, compiler/dependency settings and creation-bytecode identity. Verify successful execution, canonical inclusion, nonempty runtime code and protocolVersion()==1. Compare deployed code to the compiled artifact accounting for compiler-declared immutable/link references; do not naively compare unresolved EIP-712 immutable slots.

Persist the exact observed runtime-code keccak256 only after that build/deployment check. Compare SDK and deployed hashAction for a synthetic vector under the actual chain/domain. Reuse a previously verified matching deployment; never redeploy automatically on startup or uncertainty.

Generate the shared public deployment artifact consumed by web, SDK fixtures, verifier and Chapter 7's indexer. A redeployment requires an explicit configuration/version change and newly bound packages; never rewrite a frozen package's registry address.
</execute_task>

📦 BUILD TASK #5: packages/sdk/src/registry/live-reader.ts and chain checkpoints
🛠️ ACTION TYPE: Create

<execute_task>
Implement framework-neutral live readers accepting a caller-supplied viem client/transport and explicit chain, registry and deployment policy. The SDK must not import Next.js, Alchemy credentials, Mera, the vault or a hosted-backend singleton.

Build a ChainCheckpoint from the actual finalized block. For this application, choose a concrete state-read height no newer than finalizedHeight minus the validated Monad execution delay; currently the delay is 3 blocks. Require the height to be at/after deployment. Record finalized head, selected block number/hash/timestamp, policy and observation time.

Read code, protocolVersion, nonceOf and getReceipt at that selected block. Use block-hash pinning when the endpoint supports it; otherwise pin the block number and recheck its hash before/after the read group. Mixed, missing, regressing or inconsistent observations return unknown. Never silently fall back to latest while retaining the stronger assurance label.

For the reference application, require the configured deployment's runtime-code hash and protocol version. For other SDK callers, keep deployment/trust policy explicit and supplied by the caller; do not create a global registry allowlist in the protocol.

Decode receipt status through Chapter 3 and return the complete receipt tuple plus checkpoint. not_found requires a successful validated call returning NotFound at the verified deployment. Use validateReceiptBinding when an independently verified opening is available; never send that opening to RPC.

Keep integrity, current lifecycle, predecessor binding and caller-supplied signer policy separate. A matching receipt does not establish legal correctness or professional identity. RPC observations rely on the selected provider; they are not a light-client proof.

Expose separate provisional latest-state reads for transaction preparation, explicitly labelled and never merged with confirmed verification results. Refresh before important actions. Display an as-of block/time; later revocation or supersession may change status. Envio history must never override this live reader.
</execute_task>

📦 BUILD TASK #6: apps/web/src/server/chain/operation-store.ts and migrations
🛠️ ACTION TYPE: Create

<execute_task>
Extend PostgreSQL with bounded transaction-operation and funding records. Store authenticated owner, operation ID, chain/registry, public action/reference identity, expected registry/EOA nonces, transaction hash, phase and observed block/timestamps. Keep matter names, package hashes, artifacts, openings and legal decisions inside the encrypted vault.

Use unique idempotency keys scoped to the authenticated account and operation kind. Reusing a key with different intent fails. Serialize active application mutation workflows per chain/account across tabs and devices; a process-local mutex or viem nonce manager alone is insufficient.

Reserve an unsigned operation with a bounded lease. Once an authorisation or raw transaction may have escaped, lease expiry alone cannot prove it harmless. Preserve uncertain signed/broadcast operations for reconciliation. Do not auto-increment either nonce or release an unknown submitted nonce for a different payment.

Before broadcasting a user transaction, durably record its locally computed hash, nonce and validated public intent. Store quote field commitments/calldata hashes, not user action signatures or raw signed transactions. User signed bytes remain transient and excluded from logs. After reload, authenticated clients can recover their pending operation metadata and query chain state without a signing key.

Funding needs a durable outbox: store its fully scoped service-signed testnet transaction and hash before sending, so a crash can retry identical bytes rather than pay twice. Restrict this outbox to the funder workflow; never store a service private key or user signing session in the database.

Reserve funding cooldowns and the global value-plus-fee budget atomically. Use a shared lease for the service funder's nonce and at most one unresolved outgoing funding transaction. Retain reservations after uncertain outcomes until reconciled. Do not introduce Redis, a new queue service or an unlimited background retry loop.
</execute_task>

📦 BUILD TASK #7: apps/web/src/server/chain/testnet-funding.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement explicit Request test MON funding for an authenticated account only. Derive the recipient from requireAccountSession; reject client-supplied recipients/amounts. Confirm the chain, recipient address and undelegated EOA state. Funding never requests a user's private key or signs their registry action.

Use a dedicated server-owned testnet funder loaded from configured runtime secrets. Default policy: 0.2 MON per transfer, one grant per address per rolling 24 hours, and 10 MON maximum total committed value plus maximum fees per UTC day. Decline a grant when the recipient already has at least 0.2 MON. Make validated policy changes explicit; missing credentials/disabled funding returns unavailable.

The address cooldown is not proof of one human; the atomic global budget is the hard spending bound. Apply the existing shared-store request limits. Never automatically refill the funder, purchase assets or send mainnet funds.

Build a chain-bound EIP-1559 native transfer with empty calldata. Use verified gas/fee estimates and a maximum funding-transaction fee of 0.01 MON by default. Check funder balance including reserved fees; coordinate the service nonce through Task 6. Persist the exact signed outbox transaction before the first Alchemy broadcast.

Retry only identical signed bytes after hash/status reconciliation. Treat success, revert, timeout and already-known responses distinctly. Confirm the transfer through Task 11's canonical execution checks and read the recipient's usable balance afterward; submission alone does not mean funds arrived.

Respect Monad's asynchronous execution/reserve-balance behaviour. Serialize funding and wait for the required execution checkpoint before spending newly received funds. Do not incorrectly demand a blanket 10 MON minimum for every undelegated user account.

When disabled, exhausted or underfunded, provide the verified official faucet link and a Copy address control without changing the account provider. Never automate faucet CAPTCHA or claim the app is gasless: the user account pays transaction fees with test MON.
</execute_task>

📦 BUILD TASK #8: apps/web/src/server/chain/preflight.ts and fee-quotes.ts
🛠️ ACTION TYPE: Create

<execute_task>
Create preflight operations for execute(ReviewAction,signature) and invalidateNonce(expectedNonce) using the generated ABI only. Read fresh identified execution state, account balance, registry nonce and relevant receipt records. Reject missing/wrong registry code, wrong chain, unexpected account code/delegation and unavailable state.

Validate lifecycle before authorisation:
- ISSUE: target is unissued; prepared snapshot declares no predecessor.
- REVOKE: target is Active under the selected reviewer.
- SUPERSEDE: predecessor is Active, replacement unissued, and the frozen replacement names the exact predecessor.
- invalidateNonce: expectedNonce equals the selected account's current registry nonce.

Keep private snapshot/opening checks in the browser. The server receives only public action/reference data. It cannot certify the human review from a caller-supplied approved flag. Compare the SDK action digest with deployed hashAction when building the preflight.

Preserve the 600-second ReviewAction deadline policy. Reject stale preflight observations older than 15 seconds and material clock/chain-time discrepancies. A changed registry nonce, lifecycle, package or domain invalidates the existing action preview; never repair and re-sign silently.

After explicit action authorisation produces its signature, encode the exact execute calldata, verify the EOA signature, simulate eth_call and estimate gas from the actual sender. Do not use a fake signature or state override to manufacture success. Nonce invalidation needs its own explicit intent but no ReviewAction signature.

Obtain live EIP-1559 fee inputs. Set gasLimit = ceil(estimatedGas * 110 / 100); reject a resulting limit above 1,000,000 for registry operations rather than clipping it. Default maximum total registry fee is 0.2 MON. Require maxPriorityFeePerGas <= maxFeePerGas and sufficient balance for gasLimit * maxFeePerGas.

Monad charges according to the gas limit. Do not apply a huge Ethereum-style gas buffer, show an assumed unused-gas refund, or copy a mainnet USD cost into testnet UI. Calculate and display the expected fee and maximum fee in MON with integer arithmetic.

Issue a closed 30-second TransactionQuote binding operation ID, account, chain, registry, exact calldata/hash, value=0, type=2, EOA nonce, gas limit and fee fields. Determine the nonce from actual endpoint behaviour plus shared pending-operation records; never assume Ethereum's pending/global-mempool semantics. Refuse unresolved collisions instead of guessing.
</execute_task>

📦 BUILD TASK #9: apps/web/src/features/account/registry-transaction-signing.ts
🛠️ ACTION TYPE: Extend

<execute_task>
Extend the private Mera account controller with a narrowly scoped registry-transaction signer using its existing toViemAccount account.signTransaction method. Keep the same Chapter 4 account derivation and memory-only session; do not copy a different derivation from an SDK recipe or create a new wallet.

Permit only type-2 transactions on chain 10143, from the selected account, to the verified registry, value=0, with empty access list and exact generated execute or invalidateNonce calldata. Reject contract creation, transfers, other selectors, appended calldata, arbitrary serializer hooks, authorisation lists and signAuthorization calls.

Use two explicit authorisation stages:
1. The review/action controller consumes Chapter 4's immutable human-confirmation ticket to sign the exact EIP-712 action. ISSUE/SUPERSEDE also require the Chapter 5 recoverable capture and the future complete human-review gate. REVOKE requires its own explicit consequence preview.
2. After Task 8 simulates the signed action, display the exact transaction and maximum fee. A separate Send transaction confirmation consumes a one-use private transaction ticket bound to the complete quote and action digest.

Do not evaluate another passkey ceremony while the existing session is valid. If it expires, require explicit unlock and revalidation. Vault unlocking, backend login, voice commands and model output cannot create either ticket.

Validate and copy every field before signing; after asynchronous work recheck account generation, expiry, cancellation, quote age and exact unsigned transaction identity. Use maintained viem serialization/signing; do not hand-roll RLP/ECDSA. Parse/recover the result to verify its sender and fields before releasing it to submission.

Keep registry nonce and transaction nonce distinct. Any quote-field change requires a new transaction confirmation; any ReviewAction change requires a new action confirmation. Do not expose the raw signer, signing session or general-purpose signing function to components or the agent.

An EIP-712 signature is executable authorisation once disclosed, including during remote simulation. Explain that the first confirmation authorises the registry action; the second authorises this account's fee-paying submission. Discarding a local preview cannot revoke an already disclosed signature.
</execute_task>

📦 BUILD TASK #10: apps/web/src/app/api/chain routes and raw transaction submission
🛠️ ACTION TYPE: Create

<execute_task>
Implement bounded typed routes:
GET /api/chain/status — public network/deployment readiness and checkpoint.
GET /api/chain/receipts/[reviewer]/[commitment] — public live state for the configured registry.
POST /api/chain/operations — authenticated public-intent reservation/preflight.
POST /api/chain/operations/[id]/quote — authenticated exact-calldata simulation/quote.
POST /api/chain/operations/[id]/submit — authenticated signed transaction submission.
GET /api/chain/operations/[id] — authenticated owner-only reconciliation.
POST /api/chain/funding — authenticated bounded funding request.

Reuse requireAccountSession, configured-Origin checks, application/json, X-LexAegis-Request:1, no-store responses, 16 KiB body limits and shared-store rate limits. Public read routes require no wallet/login; allow only configured read-only verifier-origin CORS without credentials. Never create a generic JSON-RPC proxy.

For submission, decode the complete raw transaction with maintained viem utilities, recover its signer and require it to match the authenticated owner. Enforce Task 9's chain/type/destination/value/calldata restrictions independently on the server. Compare every signed field with the stored operation/quote, including both nonces and approved fee ceilings. Limit raw signed transactions to 4 KiB.

For execute, validate the embedded action signature, domain, reviewer and exact operation. For invalidateNonce, validate its exact expected nonce and selected sender. Reject trailing/noncanonical data and other calls. Never accept a client-provided sender or transaction hash as proof.

Compute txHash = keccak256(rawSignedTransactionBytes), persist the public submission identity, then call Alchemy eth_sendRawTransaction. Require a returned hash to match. The server carries a user-signed transaction; it never signs it with the funding/deployment key.

Recheck live chain/lifecycle/nonce and quote conditions before the first broadcast. Exact retries first reconcile the existing hash; do not fail merely because its original quote later expired, and never substitute newly signed bytes. Timeouts remain unknown, not failed or confirmed. Decode known RPC/contract errors without logging bodies, signatures or secret endpoint values.
</execute_task>

📦 BUILD TASK #11: packages/sdk/src/transactions/monitor.ts and operation reconciliation
🛠️ ACTION TYPE: Create

<execute_task>
Implement bounded transaction monitoring with actual hash, sender, nonce and expected intent. A viem receipt waiter may assist but its first receipt/one confirmation is not the application's complete success condition.

Maintain distinct submitted, pending, included, confirmed, reverted, replaced and unknown outcomes. A missing receipt, HTTP timeout or expired action deadline does not prove a transaction was never broadcast. Poll initially every 2 seconds with bounded backoff; after 120 seconds return unresolved state and permit explicit refresh. Do not hold one HTTP request open indefinitely.

Require an execution receipt, matching transaction fields and canonical block hash. Mark final confirmation only when the receipt's block is covered by Task 5's execution checkpoint. Recheck canonicality; a disappearing/changing pre-confirmation block returns to unresolved observation. A contradiction to already confirmed history blocks stronger claims and surfaces an integrity/network error.

For registry transactions, decode logs only from the configured address. Match reviewer, commitment(s), action nonce and expected event shape. SUPERSEDE must contain the new ReceiptIssued followed by ReceiptSuperseded as one atomic operation. invalidateNonce must show the exact counter transition.

Read current registry state at the same confirmed checkpoint and validate expected links. Separate historical transaction success from current lifecycle: a successfully issued receipt may already be revoked or superseded. A reverted transaction consumes its EOA nonce/fee but must not be reported as consuming a successful registry action nonce.

Handle same-sender/nonce replacement using observed transaction evidence. An unrelated replacement is not success for the original intent. If the nonce advanced but the actual replacement cannot be established within bounded reads, return unknown; do not perform an unbounded chain scan or assume success.

A third party may execute a disclosed valid ReviewAction first. Reconcile the expected events/current record and report that the action executed via another transaction when established; preserve the separate outcome of this user's transaction. Never issue another commitment automatically.

For funding, require the expected sender/recipient/value and successful confirmed execution, then refresh balance. Compute actual fees using the network's charged-gas rules and observed effective price; do not assume Ethereum gasUsed accounting. Record public evidence only.
</execute_task>

📦 BUILD TASK #12: apps/web/src/features/transactions recovery and cancellation
🛠️ ACTION TYPE: Create

<execute_task>
Connect account-generation/cancellation hooks to the submission controller. Before signature release/broadcast, cancellation stops subsequent work and invalidates unused tickets. After a request may have reached the server/network, show Submission outcome pending/unknown and continue only read-only reconciliation as permitted.

After reload or fresh-storage account recovery, fetch authenticated pending-operation metadata, read chain state and reconnect it to the decrypted package reference. Never require an old browser-local transaction cache, regenerate an opening, or create a replacement approval merely because a response was lost.

Keep signed user payloads in memory only for bounded explicit retry. A retry reuses identical bytes/hash. Do not automatically bump fees, replace a transaction, advance a nonce, re-sign or fund again. If bytes are lost and the outcome remains unknown, preserve that uncertainty and offer status refresh/explorer inspection.

Provide a narrowly scoped nonce-invalidation flow for a disclosed but unexecuted action when the EOA transaction nonce can be safely established. Show that this separate fee-paying transaction may lose a race, invalidates the exact current registry nonce and does not revoke an existing receipt. Unknown in-flight EOA transactions cannot be silently replaced to perform it.

REVOKE terminates an Active receipt; SUPERSEDE atomically links it to a new saved/approved package. Neither edits the old evidence. Keep their complete review/action UI integration assigned to Chapter 10 while making the underlying controllers testable here.

Application locks cannot reverse a broadcast transaction or revoke released signatures. Signed raw transactions do not acquire an on-chain expiry merely because the local quote expired; ReviewAction.deadline controls the inner action only. Keep these distinctions in concise UI messages.
</execute_task>

📦 BUILD TASK #13: Aegis transaction, funding and live-verification UI
🛠️ ACTION TYPE: Extend

<execute_task>
Connect the existing HUD to real chain/funding/operation controllers. Show Monad Testnet, selected Mera address, usable MON balance, registry availability and live-check block/time. Keep passkey session, backend session, vault lock, transaction state and indexer state independent.

Add Request test MON, funding progress, Copy address, explicit Retry status and verified explorer links. Show limits/outage/low-funder-balance states from actual responses. Funding completion does not imply review approval or a receipt.

Use the action-preview panel for lifecycle consequences and the transaction preview for exact network, destination, action, sender and maximum fee. Reflect both authorisation stages; label Send transaction clearly. Keep unavailable legal-review gates visible and disabled until their owning chapters implement them.

Drive the orb/status line from real events: Checking network, Awaiting confirmation, Signing, Sending, Pending, Checking execution, Confirmed, Reverted or Status unknown. Stop may cancel assistant work/unsent operations; it must not claim to cancel an on-chain transaction.

Display package-integrity results separately from receipt status. Green transaction confirmation requires Task 11's checks; live receipt status includes an as-of block. Envio remains unavailable until Chapter 7; do not show fabricated history or a connected indexer badge.

Put operation progress and public chain events in the activity drawer, separate from assistant tool activity and human decisions. Keep document names/openings out of public explorer URLs, analytics and logs. Preserve keyboard focus, screen-reader status announcements, reduced motion, mobile layout and the established HUD styling.
</execute_task>

📦 BUILD TASK #14: Transaction, funding and verification tests
🛠️ ACTION TYPE: Create

<execute_task>
Use existing Vitest, Foundry/Anvil and Playwright tooling with synthetic accounts/packages. Exercise real generated ABI and real Mera-to-viem signing, not a substitute signer in the production path.

Verify:
- Chain/genesis/code/domain mismatch, missing configuration and unavailable historical/finalized reads cannot produce ready/active results.
- EIP-712 digest and decoded type-2 transaction bind the exact sender, chain, registry, action and independent nonce values.
- Different calldata, appended bytes, nonzero value, contract creation, another recipient, EIP-7702, arbitrary serializer and fee-cap bypass are rejected in browser and server.
- No ISSUE/SUPERSEDE production signature without saved evidence and the future human-review gate; raw approved flags and assistant/voice inputs cannot satisfy it.
- Lock/expiry/account switch, changed previews, expired quotes and late async completions prevent new signature release.
- Real database races enforce per-account operation coordination, funding cooldown/global budget and funder nonce ownership.
- A crash before/after funding broadcast retries the identical outbox transaction and cannot pay twice; ambiguous outcomes retain their reservation.
- Raw transaction retries preserve the hash; nonce errors/replacements never trigger blind re-signing or a new commitment.
- Successful ISSUE/SUPERSEDE/REVOKE/invalidateNonce, replay rejection, exact supersession event order and current status after later lifecycle changes.
- Receipt lag, speculative blocks, reorganisation, mismatched logs, failed execution and third-party action submission are classified correctly.
- Fee arithmetic uses integers and the Monad gas-limit policy; a first receipt is not automatically final verification.
- Public reads work without login, protected operations enforce ownership/origin, and logs/browser bundles contain no RPC key, signing key, PRF or private opening.

Use deterministic RPC fixtures for failure/finality cases and label them as simulations. Anvil does not establish Monad gas charging, reserve-balance behaviour or Alchemy support. Verify those through the bounded live checks in Task 15 when available.
</execute_task>

📦 BUILD TASK #15: Chapter validation, live Monad evidence and handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run relevant lint, typecheck, contract tests, SDK integration tests, browser checks and production builds. Repair failures within this chapter. Verify test-only approval fixtures and signer adapters are absent from production entry points.

When configured testnet credentials/funds are available, execute the guarded registry deployment or validate the existing matching deployment. Through the actual Alchemy endpoint, record chain/genesis, deployment transaction/address/block, runtime-code identity and real capability results. Missing prerequisites remain blocked without invented values; complete independent local work.

Use synthetic evidence in a dedicated test harness excluded from the production application:
1. Create/recover a real user-controlled Mera credential and sign in.
2. Request one bounded test-MON grant and verify arrival/usable balance.
3. Bind a synthetic package to the actual testnet registry, preserve its encrypted opening and verify read-back.
4. Explicitly authorise the synthetic action, inspect fees, sign the outer transaction through Mera and broadcast through Alchemy.
5. Confirm execution/events/current status; test supersession, revocation and replay without publishing private evidence.
6. Lock/expire and recover the same account; reconcile transaction/public receipt state and decrypt the same saved package where hardware permits.

The synthetic harness may provide the test human-review fixture; production remains gated until Chapters 8–10. Do not advertise this test as a completed legal review. Real authenticator interaction stays user-controlled; unavailable hardware is unverified, not replaced with a claimed live pass.

Record actual onboarding/authorisation taps, observable passkey prompts and timings separately: account ready, funds usable, signature, broadcast, inclusion and confirmed execution. SDK calls and protocol marketing latency are not measured user experience. Store only public identifiers and redaction-safe evidence; never record passkey secrets or legal plaintext.

Update docs/build-state.json with actual checks, deployment identity, finality/fee policy, operation contracts, resolved dependencies and remaining gates. Update docs/assistant-ui-contract.md with implemented chain/funding states; preserve its 1,200-word cap and CLAUDE.md's 450-word cap.

Hand Chapter 7 the verified registry address, chain, deployment start block, generated event ABI and event-order rules. Hand Chapters 10–11 the restricted submission controller and caller-supplied live reader. Hand Chapters 12–13 real evidence and hosting/credential prerequisites.

Stop after Chapter 6. Do not deploy the web application, start the Envio indexer, invoke Qwen, submit hackathon materials or implement Chapter 7.
</execute_task>
```
