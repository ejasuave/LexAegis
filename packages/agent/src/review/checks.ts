import {
  REVIEW_ENGINE_VERSION,
  REVIEW_LIMITS,
  checkFindingSchema,
  type CheckFindingV1,
  type ConfirmedFactV1,
  type EvidenceChecklistV1,
  type EvidenceSelectionV1,
  type PaymentReconciliationV1,
  type RulePackReviewRecordV1,
  type SourceReferenceV1,
} from '../contracts/review';
import { buildChecklist, evidenceStateOf } from './checklist';
import { canonicalDigest, fail, ok, type Result } from './hash';
import { formatGbpShort, reconcilePayments } from './payments';
import type { LoadedRulePack } from './rule-pack';
import type { SourceSet, SourceSetFailure } from './source-references';

/*
 * Deterministic checks over verified source bindings, confirmed facts and a pinned rule pack.
 * They produce plain findings. There is no legal-validity verdict, risk score or all-clear:
 * a passing check says only what it checked.
 */

export interface CheckInput {
  readonly matterId: string;
  readonly sources: SourceSet;
  /** Set when verifying sources failed; reported as a technical failure that cannot be waived. */
  readonly integrityFailure: SourceSetFailure | null;
  readonly facts: readonly ConfirmedFactV1[];
  readonly evidence: readonly EvidenceSelectionV1[];
  readonly rulePack: LoadedRulePack;
  readonly reviewRecord: RulePackReviewRecordV1;
}

type State = CheckFindingV1['state'];
const PRIORITY: Record<State, number> = {
  technical_failure: 0,
  attention: 10,
  needs_input: 20,
  not_comparable: 25,
  ok: 90,
};

const FIELD_LABEL: Record<string, string> = {
  employer: 'Employer',
  employee: 'Employee',
  adviser_name: 'Adviser name',
  adviser_organisation: 'Adviser organisation',
  agreement_date: 'Agreement date',
  termination_date: 'Termination date',
  payment_total: 'Payment total',
  payment_instalment: 'Payment instalment',
  payment_basis: 'Payment basis',
};

const factKey = (f: ConfirmedFactV1) => `${f.field}:${f.group}:${f.slot}`;

/** A deterministic source key: the cited occurrence, or the statement it came from. */
function sourceKeyOf(fact: ConfirmedFactV1): string {
  const ref = fact.references[0];
  return ref === undefined
    ? `statement:${fact.factId}`
    : `${ref.documentVersionId}:${ref.page}:${ref.start}-${ref.end}`;
}

export function paymentInputFromFacts(
  facts: readonly ConfirmedFactV1[],
  group: string,
): Parameters<typeof reconcilePayments>[0] {
  const inGroup = facts.filter((f) => f.group === group);
  const total = inGroup.find((f) => f.field === 'payment_total');
  const basis = inGroup.find((f) => f.field === 'payment_basis')?.value ?? null;
  return {
    mode: 'review',
    group,
    statedTotal:
      total === undefined
        ? null
        : {
            amount: formatPence(total.value),
            currency: 'GBP',
            basis: asBasis(basis),
            confirmed: true,
          },
    items: inGroup
      .filter((f) => f.field === 'payment_instalment')
      .map((f) => ({
        lineItemId: f.slot,
        amount: formatPence(f.value),
        currency: 'GBP',
        basis: asBasis(basis),
        sourceKey: sourceKeyOf(f),
        factId: f.factId,
        confirmed: true,
      })),
  };
}
const asBasis = (value: string | null): 'gross' | 'net' | null =>
  value === 'gross' || value === 'net' ? value : null;
/** Confirmed payment facts carry integer pence; the kernel takes display amounts. */
function formatPence(pence: string): string {
  const padded = pence.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function describePayment(r: PaymentReconciliationV1): { state: State; text: string } {
  if (r.outcome === 'match') {
    return {
      state: 'ok',
      text: `Payment schedule adds up to the stated total of ${formatGbpShort(r.statedTotalPence ?? '0')} (arithmetic only).`,
    };
  }
  if (r.outcome === 'mismatch') {
    const diff = BigInt(r.differencePence ?? '0');
    const abs = (diff < 0n ? -diff : diff).toString();
    return {
      state: 'attention',
      text: `Payment schedule differs by ${formatGbpShort(abs)}: stated total ${formatGbpShort(r.statedTotalPence ?? '0')}, instalments total ${formatGbpShort(r.comparableSumPence ?? '0')}.`,
    };
  }
  if (r.outcome === 'needs_input') {
    return {
      state: 'needs_input',
      text: `Payment check needs input: ${r.reasons.join(', ').replaceAll('_', ' ')}.`,
    };
  }
  return {
    state: 'not_comparable',
    text: `Payment figures are not comparable: ${r.reasons.join(', ').replaceAll('_', ' ')}.`,
  };
}

export type CheckFailure = 'TOO_MANY_FACTS' | 'TOO_MANY_FINDINGS';

export interface CheckResult {
  readonly findings: readonly CheckFindingV1[];
  readonly checklist: EvidenceChecklistV1;
  readonly payments: readonly PaymentReconciliationV1[];
  readonly inputDigest: string;
}

export async function runChecks(input: CheckInput): Promise<Result<CheckResult, CheckFailure>> {
  if (input.facts.length > REVIEW_LIMITS.facts) return fail('TOO_MANY_FACTS');
  const selected = [...input.sources.selected].sort();
  const assessed = selected.length > 0 && input.integrityFailure === null;
  const inputDigest = await canonicalDigest({
    matterId: input.matterId,
    selected,
    sources: selected.map((id) => {
      const s = input.sources.sources.get(id);
      return s === undefined ? null : [s.sourceSha256, s.extractionSha256];
    }),
    facts: input.facts.map((f) => [f.factId, f.revision, f.contentSha256]),
    evidence: input.evidence,
    rulePack: [input.rulePack.digest, input.reviewRecord.state],
    engine: REVIEW_ENGINE_VERSION,
  });

  const findings: CheckFindingV1[] = [];
  const payments: PaymentReconciliationV1[] = [];
  const add = (
    checkId: CheckFindingV1['checkId'],
    ruleId: string,
    suffix: string,
    state: State,
    explanation: string,
    observed: Record<string, string> = {},
    references: readonly SourceReferenceV1[] = [],
    absence = false,
  ) => {
    findings.push(
      checkFindingSchema.parse({
        schema: 'lexaegis.check-finding.v1',
        findingId: `${checkId}:${ruleId}${suffix === '' ? '' : `:${suffix}`}`,
        checkId,
        ruleId,
        state,
        priority: PRIORITY[state],
        explanation,
        observed,
        references: references.slice(0, 8),
        searchedDocumentVersionIds: absence ? selected : [],
        inputDigest,
        engineVersion: REVIEW_ENGINE_VERSION,
      }),
    );
  };

  if (input.integrityFailure !== null) {
    add(
      'source_coverage',
      'source-integrity',
      '',
      'technical_failure',
      `A source or extraction failed verification (${input.integrityFailure.toLowerCase().replaceAll('_', ' ')}). Review cannot proceed on these inputs.`,
    );
  }

  for (const rule of input.rulePack.pack.rules) {
    switch (rule.evaluator) {
      case 'source_coverage': {
        if (input.integrityFailure !== null) break;
        if (selected.length === 0) {
          add(
            'source_coverage',
            rule.ruleId,
            '',
            'needs_input',
            'No document is selected for this review.',
          );
          break;
        }
        for (const id of selected) {
          const coverage = input.sources.sources.get(id)?.extraction.coverage;
          if (coverage === undefined) continue;
          const warn = coverage.warnings.join(', ').replaceAll('_', ' ');
          add(
            'source_coverage',
            rule.ruleId,
            id.slice(0, 8),
            coverage.status === 'complete' ? 'ok' : 'attention',
            coverage.status === 'complete'
              ? 'Text was extracted from every page. Annotations, images and signatures are not verified.'
              : `Text coverage is ${coverage.status}: ${coverage.pagesWithText} of ${coverage.pagesWithText + coverage.pagesWithoutText} pages have extractable text${warn === '' ? '' : ` (${warn})`}. Absence of a clause cannot be concluded.`,
            {
              pagesWithText: String(coverage.pagesWithText),
              pagesWithoutText: String(coverage.pagesWithoutText),
            },
          );
        }
        break;
      }
      case 'payment_reconciliation': {
        const groups = [
          ...new Set(input.facts.filter((f) => f.field.startsWith('payment_')).map((f) => f.group)),
        ].sort();
        for (const group of groups.length === 0 ? ['settlement'] : groups) {
          const result = reconcilePayments(paymentInputFromFacts(input.facts, group));
          payments.push(result);
          const { state, text } = describePayment(result);
          const refs = input.facts
            .filter((f) => f.group === group && f.field.startsWith('payment_'))
            .flatMap((f) => f.references);
          add(
            'payment_reconciliation',
            rule.ruleId,
            group,
            state,
            text,
            { outcome: result.outcome, difference: result.differencePence ?? 'n/a' },
            refs,
          );
        }
        break;
      }
      case 'conflicting_facts': {
        const byKey = new Map<string, ConfirmedFactV1[]>();
        for (const fact of input.facts)
          byKey.set(factKey(fact), [...(byKey.get(factKey(fact)) ?? []), fact]);
        const conflicts = [...byKey.entries()].filter(
          ([, list]) => new Set(list.map((f) => f.value)).size > 1,
        );
        if (conflicts.length === 0)
          add(
            'conflicting_facts',
            rule.ruleId,
            '',
            'ok',
            'No two confirmed values conflict for the same field.',
          );
        for (const [key, list] of conflicts.sort(([a], [b]) => (a < b ? -1 : 1))) {
          add(
            'conflicting_facts',
            rule.ruleId,
            key.replaceAll(':', '.'),
            'attention',
            `${FIELD_LABEL[list[0]?.field ?? ''] ?? 'Field'} has ${new Set(list.map((f) => f.value)).size} different confirmed values. Neither is chosen automatically.`,
            Object.fromEntries(list.map((f, i) => [`value${i + 1}`, f.value.slice(0, 200)])),
            list.flatMap((f) => f.references),
          );
        }
        break;
      }
      case 'missing_inputs': {
        const missing = rule.requiredInputs.filter(
          (field) => !input.facts.some((f) => f.field === field),
        );
        add(
          'missing_inputs',
          rule.ruleId,
          '',
          missing.length === 0 ? 'ok' : 'needs_input',
          missing.length === 0
            ? 'The required inputs are confirmed.'
            : `Not yet confirmed: ${missing.map((m) => FIELD_LABEL[m] ?? m).join(', ')}.`,
          { missing: missing.join(',') },
        );
        break;
      }
      case 'evidence_presence': {
        const selection = input.evidence.find((s) => s.requirement === rule.evidenceRequirement);
        const { state, permitted } = evidenceStateOf(rule, selection, assessed);
        const label = rule.title;
        const text =
          state === 'confirmed_for_check'
            ? `${label}: linked for this check. This does not verify authenticity or that the requirement was met.`
            : state === 'supplied_unreviewed'
              ? `${label}: a file was supplied but you have not confirmed it for this check.`
              : state === 'not_applicable'
                ? `${label}: marked not applicable by the reviewer, with a reason.`
                : state === 'not_assessed'
                  ? `${label}: not assessed yet.`
                  : permitted
                    ? `${label} has not been confirmed within the selected documents.`
                    : `${label}: not applicable is not permitted for this requirement.`;
        add(
          'evidence_presence',
          rule.ruleId,
          '',
          state === 'confirmed_for_check' || state === 'not_applicable'
            ? 'ok'
            : state === 'not_assessed'
              ? 'needs_input'
              : 'attention',
          text,
          { evidence: state },
          [],
          state === 'missing',
        );
        break;
      }
    }
  }

  if (findings.length > REVIEW_LIMITS.findings) return fail('TOO_MANY_FINDINGS');
  findings.sort((a, b) => a.priority - b.priority || (a.findingId < b.findingId ? -1 : 1));
  return ok({
    findings,
    checklist: buildChecklist(input.rulePack, input.evidence, assessed),
    payments,
    inputDigest,
  });
}
