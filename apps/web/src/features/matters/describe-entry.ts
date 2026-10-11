import { formatGbp } from '@lexaegis/agent/review';

/*
 * How a saved working-context entry reads in a list. Entries are stored as a typed prefix plus
 * JSON; people never see that JSON. Unknown content is shown as plain text, never interpreted.
 */

const FACT = 'lexaegis.fact.v1:';
const EVIDENCE = 'lexaegis.evidence.v1:';
const DECISION = 'lexaegis.decision.v1:';

const KIND: Record<string, string> = {
  acknowledged: 'acknowledged',
  accepted_unresolved: 'accepted an unresolved concern',
  not_applicable: 'marked not applicable',
  requires_change: 'marked as requiring a change',
};

function parse(text: string, prefix: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text.slice(prefix.length));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function describeWorkingEntry(text: string): string | null {
  if (text.startsWith(FACT)) {
    const fact = parse(text, FACT);
    if (fact === null) return 'Confirmed fact (unreadable)';
    const field = str(fact.field).replaceAll('_', ' ');
    const value = str(fact.value);
    const shown =
      /^payment_(total|instalment)$/.test(str(fact.field)) && /^\d+$/.test(value)
        ? formatGbp(value)
        : value;
    return `Fact: ${field} (${str(fact.slot)}) is ${shown}`;
  }
  if (text.startsWith(EVIDENCE)) {
    try {
      const list: unknown = JSON.parse(text.slice(EVIDENCE.length));
      return `Evidence links for ${Array.isArray(list) ? list.length : 0} requirement(s)`;
    } catch {
      return 'Evidence links (unreadable)';
    }
  }
  if (text.startsWith(DECISION)) {
    const decision = parse(text, DECISION);
    if (decision === null) return 'Your decision (unreadable)';
    const reason = str(decision.reason);
    return `Your decision: ${KIND[str(decision.kind)] ?? 'recorded'}${reason === '' ? '' : `, ${reason}`}`;
  }
  return null;
}
