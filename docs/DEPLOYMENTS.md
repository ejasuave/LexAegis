# Deployments

One registry is deployed, on **Monad testnet**. This page keeps four different kinds of record apart:
the deployment itself, the read-only comparison of its code with this repository's source, the
explorer's source verification, and the optional agent registration (none exists). Local test
deployments are not deployments in this sense and are listed only to say so.

Nothing here is a security audit. **Source verification is code correspondence**: it says the
deployed bytes are what this source compiles to. It says nothing about whether that code is safe,
and the hosted demonstration is not for client data. A registry read depends on the RPC endpoint
that answered; it is an observation, not a consensus proof.

## 1. Registry deployment (Chapter 6, 2026-10-09)

The record of the deployment is `contracts/deployments/monad-testnet.json`
(`lexaegis.registry-deployment.v1`), unchanged since it was written. Fields marked _read back_ were
read from the chain again on 2026-10-11 through the configured read-only endpoint and agree with it.

| Field                         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Network                       | Monad testnet, chain ID `10143`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | deployment record; _read back_ (`eth_chainId`)                         |
| Genesis hash                  | `0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9`                                                                                                                                                                                                                                                                                                                                                                                                                         | deployment record; _read back_                                         |
| Registry address              | `0x453bfd1602d8a8666f55bf9a8d87b127cb94048f`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | deployment record; _read back_ (receipt `contractAddress`)             |
| Deployment transaction        | `0xe6d0be40e8410df1d7dd87b18463a4dfc53fb839cf0036784c018a886ebea04a`                                                                                                                                                                                                                                                                                                                                                                                                                         | deployment record; _read back_, status success                         |
| Transaction sender (deployer) | `0xcaef8dd2419b3f5a43dffaec4bbeb28d5f537d18`, account nonce `0`                                                                                                                                                                                                                                                                                                                                                                                                                              | _read back_ (`eth_getTransactionByHash`)                               |
| Creation mechanism            | A plain contract-creation transaction from that externally owned account (`to` is null). No factory and no CREATE2: the address equals the CREATE address for that sender and nonce.                                                                                                                                                                                                                                                                                                         | _read back_ and derived                                                |
| Block                         | `69534196`, hash `0x9f9a11f3234202e24d6f0c50fe85301cf09fa97652dfa236c97aa5bd22cde0a8`, canonical at the verification checkpoint                                                                                                                                                                                                                                                                                                                                                              | deployment record; _read back_                                         |
| Block timestamp               | 2026-10-09T12:01:18Z, as the endpoint reported it                                                                                                                                                                                                                                                                                                                                                                                                                                            | _read back_                                                            |
| Creation code                 | 5,033 bytes, keccak256 `0x38a7a70bfb716f8d6d10c20ae206ac49add2be6a5c34a367dd5a51d5edf875f2`. The transaction's input hashes to this value.                                                                                                                                                                                                                                                                                                                                                   | deployment record; `contracts/artifacts/registry-v1.json`; _read back_ |
| Runtime code                  | 4,118 bytes, keccak256 `0x2389a742aa78c6aad56162f42e300cf0fb8cee571c1e822cd3d8a7cffd00ed71`, sha256 `0xbcb38d3200bda22852aa45f900054c79e60a18797221f11115eaa25e31928696`                                                                                                                                                                                                                                                                                                                     | deployment record; _read back_                                         |
| Compiler                      | solc `0.8.37+commit.f401782d`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | deployment record; rebuilt artifact metadata                           |
| Settings                      | EVM `osaka`; optimizer enabled, 200 runs; `viaIR` false; `bytecodeHash` `none` with CBOR metadata appended (a 12-byte trailer holding only the compiler version); `useLiteralContent` true; no libraries                                                                                                                                                                                                                                                                                     | `contracts/foundry.toml`; rebuilt artifact metadata                    |
| Remappings                    | `@openzeppelin/contracts/=node_modules/@openzeppelin/contracts/`, `forge-std/=node_modules/forge-std/src/`                                                                                                                                                                                                                                                                                                                                                                                   | `contracts/foundry.toml`                                               |
| Dependencies                  | OpenZeppelin Contracts `5.6.1` (lockfile integrity `sha512-Ly6SlsVJ3mj+b18W3R8gNufB7dTICT105fJhodGAGgyC2oqnBAhqSiNDJ8V8DLY05cCz81GLI0CU5vNYA1EC/w==`). forge-std `1.17.0` at `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` is used by tests and the deploy script only and is not in the bytecode.                                                                                                                                                                                              | `pnpm-lock.yaml`; `contracts/toolchain.json`                           |
| Toolchain                     | Foundry `1.8.5` (`51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f`)                                                                                                                                                                                                                                                                                                                                                                                                                                 | `contracts/toolchain.json`                                             |
| Source hashes (sha256)        | `src/ProofOfReviewRegistry.sol` `6c007cfec0430392f0574f50486c570102ca7cbc6df13dcb03e802980ad77259`; `src/ReviewAuthorization.sol` `c6efe055226de236e1c299119cd77813f1b4f70914713ebd6b2d19da5d131867`; `src/interfaces/IProofOfReviewRegistry.sol` `249c3a0dfdfe2bf529ed92255e1d8650fd6f6a6d96e4217a8caf79394d7f8f2f`; `foundry.toml` `45099d81d0fa1b3e044b4220d105378e1fa1e396a9229ca5fad589eaa375cdcf`; `toolchain.json` `518060af016c206ecb19e1fa84817b2a2fe9d121f4ae11363c71b10ddc6eb790` | this repository; `pnpm baselines:check`                                |
| **Deployment source commit**  | **NOT YET, and not recoverable as a commit.** The deployment block (2026-10-09T12:01:18Z) is earlier than this repository's first commit (`496c655`, 2026-10-09T23:45:35Z), so no commit existed when the contract was deployed. What is established instead: the sources in that first commit, unchanged since (protected baselines), compile to exactly the creation code the deployment transaction carried.                                                                              | `git log`; _read back_                                                 |
| Current verification commit   | `14c6f2965d7b224427541e835d39264b2954d88c`, with uncommitted Chapter 17 edits outside `contracts/src` at the time of the check. This identifies where the check ran. It is **not** evidence of the historical deployment commit.                                                                                                                                                                                                                                                             | evidence files below                                                   |

The deployer's key, the broadcast log and the environment file are not in this repository and are
not needed by anything on this page.

## 2. Read-only bytecode comparison (Chapter 17)

`pnpm verify:deployment` rebuilds the registry from the pinned source in a temporary directory and
compares it, byte for byte, with the code at the recorded address. It loads no key and sends nothing.
Full method, exit codes and limits: `tooling/scripts/verify-deployment.ts`.

|                        | Configured endpoint                                                                                                                                         | Independent public endpoint                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Command                | `pnpm verify:deployment -- --env-file .env --evidence --record`                                                                                             | `pnpm verify:deployment -- --public-rpc --evidence --record`                                                                           |
| Provider (origin only) | `https://monad-testnet.g.alchemy.com`                                                                                                                       | `https://testnet-rpc.monad.xyz`                                                                                                        |
| Checked (UTC)          | 2026-10-11T16:17:07Z                                                                                                                                        | 2026-10-11T16:17:14Z                                                                                                                   |
| Result                 | **MATCH**, exit `0`, policy `exact`                                                                                                                         | **MATCH**, exit `0`, policy `exact`                                                                                                    |
| Code comparison        | `exact_match`: 4,118 of 4,118 bytes                                                                                                                         | `exact_match`: 4,118 of 4,118 bytes                                                                                                    |
| Checkpoint             | block `70156819`, hash `0x570dfb2135563cf60b42640940fbab3959ffdd958c501025fff45a8c33bab052` (finalized `70156822` minus 3), hash re-checked after the reads | block `70156845`, hash `0x355b3e12910c18e5a1192f18e46d6370d74f347978f1e94cc070a4bf241ceecc` (finalized `70156848` minus 3), re-checked |
| Recorded code pin      | observed keccak256 equals `runtimeCodeKeccak256` in the record                                                                                              | equal                                                                                                                                  |
| Deployment transaction | consistent (7 of 7 checks)                                                                                                                                  | consistent (7 of 7 checks)                                                                                                             |
| Methods used           | `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_getTransactionByHash`, `eth_getTransactionReceipt` (9 requests)                                  | the same                                                                                                                               |
| Evidence               | `docs/evidence/chapter17-deployment-verify-alchemy-2026-10-11.json`                                                                                         | `docs/evidence/chapter17-deployment-verify-public-2026-10-11.json`                                                                     |

What the comparison establishes, and how:

- **The build is the deployment build.** The fresh rebuild's creation code hashes to the value in
  the deployment record, in the tracked build record and in the deployment transaction's input. The
  compiler version, EVM target, optimizer, `viaIR` and `bytecodeHash` setting equal the recorded ones.
- **Every immutable is derived, not copied.** The compiler leaves seven 32-byte ranges for
  OpenZeppelin's EIP-712 immutables. Each was computed from the pinned source and the deployment
  context (chain `10143`, the registry address, name `LexAegisProofOfReview`, version `1`) and written
  into the expected code before comparing. Nothing was read from the observed bytes, zero-masked or
  skipped. (The Chapter 6 deployment check masked these ranges; this one does not.)

  | Immutable                       | Derived value                                                        |
  | ------------------------------- | -------------------------------------------------------------------- |
  | `EIP712._cachedDomainSeparator` | `0x8e77c97c32bb647fb1873287ec6363a0537600b08c2da583a011ae33bdbd0d95` |
  | `EIP712._cachedChainId`         | `0x…279f` (10143)                                                    |
  | `EIP712._cachedThis`            | the registry address, left-padded                                    |
  | `EIP712._hashedName`            | `0x23fc53c9b8f985477ec4b07c306b22871152719d5bd349e04a48b0e3bc2e05a9` |
  | `EIP712._hashedVersion`         | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |
  | `EIP712._name`                  | short string `LexAegisProofOfReview` (21 bytes)                      |
  | `EIP712._version`               | short string `1`                                                     |

- **No library is linked** (`linkReferences` is empty).
- **The match is exact, metadata included.** No metadata-insensitive comparison was needed. Had only
  the trailer differed, the default policy would have reported `metadata_only_match` and exited
  non-zero.
- **Two endpoints agree.** The second, independently configured public endpoint corroborates the
  first. Both remain trust-dependent observations.

Local evidence for the same checker, kept separate: `contracts/integration/verify-deployment.anvil.test.ts`
runs it against the unchanged registry on a throwaway Anvil chain, including one-byte changes that
must be detected. That is not a Monad observation.

Re-checked on the final Chapter 17 source, 2026-10-11T21:05:13Z, over the public endpoint
(`pnpm verify:deployment --public-rpc`, no evidence file written): **MATCH**, exit `0`, policy
`exact`, 4,118 of 4,118 bytes, checkpoint block `70214061` re-checked, code pin equal, deployment
transaction consistent. CI runs the same command as a separate read-only job
(`deployment-read-only`); that job has not been observed on GitHub yet, and a failed or skipped run
of it is not a verified deployment.

## 3. Explorer source verification (Chapter 17)

Kept apart from section 2: an explorer result cannot override a bytecode mismatch, and a passing
comparison does not depend on the explorer.

| Field                             | Value                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route                             | Foundry with the Sourcify verifier, as Monad's guide documents for **testnet** (`--chain 10143`, no API key). Guide read 2026-10-11: <https://docs.monad.xyz/guides/verify-smart-contract/foundry>                                                                                                                                       |
| Verifier                          | Sourcify, the MonadVision / BlockVision instance: `https://sourcify-api-monad.blockvision.org/`                                                                                                                                                                                                                                          |
| Command                           | `pnpm verify:explorer -- --submit` (runs the pinned `forge verify-contract … --verifier sourcify`)                                                                                                                                                                                                                                       |
| Submitted                         | 18 Solidity sources (3 registry files, 15 pinned OpenZeppelin files) and the compiler settings of the deployment build; 166,576 bytes. The source was not flattened or reformatted and no metadata setting was changed. Allowlist and credential scan passed before sending. No key, wallet signature or transaction was involved.       |
| Verification job                  | `bbb479c7-1513-4da3-8873-bff3924d9a3c`, completed 2026-10-11T16:19:21Z                                                                                                                                                                                                                                                                   |
| **Result**                        | **Verified.** The service reports `match: "match"`, `runtimeMatch: "match"`, `creationMatch: null` for chain `10143`, address `0x453BFd1602d8A8666F55bF9A8D87B127cB94048f` (read back from its status endpoint after the job finished).                                                                                                  |
| Match level                       | `match`, Sourcify's level for bytecode that matches without a metadata hash. `exact_match` is not available for this build: it uses `bytecodeHash = "none"`, so the bytecode carries no metadata hash to compare. Creation-code matching was not reported.                                                                               |
| Explorer page                     | <https://testnet.monadvision.com/address/0x453bfd1602d8a8666f55bf9a8d87b127cb94048f>. **The rendered page was not checked by this tooling**: it answers automated requests with a bot challenge (HTTP 403). The result above comes from the explorer's verification service for this exact chain and address, not from reading the page. |
| Monadscan (Etherscan-style route) | **NOT YET.** It needs an API key, and none is configured. Not attempted.                                                                                                                                                                                                                                                                 |
| Evidence                          | `docs/evidence/chapter17-explorer-verification-2026-10-11.json`                                                                                                                                                                                                                                                                          |

## 4. Optional agent registration (Chapter 16)

**None.** No LexAegis agent has been registered in the ERC-8004 Identity Registry, no agent card is
hosted and no feedback has been written. `pnpm register:agent` is a dry run by default and has never
been executed against a network. The read-only observations of the third-party ERC-8004 registries
are in [`erc8004-availability.md`](./erc8004-availability.md); they are not deployments of this project.

## 5. Not deployments

- **Local chains.** Anvil deployments made by the test suites exist only for the life of a test.
- **Mainnet.** Nothing is deployed on Monad mainnet and nothing in this repository deploys there.
- **Replacement.** No replacement registry was deployed for this chapter, and none is planned to
  resolve a verification result.

## Reproduce

```sh
pnpm contracts:toolchain
pnpm verify:deployment -- --public-rpc          # exit 0: exact match
pnpm verify:explorer -- --status                # exit 0: the service reports a match
pnpm verify:explorer                            # dry run: prints exactly what a submission would send
```
