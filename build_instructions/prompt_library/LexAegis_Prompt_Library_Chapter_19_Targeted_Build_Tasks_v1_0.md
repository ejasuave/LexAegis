## Chapter 19 — Judge Experience and Demo Reliability

This chapter makes the project easier for judges to try and the demonstration easier to repeat. It adds a guided starting page, receipts that can be checked without an account, clear service-status information, and limits that protect your model credits and testnet funds. It also provides a safe way to restart the fictional demonstration without deleting other users’ files or pretending blockchain history disappeared.

The prompts finish the demonstration instructions and submission checks. Missing videos, broken links, untested features and unsupported claims stay visible until they are resolved. Completing this chapter file does not mean the software has been built, the live demonstration has passed or the hackathon entry has been submitted.

```text
📦 BUILD TASK #1: docs/build-state.json and Chapter 19 implementation contract
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#13 sequentially through repository edits and meaningful checks. Produce working routes, bounded controls, reproducible scripts, compact documentation and factual evidence. Omit conversational filler, architecture essays, full-file echoes and standalone terminal JSON status summaries. Required API/script report formats remain permitted.

Read applicable repository instructions, CLAUDE.md, docs/assistant-ui-contract.md, docs/build-state.json, the v3 brief and Chapters 14–19 amendment. Inspect implemented Chapter 6 funding/transaction policy, Chapter 9 budgets/cancellation, Chapter 12 evidence, Chapter 13 release/submission assets, Chapter 14 gates/smoke/readiness, Chapter 17 security/deployment checks and Chapter 18 adoption evidence. Inspect actual paths before each task; reuse equivalents and preserve unrelated changes. Do not spawn agents.

Mapping: #2–3 = 19.1 [Must]; #4 = 19.2 [Should]; #5–6 = 19.3 [Must]; #7–8 = 19.4 [Must]; #9 = 19.5 [Should]; #10–12 = 19.6 [Must]. Tasks #1/#13 protect compatibility and consolidate the handoff. Missing code blocks dependent work; authored prompts are not implementation evidence.

Preserve protocol/export schemas, existing vectors and digest/commitment construction; registry source/ABI/bytecode and EIP-712 authorisation; Mera derivation, memory-only keys and vault formats; explicit disclosure, human review, action approval and fee/Send confirmation; SDK/CLI verification semantics; and server-owned feature flags. No new wallet/provider, hidden test mode, automated approval or mainnet action.

Resolve duplicate documentation/commands against Chapter 13 before adding files. Extend its release requirements, judge guide, sponsor manifest, media records and submission validator through adapters or checked cross-links. Keep one authoritative evidence set and one final submission decision. The v3 primitive-first framing and current amendment supersede older presentation ordering; do not rewrite previous prompt chapters.

Reuse the pinned Next.js/Node/PostgreSQL stack and existing test/evidence tooling. Consult installed-version guidance and current primary documentation where needed: https://nextjs.org/docs/app/api-reference/file-conventions/route, https://nextjs.org/docs/app/guides/self-hosting, https://www.postgresql.org/docs/current/transaction-iso.html and https://www.postgresql.org/docs/current/explicit-locking.html. Do not upgrade the stack or add a queue/monitoring service for these tasks.

Keep application hosting on Monad testnet distinct from mainnet. Use existing authorised release targets when already available; this chapter prepares/tests changes without automatically publishing a new release, sending outreach or submitting an entry. Real passkey ceremonies, paid synthetic model runs and testnet writes use the existing explicit operator/user flows; CI and health checks cannot perform them.

Record command, UTC date, source commit/dirty-state fingerprint, configuration revision, environment, evidence class, outcome and sanitised references through the existing writer. Separate local, virtual-authenticator, real-device, live-testnet, hosted, published and submitted evidence. Unknown values remain NOT YET; a screenshot or populated address alone does not prove completion.

Acceptance: prerequisite implementations, protected baselines, canonical release records and source-to-task mapping are identified without changing protocol or approval boundaries.
</execute_task>

📦 BUILD TASK #2: config/judge-receipts.json and public synthetic samples
🛠️ ACTION TYPE: Create

<execute_task>
Create or extend a versioned application configuration file for pre-issued judge receipts, reusing Chapter 13's sample assets. Keep it outside protocol v1. Define a strict draft/ready distinction: draft entries may contain explicit NOT YET fields; submitted entries require complete evidence-backed values. Do not substitute zero addresses, example hashes or local-chain records for testnet evidence.

For each ready entry record a stable sample ID, synthetic-data declaration, created-in-advance label, the existing full ReceiptReferenceV1, actual issuance transaction hash, exact readable-package location and file hash, separate expected-reference location, explorer link, and last observed checkpoint/status/evidence reference. Keep creation/issuance observations distinct from current lifecycle; a receipt may later be revoked or superseded.

Obtain package bytes and references from a real completed synthetic review/export using the existing encrypted-save, approval and transaction path. Reuse an existing valid sample where possible. If none exists, finish configuration/asset wiring and leave live creation NOT YET until an operator completes the existing real workflow. Do not sign on behalf of a reviewer, manufacture a success fixture or automatically generate transactions during build.

Read back the actual issuance and current registry state with the trusted testnet reader. Verify the complete exported package against its independently retained reference. Require at least one intact, genuinely issued sample available for immediate checking; prefer an Active sample for the main positive demonstration. If a configured positive sample becomes terminal, display that fact and fail its positive-demo expectation rather than relabelling it Active.

Provide an explicitly labelled tampered copy that changes an artifact byte while retaining the original expected reference and a well-formed export container. Verify that it fails integrity for changed evidence, not merely malformed JSON. Never overwrite the intact original or issue a receipt for the tampered copy as if it were the original.

Only deliberately public fictional documents, readable openings and evidence belong in these assets. Scan for keys, authentication state, provider secrets and real client material. Explain that publishing a readable package discloses its contents; the commitment does not make a public download private.

Serve sample downloads and public references without an application account. Navigate to the independent verifier using only public reference information supported by its existing handoff; keep package bytes/openings out of query strings and analytics. Do not add an automatic cross-origin evidence upload or make the verifier depend on LexAegis cookies/backend access.

Test schema validation, wrong-chain/reference rejection, altered samples, stale lifecycle observations, unavailable RPC and missing assets. Local tests use separately labelled local configuration excluded from submitted assets. Render incomplete entries as unavailable during development without fake links; Task #12 rejects them for submission.

Acceptance: each ready sample has exact verified bytes and genuine testnet provenance, or remains explicitly incomplete; no-account downloads work; published claims never come from a local simulation.
</execute_task>

📦 BUILD TASK #3: apps/web /judge route and docs/JUDGES.md
🛠️ ACTION TYPE: Create

<execute_task>
Create /judge in the existing App Router and docs/JUDGES.md, preserving the established UI/accessibility system. The introductory route is anonymously readable; all account, vault, analysis and mutation handlers retain their existing authentication/ownership checks. Link Chapter 13's judge guide to the same maintained instructions instead of creating conflicting copies.

List only browser/OS/authenticator combinations actually verified in Chapter 12 or applicable hosted evidence. Distinguish onboarding, PRF support, scoped signing and same-credential recovery. Mark untested combinations untested; a feature-detection result or virtual authenticator is not proof of real-device support. Preserve the deployed origin/rpId boundaries and do not promise credentials from a different origin will recover the same vault.

Explain that passkeys cannot be shared as login credentials. Each judge creates or uses their own supported account; supply no shared signing key, passkey, authenticated cookie or saved browser profile. Account access and explicit vault unlock remain distinct where the implementation requires them.

Provide a Load synthetic matter action through the actual import/matter controllers after authorised account access and vault unlock. Load the bundled fictional original agreement, preserving exact bytes; create an account-owned working copy with fresh identifiers. Do not set reviewed/approved flags, restore another user's encrypted vault or send document content to Qwen automatically.

Guide the judge through five visible stages:
1. Open their account/vault, load the fictional matter and request test MON through the existing explicit funding control when needed.
2. Inspect disclosure, Send the selected text, watch genuine assistant/tool progress and open the £2,000 discrepancy at its source.
3. Distinguish the labelled payment what-if from an actual corrected source; review the real source version, confirm facts/decisions and freeze/save/read back the package.
4. Approve the exact action, separately confirm fees/Send, and observe actual transaction execution without equating pending with confirmed.
5. Export deliberately, check files and current receipt state independently, and inspect tamper/lifecycle evidence without erasing history.

Keep the £24,000 total, £10,000/£12,000 original instalments and genuine corrected £14,000 second instalment consistent with existing fixtures. A simulated number must never edit the source or enter an approval package silently.

State current application funding limits accurately from validated policy, including that test MON and capacity are limited and fees still apply. On exhaustion/unavailability retain the no-account path and verified official faucet guidance already supported; never claim unlimited funding or create a new wallet flow.

Add a No account needed section from Task #2's configuration. Label samples Made before judging, show real public transaction/explorer references and let visitors download/check the intact and tampered examples. Separate those historical demonstrations from the judge's own live run.

Add a fresh-profile Playwright journey through rendered controls using real local application/registry behaviour. Label scripted providers/authenticators; then use the existing manual live harness for genuine device/provider/testnet evidence when available. A fresh virtual profile cannot satisfy a live-support claim. Test unsupported-device, cap-hit and unavailable-service paths with keyboard/mobile layouts.

Acceptance: a fresh supported visitor has a truthful end-to-end path and an independent no-account alternative; actual evidence classes remain visible and no approval gate is bypassed.
</execute_task>

📦 BUILD TASK #4: /api/health, /status and pnpm readiness --live
🛠️ ACTION TYPE: Extend

<execute_task>
Extend existing health/status modules and add /api/health only if absent. Keep process liveness distinct from dependency readiness. Reuse the installed Next.js runtime/caching configuration; do not hardcode settings from another framework version or prerender operational facts at build time.

Define a closed allowlisted public snapshot: build version/commit, configured public chain ID/registry address, observed RPC/network/registry readiness, measured compatible indexer lag, model-provider response/capability state, and testnet funder balance band. Include checkedAt, observation provenance/freshness and stable safe reasons. Public configuration is not an observed successful check.

Use typed responding/unavailable/unknown or equivalent existing states; keep disabled/not-configured distinct. Verify RPC chain/registry policy before reporting ready. Compute indexer lag only from compatible same-chain checkpoints with known provenance; missing/stale/ahead/inconsistent observations remain unknown rather than being clamped into a healthy zero.

Model health must not generate a paid completion, invoke tools or send case text. Use a documented non-generating provider probe only if verified available, otherwise a bounded-freshness observation from an actual prior request with its provenance. If no appropriate evidence exists, say unknown. Credentials present, an open TCP connection or a models listing cannot prove qwen3.8-max tool/schema capability. Keep reachability, verified capability, kill-switch state and quota availability distinct.

Derive the funder band from usable balance and existing reserved value/fees: sufficient, low/empty, disabled or unknown as appropriate. Do not expose the key, raw account balances, private endpoint URLs, exact usage ledger, user identifiers or unresolved signed outbox data. Funding availability also depends on policy/pending operations, not balance alone.

Keep the endpoint read-only and bounded. Reuse/coalesce safe snapshots for at most 30 seconds per configuration revision, label their timestamps, and limit a refresh to 10 seconds with strict per-dependency timeouts. Apply existing shared request limits; do not let repeated public health requests amplify paid traffic or create transactions. Inaccessible dependencies produce explicit partial/unknown results, not stale success.

Use no-store HTTP responses for the public snapshot while retaining the bounded internal observation cache. /status renders the same safe projection, with text/icons and refresh time, preserving any existing account-scoped status boundaries. Do not redirect public visitors into a private matter or reveal per-user state.

Wire the snapshot into pnpm readiness --live, preserving Chapter 14's total budget below 120 seconds. Default readiness remains offline. Live mode may perform bounded reads but cannot request passkeys, run paid inference, fund, reset or publish. Missing/stale health observations cannot pass dependent gates.

Test strict response shape, freshness, failed dependencies, wrong network, lag ambiguity, disabled provider/funder and concurrent callers. Inject distinct synthetic secrets into runtime configuration/errors and assert none appears in responses/logs. Public chain/address/build fields are intentional allowlisted outputs; do not confuse them with prohibited secret environment values.

Acceptance: the API/page report actual bounded observations without secrets or side effects, and readiness handles failures honestly without triggering model spend.
</execute_task>

📦 BUILD TASK #5: packages/agent/src/runtime/budget.ts and model kill switch
🛠️ ACTION TYPE: Extend

<execute_task>
Inspect Chapter 9's budget/admission/cancellation implementation and extend gaps only. Preserve its per-run limits: six provider attempts including routing/repair/retry, eight tool executions, 120 seconds total, 25 seconds per attempt, 2,048 completion tokens per attempt/8,192 per run, and 65,536 reserved input tokens per attempt/196,608 per run. Retain at most one transient retry and all existing output/byte limits.

Keep one active run per account, three globally, 20 admitted runs per account per UTC day and 100 globally per UTC day unless existing validated configuration is stricter. Add cumulative authenticated backend-session limits where missing: default four admitted runs, 24 provider attempts, 32 tool executions, 786,432 reserved input tokens and 32,768 completion-token budget. Keep these counters separate from the shorter signing/vault session lifetimes.

Add explicit global daily aggregate budgets where missing: default 1,966,080 reserved input tokens, 81,920 completion tokens, 600 provider attempts and 800 tool executions. The independent 100-run daily ceiling still applies. These are operational admission defaults, not observed usage or an exact invoice guarantee. Preserve stricter deployed policy; document every changed value and reject malformed/unbounded settings. Clients, model outputs and demo reset cannot raise limits.

Reserve applicable account/session/global capacity atomically in the existing PostgreSQL store before dispatch. Commit the reservation before external I/O; do not hold SQL locks during provider calls. Include prompts, schemas, tools, history and framing using Chapter 9's verified tokenizer or conservative estimate. Use checked integer arithmetic and idempotent fenced reconciliation. Reconcile actual usage when known; missing/aborted usage retains the conservative charge. Confirmed never-dispatched work may release its reservation; timeouts cannot erase possibly billed attempts.

Preserve request idempotency, owner checks, leases/fencing and replica coordination. A duplicate request consumes no second execution. Logout, a new session, process restart or UTC rollover cannot erase account/day charges or in-flight reservations. Document which bucket owns a run crossing midnight and retain unresolved accounting until safely reconciled. No browser-only or process-local quota authority.

Reuse an existing server-only kill-switch variable or add one strictly parsed runtime setting, such as LEXAEGIS_MODEL_CALLS_DISABLED. Check the effective policy before run admission and every provider dispatch. Disabling blocks new model work and cancels in-flight work through the existing state machine where possible; already sent requests can remain billable. Invalid configuration fails model readiness safely.

Document when environment changes take effect and how the existing deployment process applies the same configuration revision to every worker. An environment-file edit alone is not an instantaneous global switch. Do not expose an unauthenticated toggle endpoint or turn this setting into a NEXT_PUBLIC/client-controlled flag.

Return stable cap/disabled reasons and plain UI messages. Preserve validated partial results as incomplete; never invent a finished answer. Keep deterministic tools and read-only verification available where their actual dependencies work. Stop/cancel must not need remaining model quota; preserve its ownership/security checks and separate control-plane capacity.

Test each boundary and maximum+1, concurrent requests across workers, duplicate IDs, reconnect/new session, midnight, cancellation, unknown usage, store outage and disabled/stale policy. Missing budget storage denies new paid dispatch. Log counts/reason codes only, not prompts, case identifiers, answers or credentials.

Acceptance: every paid attempt is admitted under the applicable finite budgets; caps/kill switch prevent further dispatch, Stop remains usable and no blocked run becomes fabricated success.
</execute_task>

📦 BUILD TASK #6: apps/web/src/server/chain/testnet-funding.ts
🛠️ ACTION TYPE: Extend

<execute_task>
Inspect and preserve Chapter 6's explicit funding flow. Default policy is 0.2 MON per grant, one grant per address per rolling 24 hours, no grant when the recipient already holds at least 0.2 MON, and a maximum 10 MON of committed value plus maximum fees per UTC day. Preserve the default 0.01 MON funding-transaction fee cap and any stricter validated policy.

Resolve the recipient from requireAccountSession, never a client-provided address/amount. Verify the approved testnet, account state and actual service balance including reservations. Public page visits, account creation, health checks, retries and smoke preflight must not automatically fund an address.

Apply per-address cooldown and global reservations atomically in the existing store, alongside the service nonce lease. Keep at most one unresolved outgoing funding transaction. The address cooldown is not one-human enforcement; global value-plus-fee reservation is the hard service spending bound. Do not introduce identity claims or another account provider to manage abuse.

Retain the restricted service-signed funding outbox, exact-byte retry and reconciliation rules. Pending/unknown transfers retain their spending reservation until resolved; a crash, failed response or midnight rollover cannot create another payment or erase fees already committed. Keep this narrow service outbox exception separate from prohibited persistence of user signing secrets/signatures.

No mainnet funds, purchases, automatic replenishment, arbitrary calldata or client-selected recipient. Funding unavailable/exhausted is an honest state. Show the effective per-user policy and safe retry/cooldown message without exposing private global ledgers or the funder key. Link only the already verified official faucet guidance when appropriate; never automate it.

Keep the independent verifier and public samples available when funding is capped. A judge lacking enough test MON cannot complete a new approval transaction; do not present a pre-issued sample as that judge's new result. Stop remains available independently of funding policy.

Extend real database race/outbox tests for competing requests, cooldown boundaries, sufficient recipient balance, total value-plus-fee exhaustion, unavailable store/RPC, loss of broadcast acknowledgement and restart. Use only local testnet-like execution fixtures; tests may not spend public funds or reset deployed limits.

Acceptance: authenticated requests cannot exceed per-account/global limits or duplicate an uncertain payment; the guide/UI explain actual restrictions and retain truthful read-only alternatives.
</execute_task>

📦 BUILD TASK #7: scripts/demo-reset.ts and scoped synthetic-matter reset
🛠️ ACTION TYPE: Create

<execute_task>
Expose pnpm demo:reset using the existing local/demo environment and matter controllers. Define a strict reset target from trusted operator configuration: environment identity/origin, configured test chain/registry, designated demonstration account, owned synthetic working-matter identity and fixture version. A name containing demo, a user-supplied synthetic flag or an address argument alone is insufficient authority.

Default to the isolated local demonstration environment. A hosted demonstration target must be explicitly selected and match the approved environment/account exactly; refuse mainnet, ordinary user targets and ambiguous database/bucket namespaces. Verify authenticated account ownership and synthetic-fixture provenance before any mutation. Do not expose a public unauthenticated reset endpoint or accept arbitrary filesystem/object-store paths.

Restore the working demonstration to the original fictional source bytes and unreviewed state. Prefer a fresh account-owned working copy and a change of the demonstration's selected working matter, preserving prior immutable reviews. Use the existing encrypted-vault import/save/read-back flow; the server cannot decrypt or rewrite a user's vault by possessing database access.

For a real passkey account, guide the authorised operator through the existing browser unlock/controller flow when required. Never extract a signing/PRF/vault key or bypass a ceremony. The local harness may use its existing clearly isolated test adapter. A script that only prints instructions or opens a page has not completed reset; report success only after the resulting working state and original bytes are read back and checked.

Invalidate old unsent application action tickets and stop active assistant work through existing controls. Refuse to discard unresolved signed/broadcast operations; reconcile or retain them visibly. Reset cannot revoke an escaped signature, change a registry nonce, delete on-chain receipts, restore a terminal receipt or erase observed history.

Preserve all previously approved packages/openings, public sample assets, passkey credentials and recovery metadata. Do not delete any other account's records/ciphertext, truncate tables, clear a shared bucket or sweep by a broad prefix. Do not reset model counters, daily funding reservations, cooldowns, service nonce/outbox state or unresolved operations to make a second demonstration affordable.

Make retries scoped and idempotent through existing operation/state conventions. After an uncertain save, inspect the exact intended working copy before creating another. Use fresh production randomness for new envelopes/packages; do not reset a random seed or reuse an old approved commitment as a new approval.

Extend tests with a second account's canary records/ciphertext, non-synthetic records, prior frozen reviews and pending operations. Prove these remain intact. Reject wrong environment, wrong owner, forged fixture metadata and missing unlock. Inject interruption around save/read-back and confirm retry preserves owned data and cannot report a partial reset as success.

Run the sequence demo:reset then smoke:local twice against the explicitly linked local demonstration target. Ensure smoke uses the reset working state rather than quietly creating an unrelated passing account. Use the same designated account with fresh run IDs; retain earlier receipts and quota accounting. If session renewal is required, use the documented test account flow instead of zeroing counters.

Acceptance: both complete reset/smoke cycles pass with recorded target/run identities; the original discrepancy is restored for review; unrelated/private/approved data and public history remain untouched.
</execute_task>

📦 BUILD TASK #8: docs/DEMO-RUNBOOK.md
🛠️ ACTION TYPE: Create

<execute_task>
Create the operator runbook from the implemented /judge journey, canonical release records and v3 demonstration timing. Reuse Chapter 13's recording/hosted-smoke guidance. Keep one maintained cue/timing source for this runbook and Task #11's submission script; generate or check agreement rather than maintaining contradictory timelines.

Preflight: identify the tested source/release and correct app/verifier origins; run readiness --live and verify:deployment; inspect usable demonstration funds and funding policy; inspect measured indexer lag; confirm effective model quotas/kill switch and verified provider configuration; confirm genuine public samples; select a clean supported browser profile; and prepare the verified second device/same credential for the Mera recovery clip. Do not trigger funding, paid inference or signing merely by checking readiness.

Document reset before rehearsal, exact synthetic source versions, separate intact/tampered exports, safe explorer references and the point where the operator must handle each real passkey/disclosure/approval/Send action. Keep private authentication state and raw signatures out of recordings. Do not promise one prompt or a fixed confirmation time without measured evidence.

Use the v3 three-minute structure:
0:00–0:20: lead with Proof of Review and a brief independent-verifier view; identify any displayed receipt as made before judging.
0:20–1:20: live source-linked review, the £2,000 finding, labelled what-if if time permits, actual corrected source/human decisions, explicit approval/Send and the true transaction state.
1:20–2:10: independently verify the relevant genuine package, show changed-byte failure and actual revocation/supersession history.
2:10–2:40: show the same receipt through SDK, CLI and widget, plus the team-written second-domain example; optional agent identity only if genuinely available and enabled.
2:40–3:00: state what is proven, what is not and the evidence-backed next step.

Rehearse and measure actual durations. If a live operation cannot finish in its slot, keep it pending and use the clearly identified pre-issued example for the separate completed-verification explanation. Never imply the old example is the transaction just submitted. Edited recordings may shorten waiting only with an honest elapsed-time disclosure and preservation of all required approval steps.

Add a fallback table with exact state, allowed action and accurate narration:
- Model unavailable/capped: state live analysis is unavailable; use existing deterministic tools or a clearly labelled genuine earlier synthetic run. Do not replay it as live Qwen.
- RPC unavailable: demonstrate local file integrity if it actually passes; current chain status is unknown, even if an earlier observation was Active.
- Indexer behind: show a genuinely confirmed live registry result separately from delayed indexed history; do not invent indexed events.
- Transaction pending/uncertain: show its actual public identifier and pending/unknown state; reconcile before retrying. No automatic re-signing, new commitment or duplicate funding.
- Unsupported/expired account session: explain the limitation or renew through the normal explicit flow; offer the no-account sample path without substituting a production test signer.

List separate bounty clips: actual Mera onboarding/session expiry/recovery, same-credential vault recovery on the supported second device/profile, genuine Envio lifecycle/lag handling, real Qwen tools and article, and Alchemy transmission/current-state evidence. Verify portal support for supplementary links; clips do not replace mandatory main videos.

Include a final-check entry for 13 October 2026, before 22:00 BST, plus a check immediately before submission. This is a runbook instruction, not an already executed or scheduled automation. Retain the supplied hard deadline 14 October 2026 04:59 BST and recheck official event-specific rules through the release process.

Acceptance: the runbook can be followed against actual controls, has a measured rehearsal or explicit NOT YET evidence, and every fallback preserves truthful state and existing approval boundaries.
</execute_task>

📦 BUILD TASK #9: tests/system/judge-failure-modes.spec.ts and honesty regressions
🛠️ ACTION TYPE: Validate

<execute_task>
Extend existing Chapter 12/14 browser and controller tests with the judge path. Use the real application, state machines, vault and local registry plus narrowly scoped test-only fault transports. Do not make public services fail, spend model credits to force an outage or ship query flags that simulate success/failure in production.

Exercise the required cases: model provider unreachable; RPC unreachable; indexer behind; transaction remaining pending or with unknown submission outcome; wrong network in the account/session configuration; and expired signing session. Also exercise model kill switch/caps and exhausted funding through Tasks #5–6's existing fixtures.

For every case assert the actual visible state and absence of an unearned completion badge. Distinguish assistant completion, saved evidence, signed action, broadcast, execution confirmation, indexing and current lifecycle. An error must not erase an already confirmed historical fact, while a past success must not become a current live observation.

Check Stop and /stop remain reachable and follow the acknowledgement contract. Model/funding caps cannot block cancellation. Keep owner/authentication checks; an expired session does not grant arbitrary cancellation authority. Lock/expiry/disconnect cleanup and worker fencing must prevent later dispatch and discard stale UI updates without claiming to retract external disclosures.

Check the independent verifier in a separate anonymous context. With RPC down, local file-integrity checks must still work and chain status must remain unknown. With only model/indexer/funding unavailable, supported read-only registry verification should continue. Do not require the verifier to prove an unavailable chain state.

For pending transactions, preserve the same operation/reference and reconcile without duplicate funding, signing or broadcast. For wrong network, block new signing and never auto-switch to another registry. For expired signing authority, require normal user renewal and fresh preflight/action checks; retained authentication/vault state is not signing permission.

Record each case's test ID, exact fault, expected/observed outcome, tested revision/configuration, evidence class and sanitised screenshot path through the existing build-state schema. Capture synthetic UI only; exclude storageState, cookies, private keys, raw signatures, credentials and unsanitised HAR/traces. Do not use fabricated screenshot labels as evidence of a real network outage.

Fix concrete honesty, cancellation, race or error-display defects in existing modules and rerun the affected cases. Do not redesign the product, loosen protected validation, introduce a simulated completion path or repeat unrelated security matrices. Preserve initial failures alongside corrected-run evidence.

Acceptance: every required failure has an actual observed result and safe screenshot; controls remain usable, uncertain states remain uncertain and no later callback fabricates success.
</execute_task>

📦 BUILD TASK #10: docs/submission/JUDGING-MAP.md and BOUNTY-EVIDENCE.md
🛠️ ACTION TYPE: Create

<execute_task>
Create docs/submission/JUDGING-MAP.md and BOUNTY-EVIDENCE.md as maintained views of Chapter 13's requirements/sponsor manifests and actual build evidence. Preserve existing public submission assets; use checked links/adapters rather than a second incompatible evidence system.

Map exactly the supplied criteria and weights: Technical execution 20%; Design and craft/developer experience 20%; Originality and track insight 15%; Founder and market readiness 25%; Traction and path forward 20%. Validate that weights total 100 and retain their user-supplied source; recheck official event-specific changes before final submission without silently changing the brief.

For each criterion record the concrete claim, repository file/test/command, tested revision, evidence class, actual public URL/explorer reference where relevant and present status. Link security/invariants/deployment to execution; specification/SDK/CLI/widget/clean trials to developer experience; ownerless registry/private commitments/open format and honest limitations to track fit; adopter segments/WHY/interviews to readiness; and evidence-reviewed external counts plus roadmap to traction.

Only claim observed evidence. Internal trials and the team-written code-review example demonstrate portability, not customers or independent adoption. Run traction:summary for any traction number and retain its as-of date/record identity. An empty evidence log permits an honest zero and future validation plan; it does not justify invented interviews, quotes or integrations.

For each approved bounty include the required evidence and actual link, or NOT YET / WITHDRAWN with the reason:
- Best Mera-Powered UX on Monad: real complete Mera account flow, measured onboarding/session behaviour, expiry/re-prompt, confirmed testnet execution and storage-cleared recovery.
- Mera: One Passkey, Many Keys: separate account/vault PRF purposes, no persisted user keys and genuine same-credential recovery/decryption on the supported second device/profile.
- Best Use of Envio: deployed config/schema/handlers, actual ISSUE/REVOKE/SUPERSEDE history and measured reconciliation/lag evidence.
- Best Builds with Qwen 3.8 Max: actual qwen3.8-max bounded tool work with source-linked results and the published explanatory article.
- Best Projects using Alchemy: real Monad reads, signed-transaction transmission, confirmation/current-state observations with credentials redacted; Mera remains the user signer.

Apply a withdrawal only when supported by an explicit scope decision or the existing Gate B fallback rule. Record both Mera bounty withdrawals if that rule actually applies. Withdrawing a bounty cannot waive a required T0 dependency, ship a development signer or remove the mandatory Envio pipeline. Do not silently withdraw every incomplete claim to manufacture a passing submission.

Distinguish code present, locally tested, live verified, published and claimed/withdrawn. A screenshot of configuration, an API key, a local event fixture or an unpublished Markdown article cannot satisfy live/published evidence. Do not claim eligibility, prizes, endorsement or audit status from an integration result.

Acceptance: every included claim maps to sufficient real evidence or a visible unresolved/withdrawn status; the two documents agree with canonical manifests and preserve all five bounty decisions.
</execute_task>

📦 BUILD TASK #11: docs/submission/DEMO-SCRIPT.md and PITCH-OUTLINE.md
🛠️ ACTION TYPE: Create

<execute_task>
Create the two submission-facing outlines from Task #8's maintained cue list and actual available screens. Cross-link or update Chapter 13's submission/technical-demo.md and pitch.md so they cannot prescribe a contradictory introduction or evidence claim. Do not duplicate the recording/publication pipeline.

DEMO-SCRIPT.md must show the working product within 180 seconds, following the v3 0:00–0:20 / 0:20–1:20 / 1:20–2:10 / 2:10–2:40 / 2:40–3:00 structure. For each segment specify the actual screen, concise narration, expected observable outcome, source/evidence reference and contingency. Lead with the reusable primitive and independent verification; identify the legal workspace as its reference application.

Use real review/citation, human decisions, recoverable freeze, explicit approval/Send, transaction observation, independent verification and tamper/lifecycle behaviour. Identify every pre-issued, earlier-recorded, simulated what-if or team-written example accurately. No private reasoning transcript, fabricated telemetry, predetermined live confirmation or unlabelled prerecorded assistant run.

PITCH-OUTLINE.md must stay within 120 seconds: team/founder 15 seconds; problem 15; primitive/track fit 30; what actually works 20; intended adopters and real traction 25; post-event plan 15. Keep narration concise, with a practical target of at most 230 spoken words and a timed rehearsal. Use only supplied/verified founder facts, evidence-backed capabilities and Chapter 18's measured external counts.

When traction is zero, say what was tested internally and what validation comes next. Do not turn 8–12 planned conversations or 2–3 hoped-for design partners into completed results. Explain actual account/package binding and limitations without claiming legal advice correctness, professional credentials or independent security assurance.

Reference the required genuine recording assets or keep NOT YET. Reuse Chapter 13's real capture workflow, sanitisation, measured duration checks and authorised YouTube/Loom/Vimeo publication path. A script, local MP4 filename, slide deck or code walkthrough does not satisfy the working-product video requirement. Do not generate staged footage and label it the deployed product.

Record actual rehearsal durations and adjust wording/screens when over time without skipping required approvals or hiding uncertainty. Supplementary clips remain separate and subject to actual portal support. No optional advertisement or new presentation project.

Acceptance: scripts and runbook agree, the pitch uses only validated claims, and recordings are either genuine linked assets within the limits or explicitly unfinished.
</execute_task>

📦 BUILD TASK #12: scripts/validate-submission.ts and pnpm submission:check
🛠️ ACTION TYPE: Extend

<execute_task>
Expose pnpm submission:check by extending Chapter 13's scripts/validate-submission.ts and canonical requirements/asset manifests. Use a thin wrapper if naming requires it. Do not create an independent validator that can disagree with release readiness. The command verifies evidence and links; it cannot publish, submit a form, sign, fund, reset, invoke paid inference or change flags/claims to repair its own result.

Validate the complete required submission scope: README, licence, deployment record, judge configuration/guide, the four docs/submission documents, canonical form copy/asset manifest, accepted logo, actual product/repository/verifier links, required technical/pitch videos and all claimed bounty assets. Missing mandatory entries are failures even if someone removes their links from a document.

Scan submitted copy/documents and judge configuration for NOT YET and equivalent unfilled sentinel values. Reject dummy addresses/hashes/URLs and unresolved placeholders. Use an explicit required-artifact inventory; do not scan archival prompt instructions or internal development plans indiscriminately, and do not permit arbitrary exclusions that hide missing mandatory deliverables. Preserve internal blocker history rather than deleting it for a green report.

Require every authoritative Chapter 14 T0 feature to be present and verified with applicable passing evidence. Validate feature IDs/tiers against the maintained register, not a caller-edited status label. Missing/stale/wrong-network/insufficient-class evidence, failed checks and a cut T0 feature cannot pass. Enforce required dependency/gate predicates, including a real production-capable signer and the mandatory Envio pipeline, plus judge-path/public-sample requirements.

Require complete genuine pre-issued sample entries, intact local/package hashes and positive-demo lifecycle expectations. Recheck through the trusted read-only verifier at an identified checkpoint. Verify:deployment evidence must correspond to the configured live registry. RPC unavailable means the current check is incomplete; it cannot be treated as not found or ignored because an old report passed.

Decode the submitted logo and check its actual JPG/JPEG/PNG/WEBP signature, dimensions/validity and size <=3,000,000 bytes. Reuse the existing original brand asset; an SVG, renamed file or broken image is not accepted merely from its extension. Check the licence/README/deployment record exist and contain meaningful required information without inventing ownership/licensing decisions.

Require measured technical-video duration <=180 seconds and pitch <=120 seconds, matching the recorded media assets and real public playback links. Verify anonymous access to the correct repository, live product, independent verifier and relevant article/media/explorer pages. Keep code revision, hosted release and recorded content provenance distinct; a login wall, placeholder landing page or unrelated HTTP 200 cannot establish availability.

Check only declared approved public destinations using the existing hardened link checker, with bounded redirects, timeouts and response sizes. Reject credential-bearing/private-network URLs and redact errors. Use bounded GET when HEAD is unsupported. Dynamic/video/repository access may require actual browser inspection; if that cannot be verified, record incomplete rather than guessing. Do not crawl arbitrary package URLs or attach user credentials to third-party requests.

Limit the automated check to 120 seconds with bounded concurrency and cleanup. Unfinished link/live checks fail readiness and retain a precise reason. An optional offline mode may validate files and recorded evidence, but must not claim current submission readiness without the required fresh live/access observations. Document observation freshness and bind results to the actual candidate/relevant source/configuration.

Accept WITHDRAWN only for an eligible optional claim with its recorded scope decision/reason. It cannot replace a mandatory asset, T0 dependency or a missing core integration. Removing the literal NOT YET, replacing it with ready or changing a count cannot resolve missing evidence.

Add tests showing failure for an empty/fresh repository, missing artifact, placeholder judge entry, unresolved link, wrong release/network, stale/unsupported verified status, oversized/spoofed logo, missing/overlength video, unsupported bounty claim and hidden T0 removal. Include a complete synthetic validator fixture, clearly test-only; its pass is not a real submission pass. Preserve the real current failures when running the command.

Run submission:check now against available candidate evidence. Add the final 13 October and immediately-before-submit executions to the runbook; do not backdate, claim future execution or create an automation. Refresh the official event-specific deadline/portal requirements through Chapter 13's source-record process. Retain internal target 12 October, planned latest submission 13 October 2026 22:00 BST, and supplied hard deadline 14 October 2026 04:59 BST (03:59 UTC) unless authoritative evidence establishes a change.

Acceptance: invalid/incomplete candidates exit nonzero with actionable reasons; zero requires all applicable actual evidence and access checks. A validator pass means checked readiness at that time, never that an entry was submitted or accepted.
</execute_task>

📦 BUILD TASK #13: docs/build-state.json and final prompt-library handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected schema/type/lint/build tests, judge-route/sample tests, health/readiness checks, model/funding concurrency and cap tests, both reset/smoke cycles, failure-mode evidence checks and submission-validator tests. Reuse current matching results; rerun checks invalidated by later edits. Apply existing secret/production-exclusion guards to new routes, scripts and shipped assets.

Confirm unchanged protocol vectors, registry/ABI/EIP-712 and account/vault boundaries. Do not repeat the full Chapter 17 invariant campaign unless contract/compiler inputs changed; such protected changes require their own decision. Verify model/funding failure cannot create approval authority or disable independent local verification.

Record actual command/date/source/configuration/outcome evidence through docs/build-state.json without overwriting earlier records. Keep implementation tests, live runs, hosted accessibility, real-device support, source verification, published assets and submitted-entry confirmation separate. Pending Chapter 12/13 work remains pending even though its prompt was already authored.

Update CLAUDE.md within its 450-word cap and docs/assistant-ui-contract.md within 1,200 words with actual commands, policy defaults, effective switch semantics, judge/sample boundaries and unresolved blockers. Keep status documents, runbook, submission views and canonical manifests consistent. No audited, legally correct, guaranteed funding or completed-traction badge.

When submission:check fails, preserve the exact missing evidence/action and complete all independent chapter work. Do not remove a requirement, hide a failure, automatically withdraw a required claim or switch to a simulated product. Any later publication/submission uses Chapter 13's existing authorised process and records its own observed result.

Finish with implemented files and concise factual check/discrepancy evidence. Chapter 19 completes the authored prompt sequence only; mark software, release or submission complete solely when its own gates genuinely pass. Stop here. Do not create Chapter 20, rewrite Chapters 1–18, submit an entry or start unrelated features.

Acceptance: the chapter's actual implementation/evidence is reviewable, remaining release obligations are explicit and no prompt-completion statement substitutes for a working or submitted project.
</execute_task>
```
