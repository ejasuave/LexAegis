# Static analysis of the registry

Tool output and its triage for `ProofOfReviewRegistry` and everything it inherits. This is **not an
audit** and makes no claim that the contract is free of vulnerabilities: a static analyser finds
some classes of mistake and misses others.

## What ran

|                           |                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command                   | `pnpm contracts:static` (`tooling/scripts/static-analysis.ts`)                                                                                                                                                                            |
| Observed                  | 2026-10-11, source commit `458d3c5`, clean worktree for `contracts/`                                                                                                                                                                      |
| Source identity           | `contracts/src/ProofOfReviewRegistry.sol` sha256 `6c007cfec0430392…`, `ReviewAuthorization.sol` `c6efe055226de236…`, `interfaces/IProofOfReviewRegistry.sol` `249c3a0dfdfe2bf5…` (the protected baselines; `pnpm baselines:check` passes) |
| Contract linter           | `forge lint src`, Foundry 1.8.5 (`51a52c5`), the version pinned in `contracts/toolchain.json`                                                                                                                                             |
| Static analyser           | Slither 0.11.6 with crytic-compile 0.4.2, in an isolated Python 3.13 environment under `.tools/slither/venv` (git-ignored)                                                                                                                |
| Compiler and dependencies | Unchanged: solc 0.8.37, EVM `osaka`, optimizer 200 runs, `via_ir = false`, OpenZeppelin Contracts 5.6.1. The analyser compiles through the pinned `forge` with the project's own `foundry.toml`.                                          |
| Scope analysed            | `contracts/src` (3 files) and the pinned OpenZeppelin contracts and libraries they compile: 19 contracts in total, 102 detectors. Tests and fixtures are **not** analysed and no coverage is claimed from them.                           |
| Exclusions                | None. No detector, path, severity or dependency is filtered, and there is no triage database.                                                                                                                                             |
| Isolation                 | The analyser runs `forge clean` and a forced rebuild, so it works on a copy of the project under `.tools/slither/work`. `contracts/out` and the tracked artifact are never touched. Nothing is uploaded; no network is used.              |
| Consulted                 | <https://github.com/crytic/slither> (install, Python 3.10+, Foundry projects run with `slither .`), read 2026-10-11                                                                                                                       |

The repository had no contract-linter command before this chapter. `forge fmt --check`
(`pnpm contracts:fmt:check`) is a **formatting** check only. The registry source already carried two
`forge-lint` suppression comments, so `forge lint` is the project's linter and is now run by
`pnpm contracts:static`.

## Results

- **`forge lint src`: no diagnostic.** With the two inline suppressions removed (in the isolated
  copy only) it reports 5: `reentrancy-events` × 4 and `block-timestamp` × 1. Both are triaged below
  (L-01, L-02), so the suppressions hide nothing untriaged.
- **Slither: 72 findings.** 3 are located in `contracts/src`, 69 in the pinned OpenZeppelin
  dependency. The full list, with every finding's identifier, detector, severity, confidence,
  location and whether its function is reachable from a registry entry point, is
  [`slither-findings.json`](./slither-findings.json).
- **Reachability.** Slither's own call graph gives 29 functions reachable from the registry's seven
  entry points. A dependency finding in a function outside that list concerns library code that is
  compiled in only where it is called, so it is not part of the registry's behaviour.
- **Unresolved findings: none. Findings that need a change to the registry, inherited logic or
  deployed dependencies: none.** No `requires redeploy decision` blocker is open.

## Triage

Every one of the 72 findings is named, by identifier, in exactly one entry of
[`static-analysis-triage.json`](./static-analysis-triage.json). `pnpm contracts:static` fails if a
finding is untriaged, triaged twice, listed under the wrong detector or scope, or no longer reported,
and if the committed inventory differs from what the tool reports. A triage entry cannot name a
detector without naming findings.

| Key  | Detector                         | Findings | Location                                                                   | Severity / confidence  | Reachable from the registry | Disposition        |
| ---- | -------------------------------- | -------- | -------------------------------------------------------------------------- | ---------------------- | --------------------------- | ------------------ |
| S-01 | `uninitialized-state`            | 1        | src/ProofOfReviewRegistry.sol#13                                           | High / High            | n/a                         | **false positive** |
| S-02 | `timestamp`                      | 1        | src/ReviewAuthorization.sol#55-72                                          | Low / Medium           | reachable                   | **accepted**       |
| S-03 | `pragma`                         | 1        | project-wide (src and OZ)                                                  | Informational / High   | n/a                         | **accepted**       |
| S-04 | `solc-version`                   | 3        | OZ:interfaces/IERC1271.sol, OZ:interfaces/IERC5267.sol, OZ:utils/Panic.sol | Informational / High   | n/a                         | **false positive** |
| S-05 | `incorrect-exp`                  | 1        | OZ:utils/math/Math.sol#206-277                                             | High / Medium          | not reachable               | **false positive** |
| S-06 | `divide-before-multiply`         | 9        | OZ:utils/math/Math.sol                                                     | Medium / Medium        | not reachable               | **false positive** |
| S-07 | `unused-return`                  | 1        | OZ:utils/cryptography/SignatureChecker.sol#44-55                           | Medium / Medium        | reachable                   | **false positive** |
| S-08 | `unused-return`                  | 1        | OZ:utils/cryptography/SignatureChecker.sol#32-39                           | Medium / Medium        | not reachable               | **false positive** |
| S-09 | `assembly`                       | 5        | 5 OpenZeppelin files                                                       | Informational / High   | reachable                   | **accepted**       |
| S-10 | `assembly`                       | 39       | 9 OpenZeppelin files                                                       | Informational / High   | not reachable               | **accepted**       |
| S-11 | `low-level-calls`                | 1        | OZ:utils/cryptography/SignatureChecker.sol#132-149                         | Informational / High   | not reachable               | **accepted**       |
| S-12 | `naming-convention`              | 2        | OZ:utils/cryptography/EIP712.sol                                           | Informational / High   | reachable                   | **accepted**       |
| S-13 | `too-many-digits`                | 7        | OZ:utils/Bytes.sol, OZ:utils/ShortStrings.sol, OZ:utils/math/Math.sol      | Informational / Medium | not reachable               | **accepted**       |
| L-01 | `reentrancy-events` (forge lint) | 4        | src/ProofOfReviewRegistry.sol#43-60                                        | warning                | reachable                   | **accepted**       |
| L-02 | `block-timestamp` (forge lint)   | 1        | src/ReviewAuthorization.sol#66                                             | warning                | reachable                   | **accepted**       |

"OZ:" is `node_modules/@openzeppelin/contracts/`. Dispositions used: _false positive_ (with the
reasoning that supports it) and _accepted_ (with a bounded residual risk). None is _fixed_: nothing
was changed. _open_ and _requires redeploy decision_ exist in the schema and would keep the gate open.

### S-01 `uninitialized-state`: false positive

Slither reports the private mapping `_receipts` as never initialized. A mapping has no initializer: every slot starts at zero, which is the NotFound status. It IS written, through the storage references `_create` and `_retire` receive (`receipts[commitment]` and `Receipt storage`), which this detector does not follow.

Evidence: contracts/test/Lifecycle.t.sol test_issueCreatesOneActiveReceiptWithNoPredecessor and the stateful campaign read back every written field; contracts/src/ProofOfReviewRegistry.sol lines 64-81.

### S-02 `timestamp`: accepted

`block.timestamp > action.deadline` decides expiry of an unexecuted instruction. A block producer can shift the timestamp slightly, so an action may be accepted or refused a few seconds around its deadline. Bounded: the deadline is a coarse expiry (the application signs at most 600 seconds ahead), it never affects an issued receipt, and the reviewer can cancel earlier with invalidateNonce. No value is at stake in the registry.

Evidence: contracts/test/Authorization.t.sol testFuzz_deadlineBoundaryForEveryActionShape (deadline-1, deadline, deadline+1) and test_anExpiredDeadlineDoesNotExpireAnIssuedReceipt; the source comments the intent at ReviewAuthorization.sol line 64.

### S-03 `pragma`: accepted

Five version constraints appear across the compiled files: the two registry sources pin `0.8.37` exactly, the interface allows `^0.8.24` (SPEC discrepancy D2) and the pinned OpenZeppelin files use their own ranges. Bounded: one compiler compiles all of them. `contracts/foundry.toml` sets `solc = "0.8.37"` with `auto_detect_solc = false`, and the deployed bytecode is compared with that build.

Evidence: contracts/foundry.toml (protected baseline); pnpm baselines:check; pnpm verify:deployment.

### S-04 `solc-version`: false positive

The detector lists compiler bugs for the oldest version each dependency's CONSTRAINT would allow (>=0.4.16, >=0.5.0, ^0.8.20). No such compiler is used: the project compiles every file with exactly 0.8.37. The Solidity project's bugs_by_version.json lists no known bug for 0.8.37 (read 2026-10-11).

Evidence: contracts/toolchain.json and foundry.toml pin 0.8.37; https://raw.githubusercontent.com/ethereum/solidity/develop/docs/bugs_by_version.json entry 0.8.37: bugs [] released 2026-09-10 (read 2026-10-11).

### S-05 `incorrect-exp`: false positive

`inverse = (3 * denominator) ^ 2` in OpenZeppelin Math.mulDiv is an intended XOR: it seeds the Newton-Raphson modular inverse, as the surrounding comments in that file state. The function is also not reachable from any registry entry point, so it is not part of the registry's behaviour.

Evidence: docs/security/slither-findings.json reachableFunctions does not contain Math.mulDiv; node_modules/@openzeppelin/contracts/utils/math/Math.sol lines 255-268.

### S-06 `divide-before-multiply`: false positive

OpenZeppelin Math.mulDiv and Math.invMod divide then multiply on purpose (512-bit division and the extended Euclidean algorithm); precision loss is the algorithm, not an error. Neither function is reachable from any registry entry point.

Evidence: docs/security/slither-findings.json reachableFunctions contains no Math function.

### S-07 `unused-return`: false positive

SignatureChecker.isValidSignatureNowCalldata (reachable: it is the registry's signature check) destructures `(recovered, err, )` from ECDSA.tryRecoverCalldata and ignores only the third value, the error ARGUMENT. Both values that decide the result are used: `err == NoError && recovered == signer`.

Evidence: node_modules/@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol lines 44-55; contracts/test/Authorization.t.sol test_emptyAndMalformedSignaturesAreRejected and test_malleableHighSSignatureIsRejected.

### S-08 `unused-return`: false positive

The memory variant SignatureChecker.isValidSignatureNow(address,bytes32,bytes) ignores the same error argument for the same reason, and is not reachable from any registry entry point (the registry calls the calldata variant).

Evidence: docs/security/slither-findings.json reachableFunctions lists isValidSignatureNowCalldata only.

### S-09 `assembly`: accepted

Five reachable functions of the pinned OpenZeppelin 5.6.1 use inline assembly: typed-data hashing, calldata signature parsing, the ERC-1271 STATICCALL, short-string decoding and a storage-slot cast. Informational. Residual risk, bounded: the registry relies on the correctness of this pinned dependency; the version is fixed in pnpm-lock.yaml and toolchain.json and cannot change without changing the compiled bytecode, which the baselines and the deployment comparison detect.

Evidence: contracts/test/Vectors.t.sol (digests equal independent vectors), Authorization.t.sol test_invalidOrAdversarialErc1271ValidationFailsWithoutStateChanges (empty, short and dirty return data), contracts/toolchain.json openzeppelinContracts 5.6.1.

### S-10 `assembly`: accepted

Inline assembly in OpenZeppelin library functions that no registry entry point reaches (Bytes, Strings, Math, Panic, SafeCast, other StorageSlot and MessageHashUtils helpers, the memory signature paths). Informational and outside the registry's behaviour: internal library code is compiled in only where it is called. Residual risk: none for the registry while these stay unreachable, which this check re-derives on every run.

Evidence: docs/security/slither-findings.json: every finding in this entry has reachable=false.

### S-11 `low-level-calls`: accepted

A low-level staticcall in SignatureChecker.isValidSignatureNow(bytes,bytes32,bytes), the ERC-7913 verifier path. The registry does not use ERC-7913 and the function is not reachable from any entry point. Informational; no residual risk for the registry while unreachable.

Evidence: docs/security/slither-findings.json reachable=false for this finding.

### S-12 `naming-convention`: accepted

EIP712._EIP712Name and _EIP712Version are not mixedCase. Naming style in the pinned dependency; no behaviour. Not ours to edit, and renaming would change nothing in the bytecode's behaviour.

Evidence: node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol lines 146-159.

### S-13 `too-many-digits`: accepted

Long hexadecimal literals (bit masks and the short-string fallback sentinel) in the pinned OpenZeppelin libraries. Readability only. The masks are in functions the registry cannot reach; the sentinel is a constant.

Evidence: docs/security/slither-findings.json locations in Bytes.sol, Math.sol and ShortStrings.sol.

### L-01 `reentrancy-events`: accepted

forge lint flags the four receipt events in `execute` as emitted after an external call. The only external call before them is the ERC-1271 signature check, made with STATICCALL: during it the callee cannot emit a log or change state, so it cannot reorder or fabricate the registry's events. The source suppresses the rule for exactly these lines and says why.

Evidence: contracts/src/ProofOfReviewRegistry.sol lines 43-60; contracts/test/Authorization.t.sol test_reentrantValidationCannotMutateTheRegistry and test_aSwallowedNestedMutationLetsTheOuterActionSucceedExactlyOnce (exactly one log, one nonce).

### L-02 `block-timestamp`: accepted

The same deadline comparison as S-02: a coarse expiry in seconds where small validator timestamp drift is acceptable, bounded by the 600-second signing window and by nonce invalidation. Suppressed for that one line with a comment.

Evidence: contracts/src/ReviewAuthorization.sol lines 64-66; contracts/test/Authorization.t.sol testFuzz_deadlineBoundaryForEveryActionShape.

## Reproduce

```sh
pnpm contracts:toolchain            # the pinned Foundry
uv venv --python 3.13 .tools/slither/venv
uv pip install --python .tools/slither/venv/bin/python slither-analyzer==0.11.6 crytic-compile==0.4.2
pnpm contracts:static               # exit 0: every finding accounted for
pnpm contracts:static -- --write    # refresh slither-findings.json after a source change, then triage
```

Exit codes: `0` every finding accounted for; `1` an untriaged, stale or mismatched finding, or a
lint diagnostic in the source; `3` a tool is unavailable or failed to run. Exit `3` prints
`NOT YET` with the next command and is **never** a clean result: a compilation or execution failure
is reported as a tool failure, not as "no findings". A linter pass does not stand in for an
analyser that did not run.

## Limits

- Slither's detectors are heuristics. A clean detector is not a proof of absence.
- The reachability list is Slither's static call graph for internal and library calls.
- Dependency findings are triaged for this registry's use of the dependency, not for the dependency
  in general.
- The deployed bytecode is compared with this source separately: see
  [`../DEPLOYMENTS.md`](../DEPLOYMENTS.md).
