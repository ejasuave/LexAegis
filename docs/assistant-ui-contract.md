# Assistant and UI contract

Requirements, not evidence that a feature exists. Authority: v3 brief; `UI_UX_Instructions/UI_UX_BLUEPRINT.md` for visuals only.

## Shell (Chapters 1, 10)

- `apps/web` shell (`components/hud`): telemetry ceiling (matter and version, network, passkey session, public account, vault, transaction, indexer as separate readings; server sign-in in a status disclosure), navigation, three-zone workbench (matter rail, stage, attention rail), Command-centre and Review modes, labelled mobile tabs (Matter, Document, Findings, Activity), command dock, activity and saved-context drawers. Layout rules: `UI_UX_Instructions/UI_UX_BLUEPRINT.md`.
- View state lives in `WorkspaceProvider`. A pure readiness selector returns blockers, outstanding decisions and next actions; there is no combined approved or ready flag.
- The orb is CSS/SVG with a text label, animated only for real running, tool, listening or stopping states and never under reduced motion; completion names the operation and says it approves nothing.
- Palette tokens (`--lj-*`) have a contrast test. Only the idle dock hint is clipped.

## Allowed assistant intents

`summarise`, `explain`, `check_payments`, `missing_evidence`, `brief_matter`, `prepare_review`, `status`. Slash commands mirror them. `/stop` bypasses the model. Approve, sign, freeze and similar phrases are refused by the router. No sign, approve, revoke, supersede, send-message or arbitrary-execution tool is exposed to the model, and assistant code may not import any approval, decision, package, transaction or voice controller.

## Boundaries

- The model proposes; deterministic code decides. Model output, chat and voice can never approve, sign or confirm a fact.
- Assistant run state is separate from wallet, vault, review and chain state. A finished run implies no approval, signature or confirmation.
- Events carry run, matter, version, snapshot and a per-run `seq`; stale or gapped streams are discarded.
- Stop is one coordinated action (assistant, dictation, read-aloud, unused approval preview, unsent transaction). It never sends anything and never claims to reverse a broadcast or retract a disclosed signature.

## Human approval (Chapter 10)

- **Decisions.** Each finding needing one gets the reviewer's own disposition (acknowledge, accept unresolved concern, not applicable, requires change), bound to the finding digest, snapshot and account. Reasons: at most 2 KiB, required for accepted concerns and not-applicable. Technical failures cannot be waived. Changed inputs drop dependent decisions.
- **Package.** Preview shows exact contents. Freeze captures the Chapter 2 opening and saves it through the Chapter 5 gate. Frozen and saved is not approved or issued.
- **Stage one.** The approval controller binds the signing gate: a capture verified in this unlock, the decision log read from inside it, a live registry read under 15 seconds old, unchanged account and vault generations. Approve needs a trusted click, re-reads live state, signs only the displayed action and hands the signature once to submission. Display: "Approval signed; publication not confirmed."
- **Stage two.** Send transaction is a separate one-use confirmation on an exact signed-calldata quote (expected and maximum fee in MON, 30 s validity, Renew without re-signing). Outcome, live receipt lifecycle with its block, and indexer lag are separate readings.
- **Lifecycle.** Revoke needs a known public Active receipt. Replace needs a separately frozen package declaring the Active predecessor. Cancel outstanding authorisation is the fee-paying nonce invalidation.

## Voice (Chapter 10, flag `voice`)

On-device only: dictation requires the browser to report local recognition for en-GB; no cloud fallback, wake word or background listening. Push-to-talk, 30 s limit, one recognizer; results land in an editable draft that needs Send. Read-aloud uses a `localService` voice, one answer up to 4,000 characters. Both end on lock, hidden page or context change; text works without them. Real-device behaviour is unverified.

## History (Chapters 7, 10)

- `/api/history/*` is public and read-only. Index state is `availability`, `freshness` and `indexConsistency`, with block lag in text. `not_indexed` is never NotFound. Indexed lifecycle and live registry result are separate; newer actions are "provisional"; the live read wins.
- The activity drawer separates assistant work, local unsigned decisions, and public receipts. Private matter titles join only in browser memory while unlocked.
- Saved reviews open read-only after verification in this unlock and export through disclosure previews. Nothing here reports verified.

## Assistant (Chapter 9)

- One Qwen runtime; endpoint, model and output mode are operator settings. Real-matter runs need a passing `pnpm qwen:smoke` for that exact configuration.
- `/status`, `/check-payments` and `/missing-evidence` run on the device. Anything else opens a disclosure preview; only its Send creates consent for that exact content and provider.
- The model sees handles; excerpts only via `read_sources`. Code prints quotes, totals and status.
- Limits: 6 provider attempts, 8 tool calls, 120 s, one run per account. Interrupted means unknown. A proposal needs Confirm, Edit or Dismiss.

## Optional features (Chapter 14)

Six server flags (`FEATURE_*`, exactly `true` or `false`): `voice`, `documentComparison`, `matterBriefing`, `reputationFeedback`, `agentIdentity`, `matterNotes`. A flag never bypasses missing implementation or verification; a disabled feature has no navigation, command, button or route. Implemented: `documentComparison`, `voice`, `agentIdentity` (read-only). Stop, consent, approval, fees, citations and verification are never gated.

## Accounts and vault (Chapters 4, 5, 6)

Passkey accounts (Mera, PRF), memory-only signing session (10 minutes, 5 idle), EIP-4361 sign-in, Lock, Sign out. Readings never merge; an unlocked account is not a decrypted vault. Funding is bounded, never gasless, and implies no approval. The vault is encrypted in the browser (source files 10 MiB), locks at 10 minutes (5 idle), on Lock, Sign out, `pagehide` and bfcache restore, clearing decrypted views and drafts. A saved package shows only as "Saved and checked", rebuilt by retrieval and verification this unlock. Readable exports expose documents, hashes and the blinding nonce.

## Documents (Chapter 8)

`/review`: text-PDF intake (10 MiB, 80 pages), source viewer with the exact passage highlighted, findings, checklist, SIMULATED what-if, optional two-version comparison. Only the reviewer confirms facts; any change marks results stale. No validity verdict or risk score. The rule pack is `demo_draft`, unreviewed.

## Independent verification (Chapters 11, 15)

`apps/verifier`, the SDK and the read-only `proof-of-review` command check an export locally against a separately supplied public reference. Results never combine into "valid". A receipt proves neither legal correctness nor professional identity.

## Security and limits (Chapters 12, 17)

- Ciphertext protects stored content, not the selected plaintext sent for inference. The service sees public account, size and timing metadata. The disclosure preview says each excerpt goes to the server with its source reference, and that those digests do not go to the provider.
- Receipts bind bytes and account actions, not truth or legal validity. Same-origin script compromise remains a risk. Credential loss or missing ciphertext can prevent recovery; rollback of a fresh state is only partly detectable. Disclosures and public chain history cannot be recalled by local deletion.
- No label says audited, secure, legally correct or professionally verified. Observed: registry code equals source (2026-10-11); invariant campaigns; static findings triaged; disclosure checks; the local `pnpm validate:mvp` gate. None is an audit.

## Adoption kit (Chapter 18)

The `proof-of-review-status` widget is read-only and outside the assistant: it never signs, approves or requests a wallet, and shows Receipt status and File integrity separately, never "valid". Trust comes only from host configuration; a missing configuration, wrong network or failed read is `unknown`. The ai-pr-signoff example issues only through typed terminal confirmations. Local evidence only; testnet issue NOT YET.

## Requirements still open

Real-device recovery on a second device, a live Qwen run, a new testnet lifecycle and hosting checks (Chapter 13).
