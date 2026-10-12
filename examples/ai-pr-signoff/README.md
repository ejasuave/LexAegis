# AI-assisted pull request sign-off (second-domain example)

**The project team wrote this example.** It shows that the generic Proof of Review protocol serves a
second domain, a code-review sign-off, without any legal-app code. It is **not** independent adoption,
**not** a GitHub integration, **not** Mera recovery, and **not** verified AI authorship. An example the
team builds is never counted as customer or external traction.

A receipt from this example shows that **these exact bytes** (a diff, an AI-review summary and the
reviewer's decision) were approved, as a package, by the account that signed it. It does **not** show
that the code is safe or correct, who wrote it, that tests ran, that anyone may merge it, or that a
real GitHub review took place. It never merges or alters a pull request and never contacts GitHub or a
model: every input is inert bytes.

## What it uses

- Profile `lexaegis.ai-pr-signoff` version `1`, through the **existing generic profile mechanism**. No
  protocol change, no new manifest field or role, no change to any vector.
- Existing roles only: the diff is `source`, the summary is `analysis`, the decision is `decision-log`.
  Every artifact is in scope exactly once and the approval points at the decision.
- The decision file is an example-local, versioned, closed schema
  (`lexaegis.ai-pr-signoff.decision.v1`): reviewer, an explicit `approve-review-package` decision, the
  SHA-256 of the exact diff and summary, a rationale of at most 2000 characters and a supplied time. It
  binds to the files, not to the final commitment (which would be circular).
- The SDK for the action, typed data, fee checks and verification; the vault's **unchanged** envelope
  encryption for preservation, with a **separate in-memory storage key** (not derived from the signing
  key, never written next to the ciphertext).

## Commands

From the repository root (`pnpm --filter @lexaegis/example-ai-pr-signoff signoff <command>`, or
`pnpm signoff` inside this directory). Secrets are environment variables only, never arguments.

```sh
# 1. Digests the decision file must contain (the fixtures already hold them)
pnpm signoff hash --diff fixtures/pr-42.diff --summary fixtures/ai-review-summary.md

# 2. One-time storage key. Printed once, stored nowhere: keep it. Losing it loses the preserved package.
export AI_PR_SIGNOFF_STORAGE_KEY="$(pnpm -s signoff keygen)"

# 3. Prepare: builds the exact package, preserves it ENCRYPTED, reads it back, prints the PUBLIC
#    reference. Needs no operator key. Approves and issues nothing.
pnpm signoff prepare --diff fixtures/pr-42.diff --summary fixtures/ai-review-summary.md \
  --decision fixtures/decision.json --policy ./policy.json --evidence-dir ./evidence --out ./out

# 4. Read-only verification of an export you were given, against a reference you hold separately.
#    Loads no key. The registry is read only when a policy and AI_PR_SIGNOFF_RPC_URL are given.
pnpm signoff verify --export ./export.json --expected-reference ./out/receipt-reference.json \
  [--policy ./policy.json]

# 5. Explicit, labelled full disclosure of the preserved package (writes the files unencrypted)
pnpm signoff export --reference ./out/receipt-reference.json --evidence-dir ./evidence \
  --owner 0x… --out ./export.json --full-disclosure
```

`policy.json` is the registry deployment record you trust (the SDK's `RegistryPolicy`). For Monad
Testnet, take the `policy` object from `packages/cli/src/known-deployments.generated.ts`, which
`pnpm verifier:policy` generates from [`contracts/deployments/monad-testnet.json`](../../contracts/deployments/monad-testnet.json).
Importing, installing and testing this example perform **no public write**.

## The public issue (operator-run, explicit, guarded)

```sh
export AI_PR_SIGNOFF_STORAGE_KEY=…          # the key from step 2
export AI_PR_SIGNOFF_OPERATOR_KEY=0x…       # a DEDICATED synthetic testnet operator key. Never a
                                            # production, user or funder key. Read by `issue` only.
export AI_PR_SIGNOFF_RPC_URL=https://…      # a public endpoint, https, no credentials in the URL
pnpm signoff issue --broadcast --target monad-testnet --reference ./out/receipt-reference.json \
  --policy ./policy.json --evidence-dir ./evidence --pending-dir ./pending
```

What it enforces:

- **Only Monad Testnet.** The target must be chain `10143` **and** the pinned genesis hash. A matching
  registry address on any other chain is refused. The only other target, `--target local-loopback`, is
  for a throwaway local chain: it must be loopback and must not be Monad Testnet. There is no switch to
  skip the chain check.
- **Two typed confirmations at a terminal, never a flag.** First the exact snapshot (files, reference,
  profile, reviewer, chain, registry, `ISSUE`, the registry nonce, the deadline, zero value), typed as
  `approve <commitment prefix>`; then the fee ceiling and transaction hash, typed as `send <commitment
prefix>`. `--broadcast` only enables the workflow; a decision file saying "approved" is not approval;
  a public issue refuses to run without an interactive terminal, so CI cannot bypass it.
- **Preserved first.** The encrypted opening and files are read back and checked against the original
  reference before anything is signed. If preservation fails, nothing is issued.
- **Parsed before sending.** The signed transaction is decoded: destination, selector, every action
  field, chain, zero value and the fee ceiling are checked against what you confirmed.
- **Pending identity before broadcast.** The transaction hash is recorded (public data only) before it
  is sent. After a lost response the exact transaction is reconciled before anything else; the same
  signed transaction may be sent again, but a new opening, commitment or action is never created to
  hide uncertainty. A transaction hash is never treated as confirmation: success is what the registry
  shows at a verified checkpoint.
- **Memory only.** The operator key, the storage key and the signed action stay in memory.
  Interruption cannot recall a signature or transaction that was already disclosed.

## Evidence status

| Item                                                                                               | Status                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile support (generic mechanism, vectors unchanged)                                             | Done: unit tests and `pnpm vectors:check`.                                                                                                                                                                       |
| Local workflow: prepare, encrypted preservation, guarded issue, verify, tamper, interrupted submit | Done, **local evidence only**: `contracts/integration/ai-pr-signoff.anvil.test.ts` (real registry on a throwaway Anvil chain, injected development signer).                                                      |
| Operator-run Monad Testnet issue                                                                   | **NOT YET.** Prerequisites: a dedicated, funded synthetic testnet operator key, a public RPC endpoint and an operator at an interactive terminal. No real deployment, reference or transaction is recorded here. |
| Independent adoption of this example                                                               | **None.**                                                                                                                                                                                                        |

If an operator runs the live flow, record only the real reference, transaction hash and checkpoint
after confirmation, and keep any readable export outside commits unless it is deliberately synthetic
and public.

## Layout

`src/profile.ts` profile and decision schema; `src/inputs.ts` bounded regular-file reads;
`src/package.ts` package preparation; `src/storage.ts` encrypted preservation; `src/guards.ts` target
rules; `src/chain.ts` chain access (the executor signs locally, so the hash is known before broadcast);
`src/issue.ts` the workflow; `src/verify.ts` and `src/export.ts` the read-only and disclosure paths;
`src/cli.ts` the commands. Synthetic fixtures are in `fixtures/` (the summary is team-authored text, not
a measured model run).
