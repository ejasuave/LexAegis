# CLAUDE.md

## Commands

Status: `docs/build-state.json` (5 real-device recovery, 6 testnet credentials, 9 live Qwen run). Node 24+, pnpm 11.

- `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`
- Gates: `fixtures:check`, `baselines:check`, `exclusion:check`, `secrets:check`, `packages:check`, `spec:check`, `vectors:check`, `docs:check`, `state:validate`, `readiness`
- Security: `contracts:test:ci`, `contracts:static`, `verify:deployment`, `threat:check`, `test:privacy:browser`, `test:privacy:controls` (`SECURITY.md`).
- Adoption kit: `quickstart:check` (runs docs/QUICKSTART.md, paths 1 to 4), `embed:example`, `embed:harness`, `embed:check-page`, `traction:summary`; local Anvil tests: `test:contracts:integration`.
- Others: see `package.json`. TypeScript below 6.1.

## Workflow

- Session start: read `docs/build-state.json` only.
- "Proceed to chapter N" / "next chapter": chapter N-1 must be `complete` (else stop and say). Read only its file at `chapterPromptPath`; run its `📦 BUILD TASK #n` blocks in order, no plans, without stopping between tasks. "Continue": resume `currentChapter` at its first incomplete task.
- Strict TypeScript; closed `z.strictObject` boundary schemas; no `any`, coercion or non-string bigints.
- After each task update build-state.json (status, files, interfaces later chapters need). At chapter end run the gate, record observed results, mark complete only if required checks passed, set `currentChapter`/`nextChapter`, summarise, stop.

## Git

- After each task: `git add -A`, commit `ch<N> task <X>: <summary>`, push. Chapter end: `ch<N> complete`. Messages come from the task; no `git diff`/`git log`.
- Never force-push, commit `.env`/secrets, or rewrite history. If a push fails, report and continue.

## What is being built

**Proof of Review**: a person approves an exact package of AI-assisted work; anyone can verify it without trusting the app. **LexAegis**: employment settlement review (England and Wales), Monad testnet 10143, deadline `2026-10-14T04:59+01:00`. Authority: `project_brief/`; visuals: `UI_UX_Instructions/`; requirements: `docs/assistant-ui-contract.md`. Run order: 1–3, 14, 4–6, 8, 9, 7, 10, 11, 15–18, 12, 19, 13.

## Boundaries

- `protocol` (`/v1`), `sdk` (no hashing), `vault` (Web Crypto only, `/v1` frozen), `cli` (read-only), `agent` (server-only).
- Web UI imports only `@/features/*/public`; server code never imports them, Mera or `@scure/bip32`. Test-only: `src/test-support`, `@lexaegis/agent/testing`.
- `verify-embed` (browser only, no wallet/backend/app imports; trust only from host config). `examples/ai-pr-signoff` is generic-profile, issue only via typed terminal confirmations.
- `apps/verifier` is standalone; `contracts`, `tooling`, `fixtures/*` never import `packages/`.

## Invariants

- v1 is frozen: schema IDs, commitment construction, EIP-712 domain, registry ABI, profiles `lexaegis.evm.bip32-prf.v1` and `lexaegis.vault.hkdf-sha256.aes-256-gcm.v1`. Never regenerate vectors to pass tests.
- Only `ReceiptReferenceV1` is public; manifests, hashes, labels, nonces are private.
- Saved, signed, confirmed, indexed, active differ; no `valid=true`; RPC failure: `unknown`.
- No simulated success; unavailable integrations are typed failures.
- Keys, PRF outputs, sessions stay in memory. Vault unlock is not a signing session.
- Model proposes, code decides: no model, chat or voice input approves, signs or confirms.
- A frozen package is ready only via a `RecoverableCapture` rebuilt by retrieval and verification in this unlock; signing consumes it, never a rebuild. Approval is a trusted click; technical failures are unwaivable.
- Money is GBP minor units as decimal strings.
- ERC-8004 identity: optional, inside hashed `agent-config` v2; never a manifest field; read-only.
- Only real_device/live_testnet evidence passes live gates; gates are computed. Failed Gate B withdraws Mera bounty claims.
- Adoption counts come only from `docs/adoption/traction-log.md` (evidence-reviewed external rows; internal trials never count). Keep `No external trials recorded yet` and `No entries yet` until real evidence exists. Widget/example results are local (Anvil); testnet issue NOT YET.
- Registry code matched source 2026-10-11 (`docs/DEPLOYMENTS.md`); unaudited. Monadscan and a private reporting contact: NOT YET. `contracts/foundry.toml` is protected: campaign sizes via `FOUNDRY_*` only.
