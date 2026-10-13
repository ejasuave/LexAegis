/*
 * Which finding the attention rail explains, and how its figures are classified. Pure, so the
 * rail shows one selected finding with a stated reason for the choice. No score, no verdict.
 */

export const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  source_coverage: 'Source coverage',
  payment_reconciliation: 'Payment arithmetic',
  conflicting_facts: 'Conflicting facts',
  missing_inputs: 'Missing inputs',
  evidence_presence: 'Evidence presence',
};

export function categoryLabel(checkId: string): string {
  return CATEGORY_LABEL[checkId] ?? 'Check';
}

export interface SelectableFinding {
  readonly id: string;
  readonly state: 'ok' | 'attention' | 'needs_input' | 'not_comparable' | 'technical_failure';
  /** Fixed ordering from the rule pack: lower sorts first. */
  readonly priority: number;
  readonly resolved: boolean;
}

const STATE_ORDER = { technical_failure: 0, attention: 1, needs_input: 2 } as const;

export interface SelectedFinding {
  readonly id: string;
  /** Why this one is shown, in words. */
  readonly reason: 'chosen' | 'highest_priority_unresolved' | 'first_listed';
}

/** An explicit choice if it is still in the list; otherwise the most pressing unresolved one. */
export function chooseSelectedFinding(
  findings: readonly SelectableFinding[],
  explicitId: string | null,
): SelectedFinding | null {
  if (explicitId !== null && findings.some((f) => f.id === explicitId)) {
    return { id: explicitId, reason: 'chosen' };
  }
  const open = findings
    .filter((f) => !f.resolved && f.state in STATE_ORDER)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state as keyof typeof STATE_ORDER] -
          STATE_ORDER[b.state as keyof typeof STATE_ORDER] || a.priority - b.priority,
    );
  const top = open[0];
  if (top !== undefined) return { id: top.id, reason: 'highest_priority_unresolved' };
  const first = findings[0];
  return first === undefined ? null : { id: first.id, reason: 'first_listed' };
}

export type Gap =
  | { readonly kind: 'gap'; readonly minor: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

/** Reads the calculator's own decimal-string difference. It never computes money itself. */
export function paymentGap(observed: Readonly<Record<string, string>>): Gap {
  const value = observed.difference;
  if (value === undefined || !/^-?(0|[1-9][0-9]*)$/.test(value)) return { kind: 'unknown' };
  return /^-?0$/.test(value) ? { kind: 'none' } : { kind: 'gap', minor: value };
}
