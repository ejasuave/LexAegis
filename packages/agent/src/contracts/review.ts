import { z } from 'zod';
import { digestSchema, timestampSchema, uuidSchema } from '@lexaegis/protocol/v1';

/*
 * Chapter 8 review contracts: extraction, source references, facts, payment reconciliation, rule
 * packs, findings, evidence and comparison. Application schemas, outside the receipt protocol.
 * Closed objects only. Money is canonical integer pence in decimal strings. None of these states
 * means legally valid or human approved: coverage, confirmation, calculation, evidence
 * availability and human disposition are separate dimensions.
 */

export const REVIEW_PROFILE = Object.freeze({
  id: 'lexaegis.employment-settlement.ew',
  version: '1',
});
export const REVIEW_ENGINE_VERSION = 'lexaegis.review-engine.v1';

export const REVIEW_LIMITS = Object.freeze({
  pdfsPerReview: 8,
  pagesPerPdf: 80,
  pagesPerReview: 160,
  facts: 200,
  paymentLineItems: 50,
  findings: 100,
  /** Selected original PDFs together, leaving room for derived artifacts under Chapter 2's 32 MiB. */
  originalBytes: 20 * 1024 * 1024,
  extractionArtifactBytes: 2 * 1024 * 1024,
  extractionTotalBytes: 4 * 1024 * 1024,
  quoteBytes: 4096,
  itemsPerPage: 20_000,
  compareInputCodeUnits: 200_000,
  compareMaxEditDistance: 5_000,
  compareTimeoutMs: 2_000,
  contextBytes: 32 * 1024,
});

export const REVIEW_LIMIT_CODES = [
  'TOO_MANY_PDFS',
  'TOO_MANY_PAGES_IN_PDF',
  'TOO_MANY_PAGES',
  'TOO_MANY_FACTS',
  'TOO_MANY_LINE_ITEMS',
  'TOO_MANY_FINDINGS',
  'ORIGINALS_TOO_LARGE',
  'EXTRACTION_TOO_LARGE',
  'EXTRACTIONS_TOO_LARGE',
  'PACKAGE_TOO_LARGE',
  'TOO_MANY_ARTIFACTS',
  'QUOTE_TOO_LONG',
  'COMPARE_INPUT_TOO_LARGE',
] as const;
export type ReviewLimitCode = (typeof REVIEW_LIMIT_CODES)[number];

const pageNumber = z.number().int().min(1).max(REVIEW_LIMITS.pagesPerPdf);
const offset = z.number().int().min(0).max(10_000_000);
/** Display geometry in thousandths of a PDF point, as integers (canonical JSON carries no floats). */
const milli = z.number().int().min(-1_000_000_000).max(1_000_000_000);

/** Canonical non-negative pence, up to 18 digits. */
export const penceSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
/** Signed pence, for differences. */
export const signedPenceSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]{0,17})$/)
  .refine((value) => value !== '-0', 'negative zero');

// ---- ExtractedDocumentV1 --------------------------------------------------------------------------

export const EXTRACTION_FORMAT_VERSION = 1;

export const extractionWarningSchema = z.enum([
  'annotations_present',
  'form_fields_present',
  'xfa_unsupported',
  'pages_without_text',
  'images_not_extracted',
  'signatures_not_verified',
  'text_order_may_differ_from_layout',
]);

export const textItemSpanSchema = z.strictObject({
  /** UTF-16 code-unit offsets into the page text. */
  start: offset,
  end: offset,
  /** Optional display geometry in milli-points (1/1000 of a PDF user-space unit). */
  box: z.strictObject({ x: milli, y: milli, width: milli, height: milli }).nullable(),
});

export const extractedPageSchema = z
  .strictObject({
    /** 1-based physical index: the only authoritative page identity. */
    index: pageNumber,
    /** Printed label, if any. Repeated or missing labels never identify a page. */
    label: z.string().max(64).nullable(),
    text: z.string().max(2_000_000),
    items: z.array(textItemSpanSchema).max(REVIEW_LIMITS.itemsPerPage),
    width: milli.nullable(),
    height: milli.nullable(),
    hasText: z.boolean(),
    hasImages: z.boolean(),
  })
  .check((ctx) => {
    const page = ctx.value;
    for (const item of page.items) {
      if (item.end < item.start || item.end > page.text.length) {
        ctx.issues.push({
          code: 'custom',
          message: 'item outside page text',
          input: page,
          path: ['items'],
        });
        return;
      }
    }
  });

export const extractedDocumentSchema = z
  .strictObject({
    schema: z.literal('lexaegis.extracted-document.v1'),
    formatVersion: z.literal(EXTRACTION_FORMAT_VERSION),
    documentId: uuidSchema,
    documentVersionId: uuidSchema,
    sourceArtifactId: uuidSchema,
    sourceSha256: digestSchema,
    extractor: z.strictObject({
      name: z.literal('pdfjs-dist'),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      /** The parser options that shaped the text. A different set is a different extraction. */
      options: z.strictObject({
        scripting: z.literal('not_loaded'),
        xfa: z.literal('disabled'),
        fontFace: z.literal('disabled'),
        textAssembly: z.literal('item-order;hasEOL=newline;other=none;nfc=false'),
      }),
    }),
    pageCount: z.number().int().min(1).max(REVIEW_LIMITS.pagesPerPdf),
    pages: z.array(extractedPageSchema).min(1).max(REVIEW_LIMITS.pagesPerPdf),
    coverage: z.strictObject({
      status: z.enum(['complete', 'partial', 'none']),
      pagesWithText: z.number().int().min(0),
      pagesWithoutText: z.number().int().min(0),
      warnings: z.array(extractionWarningSchema).max(16),
    }),
  })
  .check((ctx) => {
    const doc = ctx.value;
    const bad = (message: string) =>
      ctx.issues.push({ code: 'custom', message, input: doc, path: [] });
    if (doc.pages.length !== doc.pageCount) bad('page count');
    doc.pages.forEach((page, i) => {
      if (page.index !== i + 1) bad('page order');
    });
    const withText = doc.pages.filter((p) => p.hasText).length;
    if (doc.coverage.pagesWithText !== withText) bad('coverage count');
    if (doc.coverage.pagesWithoutText !== doc.pageCount - withText) bad('coverage count');
    const expected = withText === 0 ? 'none' : withText === doc.pageCount ? 'complete' : 'partial';
    // A page with images but no text, or any warning of unextracted content, keeps it partial.
    const incomplete = doc.coverage.warnings.some((w) =>
      [
        'images_not_extracted',
        'xfa_unsupported',
        'pages_without_text',
        'form_fields_present',
      ].includes(w),
    );
    if (doc.coverage.status === 'complete' && (expected !== 'complete' || incomplete))
      bad('coverage status');
    if (doc.coverage.status === 'none' && withText !== 0) bad('coverage status');
  });
export type ExtractedDocumentV1 = z.infer<typeof extractedDocumentSchema>;

// ---- SourceReferenceV1 ----------------------------------------------------------------------------

export const SOURCE_REF_SCHEMA = 'lexaegis.source-ref.v1';
export const sourceReferenceSchema = z
  .strictObject({
    schema: z.literal(SOURCE_REF_SCHEMA),
    documentId: uuidSchema,
    documentVersionId: uuidSchema,
    sourceArtifactId: uuidSchema,
    sourceSha256: digestSchema,
    extractionArtifactId: uuidSchema,
    extractionSha256: digestSchema,
    page: pageNumber,
    start: offset,
    end: offset,
    quote: z.string().min(1),
  })
  .check((ctx) => {
    const ref = ctx.value;
    if (ref.end <= ref.start) {
      ctx.issues.push({ code: 'custom', message: 'empty range', input: ref, path: ['end'] });
    }
    if (new TextEncoder().encode(ref.quote).byteLength > REVIEW_LIMITS.quoteBytes) {
      ctx.issues.push({ code: 'custom', message: 'quote too long', input: ref, path: ['quote'] });
    }
  });
export type SourceReferenceV1 = z.infer<typeof sourceReferenceSchema>;

export const SOURCE_RESOLUTIONS = [
  'resolved',
  'unavailable',
  'stale_version',
  'integrity_mismatch',
] as const;
export type SourceResolution = (typeof SOURCE_RESOLUTIONS)[number];

// ---- Facts ----------------------------------------------------------------------------------------

export const FACT_FIELDS = [
  'employer',
  'employee',
  'adviser_name',
  'adviser_organisation',
  'agreement_date',
  'termination_date',
  'payment_total',
  'payment_instalment',
  'payment_basis',
] as const;
export const factFieldSchema = z.enum(FACT_FIELDS);
export type FactField = z.infer<typeof factFieldSchema>;

/** A real civil date, YYYY-MM-DD. No locale parsing, no timezone. */
export function isCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days && year >= 1900;
}

function valueMatchesField(field: FactField, value: string): boolean {
  if (field === 'agreement_date' || field === 'termination_date') return isCivilDate(value);
  if (field === 'payment_total' || field === 'payment_instalment')
    return penceSchema.safeParse(value).success;
  if (field === 'payment_basis') return value === 'gross' || value === 'net';
  return value.length >= 1 && value.length <= 256;
}

const factIdentity = {
  factId: uuidSchema,
  matterId: uuidSchema,
  field: factFieldSchema,
  /** Groups line items of one comparison (for example "settlement"). */
  group: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** Distinguishes occurrences within a field, such as instalment 1 and 2. */
  slot: z.string().regex(/^[a-z0-9-]{1,40}$/),
  value: z.string().min(1).max(512),
};

export const factCandidateSchema = z
  .strictObject({
    schema: z.literal('lexaegis.fact-candidate.v1'),
    ...factIdentity,
    provenance: z.enum(['reviewer_selection', 'imported', 'model']),
    references: z.array(sourceReferenceSchema).max(4),
  })
  .check((ctx) => {
    const c = ctx.value;
    if (!valueMatchesField(c.field, c.value)) {
      ctx.issues.push({
        code: 'custom',
        message: 'value does not fit field',
        input: c,
        path: ['value'],
      });
    }
  });
export type FactCandidateV1 = z.infer<typeof factCandidateSchema>;

export const confirmedFactSchema = z
  .strictObject({
    schema: z.literal('lexaegis.confirmed-fact.v1'),
    ...factIdentity,
    revision: z.number().int().min(1).max(10_000),
    basis: z.enum(['source', 'reviewer_statement']),
    /** Required for a reviewer statement; never presented as a quotation. */
    statementReason: z.string().min(1).max(500).nullable(),
    references: z.array(sourceReferenceSchema).max(4),
    confirmedBy: z.string().regex(/^0x[0-9a-f]{40}$/),
    confirmedAt: timestampSchema,
    /** Content hash of the fact as confirmed, so snapshots bind content, not revision numbers. */
    contentSha256: digestSchema,
  })
  .check((ctx) => {
    const f = ctx.value;
    const bad = (message: string) =>
      ctx.issues.push({ code: 'custom', message, input: f, path: [] });
    if (!valueMatchesField(f.field, f.value)) bad('value does not fit field');
    if (f.basis === 'source' && f.references.length === 0)
      bad('source-backed fact needs a reference');
    if (
      f.basis === 'reviewer_statement' &&
      (f.statementReason === null || f.references.length > 0)
    ) {
      bad('reviewer statement needs a reason and no quotation');
    }
    if (f.basis === 'source' && f.statementReason !== null) bad('reason only for statements');
  });
export type ConfirmedFactV1 = z.infer<typeof confirmedFactSchema>;

// ---- PaymentReconciliationV1 ----------------------------------------------------------------------

export const CALCULATION_OUTCOMES = ['match', 'mismatch', 'needs_input', 'not_comparable'] as const;
export const calculationOutcomeSchema = z.enum(CALCULATION_OUTCOMES);
export type CalculationOutcome = z.infer<typeof calculationOutcomeSchema>;

export const reconciliationReasonSchema = z.enum([
  'total_missing',
  'schedule_missing',
  'fact_unconfirmed',
  'currency_not_gbp',
  'basis_missing',
  'basis_mixed',
  'negative_amount',
  'duplicate_source_occurrence',
  'duplicate_line_item',
  'too_many_line_items',
  'amount_invalid',
  'scope_unresolved',
]);

export const lineItemSchema = z.strictObject({
  lineItemId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** Input amount as written by the reviewer or taken from a confirmed fact. */
  amount: z.string().max(40),
  currency: z.string().min(1).max(8),
  basis: z.enum(['gross', 'net']).nullable(),
  /** Identifies the source occurrence; two items with one key are the same text counted twice. */
  sourceKey: z.string().min(1).max(200),
  factId: uuidSchema.nullable(),
  confirmed: z.boolean(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const paymentInputSchema = z.strictObject({
  mode: z.enum(['review', 'simulation']),
  group: z.string().regex(/^[a-z0-9-]{1,40}$/),
  statedTotal: z
    .strictObject({
      amount: z.string().max(40),
      currency: z.string().min(1).max(8),
      basis: z.enum(['gross', 'net']).nullable(),
      confirmed: z.boolean(),
    })
    .nullable(),
  items: z.array(lineItemSchema).max(1000),
});
export type PaymentInput = z.infer<typeof paymentInputSchema>;

export const paymentReconciliationSchema = z.strictObject({
  schema: z.literal('lexaegis.payment-reconciliation.v1'),
  engineVersion: z.literal(REVIEW_ENGINE_VERSION),
  mode: z.enum(['review', 'simulation']),
  group: z.string(),
  outcome: calculationOutcomeSchema,
  currency: z.literal('GBP'),
  basis: z.enum(['gross', 'net']).nullable(),
  statedTotalPence: penceSchema.nullable(),
  includedItems: z
    .array(
      z.strictObject({
        lineItemId: z.string(),
        amountPence: penceSchema,
        factId: uuidSchema.nullable(),
      }),
    )
    .max(REVIEW_LIMITS.paymentLineItems),
  comparableSumPence: penceSchema.nullable(),
  differencePence: signedPenceSchema.nullable(),
  formula: z.string().max(200),
  reasons: z.array(reconciliationReasonSchema).max(16),
  /** An incomplete diagnostic subtotal, never a comparable sum. */
  incompleteSubtotalPence: penceSchema.nullable(),
});
export type PaymentReconciliationV1 = z.infer<typeof paymentReconciliationSchema>;

// ---- RulePackV1 -----------------------------------------------------------------------------------

export const EVALUATOR_KEYS = [
  'source_coverage',
  'payment_reconciliation',
  'conflicting_facts',
  'missing_inputs',
  'evidence_presence',
] as const;
export const evaluatorKeySchema = z.enum(EVALUATOR_KEYS);

export const EVIDENCE_STATES = [
  'supplied_unreviewed',
  'confirmed_for_check',
  'missing',
  'not_assessed',
  'not_applicable',
] as const;
export const evidenceStateSchema = z.enum(EVIDENCE_STATES);
export type EvidenceState = z.infer<typeof evidenceStateSchema>;

export const rulePackSchema = z.strictObject({
  schema: z.literal('lexaegis.rule-pack.v1'),
  packId: z.string().regex(/^[a-z0-9.-]{1,80}$/),
  version: z.string().regex(/^[1-9][0-9]*$/),
  profile: z.strictObject({ id: z.string(), version: z.string() }),
  jurisdiction: z.literal('England and Wales'),
  sources: z
    .array(
      z.strictObject({
        sourceId: z.string().regex(/^[a-z0-9-]{1,40}$/),
        title: z.string().max(200),
        url: z.url(),
        identifier: z.string().max(120),
        retrievedOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        status: z.enum(['read', 'unverified']),
        note: z.string().max(400),
      }),
    )
    .max(20),
  limitations: z.array(z.string().max(400)).max(12),
  rules: z
    .array(
      z.strictObject({
        ruleId: z.string().regex(/^[a-z0-9-]{1,60}$/),
        title: z.string().max(160),
        category: z.enum(['statutory_checklist', 'product_check']),
        sourceIds: z.array(z.string()).max(6),
        evaluator: evaluatorKeySchema,
        requiredInputs: z.array(z.string().max(60)).max(8),
        /** Checklist requirement the rule asks the reviewer to link evidence for, if any. */
        evidenceRequirement: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .nullable(),
        allowedNotApplicable: z.boolean(),
        prompt: z.string().max(400),
      }),
    )
    .min(1)
    .max(40),
});
export type RulePackV1 = z.infer<typeof rulePackSchema>;

/** Review state of a pack, kept apart from its immutable content (referenced by digest). */
export const rulePackReviewRecordSchema = z.strictObject({
  schema: z.literal('lexaegis.rule-pack-review.v1'),
  packDigest: digestSchema,
  state: z.enum(['demo_draft', 'reviewed']),
  reviewedBy: z.string().max(200).nullable(),
  reviewedAt: timestampSchema.nullable(),
  note: z.string().max(400),
});
export type RulePackReviewRecordV1 = z.infer<typeof rulePackReviewRecordSchema>;

// ---- Findings, checklist, comparison --------------------------------------------------------------

export const FINDING_STATES = [
  'ok',
  'attention',
  'needs_input',
  'not_comparable',
  'technical_failure',
] as const;
export const findingStateSchema = z.enum(FINDING_STATES);

export const checkFindingSchema = z.strictObject({
  schema: z.literal('lexaegis.check-finding.v1'),
  findingId: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
  checkId: evaluatorKeySchema,
  ruleId: z.string(),
  state: findingStateSchema,
  /** Fixed ordering: lower sorts first. */
  priority: z.number().int().min(0).max(100),
  explanation: z.string().max(400),
  observed: z.record(z.string().max(40), z.string().max(200)),
  references: z.array(sourceReferenceSchema).max(8),
  /** For absence claims: the documents that were searched, never a fabricated quotation. */
  searchedDocumentVersionIds: z.array(uuidSchema).max(REVIEW_LIMITS.pdfsPerReview),
  inputDigest: digestSchema,
  engineVersion: z.literal(REVIEW_ENGINE_VERSION),
});
export type CheckFindingV1 = z.infer<typeof checkFindingSchema>;

export const evidenceChecklistSchema = z.strictObject({
  schema: z.literal('lexaegis.evidence-checklist.v1'),
  rulePackDigest: digestSchema,
  items: z
    .array(
      z.strictObject({
        requirement: z.string(),
        ruleId: z.string(),
        state: evidenceStateSchema,
        artifactIds: z.array(uuidSchema).max(16),
        notApplicableReason: z.string().max(500).nullable(),
      }),
    )
    .max(40),
});
export type EvidenceChecklistV1 = z.infer<typeof evidenceChecklistSchema>;

export const comparisonSpanSchema = z.strictObject({
  kind: z.enum(['added', 'removed']),
  /** References on the side where the text exists. Zero-width anchors carry none. */
  references: z.array(sourceReferenceSchema).max(8),
  /** A navigation anchor for a pure insertion/deletion position on the other side. */
  anchor: z.strictObject({ page: pageNumber, offset }).nullable(),
});

export const documentComparisonSchema = z.strictObject({
  schema: z.literal('lexaegis.document-comparison.v1'),
  engineVersion: z.literal(REVIEW_ENGINE_VERSION),
  matterId: uuidSchema,
  /** Direction is explicit: old to new. */
  oldVersion: z.strictObject({
    documentVersionId: uuidSchema,
    sourceSha256: digestSchema,
    extractionSha256: digestSchema,
  }),
  newVersion: z.strictObject({
    documentVersionId: uuidSchema,
    sourceSha256: digestSchema,
    extractionSha256: digestSchema,
  }),
  scope: z.strictObject({
    oldPages: z.tuple([pageNumber, pageNumber]).nullable(),
    newPages: z.tuple([pageNumber, pageNumber]).nullable(),
  }),
  options: z.strictObject({
    algorithm: z.literal('jsdiff-diffWordsWithSpace'),
    maxEditLength: z.number().int(),
    timeoutMs: z.number().int(),
  }),
  outcome: z.enum(['changes', 'no_text_changes', 'comparison_incomplete']),
  incompleteReason: z.enum(['too_large', 'edit_distance', 'timeout', 'cancelled']).nullable(),
  originalBytesIdentical: z.boolean(),
  extractionDiffers: z.boolean(),
  warnings: z.array(extractionWarningSchema).max(16),
  spans: z.array(comparisonSpanSchema).max(2000),
});
export type DocumentComparisonV1 = z.infer<typeof documentComparisonSchema>;

// ---- Evidence selection (reviewer input) -----------------------------------------------------------

/** What the reviewer linked to one checklist requirement. Supplying a file is not confirming it. */
export const evidenceSelectionSchema = z
  .strictObject({
    requirement: z.string().regex(/^[a-z0-9-]{1,40}$/),
    artifactIds: z.array(uuidSchema).max(16),
    /** The reviewer linked these files to this requirement for the check. Not authenticity. */
    confirmedForCheck: z.boolean(),
    notApplicableReason: z.string().min(1).max(500).nullable(),
  })
  .check((ctx) => {
    const s = ctx.value;
    if (s.notApplicableReason !== null && (s.artifactIds.length > 0 || s.confirmedForCheck)) {
      ctx.issues.push({
        code: 'custom',
        message: 'not applicable excludes evidence',
        input: s,
        path: [],
      });
    }
    if (s.confirmedForCheck && s.artifactIds.length === 0) {
      ctx.issues.push({ code: 'custom', message: 'nothing to confirm', input: s, path: [] });
    }
  });
export type EvidenceSelectionV1 = z.infer<typeof evidenceSelectionSchema>;
