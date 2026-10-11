# CLAUDE.md

## Commands

Status: `docs/build-state.json` (5 real-device recovery, 6 testnet credentials, 9 live Qwen run). Node 24+, pnpm 11.

- `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`
- Gates: `fixtures:check`, `baselines:check`, `exclusion:check`, `secrets:check`, `state:validate`, `readiness`
- Others (`contracts:*`, `test:*:browser`, `db:dev`, `tools:s3`): see `package.json`. Copy `.env.example`. TypeScript below 6.1.

## Workflow

- Session start: read only `docs/build-state.json`.
- "Proceed to chapter N" / "next chapter": chapter N-1 must be `complete` (else stop and say). Read only its file at `chapterPromptPath`; run its `📦 BUILD TASK #n` blocks in order, no plans, without stopping between tasks. "Continue": resume `currentChapter` at its first incomplete task.
- Strict TypeScript; closed `z.strictObject` schemas at every boundary; no `any`, coercion or non-string bigints.
- After each task update build-state.json (status, files, interfaces later chapters need). At chapter end run the gate, record observed results, mark complete only if required checks passed, set `currentChapter`/`nextChapter`, summarise, stop.

## Git

- After each task: `git add -A`, commit `ch<N> task <X>: <summary>`, push. Chapter end: `ch<N> complete`. Messages come from the task just done; no `git diff`/`git log`.
- Never force-push, commit `.env` or secrets, or rewrite history. If a push fails, report and continue; no retry loop.

## What is being built

**Proof of Review**: a person approves an exact package of AI-assisted work; anyone can verify it without trusting the app. **LexAegis**: employment settlement review (England and Wales), Monad testnet 10143, deadline `2026-10-14T04:59+01:00`. Authority: `project_brief/`; visuals: `UI_UX_Instructions/`; requirements: `docs/assistant-ui-contract.md`. Run order: 1–3, 14, 4–6, 8, 9, 7, 10, 11, 15–18, 12, 19, 13.

## Boundaries

- `protocol` (`/v1`), `sdk` (no hashing), `vault` (Web Crypto only, `/v1` frozen), `agent` (server-only).
- Web UI imports only `@/features/*/public`; server code never imports them, Mera or `@scure/bip32`. Test-only: `src/test-support`, `@lexaegis/agent/testing`.
- `apps/verifier` is standalone; `contracts`, `tooling`, `fixtures/*` never import `packages/`.

## Invariants

- v1 is frozen: schema IDs, commitment construction, EIP-712 domain, registry ABI, profiles `lexaegis.evm.bip32-prf.v1` and `lexaegis.vault.hkdf-sha256.aes-256-gcm.v1`. Never regenerate vectors to pass a test.
- Only `ReceiptReferenceV1` is public; manifests, hashes, labels, nonces are private.
- Saved, signed, confirmed, indexed and active differ; no `valid=true`; RPC failure is `unknown`.
- No simulated success; unavailable integrations return typed failures.
- Keys, PRF outputs and sessions stay in memory. Vault unlock is not a signing session.
- Model proposes, code decides: no model, chat or voice input approves, signs or confirms.
- A frozen package is ready only via a `RecoverableCapture` rebuilt by retrieval and verification in this unlock; signing consumes it, never a rebuild. Approval is a trusted click; technical failures are unwaivable.
- Money is GBP minor units as decimal strings.
- Only real_device/live_testnet evidence passes live gates; gates are computed. Failed Gate B withdraws the Mera bounty claims.
