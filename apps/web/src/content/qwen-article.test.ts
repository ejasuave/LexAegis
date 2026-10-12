import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QWEN_ARTICLE } from './qwen-article';

const markdown = readFileSync(join(__dirname, '../../../../submission/qwen-article.md'), 'utf8');

describe('Qwen article', () => {
  it('is mirrored exactly in submission/qwen-article.md', () => {
    expect(markdown).toContain(QWEN_ARTICLE.title);
    for (const section of QWEN_ARTICLE.sections) {
      expect(markdown).toContain(`## ${section.heading}`);
      for (const paragraph of section.paragraphs) expect(markdown).toContain(paragraph);
    }
  });

  it('states that it is an unpublished draft and makes no cost or adoption claim', () => {
    expect(QWEN_ARTICLE.status).toMatch(/not yet published/i);
    expect(markdown).not.toMatch(/\bsav(?:ed|ings)\b|\bcustomers?\b|\bendorse/i);
  });

  it('keeps every figure it quotes equal to the recorded evidence', () => {
    const evidence = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../docs/evidence/chapter09-qwen-smoke-2026-10-12.json'),
        'utf8',
      ),
    ) as { run: { functionCalls: { name: string }[] }; assertions: { detail: string }[] };
    expect(evidence.run.functionCalls.map((call) => call.name)).toEqual(
      expect.arrayContaining(['read_sources', 'check_payments', 'check_evidence', 'get_status']),
    );
    expect(evidence.assertions.some((a) => a.detail.includes('differencePence=200000'))).toBe(true);
    expect(evidence.assertions.some((a) => a.detail.includes('evidenceGaps=6'))).toBe(true);
  });
});
