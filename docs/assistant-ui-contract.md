# Assistant and UI contract

Requirements for assistant and UI work; not evidence that a feature exists. Authority: the v3 brief, then `UI_UX_Instructions/UI_UX_BLUEPRINT.md` for visuals only.

## Shell (Chapter 1)

- `apps/web` shell: system strip (matter, network, passkey session, vault, transaction, indexer as separate readings), navigation, Command-centre and Review modes, mobile tabs, command dock, activity drawer, action preview, readiness.
- The orb is CSS/SVG with a text label, animated only for real `running`/`stopping` states and never under reduced motion.
- View state lives in `WorkspaceProvider`, so mode switches keep the draft. Typed contracts: `@lexaegis/agent/contracts`. Voice is unavailable; Stop is `aria-disabled` unless a run or preview is active.

## Allowed assistant intents

`summarise`, `explain`, `check_payments`, `missing_evidence`, `brief_matter`, `prepare_review`, `status`. Slash commands mirror them and use the same handlers. `/stop` is handled by code, bypasses the model and calls cancellation. No sign, approve, revoke, supersede, send-message or arbitrary-execution tool is exposed to the model.

## Boundaries

- The model proposes; deterministic code decides. Model output, chat and voice can never approve, sign, confirm a fact or change rules.
- Assistant run state is separate from wallet, vault, review and chain state. A completed run implies no approval, signature or confirmation.
- Events carry run, matter, version, snapshot and a per-run `seq`; late, stale or gapped streams are discarded.
- Cancellation is bound to the authenticated run owner. Stopping cannot reverse a broadcast transaction or retract plaintext already sent.
- Local processing, assistant runs, human decisions and chain events stay visibly distinct.

## Requirements by chapter (pending)

- **Chapter 10: HUD.** Still to add: action preview, briefing, saved-context selection, mobile and screen-reader review.
- **Chapter 10: voice.** Push-to-talk only where verified on-device recognition exists; no silent remote fallback, wake word or background listening. Results go to an editable draft that needs Send. Off by default.
- **Chapters 4, 6, 10: approval.** A session or chat cannot approve. A dedicated action reviews the exact frozen package and creates the bounded EIP-712 instruction. Changed inputs invalidate the preview. Revoke and supersede have their own previews.
- **Chapters 7, 10: history.** Combine assistant activity, human decisions and Envio history without merging their meanings. Show real confirmations and checkpoints; an indexer result is never a live verification.
  - **Chapter 7 states (built).** History reads `/api/history/{status,reviewers/<address>,receipts/<address>/<commitment>}`: public, read-only, no passkey. Index state is `availability` (available|unavailable), `freshness` (caught_up|catching_up|unknown) and `indexConsistency` (consistent|recovering|inconsistent|unknown), always worded in text with exact block lag. `history_reset_required` (409) means refresh. Empty reads "No indexed history" only after coherent coverage; `not_indexed` is never NotFound. Indexed lifecycle and live registry result are two readings, compared only at the same block; actions newer than the confirmed checkpoint are "provisional".
  - **Public activity events.** The drawer's "On-chain events" section lists indexed actions (issued, revoked, replaced, authorisations cancelled) with block and provisional label, apart from assistant work and human decisions. Chain confirmed can show "history catching up". A typed read-only `HistoryController.getSnapshot()` is the `/status` adapter: it needs no model call and exposes no write capability. Private matter titles join only in browser memory while the vault is unlocked, by commitment and reviewer.
- **Chapters 12, 13.** Validation covers cited output, cancellation, cross-matter isolation, approval binding, simulation isolation, accessibility and injection. The demo shows request, cited issue, approval, real transaction and independent verifier.

## Assistant (Chapter 9)

- One Qwen runtime; endpoint, model and output mode are operator settings, never substituted. Real-matter runs need a passing `pnpm qwen:smoke` for that exact configuration.
- `/status`, `/check-payments` and `/missing-evidence` run on the device. Anything else opens a disclosure preview; only its Send creates consent, bound to that exact content and provider.
- The model sees handles and reads excerpts only through `read_sources`. Code prints quotes, totals and status; validation checks references and schema, not correctness.
- Limits: 6 provider attempts, 8 tool calls, 120 seconds, one run per account. Interrupted means the outcome is unknown.
- A proposal needs Confirm, Edit or Dismiss. Save outcome stores encrypted artifacts as an unconfirmed observation, shown saved only after read-back.
- Chapter 10 builds on `@/features/assistant/public` and `ReviewController.draftArtifacts`.

## Visual direction

Obsidian background, cobalt/cyan core; violet analysis, amber attention, green confirmed, red errors; every state also has text and an icon. Tokens: `--lj-*` in `apps/web/src/app/globals.css`. No remote fonts or icons.

## Optional features and flags (Chapter 14)

- Six server-side flags: `voice`, `documentComparison`, `matterBriefing`, `reputationFeedback`, `agentIdentity`, `matterNotes` (`FEATURE_*`, exactly `true` or `false`). The first four default off; the last two default on only when implemented and verified. An explicit `true` never bypasses a missing implementation or verification; an invalid value turns every flag off. Only `documentComparison` is implemented so far.
- A disabled feature has no navigation item, command, button, route, empty panel or coming-soon text, and no assistant tool or intent. Direct requests are rejected server-side (`rejectIfDisabled`). `/api/readiness` lists enabled features only.
- Voice off: no microphone, playback or remote speech. Notes off: saved notes are not model context.
- Stop, consent, approval, fee confirmation, citations, the what-if label and independent verification are never gated by a flag.
- Flags are read once at server start; the effective set has a revision (`computeRevision`).

## Accounts (Chapter 4)

- Passkey account creation and recovery (Mera, PRF, profile `lexaegis.evm.bip32-prf.v1`), a memory-only signing session (10 minutes, 5 idle), EIP-4361 sign-in, Lock, Sign out, and the Account panel at `/vault`.
- Public account events: `account_created`, `account_recovered`, `signing_unlocked`, `signing_locked`, `signing_expired`, `signed_in`, `signed_out`, `recovery_mismatch`, `hint_forgotten`, `cancelled`.
- The assistant may explain account state but cannot unlock, create a ticket, request PRF bytes or reach a signer.
- Separate readings, never merged: account, signing session, server sign-in, vault, chain. An unlocked account is not a decrypted vault and says nothing about a receipt.
- Approval: `review-signing.ts` signs only an exact, previewed, confirmed registry action through a one-use ticket; the production control stays unavailable until Chapter 10 supplies the review gate.
- Chain (Chapter 6): Network and test funds panel at `/vault`. Funding is bounded, never gasless and implies no approval. A second one-use ticket authorises the fee-paying transaction. Status words: Checking network, Awaiting confirmation, Signing, Sending, Pending, Checking execution, Confirmed, Reverted, Status unknown. Stop cannot cancel a sent transaction.

## Vault (Chapter 5)

- At `/vault` and in the matter rail: create (only after a fresh absence check), unlock, recover, lock, matters, source files (10 MiB), context entries, saved review packages, export/import with a disclosure preview. Labels: `Awaiting passkey`, `Unlocking vault`, `Saving encrypted files`, `Checking saved package`, `Saved`, `Unsaved changes`, `Conflict`, `Locked`, `Recovery failed`.
- Everything is encrypted in the browser. The vault locks at 10 minutes (5 idle), on Lock, Sign out, account lock, `pagehide` and bfcache restore, clearing every decrypted view, draft and pending export. Unlocking approves nothing.
- A saved package shows only as `Saved and checked`, rebuilt by retrieval and verification in the current unlock; never approved, signed or an active receipt.
- Corrections and imports are unconfirmed until accepted. A 409 keeps the draft; an uncertain save is reconciled from the head. Readable exports expose documents, hashes and the blinding nonce; nothing downloads without confirmation.
- Assistant hook: only confirmed, explicitly selected entries, at most 32 KiB, never truncated. The assistant cannot unlock, confirm, export, import or persist a fact.

## Documents (Chapter 8)

- `/review`: text-PDF intake (10 MiB, 80 pages, one job, 30-second terminable worker, Stop), source viewer by physical page with the exact passage highlighted, findings, evidence checklist, SIMULATED payment what-if, and (flag `documentComparison`, off by default) two-version comparison. Scans, passwords and OCR are refused with a reason.
- A finding opens its passage by page and offset; absence names the searched documents and quotes nothing. Hashes prove consistency, not truth.
- Only the reviewer confirms facts. Any change to sources, facts, evidence or rules marks results stale and clears the draft. Lock, matter or account change empties every pane and stops jobs.
- Findings are plain statements: no validity verdict or risk score. The rule pack is `demo_draft`, unreviewed.
- The what-if is isolated: it cannot change facts, findings, packages or transactions.
- Only ciphertext leaves the browser, except text you send through a disclosure.
