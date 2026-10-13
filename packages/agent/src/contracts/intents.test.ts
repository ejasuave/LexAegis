import { describe, expect, it } from 'vitest';
import { COMMAND_INTENTS, routeUtterance } from './intents';

describe('deterministic routing', () => {
  it('maps every slash command to its intent and /stop to cancellation', () => {
    for (const [command, intent] of Object.entries(COMMAND_INTENTS)) {
      expect(routeUtterance(command)).toEqual({ kind: 'intent', intent, via: 'command', rest: '' });
    }
    expect(routeUtterance('/stop')).toEqual({ kind: 'stop' });
    expect(routeUtterance('  /STOP now ')).toEqual({ kind: 'stop' });
    expect(routeUtterance('/explain clause 4')).toMatchObject({
      intent: 'explain',
      rest: 'clause 4',
    });
  });

  it('routes equivalent free text to the same intents', () => {
    const cases: [string, string][] = [
      ['Summarise the selected clauses', 'summarise'],
      ['Please explain this clause', 'explain'],
      ['Do the instalments add up?', 'check_payments'],
      ['check the payments', 'check_payments'],
      ['What evidence is missing?', 'missing_evidence'],
      ['Brief me on this matter', 'brief_matter'],
      ['Prepare the review', 'prepare_review'],
      ["What's the status?", 'status'],
    ];
    for (const [text, intent] of cases) {
      expect(routeUtterance(text)).toMatchObject({ kind: 'intent', intent, via: 'phrase' });
    }
  });

  it('does not mistake ordinary case questions for an explicit command', () => {
    expect(routeUtterance('Analyse my case like an employment solicitor.')).toEqual({
      kind: 'ambiguous',
    });
  });

  it('leaves unclear text ambiguous and never guesses', () => {
    expect(routeUtterance('check the payments and tell me what evidence is missing')).toEqual({
      kind: 'ambiguous',
    });
    expect(routeUtterance('Is this a good deal?')).toEqual({ kind: 'ambiguous' });
  });

  it('declines approval and signing wording and unknown commands without a model', () => {
    for (const text of ['approve this package', 'Sign it', 'yes, approve', 'revoke the receipt']) {
      expect(routeUtterance(text)).toEqual({ kind: 'unsupported', reason: 'approval_or_signing' });
    }
    expect(routeUtterance('/approve')).toEqual({ kind: 'unknown_command', command: '/approve' });
    expect(routeUtterance('   ')).toEqual({ kind: 'unsupported', reason: 'empty' });
  });
});
