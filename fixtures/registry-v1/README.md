# Registry v1 test vectors

`vectors.json` holds literal EIP-712 values for seven **synthetic** `ReviewAction` messages: the
domain separator, struct hash, signing digest and a 65-byte signature for each.

| Vector                     | What it covers                                                   |
| -------------------------- | ---------------------------------------------------------------- |
| `issue`, `revoke`          | The two single-commitment actions on chain 10143                 |
| `supersede`                | A replacement commitment                                         |
| `issue-other-registry`     | The same action for a different registry address                 |
| `issue-local`              | Chain 31337 and the first contract address of a fresh Anvil node |
| `supersede-uint256-limits` | Chain 143, the largest usable nonce and the largest deadline     |
| `issue-contract-reviewer`  | A reviewer that is a contract account, signed by its owner key   |

## Rules

- **Independent generation.** `generate.mjs` never imports `@lexaegis/*`, `packages/`,
  `contracts/` or viem (ESLint enforces this). It encodes EIP-712 by hand on a bare Keccak-256 and
  secp256k1 implementation, and its domain and type strings are literals.
- **Three implementations must agree with it:** this generator, the Solidity registry
  (`contracts/test/Vectors.t.sol`) and the TypeScript SDK (`packages/sdk/src/registry`).
- **Never edit `vectors.json` by hand and never regenerate it to make a failing test pass.** A
  mismatch means the signed encoding changed, which needs a new protocol version and registry.
- **The private key is a published test value**, derived from a label. It must never hold funds
  or sign anything real. No vector is a real approval or an on-chain receipt.

## Commands

```sh
pnpm fixtures:check              # both vector files are reproducible from their generators
pnpm contracts:test              # Solidity against the vectors
pnpm test                        # TypeScript SDK against the vectors
pnpm test:contracts:integration  # both runtimes together on a local Anvil chain
```
