# Registry invariant and authorisation campaigns

What the stateful and fuzz tests of `ProofOfReviewRegistry` assert, how hard they were run, and what
was observed. These are **local Foundry tests with synthetic keys** against the unchanged registry
source. They are not live-chain evidence, not an audit and not a proof: a campaign that finds nothing
shows that nothing was found in the sequences it generated.

## Source and toolchain

|                 |                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source state    | commit `458d3c5` (`458d3c54bb70000ad2c2563bb37bf91e68349e97`), clean worktree, content fingerprint `56c595e9e84bb9de…`                                                                                                                |
| Contract inputs | sha256 `2001781f576486f5…` over 15 files: `contracts/src`, `contracts/test`, `contracts/foundry.toml`, `contracts/toolchain.json`                                                                                                     |
| Registry source | `contracts/src/ProofOfReviewRegistry.sol` sha256 `6c007cfec0430392…`, `ReviewAuthorization.sol` `c6efe055226de236…`, `interfaces/IProofOfReviewRegistry.sol` `249c3a0dfdfe2bf5…`: the protected baselines (`pnpm baselines:check`)    |
| Toolchain       | Foundry 1.8.5 (`51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f`), solc 0.8.37, EVM `osaka`, Node v24.21.0                                                                                                                                   |
| Build settings  | Unchanged by the campaign: optimizer on, 200 runs, `via_ir = false`, `bytecode_hash = "none"`, `cbor_metadata = true`, `use_literal_content = true`. The runner compares 20 bytecode-affecting settings with and without the profile. |
| Consulted       | <https://getfoundry.sh/forge/invariant-testing> and `forge config --json` of the pinned version (`fuzz.runs`, `fuzz.seed`, `invariant.runs`, `invariant.depth`, `invariant.fail_on_revert`, `--invariant-workers`), read 2026-10-11   |

## The security profile is test-only

`contracts/foundry.toml` is a protected baseline, so the campaign is **not** a new Foundry profile in
that file. `pnpm contracts:campaign` (`tooling/scripts/security-campaign.ts`) supplies the sizes as
`FOUNDRY_FUZZ_RUNS`, `FOUNDRY_FUZZ_SEED`, `FOUNDRY_INVARIANT_RUNS`, `FOUNDRY_INVARIANT_DEPTH` and
`FOUNDRY_INVARIANT_WORKERS=1` environment overrides, reads the effective configuration back from
`forge config --json`, and refuses to run if any bytecode-affecting setting differs from the
baseline (`BUILD_SETTING_CHANGED`).

| Profile           | Fuzz cases per property | Invariant runs × depth | Process limit | Recorded as              |
| ----------------- | ----------------------- | ---------------------- | ------------- | ------------------------ |
| default (`forge`) | 256                     | 64 × 64                | none          | `pnpm contracts:test`    |
| `ci`              | 1,000                   | 256 × 128              | 45 minutes    | `contract-campaign-ci`   |
| `full`            | 10,000                  | 1,000 × 256            | 240 minutes   | `contract-campaign-full` |

A `ci` run is never recorded as the full campaign. No Foundry per-test timeout is set
(`fuzz.timeout` and `invariant.timeout` are null), so a run is never cut short and counted: the
runner checks the **effective counts in the output**, not the exit code alone. An output without the
eleven required suites, a fuzz property with fewer cases than the profile, a campaign with fewer
runs or calls, a missing handler operation or any revert under `fail_on_revert = true` makes the
outcome `fail`.

## What is asserted

Stateful model (`contracts/test/handlers/ReviewRegistryHandler.sol`): four synthetic EOA reviewers,
one locally deployed ERC-1271 reviewer whose owner is rotated, three distinct executors, and a shared
pool of 24 commitment values offered to every reviewer, so identical bytes occur under different
reviewers. Valid `ISSUE`, `REVOKE` and `SUPERSEDE` actions go through `execute` with EIP-712
signatures over the local registry and chain; `invalidateNonce` is called by the reviewer itself.
Expected answers come from an independent ghost model that is updated only after a call returned,
never from registry reads.

`contracts/test/RegistryInvariants.t.sol`, `RegistryInvariantsTest`, checked after every call:

| Invariant                                            | Properties                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invariant_everyNamespaceEqualsTheModel`             | Every (reviewer, commitment) pair equals the model field by field; a terminal receipt never returns to Active or NotFound; an issuance is never erased; each commitment is issued at most once per reviewer; one reviewer's operation never changes another's records, even for identical bytes |
| `invariant_noncesAreExactlyAccountedFor`             | Each nonce equals successful `execute` calls plus successful invalidations; it never decreases; a failed action leaves it unchanged; the zero address stays at 0                                                                                                                                |
| `invariant_supersessionLinksAgreeAndChainsTerminate` | Predecessor and successor agree within one namespace; a superseded receipt has exactly one successor created in the same second; chains do not cycle or reuse an issued commitment                                                                                                              |
| `invariant_everyRejectionHadItsModelledReason`       | Every refusal had the reason the model expected; an unmodelled refusal is counted and asserted to be zero                                                                                                                                                                                       |

The exactly-one-Active condition is asserted only **immediately after** a supersession, never for
ever and never per reviewer: a later revocation or supersession may leave neither member Active.
`contracts/test/Invariants.t.sol` (the Chapter 3 suite, unchanged) keeps its six invariants.

`RegistryTransitionsTest` (7 tests) covers issue → supersede → revoke the replacement, issue →
supersede → supersede again, several Active receipts at once, `ReceiptIssued` before
`ReceiptSuperseded` with one consumed nonce, a reverted supersession committing no state and no log,
two signed actions racing for one nonce with exactly one winner, and identical bytes under two
reviewers evolving independently. `RegistryInvariantControlsTest` (5 tests) shows that each check
reports the fault it exists for; those tests use a storage cheatcode **outside** any campaign.

`contracts/test/Authorization.t.sol`:

- `AuthorizationTest` (the Chapter 3 tests, one of them a fuzz property): domain, wrong signer, chain, registry and domain, exact
  deadline, zero deadline, replay, nonce isolation, invalidation, ERC-1271 owned, wrong-magic,
  reverting, malformed and re-entrant validators, policy change.
- `AuthorizationBoundaryTest` (14 tests, 9 of them fuzz properties): `deadline − 1`, `deadline` and
  `deadline + 1` for every action shape with overflow-safe generation (equality succeeds); the
  largest deadline; a zero deadline at any time; any other key for an EOA and for a contract
  account; a signature for another chain (chain context restored afterwards); replay on a **second
  local registry**; any other domain name or version; each individually altered signed field; a
  signature over another nonce; replay after issue, revoke, supersede and invalidation; an unrelated
  executor submitting an unchanged valid action first and getting exactly the authorised result;
  rollback when a valid signature reaches an invalid transition; malformed and high-s signatures for
  a contract account; a swallowed nested mutation letting the outer action succeed exactly once.
- `NonceExhaustionBoundaryTest` (2 tests): a **local boundary fixture** that places a nonce next to
  its maximum with a storage cheatcode. It is not a state the campaign generated and is not live
  evidence.

The fixed SDK/Solidity digest vectors (`contracts/test/Vectors.t.sol`, `fixtures/registry-v1`) are
unchanged and run in every profile.

## Observed: the two full campaigns

Both ran on 2026-10-11 against the source state above, at the same time on one machine, each with one
invariant worker.

|                            | Recorded seed (pinned in `foundry.toml`)                                                     | Additional distinct seed                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Seed                       | `0x4c657841656769732e50726f6f664f665265766965772e7631`                                       | `0x4c657841656769732e4368617074657231372e63616d706169676e2e32`                               |
| Started → finished (UTC)   | 15:58:34 → 17:05:13                                                                          | 15:58:34 → 17:05:20                                                                          |
| Duration                   | 3,999 s                                                                                      | 4,006 s                                                                                      |
| Suites, tests              | 11 suites, 105 of 105 passed                                                                 | 11 suites, 105 of 105 passed                                                                 |
| Fuzz                       | 15 properties × 10,000 = 150,000 cases                                                       | 15 properties × 10,000 = 150,000 cases                                                       |
| Invariant                  | 2 campaigns × 1,000 runs × depth 256 = 512,000 calls                                         | 2 campaigns × 1,000 runs × depth 256 = 512,000 calls                                         |
| Reverts (`fail_on_revert`) | 0                                                                                            | 0                                                                                            |
| Outcome                    | **pass**, no issue                                                                           | **pass**, no issue                                                                           |
| Evidence                   | [`chapter17-campaign-full-772e7631.json`](../evidence/chapter17-campaign-full-772e7631.json) | [`chapter17-campaign-full-676e2e32.json`](../evidence/chapter17-campaign-full-676e2e32.json) |

Operation coverage of `RegistryInvariantsTest` (calls per handler operation, of 256,000):

| Operation               | Recorded seed | Additional seed |
| ----------------------- | ------------- | --------------- |
| `issue`                 | 32,234        | 32,137          |
| `supersede`             | 31,986        | 31,932          |
| `revoke`                | 31,978        | 31,920          |
| `invalidate`            | 31,585        | 31,977          |
| `rejectSignature`       | 31,879        | 32,070          |
| `rejectShapeOrDeadline` | 31,783        | 31,828          |
| `rejectLifecycle`       | 32,399        | 32,123          |
| `rejectNonce`           | 32,156        | 32,013          |

These are calls to the handler. Whether a call produced a successful transition is checked inside
the suite after every run (`afterInvariant`): each run must contain a successful issue, supersede,
revoke and invalidation, every refusal class, at least three namespaces, shared bytes across
reviewers and zero unmodelled refusals. An all-reverting campaign cannot pass. The Chapter 3
campaign (`RegistryInvariantTest`) made another 256,000 calls per seed over its eight operations.

**No counterexample was found. The registry source, ABI and build settings are unchanged, and no
`requires redeploy decision` is open from these tests.**

## Routine profile

`pnpm contracts:test:ci` runs the `ci` profile with the recorded seed. It is what CI runs, and it is
recorded as `contract-campaign-ci`, never as a full campaign.

|                  |                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed         | 2026-10-11, 20:31:24 → 20:34:42 UTC, 198 s                                                                                                                                                |
| Source state     | commit `640ea65` with uncommitted Chapter 17 tooling; contract inputs `2001781f576486f5…` (the same 15 files as the full campaigns)                                                       |
| Effective counts | 15 fuzz properties × 1,000 = 15,000 cases; 2 campaigns × 256 runs × depth 128 = 65,536 calls; one invariant worker; `fail_on_revert = true`; no per-test timeout; 45-minute process limit |
| Suites, tests    | 11 suites, 105 of 105 passed, 0 reverts                                                                                                                                                   |
| Outcome          | **pass**                                                                                                                                                                                  |
| Evidence         | [`chapter17-campaign-ci-772e7631.json`](../evidence/chapter17-campaign-ci-772e7631.json)                                                                                                  |

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm contracts:toolchain                       # the pinned Foundry
pnpm contracts:campaign --profile full --seed 0x4c657841656769732e50726f6f664f665265766965772e7631
pnpm contracts:campaign --profile full --seed 0x4c657841656769732e4368617074657231372e63616d706169676e2e32
pnpm contracts:test:ci                         # the bounded routine profile
```

Each full run took about 67 minutes here with both running together. The evidence file holds
counts, seeds, settings and suite names only: no key, signature or trace is written. Test keys are
derived inside the tests from labels and exist nowhere else. If a campaign ever fails, Foundry
prints the minimised call sequence; keep it and the seed, replay it before any fresh random
campaign, and treat a reproducible registry failure as a blocker that needs a protected-source
decision. Do not edit the contract or weaken the assertion to make it pass.
