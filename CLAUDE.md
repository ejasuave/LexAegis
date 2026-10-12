# CLAUDE.md

## Commands

Status: `docs/build-state.json`. Node 24+, pnpm 11.

- `install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`
- Gates: `*:check` scripts, `state:validate`, `readiness`
- `validate:mvp`: bounded local gate, writes `docs/system-validation/report.json` (`--check`). `validate:live`: device and read-only live evidence; paid runs need `--spend-tokens`.

## Workflow

- Start: read only `docs/build-state.json` (`jq`).
- "Proceed to chapter N": the previous chapter in run order must be `complete`, else stop and say. Read only its `chapterPromptPath` file; run its `📦 BUILD TASK #n` blocks in order, no plans, no stops. "Continue": resume `currentChapter` at its first incomplete task.
- Strict TypeScript; closed `z.strictObject` boundaries; no `any`, coercion, non-string bigints.
- After each task update build-state.json (status, files, interfaces). Chapter end: run the gate, record observed results, mark complete only if required checks passed, set `currentChapter`/`nextChapter`, stop.
- Git per task: `git add -A`, commit `ch<N> task <X>: <summary>`, push; chapter end `ch<N> complete`. No force-push, history rewrite or secret commits. Push failure: report.

## What is being built

**Proof of Review**: a person approves an exact package of AI-assisted work; anyone can verify it. **LexAegis**: employment settlement review (England and Wales), Monad testnet 10143, deadline `2026-10-14T04:59+01:00`. Authority `project_brief/`; visuals `UI_UX_Instructions/`; requirements `docs/assistant-ui-contract.md`. Run order: 1–3, 14, 4–6, 8, 9, 7, 10, 11, 15–18, 12, 19, 13.

## Boundaries

- `protocol` (`/v1`), `sdk` (no hashing), `vault` (Web Crypto only, `/v1` frozen), `cli` (read-only), `agent` (server-only).
- Web UI imports only `@/features/*/public`; server code never imports them, Mera or `@scure/bip32`. Test-only: `src/test-support`, `agent/testing`.
- `verify-embed`: browser only, host-config trust. `examples/ai-pr-signoff`: typed terminal confirmations. `apps/verifier` is standalone; `contracts`, `tooling`, `fixtures/*` never import `packages/`.

## Invariants

- v1 is frozen: schema IDs, commitments, EIP-712 domain, registry ABI, profiles `lexaegis.evm.bip32-prf.v1`, `lexaegis.vault.hkdf-sha256.aes-256-gcm.v1`. Never regenerate vectors to pass tests.
- Only `ReceiptReferenceV1` is public; manifests, hashes, labels, nonces are private.
- Saved, signed, confirmed, indexed, active differ; no `valid=true`; RPC failure: `unknown`. No simulated success; unavailable integrations are typed failures.
- Keys, PRF outputs, sessions stay in memory. Vault unlock is no signing session.
- Model proposes, code decides: no model, chat or voice input approves, signs or confirms. A frozen package is ready only via a `RecoverableCapture` rebuilt this unlock; signing consumes it. Approval is a trusted click; technical failures cannot be waived.
- Money: GBP minor units, decimal strings. ERC-8004 identity: optional, in hashed `agent-config` v2, read-only.
- Live gates accept only real_device/live_testnet evidence, C1 only `live_provider`; gates are computed. Failed Gate B withdraws Mera bounty claims.
- Adoption counts only from `docs/adoption/traction-log.md`; keep `No external trials recorded yet`, `No entries yet` until real evidence. Widget/example results local; testnet issue NOT YET.
- Registry code matched source 2026-10-11 (`docs/DEPLOYMENTS.md`), unaudited. Monadscan, private contact: NOT YET. `contracts/foundry.toml` protected: use `FOUNDRY_*`.
