# LexAegis — Updated Project Brief

**Open Proof of Review infrastructure for human-approved AI work**  
**Reference application:** employment settlement review in England and Wales  
**Hackathon:** Monad Metropolis 2026 — Trust, Identity & AI Infrastructure  
**Version:** 2.1 · **Updated:** 2 October 2026


## 1. Product and problem

LexAegis lets a person approve an exact package of AI-assisted work and supporting evidence, then lets another application check that approval independently. An open receipt specification, a Monad registry and a portable TypeScript SDK are the primary infrastructure deliverables. The reference application is a Aegis-style legal assistant with a working command centre: it understands the current matter, performs bounded review tasks and presents its work through a cinematic, evidence-led interface.

AI findings, source documents, calculations and human decisions often become separated as work moves between people and tools. A changed document can retain an outdated approval label. A database entry alone leaves recipients dependent on the application that produced it.

LexAegis binds the approved files, evidence, rule versions and human decisions into one private package. Its public receipt records the approving account and a cryptographic commitment. Recipients with the package can check its integrity and the receipt's current state without relying on the LexAegis database.

**The receipt establishes approval by a signing account of a specific package. It does not establish legal correctness, professional qualification, the truth of the evidence or settlement enforceability. Approval of a review is separate from signing the settlement agreement.**

## 2. Users, track fit and commercial direction

| Audience | Immediate value |
| --- | --- |
| Legal technology developers and workflow teams | Add portable approval receipts, verification and revision history to an existing product. |
| Solicitors reviewing employment settlements | Inspect source-linked findings, reconcile payments and preserve the reasons for their decisions. |
| Supervisors and authorised recipients | Check exactly which version was approved and whether its receipt remains active. |

The infrastructure must remain useful without the legal interface, hosted LexAegis backend, Mera account adapter or Qwen model. Legal rules belong in the reference application; they must not become requirements of the generic protocol. Independent integrations may supply their own supported signing account, transport, model and document workflow.

The founder brings a law degree, legal internship experience and current computer-science conversion study. Practitioner validation remains a goal. Initial validation should test whether developers can integrate the SDK and whether a second reviewer actually uses the receipt when checking a handover.

Target 8–12 practitioner interviews, 2–3 potential design partners and one external developer integration. These are targets, not completed traction. The separately runnable verifier is a technical deliverable; it does not count as independent customer adoption. Measure integration effort, review time, material omissions, false alarms and verification use before making efficiency claims.

The commercial hypothesis is an open protocol with paid hosted workspace, API operations and integration support. Pricing, willingness to pay and revenue remain unvalidated. No platform token is required.

## 3. Complete MVP workflow

1. **Open the workspace.** Create or recover a Mera passkey account on a supported browser and authenticator. Establish a scoped, temporary signing session.
2. **Import a supported agreement.** Start with text-based PDFs and supporting evidence. Preserve original bytes and create page or clause references. Scans requiring OCR are outside this MVP.
3. **Consent to analysis.** Explain which selected plaintext will reach the server and Qwen; obtain explicit consent before transmission.
4. **Work with the assistant.** Ask LexAegis to summarise the matter, explain a selected clause, check payments or identify missing evidence. Qwen uses bounded tools while the HUD shows real task steps and results. Each material finding links to its source; absent facts remain unknown. A separate payment what-if panel explores proposed figures without changing the source agreement.
5. **Record human decisions.** The reviewer confirms facts, resolves findings or explicitly accepts unresolved matters with recorded reasons. The system produces a review memo, calculation output and evidence checklist.
6. **Freeze the package.** Capture the exact documents, outputs, rule pack, model/prompt configuration and decision log. Create the private opening and preserve it in the encrypted vault before publishing a receipt.
7. **Approve explicitly.** Show the exact version and action. The reviewer authorises a bounded typed action; Mera signs and Alchemy carries the transaction to Monad testnet. Report pending and confirmed states accurately.
8. **Verify and maintain history.** Envio supplies indexed history. The independent verifier checks supplied files and current registry state. A new approved version supersedes the old receipt atomically; the reviewer can also revoke an active receipt.
9. **Recover or export.** Demonstrate access after browser storage is cleared and on another supported device using the same synced credential. Export the package for authorised sharing and independent verification.

The initial legal profile covers **employment settlement agreements in England and Wales**. It combines a manually approved, versioned rule pack, payment reconciliation, evidence collection and case continuity. It does not include immigration settlement eligibility. Those workflow principles are the relevant contribution from the earlier SettleOS concept.

Payment checks use ordinary code and GBP integer minor units, represented as decimal strings at JSON boundaries. Compare amounts on a consistent currency and gross/net basis; do not infer tax treatment. Presence of a clause is distinct from confirmation of the underlying legal or factual requirement.

## 4. Protocol decisions established by Chapters 2–3

The approved Chapter 2 and Chapter 3 prompts define the exact v1 wire formats, limits, ABI and test requirements. This brief summarises them without changing those contracts.

### Private package and public reference

- **Private package:** source files, extracted text, evidence, analysis, calculations, rule pack, checklist, agent configuration and human decision log. Its manifest binds artifact hashes, the review profile, reviewer, chain, registry and intended predecessor.
- **Private opening:** the manifest and an independent, cryptographically random 32-byte blinding nonce. Keep both encrypted with the evidence.
- **Public reference:** the versioned tuple of chain ID, registry address, reviewer address and commitment. A reference alone does not prove that a receipt exists.

The package schema is `lexaegis.review-package.v1`; the reference and opening schemas are `lexaegis.receipt-ref.v1` and `lexaegis.opening.v1`. The legal profile is `lexaegis.employment-settlement.ew`, version `1`.

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

| Action | Required state | Result |
| --- | --- | --- |
| Issue | Commitment has never been issued by that reviewer | A new active receipt. |
| Revoke | Receipt is active | Terminal revoked state; history remains. |
| Supersede | Old receipt is active; replacement is new | Old receipt becomes superseded and replacement becomes active in one transaction. |

Revoking a replacement never reactivates an earlier receipt. Previously issued commitments cannot be overwritten or reused within the reviewer's namespace.

EIP-712 authorisation uses domain name `LexAegisProofOfReview`, version `1`, the actual chain ID and registry address. Every signed action binds reviewer, action, commitment, replacement commitment, nonce and deadline. The contract enforces its own one-use reviewer counter and expiry checks; EIP-712 alone does not prevent replay. Maintained OpenZeppelin signature verification supports EVM account signatures and deployed ERC-1271 accounts.

Any executor may submit a valid signed action; this does not grant permission to create an approval. Invalidating the reviewer's current nonce cancels outstanding instructions using it. Expiry ends an unexecuted authorisation, not an already issued receipt.

Verification reports file/manifest integrity separately from chain status. Missing evidence or an unavailable RPC must remain unknown or incomplete. Envio supplies history; a live registry read determines the current lifecycle state.

## 5. Approved architecture

| Module | Technology and responsibility |
| --- | --- |
| `apps/web` | Next.js App Router, React and Tailwind; Aegis command centre, legal review workspace, browser interaction controls and Node.js route handlers. |
| `apps/verifier` | Independently runnable Vite/React verifier, without a LexAegis login requirement. |
| `packages/protocol` | Closed Zod schemas, canonical encoding and portable protocol types. |
| `packages/sdk` | Framework-neutral receipt building and verification with viem and caller-supplied transports. |
| `packages/vault` | Browser Web Crypto, encryption and evidence-storage interfaces. |
| `packages/agent` | Server-only Qwen assistant runtime, case-scoped context, validated tool calls and bounded review execution; a separate browser-safe contracts export carries data types only. |
| `contracts` | Foundry, Solidity and OpenZeppelin registry implementation. |
| `indexer` | Envio HyperIndex configuration, schema and lifecycle handlers. |
| Operational storage | PostgreSQL for minimal operational/authentication metadata; S3-compatible object storage for ciphertext. |
| Quality gates | TypeScript pnpm workspace, Vitest, Foundry, Playwright and meaningful CI checks. |

Use one TypeScript application stack and one model provider. The backend router routes review tasks to **Qwen 3.8 Max (`qwen3.8-max`)**; it is not a multi-provider orchestration platform. Claude Code builds the product; Qwen powers its review workflow.

The Qwen loop is limited to explicit steps and allowlisted tools: fact extraction, approved rule retrieval, code-based calculations, evidence checks and package preparation. Apply schema validation, token/step/time limits and bounded retries. Treat document content as untrusted input. The model cannot authorise approval, sign transactions, obtain wallet secrets or change the rule pack silently.

### 5.1 Aegis is an explicit product capability

The assistant and its supporting UI are mandatory MVP components. A generic chat box or a decorative orb does not satisfy this requirement. The assistant must carry a useful task from the user's request through actual tools to a source-linked result, with visible progress and user control.

| Component selected from the references | LexAegis adaptation | Owning chapters |
| --- | --- | --- |
| Calm persona and coherent conversation — P02, P06–P12 | Concise case-aware dialogue, follow-up questions, corrections and explanations of the selected clause. | 9, 10 |
| Bounded plans and observable tools — P08, P13–P15 | Show the actual review steps, current tool, completed results and failure state; enforce budgets and cancellation in code. | 9, 10, 12 |
| Cinematic orb and command-centre narration — blueprint §9, P32 | An original cobalt/cyan orb whose labels and animation follow verified application events. | 1, 10 |
| Evidence canvas and legal analysis — P11, P30 | Clickable source passages, calculations, missing-evidence cards and bounded text comparison of two supplied document versions. | 8, 9, 10 |
| Selective memory and briefings — P22, P23, P25 | Encrypted, inspectable matter notes and a brief covering confirmed facts, unresolved findings and the next review step. | 5, 9, 10 |
| Exact action previews — P14 | A dedicated approval card bound to the frozen package, separate from conversation and passkey session permission. | 4, 6, 10 |
| Activity timeline and truthful receipts — P12, P15, P32 | Clearly separated assistant activity, human decisions and indexed blockchain history. | 7, 9, 10 |
| Simulation discipline — P40 | One deterministic payment what-if panel with editable figures and an explicit SIMULATED label. | 8, 10 |
| Invited voice and interruption — P02, P10; blueprint §7 | Push-to-talk into an editable draft, opt-in read-aloud and direct Stop controls on supported devices. | 10, 12 |
| Versioned prompt assets — README; P00, P34–P36 | A small pinned runtime prompt set, schema validation, provenance and focused failure/injection evaluations. | 9, 12 |

Useful requests include “Explain this clause”, “Why do these payments not add up?”, “What evidence is missing?”, “Brief me on this matter” and “Prepare the review package”. Short commands expose the same handlers: `/summarise`, `/explain`, `/check-payments`, `/missing-evidence`, `/prepare-review`, `/status` and `/stop`. Preparing a package never approves it.

### 5.2 Supporting UI and visual direction

Use an original obsidian/navy workspace with a luminous cobalt/cyan core, restrained rings and a faint background grid. Violet indicates active analysis, amber requests attention, green indicates a confirmed outcome and red identifies errors. Every state also has text and an icon. Readable documents take precedence over decoration.

| UI area | Required behaviour |
| --- | --- |
| Top status strip | Show the selected matter/version, passkey session, vault lock state and actual transaction/indexing status. Keep those states separate. |
| Left matter rail | Navigate matters, source documents, saved context and outstanding review items. |
| Command-centre view | Present the orb, one concise status sentence, task steps, assistant conversation and task-relevant result cards. |
| Review view | Give the document and its findings most of the screen; keep the assistant docked beside them and the orb compact. Preserve the selected clause when changing views. |
| Evidence/approval panel | Open cited passages and calculations; switch to a precise package/action preview when the user chooses to approve, revoke or supersede. |
| Bottom command dock | Text input, scoped command menu, supported voice control and an always reachable Stop action. |
| Activity drawer | Distinguish model/tool activity from signed human decisions and confirmed on-chain events. Show timestamps and useful evidence links. |

On smaller screens, use stacked views or tabs with the same controls. Support keyboard navigation, visible focus, screen-reader labels and reduced motion. Render the orb with lightweight CSS/SVG; a 3D/WebGL scene, constant particle simulation and fabricated system telemetry are unnecessary. No invented risk percentage, tool success or blockchain confirmation is allowed.

The UI consumes validated, ordered runtime events associated with the current matter, document version and run. It must ignore late results from cancelled or superseded runs. User-facing progress describes the actual operation, not private model reasoning. Use deterministic status labels instead of spending a model call on every animation or progress message.

### 5.3 Context, voice and what-if boundaries

Matter memory contains user-confirmed facts, notes, source/version references and concise saved outcomes. Users can inspect, correct, remove and export it through the encrypted vault. Keep raw chat ephemeral by default. Do not mix matters or turn a model inference into a confirmed fact. Changing working context cannot mutate a previously approved package; deleting a note does not erase a blockchain record or an exported copy.

Voice is a capability-gated enhancement to the complete text workflow. For this MVP, enable speech recognition only when on-device processing is supported and verified; never silently fall back to a remote speech service. Require a visible user activation, microphone indicator, editable transcript and Send action. Offer opt-in read-aloud with a verified local device voice. If either capability is unavailable, show a clear explanation and retain the text controls. No wake word, background listening, retained audio or additional paid speech integration is included.

Stop must cancel capture/playback and prevent new assistant tool calls after cancellation is acknowledged. It must not claim to reverse an already broadcast blockchain transaction or retract plaintext already sent to a provider. Voice and chat cannot approve a receipt: the separate review/signing ceremony remains required.

The what-if panel reuses the existing integer-minor-unit calculator. For example, changing the hypothetical second instalment from £12,000 to £14,000 removes the arithmetic gap against £24,000. The result remains SIMULATED and does not alter the document, resolve a legal finding, enter the approval package automatically or prove a payment occurred. Any proposed correction requires an actual new source version and renewed review. Full digital twins, branching simulations and predicted legal outcomes are excluded.

### 5.4 Compact assistant runtime

Adapt the older project's “model proposes, code executes” boundary to TypeScript. Use one Qwen runtime with a small common policy and only the task-specific prompt, relevant case context and allowed tool schemas needed for the turn. Pin actual prompt versions and hashes in the existing agent-configuration artifact. Do not import the 420-asset framework, add independent critic agents or make a separate model call for every orchestration step.

Case briefings run when requested or when already available state can be rendered directly. No always-on scheduler, general personal memory system, arbitrary browser/desktop control, email sending or smart-home integration enters the MVP. These choices preserve the useful Aegis interaction while keeping the existing protocol, stack, five bounty targets and deadline intact.

## 6. Privacy, passkeys and recovery

Mera provides the entire reference-app account layer. The target experience has no seed phrase, wallet extension, email/OTP account flow or custodial user-key backend. A supported setup should demonstrate onboarding with one passkey prompt and signing within a scoped, memory-only session. Session expiry requires renewed user authentication. A session never substitutes for explicit approval of the displayed package.

The vault is the meaningful non-wallet use of Mera's PRF output. Signing and encryption use separate purpose/domain namespaces and suitable key derivation. User signing keys, PRF outputs, unwrapped encryption keys and signing-session secrets remain in memory; never persist them in browser storage, cookies, the database or logs. Provider API credentials remain server-side and are separate from user secrets.

Persist ciphertext and the recovery metadata needed to rediscover it after local caches are wiped. Do not make browser-local state the sole route back to evidence. Demonstrate recovery using the **same synced passkey credential**, including a fresh profile or supported second device. Creating a new passkey is not recovery of the old one. Detect unsupported authenticator capabilities explicitly.

Passkey origin/relying-party boundaries still apply. Cross-device recovery does not imply automatic decryption on an unrelated origin. Portability requires explicit export/import or re-encryption, and the user controls which recipient receives an opening and evidence.

Encryption protects stored evidence, but selected plaintext sent for analysis is visible to the backend and model provider. This is not confidential computation or zero-knowledge AI. Keep confidential text, unsalted document hashes, filenames, storage links and amounts off-chain. Public account addresses, timing and receipt links still reveal activity.

Use synthetic legal matters for the public demonstration. Client-data pilots require separate operating and provider-data decisions. Do not describe a hosted testnet MVP as an audited production system.

## 7. Five core bounty targets

The following targets, award descriptions and evidence requirements reflect the approved hackathon information supplied in this project. They are not claims of entry acceptance, completed integrations or awards won.

| Bounty | Product integration and required evidence | Advertised award |
| --- | --- | --- |
| Best Mera-Powered UX on Monad | Entire account layer uses Mera. Show onboarding, scoped signing-session behaviour, expiry/re-prompt, a confirmed Monad transaction and recovery after clearing browser storage. Record actual taps and elapsed time. | $2,500 USD; one prize. |
| Mera: One Passkey, Many Keys | Use a separate PRF namespace for the encrypted evidence vault. Show purpose separation, no persisted plaintext user keys and live decryption recovery with the same credential on another supported device/profile. | $2,500 USD; one prize. |
| Best Use of Envio | Run an actual HyperIndex pipeline with `config.yaml`, `schema.graphql` and handlers. Index issued, revoked and superseded events into useful history and derived state. Handle replay, lag and reorganisation. | $1,000 USD; one prize. |
| Best Builds with Qwen 3.8 Max | Demonstrate live, bounded agent planning and tool execution that materially produces the review. Deliver a working Monad application and publish an article explaining Qwen's actual use and value. | $5,000 credit pool shared across the top three Track 4 winners; not $5,000 per team. |
| Best Projects using Alchemy | Use Alchemy for real Monad RPC reads, transmission of signed transactions, confirmation and current-state verification. Keep credentials server-side. Mera remains the user account layer. | $1,000 in Alchemy credits; one prize. |

Envio is a core integration in this scope. It is no longer an optional extension to remove before the demo. Avoid counting one supersession as two newly created receipts when processing its events. Evidence must distinguish application-generated test data from actual network activity.

The main track advertises $30,000 total across three $10,000 winners. Do not treat cash prizes, shared credit pools or possible award combinations as guaranteed project funding.

## 8. Prompt-library build sequence

Each chapter follows the Dual-Layer Rule: a short everyday explanation, followed by sequential, modular Targeted Component Execution Blocks using `📦 BUILD TASK`, `🛠️ ACTION TYPE` and `<execute_task>`. Claude Code edits actual files, validates meaningful outcomes and omits conversational filler, full-file echoes and standalone JSON status reports. Instructions remain scoped to the current chapter and existing repository state.

| Chapter | Title | Prompt status |
| --- | --- | --- |
| 1 | Runnable Monorepo, Shared Types and Build Checks | Authored, v2.2; assistant/UI foundation added. |
| 2 | Receipt Format, Canonical Hashing and Private Commitments | Authored, v1.0. |
| 3 | Monad Registry, Approval Signatures and Receipt Lifecycle | Authored, v1.0. |
| 4 | Mera Passkeys, Signing Sessions and Account Recovery | Next to author. |
| 5 | Encrypted Evidence Vault, Stateless Recovery and Portable Export | Planned. |
| 6 | Alchemy Transactions, Testnet Funding and Live Verification | Planned. |
| 7 | Envio Indexer, Review History and Derived Status | Planned. |
| 8 | Document Intake, Source References and Deterministic Checks | Planned. |
| 9 | Qwen 3.8 Max, Aegis Assistant Runtime and Review Tools | Planned; assistant behaviour, context, tools, events and package preparation. |
| 10 | Aegis HUD, Legal Workspace and Human Approval | Planned; complete connected assistant UI, evidence, context, voice controls and signing flow. |
| 11 | Protocol SDK, Independent Verifier and Developer Integration | Planned. |
| 12 | End-to-End Recovery, Privacy and Security Validation | Planned. |
| 13 | Production Deployment and Hackathon Submission Assets | Planned. |

Prompt authorship is separate from implementation progress. `CLAUDE.md`, `docs/assistant-ui-contract.md` and `docs/build-state.json` should record actual repository decisions, the required assistant/UI components and verified results when these chapters are executed. Chapter 1 v2.2 creates that continuity contract. Existing Chapter 1 implementations need only its additive interface, shell and continuity amendments, with relevant checks; Chapters 2–3's wire formats and registry design are unchanged. No component is complete merely because its prompt exists.

## 9. Delivery window and acceptance

**Internal submission target:** 12 October 2026.  
**Hard deadline:** 14 October 2026, 04:59 GMT+1/BST (`2026-10-14T04:59:00+01:00`, or 03:59 UTC).

The stated two-week build budget does not extend the hard deadline. Deliver the complete hosted Monad testnet workflow inside that cutoff. Reserve the final window for submission checks and critical fixes.

The MVP is complete when:

- A supported synthetic agreement produces live source-linked findings, deterministic payment checks, a memo and an evidence checklist. Evaluate at least 12 fixtures covering clean controls, seeded discrepancies, missing fields and conflicting terms; report observed results without claiming general legal accuracy.
- A conversational request starts a real bounded task; the orb, step list and activity drawer reflect its execution. A citation opens the correct clause, follow-up questions retain the selected matter/version, and Stop prevents further tool dispatch after acknowledgement.
- Command-centre and Review views work on desktop and mobile with keyboard and reduced-motion access. Unavailable voice remains clearly unavailable; supported voice creates an editable draft and uses a separately tested local speech path.
- Saved case context survives authorised vault recovery without cross-matter leakage. Payment what-if results remain visibly simulated and cannot authorise or alter a real receipt.
- The reviewer deliberately approves an immutable package, its encrypted opening is recoverable, and a real Monad transaction confirms the receipt.
- A separate verifier accepts the exact supplied package, detects altered bytes and distinguishes active, revoked, superseded, missing and unknown states.
- Wrong-account, wrong-chain, wrong-registry, replayed and expired authorisations fail; supersession is atomic and preserves history.
- Both Mera demonstrations succeed: account access after local storage clearance and vault decryption on a supported second device/profile using the same credential.
- Envio history agrees with confirmed events, and current-state checks remain honest when indexing or RPC access fails.
- Document instructions cannot trigger approval, signing or secret disclosure; model and provider failures do not produce fabricated successful reviews.
- The SDK can be used outside the reference app, with synthetic examples and usable exported verification material.
- All five integrations have actual evidence, including the published Qwen article, and the submission assets are ready.

## 10. Demonstration and submission

Use a fictional agreement with a £24,000 stated total and instalments of £10,000 and £12,000. Ask the assistant to check it, show the actual task steps and open the £2,000 mismatch at its source clauses. Briefly demonstrate the labelled payment what-if result, then review an actual corrected source version, record a human decision and approve its package. Show the real transaction, indexed history and independent verification. Alter a file and demonstrate failure; show revocation or supersession without erasing the earlier record.

The technical demo must show the working product within three minutes. Capture the Mera recovery and session evidence clearly; additional bounty clips can carry demonstrations that do not fit the main video. Never substitute an unlabelled simulation for a live integration.

Required submission assets:

- Logo in JPG, JPEG, PNG or WEBP, at most 3 MB.
- Public GitHub repository accessible to `metropolis@hackathon.monad.xyz`.
- Live product URL and clear judge access instructions, including supported passkey setup.
- Working-product technical demo of at most three minutes on YouTube, Loom or Vimeo; not a slide deck or code walkthrough.
- Pitch video of at most two minutes covering team, problem and why this approach matters.
- Deployed contract/network details, integration evidence and the published Qwen article.

An optional advertisement of at most 30 seconds is outside the judged technical deliverables. The supplied judging weights are technical execution 20%, design/craft and developer experience 20%, originality/track insight 15%, founder/market readiness 25%, and traction/path forward 20%.

## 11. Scope boundaries

Exclude OCR, additional jurisdictions, immigration eligibility, full practice management, billing, a client portal, automatic legal advice, autonomous approvals, negotiation, settlement payments, trading, tokens, a marketplace, vector databases, model fine-tuning and a multi-agent framework.

Do not add Privy, Dynamic, Kimi, Chainlink CRE or further bounty integrations to this MVP. Do not add automatic legal-source monitoring, a professional identity authority, zero-knowledge proofs, confidential-computation claims or a separate backend framework. Mera, Qwen, Envio and Alchemy already support the selected five-bounty path.

If delivery pressure increases, reduce decorative animation, additional visual themes and optional drafting. The case-aware assistant, functional command dock, evidence view, truthful state display and Stop/approval controls remain required. Capability-gated voice must degrade honestly to text. Changes to the approved protocol or bounty scope must be made explicitly rather than hidden behind simulated completion.

## 12. Source and decision record

This revision incorporates the original LexAegis and SettleOS concepts, the refined brief v1.0, subsequent approved scope/bounty decisions and the current Chapter 1–3 prompt files. Event dates, award amounts, judging weights and submission requirements above are the user-supplied project requirements.

The three attached references were read as design sources:

- `AEGIS_Engineering_Playbook_and_Prompt_Library_Blueprint_v0_1.md`: especially runtime states, invited voice, selective memory, typed tools and the cinematic interface specification.
- `Aegis_Prompt_Library_Outline(1).md`: especially P02, P06–P15, P22–P23, P25, P30, P32–P36 and the limited adaptation of P40.
- `README.md`: reported text-core architecture, deterministic execution boundaries and pinned prompt provenance. It explicitly reports no implemented desktop UI or voice; this brief does not claim reusable UI source was supplied.

The Markdown blueprint references image files that were not included with these attachments. This adaptation uses its written visual specification, not an inspection of those missing images. The older project's Python/Tauri/Claude runtime, long delivery schedule and development-only release conventions do not override LexAegis's approved stack or deadline.

Technical references:

- [Mera repository and current API status](https://github.com/category-labs/mera) — passkey-derived accounts and signing sessions; currently a preview SDK, with application-controlled recovery and storage flows.
- [Alibaba Cloud Model Studio model catalogue](https://www.alibabacloud.com/help/en/model-studio/models) — includes `qwen3.8-max`.
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) — canonical JSON encoding.
- [EIP-712](https://eips.ethereum.org/EIPS/eip-712) — typed structured-data signing; replay protection is an application responsibility.
- [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) — contract-account signature verification interface.
- [OpenZeppelin cryptography utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography) — maintained signature-verification building blocks.
- [Monad documentation](https://docs.monad.xyz/), [Alchemy Monad documentation](https://www.alchemy.com/docs/reference/monad-api-faq) and [Envio documentation](https://docs.envio.dev/) — integration references for the later chapters.
- [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) and [SpeechSynthesisVoice.localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService) — browser support and processing locality must be checked; browser speech is not universally available or automatically local.

Dependency versions, SDK capabilities and deployment configuration must be verified and pinned during implementation. No integration, test, external adoption or deployment is represented as completed by this brief.
