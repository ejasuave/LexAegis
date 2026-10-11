# Proof of Review quickstart

Three ways to use Proof of Review, each with real, tested commands:

1. **Verify a review package with the SDK** (read-only).
2. **Verify it with the command-line tool** (read-only).
3. **Prepare, issue and supersede** through the SDK with a signer you supply.

Everything below uses **synthetic** documents. The packages are not published yet, so you install them
from tarballs built in this repository. `pnpm quickstart:check` runs every command in this guide from a
clean directory and fails if one stops working or its output changes (see
[What was measured](#what-was-measured)).

> **A signature or a receipt is not a verdict.** A matching package with an active receipt shows that
> these exact bytes were committed by an account that authorized the commitment. It does not show that
> the contents are true or legally correct, who holds the account, or that anyone qualified reviewed
> anything. See [`SPEC.md`](./SPEC.md) section 11.

## Prerequisites

| Need                                     | Version used (measured)                        | Why                                                 |
| ---------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Node.js                                  | 24.x (24.21.0)                                 | The packages are ESM and need `engines.node >= 24`. |
| pnpm                                     | 11.x (11.11.0)                                 | Builds and packs the tarballs, installs them.       |
| A checkout of this repository, installed | `pnpm install --frozen-lockfile`               | Source of the tarballs and of the example you copy. |
| Foundry (path 3 only)                    | 1.8.5, installed by `pnpm contracts:toolchain` | A local chain for the issue and supersede demo.     |

No Python, no wallet, no key and no account are needed for paths 1 and 2. Installing the third-party
packages (`viem`, `zod` and others) needs the npm registry, or a pnpm store that already has them; the
automated check uses the repository's offline store. A **fabricated placeholder address is never a live
deployment**: the registry below, `0x5555…5555`, is only a placeholder.

## Set up a clean directory

Run from the repository root.

```sh quickstart:setup install
export REPO="$PWD"
export QS="$(mktemp -d)"
pnpm packages:build
mkdir "$QS/tarballs"
for package in protocol sdk cli; do pnpm --dir "packages/$package" pack --pack-destination "$QS/tarballs"; done
ls "$QS/tarballs"
```

```text quickstart:expect:setup
lexaegis-cli-0.1.0.tgz
lexaegis-protocol-0.1.0.tgz
lexaegis-sdk-0.1.0.tgz
```

Install the three tarballs. The `overrides` make the packages' own dependency on each other resolve to
the tarballs as well, never to a registry. `tsx` runs the TypeScript example without a build step.

```sh quickstart:install install
cd "$QS"
cat > package.json <<'JSON'
{
  "name": "quickstart",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lexaegis/protocol": "file:./tarballs/lexaegis-protocol-0.1.0.tgz",
    "@lexaegis/sdk": "file:./tarballs/lexaegis-sdk-0.1.0.tgz",
    "@lexaegis/cli": "file:./tarballs/lexaegis-cli-0.1.0.tgz",
    "viem": "2.57.3"
  },
  "devDependencies": { "tsx": "4.23.15" }
}
JSON
printf "overrides:\n  '@lexaegis/protocol': file:./tarballs/lexaegis-protocol-0.1.0.tgz\n  '@lexaegis/sdk': file:./tarballs/lexaegis-sdk-0.1.0.tgz\n" > pnpm-workspace.yaml
pnpm install ${QS_PNPM_FLAGS:-}
ls node_modules/.bin/proof-of-review
```

```text quickstart:expect:install
node_modules/.bin/proof-of-review
```

## Get a sample package

The document-review example builds a synthetic package with a **fresh random opening each run** and
writes the readable export plus the **public** receipt reference. The reference is what the reviewer
would hand you separately; the export is the private file with the documents in it.

```sh quickstart:sample install
cd "$QS"
mkdir -p example && cp -r "$REPO/examples/document-review/src" example/src && rm -f example/src/*.test.ts
for name in sample sample-other; do
  pnpm exec tsx example/src/cli.ts prepare --out "$name" --chain-id 10143 \
    --registry 0x5555555555555555555555555555555555555555 \
    --reviewer 0x2222222222222222222222222222222222222222 > /dev/null
done
ls sample
```

```text quickstart:expect:sample
receipt-reference.json
review-export.json
```

`sample-other` is a second, different package. We use it to show a substitution being caught.

## Path 1: verify with the SDK

`verifyReviewExport` decodes the file strictly, checks every file's exact bytes against the receipt
reference **you** supply, and, only if you pass `live`, reads the registry. This first run is local: no
request is made.

```sh quickstart:path1 execute
cd "$QS"
cat > verify-local.mjs <<'JS'
import { readFile } from 'node:fs/promises';
import { verifyReviewExport } from '@lexaegis/sdk/verify';

const [bundle, reference] = process.argv.slice(2);
const file = new Uint8Array(await readFile(bundle));
const expectedReference = JSON.parse(await readFile(reference, 'utf8'));
const result = await verifyReviewExport({ file, expectedReference });
if (!result.ok) throw new Error(result.error.source + ' ' + result.error.failure.code);
const { referenceOrigin, manifestIntegrity, artifactIntegrity, chainStatus, signerAcceptance } = result.data.report;
console.log(JSON.stringify({ referenceOrigin, manifestIntegrity, artifactIntegrity, chainStatus, signerAcceptance }));
JS
node verify-local.mjs sample/review-export.json sample/receipt-reference.json
node verify-local.mjs sample-other/review-export.json sample/receipt-reference.json
```

```text quickstart:expect:path1
{"referenceOrigin":"independent","manifestIntegrity":"match","artifactIntegrity":"match","chainStatus":"unknown","signerAcceptance":"unknown"}
{"referenceOrigin":"independent","manifestIntegrity":"mismatch","artifactIntegrity":"unknown","chainStatus":"unknown","signerAcceptance":"unknown"}
```

Read the two lines separately, never as one verdict:

| Field               | First line (the right package)             | Second line (a different package)                            |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `manifestIntegrity` | `match`: opens the reference you hold      | `mismatch`: it is not the receipt you expected               |
| `artifactIntegrity` | `match`: every file is the committed bytes | `unknown`: files are not evaluated once the manifest differs |
| `chainStatus`       | `unknown`: no registry was read            | `unknown`                                                    |
| `signerAcceptance`  | `unknown`: you gave no signer policy       | `unknown`                                                    |

The second package is internally consistent and would pass a check against **its own** reference. Only
the reference you obtained separately catches it. The SDK labels a check that used the file's own
declaration `file-declared`, and that gives no such protection.

### Reading the registry as well (not run by the automated check)

This needs a registry deployment you trust, an HTTPS RPC endpoint and a real receipt. For Monad
Testnet the verified deployment is recorded in `contracts/deployments/monad-testnet.json`; its policy is
generated for the CLI and verifier by `pnpm verifier:policy`. The ten-line example in the
[SDK README](../packages/sdk/README.md) shows the call. Live reads are observations at a block, and an
unreachable endpoint leaves the local result intact with `chainStatus: unknown`, never `not_found`.

## Path 2: verify with the installed command

```sh quickstart:path2 execute
cd "$QS"
export PATH="$QS/node_modules/.bin:$PATH"
proof-of-review --version
set +e
proof-of-review verify sample/review-export.json --chain-id 10143 \
  --registry 0x5555555555555555555555555555555555555555 \
  --expected-reference sample/receipt-reference.json --json > result.json
echo "exit=$?"
node -e "const r = JSON.parse(require('node:fs').readFileSync('result.json', 'utf8')); console.log(r.report.manifestIntegrity, r.report.artifactIntegrity, r.report.chainStatus, r.error.code)"
proof-of-review verify sample-other/review-export.json --chain-id 10143 \
  --registry 0x5555555555555555555555555555555555555555 \
  --expected-reference sample/receipt-reference.json --json > /dev/null
echo "exit=$?"
proof-of-review verify sample/review-export.json --chain-id 10143 \
  --registry 0x5555555555555555555555555555555555555555 \
  --expected-reference sample/receipt-reference.json
echo "exit=$?"
```

```text quickstart:expect:path2
0.1.0
exit=20
match match unknown DEPLOYMENT_PINS_MISSING
exit=10
receipt status      unknown
exit 20 (chain_untrusted)
```

**Do not swallow a nonzero exit: here it is the answer.** The registry `0x5555…` is a placeholder with
no trusted deployment, so no live read can honestly run: the command exits **20** and still reports the
local result (`match match`). The substituted package exits **10**. `--json` writes one parseable
document to stdout; the text form shows the same separated fields. Exit codes (first match wins):

| Code | Meaning                                                                                |
| ---- | -------------------------------------------------------------------------------------- |
| `2`  | Invalid command or options, contradictory configuration, or an unreadable input path.  |
| `10` | The package fails full integrity or reference verification.                            |
| `20` | Registry or chain state cannot be trusted or obtained (no pins, RPC failure, unknown). |
| `11` | Verified revoked. `12` verified superseded. `13` verified not found.                   |
| `0`  | `verify`: complete matching package and an **active** receipt.                         |

Exit 0 never establishes signer acceptance, legal correctness or who the reviewer is. The tool has no
signer-policy editor and no command that signs, issues or sends. Full reference: the
[CLI README](../packages/cli/README.md).

### Reading a real registry (not run by the automated check)

```sh
export PROOF_OF_REVIEW_RPC_URL='https://testnet-rpc.monad.xyz/'
proof-of-review verify review-export.json --chain-id 10143 \
  --registry 0x453bfd1602d8a8666f55bf9a8d87b127cb94048f --expected-reference expected.json
echo "exit=$?"
```

Prefer the environment variable to `--rpc`: a key inside a URL leaks through shell history and
process listings. The command refuses a URL with a key in it.

### Optional: agent identity (not run by the automated check)

Add `--agent-identity` to `verify` to read the package's ERC-8004 reference (if any) and look it up on
the registry you trust. A package without one reports "not included", not a failure. Card fetching
needs `--fetch-agent-card --agent-card-origin <origin>`. See the [CLI README](../packages/cli/README.md).

### Embeddable widget: NOT YET

There is no embeddable verification widget yet (Chapter 18). No snippet or URL is offered here, because
none would work. Use the command above or the SDK.

## Path 3: prepare, issue and supersede with your own signer

This path is **not** part of the read-only command. It is the SDK, driven by the example in
[`examples/document-review/src/lifecycle.ts`](../examples/document-review/src/lifecycle.ts). The rules
it enforces, in this order:

1. **Preparing is not approving.** `prepareExample` returns an immutable, unapproved snapshot.
2. **The opening is stored before anything is published** (`OpeningStore`), and reused for every retry.
   Losing it makes a published receipt unverifiable.
3. **Reconcile first.** A verified registry read must show no record yet. After a lost response a retry
   reports `already_recorded` and sends nothing.
4. **Read the reviewer's registry counter and the chain time**, and choose a bounded deadline with the
   SDK's `defaultActionDeadline` (600 seconds from chain time).
5. **Signing is not confirmation, and sending needs explicit approval.** Your `approve` callback is
   required and shown the exact action, nonce, deadline and fee ceiling. There is no default `true`.
6. **Success is read back**, never inferred from a transaction hash. After a replacement the old receipt
   must read `superseded` and the new one `active`; revoking a replacement later never reactivates the
   old one.
7. **A replacement has real revised source bytes, a fresh opening and names the exact predecessor.**

You supply the signer by adapting your own wallet. This adapter is the file
`examples/document-review/src/signer-adapter.ts`:

```ts quickstart:file examples/document-review/src/signer-adapter.ts
export function signerFromAccount(
  account: Pick<LocalAccount, 'address' | 'signTypedData'>,
): ReviewSigner {
  return {
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData),
  };
}
```

`account` is whatever viem gives you for your wallet: a hardware or keystore account, or a JSON-RPC
wallet that shows the typed data to its owner. **No key is embedded in this repository, passed as an
argument or read from the environment by the example.** Chain access (reading the counter, estimating,
sending, waiting) is the second thing you supply; `viem-access.ts` implements it over viem clients.

### Run it locally (no real network, no real key)

The example runs against the unchanged registry on a throwaway local chain with a **test-only** signer
that exists only in the test harness. This is the same code you would run with a real signer, composed
with a local chain.

```sh quickstart:path3 execute
cd "$REPO"
pnpm contracts:toolchain
pnpm --filter @lexaegis/contracts exec tsx scripts/foundry.ts forge build
pnpm --filter @lexaegis/contracts exec vitest run --config vitest.config.ts integration/quickstart.anvil.test.ts
```

```text quickstart:expect:path3
Tests  8 passed (8)
```

The eight tests confirm, against real contract records: issue (opening stored, approval asked, sent,
read back `active`), a retry that sends nothing, a refused approval that consumes no nonce, refusals
before any send (opening not stored, signer is not the reviewer, fee above the ceiling), supersede
(`superseded` + `active`, and the predecessor stays `superseded` after the replacement is revoked), and
the refusals around a predecessor that is not active.

**Running against a public network is manual and opt-in.** It needs your own reviewer account, funds
for the fee and a deployment you trust, and it is deliberately outside every automated check. Do not run
it until you have read what an on-chain receipt discloses: the reviewer account, the commitment and the
action are public and permanent.

## What was measured

`pnpm quickstart:check` runs the commands above from a clean directory and writes
[`evidence/chapter15-quickstart-2026-10-11.json`](./evidence/chapter15-quickstart-2026-10-11.json):
date, versions, environment, source revision, outcome, and **separate** times for installation, local
execution and manually performed live steps. Installation time depends on your machine and store, so
no total is promised here.

| Item                                             | Status                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Author-run, automated clean install              | Recorded in the evidence file (the author's machine, an offline pnpm store).             |
| Someone other than the author follows this guide | **NOT YET.** It needs a real participant with their permission. No feedback is invented. |
| Live steps against a public network              | Not performed by any check.                                                              |
| Embeddable widget                                | **NOT YET** (Chapter 18).                                                                |

An authored example shows technical portability. It is not independent adoption, practitioner
validation, a production security review or an award.
