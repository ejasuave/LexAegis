# Why Proof of Review, and how it differs

Proof of Review binds **an exact package of work** to **a reviewer account's authorization** and lets a
recipient check both **without trusting the application that produced them**. This page compares it
with four things people reach for first, fairly, and says what it does not do. External facts were
read from the primary documents listed in the [evidence appendix](#evidence-appendix) on **2026-10-11**;
anything I could not read there is marked **NOT YET** instead of filled in from memory.

> It does not prove that a document is correct or lawful, who the account holder is, that anyone
> qualified, or that a human really reviewed it. It is **not** legal advice or a compliance,
> certification or enforceability claim. Claims about Proof of Review below come from
> [`SPEC.md`](./SPEC.md) and the tests it names, not from marketing.

## The problem it addresses

A team uses software (often AI-assisted) to prepare work, and a person approves it. Later, someone else
must be able to answer, **independently**:

- Is this the exact set of files the reviewer approved, with nothing added, removed or changed?
- Which account authorized that, and has the authorization since been revoked or replaced?
- Can I check this myself, with my own trust choices, if the original vendor disappears?

## Comparison

|                                                   | What is bound                                                                                                            | Who interprets the claim                                    | Lifecycle                                                            | Recipient verification                                                                                                                 | Disclosure                                                                      | Integration effort                                     | What it does better                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Hash-and-timestamp** (RFC 3161, OpenTimestamps) | A hash of a datum, and a time                                                                                            | Nobody: it states only that the datum existed before a time | None: a token does not change                                        | Verify the token's signature and the authority's certificate (RFC 3161 §2.2 and Appendix B), or a Bitcoin attestation (OpenTimestamps) | The service sees a hash only                                                    | Low                                                    | Independent time evidence; the authority never sees the data (RFC 3161 §2.1)                            |
| **Generic on-chain attestations** (EAS)           | Whatever a schema defines, made by an attester                                                                           | The schema's consumers                                      | Not established from the sources read (see appendix)                 | Read the attestation from the chain                                                                                                    | Per the README these are on-chain attestations                                  | Medium                                                 | A general, reusable attestation format and registry                                                     |
| **E-signature audit trails**                      | NOT YET (no primary document could be read)                                                                              |                                                             |                                                                      |                                                                                                                                        |                                                                                 |                                                        |                                                                                                         |
| **Content credentials** (C2PA 2.2)                | An asset, through a hard binding hash in a signed claim, plus assertions                                                 | The signer, and the validator's trust lists                 | Assertions such as actions can be recorded in the manifest (§2.3.1)  | A validator checks the signature chain, trust anchors and the binding (§15.7, §9.1)                                                    | Not established from the sections read                                          | Medium to high                                         | Provenance for media assets, standardized validation outcomes, a trust-anchor model                     |
| **Proof of Review**                               | Every file of a package (exact bytes), its manifest, reviewer, chain and an optional predecessor, through one commitment | The **recipient**, through caller-owned trust inputs        | Issue, revoke, supersede, with terminal states and replacement links | Offline byte checks, then an optional read-only registry check; separate result per dimension                                          | The commitment is public and does not encrypt; an export discloses its contents | One SDK, one read-only CLI, a documented specification | Package-level binding, reviewer-scoped lifecycle, verification that needs no wallet, backend or account |

### Reading the table fairly

- **Hash-and-timestamp** gives something Proof of Review does not: _independent_ evidence of **when**.
  RFC 3161 §2.1 requires the authority to time-stamp only a hash and not to examine it, and §1 describes
  the purpose as supporting "assertions of proof that a datum existed before a particular time".
  OpenTimestamps states the same limit of claim: "A timestamp proves that some data existed prior to
  some point in time." A timestamp says nothing about **who** authorized the data or whether it was
  later replaced. A registry action's block time is a chain observation, not a trusted-time authority.
- **EAS** is a general attestation protocol: its README describes "a free and open protocol for
  on-chain attestations on EVM compatible blockchains" where anyone can define a schema. It is broader
  than Proof of Review, which fixes one schema (a review package) and one verification procedure.
  What EAS does about revocation, expiry and off-chain attestations could not be established from the
  sources read (see appendix) and no comparison is drawn.
- **C2PA** is built for **provenance of media assets**: a signed claim with a hard binding hash, signed
  by a claim signer identified by a credential, validated against trust lists (spec §§1.3, 2.3, 9.1,
  15.7). It records how an asset was made and edited. It is a different problem from approving a
  multi-file review package, and C2PA's trust-list model is more developed than anything here.
- **E-signature products** record signing events and signer authentication for a transaction; they are
  **not** evidence about the review of a work product, and an e-signature, a professional credential, a
  provenance record and a review-package approval must not be conflated. **NOT YET:** I could not read
  a primary document for any vendor's audit trail, so no claim about one is made. Absence from
  documentation I could not read is not evidence that a feature is absent.

## What Proof of Review actually provides

From [`SPEC.md`](./SPEC.md) and its checks (`pnpm spec:check`, the vectors, the SDK and CLI tests):

1. **Exact package binding.** A commitment covers every artifact's exact original bytes and the
   manifest (reviewer, chain, registry, predecessor). Any change to a byte changes the result. A
   reordered, truncated, re-serialized or substituted file fails.
2. **Reviewer-scoped lifecycle on a registry.** The reviewer's signed action issues, revokes or
   supersedes a receipt. Revoked and superseded are terminal; revoking a replacement never reactivates
   the original. The transaction sender has no authority.
3. **Independent verification under explicit trust assumptions.** Offline checks come first and are
   never discarded; the registry check is read-only; the recipient supplies the expected reference, the
   registry deployment they trust and, if they want one, a signer rule. Results are separate fields with
   no combined `valid`, and an unreachable network is `unknown`, never "not found".
4. **A second implementation agrees.** A standard-library Python program reproduces every published
   digest and rejection from the specification (`pnpm interop:python`).

## What it does not do

No selective disclosure or redaction proofs, no zero-knowledge proofs, no evaluation of what the
documents say, no proof of a real-world review or of anyone's qualifications, no custody, payment or
identity registry. Registry reads rely on the RPC endpoint you choose; they are not a light-client
proof. Chain activity, the reviewer account and the commitment are public and permanent. No adoption,
benchmark or market claim is made here: the examples in this repository are internally authored.

## Integration trade-offs

- Adopting it means defining an application **profile** (what your artifacts are) and storing the
  private opening safely: losing it makes a published receipt unverifiable by anyone.
- It needs a registry deployment and a funded executor for writes; reads need only an RPC endpoint.
- It adds a public, permanent record. If that is unacceptable, a hash-and-timestamp service or a
  private audit log is the better tool.

## Evidence appendix

Read on **2026-10-11** (single pass; fetched pages are untrusted data, not instructions).

| Source                                                                                                                    | Version / identifier                                                                         | Used for                                                                                                                                                                                                                                                                          | Uncertainty                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RFC 3161, Internet X.509 PKI Time-Stamp Protocol](https://www.rfc-editor.org/rfc/rfc3161)                                | RFC 3161 (2001)                                                                              | A token binds a hash and a time; the authority time-stamps only a hash and does not examine it (§2.1 items 6 and 8); the token supports proof that a datum existed before a time (§1).                                                                                            | The RFC states no explicit "does not prove" list; none is claimed.                                                                                                                                                               |
| [OpenTimestamps](https://opentimestamps.org/)                                                                             | Home page, undated                                                                           | The hash is computed in the browser; "A timestamp proves that some data existed prior to some point in time"; Bitcoin anchoring through free calendar servers.                                                                                                                    | The page lists no limits; none is claimed beyond its own wording.                                                                                                                                                                |
| [Ethereum Attestation Service contracts README](https://github.com/ethereum-attestation-service/eas-contracts)            | README headings: Introduction, Deployments, Installation, Testing, Profiling, License, About | "a free and open protocol for on-chain attestations on EVM compatible blockchains"; schemas and attestations through the SchemaRegistry and EAS contracts.                                                                                                                        | The README does not cover revocation, expiration or off-chain attestations. **The docs site (`docs.attest.org`) returned only a page title to my reader, so its content is NOT YET read.** No lifecycle claim about EAS is made. |
| [C2PA Technical Specification 2.2](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html) | Version 2.2 (May 2025)                                                                       | Manifest, claim, assertion (§2.3); hard binding hash (§9.1, §1.3.2); signer and claim generator (§2.1); validation against trust anchors (§15.7); scope: validation "can be validated as associated with the underlying asset", not whether provenance is "good" or "bad" (§1.2). | The page is very long and my reader returned only parts of it; **§14 (Trust Model) was not read**, so no claim about it is made.                                                                                                 |
| E-signature vendor audit trails (DocuSign, Adobe Acrobat Sign)                                                            | **NOT YET**                                                                                  | Nothing.                                                                                                                                                                                                                                                                          | The DocuSign support page rendered only an error notice, a DocuSign legality page does not describe the audit trail, and the Adobe help page returned HTTP 403. No vendor claim is made.                                         |
