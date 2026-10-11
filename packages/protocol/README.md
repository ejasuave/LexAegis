# @lexaegis/protocol

Proof of Review protocol v1: strict parsing, canonical hashing, private commitments, offline package
verification and the portable review-bundle decoder. Pure functions for browsers and Node.js 24+: no
network, storage, environment or signing.

- `@lexaegis/protocol/v1` — `prepareReviewPackage`, `verifyManifestOpening`, `verifyReviewPackage`,
  `describeArtifact`, schemas and limits.
- `@lexaegis/protocol/portable` — `decodeReviewExport` (the readable `lexaegis.review-export.v1`
  bundle, bounded and strict) and base64url codecs.
- `schemas/v1/*.json` — generated JSON Schemas and the compact protocol descriptor, derived from the
  implementation (`pnpm protocol:check`).

A match shows that supplied bytes are the ones a receipt reference commits to. It does not show
that the content is correct or who the reviewer is. See `@lexaegis/sdk` for registry checks and
`examples/document-review` for a runnable integration.

## More

- Specification: [`docs/SPEC.md`](../../docs/SPEC.md). Test vectors: [`test-vectors/`](./test-vectors/README.md)
  (`pnpm vectors:check`), checked independently by [`examples/python-verify`](../../examples/python-verify/README.md).
- Using it: [`docs/QUICKSTART.md`](../../docs/QUICKSTART.md), [`packages/sdk`](../sdk/README.md),
  [`packages/cli`](../cli/README.md). API reference: `pnpm docs:api`.
