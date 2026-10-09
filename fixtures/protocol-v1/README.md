# Protocol v1 test vectors

`vectors.json` holds literal expected values for three **synthetic** review packages:

| Case            | What it covers                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| `generic`       | A non-legal package; a non-ASCII label; CRLF and irregular-whitespace artifacts |
| `legal`         | Structurally complete for `lexaegis.employment-settlement.ew` version 1         |
| `legal-revised` | A revised source document that declares `legal` as its predecessor              |

Each case carries the exact artifact bytes (base64), the private opening, and the expected
canonical manifest bytes, artifact digests, package digest, commitment and public reference.

## Rules

- **Independent generation.** `generate.mjs` never imports `@lexaegis/protocol` or anything under
  `packages/` (ESLint enforces this). It uses Node's `crypto`, the separately authored
  `json-canonicalize` library and its own minimal serializer, and refuses to write unless the two
  serializers agree. Its domain strings are literals, not the implementation's constants.
- **Never edit `vectors.json` by hand and never regenerate it to make a failing test pass.** A
  mismatch means the implementation changed the wire format, which needs a new protocol version.
- **Test-only values.** Addresses, documents and decisions are fictional. The blinding nonces are
  fixed so results are reproducible; production nonces always come from the platform CSPRNG.
  Nothing here is a real approval, a model run or an on-chain receipt.

## Commands

```sh
pnpm fixtures:check          # vectors.json is reproducible from generate.mjs
pnpm fixtures:generate       # rewrite vectors.json (only when deliberately adding cases)
pnpm test:protocol           # run the vectors in Node.js
pnpm test:protocol:browser   # run the same vectors in real Chromium
```
