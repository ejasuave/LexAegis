import { describe, expect, it } from 'vitest';
import { describeWorkingEntry } from './describe-entry';

describe('working entry descriptions', () => {
  it('never shows stored JSON for a fact, evidence link or decision', () => {
    const fact = `lexaegis.fact.v1:${JSON.stringify({ field: 'payment_total', slot: 'total', value: '2400000' })}`;
    expect(describeWorkingEntry(fact)).toBe('Fact: payment total (total) is £24,000.00');
    expect(describeWorkingEntry('lexaegis.evidence.v1:[{"a":1},{"a":2}]')).toBe(
      'Evidence links for 2 requirement(s)',
    );
    const decision = `lexaegis.decision.v1:${JSON.stringify({ kind: 'accepted_unresolved', reason: 'told the client' })}`;
    expect(describeWorkingEntry(decision)).toBe(
      'Your decision: accepted an unresolved concern, told the client',
    );
  });
  it('is unreadable-safe and leaves ordinary text alone', () => {
    expect(describeWorkingEntry('lexaegis.fact.v1:{nope')).toBe('Confirmed fact (unreadable)');
    expect(describeWorkingEntry('a plain note')).toBeNull();
  });
});
