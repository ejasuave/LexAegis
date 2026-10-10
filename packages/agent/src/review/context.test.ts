import { describe, expect, it } from 'vitest';
import { ASSISTANT_LIMITS } from '../contracts';
import { TEST_IDS, PROVIDER_SCOPE, syntheticMatter, syntheticRequest } from '../testing/fixtures';
import { buildSelectedContext } from './context';
import { disclosureDigest, summariseDisclosure } from './disclosure';
import { createSourceReference } from './source-references';

describe('selected context', () => {
  it('builds a deterministic handle catalog whatever the selection order', async () => {
    const matter = await syntheticMatter();
    const selection = {
      documentVersionId: TEST_IDS.version,
      facts: [],
      evidence: [],
      savedContext: [],
    };
    const forward = buildSelectedContext(matter.set, {
      ...selection,
      references: [matter.refs.total, matter.refs.schedule, matter.refs.total],
    });
    const reverse = buildSelectedContext(matter.set, {
      ...selection,
      references: [matter.refs.schedule, matter.refs.total],
    });
    expect(forward.ok && reverse.ok && forward.data).toEqual(reverse.ok && reverse.data);
    expect(forward.ok && forward.data.sources.map((s) => [s.handle, s.reference.quote])).toEqual([
      ['S1', matter.refs.total.quote],
      ['S2', matter.refs.schedule.quote],
    ]);
    expect(forward.ok && forward.data.searchedScope).toEqual({
      documentVersionIds: [TEST_IDS.version],
      excerptsOnly: true,
    });
  });

  it('refuses a reference that does not resolve against the verified artifacts', async () => {
    const matter = await syntheticMatter();
    const forged = { ...matter.refs.total, quote: 'a total sum of £99,000.00' };
    const result = buildSelectedContext(matter.set, {
      documentVersionId: TEST_IDS.version,
      references: [forged],
      facts: [],
      evidence: [],
      savedContext: [],
    });
    expect(result).toEqual({ ok: false, code: 'SOURCE_UNRESOLVED' });
  });

  it('rejects an oversized selection and an oversized catalog; nothing is truncated', async () => {
    const matter = await syntheticMatter();
    const big = buildSelectedContext(matter.set, {
      documentVersionId: TEST_IDS.version,
      references: [matter.refs.total],
      facts: [],
      evidence: [],
      savedContext: Array.from({ length: 5 }, (_, i) => ({
        entryId: `entry-${i}`,
        kind: 'note' as const,
        text: 'n'.repeat(8000),
      })),
    });
    expect(big).toEqual({ ok: false, code: 'CONTEXT_TOO_LARGE' });
    const many = Array.from({ length: ASSISTANT_LIMITS.catalogEntries + 1 }, (_, i) => {
      const made = createSourceReference(matter.set, {
        documentVersionId: TEST_IDS.version,
        page: 1,
        start: i,
        end: i + 1,
      });
      if (!made.ok) throw new Error(made.code);
      return made.data;
    });
    expect(
      buildSelectedContext(matter.set, {
        documentVersionId: TEST_IDS.version,
        references: many,
        facts: [],
        evidence: [],
        savedContext: [],
      }),
    ).toEqual({ ok: false, code: 'CATALOG_TOO_LARGE' });
  });
});

describe('disclosure digest', () => {
  it('changes with any disclosed content and with the provider scope', async () => {
    const matter = await syntheticMatter();
    const { consent, ...body } = await syntheticRequest(matter);
    expect(await disclosureDigest(body, PROVIDER_SCOPE)).toBe(consent.disclosureDigest);
    const changed = [
      await disclosureDigest({ ...body, utterance: '/summarise please' }, PROVIDER_SCOPE),
      await disclosureDigest({ ...body, vaultGeneration: 4 }, PROVIDER_SCOPE),
      await disclosureDigest(
        { ...body, history: [{ role: 'user', text: 'earlier question' }] },
        PROVIDER_SCOPE,
      ),
      await disclosureDigest(body, { ...PROVIDER_SCOPE, region: 'ap-southeast-1' }),
      await disclosureDigest(body, { ...PROVIDER_SCOPE, model: 'qwen3.8-max-0902' }),
    ];
    expect(new Set([consent.disclosureDigest, ...changed]).size).toBe(6);
  });

  it('summarises exactly what the request contains', async () => {
    const matter = await syntheticMatter();
    const { consent: _consent, ...body } = await syntheticRequest(matter);
    const summary = summariseDisclosure(body, PROVIDER_SCOPE);
    expect(summary.excerpts.map((e) => e.handle)).toEqual(['S1', 'S2']);
    expect(summary).toMatchObject({ facts: 4, evidenceDescriptors: 1, conversationMessages: 0 });
  });
});
