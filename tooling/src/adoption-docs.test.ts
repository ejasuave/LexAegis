import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Keeps the Chapter 18 adoption documents honest: drafts, empty tables and the status ladder. */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'docs', 'adoption');
const read = (name: string): string => readFileSync(join(root, name), 'utf8');

function drafts(text: string): string[] {
  return [...text.matchAll(/## Draft \d: [^\n]*\n\n((?:>.*\n?)+)/g)].map((match) =>
    (match[1] ?? '').replace(/^> ?/gm, '').trim(),
  );
}

describe('outreach drafts', () => {
  const found = drafts(read('outreach-messages.md'));

  it('has exactly three drafts, each under 120 words', () => {
    expect(found).toHaveLength(3);
    for (const draft of found) expect(draft.split(/\s+/).length).toBeLessThan(120);
  });

  it('keeps every draft a draft: placeholders, one fifteen-minute ask, an offer to work together', () => {
    for (const draft of found) {
      expect(draft).toMatch(/\[[A-Z][A-Z /]+\]/);
      expect(draft).toMatch(/fifteen\s+minutes/);
      expect(draft).toMatch(/work\s+(?:with|together)/);
    }
  });

  it('claims no customers, savings, accuracy, adoption, legal reliability, awards or endorsement', () => {
    for (const draft of found) {
      expect(draft).not.toMatch(
        /customer|saving|accura|adopt|reliab|award|endorse|sponsor|github\.com|https?:\/\/|\d+\s?%/i,
      );
    }
  });

  it('only says the tools are working locally or not published, never available', () => {
    expect(found.join('\n')).not.toMatch(/\b(?:available now|live now|on npm|download)\b/i);
  });
});

describe('targets', () => {
  const text = read('targets.md');

  it('has two empty target tables with the required columns', () => {
    const tables = [
      ...text.matchAll(/^\| Team \/ person \|[^\n]*\n\| -[^\n]*\n((?:\|[^\n]*\n)*)/gm),
    ];
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table[0]).toContain(
        '| Team / person | Why they fit | Contact route | Status | Date | Evidence reference |',
      );
      expect((table[1] ?? '').trim()).toBe('');
    }
  });

  it('defines the exact status ladder', () => {
    expect(text).toContain(
      '`contacted` → `replied` → `call held` → `trial started` → `integrated`',
    );
  });

  it('records no named contact and says public availability is NOT YET', () => {
    expect(text).toMatch(/Nobody is named/);
    expect(text).toMatch(/\*\*NOT YET\.\*\*/);
  });
});

describe('interview guide', () => {
  const text = read('interview-guide.md');

  it('states the goal as a goal and that nothing has occurred', () => {
    expect(text).toMatch(/8 to 12 practitioner conversations/);
    expect(text).toMatch(/No conversation, pilot or interview has\s+taken place yet/);
  });

  it('asks about current behaviour before any demonstration and refuses sensitive material', () => {
    expect(text.indexOf('current settlement-review workflow')).toBeLessThan(
      text.indexOf('A portable receipt (show it only now)'),
    );
    expect(text).toMatch(/Never request or accept real client documents/);
    expect(text).toMatch(/Ask permission/);
  });

  it('has the notes template fields', () => {
    for (const field of [
      'Participant ID',
      'Consent and attribution permissions',
      'Current workflow',
      'Observed problems',
      'Exact consented quotations',
      'Paraphrases',
      'Objections',
      'Follow-up permission',
      'Evidence reference',
    ])
      expect(text).toContain(field);
  });
});

describe('README verification example', () => {
  const readme = readFileSync(join(root, '..', '..', 'README.md'), 'utf8');
  const quickstart = readFileSync(join(root, '..', 'QUICKSTART.md'), 'utf8');

  it('shows the complete runnable script that the quickstart executes, verbatim', () => {
    const script = /cat > verify-local\.mjs <<'JS'\n([\s\S]*?)\nJS\n/.exec(quickstart)?.[1];
    expect(script).toBeDefined();
    expect(readme).toContain(script ?? 'missing');
  });

  it('leads with the approval, the limits and LexAegis as the first reference application', () => {
    const lead = readme.slice(0, 900);
    expect(lead).toMatch(/exact package of AI-assisted work/);
    expect(lead).toMatch(/does \*\*not\*\* establish that the work is correct/);
    expect(lead).toMatch(/professionally qualified/);
    expect(lead).toMatch(/enforceable/);
    expect(lead).toMatch(/first reference application/);
  });

  it('keeps the honest empty state visible and offers no hosted widget', () => {
    expect(readme).toMatch(/no external trials recorded yet/i);
    expect(readme).toMatch(/no entries yet/i);
    expect(readme + quickstart).not.toMatch(/<script[^>]*src=["']https?:/i);
  });
});
