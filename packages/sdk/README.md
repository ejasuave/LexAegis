# @lexaegis/sdk

Framework-neutral Proof of Review SDK. Importing it performs no network request, environment or
storage access, wallet connection or signing.

| Entry point              | Contents                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `@lexaegis/sdk`          | Offline: protocol re-exports, `parseReviewExport`, `verifyOffline`, report schema, policies              |
| `@lexaegis/sdk/portable` | `parseReviewExport` and the bundle schema and limits                                                     |
| `@lexaegis/sdk/offline`  | `verifyOffline`, `VerificationReportV1`, `RegistryPolicy`, `expectedReviewersPolicy`                     |
| `@lexaegis/sdk/verify`   | Network-enabled `verifyReceipt` (explicit transport, registry policy, 20 s budget)                       |
| `@lexaegis/sdk/registry` | Action builders and typed data (signing data only), generated registry ABI, strict decoding, live reader |

Trust rules: the expected reference and the registry policy are the caller's; a bundle can never
supply or change them. Without a signer policy, signer acceptance is `unknown`. Live results rely on
the RPC endpoint you choose and are not a light-client proof. Action builders do not sign,
broadcast or imply human review.

Runnable usage: `examples/document-review`. Schemas: `schemas/v1/verification-report.schema.json`
and `registry-policy.schema.json` (`pnpm sdk:check`).
