# UI blueprint: repository mapping

Stage 1 of `UI_UX_Instructions/UI_UX_BLUEPRINT.md`. Visual presentation only. Protocol, crypto, approval and signing logic are not touched. Visual notes: `docs/ui-reference-notes.md`.

## Existing owners (kept)

| Concern                    | Owner                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Providers, layout          | `app/layout.tsx` wraps `AppShell` in account, review, history, decision, package, approval, transaction and assistant providers |
| Shell                      | `components/shell/AppShell` (ceiling `SystemStrip`, `NavBar`, `<main>`, `CommandDock`, drawers)                                 |
| View state                 | `components/shell/workspace-context` (`mode`, `mobileTab`, `draft`, drawers, `selection`)                                       |
| Stop                       | `components/shell/stop-context` over `features/workspace/stop`                                                                  |
| Commands                   | `CommandDock` (`SLASH_COMMANDS`), `features/assistant/controller`, `command-input.decideEnter`                                  |
| Orb state                  | `components/assistant/orb-state.deriveOrb`, `AssistantOrb` (CSS/SVG)                                                            |
| Matter, evidence, findings | `MatterRail` (inside `review/ReviewWorkspace`), `review/EvidenceChecklist`, `review/FindingsPanel`, `review/DocumentWorkspace`  |
| Review package, approval   | `review/PackagePanel`, `ReviewActionPreview`, `approval-context`, `features/review`                                             |
| Account, Mera session      | `features/account/public` (`AccountSnapshot`: `account.address`, `signing.expiresAt`, `backend.*`)                              |
| Vault                      | `components/vault/vault-context`, `vault/status.vaultStatusLabel`                                                               |
| Transaction                | `components/chain/transaction-context` (`TransactionState.stage`), `chain/status.STAGE_LABEL`, `features/transactions`          |
| Indexer                    | `history/history-context.health`, `features/history/public.indexerLabel`                                                        |
| Event schema               | `features/assistant` run events (run, matter, version, snapshot, per-run `seq`)                                                 |
| Tokens                     | `app/globals.css` `--lj-*`, asserted by `app/tokens.test.ts`                                                                    |
| Browser journey            | `tooling/scripts/hud-browser-check.ts` (`pnpm test:hud:browser`)                                                                |

## New code (built; follows the repo split: pure logic in `features/*` with a `public.ts`, React in `components/*`)

| Blueprint module                                                                                                   | Path                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `hud.selectors.ts` (readings, activity, attention, notices), `hud.finding.ts`, `hud.freshness.ts`, `hud.events.ts` | `src/features/hud/` (pure, no React)                                                                           |
| `hud.effects.ts` (effects policy, receipt gate, wash envelope), `hud.commands.ts`, `hud.fixtures.ts`               | `src/features/hud/`                                                                                            |
| `neural.renderer.ts`, `neural.geometry.ts`                                                                         | `src/features/hud/` (Canvas 2D only; no controller, fetch or DOM queries)                                      |
| `confirmation.ts`, `TransactionController.onConfirmation`                                                          | `src/features/transactions/` (the only source of a confirmation signal)                                        |
| `HudShell`, `SystemCeiling`, `MatterRail`, `AttentionRail`, `SelectedFinding`, `StateNotices`, `EffectsControl`    | `src/components/hud/`                                                                                          |
| `CommandPalette`, `use-command-dispatch`, `ApprovalCeremony`, `ceremony.ts`                                        | `src/components/hud/`                                                                                          |
| `NeuralCanvas`, `useHudAnchors`, `hud-context` (`HudProvider`), `effects-preference`, `layout-tier`                | `src/components/hud/`                                                                                          |
| `CommandDock`                                                                                                      | `src/components/shell/CommandDock.tsx`, restyled, shares the registry                                          |
| `hud.tokens.css`                                                                                                   | `src/components/hud/hud.tokens.css`, imported by `app/globals.css`; colour tokens stay in `globals.css`        |
| Tests                                                                                                              | beside each module (`*.test.ts`, repo convention) rather than `__tests__/`                                     |
| Synthetic fixtures                                                                                                 | `/hud-fixtures?state=...` (`app/hud-fixtures`, `HudFixtureStage`): 404 unless `HUD_FIXTURES=1` at server start |

## Verification scripts

`tooling/scripts/hud-visual-check.ts` (layout, keyboard focus), `hud-command-check.ts` (palette, dock, Stop), `hud-canvas-check.ts` (tiers, lifecycle, contrast, fixtures), `hud-receipt-check.ts` (confirmation effect). They run against `next dev` with `HUD_FIXTURES=1`. The existing journeys `pnpm test:hud:browser` and `pnpm test:assistant:browser` run on the production build.

## Boundaries kept

- The renderer imports no controller, fetch or document code; it receives a visual scene and measured rectangles.
- `features/hud` imports no account, vault, approval, transaction controller or Mera code; selectors take plain snapshots.
- No command can approve or sign: the registry is the assistant router's allowlist plus `/stop`, and approval wording is refused.
- `verify-embed` and `apps/verifier` are unchanged. No protocol, crypto, signing or approval logic changed.
- The transaction controller gained an observation emitter only (`onConfirmation`); its signing, sending and quoting paths are untouched.
