# Assistant and UI contract

Requirements for assistant and UI work; not evidence that a feature exists. Authority: the v3 brief, then `UI_UX_Instructions/UI_UX_BLUEPRINT.md` for visuals only.

## Shell (Chapters 1, 10)

- `apps/web` shell: status strip (matter and version, network, passkey session, server sign-in, vault, transaction, indexer as separate readings; Diagnostics disclosure), navigation, Command-centre and Review modes, labelled mobile tabs (Document, Aegis, Findings, Review package), command dock, activity drawer, saved-context drawer.
- View state lives in `WorkspaceProvider`, so mode switches keep selection and draft. A pure readiness selector (`features/workspace`) returns blockers, outstanding decisions and next actions from controller snapshots; there is no combined approved or ready flag.
- The orb is CSS/SVG with a text label, animated only for real running, tool, listening or stopping states and never under reduced motion; completion names the operation and says it approves nothing.
- Palette tokens (`--lj-*` in `globals.css`) have a contrast test. The page scrolls on narrow screens and the dock is sticky.

## Allowed assistant intents

`summarise`, `explain`, `check_payments`, `missing_evidence`, `brief_matter`, `prepare_review`, `status`. Slash commands mirror them. `/stop` bypasses the model. Approve, sign, freeze and similar phrases are refused by the router and only explain. No sign, approve, revoke, supersede, send-message or arbitrary-execution tool is exposed to the model, and assistant code may not import any approval, decision, package, transaction or voice controller (`boundaries.test.ts`).

## Boundaries

- The model proposes; deterministic code decides. Model output, chat and voice can never approve, sign or confirm a fact.
- Assistant run state is separate from wallet, vault, review and chain state. A finished run implies no approval, signature or confirmation.
- Events carry run, matter, version, snapshot and a per-run `seq`; late, stale or gapped streams are discarded.
- Stop is one coordinated action (assistant, dictation, read-aloud, unused approval preview, unsent transaction). It never sends anything and never claims to reverse a broadcast or retract a disclosed signature.

## Human approval (Chapter 10)

- **Decisions.** Each finding needing one gets the reviewer's own disposition (acknowledge, accept unresolved concern, not applicable, requires change), bound to the finding digest, snapshot and account. Reasons: at most 2 KiB, required for accepted concerns and not-applicable. Technical failures cannot be waived. A disposition never changes a result. Changed inputs drop dependent decisions. Record review decisions builds the decision log; that is not approval.
- **Package.** Preview shows exact contents (one decision log, full scope, `modelExecution` none for code-only work). Freeze captures the Chapter 2 opening and saves it through the Chapter 5 gate; retries reuse the same capture. Frozen and saved is not approved or issued.
- **Stage one.** The approval controller binds the signing gate: a capture verified in this unlock, the decision log read from inside it, a live registry read under 15 seconds old, and unchanged account and vault generations. The dedicated Approve control needs a trusted click, re-reads live state, signs only the displayed action and hands the signature once to the submission controller. Display: "Approval signed; publication not confirmed."
- **Stage two.** Send transaction is a separate one-use confirmation on an exact signed-calldata quote (expected and maximum fee in MON, 30 s validity, Renew without re-signing). Outcome, live receipt lifecycle with its block, and indexer lag are separate readings.
- **Lifecycle.** Revoke needs only a known public Active receipt. Replace needs a separately frozen package declaring the Active predecessor. Cancel outstanding authorisation is the fee-paying nonce invalidation.

## Voice (Chapter 10, flag `voice`)

On-device only: dictation requires the browser to report local recognition for en-GB (`processLocally`, `available()`); there is no cloud fallback, wake word, audio capture or background listening. Push-to-talk, 30 s limit, one recognizer, results land in an editable draft that needs Send. Read-aloud uses a chosen `localService` voice, one selected answer up to 4,000 characters as plain text. Dictation and playback never overlap; both end on lock, hidden page or context change. Real-device behaviour is unverified.

## History (Chapters 7, 10)

- Reads `/api/history/{status,reviewers/<address>,receipts/<address>/<commitment>}`: public, read-only. Index state is `availability`, `freshness` and `indexConsistency`, worded in text with block lag. `history_reset_required` (409) means refresh. `not_indexed` is never NotFound. Indexed lifecycle and live registry result are separate readings; newer actions are "provisional". The live read wins.
- The activity drawer has three views: assistant work; human decisions (unsigned, local) apart from signed authorisations; public receipts. Private matter titles join only in browser memory while unlocked.
- Saved reviews open read-only after verification in this unlock, copy only the public reference, and export through disclosure previews. Verify links to the separate verifier; nothing here reports verified.

## Assistant (Chapter 9)

- One Qwen runtime; endpoint, model and output mode are operator settings. Real-matter runs need a passing `pnpm qwen:smoke` for that exact configuration.
- `/status`, `/check-payments` and `/missing-evidence` run on the device. Anything else opens a disclosure preview; only its Send creates consent for that exact content and provider.
- The model sees handles and reads excerpts only through `read_sources`. Code prints quotes, totals and status.
- Limits: 6 provider attempts, 8 tool calls, 120 seconds, one run per account. Interrupted means unknown outcome.
- A proposal needs Confirm, Edit or Dismiss. Save outcome stores an unconfirmed observation, shown saved only after read-back.

## Optional features (Chapter 14)

Six server-side flags (`FEATURE_*`, exactly `true` or `false`): `voice`, `documentComparison`, `matterBriefing`, `reputationFeedback`, `agentIdentity`, `matterNotes`. An explicit `true` never bypasses a missing implementation or verification. A disabled feature has no navigation, command, button or route. Implemented: `documentComparison`, `voice`. Stop, consent, approval, fee confirmation, citations, the what-if label and verification are never gated.

## Accounts (Chapter 4)

Passkey accounts (Mera, PRF), memory-only signing session (10 minutes, 5 idle), EIP-4361 sign-in, Lock, Sign out. Readings never merge: account, signing session, server sign-in, vault, chain. An unlocked account is not a decrypted vault. Chain (Chapter 6): funding is bounded, never gasless and implies no approval; a second one-use ticket authorises the fee-paying transaction.

## Vault (Chapter 5)

Create (after an absence check), unlock, recover, lock, matters, source files (10 MiB), context entries, saved packages, export/import with a disclosure preview. Everything is encrypted in the browser. The vault locks at 10 minutes (5 idle), on Lock, Sign out, `pagehide` and bfcache restore, clearing decrypted views, drafts and pending exports. A saved package shows only as "Saved and checked", rebuilt by retrieval and verification this unlock. Readable exports expose documents, hashes and the blinding nonce.

## Documents (Chapter 8)

`/review`: text-PDF intake (10 MiB, 80 pages, one job, 30-second worker), source viewer with the exact passage highlighted, findings, checklist, SIMULATED what-if, and (flag, off by default) two-version comparison. Absence findings name the searched documents. Only the reviewer confirms facts. Any change to sources, facts, evidence or rules marks results stale. Findings are plain statements: no validity verdict or risk score. The rule pack is `demo_draft`, unreviewed.

## Independent verification (Chapters 11, 15)

`apps/verifier`, the SDK and the read-only `proof-of-review` command check an export locally against a separately supplied public reference; registry reads are explicit and read-only. Results never combine into "valid"; signer acceptance needs a caller policy. A receipt does not prove legal correctness or professional identity.

## Requirements still open

Chapters 12 and 13 validation (cited output, cancellation, isolation, approval binding, injection, accessibility) and the demo with a real transaction.
