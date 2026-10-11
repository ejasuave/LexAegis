# Document-review example

A small, generic Node/TypeScript integration of the Proof of Review protocol and SDK. It uses only
public entry points and a non-legal profile (`example.document-review`, version 1). It
**demonstrates reuse**; it is not a real external customer integration and says nothing about any
production use.

What a receipt shows: that a bundle's files are the ones a receipt reference commits to and, if you
check the registry, what the registry records. It does not show that the content is correct, the
facts are true or who the reviewer is.

## Commands

From the repository root (the examples are workspace packages):

```sh
# 1. Prepare a synthetic package. Prints only the public reference.
pnpm --filter @lexaegis/example-document-review review:prepare -- \
  --out ./out --chain-id 10143 \
  --registry 0x453bfd1602d8a8666f55bf9a8d87b127cb94048f \
  --reviewer 0x2222222222222222222222222222222222222222

# 2. Optional: also produce typed signing data. You choose the registry nonce and the deadline.
#    ... --nonce 0 --deadline 1900000000      (writes out/issue-typed-data.json)

# 3. Verify offline against a reference you were given separately. Prints a VerificationReportV1.
pnpm --filter @lexaegis/example-document-review review:verify -- \
  --bundle ./out/review-export.json --expected-reference ./out/receipt-reference.json

# 4. Optional: also check the registry. The endpoint is operator configuration, not an argument.
REVIEW_RPC_URL=https://testnet-rpc.monad.xyz/ pnpm --filter @lexaegis/example-document-review review:verify -- \
  --bundle ./out/review-export.json --expected-reference ./out/receipt-reference.json \
  --policy ./registry-policy.json --reviewers ./accepted-reviewers.txt
```

## Issue and supersede (a signer you supply)

`src/lifecycle.ts` adds `issueReview` and `supersedeReview`, with `src/viem-access.ts` (chain access
over viem clients) and `src/signer-adapter.ts` (wrap your own wallet account). They store the opening
before anything is sent, reconcile with a verified registry read, ask your required `approve` callback
with the exact action and fee ceiling, send, and read the result back through the SDK: success is never
inferred from a transaction hash. They hold no key. `docs/QUICKSTART.md` path 3 runs them against a
throwaway local chain with a test-only signer; any public-network run is manual and opt-in.

## Public API used

| Need                                         | Entry point                                                     |
| -------------------------------------------- | --------------------------------------------------------------- |
| Prepare an unapproved package                | `prepareReviewPackage` (`@lexaegis/protocol/v1`)                |
| Strict readable-bundle decode                | `parseReviewExport` (`@lexaegis/sdk/portable`)                  |
| Offline checks, report schema, signer policy | `@lexaegis/sdk/offline`                                         |
| Live registry check                          | `verifyReceipt` (`@lexaegis/sdk/verify`)                        |
| Signing data only                            | `buildIssueAction`, `buildTypedData` (`@lexaegis/sdk/registry`) |

## What you must supply, and why

- **An expected reference, separately from the bundle.** A bundle can agree with itself while being
  a different package. `verify` requires `--expected-reference` and never reads it from the bundle;
  the bundle's own declared reference is used only to flag a conflict.
- **A registry policy for live checks** (`--policy`, a `RegistryPolicy` JSON file): chain, genesis
  hash, registry address, protocol version, deployment block and runtime-code hash. A package can
  never provide it. Without `REVIEW_RPC_URL` and `--policy` the report keeps `chainStatus: unknown`.
- **A signer rule** (`--reviewers`, optional): addresses you accept. Without one, `signerAcceptance`
  is `unknown`. It is your rule, not a professional credential check.
- **Your own signer and approval step.** `prepare` returns typed data only. This example has no
  private key, no account unlock and no way to broadcast.

Credentials belong in your environment, never in arguments, fixtures, reports or logs. An address
that carries a key (user name, query string) is refused.

## Result meanings

`manifestIntegrity` and `artifactIntegrity`: `match`, `mismatch` or `unknown` (not supplied).
`registryIdentity`, `receiptBinding`: whether the configured deployment and the receipt bind to the
files. `chainStatus`: `unknown`, `not_found`, `active`, `revoked` or `superseded` at the reported
block. `signerAcceptance`: `accepted`, `rejected` or `unknown`. There is no combined "valid" field,
`profileSemantics` is always `not_evaluated`, and a report is an observation at `observedAt`, not a
certificate.
