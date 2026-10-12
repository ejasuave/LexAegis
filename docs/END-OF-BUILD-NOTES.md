# End-of-build notes: what to fix, and finishing Chapter 14

Written 2026-10-12, after Chapter 18 and before Chapter 12. Run order is 12, 19, 13; do the items below
**after Chapter 13**, when every owning chapter has landed. Nothing here is a claim that it is done.
Source of truth for status stays `docs/build-state.json`; gates are computed by `pnpm readiness`.

## A. Chapter 14 (state: `in-progress`, phase "early")

Chapter 14 was built early with stubs; it is **not verified**. Finish it once its dependencies exist:

| Pending dependency                                                                                    | Needed for                                     |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Chapter 4: real signer interface, PRF through application code, Gate B                                | `real-signature-approval` feature, smoke steps |
| Chapter 5: vault and encrypted save for the freeze step                                               | `freeze-and-verified-save` feature             |
| Chapters 8 to 11: document intake, Qwen runtime, HUD flag wiring beyond the command dock, verifier UI | T0 browser journey (`smoke:local`, Gate C)     |
| Chapter 6: funded deployment, Alchemy transport, Gate A deployment evidence                           | `smoke:testnet`, Gate A/B                      |
| Chapter 19: health route fields and indexer lag                                                       | live readiness probes                          |
| Chapters 15 to 18: Gate D deliverables                                                                | Gate D                                         |

To close Chapter 14:

1. Re-run `pnpm smoke:local` with real browser drivers registered (the driver map in
   `tooling/scripts/smoke-local.ts` is still empty), then the manual `pnpm smoke:testnet` journey.
2. Run the cut-ladder matrix (14.5, task 10) against the finished features.
3. Flip each `FEATURE_READINESS` constant only together with a current passing result (rule in the
   chapter 14 decisions); update `docs/scope-tiers.md`.
4. Re-run `pnpm readiness`; set `chapters[14].state` to `complete` only if required checks pass.

## B. Failures and open gaps seen at the end of Chapter 18

| Item                                                                                                                                                                                                                                                 | Where it shows                                                | Fix                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm secrets:check` fails: 2 findings (`KEY_ASSIGNMENT`, `PROVIDER_KEY_URL`) in the **git-ignored local `.env`** (dated 2026-10-11). Makes the `secret-scan` readiness check fail. Carried forward since Chapter 11.                                | `pnpm secrets:check`, `docs/readiness-report.md`              | Decide whether the scanner should skip git-ignored files (it already skips `.private/` and build output) or move the values elsewhere. Do not commit `.env`.                   |
| Gate A fails: "Registry deployed on Monad testnet (observed receipt, matching identity)" missing, `UNPROVEN_AT_CUTOFF`. The registry **is** deployed (`docs/DEPLOYMENTS.md`), but no recorded result satisfies this requirement.                     | `docs/readiness-report.md`                                    | Record the deployment observation as a result the gate accepts (live_testnet class, matching identity); do not edit gates by hand.                                             |
| Gate B fails: no real Mera account signature, no Alchemy-confirmed registry transaction, no verifier read of the resulting state. Failed Gate B withdraws Mera bounty claims.                                                                        | readiness report; Chapters 4, 5, 6                            | Needs a real-device passkey run (open item 5), a funded testnet signer (item 6) and an issued, confirmed receipt. No Active receipt exists on testnet among recorded examples. |
| Gate C fails: no genuine Qwen run (item 9), no complete T0 browser journey.                                                                                                                                                                          | readiness report                                              | Run the live Qwen smoke (`pnpm qwen:smoke`) and the T0 journey.                                                                                                                |
| Gate D fails: feature freeze, verifier, SDK, CLI, judge path, anonymously accessible deployment all "NOT YET". The SDK, CLI and verifier work locally; nothing is hosted and the repository is private.                                              | readiness report                                              | Decide on hosting and visibility; record the feature freeze.                                                                                                                   |
| Monadscan source verification, deployment source commit note, CI security jobs observed on GitHub, private security-reporting contact: all NOT YET.                                                                                                  | `SECURITY.md`, `docs/DEPLOYMENTS.md`                          | See `docs/adoption/ROADMAP.md` step 1.1.                                                                                                                                       |
| Operator-run Monad Testnet issue for `examples/ai-pr-signoff` and any live widget page: NOT YET.                                                                                                                                                     | `docs/integration-trials.md`                                  | Needs a dedicated funded synthetic operator key; see the example README.                                                                                                       |
| `pnpm test:contracts:integration` leaves generated indexer types on chain 31337, and the indexer rollback test writes a dated evidence file.                                                                                                         | known quirk                                                   | Run `pnpm indexer:codegen` before `pnpm typecheck` afterwards; delete the stray dated evidence file unless it is wanted.                                                       |
| The verifier fetches its worker script on first use, so going fully offline before the first check stops it from running (finding F-005, `docs/system-validation/findings.json`). After one check while online it works offline from the HTTP cache. | `tests/system/verifier-independence.spec.ts`; `apps/verifier` | Decide: fetch or inline the worker at load, say what the page shows when it cannot start, and set cache headers when hosting is chosen.                                        |
| `pnpm test:verifier:browser` rewrites the Chapter 10 and 11 screenshots in `docs/evidence/` and writes a new dated live-check file on every run. The tracked screenshots were re-captured during Chapter 12 task 11 and left uncommitted.            | `git status` after Chapter 12                                 | Run `git checkout -- docs/evidence/chapter10 docs/evidence/chapter11` unless the new captures are wanted.                                                                      |
| Chapter 12 and Chapter 13 validation (cited output, cancellation, isolation, approval binding, injection, accessibility) and the real-transaction demo.                                                                                              | `docs/assistant-ui-contract.md` "Requirements still open"     | Chapter 12 is next; Chapter 13 after Chapter 19.                                                                                                                               |

## C. Honest states to keep until real evidence exists

`No external trials recorded yet` (docs/integration-trials.md), `No entries yet` (docs/adoption/traction-log.md),
testnet issue NOT YET, nothing published, repository private.
