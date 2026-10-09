import { artifactDigest } from '@lexaegis/protocol/v1';
import { LIMITS } from '@lexaegis/protocol/v1';
import {
  REVIEW_ENGINE_VERSION,
  REVIEW_LIMITS,
  type CheckFindingV1,
  type ConfirmedFactV1,
  type DocumentComparisonV1,
  type EvidenceChecklistV1,
  type PaymentReconciliationV1,
  type RulePackReviewRecordV1,
  type SourceReferenceV1,
} from '../contracts/review';
import { canonicalBytes, fail, ok, type Result } from './hash';
import type { LoadedRulePack } from './rule-pack';

/*
 * Draft artifact assembly on Chapter 2's existing roles and byte hashing. No new receipt format,
 * no change to the commitment algorithm. The result is a typed draft with outstanding
 * requirements, not a production-ready signed capture: there is no model or prompt configuration
 * (Chapter 9) and no decision log (Chapter 10), and none is invented.
 */

export interface DraftSource {
  readonly artifactId: string;
  readonly documentVersionId: string;
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly extractionArtifactId: string;
  readonly extractionBytes: Uint8Array;
}

export interface DraftArtifact {
  readonly id: string;
  readonly role:
    | 'source'
    | 'extracted-text'
    | 'evidence'
    | 'analysis'
    | 'calculation'
    | 'rule-pack'
    | 'checklist';
  readonly mediaType: string;
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface DraftRequirement {
  readonly code:
    | 'AGENT_CONFIG_MISSING'
    | 'DECISION_LOG_MISSING'
    | 'HUMAN_REVIEW_GATE_PENDING'
    | 'EVIDENCE_NOT_CONFIRMED'
    | 'FINDING_UNRESOLVED';
  readonly detail: string;
}

export interface DraftInput {
  readonly matterId: string;
  readonly snapshotDigest: string;
  /** Digest the findings and payments were computed from; must equal snapshotDigest's inputs. */
  readonly resultSnapshotDigest: string;
  readonly sources: readonly DraftSource[];
  readonly evidenceFiles: readonly {
    artifactId: string;
    label: string;
    mediaType: string;
    bytes: Uint8Array;
  }[];
  readonly facts: readonly ConfirmedFactV1[];
  readonly findings: readonly CheckFindingV1[];
  readonly payments: readonly PaymentReconciliationV1[];
  readonly checklist: EvidenceChecklistV1;
  readonly comparisons: readonly DocumentComparisonV1[];
  readonly rulePack: LoadedRulePack;
  readonly reviewRecord: RulePackReviewRecordV1;
  readonly newId: () => string;
}

export type DraftFailure =
  | 'STALE_RESULT'
  | 'MISSING_DEPENDENCY'
  | 'RULE_PACK_MISMATCH'
  | 'COMPARISON_VERSION_MISSING'
  | 'ORIGINALS_TOO_LARGE'
  | 'EXTRACTION_TOO_LARGE'
  | 'EXTRACTIONS_TOO_LARGE'
  | 'PACKAGE_TOO_LARGE'
  | 'TOO_MANY_ARTIFACTS';

const JSON_TYPE = 'application/json';
const json = (value: unknown) => canonicalBytes(value);

async function describe(
  id: string,
  role: DraftArtifact['role'],
  mediaType: string,
  label: string,
  bytes: Uint8Array,
): Promise<DraftArtifact> {
  return { id, role, mediaType, label, bytes, sha256: await artifactDigest(bytes) };
}

function refsOf(input: DraftInput): SourceReferenceV1[] {
  return [
    ...input.facts.flatMap((f) => f.references),
    ...input.findings.flatMap((f) => f.references),
    ...input.comparisons.flatMap((c) => c.spans.flatMap((s) => s.references)),
  ];
}

export async function assembleDraft(
  input: DraftInput,
): Promise<Result<{ artifacts: DraftArtifact[]; outstanding: DraftRequirement[] }, DraftFailure>> {
  if (input.resultSnapshotDigest !== input.snapshotDigest) return fail('STALE_RESULT');

  // Rule pack content and review record must agree before they are bound together.
  if (input.reviewRecord.packDigest !== input.rulePack.digest) return fail('RULE_PACK_MISMATCH');

  const originals = input.sources.reduce((s, x) => s + x.bytes.byteLength, 0);
  if (originals > REVIEW_LIMITS.originalBytes) return fail('ORIGINALS_TOO_LARGE');
  if (
    input.sources.some((s) => s.extractionBytes.byteLength > REVIEW_LIMITS.extractionArtifactBytes)
  )
    return fail('EXTRACTION_TOO_LARGE');
  if (
    input.sources.reduce((s, x) => s + x.extractionBytes.byteLength, 0) >
    REVIEW_LIMITS.extractionTotalBytes
  )
    return fail('EXTRACTIONS_TOO_LARGE');

  // Every reference must resolve to artifacts that are actually included.
  const sourceIds = new Set(input.sources.map((s) => s.artifactId));
  const extractionIds = new Set(input.sources.map((s) => s.extractionArtifactId));
  for (const ref of refsOf(input)) {
    if (!sourceIds.has(ref.sourceArtifactId) || !extractionIds.has(ref.extractionArtifactId)) {
      return fail('MISSING_DEPENDENCY');
    }
  }
  const versions = new Set(input.sources.map((s) => s.documentVersionId));
  for (const c of input.comparisons) {
    if (
      !versions.has(c.oldVersion.documentVersionId) ||
      !versions.has(c.newVersion.documentVersionId)
    ) {
      return fail('COMPARISON_VERSION_MISSING');
    }
  }
  const evidenceIds = new Set([...sourceIds, ...input.evidenceFiles.map((e) => e.artifactId)]);
  for (const item of input.checklist.items) {
    if (item.artifactIds.some((id) => !evidenceIds.has(id))) return fail('MISSING_DEPENDENCY');
  }

  const out: DraftArtifact[] = [];
  for (const s of input.sources) {
    out.push(await describe(s.artifactId, 'source', 'application/pdf', s.label, s.bytes));
    out.push(
      await describe(
        s.extractionArtifactId,
        'extracted-text',
        JSON_TYPE,
        `extraction ${s.documentVersionId.slice(0, 8)}`,
        s.extractionBytes,
      ),
    );
  }
  for (const e of input.evidenceFiles)
    out.push(await describe(e.artifactId, 'evidence', e.mediaType, e.label, e.bytes));
  out.push(
    await describe(
      input.newId(),
      'calculation',
      JSON_TYPE,
      'payment reconciliation',
      json({
        schema: 'lexaegis.calculation-set.v1',
        engineVersion: REVIEW_ENGINE_VERSION,
        results: input.payments,
      }),
    ),
  );
  out.push(
    await describe(
      input.newId(),
      'checklist',
      JSON_TYPE,
      'evidence checklist',
      json(input.checklist),
    ),
  );
  // Content and review record travel together; the pack's own digest is stored externally.
  out.push(
    await describe(
      input.newId(),
      'rule-pack',
      JSON_TYPE,
      'rule pack and review record',
      json({
        schema: 'lexaegis.rule-pack-artifact.v1',
        pack: input.rulePack.pack,
        review: input.reviewRecord,
      }),
    ),
  );
  out.push(
    await describe(
      input.newId(),
      'analysis',
      JSON_TYPE,
      'confirmed facts and findings',
      json({
        schema: 'lexaegis.review-analysis.v1',
        engineVersion: REVIEW_ENGINE_VERSION,
        matterId: input.matterId,
        snapshotDigest: input.snapshotDigest,
        provenance: {
          aiAnalysis: false,
          note: 'Deterministic local checks only. No model produced any content here.',
        },
        facts: input.facts,
        findings: input.findings,
        comparisons: input.comparisons,
      }),
    ),
  );

  if (out.length > LIMITS.maxArtifacts) return fail('TOO_MANY_ARTIFACTS');
  if (out.reduce((s, a) => s + a.bytes.byteLength, 0) > LIMITS.maxTotalArtifactBytes)
    return fail('PACKAGE_TOO_LARGE');
  if (out.some((a) => a.bytes.byteLength > LIMITS.maxArtifactBytes))
    return fail('PACKAGE_TOO_LARGE');

  const outstanding: DraftRequirement[] = [
    { code: 'AGENT_CONFIG_MISSING', detail: 'No agent configuration exists until Chapter 9 runs.' },
    {
      code: 'DECISION_LOG_MISSING',
      detail: 'No decision log exists until Chapter 10 records human decisions.',
    },
    {
      code: 'HUMAN_REVIEW_GATE_PENDING',
      detail: 'The complete human-review gate is not implemented yet.',
    },
    ...input.checklist.items
      .filter((i) => i.state !== 'confirmed_for_check' && i.state !== 'not_applicable')
      .map((i) => ({ code: 'EVIDENCE_NOT_CONFIRMED' as const, detail: i.requirement })),
    ...input.findings
      .filter((f) => f.state === 'attention' || f.state === 'technical_failure')
      .map((f) => ({ code: 'FINDING_UNRESOLVED' as const, detail: f.findingId })),
  ];
  return ok({ artifacts: out, outstanding });
}
