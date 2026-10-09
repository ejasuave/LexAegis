## Chapter 10 — Aegis HUD, Legal Workspace and Human Approval

This chapter completes the interface you will use: the glowing Aegis command centre, document review screen, source-linked findings, saved matter notes and approval panels. It connects the earlier components into one working journey, from opening a matter to approving an exact review package and checking its receipt. It also adds voice input and read-aloud where the browser supports local processing, while keeping every task usable through text.

```text
📦 BUILD TASK #1: apps/web integration dependencies and Chapter 10 boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#17 sequentially through repository edits. Throughout this chapter, output clean code files, closed schemas, deterministic fixtures and compact factual build records. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Preserve unrelated changes.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and the relevant Chapter 4–9 controllers. Reuse the current Next.js/React/Tailwind application, existing Aegis components, browser-safe agent contracts, source viewer, vault, account, transaction and history adapters. Read only files needed for each task.

Complete the approved Command-centre and Review experiences, human decision records, immutable package preview, two-stage authorisation, receipt lifecycle controls and capability-gated local voice. Keep the employment-settlement England/Wales profile and existing protocol schemas unchanged.

Use current installed APIs and primary references:
https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally
https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static
https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/install_static
https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService

Extend existing components instead of creating another dashboard or application state store. Do not rebuild cryptography, the Qwen runtime, contract logic or the independent verifier. Exclude marketing pages, team collaboration, billing, autonomous actions, remote speech services, WebGL and speculative features. Missing integrations remain visibly unavailable; fixtures never masquerade as live operation.
</execute_task>

📦 BUILD TASK #2: apps/web/src/features/workspace state and readiness selectors
🛠️ ACTION TYPE: Extend

<execute_task>
Create one typed workspace view model over existing controller state. Keep selected account, matter, document/version, source selection, active run/snapshot, presentation mode and open panel coherent. Reuse existing state ownership; selectors must not become a second authority.

Keep account/signing session, backend authentication, vault access, assistant activity, review completeness, capture recoverability, transaction outcome, live receipt lifecycle and indexed history as separate dimensions. Derive labels and enabled actions from validated observations. Never compress these into one approved/ready boolean.

Define a pure readiness selector returning typed blockers, outstanding human decisions and available next actions. Integrity failures block approval; substantive findings retain their underlying result and require the applicable human disposition. Neither a green assistant state nor an indexer event grants signing authority.

Represent review stages as working draft, decisions recorded, capture saving, capture verified, action preview, action signed, transaction preview and observed submission outcome. Treat these as views of controller state, not caller-supplied authority tokens.

Bind asynchronous updates to account/vault generation, matter, exact document version, snapshot and operation/run identity. On relevant changes, invalidate affected previews, cancel stale work and reject late updates. Preserve immutable frozen records.

Keep private selection/content in memory or the encrypted vault. Only non-sensitive presentation preferences may use browser persistence. Do not put titles, excerpts, private hashes or matter identifiers into URLs, document titles, analytics or durable UI caches. Public receipt references follow the existing public schemas.
</execute_task>

📦 BUILD TASK #3: apps/web design tokens, application shell and responsive navigation
🛠️ ACTION TYPE: Extend

<execute_task>
Finish the original cinematic design using existing semantic tokens. Where missing, define: background #060B14; surface #0C1626; raised surface #112039; border #23364C; primary text #E6EDF7; secondary text #AABCD0; cobalt action #1D4ED8; cyan #67E8F9; violet #B6A1FF; amber #F5C76A; green #69D8A7; red #FDA4AF. Verify rendered contrast; adjust token pairings where necessary.

Use a restrained 4/8-pixel spacing scale, 12–16-pixel card radii, thin borders, subtle elevation and locally available fonts. Body text is at least 16 pixels with comfortable line height; reserve monospace for identifiers and numeric details. Avoid tiny uppercase paragraphs, excessive glass blur and remote font/icon requests.

At wide desktop sizes, use a roughly 64-pixel status header, 232-pixel matter rail, flexible central workspace and optional 360–420-pixel evidence/assistant panel. Keep the bottom command dock reachable without covering content. Use CSS grid/minmax and existing breakpoints rather than hardcoded viewport coordinates.

Provide functional Review, Vault, History and Verify navigation. The matter rail groups current documents, saved context and outstanding items. The status strip identifies the current matter/version and separates account, vault, network and indexing states; place detailed diagnostics behind an accessible disclosure.

Below desktop width, collapse the rail and auxiliary panel. On narrow screens use labelled Document, Aegis, Findings and Review package tabs with equivalent actions. Respect safe-area insets and dynamic viewport height; the software keyboard must not obscure Send, Stop or approval controls.

Keep the background grid faint and decorative. Use semantic landmarks, a skip link and consistent empty/loading/error states. Empty accounts show onboarding and document-intake actions, never fabricated matters or telemetry.
</execute_task>

📦 BUILD TASK #4: components/assistant/AssistantOrb and CommandCentre
🛠️ ACTION TYPE: Extend

<execute_task>
Finish AssistantOrb with lightweight CSS/SVG: a cobalt/cyan core, restrained concentric rings and a soft glow. Provide expanded and compact variants using the same component. Keep decoration separate from the accessible status label.

Map actual controller events to states: idle, local microphone active, processing, tool running, awaiting user input, stopping, completed, unavailable and error. Adapt existing enum names instead of adding a competing runtime protocol. Violet marks analysis, amber attention, and red failure; completion labels identify exactly which operation finished.

Use bounded transform/opacity animation only while the corresponding operation is active. Honour prefers-reduced-motion with a static equivalent. Stop offscreen animation. Do not draw a live audio waveform without actual audio measurements or animate nonexistent tool progress.

Build the Command-centre composition around the expanded orb, one concise status sentence, the current bounded task plan, conversation and relevant result cards. Show actual tool start/result events and meaningful failure states. No invented percentages, CPU meters, confidence scores or legal-risk gauges.

Offer contextual entry actions: Explain selection, Check payments, Missing evidence, Brief this matter and Prepare review. Disable unavailable actions with a specific reason and route enabled actions through Chapter 9 handlers. Do not create extra model calls for status copy, animation or navigation.

Preserve current matter, source selection, draft message and run when switching presentation modes. A view change alone must not restart analysis, disclose more context, discard a result or manufacture completion.
</execute_task>

📦 BUILD TASK #5: components/review/ReviewWorkspace and evidence panels
🛠️ ACTION TYPE: Extend

<execute_task>
Complete the document-dominant Review view using Chapter 8's DocumentIntakePanel, SourceViewer, FindingsPanel, EvidenceChecklist, DocumentComparison and PaymentWhatIfPanel. Dock Aegis beside the document with its compact orb. Reuse controllers and calculations; do not duplicate them inside components.

Show exact document/version, extraction coverage, saved state and source availability. Open citations through SourceReferenceV1 resolution against verified artifacts. Highlight the exact stored passage and preserve physical page identity; approximate PDF geometry must remain labelled. Retain the accessible text alternative and existing rendering limits.

Keep findings selectable beside their source, related confirmed facts, calculation inputs/results and evidence state. Display unknown, unconfirmed, missing, not assessed and not comparable distinctly. An absence finding names its searched scope; a selected excerpt cannot establish absence from the entire agreement.

Expose fact confirmation/correction and evidence-review controls through their existing user-action handlers. Show proposed values beside their sources. Preserve conflicting facts and unresolved concerns; no automatic checkbox completion from model prose.

Keep comparison limited to two supplied versions. Show incomplete/timeout results honestly. Preserve the underlying source versions when navigating differences; no automatic rewrite or acceptance of changed clauses.

Keep the payment what-if panel visually distinct and label inputs/results SIMULATED. Show original versus hypothetical figures, Reset and the actual discrepancy separately. Simulated values cannot overwrite confirmed facts, resolve findings or enter the package automatically. A contractual change requires a new source version; correcting a transcription uses the separate fact-correction flow.
</execute_task>

📦 BUILD TASK #6: CommandDock, conversation, disclosure and saved-context drawer
🛠️ ACTION TYPE: Extend

<execute_task>
Complete the shared text composer, scoped command menu, result cards and follow-up controls. Use Chapter 9 routing for commands and natural language. Enter sends only when appropriate; Shift+Enter inserts a newline; respect IME composition and mobile input behaviour. Keep draft text when a request fails before submission.

Show the selected analysis scope before Send and reuse the exact disclosure-consent controller. Source/selection/provider changes invalidate the previous disclosure as defined in Chapter 9. Local checks remain local; never upload the entire vault to fill conversational context.

Render only validated assistant blocks. Source links, calculations, findings and status cards use their trusted typed references. Display incomplete outputs and stale snapshots explicitly. Follow-up questions cannot silently broaden evidence scope or change matter/version.

Keep Stop directly reachable while assistant or voice work is active. /stop bypasses the model. Requests to approve/sign through conversation may explain or navigate to the appropriate review screen, but cannot create approval tickets or execute its controls.

Complete the saved-context drawer for confirmed facts, user notes and explicitly saved assistant observations. Provide inspect, correct, remove and export controls using the encrypted vault. Keep observations separate from confirmed facts and raw chat ephemeral.

Brief this matter is a user-requested action over the selected confirmed context, unresolved findings and current next step. Do not add scheduled briefings or global memory. Save outcome shows success only after the existing encrypted commit/readback succeeds. Removing working notes does not modify frozen reviews or previously exported copies.
</execute_task>

📦 BUILD TASK #7: Account, vault, recovery and integration-status surfaces
🛠️ ACTION TYPE: Extend

<execute_task>
Finish concise onboarding and recovery screens around existing Mera account controllers. Provide Create account and Use existing passkey with truthful capability/error states. Do not add seed phrases, browser-wallet extensions, email/OTP authentication or a second account layer.

Explain account access and vault unlocking separately. A usable signing session does not prove the vault is unlocked; vault access does not approve a package. Preserve existing session lifetimes and purpose-separated key handling. Reuse a valid scoped session without unnecessary passkey prompts.

Show meaningful transitions for unsupported capability, cancelled ceremony, expired session, backend authentication loss, empty vault, unavailable ciphertext and integrity failure. Keep private material concealed until the corresponding controller verifies access. No optimistic recovered state from a matching displayed address alone.

Connect fresh-storage recovery to the same existing credential/rpId, ciphertext discovery and actual decryption verification. Creating a different passkey is not recovery. Show when the required credential or authenticator feature is unavailable without promising universal cross-device support.

Resume read-only reconciliation of known public operations after recovery. Reconnect decrypted frozen packages by their exact references. Do not restore unused approval tickets, silently re-sign, regenerate an opening or automatically resend a transaction.

Use Chapter 6 funding controls only after an explicit Request test MON action. Show actual balance, funding limits and service availability. Keep network readiness, Qwen readiness and Envio health independent. On lock, clear sensitive panes, cancel pending private work and preserve only permitted public operation status.
</execute_task>

📦 BUILD TASK #8: apps/web/src/features/review human decisions and decision-log artifact
🛠️ ACTION TYPE: Create

<execute_task>
Implement the genuine human-review gate missing from earlier chapters. Add closed, versioned ReviewDispositionV1 and ReviewDecisionLogV1 application schemas outside the generic receipt protocol. Reuse existing fact-confirmation records; do not redefine their authority.

Bind each disposition to the finding identity, exact input/result digest, current review snapshot and actual reviewer account. Record the user's selected disposition, bounded reason and actual timestamp. Allow acknowledgement, accepted unresolved concern, permitted not-applicable, or requires change as appropriate to the finding/rule.

Require a nonblank reason for accepted unresolved concerns and permitted not-applicable decisions. Limit each reason to 2 KiB UTF-8 and apply existing finding/package limits. No preselected acceptance, model-generated human signature, automatic bulk acceptance or fabricated reviewer identity.

A human disposition does not change an arithmetic mismatch to match, prove missing evidence exists or establish legal validity. A resolved check requires corrected inputs/evidence and successful recomputation. Changed inputs invalidate dependent dispositions; preserve previous frozen records.

Technical failures—missing bytes, hash mismatch, invalid source binding, corrupt capture or stale snapshot—cannot be waived. Keep rule-pack review status and extraction limitations visible; acknowledging a draft rule pack must not relabel it reviewed or authoritative. Apply genuine profile requirements without inventing legal qualifications for the reviewer.

Generate the decision-log artifact only from actual recorded actions after explicit Record review decisions. Bind source/fact/rule versions, scope and dispositions. Exclude the log's own digest, final package digest, commitment and future signature to avoid circular hashing. Decision recording is not yet cryptographic approval.

Persist working decisions through encrypted copy-on-write vault operations. Surface unsaved/conflict states; do not enable the review gate from model text, imported approved=true flags or backend JSON claims.
</execute_task>

📦 BUILD TASK #9: apps/web/src/features/review package preview and freeze controller
🛠️ ACTION TYPE: Extend

<execute_task>
Connect Chapter 8's draft assembler to actual Chapter 9 agent-config/analysis artifacts and Task #8's genuine decision log. Build a readable review memo view from the same validated findings, calculations, evidence and decisions; do not add a second model call or a PDF-generation subsystem.

Present the exact proposed contents, source versions, confirmed facts, findings/dispositions, rule-pack/review-record identity, model-execution provenance and outstanding limitations. Use modelExecution=none for code-only work. Exclude unconfirmed proposals, ephemeral chat and SIMULATED results from automatic inclusion.

Validate Chapter 2 schemas, byte hashes, size limits and references. Require at least one source, exactly one decision-log artifact and scopeArtifactIds covering every included artifact exactly once. Validate predecessor context for supersession. Never insert placeholder artifacts to satisfy required fields.

An explicit Freeze review package action captures immutable manifest/artifact bytes and uses Chapter 2's private random opening. Pass that exact capture to Chapter 5's encrypted persistence/readback gate. Show Saving, Recoverable snapshot or the actual failure; frozen/saved does not mean approved or issued.

Copy inputs before asynchronous work and reject stale completion. Capture retries reuse the same opening, nonce, commitment and artifact identity; first reconcile an uncertain save. Do not create a new commitment to hide a timeout or catalog conflict.

Only the private vault controller may produce recoverable-capture authority. Reconstruct it after reload by retrieval, decryption and verification. A persisted flag, imported manifest or successful upload alone cannot enable signing.

Display the frozen package read-only with its public commitment and expandable technical details. Never append signatures, chain results or later human edits into its hashed contents. Relevant working changes invalidate pending previews; the old frozen package remains inspectable and immutable.
</execute_task>

📦 BUILD TASK #10: ReviewActionPreview and explicit package authorisation
🛠️ ACTION TYPE: Extend

<execute_task>
Connect the complete human-review gate and verified recoverable capture to Chapter 4's restricted review-signing controller. Keep preview tickets private, one-use and controller-owned. UI booleans, chat, voice, tool output, imported JSON and HTTP callers cannot grant these capabilities.

Before preview, ensure the intended account/session is usable, then obtain Chapter 6's fresh live chain/lifecycle/registry-nonce preflight. Preserve chain 10143, configured verified registry, the existing EIP-712 domain and 600-second action deadline. Apply the existing 15-second preflight freshness rule.

Display the exact action, signing account, network/registry, frozen package/version, commitment, complete scope, unresolved concerns and human reasons. Include predecessor/replacement for supersession. Put nonce/deadline and cryptographic details in an accessible expansion without hiding material consequences.

State plainly: this approves the specified review package, not the settlement agreement, legal correctness or professional qualification. Explain before confirmation that the approval signature authorises execution and may be submitted once disclosed, even if the user closes the screen before sending their own transaction.

Use a dedicated Approve this package button for ISSUE. Its explicit activation consumes the immutable confirmation ticket and signs only the displayed SDK action. No auto-confirmation after a passkey prompt, timer, successful analysis or checklist completion.

Any changed action field, account/generation, package, nonce, deadline, chain, registry or predecessor/replacement invalidates the preview. Expired sessions require explicit unlock followed by revalidation; never repair and re-sign silently. Recheck captured identity after asynchronous signing.

Return the signature only to the existing submission controller. Display Approval signed; publication not confirmed until chain evidence establishes more. A local decision record or signature alone cannot produce an Active receipt badge.
</execute_task>

📦 BUILD TASK #11: TransactionPreview and receipt-outcome screens
🛠️ ACTION TYPE: Extend

<execute_task>
After action authorisation, use Chapter 6's exact signed-calldata simulation and fee-quote flow. Do not estimate with a fake signature. Preserve the 30-second quote validity, existing gas policy, maximum-fee ceiling and nonce handling.

Show sender, Monad Testnet, destination registry, action, commitment/reference, expected fee and maximum fee in MON. Use existing integer arithmetic. Do not imply value=0 means no fee, promise an Ethereum-style unused-gas refund or invent a fiat conversion.

Require the separate Send transaction confirmation to consume its own one-use quote-bound ticket. This authorises the account's fee-paying submission; the earlier signature already authorised the inner registry action. Changed quote fields require renewed transaction confirmation; changed ReviewAction fields require renewed action confirmation.

Connect actual submitted, pending, included, confirmed, reverted, replaced and unknown outcomes. Show the transaction hash only when derived/observed by the trusted controller. Disable duplicate sends while reconciling the same operation.

Confirmation requires Chapter 6's execution receipt, matching fields/events, canonical block and confirmed execution checkpoint. Show receipt lifecycle separately with its as-of checkpoint. A confirmed issue transaction may correspond to a receipt now revoked or superseded.

Show indexer lag independently. Envio data cannot promote an unknown transaction or override live registry state. If another executor submitted the disclosed authorisation, show that established action outcome separately from this account's own transaction outcome.

After timeout/reload, offer Refresh status and a configured explorer link; do not mark failure solely from missing response. Never automatically fund, replace, bump fees, change a nonce, regenerate a commitment or re-sign. Keep raw signatures and transactions out of durable browser storage, logs and screenshots.
</execute_task>

📦 BUILD TASK #12: Receipt lifecycle actions and coordinated Stop behaviour
🛠️ ACTION TYPE: Extend

<execute_task>
Finish explicit Revoke receipt and Replace with reviewed package flows using existing REVOKE/SUPERSEDE controllers. Show current live status, selected reviewer, exact commitment(s) and consequences before authorisation. Require fresh lifecycle checks and the existing two-stage signing/submission flow.

REVOKE targets an Active receipt belonging to the selected reviewer and leaves its evidence/history intact. Do not require the old private documents merely to inspect or revoke a known public receipt when existing controller requirements are satisfied.

SUPERSEDE requires a separately reviewed, frozen and recoverably saved replacement declaring the exact Active predecessor under the same chain/registry/reviewer. Show both versions and changed review scope. Preserve the old package; do not edit it in place. The paired supersession logs represent one action.

Provide Cancel outstanding authorisation through Chapter 6's narrowly scoped registry-nonce invalidation flow. Show the exact nonce and that all outstanding instructions using it are affected. This is a separate fee-paying action, may lose a race and does not revoke an already issued receipt. Do not manufacture a ReviewAction signature for invalidateNonce.

Coordinate Stop with Chapter 9 cancellation, local speech abort, read-aloud cancellation and invalidation of unused approval/transaction tickets. Stop itself never submits nonce invalidation, revocation or another transaction.

Before signature release/broadcast, cancel subsequent work. After disclosure or possible submission, explain the remaining authorisation or pending/unknown network outcome and retain read-only reconciliation. Closing a panel, locking the vault or expiring a local quote cannot retract an already disclosed signature or broadcast transaction.

Keep acknowledgement semantics honest: assistant Stopping becomes Cancelled only when the runtime acknowledges it. Network outcomes use their own state. Do not label the whole matter cancelled when only dictation or assistant work stopped.
</execute_task>

📦 BUILD TASK #13: ActivityDrawer, History and export/verification handoff
🛠️ ACTION TYPE: Extend

<execute_task>
Complete the activity drawer with separate Assistant work, Human decisions and Public receipts views. Use actual timestamps and provenance. Distinguish an unsigned local decision, signed authorisation and observed on-chain event; do not present them as interchangeable evidence.

Connect Chapter 7's paginated history and freshness/checkpoint data. Deduplicate stable event identities; group supersession correctly. Display reorganisation, lag, unavailable and partial-history states. Private matter titles may enrich an unlocked local view but must not be sent to the indexer or public links.

Open historical frozen reviews read-only. Keep current working results separate from past package contents. Removing a working note does not erase historical evidence or public receipts. An address identifies a signing account, not a verified professional identity.

Connect Chapter 5's existing EncryptedReviewExportV1, ReviewExportV1 and MatterContextExportV1 controls. An encrypted review export backs up one review and requires the same usable credential/rpId; it is not a whole-workspace backup or independently decryptable recipient handoff.

Readable review/context downloads require their dedicated disclosure preview and explicit Download action. Identify included documents/notes and the opening/hash disclosure. Do not silently redact a committed package, call full-package disclosure selective, or automatically share files. Reuse existing size limits, safe filenames and object-URL cleanup.

Provide Copy public receipt reference without copying the private opening. Hand readable files to the user for explicit import into the independent verifier; never put them in URLs, cross-origin messages or automatic uploads. The full verifier integration belongs to Chapter 11; show its actual availability without fabricated verification success.
</execute_task>

📦 BUILD TASK #14: apps/web/src/features/voice local speech recognition
🛠️ ACTION TYPE: Create

<execute_task>
Implement optional on-device dictation behind a typed capability adapter. Feature-detect the actual SpeechRecognition implementation, processLocally support and available() API; assigning an arbitrary JavaScript property does not prove support. Use a secure context and verify current browser API behaviour.

Default the requested language to en-GB. Check available({langs:[language],processLocally:true}); set recognition.lang=language, processLocally=true and continuous=false before start(). Enable capture only when the selected local capability is available. Do not infer locality from a browser name, prefixed constructor or microphone permission alone.

Represent unavailable, downloadable, downloading, ready, denied and failed states separately. If supported, offer an explicit Download language pack action through install({langs:[language]}); recheck after completion. Use verified supported options only. Never set processLocally=false or introduce a cloud fallback. Unsupported local voice leaves text fully usable.

Start capture only from an explicit push-to-talk action, with an equivalent keyboard-accessible Start/Finish control. Set a 30-second maximum, prevent concurrent recognizers and show actual microphone state from lifecycle events. Normal Finish uses stop() to obtain final text; Stop/cancellation uses abort() and rejects late results.

Place results into an editable draft requiring Send and Chapter 9's normal disclosure flow. Interim text stays provisional; do not overwrite intervening manual edits. Spoken commands, yes or approve cannot confirm facts, create approval tickets or send transactions.

On lock, account/matter/version switch, hidden page, unexpected loss of capture control or unmount, abort and detach handlers. Normal button release must retain its pending final-result phase. Bind callbacks to capture generation; never auto-restart after end/error. Do not record/upload audio, add MediaRecorder, create fake waveforms or start background listening. Restrict relevant Permissions-Policy directives to intended same-origin capabilities without weakening existing account/security policy.
</execute_task>

📦 BUILD TASK #15: Local read-aloud and shared voice interruption controls
🛠️ ACTION TYPE: Create

<execute_task>
Implement opt-in read-aloud using SpeechSynthesis with an explicitly selected voice whose localService===true. Enumerate voices, handle voiceschanged and verify the selected voice still exists immediately before playback. Do not use a default or remote voice when the local choice is unavailable.

Read only the user-selected, validated answer or passage as plain text. Bound one playback selection to 4,000 characters and require explicit narrowing instead of silently implying the entire document was read. No SSML injection, auto-reading new model output, actor imitation or external speech provider.

Provide Play, Pause/Resume where supported and Stop with accessible labels. Show actual playback state/errors. Keep voice preferences non-sensitive; never persist spoken legal text in a preference store or audio cache.

Prevent simultaneous recognition and synthesis. Starting dictation stops playback; starting read-aloud ends capture through an explicit user action. Stop calls speechSynthesis.cancel(), aborts active recognition and invokes the existing assistant cancellation handler when applicable. These operations keep their separate acknowledgements.

Cancel playback on lock, hidden page, account/matter/version switch, source invalidation or component teardown. Remove queued utterances and ignore stale callbacks. If local speech cannot be verified, explain that read-aloud is unavailable and retain the complete text experience.

Keep voice state subordinate to the existing workspace/assistant contracts. Listening and Speaking describe actual device activity, never model readiness, human approval or successful chain execution.
</execute_task>

📦 BUILD TASK #16: Focused browser tests, accessibility and visual verification
🛠️ ACTION TYPE: Validate

<execute_task>
Add meaningful Playwright/integration coverage using synthetic Chapter 8–9 fixtures. Test both presentation modes, source navigation, command parity, disclosure changes, fact confirmation, saved context, decision recording, frozen capture and the two distinct authorisation stages.

Assert that model output, voice transcripts, imported approval flags, expired sessions, missing capture objects, invalid hashes and stale source/fact/rule revisions cannot enable signing. Use controlled async barriers to change account/package/nonce/quote during signing and assert stale signatures or submissions are rejected.

Cover user rejection at each ceremony, duplicate clicks, quote expiry, unknown submission, external execution, reload recovery, indexer lag, revocation, supersession and nonce invalidation. Assert Stop does not send a transaction or claim to reverse one. Keep live and scripted evidence distinctly labelled.

Test speech through injected capability adapters: local support, missing pack, permission denial, no cloud fallback, transcript editing, manual-edit races, late callbacks, local-voice disappearance and coordinated Stop. Mocked browser speech proves controller behaviour only; record real-device local recognition/playback separately when available.

Inspect 1440×900, 1024×768 and 390×844 layouts plus narrow 320-CSS-pixel reflow and browser zoom. Capture synthetic screenshots for command centre, review, approval, locked and error states. Fix clipped controls, overlapping panels, obscured focus, unreadable text and fake progress. Use screenshot inspection, not a fabricated visual-QA pass.

Use semantic controls, visible focus, keyboard navigation, non-colour state labels, restrained live announcements and reduced motion. Dialogs manage initial focus, focus containment, Escape and restoration; Escape never confirms. Use at least 44×44 CSS-pixel primary touch controls and maintain WCAG AA contrast.

Verify lock clears private DOM/state and stale responses cannot repopulate it. Revalidate controller state on page restoration before showing private panes. Keep confidential contents out of server-rendered HTML, URLs, logs and persistent browser caches. Do not claim guaranteed memory erasure or complete accessibility certification from automated checks.
</execute_task>

📦 BUILD TASK #17: Chapter 10 build gates and independent-verifier handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected type/schema checks, lint, web/agent/vault builds and focused controller/browser tests. Verify browser bundles contain no provider credentials or raw signing interfaces and that model tools cannot import human approval controllers. Fix concrete failures without weakening gates.

Demonstrate the integrated synthetic journey: recover/create account -> unlock vault -> select document -> ask Aegis with explicit disclosure -> open cited findings -> confirm facts and record decisions -> freeze/save/read back -> approve exact package -> inspect fees -> explicitly send -> observe actual receipt state -> export the selected package.

Use the real adapters where configured. A scripted transaction/provider is a fixture, not live bounty evidence. If network, passkey, speech or deployment prerequisites are unavailable, record the exact unverified portion and preserve working text/local workflows. Do not create fake addresses, signatures, hashes, confirmations or recovery success.

Record actual screenshots, test results, supported/unsupported voice capabilities and relevant integration evidence paths in docs/build-state.json. Preserve previous chapter records. Keep CLAUDE.md within 450 words and docs/assistant-ui-contract.md within 1,200 words by updating stale content rather than appending repetition.

Hand Chapter 11 the existing readable export/reference schemas, receipt-state distinctions, public verification navigation and complete package examples. Do not implement that chapter's independent verifier or claim the remaining security/deployment chapters are complete.

Finish with the working Aegis HUD and genuine human approval gates in repository files. Stop after Chapter 10. Do not deploy, publish a submission/article or output a terminal status-report payload.
</execute_task>
```
