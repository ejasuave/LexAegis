# Proof of Review protocol v1 test vectors

Language-neutral, **synthetic and public** vectors for implementing Proof of Review protocol v1 in
any language. Every address, document, decision and opening nonce is fictional; the nonces are fixed
only so results are reproducible and **must never be used in production** (production nonces come
from a cryptographically secure generator). The file holds no keys, signatures, provider replays or
private case material.

- `protocol-v1.json`: the vectors (`format: lexaegis.protocol-test-vectors/1`).
- `../../../docs/SPEC.md`: the specification they exercise.
- `../../../examples/python-verify/verify_vectors.py`: an independent, standard-library-only checker.

## Layout

| Field     | Meaning                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------- |
| `domains` | The two UTF-8 domain-separator strings.                                                           |
| `sources` | SHA-256 of the two files this asset is exported from.                                             |
| `goldens` | The three original independently generated cases (`generic`, `legal`, `legal-revised`), verbatim. |
| `cases`   | Operation cases (below).                                                                          |

Case metadata (`id`, `stage`, `operation`, `source`, `description`) sits beside the data and is never
part of a protocol envelope.

## Encodings

`input` and artifact values are `{ "encoding": "utf8" | "hex" | "base64", "value": "..." }`.

- `utf8`: the text is the exact input; encode it as UTF-8 without a byte-order mark.
- `hex`: lowercase, `0x`-prefixed raw bytes. Used where the input is not valid text (malformed UTF-8,
  a byte-order mark) so it survives storage.
- `base64`: standard padded base64 of exact artifact bytes.

Negative inputs are stored as raw text or bytes, so duplicate keys, escaped-equivalent keys, malformed
UTF-8 and lexical errors reach your parser unchanged. **Do not parse and re-serialize them.**

## Operations

| `operation`          | Input                                                | Expected                                                          |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `canonicalize-json`  | JSON text in the protocol subset                     | `canonicalUtf8Hex` (RFC 8785)                                     |
| `canonical-manifest` | an opening; canonicalize its `manifest`              | `canonicalUtf8Hex`                                                |
| `artifact-digest`    | artifact bytes                                       | `digest`: SHA-256 of the bytes                                    |
| `package-digest`     | canonical manifest bytes (hex)                       | `digest`: SHA-256(domain, `0x00`, bytes)                          |
| `commitment`         | `blindingNonce` and `packageDigest`                  | `commitment`: SHA-256(domain, `0x00`, nonce, digest)              |
| `parse-opening`      | an opening (raw)                                     | `outcome: ok`, or `error` with `stage` and `code`                 |
| `parse-reference`    | a receipt reference (raw)                            | as above                                                          |
| `verify-package`     | `opening`, supplied `artifacts`, `expectedReference` | `manifestIntegrity`, `artifactIntegrity` and the ordered `issues` |

`verify-package` is offline: it makes no network request and says nothing about a chain or a signer.
An error outcome from `verify-package` (a malformed expected reference) is reported as `outcome:
error` with the same `stage` and `code`.

## Stages

A negative case names the stage that must reject it. Implementations should reproduce the stage as
well as the code; failing at a different stage is not a pass.

| `stage`        | Codes that belong to it                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict-json`  | `INPUT_TOO_LARGE`, `INVALID_UTF8`, `BYTE_ORDER_MARK`, `INVALID_JSON`, `DUPLICATE_KEY`, `NESTING_TOO_DEEP`, `UNSAFE_NUMBER`, `LONE_SURROGATE`, `FORBIDDEN_KEY`                                                                                           |
| `version`      | `UNSUPPORTED_VERSION`; `SCHEMA_INVALID` when the `schema` member is missing or not a string                                                                                                                                                             |
| `schema`       | `UNKNOWN_FIELD`, `SCHEMA_INVALID`, `TOO_MANY_ARTIFACTS`, `ARTIFACT_TOO_LARGE`                                                                                                                                                                           |
| `cross-field`  | `DUPLICATE_ARTIFACT_ID`, `SOURCE_ARTIFACT_REQUIRED`, `DECISION_LOG_ARTIFACT_INVALID`, `DUPLICATE_SCOPE_ID`, `UNRESOLVED_ARTIFACT_REFERENCE`, `SCOPE_INCOMPLETE`, `DECISION_LOG_REFERENCE_INVALID`, `SUPERSEDES_CONTEXT_MISMATCH`, `ARTIFACTS_TOO_LARGE` |
| `verification` | the issue codes of `verify-package` (`COMMITMENT_MISMATCH`, `CONTEXT_MISMATCH`, `ARTIFACT_*`, `ARTIFACTS_NOT_EVALUATED`)                                                                                                                                |

Canonicalization cases (`stage: canonicalization`) test the RFC 8785 serializer on supplemental inputs
because closed manifests cannot exercise key sorting. They are separate from schema rejection: a
valid but non-canonical import (different whitespace or property order) is **not** an error, and the
`generic-import-*` cases show it verifies identically.

## What is not covered

Registry signatures and EIP-712 vectors are in `fixtures/registry-v1`. Nothing here verifies a chain
record, an account or a real-world review.

## Commands (repository)

```sh
pnpm vectors:export   # explicit: materialize protocol-v1.json from its two independent sources
pnpm vectors:check    # read-only drift check; never rewrites the asset
pnpm fixtures:check   # both source files reproduce from their independent generators
pnpm test:protocol    # TypeScript runs every case (also: pnpm test:protocol:browser)
```

Never edit the vectors by hand and never regenerate them to make a failing implementation pass: a
mismatch means the implementation changed a v1 rule.
