# Proof of Review and LexAegis

**Proof of Review** lets a person approve an exact package of AI-assisted work, so that a recipient can
check the same package independently, without trusting the application that produced it. A signing
account approved the committed package; the receipt does **not** establish that the work is correct,
that anyone was professionally qualified, or that a settlement is enforceable. **LexAegis** (employment
settlement review, England and Wales) is the first reference application. Everything below is about
the primitive unless it says otherwise.

```js
import { verifyReviewExport } from '@lexaegis/sdk/verify';
const result = await verifyReviewExport({ file, expectedReference, ...(live && { live }) });
console.log(result.ok ? result.data.report : result.error);
```

Those three lines are real and read-only, but `file`, `expectedReference` and `live` are not magic: the
complete runnable version below supplies them. `expectedReference` is the receipt reference you obtained
**separately** (never from the package), and `live` (a deployment record you trust plus a public endpoint)
is optional; without it no network request is made and the chain status is reported as `unknown`.

<!-- prettier-ignore -->
```js
import { readFile } from 'node:fs/promises';
import { verifyReviewExport } from '@lexaegis/sdk/verify';

const [bundle, reference, policyFile] = process.argv.slice(2);
const file = new Uint8Array(await readFile(bundle)); // the package you were sent
const expectedReference = JSON.parse(await readFile(reference, 'utf8')); // obtained separately, never from the package
// Optional registry read: only with a deployment record YOU trust and a public endpoint you choose.
const live =
  policyFile && process.env.PROOF_OF_REVIEW_RPC_URL
    ? {
        policy: JSON.parse(await readFile(policyFile, 'utf8')),
        transport: { kind: 'rpc', url: process.env.PROOF_OF_REVIEW_RPC_URL },
      }
    : undefined;
const result = await verifyReviewExport({ file, expectedReference, ...(live && { live }) });
if (!result.ok) throw new Error(result.error.source + ' ' + result.error.failure.code);
const { referenceOrigin, manifestIntegrity, artifactIntegrity, chainStatus, signerAcceptance } = result.data.report;
console.log(JSON.stringify({ referenceOrigin, manifestIntegrity, artifactIntegrity, chainStatus, signerAcceptance }));
```

This exact script runs in [`docs/QUICKSTART.md`](docs/QUICKSTART.md) against the packed packages
(`pnpm quickstart:check`). Nothing is hosted: every link on this page is a file in this repository, and
the packages are private and unpublished.

> A matching package with an active receipt shows that **these exact bytes** were committed by an
> account that authorized the commitment. It does not show that the content is true or legally correct,
> who holds the account, or that anyone qualified reviewed anything.

## For developers

| Need                                                                                   | Go to                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The exact rules (formats, hashes, registry, verification, limits)                      | [`docs/SPEC.md`](docs/SPEC.md) (`pnpm spec:check` keeps it honest)                                                                                                                   |
| Language-neutral test vectors                                                          | [`packages/protocol/test-vectors`](packages/protocol/test-vectors/README.md)                                                                                                         |
| An independent second implementation (Python, standard library only)                   | [`examples/python-verify`](examples/python-verify/README.md)                                                                                                                         |
| Get something running                                                                  | [`docs/QUICKSTART.md`](docs/QUICKSTART.md) (`pnpm quickstart:check` runs it)                                                                                                         |
| Why this and not a timestamp, an attestation, an e-signature trail or C2PA             | [`docs/WHY.md`](docs/WHY.md)                                                                                                                                                         |
| Protocol package                                                                       | [`packages/protocol`](packages/protocol/README.md)                                                                                                                                   |
| SDK (verification, registry data) and its [result codes](packages/sdk/RESULT_CODES.md) | [`packages/sdk`](packages/sdk/README.md)                                                                                                                                             |
| Read-only command `proof-of-review`                                                    | [`packages/cli`](packages/cli/README.md)                                                                                                                                             |
| A runnable generic integration (prepare, verify, issue, supersede)                     | [`examples/document-review`](examples/document-review/README.md)                                                                                                                     |
| Registry interface reference                                                           | [`contracts/REGISTRY_REFERENCE.md`](contracts/REGISTRY_REFERENCE.md)                                                                                                                 |
| API reference                                                                          | Generated: `pnpm docs:api`, then open `docs/api/index.html` (not committed)                                                                                                          |
| Embeddable status widget (local only; no hosted script)                                | [`packages/verify-embed`](packages/verify-embed/README.md) and its plain HTML page [`examples/embed`](examples/embed/README.md)                                                      |
| Second-domain example: sign-off on an AI-assisted pull request                         | [`examples/ai-pr-signoff`](examples/ai-pr-signoff/README.md) (team-authored)                                                                                                         |
| Independent verifier (standalone web app; no hosted URL is recorded)                   | [`apps/verifier`](apps/verifier)                                                                                                                                                     |
| The deployed registry and its records                                                  | [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md)                                                                                                                                         |
| Install trials and what they found; adoption plan; evidence log                        | [`docs/integration-trials.md`](docs/integration-trials.md), [`docs/adoption/ROADMAP.md`](docs/adoption/ROADMAP.md), [`docs/adoption/traction-log.md`](docs/adoption/traction-log.md) |

The packages are **private and unpublished**; install them from local tarballs
(`pnpm packages:build && pnpm packages:check`). The internally authored examples show technical
portability, not independent adoption, practitioner validation or production security. The widget and
the pull-request example were verified on a throwaway local chain; an operator-run Monad Testnet issue and
any live widget page are **NOT YET**. **No external trials recorded yet.** The traction log's entries read: **No entries yet**. An honest empty log
is not a failure, and it is not traction.

## Working in this repository

Node 24+ and pnpm 11. `pnpm install --frozen-lockfile`, then `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`. Gates: `pnpm fixtures:check`, `pnpm baselines:check`, `pnpm exclusion:check`,
`pnpm secrets:check`, `pnpm packages:check`, `pnpm docs:check`, `pnpm state:validate`, `pnpm readiness`.
Project status and evidence are recorded in [`docs/build-state.json`](docs/build-state.json).
