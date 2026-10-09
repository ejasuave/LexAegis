## Chapter 13 — Production Deployment and Hackathon Submission Assets

This final chapter puts LexAegis online as a working Monad testnet application, with its Aegis interface, private vault and separate verifier. It prepares the public repository, judge instructions, demo and pitch materials, Qwen article and evidence for all five bounties. It also checks the real hosted upload and streaming behaviour, keeps passkey recovery tied to the correct website, and records any missing evidence before submission.

```text
📦 BUILD TASK #1: docs/release/requirements.json and final-chapter contract
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#17 sequentially through repository edits and authorised release operations. Output clean code/configuration files, closed JSON records and the requested submission prose in named files. Omit conversational fluff, architectural essays, full-file echoes and terminal status-report payloads.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, the current project brief and Chapter 12 results. Inspect actual code/configuration and preserve unrelated changes. Prompt authorship is not implementation evidence. Repair concrete release blockers; do not replace missing integrations with mocked success.

Production means production-hosted software using Monad Testnet, chain 10143. Preserve Mera accounts and separate PRF vault keys, Qwen qwen3.8-max, Alchemy, Envio, protocol v1 and the independent verifier. No mainnet, additional provider, autonomous approval or new product scope.

Create a versioned requirements record from the supplied brief and current organiser/sponsor rules. Retain source URL/file, checkedAt and user_supplied|official_verified|unverified status for each external requirement. Do not infer a submission portal or eligibility from third-party roundups or another event edition.

Carry forward the internal target 2026-10-12 and supplied deadline 2026-10-14T04:59:00+01:00, equivalent to 2026-10-14T03:59:00Z. Recheck the exact organiser timezone/date before submission. A failed lookup does not extend the deadline. Preserve conflicting requirements visibly instead of silently replacing them.

Carry forward: public repository, live application, contract details, logo <=3 MB, working-product demo <=180 seconds, pitch <=120 seconds, judge access and five bounty evidence sets including a published Qwen article. Verify actual portal fields/file limits and record unresolved requirements.

Use existing authorisation for configured deployment/publication targets; do not request it again. Complete files, checks and assets before requesting any genuinely missing account, billing or publication decision. Missing external access blocks only dependent operations; continue independent tasks. Do not fabricate deployment, video, publication or submission completion.
</execute_task>

📦 BUILD TASK #2: deploy/target.json, environment schemas and stable origins
🛠️ ACTION TYPE: Create

<execute_task>
Reuse the repository's configured hosting target if it satisfies the existing runtime requirements. Otherwise implement one minimal Docker-based Railway target: a Node web service, a separately served static verifier, PostgreSQL and a private S3-compatible store; deploy the indexer through the verified Envio hosting path. Reuse provisioned compatible resources before creating any.

Inspect current platform documentation and selected-plan capabilities:
https://nextjs.org/docs/app/guides/self-hosting
https://docs.railway.com/networking/public-networking/specs-and-limits
https://docs.envio.dev/docs/HyperIndex/hosted-service-deployment

Record exact provider project/environment/service identifiers, resource limits, region, approved spending policy and durable-data locations in private operator configuration. Publish only an allowlisted projection. Do not promise free hosting, invent costs or enable unbounded autoscaling/paid upgrades.

Select one durable HTTPS application origin before creating production-demo passkeys. Pin the existing configured rpId, auth domain/URI and allowed origins; do not derive them from forwarding headers or widen the relying-party scope to bypass recovery restrictions. A temporary preview origin is not an interchangeable recovery origin.

If development credentials belong to a different rpId, explain that they cannot simply become production credentials. Use a deliberately created production test account or explicit readable-data portability without claiming the same signing identity. Preserve historical references unchanged.

Give the verifier a separate stable HTTPS origin with no application session or passkey dependency. Configure explicit navigation, CORS/CSP and public RPC policy. Do not put private packages in URLs or use the application backend as its mandatory verifier transport.

Extend existing environment schemas; do not invent parallel variable names. Separate public build inputs from server/runtime secrets. Runtime-only values include Alchemy/Qwen/Envio credentials, database/storage credentials and the optional testnet funder key. A deployer key belongs only to the guarded deployment command, never the running web service.

Keep secret values out of Docker ARG/layers, public environment prefixes, build logs, screenshots and release records. Missing required configuration must remain unavailable. Missing optional voice capability retains the full text workflow.
</execute_task>

📦 BUILD TASK #3: apps/web and apps/verifier production container artifacts
🛠️ ACTION TYPE: Create

<execute_task>
Create minimal multi-stage Dockerfiles and a scoped .dockerignore using the pinned Node/pnpm versions and real lockfile. Build from the correct monorepo context with frozen dependency resolution. Preserve compatible package/module conventions; no speculative toolchain upgrade.

Build apps/web with the installed Next.js standalone/output-tracing conventions. Include required workspace runtime dependencies, public assets, static chunks, parser workers and any existing local WASM/font assets. Test the actual image, not only the monorepo dev server. Bind the platform PORT on 0.0.0.0 and run as a non-root user.

Keep backend route handlers in the Node runtime. Do not turn the web application into a static export or move private operations into the browser to bypass hosting limits. Do not supply fake secrets merely to make next build pass; validate server secrets at the appropriate runtime boundary.

Build apps/verifier into static assets and serve them independently with a minimal production static server and correct route fallback, MIME types and security headers. Its bundle may contain only deliberately public deployment/RPC configuration, never application/provider credentials.

Use immutable build/release identifiers and preserve asset compatibility during rollout. A required reload locks private state and invalidates pending UI tickets; do not persist secrets or silently replay writes to survive version changes.

Add local image smoke checks for startup, health routes, static assets, worker loading, CSP and independent verifier operation. Fail on missing traced files, browser Node imports, leaked secrets or test adapters in production exports.

Emit reproducible artifact digests and a secret-free release manifest. Do not claim byte-identical images if the build is not reproducible; record actual observed digests. Do not embed mutable latest tags as the only rollback reference.
</execute_task>

📦 BUILD TASK #4: Public repository, README and reusable package release artifacts
🛠️ ACTION TYPE: Extend

<execute_task>
Prepare the existing repository for judge/developer access. Scan the complete history and files selected for publication, generated bundles, fixtures and media for secrets/private evidence. Keep raw credentials, authentication state, confidential documents, signatures and sensitive traces excluded.

If a real secret is exposed, stop publication of affected material and complete authorised revocation/rotation and remediation. Deleting the working-tree file is insufficient. Do not rewrite shared history or change visibility without the required authority; prepare a concrete safe release candidate first.

Use the existing repository owner/name and licence when established. Otherwise resolve the actual publication destination and project licence before public release. Do not invent organisation ownership, copyright holders, third-party licence permissions or customer endorsements.

Write a concise README with the problem, actual MVP capabilities, hosted app/verifier links, supported setup, exact local build/test commands, contract network/address, SDK example and known limits. Keep infrastructure reusable independently of the legal reference application. Explain receipt integrity/approval versus legal correctness.

Include the Chapter 11 tested package artifacts, generated schemas/ABI and generic example. Prove a clean clone and packed consumer work without monorepo-only paths. Public npm publication is not an MVP requirement; perform it only if an owned namespace and explicit publication intent already exist.

Publish the sanitised candidate to the authorised GitHub destination using ordinary non-force operations. Preserve unrelated branches/tags and established protections. If publication is not authorised or access is missing, keep the complete candidate ready and record that public access remains blocked.

Check the repository anonymously. The supplied judge address metropolis@hackathon.monad.xyz must not need private credentials to read a public repo. Do not send invitations/email or add collaborators merely because that address appears in the brief. Keep videos and large recordings out of source history.
</execute_task>

📦 BUILD TASK #5: Operational database, ciphertext storage and migration release
🛠️ ACTION TYPE: Extend

<execute_task>
Configure the existing PostgreSQL and private S3-compatible adapters for the selected hosted environment. Preserve account ownership, immutable object IDs, quotas, ready-state checks, catalog compare-and-swap and ciphertext-only storage. No local container filesystem may be the sole durable evidence store.

Use separate application/indexer database roles or databases, least-required storage permissions and private endpoints where supported. Keep databases, bucket listings and admin consoles off public unauthenticated access. Validate TLS through maintained client configuration; do not disable certificate verification.

Run existing migrations once through a controlled release job with a database lock and recorded version. Test against a disposable restored schema first. Use backward-compatible additive changes for this release; no destructive reset, automatic down migration or database recreation to fix a deployment error.

Verify the chosen object store's actual conditional-create semantics using isolated synthetic objects: identical retry succeeds, conflicting overwrite fails, read-back digest/length matches. An ETag is not the application's SHA-256. Unknown capabilities block vault readiness.

Prove an authenticated encrypted object traverses the deployed upload path without truncation, is stored privately and can be retrieved/decrypted by its owner. Preserve the 16 MiB wire-object route limit and existing artifact/account quotas; do not globally raise other body limits.

Enable an existing provider-supported backup/version-retention facility with a documented bounded retention policy. Back up operational metadata and encrypted object references consistently; never add user keys to make recovery easier. Verify the restore path in Task #11.

Retain auth revocation, quota, run-admission and pending transaction/funding records across restarts. A storage outage is unavailable, not an empty vault. Do not auto-delete unreachable ciphertext or expired proof history during release.
</execute_task>

📦 BUILD TASK #6: Monad deployment identity and Alchemy runtime configuration
🛠️ ACTION TYPE: Validate

<execute_task>
Reuse Chapter 6's verified registry deployment and exact public artifact. Recheck chain 10143, genesis, registry code, protocolVersion, deployment block/hash and observed runtime-code keccak256 through the configured Alchemy endpoint. Reject mainnet, wrong code/domain and missing pins.

If no valid deployment exists, use the existing guarded Foundry testnet script with an authorised operator-owned deployer and bounded fee policy. Do not redeploy on startup or to conceal uncertainty. Preserve non-upgradeable/ownerless behaviour and existing ABI/action signatures.

Where supported, publish contract source verification using exact compiler, optimiser, EVM target, constructor/link/immutable metadata. Explorer verification failure stays visible; it is distinct from runtime-code identity and transaction success. Never invent a verification link.

Generate one secret-free deployment projection for web, SDK, verifier and Envio. Keep its chain/address/start block/ABI/profile consistent. A new registry requires explicit new configuration and newly bound packages; do not rewrite existing frozen references.

Probe the real Alchemy capabilities required by existing checkpoint, simulation, fee and transaction-monitor code. Preserve conservative execution assurance, integer fee arithmetic and current gas/spending ceilings. No silent RPC fallback or fixed sleep advertised as finality.

Load an optional dedicated testnet funder only in the server runtime. Preserve explicit Request test MON, cooldown/global-budget reservations and durable outbox behaviour. Never use the deployment key as a user signer, automatically top up an account or purchase funds.

Record actual public deployment/capability evidence with safe provider identifiers. Installed packages or configured API keys alone do not prove a working Alchemy integration.
</execute_task>

📦 BUILD TASK #7: indexer hosted build, configuration and public-history service
🛠️ ACTION TYPE: Extend

<execute_task>
Prepare the actual Envio V3 indexer for the selected hosting service. Verify that its pinned runtime, package scripts, build root and generated GraphQL schema are supported. Reuse config.yaml, schema.graphql and handlers; do not replace HyperIndex with a handwritten event poller.

Preserve Monad Testnet HyperSync ingestion, the actual inclusive deployment start block, registry/event ABI, lowercase addresses, rollback settings, projection fingerprint and generation semantics from Chapter 7. Keep ENVIO_API_TOKEN and hosted admin credentials in server-side secret configuration.

Ensure the hosted build can resolve all imports inside its permitted build context. Generate/copy the required public ABI and neutral build artifacts deterministically, checking their hashes against the source. Do not copy private app dependencies or hand-maintain divergent event definitions.

Use an explicit deployment branch/revision and indexer identity. Deploy through the authorised service; if its current runtime cannot support the pinned implementation, prepare the documented self-hosted container path on the selected host and record the choice. Never silently downgrade schema/handler semantics.

Wait for actual initial sync and coherent coverage from the real start block before claiming caught_up. Validate named queries against the deployed GraphQL schema; use read-only credentials/roles where available and keep generic/admin GraphQL access out of the browser.

Compare public lifecycle examples with canonical Alchemy observations at compatible checkpoints. Verify supersession counts once as an action, generation-aware cursors and honest lag/outage indicators. Index success cannot establish transaction confirmation or private-package integrity.

Use a plan that keeps the indexer running through judging within authorised spending limits. Record observed plan/quota constraints; do not assume a temporary development deployment will remain available. If service access is unavailable, finish deployable files and record live indexing as blocked.
</execute_task>

📦 BUILD TASK #8: Hosted ingress, streaming, health and graceful shutdown
🛠️ ACTION TYPE: Extend

<execute_task>
Configure the real ingress/proxy and web service for existing route-specific limits: 16 KiB controls, 16 MiB vault objects and 128 KiB assistant start requests. Preserve streaming byte-counted rejection and no-store headers; a provider's upload limit does not replace application limits.

Verify the complete POST/fetch SSE path supports the 120-second assistant deadline plus bounded shutdown/network margin. Disable buffering/compression where they delay events and preserve backpressure/cancellation. Heartbeats are transport keepalives, not fabricated task progress.

Test deployed ingress with bounded synthetic uploads and a protected, temporary release probe or existing test harness. Demonstrate progressive event arrival and oversized rejection without paid inference or a permanent public diagnostic endpoint. Remove probe-only access after validation.

Use HTTPS URLs directly, including API clients; do not depend on a redirect preserving POST bodies. Apply the existing CSP, secure cookies, origin/CORS checks, Permissions-Policy and referrer policy to actual responses. No wildcard credentials, broadly weakened script policy or secret-bearing public URLs.

Keep the initial deployment to one correctly sized application replica unless the existing multi-replica tests justify more. Preserve shared PostgreSQL admission/leases; no new Redis/queue service. Account for browser hashing/parser memory and concurrent request copies when selecting limits.

Separate process liveness from dependency readiness. Readiness reports redacted capability states and actual dependency failure; it must not report completed legal review or expose credentials. Disable sensitive body/header capture in hosting logs, tracing and error reporting.

On shutdown, reject new work, drain bounded active operations or mark them interrupted/unknown, abort provider requests where possible and preserve durable transaction reconciliation. Never broadcast/re-sign automatically after restart. Configure restart/uptime behaviour deliberately; do not promise high availability from one replica.
</execute_task>

📦 BUILD TASK #9: scripts/release.ts and deployment execution
🛠️ ACTION TYPE: Create

<execute_task>
Implement one small release command around the established provider CLI/API and existing build checks. Use prepare, deploy and verify phases with explicit target/revision/configuration inputs. Do not add Terraform/Kubernetes or a second deployment framework for this MVP.

Prepare an immutable candidate manifest binding tested source revision, non-secret configuration digest, container/static artifact digests, migration version, registry identity and indexer projection. Keep secret values and secret-derived hashes out of the manifest.

Require Chapter 12's applicable local safety gates before deploying a candidate. Hosted-only observations necessarily follow deployment; record them as pending without relabelling a failed local security gate as deferred. Use synthetic data until the hosted checks pass.

Resolve the authenticated operator, intended project, stable origins and resource/billing scope before mutations. Reuse existing authorisation. If a genuinely unapproved purchase or target change is necessary, prepare its exact configuration/cost implications and defer only that action while completing other assets.

Apply additive migrations once, publish exact web/verifier artifacts and activate the verified indexer configuration in dependency order. Runtime probes must gate application readiness. Do not automatically run contract deployment, funder transfers, paid Qwen smoke or user signatures as deployment hooks.

Make retries idempotent by observed release/service IDs. After a timeout, query actual deployment state before creating another environment. Preserve previous artifacts and data. Never force-push, recreate the database/bucket, change rpId or rotate a registry simply to obtain a green deployment.

Execute through configured authorised access; do not stop at writing a Dockerfile when the release can be deployed. Missing credentials/services remain factual blockers, with all buildable assets completed. Record actual release IDs, URLs, timestamps and outcomes from the provider, not intended values.
</execute_task>

📦 BUILD TASK #10: scripts/hosted-smoke.ts and real-origin recovery evidence
🛠️ ACTION TYPE: Validate

<execute_task>
Validate the deployed candidate from a clean browser/session and the real HTTPS origins. Check static assets, workers, secure cookies, headers, auth, database/object access, upload bounds, genuine SSE progress and the independent verifier. A root-page 200 response is insufficient.

Run Chapter 12's integrated synthetic journey through the deployed controls. Use genuine Mera ceremonies under the user's control, real Qwen tools within explicit disclosure/budgets and approved Monad testnet actions with separate action/Send confirmations. Reuse existing valid evidence when equivalent; no automatic fee-paying operation to populate a screenshot.

Verify a source-linked answer and deterministic payment result, explicit human decisions, immutable saved/read-back capture, successful receipt execution, Envio history and independently supplied-reference verification. Inspect actual output; a configured adapter or provider ping cannot establish the workflow.

At the final configured rpId, demonstrate recovery after clearing only the test origin's browser storage with specific consent while retaining the credential. Require the same account and decrypted bytes/commitment. Test the same available synced credential on a separate supported device where available; record missing hardware honestly.

Check reference-only/local-file verification with the web backend unavailable using controlled request blocking, not a production outage. Separately test the verifier's explicit public RPC transport. No wallet, account login, model or hosted LexAegis service may be required for local integrity verification.

Observe pending/unknown, revoked/superseded and tampered-file outcomes using existing synthetic evidence or explicitly authorised lifecycle actions. Preserve as-of checkpoints and indexed/live distinctions. Do not weaken confirmation rules to shorten the demonstration.

Record actual device/browser capabilities, ceremony counts, latency stages, release identity and public references. Redact credentials, raw signatures and private payloads. Missing required live results remain blockers to the corresponding product/bounty claim; text-only voice fallback remains valid when honestly labelled.
</execute_task>

📦 BUILD TASK #11: scripts/release-rollback.ts and bounded restore checks
🛠️ ACTION TYPE: Create

<execute_task>
Implement a minimal rollback command selecting a recorded previously tested image/static release on the same services, origins and rpId. Check database/schema/configuration compatibility before activation. Do not downgrade destructively, restore stale chain state or overwrite private captures.

Keep the ownerless registry and already published receipts unchanged. Code rollback cannot revoke signatures, reverse transactions or remove public history. Restore only application availability; maintain unknown transaction outcomes until read-only reconciliation resolves them.

Exercise database/ciphertext backup restoration into an isolated disposable namespace. Verify restored descriptor/head/reference relationships and exact encrypted object digests. A database-only restore without referenced ciphertext is incomplete. Do not overwrite the running dataset as a test.

Disable funding, broadcasts and new assistant work during any actual operational restore until safety checks finish. Expire restored sessions/challenges so a backup cannot revive revoked login state. Reconcile pending operations, funder outbox/nonces, quota/spending reservations and live chain observations before allowing new mutations.

Rebuild Envio-derived state from the genuine deployment start block when needed, using a new generation and cursor invalidation. Do not reset operational auth/vault storage or claim a replayed index is a rollback of Monad.

Record observed restore duration and data coverage, not invented recovery objectives. Verify account/vault recovery separately under the same original usable credential/rpId; restoring ciphertext cannot recreate a deleted credential. Do not add key escrow or automatic destructive garbage collection.

Add only concise actual rollback/restore commands and prerequisites to the operator README. Keep backups private and within the configured retention policy. Automatic failure handling may disable unsafe work; it must not create new transactions or silently replace user evidence.
</execute_task>

📦 BUILD TASK #12: submission/judge-guide.md and public synthetic demonstration assets
🛠️ ACTION TYPE: Create

<execute_task>
Create a short judge guide with actual application/verifier URLs, verified browser/passkey support, explicit account/vault actions, optional test-MON request and a reproducible synthetic review. Judges use their own credentials; never distribute a signing key, shared passkey or authenticated browser state.

Reuse the fictional £24,000 total with £10,000 and £12,000 instalments. Provide original synthetic source files and an actual corrected version with consistent totals. The £14,000 what-if remains SIMULATED until a genuinely changed source is imported and reviewed.

Expose the sample through existing import/sample controls or a small public asset link. Do not add a second demonstration application, pre-approved gate, public write bypass or hidden prerecorded assistant replacing live execution.

Provide a clearly labelled pre-existing synthetic readable package and public receipt reference for immediate independent verification without account setup. Derive them from a real completed review/export; if none exists, do not invent an Active receipt or fill an address placeholder.

Offer both an intact package and an explicitly labelled tampered copy for integrity comparison, preserving the original expected reference separately. Do not include keys, real client material or a fake signed certificate.

Explain current capability limits briefly: supported text documents, draft/reviewed rule status, selected plaintext inference, testnet fees and optional local voice. A receipt proves package/account binding, not legal validity or practitioner qualification.

Test the guide in a clean anonymous browser and a fresh supported account. Ensure links do not require the developer's cookies, cloud-console access or GitHub login. Keep funding/rate limits visible and avoid promises that every unsupported device can complete onboarding.
</execute_task>

📦 BUILD TASK #13: submission/sponsor-evidence.json and evidence index
🛠️ ACTION TYPE: Create

<execute_task>
Create a closed versioned evidence manifest for the five approved bounty targets. Each entry includes exact supplied bounty name, current rule source/status, implemented modules, tested release, evidence class, public artifact/clip/reference links, observed result, limitations and missing requirements.

Map Best Mera-Powered UX on Monad to the entire Mera account flow, actual onboarding/signing-session behaviour, expiry/re-prompt, confirmed testnet execution and storage-cleared recovery. Record real tap/prompt counts; do not promise a universal one-ceremony experience.

Map Mera: One Passkey, Many Keys to separate account/vault PRF namespaces, browser encryption and actual same-credential recovery/decryption evidence. A fresh key, cached plaintext or copied signing secret is not recovery.

Map Best Use of Envio to deployed config/schema/handlers, genuine indexed ISSUE/REVOKE/SUPERSEDE history, useful projections and observed lag/reconciliation. Code fixtures and local rollback tests remain labelled as such.

Map Best Builds with Qwen 3.8 Max to actual qwen3.8-max execution, model-requested read-only tools, validated source-linked outputs, observed budgets/usage and the published article. A chat completion or hardcoded tool trace alone is insufficient.

Map Best Projects using Alchemy to actual configured Monad reads, exact signed-transaction transmission, execution monitoring and current-state checks. Keep Mera as the user signer; do not expose Alchemy credentials to prove usage.

Reuse verified evidence from Chapters 4–12; refresh only stale configuration-dependent observations. Link source code to the actual commit and media to genuine captures. Never infer eligibility, award wins, external users or practitioner approval from integration completion. Describe Qwen/Alchemy credit awards as credits if mentioned; avoid unverified prize arithmetic.
</execute_task>

📦 BUILD TASK #14: submission/technical-demo.md, pitch.md and recording artifacts
🛠️ ACTION TYPE: Create

<execute_task>
Write a timed working-product demo script with a maximum final duration of 180 seconds and a practical target of 175 seconds. Show the product immediately; do not substitute slides or a code walkthrough.

Use this bounded sequence, adapting only to actual observed UI:
0–15s: open the Aegis workspace and state the portable Proof of Review problem;
15–50s: run/inspect genuine Qwen tool work and open the £2,000 discrepancy at its sources;
50–65s: distinguish SIMULATED what-if from the genuinely corrected source;
65–110s: show human decisions, freeze/read-back, action approval and separate Send confirmation;
110–145s: show real execution, indexed history and independent verification;
145–165s: show tamper rejection and a genuine lifecycle example;
165–175s: show reusable SDK/verifier access and the product's exact limits.

Record actual software and user-controlled ceremonies. Waiting may be cut for duration only with an honest elapsed-time disclosure; never splice a fabricated successful result, erase required confirmations or imply edited footage proves one-prompt onboarding. Keep full measurements separately.

Create supplementary short bounty captures for session expiry, storage-cleared recovery and same-credential second-device decryption where the main limit prevents inclusion. Verify whether the portal accepts supplementary links; do not assume they replace required main-video evidence.

Write a separate pitch <=120 seconds, targeting <=230 spoken words: problem/customer, reusable protocol and legal reference app, why Monad, actual team capability, evidence achieved and next validation step. Use only verified founder/team/traction facts. Planned interviews/design partners are plans, not customers or revenue.

Create recordings with available capture tools and supplied/user-recorded narration; never fabricate a person's voice or claim a human ceremony occurred without footage. If recording requires unavailable interaction, finish scripts/shot lists/captions and mark the video missing rather than generating a fake product demo.

Inspect exported duration, legibility, audio, subtitles and credential redaction. Use real measured MP4 metadata. Upload to the authorised YouTube/Loom/Vimeo destination only when publication authority/access exists; verify anonymous playback and record actual links. A local filename is not a hosted video URL.
</execute_task>

📦 BUILD TASK #15: submission/qwen-article.md and public article route
🛠️ ACTION TYPE: Create

<execute_task>
Write the complete Qwen article from actual implementation and sanitised live evidence, aiming for 700–1,000 words unless current bounty rules require otherwise. Explain the concrete review problem, why bounded agent/tool execution helps, what qwen3.8-max actually did and what deterministic code/human reviewers remained responsible for.

Include one synthetic source-linked example, actual requested tools and validated results, prompt/schema/config versions, measured latency/usage when observed, failure/cancellation behaviour and the limits of the evidence. Do not publish hidden reasoning, complete private provider transcripts, credentials or legal client data.

Distinguish model-requested actions from code execution. Explain that tools cannot approve/sign and that arithmetic, source bindings, vault keys and receipt verification are controlled outside the model. Do not call model outputs deterministic or claim inference is zero-knowledge.

Use original concise prose and factual screenshots from the working HUD. Credit current official API references and preserve third-party licences. No invented performance gains, user quotations, token savings, endorsements or claims that an API key proves successful agent behaviour.

Prepare a small static first-party article route, such as /build/qwen, using the existing web stack; no CMS/blog subsystem. If official rules require a different publishing destination, prepare the same complete article for that authorised destination and track that unresolved requirement.

Publish only factual completed claims. If required live Qwen evidence is missing, keep the article as a complete draft with that limitation and leave the bounty-publication gate incomplete. Do not publish a planned implementation as a demonstrated integration.

When publication is authorised and evidence exists, release the article through the same tested deployment pipeline, check its public canonical URL anonymously and record the actual publication/revision time. Recheck linked code/evidence and update the bounty manifest. An unpublished Markdown file does not satisfy the published-article requirement.
</execute_task>

📦 BUILD TASK #16: submission/project.json, brand assets and submission validator
🛠️ ACTION TYPE: Create

<execute_task>
Prepare the actual form-ready project text and a closed versioned submission manifest. Include project name, concise summary, problem/customer, implemented solution, track, team facts, technical components, actual adoption/validation, limitations and next steps. Adapt to verified form field limits; never invent portal fields or completed traction.

Position the open protocol/SDK/verifier as the infrastructure and the Aegis legal workspace as its reference application. Distinguish signing-account approval from settlement signature/legal validity. Address the supplied judging dimensions with evidence: technical execution, design/developer experience, originality/track insight, founder/market readiness and traction/path forward.

Reuse the existing original LexAegis logo. If absent, create a simple original vector mark/wordmark and export a valid PNG with the existing renderer; no copied Marvel identity or unlicensed sponsor artwork. Inspect legibility and decoded image type. Keep the submitted logo <=3,000,000 bytes and within an accepted JPG/JPEG/PNG/WEBP format.

Create a release asset manifest for logo, synthetic screenshots, technical/pitch videos, judge guide, deployed contract details, five bounty evidence entries and article. Bind local assets with SHA-256 of exact bytes; use observed public URLs for uploaded assets. Do not hash a file including its own digest.

Implement scripts/validate-submission.ts to validate schema, required fields, file signatures/size, measured video duration, safe public URLs, actual repo access, app/verifier health, article publication and evidence completeness. Use explicit unknown/blocked states; no dummy address, placeholder URL or guessed upload receipt.

Check links with bounded requests and approved public destinations. Detect login walls, wrong releases, private media, redirects to unintended sites and missing content; HTTP 200 alone is insufficient. Use browser inspection where needed. Link checking must never post a form or attach credentials to third-party URLs.

Produce a compact ready-to-upload directory/archive containing only intended public assets and form copy. Keep secrets, raw auth state, private evidence, internal access notes and unnecessary binaries excluded. Do not create an optional advertisement or slide deck for this MVP.
</execute_task>

📦 BUILD TASK #17: Final release verification, submission handoff and library completion
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected local gates, container/package checks, hosted smoke checks and the submission validator against one identified final revision. Release any completed article/asset changes through the same authorised pipeline and repeat the affected public checks. Keep previously passing evidence only where its source/configuration remains applicable.

Maintain separate authored, locally_passed, deployed, live_verified, published and submitted records. A repository commit is not deployment; a published site is not a submitted entry. Required blocked/not_run evidence cannot be changed to pass by an assistant summary.

Recheck the current organiser deadline/timezone and actual submission portal before the final action. Keep the supplied 12 October internal target and 14 October 2026 04:59 BST cutoff unless authoritative event-specific information establishes a change. Do not report on-time submission from a local clock estimate or an unsent form.

Make the complete form copy, exact public links, accepted logo and measured videos ready for review. Reuse explicit submission authorisation if already present; otherwise leave only the final submission action for the user. Do not infer permission to send email, accept unreviewed legal declarations, spend new funds or post to unrelated accounts.

If authorised and supported, submit the reviewed fields/files through the actual portal and retain its observed confirmation/entry ID/time. If access or a required human action is unavailable, record ready_for_submission or blocked with the exact missing item; do not claim submitted. Continue all other authorised release work before handing back.

Keep the application, verifier, RPC capacity and Envio service available for the organiser's verified judging period within approved budgets. Do not automatically destroy services or reset public demonstration receipts at the submission deadline. Use existing operational controls; no new monitoring platform or unsolicited messages.

Update docs/build-state.json, the compact project README and relevant project brief with actual results/links/blockers. Preserve previous chapter records and distinguish the completed 13-chapter prompt library from the implementation's verified status. Keep CLAUDE.md <=450 words and docs/assistant-ui-contract.md <=1,200 words.

Finish with executable deployment assets, the working hosted MVP where access permits, truthful public evidence and the complete submission package. Stop after Chapter 13. Do not generate Chapter 14, introduce speculative features or replace repository deliverables with a terminal JSON report.
</execute_task>
```

