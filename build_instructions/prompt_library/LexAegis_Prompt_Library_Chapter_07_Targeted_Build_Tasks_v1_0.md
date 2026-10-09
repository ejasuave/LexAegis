## Chapter 7 — Envio Indexer, Review History and Derived Status

This chapter gives LexAegis a review-history screen powered by Envio. Users can see when a receipt was created, withdrawn or replaced, follow linked versions, and see whether the history is still catching up. These features join the Aegis HUD and activity drawer. Private matter names appear only after the vault is unlocked; current receipt status still comes from Chapter 6's live blockchain checks.

```text
📦 BUILD TASK #1: Indexer dependencies and chapter boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#14 sequentially through repository edits. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Produce working files, closed schemas and compact factual repository records. Preserve unrelated changes.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and relevant Chapter 2–6 modules. Reuse the generated registry ABI, verified deployment artifact, public receipt-reference types, live reader, operation journal and encrypted-vault controller.

Implement real Envio HyperIndex ingestion, deterministic projections, bounded GraphQL reads and Aegis history components. Keep the existing TypeScript/pnpm/Next.js stack. Do not replace HyperIndex with an application polling loop, hand-built SQL indexer or static fixture endpoint.

Preserve protocol formats, registry transitions, Mera derivation, vault encryption and human-approval gates. Indexing is read-only and cannot authorise, sign, submit, confirm or revoke a transaction. No model calls, embeddings, reputation scores, cross-chain analytics or additional sponsors.

Consult current official documentation and installed declarations:
https://docs.envio.dev/docs/HyperIndex/configuration-file
https://docs.envio.dev/docs/HyperIndex/schema
https://docs.envio.dev/docs/HyperIndex/event-handlers
https://docs.envio.dev/docs/HyperIndex/testing
https://docs.envio.dev/docs/HyperIndex/observability
https://docs.envio.dev/docs/HyperIndex/reorgs-support
https://docs.envio.dev/docs/HyperIndex/supported-networks

Use one pinned stable HyperIndex V3 release supporting the required APIs. Reconcile any older indexer scaffold explicitly; do not mix V2 generated imports/configuration with V3 handlers. Generate actual types and lockfile entries; never fabricate SDK methods or successful integration evidence.
</execute_task>

📦 BUILD TASK #2: indexer/package.json, config.yaml and deployment binding
🛠️ ACTION TYPE: Extend

<execute_task>
Make indexer a runnable pnpm workspace package with codegen, typecheck, test, dev and start scripts using the pinned Envio CLI. Retain generated files according to that release's convention; never hand-edit generated types.

Configure one production ingestion source: Monad Testnet, chain ID 10143, through its verified HyperSync service, currently https://10143.hypersync.xyz. Keep ENVIO_API_TOKEN server-side. Reject chain 143, source/network mismatch and silent RPC-source fallback. Allow an isolated loopback Anvil/RPC configuration solely for tests.

Generate deployment-bound configuration from Chapter 6's artifact. Require matching chain/genesis, registry address, deployment block/hash, protocol version and runtime-code identity. Verify those bindings through Chapter 6's Alchemy reader before starting live ingestion. Missing deployment data permits local fixture tests but cannot enable live readiness.

Use V3 chains configuration, abi_file_path referencing an export of the compiled registry ABI, address_format: lowercase and PostgreSQL storage. Index only ReceiptIssued, ReceiptRevoked, ReceiptSuperseded and NonceInvalidated from the configured registry. Verify the exported ABI's identity during builds.

Start at the actual deployment block, inclusively. Never use latest, a guessed block or a shortened history window. Set rollback_on_reorg: true and max_reorg_depth: 200 explicitly; this is a rollback window, not a finality policy.

Create a public configuration fingerprint from canonical chain/deployment/ABI/projection-version data. Keep a separate index generation identifier, stable across restarts and changed on a rebuild. Neither contains credentials.

Isolate Envio's database and role from authentication/vault tables. Keep local admin consoles on loopback. Add empty secret examples; never put admin secrets or authenticated upstream URLs in browser configuration.
</execute_task>

📦 BUILD TASK #3: indexer/schema.graphql and entity identities
🛠️ ACTION TYPE: Create

<execute_task>
Define these minimal entities with explicit fields and generated TypeScript types:
- RegistryState: deployment/configuration identity, generation, rawEventCount, actionCount, pendingSupersessions and last observed event position/hash.
- ChainEvent: event kind, chain/registry/reviewer, decoded public parameters, block number/hash/timestamp, transaction hash, executor address and block-wide log index.
- IndexedAction: ISSUE, REVOKE, SUPERSEDE or INVALIDATE_NONCE; consumed/next nonce, applicable commitments, transaction/block identity and first/last event positions.
- IndexedReceipt: reviewer, commitment, Active/Revoked/Superseded status, predecessor/successor commitments, issuedAt/updatedAt and issuing/latest action references.
- ReviewerSummary: nextNonce, totalReceipts, activeReceipts, revokedReceipts, supersededReceipts and actionCount.
- PendingSupersession: internal staging data for the two-event replacement transition, including completion state.

Use @internal for staging where supported by the pinned release. Public entities must not reference internal entities. Use documented indexes for reviewer, receipt linkage and ordered action queries; avoid unbounded relationship arrays and runtime aggregate queries.

Build unambiguous IDs from validated fixed-format components:
registryKey = chainId:genesisHash:registryAddress
reviewerKey = registryKey:reviewer
receiptId = reviewerKey:commitment
actionId = reviewerKey:consumedNonce
eventId = registryKey:blockHash:transactionHash:logIndex

Use lowercase addresses/hashes and canonical decimal integers. Store quantities as BigInt with sufficient precision for uint256, including explicit precision 78 where required. Use bigint internally; reject negative/out-of-range values. Convert to decimal strings at JSON boundaries. Guard unavoidable library Number conversions with safe-integer checks.

Represent zero predecessor/successor exactly as the registry tuple requires. An absent indexed receipt means not_indexed, never authoritative NotFound. Executor is transaction.from; reviewer comes from event parameters. They may differ.

Store public event metadata only. Exclude document titles, party names, matter IDs, openings, package digests, vault object IDs, signatures, prompts, credentials and user-session metadata.
</execute_task>

📦 BUILD TASK #4: indexer/src/handlers and shared transition helpers
🛠️ ACTION TYPE: Create

<execute_task>
Register typed V3 handlers with indexer.onEvent imported from envio. Select only necessary event metadata, including transaction hash/from and block hash/timestamp; use the documented block-wide logIndex. Do not assume transaction fields are selected automatically.

Implement pure validation/transition helpers shared by all four handlers. Load required context entities before the context.isPreload guard; perform state-dependent assertions and writes only during the processing phase. HyperIndex V3 preloads handlers separately; never increment counters or emit side effects during preload.

Reject wrong chain/source address, invalid public parameters, inconsistent event/block timestamps, nonce discontinuities and impossible lifecycle transitions. Compute a complete transition before applying its entity writes. Fail the batch on an invariant violation rather than inventing missing predecessor state.

Check eventId before applying a transition. An identical persisted event is a no-op; a conflicting payload under that ID is an integrity failure. Increment rawEventCount once per new raw event. Increment logical action counters only when a complete action is applied.

Keep all mutable projection state in Envio context entities. No RPC/model calls, external writes, process-local counters, Date.now-derived event facts or manually maintained SQL rollback tables inside handlers. Logs contain bounded error codes and public positions only.

Initialise RegistryState deterministically from the validated deployment configuration. If initialisation before the first event is needed, use a one-time deployment-block handler that preserves existing state. Never substitute a synthetic event or use the last receipt event as the indexing-progress watermark.

Maintain deterministic ordering by numeric block number and log index. Preserve raw events separately from derived user-facing actions so a supersession can retain both logs without becoming two approvals.
</execute_task>

📦 BUILD TASK #5: ReceiptIssued and ReceiptRevoked projections
🛠️ ACTION TYPE: Create

<execute_task>
For ReceiptIssued with zero predecessor, require an unissued nonzero commitment and event.nonce equal to ReviewerSummary.nextNonce, initially zero. Create one Active receipt with zero predecessor/successor and issuedAt=updatedAt=event.timestamp. Create one ISSUE action; increment totalReceipts, activeReceipts, actionCount and nextNonce once.

For ReceiptIssued with nonzero predecessor, stage a PendingSupersession keyed by reviewer/action nonce. Require an existing Active predecessor, a different never-issued replacement, the expected nonce and matching event identity. Record the raw issuance event and increment pendingSupersessions, but do not publish an ISSUE action, replacement receipt or updated reviewer totals. Task #6 completes the atomic replacement.

For ReceiptRevoked, require an existing Active receipt and the expected action nonce. Set status=Revoked and updatedAt=event.timestamp. Preserve issuedAt, predecessor and the remaining immutable identity. Decrement activeReceipts, increment revokedReceipts and create one REVOKE action. Advance nextNonce/actionCount once.

Preserve terminal lifecycle states: neither Revoked nor Superseded can become Active. Revoking a replacement never reactivates its predecessor. Do not infer revocation from an expired signing session, account-policy change, missing index row or nonce invalidation.

After each completed transition require nonnegative counters and:
totalReceipts = activeReceipts + revokedReceipts + supersededReceipts.

Use the event reviewer namespace for every lookup. Identical commitment bytes under another reviewer are independent receipts. Never use executor address as the receipt owner.
</execute_task>

📦 BUILD TASK #6: ReceiptSuperseded and NonceInvalidated projections
🛠️ ACTION TYPE: Create

<execute_task>
Implement the registry's exact replacement sequence: ReceiptIssued(replacement, predecessor=old) precedes ReceiptSuperseded(old, replacement). Both logs share reviewer, authorisation nonce, transaction, block and timestamp.

ReceiptSuperseded must find the matching incomplete PendingSupersession, with an earlier log index, Active old receipt and never-issued replacement. Reject missing, conflicting or already-consumed staging except an identical raw-event replay.

Apply the completed transition together: old becomes Superseded with successor=replacement and updatedAt=current timestamp; preserve its issuedAt/predecessor. Create replacement as Active with predecessor=old, zero successor and issuedAt=updatedAt=current timestamp. Mark staging complete and decrement pendingSupersessions.

Create exactly one SUPERSEDE IndexedAction referencing both events. Increment totalReceipts and supersededReceipts once; activeReceipts remains unchanged. Advance nextNonce/actionCount once. Do not count the staged ReceiptIssued as a separate ISSUE action or consume the nonce twice.

Support repeated replacement chains through direct predecessor/successor references. Do not traverse the complete chain during ingestion or build an unbounded graph in one response.

For NonceInvalidated, require previousNonce=nextNonce and newNonce=previousNonce+1. Create one INVALIDATE_NONCE action using previousNonce as its consumed nonce. Advance the summary nonce/actionCount without changing any receipt or lifecycle counter. The registry enforces msg.sender=reviewer; do not equate msg.sender with transaction.from when a contract reviewer calls the registry.

Expose invalidation as cancellation of outstanding authorisations at that nonce, not withdrawal of an existing receipt. No new receipt is created. A signature or reverted transaction with no successful registry event does not appear as an indexed action.
</execute_task>

📦 BUILD TASK #7: Native progress metadata and reorganisation recovery
🛠️ ACTION TYPE: Extend

<execute_task>
Use HyperIndex's actual _meta GraphQL response for coverage: progressBlock is the fully processed persisted block; sourceBlock is source progress. Treat isReady as historical-sync information and /healthz as process liveness. Neither proves current chain agreement. Validate the installed schema rather than inventing metadata fields.

Keep lastEventBlock separate from progressBlock. Verify progress behaviour across ranges containing no registry events. Missing metadata returns unknown coverage; an old last event alone does not indicate stalled indexing.

Rely on HyperIndex rollback for every projection, raw event, summary and staging entity. Configure HyperSync-backed reorganisation handling within the explicit 200-block window. Do not mark orphaned entities canonical, retain their counters or manually replay external side effects.

Detect configuration/generation changes, regressing coverage, changed event anchors and committed incomplete supersessions. Expose recovering or inconsistent states until coherent data is available. Fail readiness on known corruption or a reorganisation beyond the supported rollback window.

Provide an explicit rebuild command scoped only to the configured disposable indexer database, starting from the verified deployment block and assigning a new generation. Never reset automatically, touch authentication/vault data, erase application operation records or change the registry deployment. Keep history unavailable while a required rebuild is incomplete.

Store no guessed progress-block hash: _meta does not supply one. Obtain canonical block hashes through the existing live reader when needed and label that separate observation. Indexed event hashes remain the indexer's own observed anchors.

Record the actual rollback capability tested. A fixture reducer test alone is not proof that the running Envio engine rolls database state back correctly.
</execute_task>

📦 BUILD TASK #8: indexer/queries and apps/web/src/server/history/envio-client.ts
🛠️ ACTION TYPE: Create

<execute_task>
Create named GraphQL operations for index metadata, reviewer summary, action pages, receipt detail and a single predecessor/successor lookup. Validate them against the real generated GraphQL schema. Use index-time summaries rather than Hasura-only aggregate helpers unavailable on some hosted backends.

Create a server-only client for an explicitly configured Envio GraphQL endpoint. Use a select-only role where the backend supports it. Keep admin credentials private; never expose a generic GraphQL proxy, mutations, upstream URL selection or arbitrary query text to browsers.

Use variables and closed input/output schemas. Default page size 20, maximum 50; fetch at most limit+1. Bound upstream responses to 1 MiB, requests to 5 seconds and transient read retries to one. Reject malformed scalars, GraphQL errors and partial data; never convert failures into empty successful results.

Paginate one reviewer's completed actions by consumedNonce descending, numerically. On the first page fix an upper action anchor. Encode a versioned cursor containing configuration/generation, reviewer scope, upper nonce/action block hash and last returned nonce/action block hash. Limit cursor bytes to 2 KiB. Treat cursor contents as untrusted input, never as authorisation.

Validate both anchors and scope on continuation; constrain every query to the original upper nonce. Missing/changed anchors, rollback below coverage or changed generation returns history_reset_required. Newer actions appear after Refresh; they cannot shift existing pages. Reject tampered ordering bounds and unbounded scans.

Read metadata and projection data consistently using the backend's verified snapshot semantics. Otherwise bracket reads with matching progress/configuration/event-anchor observations; retry once on change, then return retryable uncertainty. Do not claim a trustless snapshot.

Action-page anchoring does not freeze mutable receipt summaries. Label current indexed lifecycle separately; never present a current projection as reconstructed historical state merely by adding a block-number filter.
</execute_task>

📦 BUILD TASK #9: apps/web/src/server/history/status.ts and live reconciliation
🛠️ ACTION TYPE: Create

<execute_task>
Define closed HistoryHealth and HistoryPage response schemas outside the immutable receipt protocol. Include configured identity, generation, observedAt, progressBlock, sourceBlock, live checkpoint when available, lag quantities and reason codes. Use availability=available|unavailable, freshness=caught_up|catching_up|unknown and indexConsistency=consistent|recovering|inconsistent|unknown. Include items, nextCursor and the action anchor in page responses.

Compute sourceLag=max(0,sourceBlock-progressBlock) and confirmedLag=max(0,liveCheckpoint.number-progressBlock) with bigint. Unknown inputs remain unknown. caught_up requires both known lags to be zero and coherent, currently observed coverage; otherwise use catching_up or unknown. Show observation time and exact lag, without invented block-to-seconds conversions. Freshness never implies blockchain finality or package integrity.

Require matching deployment/configuration before accepting history. Check index event anchors against canonical Alchemy block hashes when establishing or continuing a page. A mismatch means recovering/inconsistent, not a successful empty result. Bound comparisons to page anchors and the selected receipt; do not perform one RPC per history row.

For a selected receipt return indexed lifecycle and Chapter 6's live result as separate objects. Compare tuples only at the same identified block. If indexed state at progressBlock is no newer than the live confirmed checkpoint and historical reads are supported, compare at that block; otherwise report comparison unavailable or different checkpoints. Recheck hashes around number-pinned reads.

A projection newer than the confirmed live checkpoint may legitimately differ. Mark its newer actions provisional. Never use an unconfirmed index projection to overwrite confirmed verification or mistake expected temporal differences for corruption.

Keep not_indexed, live NotFound, RPC unavailable, index unavailable and actual tuple mismatch distinct. History cannot set TransactionOperation.confirmed, establish package integrity, authorise a signature or satisfy the human-review gate. Only Chapter 6's monitor controls transaction confirmation.

Index failure must leave existing live verification operational. Live failure may leave historical rows visible with their source/checkpoint labels, but cannot preserve a green current-verification badge.
</execute_task>

📦 BUILD TASK #10: apps/web/src/app/api/history routes
🛠️ ACTION TYPE: Create

<execute_task>
Implement read-only routes using the existing Next.js route conventions:
GET /api/history/status
GET /api/history/reviewers/[reviewer]?cursor=...&limit=...
GET /api/history/receipts/[reviewer]/[commitment]

Use configured chain/registry only. Validate lowercase nonzero reviewer addresses, 32-byte commitments, bounded cursors and integer limits. Reject unknown query parameters. These endpoints return public blockchain history; do not require a passkey, vault unlock or private matter identifier.

Enforce existing shared-store request limits, bounded upstream concurrency, AbortSignal cancellation and no-store responses. Apply the established read-only verifier CORS policy where needed; do not use credentialed wildcard CORS.

Return typed unavailable/unknown bodies with appropriate non-success statuses for upstream failures. Use a distinct 409 history_reset_required response for invalidated pagination. A successful empty page is valid only after coherent ingestion coverage and scope checks; its wording remains No indexed history.

Exclude backend auth/vault joins, arbitrary RPC forwarding, user-supplied URLs, on-chain writes and model calls. Sanitise errors and logs; never expose admin headers, source tokens or deployment secrets.

Correlate an already-known application operation with an indexed action using chain, registry, reviewer, consumed nonce, commitments and event identity. Preserve transaction executor differences and third-party relay outcomes. Indexed visibility can annotate an operation but cannot declare its own submitted transaction successful.
</execute_task>

📦 BUILD TASK #11: Aegis review-history panel, activity drawer and indexer indicator
🛠️ ACTION TYPE: Extend

<execute_task>
Integrate ReviewHistoryPanel, ReceiptHistoryDetail and IndexerStatusIndicator into the existing Aegis HUD. Reuse its original visual tokens, orb/status system, responsive layout and accessible controls. Keep account, vault, transaction, live verification and indexer states visibly separate.

Show a paginated timeline of issued, revoked, superseded and nonce-invalidated actions. Render one replacement row linking old and new commitments; offer expandable raw event details. Show reviewer, distinct executor when applicable, transaction link and observed block/time. Never translate registry activity into claims about legal correctness or verified human identity.

Provide selected-receipt lifecycle, direct Previous/Next review navigation, Refresh, Load more, Copy receipt reference and safe explorer links. Mark provisional events, recovering history, delayed coverage, unknown state and empty history in text as well as colour. Do not build a global explorer or unbounded version graph.

Join private matter titles/document labels with receipt references only in browser memory after vault decryption. Match the full chain/registry/reviewer/commitment tuple. Locked or unmatched entries use public identifiers. Clear private labels and stale selection on lock, account switch or generation change; never send those labels to history APIs, analytics or URLs.

Place blockchain events in the activity drawer's public-chain section, separate from assistant work and human decisions. Supply a typed read-only history-status adapter for Chapter 9's /status command; status rendering needs no model call. Do not fabricate assistant narration or enable incomplete approval flows.

After submission, display Chain confirmed; history catching up when appropriate. Refresh visible history at most every 10 seconds for 2 minutes, then offer manual refresh. Pause on hidden/unmounted views, cancel stale requests and reset invalid cursors. Late responses cannot repopulate another account's or matter's view.

Provide keyboard navigation, focus-safe updates, screen-reader status announcements and reduced-motion behaviour. Keep document review dominant in docked mode.
</execute_task>

📦 BUILD TASK #12: indexer transition, replay and rollback tests
🛠️ ACTION TYPE: Validate

<execute_task>
Use the pinned release's createTestIndexer and supported simulation API for deterministic tests. Use meaningful lifecycle assertions derived from Chapter 3's contract, not snapshots that merely restate handler output. Keep network-dependent tests outside the default offline suite.

Cover: first ISSUE; duplicate delivery; independent reviewers sharing commitment bytes; third-party executor; REVOKE; paired SUPERSEDE; repeated replacements; replacement revocation; nonce invalidation before/after issuance; contract-reviewer invalidation with a different outer executor; multiple ordered actions in one block; large integers; preload execution; and restart with existing state.

Assert exact receipt tuples, one action/nonce increment per authorisation, two raw logs for supersession, unchanged active count on replacement and the receipt-count invariant. Test wrong registry, missing predecessor, mismatched paired logs, nonce gap, timestamp mismatch and terminal-state reuse. Each must fail without publishing a partial completed action.

Add a deterministic replay comparison: rebuilding the same ordered source into an empty generation yields identical semantic entities/counters, excluding explicit generation identity. Replaying duplicate events cannot inflate totals.

Exercise actual HyperIndex rollback against a disposable local chain/database using supported runtime controls: index branch A, revert to a common ancestor, mine branch B with a different receipt transition, and wait for reindexing. Verify orphan removal, counter/nonce restoration, links, staging and GraphQL results. Keep the local RPC-mode limitation distinct from HyperSync's production guarantees.

Test beyond-window detection/rebuild handling without reorganising a public chain or deleting shared databases. If a runtime test is blocked, record the precise prerequisite and leave that verification gate incomplete; do not relabel unit tests as live rollback evidence.
</execute_task>

📦 BUILD TASK #13: GraphQL, API and HUD integration checks
🛠️ ACTION TYPE: Validate

<execute_task>
Run generated-schema query validation and focused API/UI tests against the real local Envio GraphQL service. Test page limits/order, new actions between pages, changed anchors, rebuilt generation, simultaneous projection updates, malformed cursors, unsafe integers, partial GraphQL errors, timeouts and rate limits.

Verify empty event ranges do not create false lag from lastEventBlock. Verify unavailable metadata is unknown, healthz alone is insufficient, stale source progress is not proof of freshness and a stopped indexer becomes visibly delayed as the live checkpoint advances.

Use Playwright for one complete history interaction: select a receipt, view replacement links, inspect live/indexed states, paginate, handle history_reset_required and refresh after recovery. Exercise keyboard and reduced-motion paths without broad unrelated UI rewrites.

Test different-block versus same-block lifecycle comparisons. Stop Envio and verify Chapter 6's live receipt reader still works. Stop RPC and verify the UI retains labelled history without claiming current verification. Confirm indexed success cannot mutate operation confirmation or unlock a signing gate.

Test vault lock, account/matter switching and late responses. Use synthetic private-label canaries to assert no private content reaches GraphQL requests, API payloads, logs, URLs or browser-persistent history caches. Confirm public reads need no Mera credential.

Run affected typechecks, lint, unit/integration checks and web/indexer builds. Inspect client bundles for server-only imports and secrets. Fix concrete failures; record exact passed/failed/skipped gates rather than claiming unexecuted checks passed.
</execute_task>

📦 BUILD TASK #14: Real Envio integration evidence and chapter handoff
🛠️ ACTION TYPE: Validate

<execute_task>
When Chapter 6's verified deployment and Envio credentials are available, start the actual HyperIndex service from the deployment block. Query its generated GraphQL API and consume those results through the real history routes/HUD. A local fixture server or imported JSON is not evidence of live Envio ingestion.

Use existing public test receipts where sufficient. If additional lifecycle events are needed, use Chapter 6's explicitly synthetic, guarded testnet harness and existing fee/funding limits. Preserve its signing confirmations and production approval restrictions. Never manufacture production legal-review approvals or redeploy solely to simplify the indexer.

Demonstrate ISSUE, SUPERSEDE, REVOKE and INVALIDATE_NONCE projections; capture actual public transaction/block references and query results. Verify supersession is one action with two raw events, independent reviewers remain isolated and live current status agrees at a comparable checkpoint.

Observe a real indexing delay/recovery or clearly labelled controlled local outage. Record network, deployment, Envio version, source mode, configuration/generation, observation time, progress, GraphQL operation and actual result. Keep live-network evidence separate from local rollback evidence. Redact all credentials and private materials.

Update docs/build-state.json with implemented files, passed gates, observed integrations and unresolved prerequisites. Add compact factual Envio evidence to the existing evidence location; do not create a deployment essay, claim a bounty award or invent performance/traction numbers. Production hosting remains Chapter 13.

Update docs/assistant-ui-contract.md within its established size budget with history states, public activity events and the read-only status adapter. Preserve the larger Aegis assistant and review-screen commitments for Chapters 9–10.

Hand off to Chapter 8 with unchanged receipt/reference formats, typed indexed/live status separation, local private-label mapping and explicit unavailable states. Do not add intake, Qwen calls or autonomous approval here. End after repository edits and truthful build-state updates; omit conversational summaries and terminal JSON reports.
</execute_task>
```
