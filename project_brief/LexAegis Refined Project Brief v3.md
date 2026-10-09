# LexAegis — Refined Project Brief

**Proof of Review: open infrastructure for human-approved AI work**
**Reference application:** LexAegis, employment settlement review in England and Wales
**Hackathon:** Monad Metropolis 2026 — Trust, Identity & AI Infrastructure
**Version:** 3.0 · **Updated:** 5 October 2026

This brief replaces v2.1 (2 October 2026). It keeps every protocol decision, the stack and the five bounty targets, and it is built to sit on top of the 13-chapter prompt library that already exists. What it adds is aimed at the judging criteria that carry the most weight and that the earlier brief covered least: market readiness, traction, developer experience, track fit and delivery risk. Chapters 14–19 are additive adjustment chapters; they do not restart or rewrite Chapters 1–13. Implementation, test results and deployment have not been verified in this prompt-design workflow.

## 0. What changed in v3.0

| #   | Change                                                                                                                                                                                                         | Why it matters                                                                                                               | Where it is built         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | The product is described as a primitive first and an app second. The protocol is presented as **Proof of Review**; LexAegis is its first application. Wire-format identifiers keep the `lexaegis` namespace. | The track excludes standalone consumer products. Renaming identifiers would break Chapters 2–3, so only the framing changes. | Sections 1, 2; Chapter 15 |
| 2   | Added positioning against the alternatives judges will name (hash and timestamp, EAS-style attestations, e-signature audit trails, C2PA).                                                                      | Originality and "why not roll your own" are scored.                                                                          | Section 3; Chapter 15     |
| 3   | Added a judging map from each criterion to the evidence we will show.                                                                                                                                          | Keeps work pointed at the score.                                                                                             | Section 4                 |
| 4   | Added an optional, availability-gated ERC-8004 link so the assistant is an identifiable agent.                                                                                                                 | The track names ERC-8004 as a building block.                                                                                | Section 6.1; Chapter 16   |
| 5   | Added an adoption kit: embeddable verifier, CLI, second-domain example, outsider install test, outreach pack and an honest evidence log.                                                                       | Founder/market readiness (25%) and traction (20%) are the two heaviest criteria after execution.                             | Chapters 15, 18           |
| 6   | Added security hardening: threat model, invariant tests, static analysis, verified deployment.                                                                                                                 | Technical execution (20%).                                                                                                   | Chapter 17                |
| 7   | Added scope tiers, a cut ladder, feature flags, delivery gates and a golden-path smoke test. Voice moves from MVP to stretch.                                                                                  | A working live demo outweighs breadth. The plan covers five bounties in nine days on a preview SDK.                          | Section 10; Chapter 14    |
| 8   | Added a judge path, health checks, demo reset, per-session model budgets and a timed runbook.                                                                                                                  | Judges must be able to use the live product; the demo video must show it working.                                            | Chapter 19                |
| 9   | Rewrote the delivery plan around dated gates with a defined fallback if Mera blocks.                                                                                                                           | The deadline is fixed.                                                                                                       | Section 12                |

**Unchanged:** the receipt schemas and digest/commitment construction (Chapter 2), the registry design, ABI and EIP-712 authorisation (Chapter 3), the technology stack, the five bounty targets and the honesty rules (no simulated completion, no invented traction).

## 1. Product and problem

**In one sentence:** Proof of Review lets a person approve an exact package of AI-assisted work and supporting evidence, and lets anyone else check that approval later without trusting the application that produced it.

An open receipt specification, a Monad registry and a portable TypeScript SDK are the primary infrastructure deliverables, joined by a read-only verifier, a command-line checker and an embeddable status widget. LexAegis is the reference application: a Aegis-style legal assistant with a working command centre that understands the current matter, performs bounded review tasks and presents its work through an evidence-led interface.

AI findings, source documents, calculations and human decisions often become separated as work moves between people and tools. A changed document can retain an outdated approval label. A database entry alone leaves recipients dependent on the application that produced it.

LexAegis binds the approved files, evidence, rule versions and human decisions into one private package. Its public receipt records the approving account and a cryptographic commitment. Recipients with the package can check its integrity and the receipt's current state without relying on the LexAegis database.

**The receipt establishes approval by a signing account of a specific package. It does not establish legal correctness, professional qualification, the truth of the evidence or settlement enforceability. Approval of a review is separate from signing the settlement agreement.**

**Primitive versus product.** The reusable layer is the specification, registry, SDK, verifier, CLI and widget. The legal workspace, the rule pack and the Aegis interface are one profile built on it. Legal rules must not become requirements of the generic protocol. Public material calls the protocol _Proof of Review_ and the app _LexAegis_.

## 2. Users, track fit and market

The track asks for a trust and data-ownership layer that is privacy-preserving, composable and not capturable by one platform, and it places standalone consumer products outside its scope. Proof of Review fits because the registry is permissionless and ownerless, the package stays private and user-held, any application can verify with read-only calls, and the format is open.

| Audience                                            | Immediate value                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Legal technology developers and workflow teams      | Add portable approval receipts, verification and revision history to an existing product.          |
| Teams building AI agents, including ERC-8004 agents | Show that a named person approved exactly what an agent produced, and let counterparties check it. |
| Solicitors reviewing employment settlements         | Inspect source-linked findings, reconcile payments and preserve the reasons for their decisions.   |
| Supervisors, clients and authorised recipients      | Check exactly which version was approved and whether its receipt remains active.                   |

The infrastructure must remain useful without the legal interface, hosted LexAegis backend, Mera account adapter or Qwen model. Independent integrations may supply their own supported signing account, transport, model and document workflow.

**Why adopt it instead of building it.** A team can store a hash and a timestamp in a day. What it does not get for free is the package format with a blinded commitment, a tested canonical encoding with published test vectors, atomic replacement of an approved version, terminal revocation, replay-safe authorisation that works with passkey accounts, an independent verifier that separates file integrity from chain status, and a free read-only check for recipients. Adoption starts on the read side: a team can show a receipt's status with a few lines of code and no wallet.

The founder brings a law degree, legal internship experience and current computer-science conversion study. Practitioner validation remains a goal. Initial validation should test whether developers can integrate the SDK and whether a second reviewer actually uses the receipt when checking a handover.

**Traction targets (not completed traction):** 8–12 practitioner interviews, 2–3 potential design partners and one external developer integration. The separately runnable verifier is a technical deliverable; it does not count as independent customer adoption. An integration the team writes itself is a reference example, not adoption. Measure integration effort, review time, material omissions, false alarms and verification use before making efficiency claims. Record every real signal in an evidence log (Chapter 18) and cite only what the log can support.

**Traction plan.** Start interviews now, in parallel with the build. Publish the specification and a verify-only snippet as soon as the registry is deployed, then offer hands-on help to two or three hackathon teams that build agents so one of them integrates before submission. Plan the post-event path in `docs/ROADMAP.md` with specific next steps and named kinds of adopters.

The commercial hypothesis is an open protocol with paid hosted workspace, API operations and integration support. Pricing, willingness to pay and revenue remain unvalidated. No platform token is required.

## 3. Positioning against alternatives

| Alternative                                              | What it does well                                               | What Proof of Review adds                                                                                                                   | Honest limit                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Hash plus timestamp (for example a notarisation service) | Simple proof that bytes existed at a time.                      | A defined package, human decision log and reviewer identity; supersession and revocation; a verifier that checks supplied files.            | A timestamp service is enough if you only need existence at a time.                                  |
| Generic onchain attestations (EAS-style)                 | Flexible, revocable attestations with a shared schema registry. | A concrete package and opening format, blinded commitment convention, atomic supersession, a reviewer-owned namespace and a verifier suite. | A generic attestation schema could carry the same commitment; a bridge is a roadmap item, not built. |
| E-signature and audit-trail vendors                      | Familiar workflow and legal acceptance for signing documents.   | Recipients do not depend on a vendor's database to check what was approved.                                                                 | It does not sign the settlement and is not a substitute for a legally effective signature.           |
| C2PA-style content credentials                           | Provenance for media and edits.                                 | Approval of a bundle of documents, calculations and decisions by a human account.                                                           | Complementary rather than competing; no integration is built.                                        |

Check these comparisons against the current state of each project before they appear in public material. Chapter 15 writes them into `docs/WHY.md`.

## 4. Judging map

| Criterion (weight)                  | What judges look for                                                                   | Evidence we will show                                                                                                                                                                     | Built in        |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Technical execution (20%)           | Primitive implemented correctly and securely; sound key derivation; no leaked secrets. | Foundry tests including invariants; replay, wrong-chain, wrong-registry and expiry failures; separate PRF namespaces; no persisted keys; secret scans; threat model; verified deployment. | 3, 4, 5, 12, 17 |
| Design and craft (20%)              | Developers can build on it: docs, clean interface.                                     | Specification with test vectors, five-minute quickstart, typed SDK errors, CLI, embeddable widget, API docs, working example outside the legal app.                                       | 11, 15, 18      |
| Originality and track insight (15%) | Privacy-preserving, not capturable by one platform.                                    | Ownerless registry, blinded commitments, user-held vault, open format, independent verification, optional ERC-8004 agent identity; honest statement of what is not private.               | 2, 3, 5, 16     |
| Founder and market readiness (25%)  | Specific adopters; why adopt over rolling their own.                                   | Named adopter segments, comparison with alternatives, practitioner interviews, design-partner conversations, hands-on integration offers.                                                 | 15, 18          |
| Traction and path forward (20%)     | Developer interest; a plan for more integrations.                                      | Evidence log, outsider install test, at least one external integration attempt, post-event roadmap.                                                                                       | 18              |

## 5. Complete MVP workflow

Tier labels (T0–T3) are defined in Section 10.

1. **Open the workspace (T1).** Create or recover a Mera passkey account on a supported browser and authenticator. Establish a scoped, temporary signing session.
2. **Import a supported agreement (T0).** Start with text-based PDFs and supporting evidence. Preserve original bytes and create page or clause references. Scans requiring OCR are outside this MVP.
3. **Consent to analysis (T0).** Explain which selected plaintext will reach the server and Qwen; obtain explicit consent before transmission.
4. **Work with the assistant (T0).** Ask LexAegis to summarise the matter, explain a selected clause, check payments or identify missing evidence. Qwen reads and extracts, bounded tools calculate, and the HUD shows real task steps and results. Each material finding links to its source; absent facts remain unknown. A separate payment what-if panel explores proposed figures without changing the source agreement. Document comparison is T3.
5. **Record human decisions (T0).** The reviewer confirms facts, resolves findings or explicitly accepts unresolved matters with recorded reasons. The system produces a review memo, calculation output and evidence checklist.
6. **Freeze the package (T0).** Capture the exact documents, outputs, rule pack, model/prompt configuration and decision log. Create the private opening and preserve it in the encrypted vault before publishing a receipt.
7. **Approve explicitly (T0).** Show the exact version and action. The reviewer authorises a bounded typed action; Mera signs and Alchemy carries the transaction to Monad testnet. Report pending and confirmed states accurately.
8. **Verify and maintain history (T0 verify, T2 history).** Envio supplies indexed history. The independent verifier checks supplied files and current registry state. A new approved version supersedes the old receipt atomically; the reviewer can also revoke an active receipt.
9. **Recover or export (T1).** Demonstrate access after browser storage is cleared and on another supported device using the same synced credential. Export the package for authorised sharing and independent verification.
10. **Integrate (T1).** From a clean directory, verify a receipt with the SDK, the CLI and the embeddable widget, and run the second-domain example.

The initial legal profile covers **employment settlement agreements in England and Wales**. It combines a manually approved, versioned rule pack, payment reconciliation, evidence collection and case continuity. It does not include immigration settlement eligibility. Those workflow principles are the relevant contribution from the earlier SettleOS concept.

Payment checks use ordinary code and GBP integer minor units, represented as decimal strings at JSON boundaries. Compare amounts on a consistent currency and gross/net basis; do not infer tax treatment. Presence of a clause is distinct from confirmation of the underlying legal or factual requirement.

## 6. Protocol decisions established by Chapters 2–3

The approved Chapter 2 and Chapter 3 prompts define the exact v1 wire formats, limits, ABI and test requirements. This brief summarises them without changing those contracts.

### Private package and public reference

- **Private package:** source files, extracted text, evidence, analysis, calculations, rule pack, checklist, agent configuration and human decision log. Its manifest binds artifact hashes, the review profile, reviewer, chain, registry and intended predecessor.
- **Private opening:** the manifest and an independent, cryptographically random 32-byte blinding nonce. Keep both encrypted with the evidence.
- **Public reference:** the versioned tuple of chain ID, registry address, reviewer address and commitment. A reference alone does not prove that a receipt exists.

The package schema is `lexaegis.review-package.v1`; the reference and opening schemas are `lexaegis.receipt-ref.v1` and `lexaegis.opening.v1`. The legal profile is `lexaegis.employment-settlement.ew`, version `1`. The `lexaegis` namespace is deliberate: other profiles can define their own identifiers without altering the generic construction.

Manifest canonicalization uses RFC 8785 JSON Canonicalization Scheme. Artifact hashes use original bytes. Chapter 2 fixes the following SHA-256 construction:

```text
artifactDigest = SHA256(originalArtifactBytes)
packageDigest = SHA256(UTF8("lexaegis:review-package:v1") || 0x00 || UTF8(JCS(manifest)))
commitment = SHA256(UTF8("lexaegis:review-commitment:v1") || 0x00 || nonce32 || packageDigest32)
```

Concatenation operates on bytes, not hexadecimal text. The opening nonce is separate from passkey-derived keys. Strict schemas reject ambiguous or unsupported inputs. Freeze metadata and file bytes together so an edit during approval cannot change what is signed.

The commitment is neither encryption nor a zero-knowledge proof. V1 verification discloses the full supplied package; it does not provide selective disclosure. Redaction creates a different package. Hashes bind bytes, not the truth or completeness of an analysis.

### Registry and authorisation

`ProofOfReviewRegistry` is permissionless, non-upgradeable and ownerless. There is no administrator override or global professional allowlist. Each reviewer controls their own receipt namespace.

| Action    | Required state                                    | Result                                                                            |
| --------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Issue     | Commitment has never been issued by that reviewer | A new active receipt.                                                             |
| Revoke    | Receipt is active                                 | Terminal revoked state; history remains.                                          |
| Supersede | Old receipt is active; replacement is new         | Old receipt becomes superseded and replacement becomes active in one transaction. |

Revoking a replacement never reactivates an earlier receipt. Previously issued commitments cannot be overwritten or reused within the reviewer's namespace.

EIP-712 authorisation uses domain name `LexAegisProofOfReview`, version `1`, the actual chain ID and registry address. Every signed action binds reviewer, action, commitment, replacement commitment, nonce and deadline. The contract enforces its own one-use reviewer counter and expiry checks; EIP-712 alone does not prevent replay. Maintained OpenZeppelin signature verification supports EVM account signatures and deployed ERC-1271 accounts.

Any executor may submit a valid signed action; this does not grant permission to create an approval. Invalidating the reviewer's current nonce cancels outstanding instructions using it. Expiry ends an unexecuted authorisation, not an already issued receipt.

Verification reports file/manifest integrity separately from chain status. Missing evidence or an unavailable RPC must remain unknown or incomplete. Envio supplies history; a live registry read determines the current lifecycle state.

### 6.1 Agent identity reference (additive in v3.0)

The assistant that helped produce a package can be named as an ERC-8004 agent. ERC-8004 defines an Identity Registry and a Reputation Registry (and a Validation Registry that Monad's documentation lists as not yet deployed). Per Monad's documentation, the Identity and Reputation registries are deployed on Monad mainnet, and the documentation lists no testnet addresses. Because this project runs on Monad testnet, availability must be probed before any integration is built.

Rules for the integration:

- The agent reference lives **inside the agent-configuration artifact**, which is already hashed into the package. It does **not** enter the manifest schema, the receipt reference or the commitment construction, and the registry contract and its ABI are unchanged. Chapter 2's test vectors for the manifest, package digest and commitment must still pass unchanged.
- The reference is optional. Receipts and verification work without it, and its absence is never an integrity failure.
- If the registries are not present on the target network, the HUD and verifier report the agent identity as unavailable. The project does not deploy a copy under a canonical-looking name and does not post to mainnet.
- The verifier resolves the reference with read-only calls and treats the agent card as untrusted input.
- Posting reputation feedback is a reviewer-initiated, content-free, clearly previewed extra (T3, off by default). It publicly links the reviewer account to use of the agent, so use it only with the synthetic demonstration account.
- Validation Registry integration is out of scope until it exists on the target network.

BTX encrypted mempools are research-stage according to Monad's own description and are not used. They may appear on the roadmap only. The P256 precompile (address `0x0100`, EIP-7951, documented gas cost 6,900) is available for passkey signature verification; whether Mera's accounts use it or derive an EVM key from the passkey's PRF output must be established in Chapter 4 and documented as it actually is.

## 7. Approved architecture

| Module                  | Technology and responsibility                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`              | Next.js App Router, React and Tailwind; Aegis command centre, legal review workspace, browser interaction controls and Node.js route handlers.                               |
| `apps/verifier`         | Independently runnable Vite/React verifier, without a LexAegis login requirement.                                                                                            |
| `packages/protocol`     | Closed Zod schemas, canonical encoding, portable protocol types and published test vectors.                                                                                   |
| `packages/sdk`          | Framework-neutral receipt building and verification with viem and caller-supplied transports.                                                                                 |
| `packages/cli`          | Read-only command-line verifier with stable exit codes (Chapter 15).                                                                                                          |
| `packages/verify-embed` | Framework-neutral status widget for third-party pages, read-only and wallet-free (Chapter 18).                                                                                |
| `packages/vault`        | Browser Web Crypto, encryption and evidence-storage interfaces.                                                                                                               |
| `packages/agent`        | Server-only Qwen assistant runtime, case-scoped context, validated tool calls and bounded review execution; a separate browser-safe contracts export carries data types only. |
| `contracts`             | Foundry, Solidity and OpenZeppelin registry implementation, plus a standalone interface file.                                                                                 |
| `indexer`               | Envio HyperIndex configuration, schema and lifecycle handlers.                                                                                                                |
| `examples/*`            | A second-domain integration and a plain-HTML embed example (Chapters 15, 18).                                                                                                 |
| `docs/*`                | Specification, quickstart, comparison, threat model, deployments, traction log, runbook.                                                                                      |
| Operational storage     | PostgreSQL for minimal operational/authentication metadata; S3-compatible object storage for ciphertext.                                                                      |
| Quality gates           | TypeScript pnpm workspace, Vitest, Foundry, Playwright and meaningful CI checks.                                                                                              |

Use one TypeScript application stack and one model provider. The backend router routes review tasks to **Qwen 3.8 Max (`qwen3.8-max`)**; it is not a multi-provider orchestration platform. Claude Code builds the product; Qwen powers its review workflow.

The Qwen loop is limited to explicit steps and allowlisted tools: fact extraction, approved rule retrieval, code-based calculations, evidence checks and package preparation. Apply schema validation, token/step/time limits and bounded retries. Treat document content as untrusted input. The model cannot authorise approval, sign transactions, obtain wallet secrets or change the rule pack silently. The model reads and extracts; code calculates; the person decides.

### 7.1 Aegis is an explicit product capability

The assistant and its supporting UI are mandatory MVP components. A generic chat box or a decorative orb does not satisfy this requirement. The assistant must carry a useful task from the user's request through actual tools to a source-linked result, with visible progress and user control.

| Component selected from the references                         | LexAegis adaptation                                                                                                                                                     | Owning chapters | Tier               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------ |
| Calm persona and coherent conversation — P02, P06–P12          | Concise case-aware dialogue, follow-up questions, corrections and explanations of the selected clause.                                                                   | 9, 10           | T0                 |
| Bounded plans and observable tools — P08, P13–P15              | Show the actual review steps, current tool, completed results and failure state; enforce budgets and cancellation in code.                                               | 9, 10, 12       | T0                 |
| Cinematic orb and command-centre narration — blueprint §9, P32 | An original cobalt/cyan orb whose labels and animation follow verified application events.                                                                               | 1, 10           | T1                 |
| Evidence canvas and legal analysis — P11, P30                  | Clickable source passages, calculations, missing-evidence cards; bounded text comparison of two supplied document versions.                                              | 8, 9, 10        | T0 (comparison T3) |
| Selective memory and briefings — P22, P23, P25                 | Encrypted, inspectable matter notes; a brief covering confirmed facts, unresolved findings and the next review step.                                                     | 5, 9, 10        | T2 (briefing T3)   |
| Exact action previews — P14                                    | A dedicated approval card bound to the frozen package, separate from conversation and passkey session permission.                                                        | 4, 6, 10        | T0                 |
| Activity timeline and truthful receipts — P12, P15, P32        | Clearly separated assistant activity, human decisions and indexed blockchain history.                                                                                    | 7, 9, 10        | T2                 |
| Simulation discipline — P40                                    | One deterministic payment what-if panel with editable figures and an explicit SIMULATED label.                                                                           | 8, 10           | T1                 |
| Invited voice and interruption — P02, P10; blueprint §7        | Push-to-talk into an editable draft, opt-in read-aloud and direct Stop controls on supported devices. The Stop control is T0; voice itself is **T3 and off by default**. | 10, 12          | T3                 |
| Versioned prompt assets — README; P00, P34–P36                 | A small pinned runtime prompt set, schema validation, provenance and focused failure/injection evaluations.                                                              | 9, 12           | T1                 |

Useful requests include "Explain this clause", "Why do these payments not add up?", "What evidence is missing?", "Brief me on this matter" and "Prepare the review package". Short commands expose the same handlers: `/summarise`, `/explain`, `/check-payments`, `/missing-evidence`, `/prepare-review`, `/status` and `/stop`. Preparing a package never approves it.

### 7.2 Supporting UI and visual direction

Use an original obsidian/navy workspace with a luminous cobalt/cyan core, restrained rings and a faint background grid. Violet indicates active analysis, amber requests attention, green indicates a confirmed outcome and red identifies errors. Every state also has text and an icon. Readable documents take precedence over decoration.

| UI area                 | Required behaviour                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top status strip        | Show the selected matter/version, passkey session, vault lock state and actual transaction/indexing status. Keep those states separate.                             |
| Left matter rail        | Navigate matters, source documents, saved context and outstanding review items.                                                                                     |
| Command-centre view     | Present the orb, one concise status sentence, task steps, assistant conversation and task-relevant result cards.                                                    |
| Review view             | Give the document and its findings most of the screen; keep the assistant docked beside them and the orb compact. Preserve the selected clause when changing views. |
| Evidence/approval panel | Open cited passages and calculations; switch to a precise package/action preview when the user chooses to approve, revoke or supersede.                             |
| Bottom command dock     | Text input, scoped command menu, an always reachable Stop action, and voice control only when the voice flag is on and supported.                                   |
| Activity drawer         | Distinguish model/tool activity from signed human decisions and confirmed on-chain events. Show timestamps and useful evidence links.                               |

On smaller screens, use stacked views or tabs with the same controls. Support keyboard navigation, visible focus, screen-reader labels and reduced motion. Render the orb with lightweight CSS/SVG; a 3D/WebGL scene, constant particle simulation and fabricated system telemetry are unnecessary. No invented risk percentage, tool success or blockchain confirmation is allowed.

The UI consumes validated, ordered runtime events associated with the current matter, document version and run. It must ignore late results from cancelled or superseded runs. User-facing progress describes the actual operation, not private model reasoning. Use deterministic status labels instead of spending a model call on every animation or progress message.

### 7.3 Context, voice and what-if boundaries

Matter memory contains user-confirmed facts, notes, source/version references and concise saved outcomes. Users can inspect, correct, remove and export it through the encrypted vault. Keep raw chat ephemeral by default. Do not mix matters or turn a model inference into a confirmed fact. Changing working context cannot mutate a previously approved package; deleting a note does not erase a blockchain record or an exported copy.

Voice is a stretch feature behind a feature flag that defaults to off. If it is enabled, it must be a capability-gated enhancement to the complete text workflow: enable speech recognition only when on-device processing is supported and verified; never silently fall back to a remote speech service; require a visible user activation, microphone indicator, editable transcript and Send action; offer opt-in read-aloud with a verified local device voice. If either capability is unavailable, show a clear explanation and retain the text controls. No wake word, background listening, retained audio or additional paid speech integration is included.

Stop must cancel any capture or playback and prevent new assistant tool calls after cancellation is acknowledged. It must not claim to reverse an already broadcast blockchain transaction or retract plaintext already sent to a provider. Voice and chat cannot approve a receipt: the separate review/signing ceremony remains required.

The what-if panel reuses the existing integer-minor-unit calculator. For example, changing the hypothetical second instalment from £12,000 to £14,000 removes the arithmetic gap against £24,000. The result remains SIMULATED and does not alter the document, resolve a legal finding, enter the approval package automatically or prove a payment occurred. Any proposed correction requires an actual new source version and renewed review. Full digital twins, branching simulations and predicted legal outcomes are excluded.

### 7.4 Compact assistant runtime

Adapt the older project's "model proposes, code executes" boundary to TypeScript. Use one Qwen runtime with a small common policy and only the task-specific prompt, relevant case context and allowed tool schemas needed for the turn. Pin actual prompt versions and hashes in the existing agent-configuration artifact. Do not import the 420-asset framework, add independent critic agents or make a separate model call for every orchestration step.

Case briefings run when requested or when already available state can be rendered directly. No always-on scheduler, general personal memory system, arbitrary browser/desktop control, email sending or smart-home integration enters the MVP. Because judges will use the live product, the server enforces a per-session and a global model-usage budget and a kill switch (Chapter 19).

## 8. Privacy, passkeys and recovery

Mera provides the entire reference-app account layer. The target experience has no seed phrase, wallet extension, email/OTP account flow or custodial user-key backend. A supported setup should demonstrate onboarding with one passkey prompt and signing within a scoped, memory-only session. Session expiry requires renewed user authentication. A session never substitutes for explicit approval of the displayed package. Mera is currently a preview SDK; Chapter 4 must record what the SDK actually does and which behaviours were measured rather than assumed.

The vault is the meaningful non-wallet use of Mera's PRF output. Signing and encryption use separate purpose/domain namespaces and suitable key derivation. User signing keys, PRF outputs, unwrapped encryption keys and signing-session secrets remain in memory; never persist them in browser storage, cookies, the database or logs. Provider API credentials remain server-side and are separate from user secrets.

Persist ciphertext and the recovery metadata needed to rediscover it after local caches are wiped. Do not make browser-local state the sole route back to evidence. Demonstrate recovery using the **same synced passkey credential**, including a fresh profile or supported second device. Creating a new passkey is not recovery of the old one. Detect unsupported authenticator capabilities explicitly.

Passkey origin/relying-party boundaries still apply. Cross-device recovery does not imply automatic decryption on an unrelated origin. Portability requires explicit export/import or re-encryption, and the user controls which recipient receives an opening and evidence.

Encryption protects stored evidence, but selected plaintext sent for analysis is visible to the backend and model provider. This is not confidential computation or zero-knowledge AI. Keep confidential text, unsalted document hashes, filenames, storage links and amounts off-chain. Public account addresses, timing and receipt links still reveal activity.

**Linkability.** One reviewer address links all of that reviewer's receipts. If Mera can derive a distinct signing account per purpose or matter, evaluate it as a later improvement; otherwise state the limitation plainly. Do not claim unlinkability.

Use synthetic legal matters for the public demonstration. Client-data pilots require separate operating and provider-data decisions. Do not describe a hosted testnet MVP as an audited production system.

## 9. Five core bounty targets

The following targets, award descriptions and evidence requirements reflect the approved hackathon information supplied in this project. They are not claims of entry acceptance, completed integrations or awards won.

| Bounty                        | Product integration and required evidence                                                                                                                                                                            | Advertised award                                                                     | Dependency risk and fallback                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Best Mera-Powered UX on Monad | Entire account layer uses Mera. Show onboarding, scoped signing-session behaviour, expiry/re-prompt, a confirmed Monad transaction and recovery after clearing browser storage. Record actual taps and elapsed time. | $2,500 USD; one prize.                                                               | Preview SDK. If Gate B fails (Section 10), drop the Mera bounties and keep the main track.   |
| Mera: One Passkey, Many Keys  | Use a separate PRF namespace for the encrypted evidence vault. Show purpose separation, no persisted plaintext user keys and live decryption recovery with the same credential on another supported device/profile.  | $2,500 USD; one prize.                                                               | Same as above; needs a second device or profile for the recording.                           |
| Best Use of Envio             | Run an actual HyperIndex pipeline with `config.yaml`, `schema.graphql` and handlers. Index issued, revoked and superseded events into useful history and derived state. Handle replay, lag and reorganisation.       | $1,000 USD; one prize.                                                               | Lowest-risk after the registry is deployed. Cut History UI polish first, never the pipeline. |
| Best Builds with Qwen 3.8 Max | Demonstrate live, bounded agent planning and tool execution that materially produces the review. Deliver a working Monad application and publish an article explaining Qwen's actual use and value.                  | $5,000 credit pool shared across the top three Track 4 winners; not $5,000 per team. | Article is a hard deliverable; draft it on 11 October.                                       |
| Best Projects using Alchemy   | Use Alchemy for real Monad RPC reads, transmission of signed transactions, confirmation and current-state verification. Keep credentials server-side. Mera remains the user account layer.                           | $1,000 in Alchemy credits; one prize.                                                | Low risk; keep a public-RPC fallback for the verifier only.                                  |

Envio is a core integration in this scope. Avoid counting one supersession as two newly created receipts when processing its events. Evidence must distinguish application-generated test data from actual network activity.

The main track advertises $30,000 total across three $10,000 winners. Do not treat cash prizes, shared credit pools or possible award combinations as guaranteed project funding. **The main track comes first:** work on a bounty counts only if it sits on the main demo path or can be shown in a short separate clip.

## 10. Scope tiers, cut ladder and delivery gates

**Tiers.**

- **T0 — the golden path.** Without it there is no submission: import, consent, Qwen-assisted findings with source links, human decision, freeze, approve with a real signature, confirmed Monad testnet receipt, independent verification, tamper detection, supersede or revoke, deployed registry, SDK verify.
- **T1 — the strong submission.** Mera recovery and vault, what-if panel, compact orb, CLI, embeddable widget, second-domain example, specification with test vectors, quickstart, judge path.
- **T2 — the differentiators.** Envio history and derived status, matter notes, ERC-8004 agent reference (if available on testnet), invariant tests, threat model, verified deployment, 8 evaluation fixtures.
- **T3 — only if ahead.** Voice, document comparison, matter briefing, reputation feedback, 12 fixtures, extra visual polish.

**Cut ladder.** When behind, cut in this order and record each cut in `docs/build-state.json`: voice, document comparison, matter briefing, reputation feedback, orb animation beyond a static state indicator, History UI polish, fixtures from 12 to 8, agent-identity reference, matter notes. Never cut: real signature, real Monad transaction, independent verifier with tamper failure, honest state labels, Stop, explicit approval.

**Gates.** A gate is passed only when its evidence exists in the repository, not when a prompt has been run.

| Gate | Target             | Pass condition                                                                                                        | If it fails                                                                                                                                                                           |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 6 Oct              | Chapters 1–3 build and test green; registry deployed to Monad testnet; address, transaction hash and commit recorded. | Fix before anything else.                                                                                                                                                             |
| B    | 8 Oct, end of day  | A real Mera account signs; a registry transaction confirms through Alchemy; the verifier reads the state.             | Fall back to a development-only signer adapter behind the existing signer interface, clearly labelled and absent from production builds; drop the Mera bounties; keep the main track. |
| C    | 10 Oct, end of day | Live Qwen run produces source-linked findings; the T0 path works in the UI.                                           | Cut per the ladder.                                                                                                                                                                   |
| D    | 11 Oct, end of day | Feature freeze; verifier, SDK, CLI, judge path and public repository ready.                                           | Only critical fixes after this point.                                                                                                                                                 |

## 11. Prompt-library build sequence

Each chapter follows the Dual-Layer Rule: a short everyday explanation, followed by sequential, modular Targeted Component Execution Blocks using `📦 BUILD TASK`, `🛠️ ACTION TYPE` and `<execute_task>`. Claude Code edits actual files, validates meaningful outcomes and omits conversational filler, full-file echoes and standalone JSON status reports. Instructions remain scoped to the current chapter and existing repository state.

| Chapter | Title                                                                 | Status             |
| ------- | --------------------------------------------------------------------- | ------------------ |
| 1       | Runnable Monorepo, Shared Types and Build Checks                      | Authored (v2.2).   |
| 2       | Receipt Format, Canonical Hashing and Private Commitments             | Authored.          |
| 3       | Monad Registry, Approval Signatures and Receipt Lifecycle             | Authored.          |
| 4       | Mera Passkeys, Signing Sessions and Account Recovery                  | Authored.          |
| 5       | Encrypted Evidence Vault, Stateless Recovery and Portable Export      | Authored.          |
| 6       | Alchemy Transactions, Testnet Funding and Live Verification           | Authored.          |
| 7       | Envio Indexer, Review History and Derived Status                      | Authored.          |
| 8       | Document Intake, Source References and Deterministic Checks           | Authored.          |
| 9       | Qwen 3.8 Max, Aegis Assistant Runtime and Review Tools               | Authored.          |
| 10      | Aegis HUD, Legal Workspace and Human Approval                        | Authored.          |
| 11      | Protocol SDK, Independent Verifier and Developer Integration          | Authored.          |
| 12      | End-to-End Recovery, Privacy and Security Validation                  | Authored.          |
| 13      | Production Deployment and Hackathon Submission Assets                 | Authored.          |
| 14      | Scope Gates, Feature Flags and Golden-Path Smoke Test                 | **New, additive.** |
| 15      | Developer Experience: Specification, Test Vectors, Quickstart and CLI | **New, additive.** |
| 16      | Agent Identity: ERC-8004 Link, Availability-Gated                     | **New, additive.** |
| 17      | Security Hardening and Verified Deployment                            | **New, additive.** |
| 18      | Adoption Kit and Traction Evidence                                    | **New, additive.** |
| 19      | Judge Experience and Demo Reliability                                 | **New, additive.** |

**Recommended run order.** 1–3 (confirm Gate A) → 14 (tasks 14.1 and 14.2 immediately, and the 14.3 harness with steps enabled as features land) → 4 → 5 → 6 (Gate B) → 8 and 9 → 7 → 10 → 11 → 15 → 16 (after its availability probe) → 17 → 18 → 12 → 19 → 13. Run Chapter 14's remaining tasks as soon as the UI exists. Chapters 15 and 18 can start as soon as the SDK verifies a real receipt.

Prompt authorship is separate from implementation progress. `CLAUDE.md`, `docs/assistant-ui-contract.md` and `docs/build-state.json` should record actual repository decisions, the required assistant/UI components and verified results when these chapters are executed. No component is complete merely because its prompt exists. Chapters 14–19 are additive: where they touch earlier work they say exactly what may change, and they leave Chapter 2–3 wire formats, the registry ABI and the commitment construction alone.

## 12. Delivery window and acceptance

**Internal submission target:** 12 October 2026.
**Hard deadline:** 14 October 2026, 04:59 GMT+1/BST (`2026-10-14T04:59:00+01:00`, or 03:59 UTC).
**Submit by:** 13 October 2026, 22:00 BST at the latest. Treat the hard deadline as unavailable.

| Dates     | Focus                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| 5–6 Oct   | Confirm Chapters 1–3 (Gate A). Chapter 14 tasks 14.1–14.2 and the 14.3 harness. Book practitioner interviews. |
| 6–8 Oct   | Chapters 4, 5, 6 (Gate B). Publish the specification draft and verify-only snippet; contact hackathon teams.  |
| 8–10 Oct  | Chapters 8, 9, 7, 10 (Gate C). Interviews continue.                                                           |
| 10–11 Oct | Chapters 11, 15, 16, 17, 18 (Gate D, feature freeze). Draft the Qwen article.                                 |
| 11–12 Oct | Chapter 12 validation, Chapter 19, record videos and bounty clips. Internal submission.                       |
| 13 Oct    | Buffer. Critical fixes only. Final submission by 22:00.                                                       |

The stated two-week build budget does not extend the hard deadline. Adjust these dates to the repository's actual state, but keep the gates.

The MVP is complete when:

- A supported synthetic agreement produces live source-linked findings, deterministic payment checks, a memo and an evidence checklist. Evaluate at least 8 fixtures (12 if time allows) covering clean controls, seeded discrepancies, missing fields and conflicting terms; report observed results without claiming general legal accuracy.
- A conversational request starts a real bounded task; the orb, step list and activity drawer reflect its execution. A citation opens the correct clause, follow-up questions retain the selected matter/version, and Stop prevents further tool dispatch after acknowledgement.
- Command-centre and Review views work on desktop and mobile with keyboard and reduced-motion access. Voice is either absent or, if enabled, clearly gated and separately tested.
- Saved case context survives authorised vault recovery without cross-matter leakage. Payment what-if results remain visibly simulated and cannot authorise or alter a real receipt.
- The reviewer deliberately approves an immutable package, its encrypted opening is recoverable, and a real Monad transaction confirms the receipt.
- A separate verifier accepts the exact supplied package, detects altered bytes and distinguishes active, revoked, superseded, missing and unknown states.
- Wrong-account, wrong-chain, wrong-registry, replayed and expired authorisations fail; supersession is atomic and preserves history. Registry invariants hold under fuzzing.
- Both Mera demonstrations succeed: account access after local storage clearance and vault decryption on a supported second device/profile using the same credential. If Gate B failed, the Mera bounties are withdrawn rather than claimed.
- Envio history agrees with confirmed events, and current-state checks remain honest when indexing or RPC access fails.
- Document instructions cannot trigger approval, signing or secret disclosure; model and provider failures do not produce fabricated successful reviews.
- The SDK, CLI and embeddable widget work from a clean directory using only the quickstart, with synthetic examples and usable exported verification material. The specification and test vectors let someone else implement the digest and commitment independently.
- The agent identity reference works on the target network, or its absence is reported honestly.
- The judge path works for a first-time visitor with a supported browser, and a pre-issued real testnet receipt can be verified without creating an account.
- The traction log contains only verifiable entries.
- All five integrations have actual evidence (or are explicitly withdrawn), including the published Qwen article, and the submission assets are ready.

## 13. Demonstration and submission

Use a fictional agreement with a £24,000 stated total and instalments of £10,000 and £12,000. Ask the assistant to check it, show the actual task steps and open the £2,000 mismatch at its source clauses. Briefly demonstrate the labelled payment what-if result, then review an actual corrected source version, record a human decision and approve its package. Show the real transaction, indexed history and independent verification. Alter a file and demonstrate failure; show revocation or supersession without erasing the earlier record.

**Technical demo (three minutes maximum), suggested timing.** Lead with the primitive, not the app.

| Time      | Content                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | The problem in one sentence, and the claim: approval anyone can check without trusting the app.                                               |
| 0:20–1:20 | Live review: the assistant's real steps, the £2,000 finding at its source, a human decision, one approval, a confirmed Monad transaction.     |
| 1:20–2:10 | The verifier with no login: match, then change one amount and watch it fail; supersede or revoke while the earlier record stays visible.      |
| 2:10–2:40 | The same receipt checked through the SDK, the CLI and the embeddable widget in a different example; the ERC-8004 agent identity if available. |
| 2:40–3:00 | What is and is not proven, and where the protocol goes next.                                                                                  |

The technical demo must show the working product within three minutes. Capture the Mera recovery and session evidence clearly; additional bounty clips can carry demonstrations that do not fit the main video. Never substitute an unlabelled simulation for a live integration.

**Pitch video (two minutes maximum), suggested structure.** Team and founder background (15 s); the problem (15 s); the primitive and why no single platform can capture it (30 s); what exists and works today (20 s); who will adopt it, with only the traction the evidence log supports (25 s); what happens after the hackathon (15 s).

**Judge access.** Passkeys cannot be shared as login credentials. Provide (a) a guided path that creates the judge's own passkey account on the supported browsers listed, with funded testnet access, and (b) pre-issued real testnet receipts and sample packages that can be verified with no account. Label pre-issued items as made in advance.

Required submission assets:

- Logo in JPG, JPEG, PNG or WEBP, at most 3 MB.
- Public GitHub repository accessible to `metropolis@hackathon.monad.xyz`.
- Live product URL and clear judge access instructions, including supported passkey setup.
- Working-product technical demo of at most three minutes on YouTube, Loom or Vimeo; not a slide deck or code walkthrough.
- Pitch video of at most two minutes covering team, problem and why this approach matters.
- Deployed contract/network details, integration evidence and the published Qwen article.

An optional advertisement of at most 30 seconds is outside the judged technical deliverables. The supplied judging weights are technical execution 20%, design/craft and developer experience 20%, originality/track insight 15%, founder/market readiness 25%, and traction/path forward 20%.

## 14. Scope boundaries

Exclude OCR, additional jurisdictions, immigration eligibility, full practice management, billing, a client portal, automatic legal advice, autonomous approvals, negotiation, settlement payments, trading, tokens, a marketplace, vector databases, model fine-tuning and a multi-agent framework.

Do not add Privy, Dynamic, Kimi, Chainlink CRE or further bounty integrations to this MVP. Do not add automatic legal-source monitoring, a professional identity authority, zero-knowledge proofs, confidential-computation claims or a separate backend framework. Also excluded in v3.0: BTX or encrypted-mempool features, an EAS bridge, a hosted public verification API, mainnet deployment, a Validation Registry integration, and any claim of external adoption that the evidence log cannot support. Mera, Qwen, Envio and Alchemy already support the selected five-bounty path.

If delivery pressure increases, follow the cut ladder in Section 10. The case-aware assistant, functional command dock, evidence view, truthful state display and Stop/approval controls remain required. Changes to the approved protocol or bounty scope must be made explicitly rather than hidden behind simulated completion.

## 15. Source and decision record

This revision incorporates the original LexAegis and SettleOS concepts, the refined brief v1.0, brief v2.1, the 13-chapter prompt library overview, the hackathon track description and judging criteria, and the following checks made on 5 October 2026.

**Checked against Monad's public documentation:**

- The P256 precompile is at address `0x0100`, takes 160 bytes (message hash, r, s, public key x and y), costs 6,900 gas and follows EIP-7951. The documentation does not say which networks have it.
- ERC-8004 Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and Reputation Registry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` are listed for Monad mainnet; the Validation Registry is not deployed; no testnet addresses are listed. Re-check before relying on them.
- BTX (batch threshold encryption) is described as research in Monad's own post, not a deployed feature.

**Not verified in this workflow:** Mera's current API and behaviour (the repository could not be opened here), the `qwen3.8-max` model identifier, Envio and Alchemy specifics, and the comparisons in Section 3. Chapters instruct Claude Code to inspect the live sources and record what it finds.

The three attached references from the earlier brief were read as design sources:

- `AEGIS_Engineering_Playbook_and_Prompt_Library_Blueprint_v0_1.md`: especially runtime states, invited voice, selective memory, typed tools and the cinematic interface specification.
- `Aegis_Prompt_Library_Outline(1).md`: especially P02, P06–P15, P22–P23, P25, P30, P32–P36 and the limited adaptation of P40.
- `README.md`: reported text-core architecture, deterministic execution boundaries and pinned prompt provenance. It explicitly reports no implemented desktop UI or voice; this brief does not claim reusable UI source was supplied.

The Markdown blueprint references image files that were not included with these attachments. This adaptation uses its written visual specification, not an inspection of those missing images. The older project's Python/Tauri/Claude runtime, long delivery schedule and development-only release conventions do not override LexAegis's approved stack or deadline.

Technical references:

- [Mera repository and current API status](https://github.com/category-labs/mera) — passkey-derived accounts and signing sessions; currently a preview SDK, with application-controlled recovery and storage flows.
- [Monad ERC-8004 guide](https://docs.monad.xyz/guides/erc-8004), [Monad precompiles](https://docs.monad.xyz/developer-essentials/precompiles) and [BTX announcement](https://monad.xyz/blog/btx-batch-threshold-encryption).
- [Alibaba Cloud Model Studio model catalogue](https://www.alibabacloud.com/help/en/model-studio/models) — includes `qwen3.8-max`.
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) — canonical JSON encoding.
- [EIP-712](https://eips.ethereum.org/EIPS/eip-712) — typed structured-data signing; replay protection is an application responsibility.
- [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) — contract-account signature verification interface.
- [OpenZeppelin cryptography utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography) — maintained signature-verification building blocks.
- [Monad documentation](https://docs.monad.xyz/), [Alchemy Monad documentation](https://www.alchemy.com/docs/reference/monad-api-faq) and [Envio documentation](https://docs.envio.dev/) — integration references for the later chapters.
- [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) and [SpeechSynthesisVoice.localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService) — browser support and processing locality must be checked; browser speech is not universally available or automatically local.

Dependency versions, SDK capabilities and deployment configuration must be verified and pinned during implementation. No integration, test, external adoption or deployment is represented as completed by this brief.
