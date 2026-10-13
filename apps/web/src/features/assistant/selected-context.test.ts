import { describe, expect, it } from 'vitest';
import type { AssistantAvailability } from '@lexaegis/agent/contracts';
import { disclosureDigest } from '@lexaegis/agent/review';
import { confirm, importAndWait, range, rig, wait, type Rig } from '@/test-support/review-rig';
import {
  DISCLOSURE_FACTS,
  consentToDisclosure,
  disclosureIsCurrent,
  prepareDisclosure,
} from './disclosure';
import { buildRequestBody, factsFor, savedContextOf, type ContextPorts } from './selected-context';

/*
 * Selected context and disclosure on the real review and vault controllers with a real synthetic
 * PDF. Nothing here talks to a provider.
 */

const availability: AssistantAvailability = {
  schema: 'lexaegis.assistant-availability.v1',
  state: 'test_provider',
  providerScope: { provider: 'scripted-test', model: 'qwen3.8-max', region: 'test-loopback' },
  notices: [],
  briefingEnabled: false,
};

const ports = (r: Rig): ContextPorts => ({
  review: r.controller,
  vault: r.h.vault,
  account: () => ({ present: true, unlocked: true }),
  newId: () => crypto.randomUUID(),
});

async function prepared() {
  const r = await rig();
  const doc = await importAndWait(r, 'discrepancy-2000');
  const id = doc.documentVersionId;
  for (const spec of [
    { field: 'payment_total', slot: 'total', value: '2400000', quote: '24,000', page: 2 },
    { field: 'payment_instalment', slot: 'i1', value: '1000000', quote: '10,000', page: 2 },
    { field: 'payment_instalment', slot: 'i2', value: '1200000', quote: '12,000', page: 2 },
    { field: 'payment_basis', slot: 'basis', value: 'gross', quote: 'gross', page: 2 },
    { field: 'employer', slot: 'employer', value: 'Northwind', quote: 'Northwind', page: 1 },
  ]) {
    expect(await confirm(r, id, spec)).toEqual({ ok: true });
  }
  const text = r.controller.extraction(id)?.pages[1]?.text ?? '';
  const clause = r.controller.createReference({
    documentVersionId: id,
    page: 2,
    ...range(text, '24,000'),
  });
  if (!clause.ok) throw new Error(clause.code);
  return { r, id, clause: clause.data };
}

describe('selected context for a request', () => {
  it('builds bounded, hash-verified matter excerpts without manually selecting a passage', async () => {
    const { r } = await prepared();
    await r.controller.setSelected([]);
    const built = await buildRequestBody(ports(r), {
      intent: 'ask_matter',
      trigger: 'free_text',
      utterance: 'Analyse the employment settlement and identify the risks.',
      documentVersionId: null,
      references: [],
      savedEntryIds: [],
      history: [],
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.documentVersionId).toBeNull();
      expect(built.body.context.sources.length).toBeGreaterThan(0);
      expect(built.body.context.searchedScope.automatic?.includedDocuments).toBe(1);
      for (const source of built.body.context.sources) {
        expect(source.reference.quote.length).toBeLessThanOrEqual(450);
        expect(source.reference.sourceSha256).toMatch(/^0x[0-9a-f]{64}$/);
      }
      expect(r.controller.getSnapshot().documents.every((doc) => !doc.selected)).toBe(true);
    }
    r.controller.dispose();
  });

  it('sends only the selected excerpt for an explanation, with no facts or client status', async () => {
    const { r, id, clause } = await prepared();
    const built = await buildRequestBody(ports(r), {
      intent: 'explain',
      trigger: 'ui_action',
      utterance: '',
      documentVersionId: id,
      references: [clause],
      savedEntryIds: [],
      history: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.context.sources.map((s) => s.reference.quote)).toEqual(['24,000']);
    expect(built.body.context.facts).toEqual([]);
    expect(built.body.context.evidence).toEqual([]);
    expect(built.body.clientObserved).toBeNull();
    // The body carries no whole document: only the selected quote and bindings.
    expect(JSON.stringify(built.body).length).toBeLessThan(4000);
    r.controller.dispose();
  });

  it('says on the preview that an excerpt carries the digests of its source, which it does', async () => {
    // Chapter 17 privacy check: the request names the SHA-256 of the file and of its extraction for
    // every excerpt. The disclosure facts must say so for as long as the request does.
    const { r, id, clause } = await prepared();
    const built = await buildRequestBody(ports(r), {
      intent: 'explain',
      trigger: 'ui_action',
      utterance: '',
      documentVersionId: id,
      references: [clause],
      savedEntryIds: [],
      history: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const references = built.body.context.sources.map((source) => source.reference);
    expect(references.length).toBe(1);
    for (const reference of references) {
      expect(reference.sourceSha256).toMatch(/^0x[0-9a-f]{64}$/);
      expect(reference.extractionSha256).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(
      DISCLOSURE_FACTS.some(
        (fact) => /source reference/.test(fact) && /SHA-256 of the file/.test(fact),
      ),
    ).toBe(true);
    r.controller.dispose();
  });

  it('includes payment facts and the passages they cite for a payment explanation', async () => {
    const { r, id } = await prepared();
    const built = await buildRequestBody(ports(r), {
      intent: 'check_payments',
      trigger: 'ui_action',
      utterance: '',
      documentVersionId: id,
      references: [],
      savedEntryIds: [],
      history: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.context.facts.map((f) => f.field).sort()).toEqual([
      'payment_basis',
      'payment_instalment',
      'payment_instalment',
      'payment_total',
    ]);
    expect(built.body.context.sources.length).toBe(4);
    expect(factsFor('summarise', r.controller.getSnapshot().facts)).toEqual([]);
    r.controller.dispose();
  });

  it('serves a directly requested deterministic check locally and builds no request', async () => {
    const { r, id } = await prepared();
    for (const intent of ['status', 'check_payments', 'missing_evidence'] as const) {
      expect(
        await buildRequestBody(ports(r), {
          intent,
          trigger: 'command',
          utterance: '',
          documentVersionId: id,
          references: [],
          savedEntryIds: [],
          history: [],
        }),
      ).toEqual({ ok: false, code: 'LOCAL_INTENT' });
    }
    r.controller.dispose();
  });

  it('never sends typed fact or evidence entries, or unconfirmed entries, as saved context', async () => {
    const { r } = await prepared();
    const vault = r.h.vault.getSnapshot();
    const factEntry = vault.selectedMatter?.context.entries[0];
    expect(factEntry).toBeDefined();
    expect(savedContextOf(vault, [factEntry?.entryId ?? ''])).toEqual({
      ok: false,
      code: 'CONTEXT_ENTRY_NOT_TEXT',
    });
    expect(savedContextOf(vault, ['00000000-0000-4000-8000-000000000000'])).toEqual({
      ok: false,
      code: 'CONTEXT_ENTRY_NOT_FOUND',
    });
    r.controller.dispose();
  });
});

describe('disclosure consent', () => {
  const input = (
    id: string,
    clause: Parameters<typeof disclosureDigest>[0]['context']['sources'][number]['reference'],
  ) => ({
    intent: 'explain' as const,
    trigger: 'ui_action' as const,
    utterance: '',
    documentVersionId: id,
    references: [clause],
    savedEntryIds: [],
    history: [],
  });
  const binding = (r: Rig) => ({
    providerScope: availability.providerScope,
    matterId: r.matterId,
    inputRevision: r.controller.getSnapshot().inputRevision,
    vaultGeneration: r.h.vault.getSnapshot().generation,
  });

  it('binds consent to the exact disclosure and refuses an unverified or missing provider', async () => {
    const { r, id, clause } = await prepared();
    const built = await buildRequestBody(ports(r), input(id, clause));
    if (!built.ok) throw new Error(built.code);
    expect(
      await prepareDisclosure(built.body, { ...availability, state: 'not_configured' }),
    ).toEqual({
      ok: false,
      code: 'ASSISTANT_NOT_CONFIGURED',
    });
    expect(
      await prepareDisclosure(built.body, { ...availability, state: 'configured_unverified' }),
    ).toEqual({ ok: false, code: 'ASSISTANT_NOT_VERIFIED' });
    const prepared_ = await prepareDisclosure(built.body, availability);
    if (!prepared_.ok) throw new Error(prepared_.code);
    const consented = consentToDisclosure(
      prepared_.pending,
      binding(r),
      new Date('2026-10-10T10:00:00Z'),
    );
    expect(consented.ok).toBe(true);
    if (!consented.ok) return;
    expect(consented.request.consent).toMatchObject({
      action: 'explicit_send',
      disclosureDigest: prepared_.pending.digest,
      matterId: r.matterId,
      documentVersionId: id,
    });
    const { consent: _consent, ...body } = consented.request;
    expect(await disclosureDigest(body, prepared_.pending.providerScope)).toBe(
      prepared_.pending.digest,
    );
    r.controller.dispose();
  });

  it('needs renewed consent after a fact, source, provider or vault change', async () => {
    const { r, id, clause } = await prepared();
    const built = await buildRequestBody(ports(r), input(id, clause));
    if (!built.ok) throw new Error(built.code);
    const prepared_ = await prepareDisclosure(built.body, availability);
    if (!prepared_.ok) throw new Error(prepared_.code);
    const pending = prepared_.pending;
    expect(disclosureIsCurrent(pending, binding(r))).toBe(true);
    // Another provider scope.
    expect(
      disclosureIsCurrent(pending, {
        ...binding(r),
        providerScope: { provider: 'qwen', model: 'qwen3.8-max', region: 'ap-southeast-1' },
      }),
    ).toBe(false);
    // A fact revision.
    const fact = r.controller.getSnapshot().facts[0];
    expect(r.controller.removeFact(fact?.factId ?? '')).toEqual({ ok: true });
    expect(disclosureIsCurrent(pending, binding(r))).toBe(false);
    expect(consentToDisclosure(pending, binding(r), new Date())).toEqual({
      ok: false,
      code: 'DISCLOSURE_STALE',
    });
    // A lock empties the controller; an old disclosure can never be sent afterwards.
    r.h.vault.lock();
    await wait(10);
    expect(disclosureIsCurrent(pending, binding(r))).toBe(false);
    const after = await buildRequestBody(ports(r), input(id, clause));
    expect(after.ok).toBe(false);
    r.controller.dispose();
  });
});
