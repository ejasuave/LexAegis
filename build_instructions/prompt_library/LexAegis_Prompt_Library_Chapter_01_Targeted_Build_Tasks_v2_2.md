1. Runnable Monorepo, Shared Types and Build Checks
2. Receipt Format, Canonical Hashing and Private Commitments
3. Monad Registry, Approval Signatures and Receipt Lifecycle
4. Mera Passkeys, Signing Sessions and Account Recovery
5. Encrypted Evidence Vault, Stateless Recovery and Portable Export
6. Alchemy Transactions, Testnet Funding and Live Verification
7. Envio Indexer, Review History and Derived Status
8. Document Intake, Source References and Deterministic Checks
9. Qwen 3.8 Max, Aegis Assistant Runtime and Review Tools
10. Aegis HUD, Legal Workspace and Human Approval
11. Protocol SDK, Independent Verifier and Developer Integration
12. End-to-End Recovery, Privacy and Security Validation
13. Production Deployment and Hackathon Submission Assets

## Chapter 1 — Runnable Monorepo, Shared Types and Build Checks

This chapter builds the project's basic structure: the Aegis command-centre shell, its document review view, a separate proof-checking app, shared data rules and build checks. Revision v2.2 adds the assistant interfaces, orb, command dock and a clear record of which later chapters connect each feature. If you already implemented v2.1, apply the additions in Tasks 5, 8 and 10 and rerun the relevant checks; keep existing work. Wallets, AI, voice and blockchain actions stay visibly unavailable until their chapters connect them.

```text
📦 BUILD TASK #1: Repository root and existing project instructions
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the implementation engineer for LexAegis. Execute this chapter's tasks sequentially, applying their instructions to actual repository files. Do not return a proposed implementation or JSON status report.

Inspect the working directory, git status, applicable AGENTS.md and CLAUDE.md files, package manifests and relevant existing source. Use targeted reads and rg; exclude generated output and dependency directories. Preserve unrelated work.

This is Chapter 1 revision v2.2. Reuse compatible existing code; do not delete or rebuild working modules merely to match suggested paths. If v2.1 is implemented, reconcile the additive assistant contracts, UI shell and continuity requirements in Tasks 5, 8 and 10, then run affected validation. Preserve completed later work and the Chapter 2–3 protocol, hashes, ABI and lifecycle. Apply these constraints throughout subsequent tasks:
- Build an open Proof of Review protocol with an England-and-Wales employment-settlement reference application.
- The reference application includes a case-aware Aegis assistant and a functional cinematic HUD. Its conversation, real tool progress, evidence canvas, case context, command dock and Stop/approval controls are required product features. A decorative orb alone is insufficient.
- Use Monad testnet for the live MVP, Mera for the entire user account layer, separate Mera PRF-derived encryption, Envio HyperIndex, Alchemy RPC and Qwen 3.8 Max.
- Keep protocol and SDK usable without our legal interface, model provider, account adapter or hosted backend.
- A receipt establishes approval by a signing account of a committed package; it does not establish legal correctness or professional qualification.
- Implement only the foundation in this chapter. Leave live integrations, cryptography and contracts to their assigned chapters.
- Emit implementation through file edits. Omit conversational fluff, architectural essays and full-file echoes.
</execute_task>

📦 BUILD TASK #2: package.json, pnpm-workspace.yaml and workspace directories
🛠️ ACTION TYPE: Create

<execute_task>
Create or minimally adapt a TypeScript pnpm workspace. Select compatible stable dependencies using official package metadata; pin the package manager and commit a genuine generated lockfile. Never fabricate dependency versions or lockfile contents.

Establish these modules:
- apps/web: Next.js App Router, React and Tailwind CSS; Node.js route handlers provide the backend.
- apps/verifier: independently runnable Vite/React application.
- packages/protocol: framework-neutral schemas and domain types.
- packages/sdk: framework-neutral receipt client and verification interfaces.
- packages/vault: browser-only encryption and evidence-storage interfaces.
- packages/agent: server-only review-agent interfaces.
- contracts: reserved for Foundry/Solidity in Chapter 3.
- indexer: reserved for Envio in Chapter 7.
- fixtures: synthetic test inputs only.

Use workspace package names under @lexaegis. Declare explicit package exports and dependencies. Create minimal compilable source entry points; do not implement future business functionality.

Provide root dev, dev:verifier, lint, typecheck, test and build scripts. Run the applications on distinct configurable ports. Commands must invoke real tooling; prohibit empty scripts that report success.

Install only dependencies required by this chapter. Do not add a second backend framework, alternative account provider, vector database or multi-agent framework.
</execute_task>

📦 BUILD TASK #3: TypeScript, lint, formatting and repository hygiene configuration
🛠️ ACTION TYPE: Create

<execute_task>
Create shared TypeScript configuration with strict and noUncheckedIndexedAccess enabled. Configure compatible module resolution separately for Next.js, Vite and shared packages. Do not introduce conflicting ESM/CommonJS settings.

Configure one consistent linter and formatter. Prohibit explicit any, blanket lint suppression and unexplained ts-ignore directives. Use unknown only at external boundaries and narrow it through validation.

Enforce package boundaries:
- protocol imports no application, server integration or wallet implementation.
- sdk imports no Next.js runtime, agent implementation or hosted-service singleton.
- vault exports no server credential access.
- browser modules cannot import server environment modules or agent implementations.
- applications consume declared package exports rather than private source paths.
Use lint restrictions and server-only entry points where appropriate.

Create .gitignore rules for dependencies, build output, coverage, local environment files, private keys, downloaded case documents and runtime evidence. Keep .env.example, source fixtures and lockfiles tracked.

Do not weaken validation or bypass repository safeguards to make compilation pass.
</execute_task>

📦 BUILD TASK #4: packages/protocol/src — shared schemas and domain types
🛠️ ACTION TYPE: Create

<execute_task>
Implement closed Zod schemas and inferred TypeScript types for:
- Schema version and opaque identifiers.
- EVM addresses: 0x-prefixed, exactly 20 bytes.
- Bytes32 digests: 0x-prefixed, exactly 32 bytes.
- Valid RFC 3339 timestamps.
- GBP monetary values with signed integer minor units serialized as decimal strings.
- Redaction-safe application errors with stable error code and request ID.

Reject malformed values and unexpected object properties. Do not use floating-point monetary calculations or serialize JavaScript bigint directly into JSON.

Define a reusable discriminated result:
success contains ok=true and typed data;
failure contains ok=false and a validated error.

Keep these states separate:
- Integration: unimplemented, unconfigured, configured, verified, blocked.
- Review workflow: draft, analyzing, needs_review, ready_to_approve, submitting, confirmed, failed.
- Package integrity: match, mismatch, unknown.
- Receipt lifecycle: active, revoked, superseded, not_found, unknown.
- Signer acceptance: accepted, rejected, unknown.

A configured integration is not automatically verified. Matching package bytes do not establish active on-chain status or acceptance of the signer.

Export schemas and types through the package entry point. Defer canonical encoding, commitment algorithms and final receipt payloads to Chapter 2.
</execute_task>

📦 BUILD TASK #5: Integration ports and packages/agent/src/contracts.ts
🛠️ ACTION TYPE: Create

<execute_task>
Create minimal typed ports using the shared schemas:
- AccountProvider: browser account creation/recovery, session lifecycle and explicitly requested signing.
- EvidenceVault: browser encryption/decryption, encrypted-manifest access and portable bundle operations.
- ReviewAgent: server-side analysis request, validated findings, tool activity and cancellation.
- ReceiptClient: preparation/submission interfaces and current contract-status reads.
- ReceiptIndexer: indexed lifecycle/history queries with checkpoint metadata.

Place ports in their owning modules. Use schema-derived input/output types and AbortSignal for asynchronous operations where applicable. Prevent circular dependencies.

Add browser-safe assistant data contracts at @lexaegis/agent/contracts, separately exported from the server-only runtime entry point. Reuse protocol primitives; never import server credentials or adapters into this export. Keep assistant-specific schemas out of the generic on-chain protocol package.

Define closed, versioned application contracts for an assistant request, selected matter/document/source context, a bounded plan, tool results with evidence references, a response with source references, and discriminated runtime events. Events carry runId, matterId, documentVersionId, a monotonic per-run sequence number and timestamp. Payloads must match their event type. Support plan updates, state transitions, tool start/result, response deltas, output references and terminal completion/cancellation/error.

Keep assistant run state separate from wallet, vault, review and blockchain state. A completed assistant run cannot imply human approval, a valid signature or a confirmed transaction. Define an explicit cancellation operation bound to the authenticated run owner; its unavailable adapter must not pretend to stop an unimplemented operation.

Document the allowed assistant intents: summarise, explain selected clause, check payments, list missing evidence, brief current matter, prepare review package and inspect status. Stop is handled directly by code. Free text and slash commands will share handlers in Chapter 9. No sign, approve, revoke, supersede, send-message or arbitrary-execution tool is exposed to the model.

Implement unavailable adapters that return NOT_IMPLEMENTED or NOT_CONFIGURED. Never generate fake addresses, signatures, transaction hashes, model findings or successful verification results.

Maintain these boundaries:
- Agent tools cannot approve reviews, obtain user private keys or sign transactions.
- Account-signing and evidence-encryption key purposes remain separate.
- Never persist user private keys, PRF outputs, plaintext data keys or signing sessions.
- Evidence-storage interfaces accept ciphertext and necessary public metadata; legal plaintext is not durable backend state.
- SDK verification accepts caller-supplied transport and signer policy rather than a platform-controlled trust list.
- Indexed history cannot override a live contract read. Unavailable chain state remains unknown.

Do not invent Mera SDK methods or implement cryptography inside these interface modules.
</execute_task>

📦 BUILD TASK #6: Server environment modules, public configuration and .env.example
🛠️ ACTION TYPE: Create

<execute_task>
Implement separate server and browser configuration modules with runtime validation.

Allowlist browser configuration explicitly: application/verifier origins, intended WebAuthn RP ID, chain ID and registry address when available. Do not expose the whole environment or spread server configuration into browser objects.

Define server configuration for:
- QWEN_API_KEY, QWEN_BASE_URL and QWEN_MODEL.
- ALCHEMY_MONAD_RPC_URL.
- ENVIO_GRAPHQL_URL and any required private access credential.
- DATABASE_URL.
- S3-compatible endpoint, bucket, region and access credentials.
- Future service-owned testnet funding and backend session-authentication secrets.

Set QWEN_MODEL=qwen3.8-max in .env.example. Leave secret values empty. Validate endpoint schemes, addresses and chain configuration when supplied. Never substitute a different model silently.

Permit missing future-integration credentials so both application shells can boot. Reject malformed supplied configuration without exposing its value. Do not mark unavailable services ready.

Keep account/decryption secrets exclusively in browser memory when their implementation chapters arrive. Backend API credentials and service-owned funding credentials are separate from user account custody.

Ensure Next.js public variables and Vite public variables contain only approved values. Do not expose provider keys through client bundles, error messages, health responses or private endpoint URLs.
</execute_task>

📦 BUILD TASK #7: apps/web — health, readiness and error-handling modules
🛠️ ACTION TYPE: Create

<execute_task>
Implement GET /api/health for process liveness and GET /api/readiness for capability readiness.

Return HTTP 200 from a healthy process even when later integrations are unavailable. Return HTTP 503 from readiness until required live capabilities have verified implementations.

Expose only stable capability names, safe states and machine-readable reason codes. Do not return credential values, private URLs, environment dumps or stack traces.

Implement request IDs and a consistent error mapper using the shared error schema. Return an unavailable result for unfinished operations; never convert an exception into a successful review or verification.

Disable request-body logging and response caching for sensitive API routes. Establish a logger that excludes legal text, authorization headers, cookies, credentials, signing material and decryption material.

Make readiness depend on real implementation/configuration evidence. The presence of an environment variable alone cannot establish successful integration.
</execute_task>

📦 BUILD TASK #8: apps/web/src/app and components/assistant — Aegis HUD shell
🛠️ ACTION TYPE: Create

<execute_task>
Build a working responsive application shell with:
- Application layout and navigation for Review, Vault, History and Verify.
- Command-centre and Review presentation modes sharing the selected matter/document context.
- Original AssistantOrb with a text/icon state label, using lightweight CSS/SVG.
- Matter/context rail, bounded task-step area, assistant conversation panel and expandable evidence panel.
- Review layout giving the document and findings most of the space, with the assistant docked beside them and a compact orb.
- CommandDock with a labelled text input, command menu, reserved voice affordance and directly reachable Stop control.
- Separate action-preview area for future explicit review approval.
- Activity drawer separating assistant/tool activity, human decisions and on-chain events.
- Account session and vault-lock indicators separate from transaction/indexer status.
- Integration-readiness display consuming the implemented readiness endpoint.
- Dedicated empty-state pages for unfinished workflows.

Use obsidian/navy surfaces, a cobalt/cyan orb and action accents, violet analysis, amber attention, green verified completion and red errors. Keep document text readable and the background grid faint. Reinforce every color with a label and icon. Honour prefers-reduced-motion; provide visible keyboard focus, semantic controls, accessible names and stacked/tabbed mobile layouts. Do not add Three.js, WebGL, a 3D asset pipeline or a UI framework solely for the orb.

View switches, panel controls and the activity drawer must work. Keep the current selection when switching views. Define components against the typed contracts from Task 5; this chapter consumes real unavailable/readiness states only. Do not simulate active analysis, microphone capture, model conversation or tool progress.

Render unavailable account and workflow actions as disabled controls with specific explanations. Handle loading, empty, unavailable and request-failure states.

Show the assistant as unavailable until connected in Chapter 9. Do not request microphone permission, invoke speech synthesis or connect a voice provider in this chapter. Chapter 10 supplies capability-gated on-device push-to-talk, editable transcripts and local read-aloud; text remains fully usable when voice is unavailable.

Do not add fictitious cases, risk scores, charts, activity, balances or transaction confirmations. Do not label a receipt valid or a document compliant.

Make navigation functional. Keep private configuration and server modules outside client imports. Do not implement document analysis or approval execution in this task.
</execute_task>

📦 BUILD TASK #9: apps/verifier/src — independent verifier application shell
🛠️ ACTION TYPE: Create

<execute_task>
Build an independently runnable verifier application using shared protocol types and SDK interfaces.

Render a proof-package input area and separate placeholders for:
- Package integrity.
- Receipt lifecycle.
- Signer acceptance.
- Chain and registry information.
- Block/checkpoint information when available.

Disable actual verification until the implementation in Chapter 11. Show unknown or unavailable states instead of simulated results.

Require no LexAegis account, Mera session, Qwen service or access to the legal workspace. Do not assume passkeys can be reused across unrelated origins.

Prepare the interface for an explicitly exported proof package. Do not fetch confidential evidence automatically or upload imported material to an unrelated service.

Ensure the application builds and starts separately from apps/web. Its eventual verification logic must not depend on the LexAegis backend.
</execute_task>

📦 BUILD TASK #10: CLAUDE.md, docs/assistant-ui-contract.md and docs/build-state.json
🛠️ ACTION TYPE: Create

<execute_task>
Create compact persistent project context for subsequent chapters. Preserve applicable existing repository instructions.

Keep CLAUDE.md within 450 words. Record the product objective, actual commands, module boundaries, security invariants and pointers to docs/build-state.json and docs/assistant-ui-contract.md. Instruct future sessions to read the active chapter, this compact context, relevant component requirements and relevant source files; do not load all prompt chapters on every turn.

Use docs/build-state.json as a repository data file, not a terminal response. Record chapter ownership, implementation state, integration prerequisites, evidence paths and actual check results. Initialize future requirements as pending.

Record the complete chapter sequence:
01 Runnable Monorepo, Shared Types and Build Checks
02 Receipt Format, Canonical Hashing and Private Commitments
03 Monad Registry, Approval Signatures and Receipt Lifecycle
04 Mera Passkeys, Signing Sessions and Account Recovery
05 Encrypted Evidence Vault, Stateless Recovery and Portable Export
06 Alchemy Transactions, Testnet Funding and Live Verification
07 Envio Indexer, Review History and Derived Status
08 Document Intake, Source References and Deterministic Checks
09 Qwen 3.8 Max, Aegis Assistant Runtime and Review Tools
10 Aegis HUD, Legal Workspace and Human Approval
11 Protocol SDK, Independent Verifier and Developer Integration
12 End-to-End Recovery, Privacy and Security Validation
13 Production Deployment and Hackathon Submission Assets

Preserve these requirements and ownership:
- Chapters 4, 6, 12: Mera-only accounts, supported one-prompt onboarding, measured time/taps to a real transaction, memory-only signing sessions, expiry handling and fresh-storage recovery.
- Chapters 5, 12: separate non-wallet PRF encryption namespace, reproducible public derivation metadata, discoverable encrypted manifests, same synced credential decrypting on a second device or fresh profile, versioned export/import. A new passkey is not the same credential.
- Chapters 6, 12: actual Alchemy-backed Monad reads, user-signed transaction submission, confirmation and current-status checks; bounded service-owned testnet funding without custody of user keys.
- Chapters 7, 10, 12: deployed Envio pipeline, public config.yaml/schema.graphql/handlers, useful derived receipt/history state, frontend consumption, lag visibility and replay/reorg handling.
- Chapters 9, 12, 13: verified access to the exact Qwen model, bounded multi-step tool execution, deterministic calculations, source-linked findings, tool-call audit records and a published article explaining actual use.
- Chapters 2, 3, 11, 12: canonical private commitments, signature authorization, replay protection, revocation/supersession, SDK and independent verification.
- Chapters 8, 10: evidence checklist, versioned source references, explicit human approval of an immutable review package; no automatic legal decisions.
- Chapter 13: public repository accessible to judges, live Monad deployment and access instructions, permitted logo image <=3 MB, working-product demo video <=3 minutes, team/problem pitch <=2 minutes and published Qwen article.

Create docs/assistant-ui-contract.md, at most 1,200 words, recording these mandatory component responsibilities and their acceptance conditions. This file governs the later assistant/UI implementation; it is not evidence that those features already exist.

- Chapters 5, 9, 10: encrypted matter-scoped working context containing user-confirmed facts, notes, source/version references and concise saved outcomes. Provide inspect/correct/remove/export controls. Keep raw conversation ephemeral by default; distinguish model proposals from confirmed facts. Enforce account/matter isolation. Working-context edits never mutate a frozen approved package.
- Chapter 8: stable source references, deterministic GBP calculation results and a bounded text comparison of two supplied source versions. Preserve original bytes and label extraction/diff limits. No OCR or automatic document editing.
- Chapter 9: one bounded Qwen runtime with a calm concise persona, matter/document-aware dialogue, follow-up/correction handling, relevant-context selection, typed tools, strict outputs, source references and package preparation. Free text and /summarise, /explain, /check-payments, /missing-evidence, /prepare-review and /status use the same handlers. /stop bypasses the model and invokes cancellation.
- Chapter 9: stream validated events tagged with the run and document version. Enforce per-run budgets, ownership, ordered event identity, bounded retries and cancellation before each tool dispatch. Prevent new calls after cancellation acknowledgement. Expose short factual progress summaries rather than chain-of-thought. Do not call another model to narrate every state change.
- Chapter 9: a small versioned runtime prompt set comprising common policy plus relevant task/output contracts, with pinned content hashes recorded in the existing agent-config artifact. Supply only relevant evidence and tool schemas per turn. Reuse deterministic validation instead of separate critic agents or the older project's 420-asset framework.
- Chapter 10: connect the shell's orb, command dock, conversation, task steps, evidence panel, action preview and activity drawer to real runtime data. Discard late events from cancelled/stale runs. Keep private text out of generic logs and browser persistence. Show unavailable/error states and retain safe partial work.
- Chapter 10: preserve Command-centre and Review modes. The expanded orb anchors the command centre; the compact orb leaves space for the document during review. Add source navigation, selected-clause questions, a requested matter briefing and visible saved-context controls. Keep the UI original, readable and keyboard/mobile/reduced-motion accessible.
- Chapters 8, 10: a payment-only what-if panel reusing the existing integer calculator, with explicit SIMULATED labels and hypothetical inputs. It cannot edit source bytes, resolve a real finding, alter an approval package or sign a transaction. An actual correction requires a new source version and review. No general simulation engine, digital twin or outcome predictor.
- Chapter 10: push-to-talk only where verified on-device SpeechRecognition is available; detect support and required language resources, and do not silently fall back to remote recognition. Capture only after a user gesture, show a microphone indicator, discard audio and place results in an editable draft requiring Send. Read-aloud is opt-in with a verified local SpeechSynthesis voice. Stop cancels capture/playback. Unsupported features have truthful text fallback. No wake word, background listening, external voice integration or actor imitation.
- Chapters 4, 6, 10: signing-session permission and conversational intent cannot approve a package. A dedicated human action reviews the exact frozen package and creates the bounded EIP-712 instruction. Changed inputs invalidate the preview. Receipt revocation/supersession use their own explicit action previews. Model tools never control signing.
- Chapters 7, 10: combine the UI's views of assistant activity, human decisions and Envio history while preserving their different meanings. Display actual confirmation and indexer checkpoints; never label an indexer result as a successful live verification.
- Chapter 12: verify a natural-language request through real tools to cited output; follow-up/correction handling; cancellation and stale events; cross-matter isolation; context recovery; exact approval binding; simulation isolation; voice support/fallback; keyboard/mobile/reduced-motion operation; and injection/error handling. An already broadcast transaction cannot be cancelled by Stop; display its real status.
- Chapter 13: demonstrate the assistant request, task progress, cited issue, explicit human approval, real transaction and independent verifier within the existing demo limit. Demonstrate only supported live voice; do not claim unsupported devices work.

Record these adaptations as derived design requirements from the attached Aegis/Aegis references. Do not import their Python/FastAPI/Tauri/Claude runtime, global personal memory, desktop/browser automation, communications, smart-home services, multi-model router, full simulation system or development-only release gate into LexAegis. The referenced images and UI source were not supplied; do not claim a pixel-exact recreation or existing UI implementation.

Record the nominal 14-day effort budget, hard deadline 2026-10-14T04:59:00+01:00 and internal submission target 2026-10-12. The hard deadline takes precedence.

Exclude CRE, Kimi, extra wallet stacks, payments/trading, OCR and speculative features from this MVP. Keep PostgreSQL for minimal operational metadata and S3-compatible storage for ciphertext as the planned persistence interfaces.

Record that encrypted storage does not hide deliberately submitted analysis text from the backend/model provider. Approval requires an explicit human action; prompt-free signing does not grant autonomous approval.

Distinguish internal example applications from independent developer adoption. Never claim a bounty requirement, recovery demonstration or deployment is complete without evidence.
</execute_task>

📦 BUILD TASK #11: Foundation tests and .github/workflows/ci.yml
🛠️ ACTION TYPE: Create

<execute_task>
Implement focused Vitest tests for:
- Rejection of malformed addresses, digests, timestamps and monetary values.
- Exact minor-unit handling without floating-point arithmetic.
- Exclusion of server secrets from public configuration and API responses.
- Rejection of malformed supplied configuration.
- Missing sponsor credentials permitting shell startup while readiness remains unavailable.
- Unimplemented adapters returning typed failure rather than successful results.
- Separation of package integrity, receipt lifecycle and signer acceptance.
- Browser-safe assistant contracts rejecting malformed/unknown event fields and preventing a run-completed event from asserting a receipt confirmation.

Use synthetic values only. Do not contact paid providers or live wallets from unit tests.

Add a CI workflow that installs from the frozen lockfile and executes actual lint, typecheck, test and production-build commands. Ensure failing checks fail CI.

Keep package-boundary restrictions active in CI. Do not add empty contract/indexer test commands or use pass-with-no-tests to imply future features are verified.

Do not test static headings merely to increase test count. Reserve real contract, cryptographic, passkey and integrated browser validation for the chapters implementing those capabilities.
</execute_task>

📦 BUILD TASK #12: Workspace validation and chapter completion
🛠️ ACTION TYPE: Validate

<execute_task>
Run the implemented lint, typecheck, unit-test and production-build commands. Repair failures within Chapter 1 scope and rerun affected checks.

Start both application shells without sponsor credentials. Check HTTP responses for their entry pages, working navigation, health and readiness. Confirm:
- Both applications start independently.
- Liveness returns HTTP 200.
- Readiness returns HTTP 503 with truthful unavailable states.
- No placeholder operation reports a valid proof, successful transaction or completed analysis.
- Private server configuration is absent from public responses and browser exports.
- Shared package imports satisfy the configured boundaries.
- Command-centre/Review view switching, panel controls and mobile navigation work with truthful empty states; assistant, voice and transaction execution remain unavailable.
- Reduced-motion mode preserves all visible status labels and controls without requiring animation.

Inspect the final diff for accidental secret inclusion, unrelated changes and disabled validation. Stop only processes started by this task.

Update docs/build-state.json with observed commands, results and unresolved prerequisites. Mark checks not executed as unverified or blocked; never invent passes. Missing credentials for future chapters do not block a correctly implemented foundation.

If a genuine environment blocker prevents a check, preserve completed work and record its precise cause. Do not weaken the check or replace it with an unconditional success.

Mark Chapter 1 complete only when its implemented acceptance checks pass. Initialise unimplemented later chapters as pending; preserve accurate existing completion records for work already done. Stop after this task; do not deploy, fund accounts or implement a subsequent chapter.
</execute_task>
```
