## Chapter 8 — Document Intake, Source References and Deterministic Checks

This chapter lets users bring agreements into LexAegis, click a finding to see its exact source, check whether payment figures add up, and track missing evidence. It also adds a comparison of two document versions and a clearly labelled payment what-if panel. Documents stay in the encrypted vault. These components give Aegis reliable tools to use in Chapter 9; the final human-approval screen follows in Chapter 10.

```text
📦 BUILD TASK #1: Document-review dependencies and chapter boundaries
🛠️ ACTION TYPE: Validate

<execute_task>
Act as the LexAegis implementation engineer. Execute Tasks #1–#15 sequentially through repository edits. Omit conversational fluff, architectural essays, full-file echoes and terminal JSON status reports. Produce code files, closed schemas, deterministic fixtures and compact factual build records. Preserve unrelated changes.

Read applicable repository instructions, CLAUDE.md, docs/build-state.json, docs/assistant-ui-contract.md and relevant Chapter 2–7 modules. Reuse protocol primitives, encrypted MatterRecordV1/source descriptors, vault transactions, recoverable-capture validation and browser-safe assistant contracts.

Implement browser-local text-based PDF intake, immutable extraction, exact source references, human-confirmed facts, GBP reconciliation, a versioned evidence checklist, bounded two-version text comparison and supporting Aegis controls. Keep the profile lexaegis.employment-settlement.ew version 1.

Do not add OCR, DOCX conversion, remote document parsing, immigration rules, tax calculation, entitlement valuation, semantic redlining, automatic document editing or a general simulation engine. Existing opaque evidence files may remain stored; do not pretend their content was extracted.

No Qwen call, transaction submission or receipt-approval implementation belongs here. Chapter 9 supplies the assistant runtime; Chapter 10 completes approval. A successful check or saved document cannot enable signing.

Check current official APIs, installed declarations and security advisories:
https://mozilla.github.io/pdf.js/
https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
https://github.com/mozilla/pdf.js/security/advisories
https://github.com/kpdecker/jsdiff
https://www.acas.org.uk/settlement-agreements
https://www.legislation.gov.uk/ukpga/1996/18/section/203
https://www.legislation.gov.uk/ukpga/2010/15/section/147

Pin compatible maintained dependencies and generate genuine lockfile changes. Treat unreadable legal sources as unverified; never claim they were checked or silently substitute an old statutory version.
</execute_task>

📦 BUILD TASK #2: packages/agent review contracts and pure exports
🛠️ ACTION TYPE: Extend

<execute_task>
Add closed, versioned Zod contracts for ExtractedDocumentV1, SourceReferenceV1, FactCandidateV1, ConfirmedFactV1, PaymentReconciliationV1, RulePackV1, CheckFindingV1, EvidenceChecklistV1 and DocumentComparisonV1. Extend existing compatible contracts instead of creating competing definitions.

Keep these application schemas outside the generic receipt protocol. Export them through @lexaegis/agent/contracts. Export pure review functions through @lexaegis/agent/review, without Next.js, Qwen credentials, wallet/vault controllers or browser globals. Keep PDF parsing in the web application.

Bind results to matterId, documentVersionId, exact source/extraction hashes, input revision, rule-pack version/hash and applicable engine version. Use canonical integer-string money, actual UTC event timestamps and bounded safe integers for text offsets/page numbers. Reject unknown fields, invalid identifiers and non-finite coordinates.

Separate extraction coverage, fact confirmation, calculation outcome, evidence availability and human disposition. Use calculation outcomes match|mismatch|needs_input|not_comparable; evidence states supplied_unreviewed|confirmed_for_check|missing|not_assessed|not_applicable. None means legally_valid or human_approved.

Limit one selected review to 8 PDFs, 80 physical pages per PDF, 160 pages overall, 200 facts, 50 payment line items per reconciliation and 100 findings. Enforce Chapter 2's 10 MiB/artifact, 32 MiB/package and 128-artifact limits as hard ceilings.

Reserve capacity for derived artifacts: selected original PDFs total at most 20 MiB; each extraction artifact at most 2 MiB and all extraction artifacts at most 4 MiB. Check actual final package size independently. Return typed limit errors; never silently truncate a purported complete review.
</execute_task>

📦 BUILD TASK #3: apps/web/src/features/documents/pdf-intake.ts and worker lifecycle
🛠️ ACTION TYPE: Create

<execute_task>
Implement explicit file-picker/drop intake for text-based PDFs while the selected matter's vault is unlocked. Validate byte length, PDF signature and parser acceptance; filename/MIME alone is insufficient. Hash original bytes before any parser transfer and preserve an immutable copy through Chapter 5's encrypted storage flow.

Use a pinned, security-patched pdfjs-dist build with matching worker/assets. Load supplied Uint8Array data, never a document-controlled URL. Bundle necessary fonts/CMaps/WASM locally. Do not invoke PDF JavaScript, launch actions, embedded files, external links or a full interactive viewer. Disable XFA and unsupported evaluation features using actual supported options.

Parse in a dedicated terminable worker with one intake job at a time, a 30-second document deadline and explicit cancellation. Bound emitted text/items and rendered pixel area; byte-size limits alone do not bound decompression work. Do not use a Promise timeout that leaves parsing running.

Return distinct unsupported, password_required, no_extractable_text, partial_coverage, malformed, limit_exceeded, cancelled and failed outcomes. Password-protected files and OCR-only input remain unsupported here. Do not classify every empty page as a scan or declare it irrelevant.

Detect unsupported forms, annotations and other unextracted content where the parser exposes them. Surface coverage limitations; never imply that extracted page text covers every visible element or verifies a digital signature.

On lock, account/matter switch, cancellation or timeout, destroy loading/render tasks and worker resources, revoke object URLs and clear plaintext buffers/state on a best-effort basis. Tag callbacks with the active job and vault generation; discard stale results.

No plaintext upload, remote analysis request, telemetry payload or browser-persistent plaintext cache occurs during intake.
</execute_task>

📦 BUILD TASK #4: Deterministic extraction artifacts and source-version persistence
🛠️ ACTION TYPE: Create

<execute_task>
Create ExtractedDocumentV1 from each successfully parsed immutable source. Record source artifact/document/version identity, original SHA-256, parser version, relevant parser options and an extraction-format version.

For each physical page, preserve its 1-based index, optional printed label, extracted text, bounded item-to-text offsets and optional finite display geometry. Store coverage flags separately. Physical index is authoritative for navigation; repeated or missing printed page labels cannot identify a page uniquely.

Define one deterministic text-assembly rule using parser item order, explicit separators and hasEOL metadata. Pin normalisation options. Do not remove repeated clauses, silently dehyphenate, correct wording or reorder content using an LLM. PDF text order/whitespace may differ from visual layout; keep the original page available.

Offsets address the stored page text as UTF-16 code units, matching JavaScript slice semantics. Reject boundaries inside surrogate pairs. Normalised search text, if needed, is a separate view with a reversible offset map.

Serialize the extraction as RFC 8785 canonical JSON encoded in UTF-8, then SHA-256 its exact bytes using Chapter 2 helpers. Keep its own digest in the external artifact reference, not recursively inside the hashed payload. Do not insert fresh timestamps/random IDs during deterministic reprocessing of the same bound input.

Save original and extracted-text artifacts through encrypted copy-on-write vault operations. Re-read/decrypt and verify hashes before marking the version saved. Preserve an unsaved draft on a recoverable save conflict; never show success before the catalog commit.

Re-extraction with different parser/options creates a distinct extraction identity. Never overwrite an extraction referenced by findings or a frozen package. New source bytes require a new documentVersionId; matching filenames are not version identity.
</execute_task>

📦 BUILD TASK #5: packages/agent/src/review/source-references.ts
🛠️ ACTION TYPE: Create

<execute_task>
Define SourceReferenceV1 with exactly:
{schema:"lexaegis.source-ref.v1", documentId, documentVersionId, sourceArtifactId, sourceSha256, extractionArtifactId, extractionSha256, page, start, end, quote}

Use existing UUID/hash validators. Require a valid physical page, 0<=start<end<=pageText.length and quote===pageText.slice(start,end). Bound one quote to 4 KiB UTF-8. Validate full document/version/artifact/hash bindings against the active matter's authorised source set.

Implement createSourceReference and resolveSourceReference using an explicit supplied artifact lookup. Verify original/extraction byte hashes when loading the source set; reuse only that verified immutable set within its generation. Never resolve by filename, approximate quote matching, nearest page or another version's text.

Return resolved, unavailable, stale_version or integrity_mismatch explicitly. A repeated quotation remains distinguishable by page/offset. Multi-page statements require multiple references; do not invent a cross-page offset.

Support click-to-source navigation with a text highlight and original-page view. Derive geometry from the validated extraction mapping; if exact geometry is unavailable, show the precise text passage and labelled page without drawing a misleading highlight.

Hashes and quote matching establish reference consistency, not faithful transcription, factual truth or legal correctness. Keep extraction warnings alongside citations.

Use rule references plus explicit searched document scope for missing-evidence findings. Do not fabricate a quotation for an absence claim. Render source text, filenames and labels as escaped text, never executable HTML or document-supplied instructions.
</execute_task>

📦 BUILD TASK #6: Confirmed facts and evidence-selection controls
🛠️ ACTION TYPE: Create

<execute_task>
Implement matter-scoped fields for parties, adviser details, relevant dates, payment totals/instalments, comparison basis and evidence selections. Permit manual entry from a selected source passage. Later Qwen extraction feeds the same FactCandidateV1 schema.

Keep candidates separate from confirmed facts. A candidate carries its proposed value, provenance and validated references; schema-valid or source-linked does not mean confirmed. Only the explicit reviewer control may create a confirmation record under the active account/matter generation.

Record value, fact ID/revision, confirming account, actual confirmation time and source references. Distinguish source-backed facts from reviewer_statement entries with an explicit reason. A reviewer statement cannot be presented as a quotation or silently satisfy a source-evidence requirement.

Show the cited passage beside each confirmation/edit control. Conflicting candidate values remain visible; do not choose the last value automatically. Unknown is not zero, false, absent or not_applicable.

Parse user-confirmed civil dates as validated YYYY-MM-DD calendar dates. Preserve ambiguous source dates such as 03/04/2026 until the reviewer resolves their meaning. Do not use locale-dependent Date parsing or substitute the blockchain approval date for agreement execution.

Correct/remove operations create a new working revision, invalidate dependent results and clear obsolete confirmation. Do not mutate source bytes or prior frozen reviews. Save through Chapter 5's confirmed-context/vault interfaces without duplicating the account or persistence layer.

Document content, imported JSON and model tool responses cannot set confirmed=true, select a reviewer, change the active rule pack or approve a receipt.
</execute_task>

📦 BUILD TASK #7: packages/agent/src/review/payments.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement one pure GBP arithmetic kernel with closed review/simulation adapters, reused by checks, future agent tools and the what-if panel. Review mode requires confirmed facts; simulation accepts explicitly hypothetical values without creating confirmation records. Every result carries its mode.

Parse validated decimal input into integer pennies without floating-point arithmetic. Reject exponential notation, malformed grouping, ambiguous currency, excess fractional digits and out-of-range values. Bound absolute input amounts to 18 decimal digits of minor units.

Require an explicit payment group, stated total, complete selected instalment schedule, unique line-item/source occurrences, GBP currency and one comparable gross/net basis. Allow nonnegative totals/instalments; zero is a value, not missing data. Do not mix salary, notice pay, compensation, legal fees or repeated totals unless explicitly identified as the same comparison group.

Compute comparableSum=sum(included instalments) and difference=statedTotal-comparableSum. Negative amounts or terms requiring deduction/tax conversion are outside this MVP reconciliation and return not_comparable. Return canonical decimal strings, formula, input identities/revisions, provenance and engine version. Equality is exact to one penny; no tolerance hides a discrepancy.

In review mode return needs_input for absent/unconfirmed inputs; in either mode return not_comparable for unresolved currency, basis, scope or overlapping items. Reject duplicate source occurrences even under different line-item IDs. Report any diagnostic subtotal as incomplete. Never issue match from a partial schedule or guessed tax treatment.

Keep tax, national insurance, interest, statutory entitlements, business-day deadlines and proof of actual payment outside this calculator. A matching schedule proves arithmetic consistency only.

Use the control vector: total £24,000; instalments £10,000 and £12,000; result £22,000 and difference £2,000. With a hypothetical second instalment of £14,000, difference is zero. Store the latter only as a SIMULATED result, never a correction to the real agreement.

Return stable result data for identical validated inputs. Add observation timestamps only in the caller's provenance envelope, outside the deterministic calculation core.
</execute_task>

📦 BUILD TASK #8: packages/agent/rules/employment-settlement-ew.v1.json
🛠️ ACTION TYPE: Create

<execute_task>
Create a small, versioned rule/checklist pack for the approved England-and-Wales employment-settlement profile. Use current Acas guidance and relevant current legislation as source material; record exact source URLs, section identifiers, retrieval dates, jurisdiction, coverage limitations and unresolved source checks.

Represent rules as data: stable ruleId, category, source references, required inputs/evidence, allowed result states and a fixed evaluator key. Dispatch through an allowlisted code map. Never execute expressions, scripts or arbitrary URLs stored in the rule pack.

Include checklist prompts for the written agreement, identified complaints/claims, relevant independent advice, adviser identification, adviser insurance/indemnity evidence and the agreement's required-condition statement. Separate textual observations from confirmation that advice, independence or insurance requirements were actually met. This is a scoped review aid, not an exhaustive enforceability test.

Add technical checks for source coverage, payment reconciliation, unresolved contradictory confirmed facts and missing reviewer-selected evidence. Clearly distinguish these product checks from statutory requirements. Do not invent a mandatory certificate, universal payment deadline or statutory document-expiry period.

Keep project-review state and any genuine approval record separate from immutable rule-pack content, referencing its content digest. Use demo_draft until an actual reviewer approves that content. Do not invent legal qualifications or approval. Allow draft checklist inspection with clear status; the model cannot publish or alter rules.

Hash the exact canonical pack bytes with SHA-256, storing the digest externally. Results pin its version/hash and the separate review-record identity/state. Bind both content and review record in the eventual rule-pack artifact without a self-referential digest. Changed content/review state invalidates dependent working results; retain prior frozen versions.

Bundle approved packs locally. Runtime retrieval returns only selected rules from the pinned pack, with no live legal scraping, background updates or arbitrary document-provided URLs.
</execute_task>

📦 BUILD TASK #9: packages/agent/src/review/checks.ts and checklist.ts
🛠️ ACTION TYPE: Create

<execute_task>
Implement deterministic checks over verified source bindings, explicitly confirmed facts and a pinned rule pack. Return structured findings with stable check ID, input revision/digest, rule references, source references, observed values, result state and factual explanation template.

Implement only: extraction/source-integrity coverage; payment reconciliation; conflicting confirmed values for the same field; missing required inputs; and presence/review state of selected supporting evidence. Keyword searches may propose passages but cannot confirm legal meaning or declare a clause absent from an incompletely extracted document.

Populate EvidenceChecklistV1 from actual selected artifacts and reviewer decisions. supplied_unreviewed means a file was supplied; confirmed_for_check means the reviewer linked it to the specified requirement. Neither proves authenticity, independence, insurance validity or professional qualification.

not_applicable requires an explicit reviewer reason permitted by the rule. Missing evidence means not supplied/confirmed within the selected review scope, not that it cannot exist elsewhere. Report conflicts without resolving them automatically.

Keep raw check results separate from future human dispositions. Accepting a discrepancy with reasons cannot change mismatch to match; resolving it requires changed legitimate inputs and rerunning the check. Schema/hash/reference failures remain technical failures that cannot be waived into integrity success.

Do not produce a global legal-validity verdict, risk percentage, approval recommendation or green all-clear from passing arithmetic. Use plain findings such as Payment schedule differs by £2,000 and Adviser evidence has not been confirmed.

Generate concise deterministic explanation text from validated result fields. No LLM call is needed to add, compare, display status or list missing evidence. Sort findings by fixed priority and stable IDs, not random ordering or wall-clock timing.
</execute_task>

📦 BUILD TASK #10: Bounded comparison of two supplied source versions
🛠️ ACTION TYPE: Create

<execute_task>
Implement compareDocumentVersions for exactly two explicitly selected, accessible PDF versions in the same matter. Verify both source/extraction identities. Keep old/new direction explicit and preserve source bytes.

Use the pinned diff package's documented line/token API in a cancellable worker. Compare stored extracted text with case, numbers, punctuation and whitespace differences preserved. No model inference, semantic equivalence claim, automatic patch application or inferred legal impact.

Maintain mappings from diff input offsets back to each version's physical pages and UTF-16 offsets. Each nonempty added/removed span links to validated SourceReferenceV1 entries on the side where that text exists. Zero-width insertion positions are navigation anchors, not fabricated quotes. Split multi-page or oversized quotations into bounded references.

Limit each selected text input to 200,000 UTF-16 code units, maximum edit distance 5,000 and execution to 2 seconds using supported library limits plus worker termination. An aborted/undefined result means comparison_incomplete, not no_changes. Never silently compare only a prefix.

For larger inputs, require an explicit smaller page-range selection and label that comparison scope. If parser/options differ or extraction coverage is incomplete, display those limitations. Identical extracted text does not prove identical PDFs, layout, annotations or signatures; show original-byte equality separately.

Save only an explicitly requested comparison through the encrypted vault. Preserve its two input identities and engine/options. Include both versions' referenced artifacts if the comparison later enters a review package.
</execute_task>

📦 BUILD TASK #11: apps/web/src/features/review controller and result invalidation
🛠️ ACTION TYPE: Create

<execute_task>
Create one matter-scoped controller coordinating document selection, extraction, confirmed facts, checks, comparison and encrypted saves. Reuse the existing account/vault generation and cancellation patterns.

Capture a ReviewInputSnapshot containing selected immutable source/extraction identities, confirmed facts with revisions and content hashes, evidence selections, rule-pack/review-record identities and engine versions. Bind actual input content, not revision numbers alone. Canonicalise/hash this application snapshot; keep its digest private and distinct from Chapter 2's blinded public commitment.

Bind each asynchronous job and result to the snapshot digest, matter/version and controller generation. Recheck before accepting results. Source changes, fact corrections, evidence-selection changes or rule changes mark dependent results stale and clear any draft readiness. A late completion cannot restore an old ready state.

Persist review data only through Chapter 5's encrypted copy-on-write records and read-back checks. Keep filenames, quotes, extracted text, facts, result hashes and private version relationships out of operational backend metadata, logs, analytics, URL parameters and public indexing.

Use explicit saves for working results and preserve truthful saving/saved/conflict/error states. On concurrent changes, reload/reapply using existing vault semantics; never merge a finding against another revision silently.

Handle Stop locally for extraction, comparison and checking jobs, without waiting for an LLM. Cancel workers, clear pending dispatch and ignore stale callbacks. Stop does not erase saved versions or change existing blockchain receipts.

Expose typed local progress for the HUD. Keep local processing, assistant runs, human decisions and chain events distinct. Enforce the existing limits on selected saved context rather than loading the whole vault into a review or future model request.
</execute_task>

📦 BUILD TASK #12: Review artifact assembly and frozen-package compatibility
🛠️ ACTION TYPE: Extend

<execute_task>
Implement a draft artifact assembler using Chapter 2's existing artifact roles and byte hashing. Do not introduce a new receipt format or change the commitment algorithm.

Prepare source/evidence originals, extracted-text artifacts, a calculation artifact, evidence checklist, a rule-pack artifact binding exact content/review record, and structured review-analysis artifacts containing confirmed facts/findings and explicitly included comparisons. Use versioned deterministic JSON. Include complete provenance and limitations without claiming AI analysis occurred.

Verify every source/rule/input reference resolves to the exact included artifact or explicit recorded reviewer statement. Preserve immutable artifact IDs where already assigned. Reject missing dependencies, mismatched hashes, stale results, inconsistent snapshot bindings and exceeded package limits. A comparison requires both referenced versions; never quietly drop one side.

Keep draft technical completeness separate from legal concerns and reviewer disposition. Missing/corrupted bytes and invalid citations block integrity readiness. Missing evidence or unresolved findings stay visible for Chapter 10's explicit human decisions; do not fabricate accepted reasons or an empty decision log.

Do not create fake model/prompt configuration: Chapter 9 supplies the actual agent-config and analysis provenance when its runtime executes. Chapter 10 supplies the genuine decision log and approval interaction. This chapter returns a typed draft with outstanding requirements, not a production-ready signed capture.

Exclude ephemeral conversation, unconfirmed model proposals and SIMULATED payment results from automatic package assembly. Selected confirmed working facts may enter only as explicit snapshot data.

Hand completed artifacts to the existing freeze/vault capture interfaces when later gates are satisfied. Frozen sources, results and rule packs remain immutable after subsequent working edits. No public receipt reveals these private artifact hashes or contents.
</execute_task>

📦 BUILD TASK #13: Aegis document workspace, evidence cards and payment what-if panel
🛠️ ACTION TYPE: Extend

<execute_task>
Connect DocumentIntakePanel, SourceViewer, FindingsPanel, EvidenceChecklist, DocumentComparison and PaymentWhatIfPanel to real Chapter 8 controllers. Reuse existing Aegis components/tokens rather than create a second dashboard.

Keep the document dominant in Review mode, with the assistant docked, a compact orb and selected-clause state preserved when switching views. Show actual file/version, extraction coverage, saved state and stale-result markers. Provide Explain selection as a typed Chapter 9 handoff; show unavailable until the runtime exists.

Selecting a finding opens the exact source passage and relevant calculation/evidence card. Use a lazy page canvas and accessible extracted-text view. Render at most two page canvases concurrently and cap each at 8 million pixels. Surface missing/approximate visual mapping without inventing precision.

Provide source-side confirmation/edit controls, a payment table with explicit basis and included items, missing-evidence actions and two-version comparison navigation. Show unknown/unsupported states in text and icons; no fabricated risk score or legal-validity badge.

The what-if panel copies selected payment values into isolated ephemeral state and calls the simulation adapter over the same arithmetic kernel. Label inputs and every output SIMULATED. Include Reset and a visible difference from actual figures. It cannot update confirmed facts, source bytes, findings, package readiness or transaction state. No Apply to agreement or automatic correction action.

Changing contractual figures requires a newly supplied source version and renewed review. Correcting a mistaken transcription uses the separate fact-correction control against its actual source. Closing/locking/changing matter clears simulation data. Keep real findings unchanged when a simulated discrepancy becomes zero.

Support keyboard source navigation, visible focus, screen-reader labels, mobile tabs and reduced motion. Escape all document-controlled content. Clear private panes and cancel jobs on vault lock; stale responses cannot repopulate them.
</execute_task>

📦 BUILD TASK #14: Deterministic fixtures and document/privacy tests
🛠️ ACTION TYPE: Validate

<execute_task>
Create at least 12 synthetic, non-client fixtures with independently specified expected results. Include actual PDFs for extraction/navigation tests, not only mocked extracted JSON. Mark fixtures DEMO/SYNTHETIC and keep them outside production matter data.

Cover: clean payment control; £2,000 discrepancy; one-penny discrepancy; missing instalment; gross/net mismatch; non-GBP amount; repeated total/duplicate source selection; contradictory confirmed facts; missing adviser evidence; repeated quote and printed page labels; mixed image/text coverage; changed amount/negation across two versions. Add focused adversarial cases for surrogate pairs, stale references, malformed PDFs, parser limits and prompt-injection text.

Assert exact penny results, blocked incomplete comparisons, correct physical-page/offset resolution, stable deterministic output, original-byte preservation and input-revision invalidation. Test values beyond Number.MAX_SAFE_INTEGER within the permitted decimal-string range.

Exercise actual PDF worker cancellation/timeouts and reject stale completion after account/matter changes. Verify corrupted source/extraction hashes fail, unsupported/empty extraction cannot produce a complete clean review, and a diff timeout is not reported as equality.

Use Playwright to import a synthetic PDF, confirm cited inputs, run checks, open a citation, save encrypted state, reload/unlock, compare versions and run/reset a simulation. Confirm simulation cannot change real findings or enter draft artifacts.

Inspect network/storage/log output with synthetic private canaries. Intake and local checks may request static application assets and ciphertext transport, but must send no legal plaintext to backend analysis or external services. No plaintext localStorage/IndexedDB/service-worker cache, raw document logging or document-controlled network fetch.

Record observed fixture results and unsupported cases. Do not turn synthetic accuracy into claims about general legal reliability, user traction or completed Qwen integration.
</execute_task>

📦 BUILD TASK #15: Build gates and Chapter 9 tool handoff
🛠️ ACTION TYPE: Validate

<execute_task>
Run affected schema/type checks, lint, unit tests, real PDF/browser integration tests and web/agent builds. Verify browser-safe exports cannot import the server runtime, credentials or signing/vault keys. Fix concrete failures; report unavailable prerequisites honestly in repository records.

Expose typed read-only entry points for resolving selected sources, retrieving pinned rules, reconciling payments, checking evidence and obtaining draft artifact requirements. Require explicit matter/version/snapshot scope and bounded inputs. These interfaces are the tools Chapter 9 will wrap; do not create a generic execution tool or model-controlled confirmation mutation.

Provide a selected-context builder containing only deliberately selected excerpts, references and relevant confirmed facts within the existing 32 KiB context limit. Reject oversized selection rather than silently truncating required evidence. Document data is untrusted content, never instructions or permission to fetch links/use tools.

Preserve an explicit consent boundary before any future plaintext transmission to the backend/Qwen. Local intake does not grant that consent. The future request must identify the provider, selected matter/version and disclosed content; changed selection requires the corresponding valid consent scope. Do not misdescribe encrypted storage as hiding deliberately submitted analysis text from the provider.

Update docs/build-state.json with implemented modules, exact passed/failed/skipped checks, extraction limitations and rule-pack review state. Preserve factual separation between generated code, executed local tests and external integrations.

Update docs/assistant-ui-contract.md within its existing size budget with source selection, findings, comparison, simulation isolation, cancellation and stale-result behaviour. Keep the planned conversational Aegis runtime and final approval screen intact.

Stop after Chapter 8. Hand Chapter 9 validated source/fact contracts and deterministic tools; hand Chapter 10 the working document/evidence controls and draft artifacts. Omit conversational summaries, invented approvals and terminal JSON reports.
</execute_task>
```
