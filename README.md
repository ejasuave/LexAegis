# Proof of Review and LexAegis

**Proof of Review** is a primitive: a person approves an exact package of AI-assisted work, and anyone
can verify that package **without trusting the application that produced it**. **LexAegis** is the
reference application (employment settlement review, England and Wales). Everything below is about the
primitive unless it says otherwise.

> A matching package with an active receipt shows that **these exact bytes** were committed by an
> account that authorized the commitment. It does not show that the content is true or legally correct,
> who holds the account, or that anyone qualified reviewed anything.

## For developers

| Need                                                                                   | Go to                                                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The exact rules (formats, hashes, registry, verification, limits)                      | [`docs/SPEC.md`](docs/SPEC.md) (`pnpm spec:check` keeps it honest)           |
| Language-neutral test vectors                                                          | [`packages/protocol/test-vectors`](packages/protocol/test-vectors/README.md) |
| An independent second implementation (Python, standard library only)                   | [`examples/python-verify`](examples/python-verify/README.md)                 |
| Get something running                                                                  | [`docs/QUICKSTART.md`](docs/QUICKSTART.md) (`pnpm quickstart:check` runs it) |
| Why this and not a timestamp, an attestation, an e-signature trail or C2PA             | [`docs/WHY.md`](docs/WHY.md)                                                 |
| Protocol package                                                                       | [`packages/protocol`](packages/protocol/README.md)                           |
| SDK (verification, registry data) and its [result codes](packages/sdk/RESULT_CODES.md) | [`packages/sdk`](packages/sdk/README.md)                                     |
| Read-only command `proof-of-review`                                                    | [`packages/cli`](packages/cli/README.md)                                     |
| A runnable generic integration (prepare, verify, issue, supersede)                     | [`examples/document-review`](examples/document-review/README.md)             |
| Registry interface reference                                                           | [`contracts/REGISTRY_REFERENCE.md`](contracts/REGISTRY_REFERENCE.md)         |
| API reference                                                                          | Generated: `pnpm docs:api`, then open `docs/api/index.html` (not committed)  |
| Embeddable verification widget                                                         | **NOT YET** (Chapter 18)                                                     |

The packages are **private and unpublished**; install them from local tarballs
(`pnpm packages:build && pnpm packages:check`). The internally authored examples show technical
portability, not independent adoption, practitioner validation or production security.

## Working in this repository

Node 24+ and pnpm 11. `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`. Gates: `pnpm fixtures:check`, `pnpm baselines:check`, `pnpm exclusion:check`,
`pnpm secrets:check`, `pnpm packages:check`, `pnpm docs:check`, `pnpm state:validate`, `pnpm readiness`.
Project status and evidence are recorded in [`docs/build-state.json`](docs/build-state.json).
