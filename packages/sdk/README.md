# @lexaegis/sdk

Framework-neutral **Proof of Review** SDK: read a readable review export, check that its files are
the exact bytes a reviewer committed, and, if you ask, read the receipt's status from the registry.
It needs no wallet, key, backend, model or account. Importing it makes no network request and reads
no environment or storage. It signs and submits nothing.

> Status: version `0.1.0`, **private and unpublished**. Install it from a local tarball
> (`pnpm packages:build && pnpm packages:check` packs and tests the real tarballs).

## Verify an export in ten lines

```ts
import { readFile } from 'node:fs/promises';
import { verifyReviewExport } from '@lexaegis/sdk/verify';

const file = new Uint8Array(await readFile('review-export.json')); // the file you were sent
const expectedReference = JSON.parse(await readFile('expected-reference.json', 'utf8')); // obtained separately
const policy = JSON.parse(await readFile('registry-policy.json', 'utf8')); // the registry deployment YOU trust
const result = await verifyReviewExport({
  file,
  expectedReference,
  live: { policy, transport: { kind: 'rpc', url: process.env.REVIEW_RPC_URL ?? '' } },
});
console.log(JSON.stringify(result.ok ? result.data.report : result.error, null, 2));
```

### Setup this example needs (nothing is hidden)

| You provide                   | Why it is yours, not the file's                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `review-export.json`          | The readable export (`ReviewExportV1`) to check.                                                                                     |
| `expected-reference.json`     | A `ReceiptReferenceV1` you got **outside** that file (the reviewer's page, an email, a QR). Copying it from the file proves nothing. |
| `registry-policy.json`        | A `RegistryPolicy`: chain ID, pinned genesis hash, registry address, runtime-code hash, deployment block. A file can never set it.   |
| `REVIEW_RPC_URL`              | An **HTTPS** JSON-RPC endpoint you chose, without a key in the URL (a URL with user info, query or fragment is refused).             |
| Node 24+, `fetch`, Web Crypto | The SDK is ESM and uses Web Crypto; browsers work too.                                                                               |

If `REVIEW_RPC_URL` is empty the live part fails with `REGISTRY_POLICY_INVALID` and you still get the
local integrity result. For a throwaway local chain add `allowLoopbackHttp: true` to the transport; do
not use it elsewhere.

### What the result says

The report is an **observation at `observedAt`, not a certificate**. There is no combined `valid`
field: read each dimension.

| Field               | Values                                                        | Means                                                                                   |
| ------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `manifestIntegrity` | `match` · `mismatch` · `unknown`                              | The opening recomputes the commitment of **your** expected reference.                   |
| `artifactIntegrity` | `match` · `mismatch` · `unknown`                              | Every committed file's length and SHA-256 match the bytes supplied.                     |
| `registryIdentity`  | `match` · `mismatch` · `unknown`                              | The registry the RPC shows is the deployment your policy trusts (chain, genesis, code). |
| `receiptBinding`    | `match` · `mismatch` · `unknown`                              | The on-chain record is this package's receipt (tuple, plausible record, predecessor).   |
| `chainStatus`       | `active` · `revoked` · `superseded` · `not_found` · `unknown` | The receipt's lifecycle at `checkpoint`. A failed read is `unknown`, never `not_found`. |
| `signerAcceptance`  | `accepted` · `rejected` · `unknown`                           | Whether **your** signer policy accepts the reviewer account. No policy means `unknown`. |
| `profileSemantics`  | `not_evaluated`                                               | The SDK never judges what the documents say.                                            |

An `active` receipt with matching bytes shows that this exact package was committed by an account
that authorized the commitment at that checkpoint. It does **not** show that the content is true or
legally correct, who the account holder is, that a professional reviewed it, or that the receipt is
still active later. Live results rely on the RPC endpoint you choose; they are not a light-client
proof. See [`docs/SPEC.md`](../../docs/SPEC.md).

Failures are typed: a file that cannot be decoded returns
`{ ok: false, error: { source: 'export', failure } }`; a bad reference or option returns
`{ source: 'verification', failure }`. An unreachable RPC, wrong chain or wrong registry code never
discards the local result: it appears as `registryIdentity`/`chainStatus` `unknown` or `mismatch`
and a typed issue code.

## Result codes

Every public code, its cause and whether retrying can help is in
[`RESULT_CODES.md`](./RESULT_CODES.md) (generated; `pnpm sdk:check` fails if it drifts). In code:

```ts
import { describeResultCode } from '@lexaegis/sdk';

console.log(describeResultCode('report-issue', 'LIVE_RPC_UNAVAILABLE')?.retry); // "transient"
```

| Retry           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `no`            | The input or observation is final; repeating changes nothing.       |
| `after-fix`     | Correct input, configuration or policy first.                       |
| `transient`     | Network, provider or budget stopped the read; it may succeed later. |
| `informational` | Not a failure: it says what was not evaluated.                      |

## Entry points

| Entry point                  | Contents                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@lexaegis/sdk`              | Offline: protocol re-exports, `parseReviewExport`, `verifyOffline`, report schema, signer policies, result codes |
| `@lexaegis/sdk/portable`     | `parseReviewExport`, the export schema and limits                                                                |
| `@lexaegis/sdk/offline`      | `verifyOffline`, `VerificationReportV1`, `RegistryPolicy`, `expectedReviewersPolicy`                             |
| `@lexaegis/sdk/verify`       | Network-enabled `verifyReceipt` and `verifyReviewExport` (explicit transport, registry policy, 20 s budget)      |
| `@lexaegis/sdk/registry`     | Action builders and typed data (signing data only), registry ABI, strict decoding, live reader                   |
| `@lexaegis/sdk/transactions` | Reference-application transaction scope checks and monitoring. Not needed to verify anything.                    |

Offline and network operations are separate: nothing is requested unless you pass `live`.

## Trust rules

- The expected reference and the registry policy are **yours**; a bundle can never supply or change them.
- Without `expectedReference`, `verifyReviewExport` checks the file against its own declaration and
  marks it `file-declared`: that gives **no protection** against a bundle rewritten consistently.
- Without a signer policy, signer acceptance is `unknown`. `accepted` means only that the account meets
  the rule you selected.
- RPC calls carry only public data (addresses, block numbers, call data from a reviewer and a
  commitment). The opening, files, hashes and labels never leave your process.
- Action builders (`buildIssueAction`, `buildRevokeAction`, `buildSupersedeAction`) return **signing
  data only**; you supply an approval step, a supported signer and a transport. Preparing is not
  approving, signing is not confirmation.

Runnable usage: [`examples/document-review`](../../examples/document-review). Schemas:
`schemas/v1/verification-report.schema.json` and `registry-policy.schema.json`.
