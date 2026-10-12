# Integration trials

What happened when the install paths in [`QUICKSTART.md`](./QUICKSTART.md) were followed from a fresh
directory. Every trial below is an **internal trial**: it was run by the project team or the coding
agent, on the author's machine, from an offline package store, with a script following the guide. A
fresh directory does not make an internal trial external. Automated runner durations are **not** a
human's time to understand the guide, and no human reading time is claimed.

Nothing here is published: the packages are local tarballs (`pnpm pack`); there is no registry release
and no hosted widget script.

## External trials

**No external trials recorded yet.**

Use the [template](#external-trial-template) below once a real participant, with their permission,
supplies evidence. The same trial run again in another directory by the team is not an external trial.

## Internal trial 1: the guide, verbatim (paths 1, 2, 3 and 4)

| Item           | Value                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date           | 2026-10-12                                                                                                                                                                                  |
| Performed by   | Coding agent (internal), via `pnpm quickstart:check`, which extracts and runs the guide's fenced blocks in one shell                                                                        |
| Source         | Commit `185a5c3` with a **dirty** working tree (the Chapter 18 changes in progress); recorded in the evidence file                                                                          |
| Environment    | linux 7.0.0-38-generic x64, Node v24.21.0, pnpm 11.11.0, Vite 8.3.4, headless Chromium (Playwright), offline pnpm store; Foundry 1.8.5 for Anvil                                            |
| Evidence       | [`evidence/chapter18-quickstart-trial1-2026-10-12.json`](./evidence/chapter18-quickstart-trial1-2026-10-12.json) (a copy of the check's own output)                                         |
| Outcome        | **Pass**, 13 of 13 checks                                                                                                                                                                   |
| Tarballs       | cli `599cabd5…32ecb` (21356 B), protocol `53058f8a…cea34` (72014 B), sdk `e970c2ce…57b2b` (85117 B), verify-embed `d44c2c60…2f08d` (170064 B); full SHA-256 values are in the evidence file |
| Installed from | Only those tarballs. The check proves every `@lexaegis` package resolves inside the consumer directory, and the consumer has no `tsconfig.json`, path alias or repository source            |

Measured runner durations from that evidence file (automated, kept separate; milliseconds):

| Phase                                                                                           | Duration           |
| ----------------------------------------------------------------------------------------------- | ------------------ |
| Package preparation and installation (build, pack four tarballs, install, copy the sample)      | 10880              |
| Path 1 SDK verification, local (first successful verification)                                  | 409                |
| Path 2 CLI text and JSON verification, local (first successful verification)                    | 946                |
| Path 3 lifecycle on a local chain (includes the Foundry build)                                  | 8027               |
| Path 4 widget: harness start, page, status-only and Check files (first successful verification) | 6524               |
| Manual or live steps                                                                            | 0 (none performed) |
| Wall clock of the whole check                                                                   | 27715              |

Paths 1 and 2 together took 1355 ms of local execution. An earlier run of the same check, made before
the tarball hashes were recorded, took path 1 389 ms, path 2 1528 ms, path 3 7370 ms and path 4 6638 ms:
the figures vary between runs, so treat them as one machine's order of magnitude only.

### Problems and gaps found

No command in the guide failed on this first run. Reading the guide as a newcomer would, the following
were found. They are **assumptions, guesses and limitations**, not observed failures, except where
stated.

1. **Path 4 assumed path 3 had run.** It starts a local chain but never installed the Foundry toolchain;
   a reader who skips path 3 would fail at `anvil`. _Found by review, not observed (the toolchain was
   already installed here)._
2. **A fixed `sleep 1` waited for the page server.** A guess: slow machines could race it. _Found by
   review, not observed._
3. **A fixed `sleep 2` waited for the harness to stop.** Same kind of guess.
4. **Path 4 needs the repository checkout**, not just the installed packages: the local chain
   (`pnpm embed:harness`) and the headless browser driver (`pnpm embed:check-page`) live in the
   repository. The consumer directory itself uses only the tarball's module. This limitation is stated
   in the guide.
5. **The browser step is scripted.** A person opens the page; the check presses **Check files** with
   headless Chromium. It shows what the widget does, not how long a person needs to follow the guide.
6. **Offline store.** Installation time (about 11 s here) excludes downloading third-party packages.
7. **Internal and authored.** The sample packages come from the team's own example; this is no evidence
   about anyone else's documents or workflow.

### Corrections, and the repeated trial

Documentation was corrected first. No code defect was found.

- Path 4 now starts with `pnpm contracts:toolchain` (item 1) and the prerequisites table lists Foundry
  for paths 3 and 4.
- The page-server wait is a loop that polls the server; the harness wait is `wait "$HARNESS_PID"`
  (items 2 and 3).

The affected path (path 4) was rerun from a fresh consumer; the unaffected paths ran again as part of the
same check because the guide runs in one shell. The initial result is kept above and in
`chapter18-quickstart-trial1-2026-10-12.json`.

## Internal trial 2: the corrected guide

| Item         | Value                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Date         | 2026-10-12                                                                                                       |
| Performed by | Coding agent (internal), `pnpm quickstart:check`                                                                 |
| Source       | Commit `185a5c3`, dirty working tree (same source code; the guide corrections above)                             |
| Evidence     | [`evidence/chapter18-quickstart-trial2-2026-10-12.json`](./evidence/chapter18-quickstart-trial2-2026-10-12.json) |
| Outcome      | **Pass**, 13 of 13 checks. Tarball SHA-256 values are identical to trial 1 (the packaging is reproducible)       |

| Phase                                          | Duration (ms) |
| ---------------------------------------------- | ------------- |
| Preparation and installation                   | 11776         |
| Local execution of paths 1 and 2               | 1288          |
| Path 3, local chain                            | 7293          |
| Path 4, widget (first successful verification) | 4876          |
| Manual or live steps                           | 0             |
| Wall clock of the whole check                  | 25638         |

## Internal trial 3: the second-domain example from its documented setup

The AI-assisted pull request sign-off example ([`examples/ai-pr-signoff`](../examples/ai-pr-signoff/README.md))
is a workspace example, so its "clean setup" is a repository checkout with `pnpm install`; it is not
installed from a tarball.

| Item         | Value                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date         | 2026-10-12                                                                                                                                                                                                                                                      |
| Performed by | Coding agent (internal), following the README's commands with a fresh storage key and temporary evidence directory                                                                                                                                              |
| Commands     | `signoff keygen`, `prepare` (fixtures, Monad Testnet deployment record as policy), `export --full-disclosure`, `verify` (offline), all from `examples/ai-pr-signoff`                                                                                            |
| Outcome      | Pass: the package was prepared and preserved encrypted (4 sealed objects and one record in a fresh directory), exported, and verified offline as `manifestIntegrity: match`, `artifactIntegrity: match`, `chainStatus: unknown`, `referenceOrigin: independent` |
| Durations    | keygen 834 ms, prepare 820 ms, export 789 ms, verify 748 ms (each includes starting `tsx`; automated)                                                                                                                                                           |
| Not done     | The public issue. **NOT YET**: it needs a dedicated funded testnet operator key, a public endpoint and a person at a terminal. The local issue flow is covered by `contracts/integration/ai-pr-signoff.anvil.test.ts` (local evidence)                          |

Problems found: the README's first draft said the registry policy was in `docs/DEPLOYMENTS.md`; it is not
(only the deployment facts are). The README now points at `packages/cli/src/known-deployments.generated.ts`
and `pnpm verifier:policy`. A user must also create `policy.json` themselves; there is no command that
writes it.

## What these trials do not show

- Nobody outside the project followed any of this.
- No live Monad Testnet widget page, no hosted script and no published package exists.
- The widget's lifecycle states, network boundary and package-integrity cases are covered by the real
  Chromium tests described in [`packages/verify-embed/README.md`](../packages/verify-embed/README.md),
  against a throwaway local chain.

## External trial template

Copy this block for each real external participant, with their written permission. Do not record names or
contact details in this public file unless they have agreed to be named; use an anonymous identifier.

```text
Participant identifier: (anonymous ID, e.g. EXT-001)
Permission: (what they agreed to: trial recorded, attribution, quotes; date given)
Date of trial:
Environment: (OS, Node, pnpm, browser; local or their own project)
Path attempted: (SDK / CLI / widget / example)
Time to first successful verification: (stopwatch, started when they opened the guide; say who timed it)
Problems met: (each, in their words where consented)
Assistance received: (none, or exactly what the team said or did)
Outcome: (verified / partially / abandoned) and why
Evidence link: (note or screenshot reference in docs/adoption/, per the traction-log rules)
```
