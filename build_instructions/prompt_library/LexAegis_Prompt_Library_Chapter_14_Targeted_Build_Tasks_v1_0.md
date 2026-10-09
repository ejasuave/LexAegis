## Chapter 14 — Scope Gates, Feature Flags and Golden-Path Smoke Test

This chapter protects the main demonstration while you finish the build. It records what is essential, switches optional features off cleanly, and checks the whole journey from uploading a document to independently verifying its receipt. It also adds one readiness command that shows what genuinely works and what is still missing. Automated tests, real-device checks and live blockchain evidence stay separate; a development test signer never becomes a shortcut in the public application.

```text
📦 BUILD TASK #1: CLAUDE.md and the Chapter 14 amendment contract
🛠️ ACTION TYPE: Extend

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#11 sequentially through repository edits and checks. Write complete code/configuration and compact evidence to named files. Omit conversational filler, playbooks, full-file echoes, reasoning traces and standalone terminal JSON status payloads. Show only requested test tables and concise blockers; never suppress failures to save tokens.

Inspect applicable repository instructions, CLAUDE.md, docs/assistant-ui-contract.md, docs/build-state.json, the supplied LexAegis Refined Project Brief v3.md and LexAegis Prompt Chapters 14-19.md. Inspect actual implementations and existing test/release tooling before editing. Use rg and bounded reads; do not reload the entire prompt library or dependency tree. Preserve unrelated changes. Do not spawn agents.

Add a compact Chapters 14–19 rules section to CLAUDE.md. V3 authorises additive work beyond Chapter 13, moves voice/comparison/briefing to stretch, and establishes an eight-fixture minimum with twelve as stretch. Do not rewrite earlier prompt files or reinterpret their authorship as implementation progress. Call the reusable primitive Proof of Review and the application LexAegis without renaming identifiers or packages.

Preserve the manifest, opening and receipt-reference schemas; digest/commitment construction and existing vectors; EIP-712 domain/types; registry source, ABI and deployed bytecode; account derivation, vault formats and approval boundaries. Record SHA-256 baselines for existing protected source/vector files and available compiled artifacts before changes. If a required correction crosses these boundaries, stop that task and record the exact conflict. Never regenerate expected vectors to hide a regression.

Map the paths named below onto existing modules and commands; extend equivalents instead of creating parallel systems. Missing application dependencies block their integration tasks, not independent scope/configuration work. The explicitly permitted early smoke harness may list pending steps; it may not stub production features or manufacture success.

Scope: supplied Tasks 14.1–14.5 only. Mapping: #2–3 = 14.1 [Must]; #4–5 = 14.2 [Must]; #6–8 = 14.3 [Must]; #9 = 14.4 [Should]; #10 = 14.5 [Should]; #1/#11 establish and verify shared boundaries. No implementation of Chapters 15–19, provider substitution, external deployment, publication, outreach or mainnet operation. External smoke execution is manual and separately guarded in Task #8.

Acceptance: source-to-target task/path mapping and protected baselines recorded; existing continuity instructions preserved; every missing prerequisite has an owning chapter.
</execute_task>

📦 BUILD TASK #2: docs/scope-tiers.md and the build-state schema
🛠️ ACTION TYPE: Extend

<execute_task>
Inspect the existing build-state schema, validator and evidence model. Implement supplied Task 14.1 by extending them, not replacing them. Add a tiers section and generate docs/scope-tiers.md from the same authoritative register or test their exact agreement.

Register these tiers with explicit feature IDs and owning chapters:
T0: document import; consent; live Qwen-assisted source-linked findings; human decision; immutable freeze and verified save; explicit real-signature approval; confirmed Monad testnet receipt; independent verification; tamper detection; supersession/revocation; deployed registry; SDK verification.
T1: Mera recovery and encrypted vault; payment what-if; compact labelled orb; pinned runtime prompts; CLI; embeddable widget; second-domain example; specification/test vectors; quickstart; judge path.
T2: Envio history/derived status; matter notes; availability-gated agent identity; invariant tests; threat model; verified deployment; eight evaluation fixtures.
T3: voice; document comparison; matter briefing; reputation feedback; four additional evaluation fixtures, bringing the total to twelve; additional visual polish.

Each feature has id, tier, chapter, status and evidence. Status is exactly not-started|in-progress|verified|cut. Use an empty evidence array until verified. Reference actual checked paths/commands/URLs, not future filenames as proof. Map missing/failed prerequisites into separate reason/check records without adding undocumented feature statuses. Authored prompts alone remain not-started. Existing code without a passing applicable check is not verified.

Extend the existing closed result schema with source revision, dirty-worktree indicator/content fingerprint, checkedAt, command, environment, evidence class, outcome, reason codes and safe evidence references. Preserve existing result enums where possible. Keep local scripted, virtual-authenticator, real-device and live-testnet evidence distinguishable. Preserve historical results but invalidate current verification when its relevant source/configuration changes.

Tier priority does not remove dependencies: freeze still requires recoverable encrypted storage; approval still requires its real signer; Envio's pipeline remains required despite its T2 label. Disabling notes must not delete encrypted data or alter historical approved packages. A disabled default is not automatically a recorded scope cut.

Acceptance: state parses and passes its existing extended validator; unknown IDs/statuses and unsupported verified claims fail validation; prior state survives the additive migration; documentation and register agree.
</execute_task>

📦 BUILD TASK #3: Gate A–D evidence predicates and cut-ladder policy
🛠️ ACTION TYPE: Create

<execute_task>
Inspect existing release requirements and evidence evaluators. Add pure, unit-testable gate predicates and a gates section in docs/build-state.json. Keep recorded evidence separate from computed gate results: pass|fail|unknown. Missing, stale, wrong-network or insufficient-class evidence cannot pass. Actual failed checks remain failures, not unknown.

Use these Europe/London targets, recording explicit offsets:
A: 2026-10-06, operational cutoff 2026-10-06T23:59:59+01:00. Chapters 1–3 build/tests pass; the existing registry is deployed on Monad testnet; actual chain ID, address, deployment transaction and source commit are recorded. Require an observed successful deployment receipt and matching deployment identity, not a populated address string. Reuse authorised deployment evidence; do not deploy from this chapter.
B: 2026-10-08T23:59:59+01:00. A real Mera account signs the exact action; a registry transaction confirms through Alchemy; the verifier reads the resulting state. Require real-device/live evidence linked to the same action, registry and network. Local or virtual signatures cannot satisfy this gate.
C: 2026-10-10T23:59:59+01:00. A genuine Qwen run invokes bounded tools and produces valid source-linked findings; the complete T0 browser journey succeeds. Require live provider provenance and independently checked transaction/verification evidence, not a replayed conversation.
D: 2026-10-11T23:59:59+01:00. Feature freeze recorded; verifier, SDK, CLI, judge path and anonymously accessible public repository have applicable passing evidence. Missing later-chapter deliverables remain NOT YET, never dummy links.

Keep the internal submission target 2026-10-12, latest planned submission 2026-10-13T22:00:00+01:00 and supplied hard deadline 2026-10-14T04:59:00+01:00 distinct. Never move targets forward automatically or backdate results. Record dependencies that cross chapter numbering instead of assuming a numbered chapter proves a gate.

Encode this ordered cut ladder: voice; documentComparison; matterBriefing; reputationFeedback; nonessential orb animation; History UI polish; fixture target twelve to eight; agentIdentity; matterNotes. Record each applied cut, reason, date and affected checks. Do not delete tests to reduce the required fixture target. Preserve a static labelled orb and meaningful history; never cut the Envio pipeline.

Never-cut controls: real signature, real Monad transaction, independent verifier including tamper failure, honest status labels, Stop and explicit approval. Do not cut consent, encryption, save/read-back, limits, authorisation checks or any other dependency protecting them.

If Gate B is actually failed or unproven at its cutoff, record that evidence and the brief's withdrawal of both Mera bounty claims. A development-only signer may support labelled development work, but cannot pass Gate B or enter production. Dropping bounties does not manufacture a deployable signer or complete hosted T0. Record that release blocker explicitly; do not add another wallet stack or relax the gate.

Acceptance: tests cover missing/stale records, invalid provenance, dangling evidence references, wrong chain, failed checks, deadline boundaries, immutable history and non-waivable controls; local simulation cannot pass live gates.
</execute_task>

📦 BUILD TASK #4: apps/web server-owned typed feature flags
🛠️ ACTION TYPE: Create

<execute_task>
Inspect the existing environment parser, server/client boundary and capability projection. Implement supplied Task 14.2 in one typed feature-flag module using the existing schema library. Reuse variable names and configuration mechanisms where present; do not add a flag service or new framework.

Define exactly these product flags: voice, documentComparison, matterBriefing, reputationFeedback, agentIdentity, matterNotes. The first four default false. The last two default true only when their implementation exists and applicable verification evidence matches the current feature implementation/configuration; otherwise false. An explicit false always disables. An explicit true cannot bypass missing implementation or verification. Invalid values fail configuration validation; never coerce the string "false" to true.

Read configuration on the server at application startup. Pass only the validated effective booleans to clients through the existing configuration boundary. Do not expose raw environment variables, credentials, evidence records or a runtime switch endpoint. Do not let query strings, localStorage, cookies, client payloads or model outputs enable features.

Respect installed Next.js runtime semantics. Consult https://nextjs.org/docs/app/guides/self-hosting when needed; do not turn server-controlled runtime switches into NEXT_PUBLIC build-time variables. Document the restart/reload needed to apply a changed configuration and test that all instances use the intended configuration revision.

Keep product flags separate from device/network availability. An enabled voice feature still needs independently verified local speech support. A later implemented agent-identity feature can honestly report network unavailability; setting its flag is not proof of registration.

No product flag may select a test signer, provider replay, deterministic production randomness, altered chain, relaxed validation, unsigned approval or other security bypass. Keep Mera, Qwen, Alchemy, vault and registry policies unchanged.

Acceptance: unit tests cover defaults, strict parsing, invalid names/values, implemented-versus-verified distinction, explicit disable, client tampering and secret-free projection. With optional features disabled, production modules compile without future chapter imports.
</execute_task>

📦 BUILD TASK #5: Aegis navigation, command dispatch and status projections
🛠️ ACTION TYPE: Extend

<execute_task>
Inspect existing HUD components, command registry, /status handler, status route, optional endpoints and agent tool exposure. Apply the effective flags consistently; reuse the current routes instead of introducing Chapter 19 health endpoints early.

Disabled features have no navigation item, command-menu entry, button, keyboard shortcut, empty panel, dead link or promotional coming-soon text. /status and the status route list only enabled optional capabilities while retaining required account, vault, chain and indexer states. Never report a disabled capability as ready.

Enforce the same decision server-side for direct requests and applicable structured assistant intents. Filter optional workflow/tool exposure without removing core summarisation, clause explanation or payment checks. A stale client must not execute an optional operation that the server has disabled. Reuse stable existing error conventions; no secret configuration or raw exception in responses.

Keep Stop, consent, explicit approval/action preview, fee confirmation, source citations, the payment what-if isolation label and independent verification accessible. Voice off means no microphone acquisition, audio playback initialisation or remote speech fallback. Notes off means no automatic loading/transmission of saved notes into model context; preserve stored ciphertext and frozen-package verification/export.

On a configuration-change reload, preserve existing lock/cancellation semantics and reject late results. Never treat a UI preference as authority to revoke an already broadcast transaction or erase an approved package.

Test rendered visible/accessibility surfaces and server dispatch with all optional flags off. Assert disabled feature labels and raw flag dumps are absent from product controls. Do not redact matching words from user documents, erase required privacy notices, or mistake non-visible hydration data for a menu entry.

Acceptance: affected typecheck, unit/component tests and route tests pass; forged/direct disabled actions are rejected; core commands and Stop still work. If Chapter 10 is absent, record integration as pending rather than creating a mock HUD.
</execute_task>

📦 BUILD TASK #6: tests/test-support adapters and production-exclusion checks
🛠️ ACTION TYPE: Create

<execute_task>
Inspect existing Chapter 9 scripted providers, Chapter 12 tests/system adapters, signer interfaces and Chapter 13 bundle guards. Extend them for supplied Task 14.3; do not create alternate production authentication or cryptography.

First probe the pinned Chromium/CDP virtual authenticator through an actual credential creation/assertion with the required PRF extension. Inspect the installed protocol and https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/; use supported hasPrf options only when accepted. Prove stable same-input PRF evaluation and purpose separation using the existing application path. A successful addVirtualAuthenticator call alone is insufficient.

If required PRF behaviour is unavailable, use a clearly named test-only signer adapter under the existing test-support directory implementing the actual signer interface. Use isolated ephemeral local-chain credentials. Where vault tests require a synthetic PRF source, inject it solely at the test credential boundary and still run the real key derivation, encryption, storage and read-back code. Never bypass authentication middleware, vault integrity or approval controllers. If an interface is not implemented yet, mark its dependent step pending; do not invent the missing production interface.

Record authenticator mode and "passkey step requires real-device evidence". Even a working virtual authenticator does not establish real-device or synced-credential recovery support.

Use existing synthetic scripted Qwen fixtures or genuinely recorded synthetic responses only through test composition. Record origin, configured model identifier, creation/recording date, request/prompt/schema fingerprint and fixture digest. Never label hand-authored data as a real provider recording. Schema validation and deterministic tools still execute normally. Missing or mismatched fixtures fail; no live-provider fallback from local CI.

Separate test composition from deployable entry points. Require explicit test invocation, isolated loopback services and an observed local chain identity; reject nonlocal redirects/RPCs and production credentials. The default local test path cannot reach Monad, Qwen or a funded external account.

Extend production import-graph and artifact scans to cover web client/server outputs, verifier, containers and distributable packages. Fail on test adapter/replay imports, marker strings, test-only fixture paths, test-private-key identifiers/literals and test artifacts. A dormant runtime branch is not sufficient isolation. Required production demo documents are not test-provider/authentication fixtures; classify them explicitly instead of banning every file named fixture.

Add negative controls in an isolated temporary copy/worktree: deliberately import the test signer and replay provider into production entries, and inject a test artifact into a distributable. Each guard must fail; the clean candidate must pass. Do not switch/reset the user's branch, publish the negative control or log key values.

Acceptance: recorded PRF probe result, truthful adapter classification and passing negative/positive exclusion checks; production cannot activate test paths through any flag or request.
</execute_task>

📦 BUILD TASK #7: pnpm smoke:local and the visible golden-path journey
🛠️ ACTION TYPE: Create

<execute_task>
Inspect and extend tests/system/full-review-journey.spec.ts or its actual equivalent. Add pnpm smoke:local as a thin wrapper, sharing existing system-case schemas and setup. Do not create a second end-to-end framework.

Build a complete ordered step manifest now, including owning chapter, prerequisites, required UI assertion and evidence class. If a feature is absent, report pending with its dependency; never silently skip or fill in success. Before Gate C, an incomplete run remains explicitly incomplete. From entry into Gate C or its target cutoff, whichever occurs first, any pending T0 step fails the run. Do not let a CLI flag or edited tier label waive this rule.

Use isolated loopback Anvil, the unchanged registry deployment script, existing local PostgreSQL/ciphertext storage and independently served apps/verifier. Never fork a public chain. Verify actual endpoint/chain identity; domain-bind signatures to that local deployment without modifying protocol v1. Record resources owned by this run and clean up only those exact resources. The account/nonce sequence is serial.

Drive rendered controls through these assertions:
1. Access the synthetic account, unlock its vault and import/select the original fictional agreement; retain its exact bytes/version.
2. Inspect the disclosure and explicitly send the selected text; assert no provider submission before consent.
3. Submit the assistant request, observe real controller/tool events, open the citation at the correct page/clause, and verify 2400000 - (1000000 + 1200000) = 200000 GBP minor units. JSON amounts remain decimal strings.
4. Confirm required facts and record human dispositions. For the initial discrepant package, use only a permitted acceptance-with-reason of the unresolved discrepancy; never label it corrected. A technical integrity/storage failure cannot be waived.
5. Freeze exact contents, encrypt/save and read back. Approval remains unavailable until the existing capture-readiness controller succeeds.
6. Review the exact action, explicitly approve, separately confirm the fee/Send action, observe submission and actual local confirmation, and check the receipt with the SDK.
7. Export through the existing disclosure flow. In a separate verifier origin/context without a LexAegis session, import the exact package and trusted expected reference; observe file match and Active registry state separately.
8. Change one artifact byte while retaining a well-formed container and unchanged opening/reference. Observe integrity failure, not merely a parser error. Preserve the original export.
9. Import an actual corrected source version with a £14,000 second instalment. Re-run review, record fresh decisions, freeze/save/read back a new package, and explicitly approve/send supersession. Observe old Superseded and replacement Active from the registry and verifier; preserve the old record. Add revocation coverage by reusing existing tests where present.

Use accessible selectors and bounded condition polling, not long sleeps or assertions of exact model prose. Never call private approval/signing methods from page.evaluate, pre-seed an approval ticket, or use direct API writes to replace visible human-review gates. If the application does not permit accepting the initial finding, use a genuinely reviewed clean precursor package and record the supported branch; never weaken its review rules.

Keep saved, signed, broadcast, confirmed, indexed and currently Active distinct. Add a Stop/cancellation check proving no new tool dispatch after acknowledgement and no late result replaces the current matter/version.

Output a compact step table and sanitised result artifact; update build-state once through the validated evidence writer. Exit 0 only for the complete local path; nonzero for failure/incompleteness. Clearly label replay/virtual/test-signer components. Local success cannot pass live Gates B/C.

Acceptance: the complete path passes twice in isolated clean-checkout test namespaces once prerequisites exist; all earlier pending steps remain visible until genuinely implemented.
</execute_task>

📦 BUILD TASK #8: pnpm smoke:testnet manual live harness
🛠️ ACTION TYPE: Create

<execute_task>
Inspect Chapter 12 live-human evidence tooling and Chapter 13 hosted-smoke.ts. Reuse their journey and safety controls for pnpm smoke:testnet; do not add a new deployment or hidden live-test mode.

Default to a read-only preflight and display the planned synthetic actions. The live journey requires an explicit operator start, the approved application/verifier origins, configured registry, actual Monad testnet chain 10143 and a deliberately selected synthetic demonstration account. Refuse CI execution, mainnet, unknown targets, replay providers, virtual authenticators and test signers.

Run the same visible journey as smoke:local through genuine Mera, live Qwen and Alchemy. Use a headed browser under the operator's control; pause for real passkey ceremonies, disclosure, human review, exact approval and Send/fee confirmation. Do not automate a real person's consent or approve from the assistant conversation. Use existing provider/transaction/funding budgets; never buy funds, bypass a cap or broadcast to discover whether configuration works.

Observe transactions rather than inventing receipts. Preserve pending/unknown on timeout, keep their identifiers, and reconcile before any retry. A rerun must not duplicate approval, funding or submission. Use fresh synthetic matter/run identifiers; never reset shared application data or attempt to erase public history.

Record observed application revision, browser/device classification, model identifier, run time, public chain/registry/receipt references, confirmations and sanitised evidence paths. Never persist passkey material, signing-session secrets, auth cookies/storageState, raw signatures, provider credentials or sensitive browser traces. A fresh browser context is not evidence of synced-credential recovery; link separate Chapter 12 evidence for that claim.

Print the factual step table and write the dated validated result into build-state. Reach only as far as genuine prerequisites permit; unavailable access is blocked/unknown, not a successful simulation. Do not execute this live journey merely because Claude Code is implementing the harness.

Acceptance: preflight/guard tests reject CI, wrong network, missing configuration and simulated dependencies; a manual run can resume without repeating writes and records exactly the live steps actually completed.
</execute_task>

📦 BUILD TASK #9: scripts/readiness.ts and docs/readiness-report.md
🛠️ ACTION TYPE: Create

<execute_task>
Inspect existing validation/release evaluators. Implement supplied Task 14.4 as pnpm readiness, using the gate predicates and the existing schema/evidence writer. Do not derive readiness from task filenames, checkboxes or whether an environment variable is nonempty.

Without --live, make no network calls. Use installed, pinned tooling and existing dependencies; do not install packages, download a compiler/browser, fetch fonts, run telemetry, probe URLs or contact providers. Run typecheck, unit tests, forge test, the existing secret scan and production build/exclusion checks. Configure offline test/build behaviour; missing offline prerequisites become unknown with a precise reason.

Use bounded parallel child processes and a total wall-clock budget below 120 seconds, including cleanup. Kill only this runner's timed-out process trees. Timed-out or unexecuted checks are unknown, never pass. Do not drop checks or reuse evidence from another source/configuration merely to satisfy the time budget. Record actual timing and tool versions.

Evaluate recorded external evidence offline with its timestamp and environment. Label a previously observed chain result as historical, not a current live read. A live property without current evidence is unknown; stale configuration or source evidence cannot pass its dependent gate.

With --live, additionally perform bounded read-only probes of the configured deployed registry, existing application health route and indexer checkpoint/lag. Validate chain/registry identity, compare compatible checkpoints and return unknown for unavailable or unmeasurable lag. Do not create Chapter 19 routes now, invoke paid model generation, request passkeys, sign, fund, reset or publish. A missing future health field remains unknown. Redact credential-bearing RPC URLs, headers and exception bodies before output.

Print a deterministic compact table: gate, target, pass|fail|unknown, missing evidence/reason, observation time. Write the same versioned result to docs/readiness-report.md and build-state using atomic per-file writes; detect mismatched result IDs after interruption. For NOT YET items, keep the literal marker in the report. No narrative success claim or standalone terminal JSON payload.

Exit nonzero for invalid state, failed checks or any required/due gate that is not pass. Support --require A|B|C|D to enforce an earlier target explicitly, including its prerequisite gates. Future unknown gates are still displayed; exit 0 before their deadlines is not a claim of submission readiness.

Acceptance: tests cover offline network denial, deadline boundaries, missing/expired evidence, wrong chain/registry, missing health/indexer support, timeout cleanup and secret redaction. The measured offline command completes within the budget without falsely marking incomplete checks as passed.
</execute_task>

📦 BUILD TASK #10: Cut-ladder regression matrix and cutLadderChecks
🛠️ ACTION TYPE: Validate

<execute_task>
Inspect current optional-feature implementations, flag tests and existing visual/reduced-motion settings. Implement supplied Task 14.5 by running the actual application through progressively reduced configurations.

Test at least: the verified available-feature baseline; all four T3 product flags false; all six product flags false; each ordered cut-ladder step; and agentIdentity=false plus matterNotes=false. Enable a baseline feature only if implemented and verified. Unimplemented optional features are not counted as working features successfully cut.

Represent non-flag cuts through existing local presentation/evaluation configuration: static labelled orb, simpler History layout and an eight-fixture required set. Do not invent product switches for core services, remove existing tests, or hide failed cases by reclassifying them as stretch. Keep eight meaningful fixtures spanning clean controls, discrepancies, missing fields and conflicting terms.

For each distinct effective configuration run typecheck, unit/component tests, smoke:local, production build and exclusion guard. Reuse a result only for identical source/configuration fingerprints, while recording which ladder entries it covers. Use Playwright at existing desktop/mobile viewports to verify working routes, no empty panes/dead controls, keyboard access, static/reduced-motion status, preserved selected source and separate truthful receipt states.

Explicitly test Stop and approval boundaries with all flags off; crafted disabled-feature requests; no microphone activation; no hidden matter-note context submission; preserved encrypted evidence and existing proof verification/export. Keep real history indexing independent from optional History polish.

Write sanitised results under cutLadderChecks with configuration, commands, revision, timing, outcome and evidence paths. Distinguish validation of a candidate configuration from actually applying a project scope cut. Do not mutate the deployed configuration during tests.

Fix flag wiring, route filtering or presentation-gating defects only. If tests expose missing core work or protocol/security defects, record the owning task and block the affected result; do not weaken feature code or edit a protected contract.

Acceptance: each tested, fully implemented configuration retains the working T0 journey and passes its checks. Pending core dependencies prevent cut-ladder completion rather than producing a partial green result.
</execute_task>

📦 BUILD TASK #11: Chapter 14 regression evidence and continuity handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Inspect the completed diff and recorded outcomes. Run the build-state validator, affected static/unit/component tests, production-exclusion negative controls, available local smoke matrix and readiness command. Do not claim the manual testnet journey ran unless the operator actually completed it.

Compare protected source/vector baselines, ABI and available compiled registry artifacts against Task #1. Preserve compiler/settings when comparing bytecode. Missing toolchain artifacts are unverified, not evidence of equality. No original protocol vector, EIP-712 type, registry source or namespace may change to make this chapter pass.

Check command wiring, valid JSON, real evidence references, safe logs and production packaging. Keep observed failures, prerequisites and operator actions visible. Preserve authored, implemented, locally tested, real-device verified, deployed and submitted as separate facts.

Update CLAUDE.md, docs/assistant-ui-contract.md and docs/build-state.json only with this additive scope/flag/smoke contract and verified outcomes. Keep persistent context compact. Include the mapping to supplied Tasks 14.1–14.5, commands, actual module paths, current gates and unresolved dependencies. No confidential documents, raw auth state or secrets in continuity files.

Early implementation: complete scope/flags and the smoke step registry, then leave unavailable integration checks pending with owning chapters. Mature implementation: require the full local journey and cut-ladder checks. Never mark Chapter 14 fully verified merely because its early harness compiles.

Retain the v3 run order: Chapters 1–3 and Gate A; early Chapter 14 scope/flags/harness; Chapters 4–6 and Gate B; Chapters 8–9, 7, 10–11; remaining Chapter 14 integration checks; Chapters 15–18 with Chapter 16 availability gating; Chapter 12; Chapter 19; Chapter 13 release. Record the dated gates independently of that order.

Finish with actual repository edits and factual check evidence. Emit only requested tables or concise blockers. Stop after Chapter 14; do not implement Chapter 15 or release a development signer.
</execute_task>
```
