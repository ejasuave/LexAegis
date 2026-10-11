# @lexaegis/cli: `proof-of-review`

A **read-only** command-line verifier for Proof of Review. It checks that an exported review
package is the exact bytes a reviewer committed, and reads the receipt's status from the registry.

It never asks for, loads or uses a private key, never signs or sends a transaction, calls no model
and needs no application login. There is no `issue`, `revoke` or `supersede` command. To create
receipts use the SDK with your own signer (see `docs/QUICKSTART.md`).

> Status: version `0.1.0`, **private and unpublished**. Install the packed tarballs
> (`pnpm packages:build && pnpm packages:check` does this in a clean directory). In the repository,
> `pnpm cli <command> ...` runs the same code from source.

## Commands

```text
proof-of-review verify <package-path> --chain-id <id> --registry <address>
                [--expected-reference <reference.json>] [--deployment <file.json>]
                [--rpc <url>] [--json]
proof-of-review status --chain-id <id> --registry <address> --reviewer <address>
                --commitment <0x...> [--deployment <file.json>] [--rpc <url>] [--json]
```

- `verify` reads a readable export (`ReviewExportV1`) through the SDK's strict, bounded decoder
  (48 MiB), runs full integrity and reference checks, **then** reads the registry. An artifact label
  is never used as a path, no URL in the file is fetched, nothing is extracted or repaired. If the
  package fails, the registry is not contacted.
- `status` builds a public reference from your arguments and reads its status. It loads no package
  and says nothing about any file (`filesEvaluated: false`). `--reviewer` selects a record; it does
  not certify the account.

## Trust inputs: all yours, none from the package

| Input                  | Purpose                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--expected-reference` | A `ReceiptReferenceV1` you obtained separately. Its chain and registry must equal `--chain-id` / `--registry`. Without it the file is checked against its own declaration, labelled `file-declared`: **no protection** against a package rewritten consistently. |
| `--deployment`         | A registry deployment record (`lexaegis.registry-deployment.v1`, with a genesis pin) or a registry policy. It must agree with `--chain-id` and `--registry`.                                                                                                     |
| built-in deployment    | The verified public Monad Testnet deployment ships in this build. Any other registry needs `--deployment`: **an address that merely answers an RPC call is not registry identity.**                                                                              |
| `--rpc`                | HTTPS JSON-RPC endpoint. No query string, fragment or user info is accepted, redirects are refused, credentials and referrers are not sent.                                                                                                                      |

RPC precedence: `--rpc`, then `PROOF_OF_REVIEW_RPC_URL`, then the public endpoint recorded with
the built-in deployment (and only for it). There is no other default, and a malformed choice is an
error, never silently replaced. **A key inside an `--rpc` URL can leak through shell history and
process listings; prefer the environment variable.** Errors and results never print the endpoint.

`--allow-loopback-http` permits `http://127.0.0.1` for a throwaway local chain. Test use only.

## Exit codes

First match wins. Meanings are specific to this command.

| Code  | Meaning                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `2`   | Invalid command or options, contradictory configuration, or an unreadable input path.                                                 |
| `10`  | The package fails full integrity or reference verification. The SDK code (malformed, incomplete, mismatched) is kept in the result.   |
| `20`  | Registry or chain state cannot be trusted or obtained: wrong chain or registry, missing deployment pins, RPC failure, unknown status. |
| `11`  | Verified **revoked** receipt.                                                                                                         |
| `12`  | Verified **superseded** receipt. The replacement is a separate receipt: check it separately.                                          |
| `13`  | Verified **not found** in the correct registry.                                                                                       |
| `0`   | `verify`: a complete matching package and an **active** receipt. `status`: an **active** receipt (files not evaluated).               |
| `130` | Interrupted (SIGINT or SIGTERM). A shell convention, not a verification result.                                                       |

**Exit 0 never establishes signer acceptance, legal correctness, the reviewer's identity or that a
professional reviewed anything.** Signer requirements are always reported as `not_evaluated`: this
tool has no signer-policy editor. Use the SDK's signer policy when you need to decide whom to accept.
A result is an observation at its checkpoint, not a certificate: a later revocation or replacement
can follow.

## Output

Text goes to stdout (diagnostics for usage errors go to stderr). With `--json` one document is
written to stdout, also for usage errors, so a script can always parse it:

```json
{
  "schema": "lexaegis.cli-result.v1",
  "command": "verify",
  "exit": { "code": 0, "meaning": "active" },
  "filesEvaluated": true,
  "signerRequirements": "not_evaluated",
  "rpcSource": "flag",
  "report": { "...": "an allowlisted projection of VerificationReportV1" },
  "error": null
}
```

`report` holds the SDK's separate dimensions (`manifestIntegrity`, `artifactIntegrity`,
`registryIdentity`, `receiptBinding`, `chainStatus`, `signerAcceptance`), the checkpoint and the
issue **codes** only. It never contains artifact IDs, labels, hashes, openings, the profile, stack
traces or an endpoint, and there is no combined `valid` field. Numbers are decimal strings. In text
mode every dynamic value is escaped so a hostile value cannot control your terminal.

CLI-only error codes (`error.source: "cli"`) are listed in `src/exit.ts`; SDK and protocol codes
are passed through unchanged (see the SDK's `RESULT_CODES.md`).

## Examples

```sh
# Local integrity plus a live read, with a reference you got separately
export PROOF_OF_REVIEW_RPC_URL='https://testnet-rpc.monad.xyz/'
proof-of-review verify review-export.json --chain-id 10143 \
  --registry 0x453bfd1602d8a8666f55bf9a8d87b127cb94048f --expected-reference expected.json --json
echo "exit=$?"   # do not swallow a nonzero exit: 11, 12, 13, 10 and 20 are results

# Optional ERC-8004 agent identity sidecar (off by default; never changes the exit code)
proof-of-review verify review-export.json --chain-id 10143 --registry 0x453b... --agent-identity --json
# --agent-policy <file>: the ERC-8004 deployment you trust (built in: documented Monad testnet only)
# --fetch-agent-card --agent-card-origin https://host: also fetch the card (5 s, 32 KiB, no redirects)
# JSON becomes lexaegis.cli-result-agent-identity.v1 { core: <unchanged result>, agentIdentity }

# Status only
proof-of-review status --chain-id 10143 --registry 0x453b... --reviewer 0x... --commitment 0x...
```

See also: [`docs/QUICKSTART.md`](../../docs/QUICKSTART.md) path 2, [`docs/SPEC.md`](../../docs/SPEC.md) section 9
(what each verification field means) and the [SDK result codes](../sdk/RESULT_CODES.md).
