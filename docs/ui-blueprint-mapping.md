# UI blueprint: repository mapping

Stage 1 of `UI_UX_Instructions/UI_UX_BLUEPRINT.md`. Visual presentation only. Protocol, crypto, approval and signing logic are not touched. Visual notes: `docs/ui-reference-notes.md`.

## Existing owners (kept)

| Concern | Owner |
| --- | --- |
| Providers, layout | `app/layout.tsx` wraps `AppShell` in account, review, history, decision, package, approval, transaction and assistant providers |
| Shell | `components/shell/AppShell` (ceiling `SystemStrip`, `NavBar`, `<main>`, `CommandDock`, drawers) |
| View state | `components/shell/workspace-context` (`mode`, `mobileTab`, `draft`, drawers, `selection`) |
| Stop | `components/shell/stop-context` over `features/workspace/stop` |
| Commands | `CommandDock` (`SLASH_COMMANDS`), `features/assistant/controller`, `command-input.decideEnter` |
| Orb state | `components/assistant/orb-state.deriveOrb`, `AssistantOrb` (CSS/SVG) |
| Matter, evidence, findings | `MatterRail` (inside `review/ReviewWorkspace`), `review/EvidenceChecklist`, `review/FindingsPanel`, `review/DocumentWorkspace` |
| Review package, approval | `review/PackagePanel`, `ReviewActionPreview`, `approval-context`, `features/review` |
| Account, Mera session | `features/account/public` (`AccountSnapshot`: `account.address`, `signing.expiresAt`, `backend.*`) |
| Vault | `components/vault/vault-context`, `vault/status.vaultStatusLabel` |
| Transaction | `components/chain/transaction-context` (`TransactionState.stage`), `chain/status.STAGE_LABEL`, `features/transactions` |
| Indexer | `history/history-context.health`, `features/history/public.indexerLabel` |
| Event schema | `features/assistant` run events (run, matter, version, snapshot, per-run `seq`) |
| Tokens | `app/globals.css` `--lj-*`, asserted by `app/tokens.test.ts` |
| Browser journey | `tooling/scripts/hud-browser-check.ts` (`pnpm test:hud:browser`) |

## New code (follows the repo split: pure logic in `features/*` with a `public.ts`, React in `components/*`)

| Blueprint module | Path |
| --- | --- |
| `hud.selectors.ts`, `hud.effects.ts`, `neural.renderer.ts`, `useHudAnchors` logic | `src/features/hud/` (pure, no React, `public.ts` only import path) |
| `HudShell`, `SystemCeiling`, `MatterRail`, `AttentionRail`, `CommandPalette`, `NeuralCanvas`, `useHudAnchors` | `src/components/hud/` |
| `CommandDock` | stays `components/shell/CommandDock`, restyled |
| `hud.tokens.css` | `src/components/hud/hud.tokens.css`, imported by `globals.css` |
| Tests | beside each module (`*.test.ts`, repo convention) rather than `__tests__/` |

## Boundaries kept

- Canvas renderer imports no controller, fetch or document code; it receives a visual view model and measured rects.
- `features/hud` imports no account, vault, approval, transaction controller or Mera code; selectors take plain snapshots.
- No command can approve or sign: the registry keeps the existing allowlist and the router's refusal of approve/sign phrases.
- `verify-embed` and `apps/verifier` are unchanged.

## Known gaps to close, by stage

- Ceiling "Transaction" is hardcoded `None` today (stage 3 wires `TransactionState`).
- Palette tokens differ from the blueprint (`--lj-bg` is `#060b14`, not `#000000`); stage 2 aligns them and updates `tokens.test.ts`.
- Panels are bordered `.lj-card`-style; blueprint requires transparent, hairline-separated regions.
- No `Ctrl/Cmd+K` palette, Effects control, canvas, anchors or receipt effect exist yet.
