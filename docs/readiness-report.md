# Readiness report

<!-- readiness-run:rd-20261010232546-829ded version:1 -->

Run `rd-20261010232546-829ded` at 2026-10-10T23:25:46.728Z. Source fingerprint `720570aa2a98d415`.
Exit 0 before a deadline is not a claim of submission readiness. Recorded chain results are historical, not live reads.

## Gates

```text
gate  target                     outcome  observed                   missing evidence / reason
A  2026-10-06T23:59:59+01:00  fail     2026-10-10T23:25:46.728Z  NOT YET: Registry deployed on Monad testnet (observed receipt, matching identity)
B  2026-10-08T23:59:59+01:00  fail     -  NOT YET: A real Mera account signed the exact action; NOT YET: Registry transaction confirmed through Alchemy; NOT YET: Verifier read the resulting state
C  2026-10-10T23:59:59+01:00  fail     -  NOT YET: Genuine Qwen run with bounded tools and valid source-linked findings; NOT YET: Complete T0 browser journey
D  2026-10-11T23:59:59+01:00  unknown  -  NOT YET: Feature freeze recorded; NOT YET: Verifier passes; NOT YET: SDK passes; NOT YET: CLI passes; NOT YET: Judge path passes; NOT YET: Anonymously accessible public repository
```

## Checks

| Check               | Outcome | Reason | Seconds |
| ------------------- | ------- | ------ | ------- |
| typecheck           | pass    | OK     | 18.4    |
| unit-tests          | pass    | OK     | 10.1    |
| forge-test          | pass    | OK     | 21.0    |
| secret-scan         | fail    | EXIT_1 | 0.6     |
| protected-baselines | pass    | OK     | 0.6     |
| build               | pass    | OK     | 4.8     |
| exclusion           | pass    | OK     | 0.8     |

Total 28.3 s. Tools: node v24.21.0, pnpm 11.11.0, forge 1.8.5.
