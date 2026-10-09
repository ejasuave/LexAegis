# CLAUDE.md

## Commands

Chapters 1–3 and 8 complete; 14 (early scope), 4 and 5 (awaiting real-device checks) and 6 (awaiting testnet credentials and deployment) in progress. Results: `docs/build-state.json`. Node 24+, pnpm 11.

- `pnpm install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `test`, `build`
- One file: `pnpm exec vitest run <path>`; by name add `-t "<name>"`
- `fixtures:check`, `protocol:check`, `baselines:check`, `secrets:check`, `exclusion:check`, `state:validate`, `readiness`
- `contracts:*` (Foundry via `contracts/scripts/foundry.ts`), `contracts:deploy:testnet` (env-only keys), `test:contracts:integration`
- `db:dev` (throwaway PostgreSQL), `tools:s3` (pinned VersityGW), `test:auth:db`
- `test:protocol:browser`, `test:account:browser`, `test:vault:browser`, `test:review:browser` (Chromium, virtual authenticator)
- `dev` (3000), `dev:verifier` (5173). Copy `.env.example`; variables are optional.

TypeScript stays below 6.1.

## Development Workflow

"Proceed to Chapter [N]": ingest only that chapter in `build_instructions/prompt_library/`, run its `📦 BUILD TASK #n` blocks in order as repository edits, no plans. Verify with strict TypeScript and closed `z.strictObject` schemas at every boundary (no `any`, no coercion, bigint-safe decimal strings). Run the chapter gate, record observed results in `docs/build-state.json`, mark complete only when required checks passed, then stop.

## Session resume protocol

- On session start, read `docs/build-state.json` only. Do not read other chapters' files.
- If told "proceed to chapter N" or "next chapter": confirm chapter N-1 is `complete` in build-state.json (if not, stop and say so). Then read ONLY that chapter's file at its `chapterPromptPath` and run all its tasks in order without stopping between tasks.
- If told "continue": resume `currentChapter` at its first incomplete task.
- After each task, update build-state.json (status, files changed, interfaces later chapters need).
- At chapter end, mark it complete, set `currentChapter` and `nextChapter`, and give a short summary.

## Git

- After each task: update build-state.json, then `git add -A`, commit as `ch<N> task <X>: <short summary>`, and push.
- At chapter end: commit `ch<N> complete` and push.
- Write commit messages from the task just completed. Do not run `git diff` or `git log` to write them.
- Never force-push, never commit `.env` or secrets, never rewrite history.
- If a push fails, report it and keep going. Do not retry in a loop.

## What is being built

**Proof of Review**: a person approves an exact package of AI-assisted work; anyone holding it can check that without trusting the app. **LexAegis** is the reference app (employment settlement review, England and Wales), Monad testnet 10143. Deadline `2026-10-14T04:59:00+01:00`. Authority: `project_brief/LexAegis Refined Project Brief v3.md`; visuals: `UI_UX_Instructions/`; requirements: `docs/assistant-ui-contract.md`. Run order: 1–3, 14, 4, 5, 6, 8, 9, 7, 10, 11, 15–18, 12, 19, 13.

## Boundaries

- `packages/protocol` (`/v1` wire protocol), `sdk` (no hashing), `vault` (Web Crypto only, `/v1` frozen), `agent` (server-only).
- `apps/web`: UI imports `@/features/account/public` and `@/features/vault/public` only; server code never imports them, Mera or `@scure/bip32`. `src/test-support` is test-only.
- `apps/verifier`: standalone. `contracts`, `tooling`, `fixtures/*` generators never import `packages/`.

## Invariants

- v1 is frozen: schema IDs, commitment construction, EIP-712 domain, registry ABI, account profile `lexaegis.evm.bip32-prf.v1`, vault profile `lexaegis.vault.hkdf-sha256.aes-256-gcm.v1`. Never regenerate vectors to pass a test.
- Only `ReceiptReferenceV1` is public; manifests, hashes, labels, nonces are private.
- Signing consumes a `PreparedReviewPackage`; never rebuild it or its nonce.
- Saved, signed, confirmed, indexed and active differ; there is no `valid=true`. RPC failure is `unknown`.
- No simulated success; unavailable integrations return typed failures.
- Keys, PRF outputs and sessions stay in memory. Vault unlock is not a signing session.
- Model proposes, code decides: no model, chat or voice input approves, signs or confirms.
- A frozen package is ready only through a `RecoverableCapture` rebuilt by retrieval and verification in this unlock.
- Money is GBP minor units as decimal strings.
- Evidence classes stay separate; only real_device/live_testnet pass live gates; gates are computed. Failed Gate B withdraws the Mera bounty claims.
