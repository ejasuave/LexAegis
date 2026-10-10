import type {
  ConfirmedFactV1,
  EvidenceChecklistV1,
  EvidenceSelectionV1,
  PaymentReconciliationV1,
} from '../contracts/review';
import { buildChecklist } from './checklist';
import { paymentInputFromFacts } from './checks';
import { reconcilePayments } from './payments';
import type { LoadedRulePack } from './rule-pack';

/*
 * A preview of what still stands between the current inputs and a review draft. It is computed
 * from confirmed facts, the reviewer's evidence links and the pinned rules only. It saves and
 * freezes nothing, and an empty list would still not be an approval: the human decision and the
 * approval gate are always listed, because they belong to the reviewer.
 */

export type RequirementCode =
  | 'AGENT_CONFIG_MISSING'
  | 'DECISION_LOG_MISSING'
  | 'HUMAN_REVIEW_GATE_PENDING'
  | 'EVIDENCE_NOT_CONFIRMED'
  | 'FINDING_UNRESOLVED'
  | 'INPUT_NOT_CONFIRMED'
  | 'NO_DOCUMENT_SELECTED';

export interface RequirementPreview {
  readonly code: RequirementCode;
  readonly detail: string;
}

export interface RequirementInput {
  readonly rulePack: LoadedRulePack;
  readonly facts: readonly ConfirmedFactV1[];
  readonly evidence: readonly EvidenceSelectionV1[];
  /** Number of documents selected for the review; zero means nothing was assessed. */
  readonly selectedDocuments: number;
}

export function paymentGroups(facts: readonly ConfirmedFactV1[]): string[] {
  return [
    ...new Set(facts.filter((f) => f.field.startsWith('payment_')).map((f) => f.group)),
  ].sort();
}

export function requirementsPreview(input: RequirementInput): {
  requirements: RequirementPreview[];
  checklist: EvidenceChecklistV1;
  payments: PaymentReconciliationV1[];
} {
  const requirements: RequirementPreview[] = [];
  if (input.selectedDocuments === 0)
    requirements.push({
      code: 'NO_DOCUMENT_SELECTED',
      detail: 'No document is selected for this review.',
    });

  for (const rule of input.rulePack.pack.rules) {
    if (rule.evaluator !== 'missing_inputs') continue;
    for (const field of rule.requiredInputs) {
      if (!input.facts.some((fact) => fact.field === field))
        requirements.push({ code: 'INPUT_NOT_CONFIRMED', detail: `${rule.ruleId}:${field}` });
    }
  }

  const payments = paymentGroups(input.facts).map((group) =>
    reconcilePayments(paymentInputFromFacts(input.facts, group)),
  );
  for (const result of payments) {
    if (result.outcome === 'mismatch')
      requirements.push({
        code: 'FINDING_UNRESOLVED',
        detail: `payment_reconciliation:${result.group}:mismatch`,
      });
    else if (result.outcome !== 'match')
      requirements.push({
        code: 'INPUT_NOT_CONFIRMED',
        detail: `payment_reconciliation:${result.group}:${result.reasons.join('+')}`.slice(0, 200),
      });
  }

  const byKey = new Map<string, Set<string>>();
  for (const fact of input.facts) {
    const key = `${fact.field}.${fact.group}.${fact.slot}`;
    byKey.set(key, (byKey.get(key) ?? new Set()).add(fact.value));
  }
  for (const [key, values] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (values.size > 1)
      requirements.push({ code: 'FINDING_UNRESOLVED', detail: `conflicting_facts:${key}` });
  }

  const checklist = buildChecklist(input.rulePack, input.evidence, input.selectedDocuments > 0);
  for (const item of checklist.items) {
    if (item.state !== 'confirmed_for_check' && item.state !== 'not_applicable')
      requirements.push({
        code: 'EVIDENCE_NOT_CONFIRMED',
        detail: `${item.requirement}:${item.state}`,
      });
  }

  requirements.push(
    {
      code: 'AGENT_CONFIG_MISSING',
      detail:
        'An agent configuration is recorded only when an assistant outcome is saved for the draft.',
    },
    {
      code: 'DECISION_LOG_MISSING',
      detail: 'No decision log exists until human decisions are recorded.',
    },
    {
      code: 'HUMAN_REVIEW_GATE_PENDING',
      detail: 'The reviewer has not approved anything. Approval is a separate, explicit action.',
    },
  );
  return { requirements, checklist, payments };
}
