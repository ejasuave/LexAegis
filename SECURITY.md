# Security

LexAegis is a **testnet demonstration**. It is **unaudited**, it uses **synthetic matters**, and it
is **not for client data**. Nothing in this repository is legal advice, a legal certification or a
claim of production readiness.

## What the evidence is, and is not

Five different kinds of evidence exist. None of them is an independent audit.

| Evidence                     | What it shows                                                                                        | What it does not show                                                 | Record                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Local tests                  | A named behaviour held for the tested source state, with synthetic keys and documents                | The absence of other faults; behaviour on a real device or provider   | [`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md)                         |
| Invariant and fuzz campaigns | No counterexample in the generated sequences against the unchanged registry                          | A proof; anything outside the modelled operations                     | [`docs/security/invariants.md`](./docs/security/invariants.md)           |
| Static analysis              | Every finding of the linter and the analyser is listed and triaged                                   | That the contract is free of vulnerabilities                          | [`docs/security/static-analysis.md`](./docs/security/static-analysis.md) |
| Deployment verification      | The deployed bytes are what this source compiles to (code correspondence), read through one endpoint | That the code is safe; a consensus proof                              | [`docs/DEPLOYMENTS.md`](./docs/DEPLOYMENTS.md)                           |
| Disclosure-boundary checks   | Planted synthetic canaries did not cross the tested boundaries in two local scripted journeys        | The absence of every encoding, side channel or same-origin compromise | [`docs/security/privacy-checks.md`](./docs/security/privacy-checks.md)   |

An explorer's "verified" label means source correspondence. It is not a statement about safety.

## Supported versions

There is no tagged release. Versions are named separately because they change separately.

| Layer       | Version                                                                                                          | Status                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Protocol    | Proof of Review protocol v1 ([`docs/SPEC.md`](./docs/SPEC.md)): schemas, commitment construction, EIP-712 domain | Frozen. A change is a new version, never an edit.                                                                         |
| Deployment  | One `ProofOfReviewRegistry` on Monad testnet, chain `10143`, `0x453bfd1602d8a8666f55bf9a8d87b127cb94048f`        | The only deployment. Runtime code matched this source on 2026-10-11. There is no mainnet deployment.                      |
| Packages    | `@lexaegis/protocol`, `@lexaegis/sdk`, `@lexaegis/cli` at `0.1.0`, built from this repository                    | Not published to a registry. Only the current `main` branch is maintained.                                                |
| Application | The reference web application and the standalone verifier on the current `main` branch                           | Runs locally with synthetic data. **A hosted reference deployment is NOT YET complete**; no hosted instance is supported. |

Forks, older commits and modified deployments are not maintained here.

## Scope

- **Registry**: `contracts/src` and the pinned OpenZeppelin code it compiles.
- **Protocol and SDK**: `packages/protocol`, `packages/sdk`.
- **Verifier and CLI**: `apps/verifier`, `packages/cli`. Both are read-only.
- **Account and vault integration**: passkey-derived account, the browser vault (`packages/vault`,
  `apps/web/src/features/account`, `apps/web/src/features/vault`).
- **Analysis and approval boundary**: the assistant (`packages/agent`, `apps/web/src/server/assistant`)
  and the human approval flow. A model proposes; only a person's click approves, signs or confirms.
- **Reference application**: `apps/web`.

Optional agent identity (ERC-8004) is **discovery only**. Its presence or absence does not change
whether a receipt is valid, and it is not the reviewer, the model or a qualification. No agent is
registered.

## Limits you should know

1. **Public activity is linkable.** Receipts are published from one account. The account, the times
   and the receipt history are public and permanent.
2. **Verifying means disclosing.** A recipient who verifies a package receives the whole supplied
   package, including the opening.
3. **Analysis sees plaintext.** Text you select and send is readable by the LexAegis server and by
   the model provider (Qwen) for that request. Each excerpt also carries its source reference to
   the server: document identifiers, page, position and the SHA-256 of the file and of its extracted
   text. The digests are not passed to the provider. Sending cannot be undone.
4. **Hashes bind bytes.** A commitment shows that these exact bytes were approved. It does not show
   that they are true, complete or legally correct.
5. **Approval is by a signing account.** It is not proof of a professional qualification and it is
   not a signature of the settlement agreement.
6. **Same-origin compromise.** A script running on the application origin can read unlocked material
   and use a live signing session. An application session is not hardware isolation.
7. **Passkeys.** A passkey is bound to its origin and authenticator. Losing every authenticator loses
   the account and the vault key. Recovery depends on the authenticator's own backup.
8. **RPC trust.** Registry reads come from an RPC endpoint. One endpoint can lie consistently; a read
   is an observation, not a consensus proof. When a read fails, the result is `unknown`.
9. **External disclosures are irreversible.** Stop cannot recall plaintext already sent, a signature
   already disclosed or a transaction already broadcast.
10. **Old snapshots.** An encrypted old vault snapshot can be replayed to a browser that never saw a
    newer one.

The full list of abuse cases, with the test for each and the cases that have no test yet, is in
[`docs/THREAT-MODEL.md`](./docs/THREAT-MODEL.md).

## Known unresolved issues

- **No deployable signer.** The signers used in development cannot enter production. This blocks a
  hosted deployment.
- **Hosted reference deployment: NOT YET.**
- **Real-device evidence is incomplete.** One operator-reported account check on a real passkey
  passed; the real-device vault check is recorded as failed because recovery on a second device and
  export/import were not shown. Every automated browser test uses a virtual authenticator.
- **Monadscan source verification: NOT YET** (no API key configured). Sourcify verification is
  recorded in [`docs/DEPLOYMENTS.md`](./docs/DEPLOYMENTS.md).
- **Unread response bodies in the disclosure checks.** A response whose request was cut off by a
  navigation, a lock or Stop has no complete body to inspect; these are listed as unobserved in
  [`docs/security/privacy-checks.md`](./docs/security/privacy-checks.md).
- Threat-model cases marked `NO TEST YET` remain uncovered.

No finding of the static analysis or of the invariant campaigns requires a change to the deployed
registry.

## Reporting a vulnerability

**Private reporting contact: NOT YET.** This repository has no private security reporting channel
configured (no security policy URL and no private vulnerability reporting). Until one is published
here, **please do not put sensitive details in a public issue**. Open an issue that says only that
you have a security report, and wait for a private route to be supplied.

No response time, reward or legal safe harbour is promised.

When a private route exists, a useful report contains:

- the affected version or commit and the environment (browser, operating system, network);
- the impact;
- a minimal reproduction that uses **synthetic** data.

Do not include client documents, commitment openings, keys, session tokens or usable signatures. Do
not test against other users or their data, and do not cause disruption to demonstrate a report.
