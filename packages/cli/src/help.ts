export const HELP = `proof-of-review: read-only Proof of Review verifier

Usage:
  proof-of-review verify <package-path> --chain-id <id> --registry <address>
                  [--expected-reference <reference.json>] [--deployment <file.json>]
                  [--rpc <url>] [--json]
  proof-of-review status --chain-id <id> --registry <address> --reviewer <address>
                  --commitment <0x...> [--deployment <file.json>] [--rpc <url>] [--json]
  proof-of-review --help | --version

verify checks a readable review export (ReviewExportV1): the files are the exact committed
bytes, and then the receipt's status is read from the registry. status reads a receipt's
status only; it never loads a package and says nothing about any file.

Trust inputs (all local, none taken from the package):
  --expected-reference  A receipt reference you obtained separately. Without it the file is
                        checked against its own declaration, labelled file-declared, which gives
                        no protection against a substituted package.
  --deployment          Trusted deployment metadata: a registry deployment record or a registry
                        policy. It must agree with --chain-id and --registry. A known public
                        deployment is built in; any other registry needs this file.
  --rpc <url>           HTTPS JSON-RPC endpoint. A URL containing a key can leak through
                        shell history and process listings: prefer PROOF_OF_REVIEW_RPC_URL.
                        Order: --rpc, then PROOF_OF_REVIEW_RPC_URL, then the public endpoint
                        recorded with a built-in deployment. A malformed choice is an error,
                        never replaced by the next source.
  --allow-loopback-http Permit http://127.0.0.1 for a throwaway local chain. Test use only.
  --json                One JSON result on stdout; diagnostics stay on stderr.

Optional agent identity (verify only; off unless asked, and never changes the exit code):
  --agent-identity      After the core checks match, read the ERC-8004 reference in the package's
                        agent-configuration artifact and look it up on the registry you trust. A
                        missing reference, notFound or a failure is a separate, non-fatal result.
                        The JSON document then uses lexaegis.cli-result-agent-identity.v1:
                        { core: <the unchanged result>, agentIdentity }.
  --agent-policy <file> The ERC-8004 deployment you trust (chain, genesis hash, Identity Registry).
                        Built in for the documented Monad testnet registry only.
  --fetch-agent-card    Also fetch the registered card (https, 5 s, 32 KiB, no redirects, DNS
                        pinned to public addresses). Needs --agent-card-origin <origin>, the exact
                        origin you allow. Card contents are self-declared claims, never verified.

Signer: this tool has no signer-policy editor. Signer requirements are reported as not evaluated;
use the SDK's signer policy if you need to decide whom to accept. A reviewer address selects a
record and does not certify the account.

Exit codes (first match wins):
  2   invalid command or options, contradictory configuration, or an unreadable input path
  10  the package fails full integrity or reference verification (malformed, incomplete or
      mismatched; the SDK code is kept in the result)
  20  registry or chain state cannot be trusted or obtained: wrong chain or registry, missing
      deployment pins, RPC failure, unknown status
  11  verified revoked receipt
  12  verified superseded receipt
  13  verified not found in the correct registry
  0   verify: complete matching package and an active receipt
      status: an active receipt (files are not evaluated)
  130 interrupted (SIGINT or SIGTERM)
Exit 0 never establishes signer acceptance, legal correctness or the reviewer's identity.
`;
