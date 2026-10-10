import { describe, expect, it } from 'vitest';
import { answer, done, toolCall } from '@lexaegis/agent/testing';
import { EVIDENCE_PREFIX, FACT_PREFIX } from '@/features/review/persistence';
import {
  assistantRig,
  dispose,
  lastRun,
  until,
  type AssistantRig,
} from '@/test-support/assistant-rig';
import { must, wait } from '@/test-support/review-rig';
import {
  AGENT_CONFIG_LABEL,
  ANALYSIS_LABEL,
  decodeOutcome,
  describeContextEntry,
} from './saved-outcomes';
import { OUTCOME_PREFIX } from './selected-context';

/*
 * Fact proposals and saved outcomes on the real review and vault controllers (real Web Crypto,
 * in-memory vault server) with the real runtime and a scripted provider.
 */

const proposing = (
  value: string,
  field: 'payment_instalment' | 'employer' = 'payment_instalment',
) =>
  answer({
    outcome: 'needs_input',
    blocks: [],
    factProposals: [
      {
        field,
        group: 'settlement',
        slot: field === 'employer' ? 'employer' : 'i2',
        value,
        sources: ['S1'],
      },
    ],
    questions: ['Please confirm the value shown in the selected passage.'],
  });

async function proposed(
  script = [done(), proposing('1400000')],
): Promise<{ a: AssistantRig; viewId: string }> {
  const a = await assistantRig(script);
  await a.assistant.action('explain', { references: [a.clause] });
  await a.assistant.send();
  const run = lastRun(a);
  if (run === null) throw new Error('no run');
  return { a, viewId: run.id };
}

const facts = (a: AssistantRig) =>
  a.r.controller
    .getSnapshot()
    .facts.map((f) => `${f.field}:${f.slot}=${f.value}@${f.revision}`)
    .sort();

describe('fact proposals', () => {
  it('a proposal confirms nothing until the reviewer chooses Confirm', async () => {
    const { a, viewId } = await proposed();
    const before = facts(a);
    expect(lastRun(a)).toMatchObject({
      state: 'awaiting_input',
      outcome: 'needs_input',
      proposals: {},
    });
    expect(lastRun(a)?.summary?.factProposals).toHaveLength(1);
    expect(facts(a)).toEqual(before);
    // Typed replies are requests or refusals; none of them is a confirmation.
    for (const reply of ['yes', 'approve', 'confirm it', 'ok, approve that']) {
      await a.assistant.submit(reply);
      a.assistant.cancelPreview();
    }
    expect(facts(a)).toEqual(before);
    expect(lastRun(a)?.proposals).toEqual({});
    expect(viewId).toBe(lastRun(a)?.id);
    dispose(a);
  });

  it('Confirm records the reviewer action as a correction and makes earlier results out of date', async () => {
    const { a, viewId } = await proposed();
    expect(await a.assistant.confirmProposal(viewId, 'P1')).toBe(true);
    const fact = a.r.controller.getSnapshot().facts.find((f) => f.slot === 'i2');
    expect(fact).toMatchObject({
      value: '1400000',
      revision: 2,
      basis: 'source',
      confirmedBy: a.r.h.controller.getSnapshot().account?.address.toLowerCase(),
    });
    expect(fact?.references[0]?.quote).toBe(a.clause.quote);
    expect(lastRun(a)).toMatchObject({ proposals: { P1: 'confirmed' }, stale: true });
    expect(a.r.controller.getSnapshot().save).toBe('unsaved');
    // A second click does nothing.
    expect(await a.assistant.confirmProposal(viewId, 'P1')).toBe(false);

    // The refreshed deterministic check now uses the corrected value.
    await a.assistant.submit('/check-payments');
    const check = lastRun(a);
    const tool = check?.tools[0];
    expect(tool?.output?.tool === 'check_payments' && tool.output.result).toMatchObject({
      outcome: 'match',
      comparableSumPence: '2400000',
      differencePence: '0',
    });
    dispose(a);
  });

  it('Edit confirms the corrected value of the reviewer; an invalid value confirms nothing', async () => {
    const { a, viewId } = await proposed();
    const before = facts(a);
    expect(await a.assistant.confirmProposal(viewId, 'P1', '£14,000')).toBe(false);
    expect(facts(a)).toEqual(before);
    expect(a.assistant.getSnapshot().notice).toContain('does not fit');
    expect(await a.assistant.confirmProposal(viewId, 'P1', '1350000')).toBe(true);
    expect(a.r.controller.getSnapshot().facts.find((f) => f.slot === 'i2')?.value).toBe('1350000');
    dispose(a);
  });

  it('Dismiss records nothing, and a proposal whose source changed cannot be confirmed', async () => {
    const dismissed = await proposed();
    const before = facts(dismissed.a);
    dismissed.a.assistant.dismissProposal(dismissed.viewId, 'P1');
    expect(lastRun(dismissed.a)?.proposals).toEqual({ P1: 'dismissed' });
    expect(await dismissed.a.assistant.confirmProposal(dismissed.viewId, 'P1')).toBe(false);
    expect(facts(dismissed.a)).toEqual(before);
    dispose(dismissed.a);

    const changed = await proposed();
    await changed.a.r.controller.setSelected([]);
    expect(await changed.a.assistant.confirmProposal(changed.viewId, 'P1')).toBe(false);
    expect(changed.a.assistant.getSnapshot().notice).toContain('no longer matches');
    dispose(changed.a);
  });
});

describe('saved outcomes', () => {
  const completed = async () => {
    const a = await assistantRig([
      toolCall('check_payments', { groupId: 'settlement' }),
      done(),
      answer({
        blocks: [
          {
            kind: 'calculation',
            text: 'SENTINEL-COMMENT the schedule is lower.',
            basis: 'supported',
            sources: [],
            rules: [],
            tools: ['T1'],
          },
          {
            kind: 'quotation',
            text: '',
            basis: 'supported',
            sources: ['S1'],
            rules: [],
            tools: [],
          },
        ],
      }),
    ]);
    await a.assistant.action('check_payments');
    await a.assistant.send();
    const run = lastRun(a);
    if (run === null) throw new Error('no run');
    return { a, viewId: run.id };
  };
  const outcomes = (a: AssistantRig) =>
    (a.r.h.vault.getSnapshot().selectedMatter?.context.entries ?? []).filter((e) =>
      e.text.startsWith(OUTCOME_PREFIX),
    );

  it('shows saved only after encrypted read-back and the catalog commit', async () => {
    const { a, viewId } = await completed();
    expect(lastRun(a)?.save.state).toBe('unsaved');
    expect(outcomes(a)).toHaveLength(0);
    expect(await a.assistant.saveOutcome(viewId)).toBe(true);
    expect(lastRun(a)?.save).toEqual({ state: 'saved', message: null });

    const [entry] = outcomes(a);
    // An observation: recorded as model-proposed and unconfirmed, apart from confirmed facts.
    expect(entry).toMatchObject({
      kind: 'outcome',
      status: 'unconfirmed',
      origin: 'model_proposed',
      confirmedAt: null,
    });
    const stored = decodeOutcome(entry?.text ?? '');
    expect(stored).toMatchObject({
      v: 1,
      intent: 'check_payments',
      outcome: 'completed',
      modelExecution: 'scripted-test',
    });
    expect(stored?.summary).toContain('difference £2,000.00');
    expect(describeContextEntry(entry?.text ?? '')).toMatch(/^Assistant observation: /);
    expect(a.r.controller.getSnapshot().facts).toHaveLength(4);

    // Both artifacts read back through the vault, hash-checked, as canonical JSON.
    const analysis = JSON.parse(
      new TextDecoder().decode(
        must(await a.r.h.vault.readSource(a.r.matterId, stored?.analysisVersionId ?? '')),
      ),
    ) as {
      schema: string;
      response: { blocks: unknown[] };
      sources: unknown[];
      toolResults: { handle: string }[];
    };
    expect(analysis.schema).toBe('lexaegis.assistant-analysis.v1');
    expect(analysis.response.blocks).toHaveLength(2);
    expect(analysis.sources).toHaveLength(1);
    expect(analysis.toolResults.map((t) => t.handle)).toEqual(['T1']);
    const config = JSON.parse(
      new TextDecoder().decode(
        must(await a.r.h.vault.readSource(a.r.matterId, stored?.agentConfigVersionId ?? '')),
      ),
    ) as { schema: string; modelExecution: string };
    expect(config).toMatchObject({
      schema: 'lexaegis.agent-config.v1',
      modelExecution: 'scripted-test',
    });

    // The server holds ciphertext only.
    const server = [...a.r.h.server.objects.objects.values()]
      .map((o) => Buffer.from(o).toString('latin1'))
      .join('');
    for (const plain of ['SENTINEL-COMMENT', 'assistant-analysis', '24,000', 'check_payments']) {
      expect(server).not.toContain(plain);
    }
    // Saving again is refused: nothing is stored twice.
    expect(await a.assistant.saveOutcome(viewId)).toBe(false);
    expect(outcomes(a)).toHaveLength(1);
    dispose(a);
  });

  it('recovers the saved outcome through lock and unlock', async () => {
    const { a, viewId } = await completed();
    await a.assistant.saveOutcome(viewId);
    a.r.h.vault.lock();
    await wait(10);
    expect(a.assistant.getSnapshot().conversation).toEqual([]);
    must(await a.r.h.vault.unlock());
    a.r.h.vault.selectMatter(a.r.matterId);
    await wait(100);
    const [entry] = outcomes(a);
    const stored = decodeOutcome(entry?.text ?? '');
    expect(stored?.summary).toContain('Payment check: mismatch');
    expect((await a.r.h.vault.readSource(a.r.matterId, stored?.analysisVersionId ?? '')).ok).toBe(
      true,
    );
    // The raw chat was never stored: only the outcome entry and the typed review entries exist.
    const others = (a.r.h.vault.getSnapshot().selectedMatter?.context.entries ?? []).filter(
      (e) =>
        !e.text.startsWith(OUTCOME_PREFIX) &&
        !e.text.startsWith(FACT_PREFIX) &&
        !e.text.startsWith(EVIDENCE_PREFIX),
    );
    expect(others).toEqual([]);
    dispose(a);
  });

  it('refuses to save a result that is out of date, incomplete or whose source changed', async () => {
    const { a, viewId } = await completed();
    const fact = a.r.controller.getSnapshot().facts[0];
    a.r.controller.removeFact(fact?.factId ?? '');
    expect(await a.assistant.saveOutcome(viewId)).toBe(false);
    expect(lastRun(a)?.save).toMatchObject({ state: 'failed' });
    expect(lastRun(a)?.save.message).toContain('out of date');
    expect(outcomes(a)).toHaveLength(0);
    dispose(a);
  });

  it('keeps the result as a clearly unsaved draft when the vault write fails, and saves on retry', async () => {
    const { a, viewId } = await completed();
    const objectsBefore = a.r.h.server.objects.objects.size;
    a.r.h.faults.dropNextWrite = true;
    expect(await a.assistant.saveOutcome(viewId)).toBe(false);
    const failed = lastRun(a);
    expect(failed?.save.state).toBe('failed');
    expect(failed?.save.message).toContain('still here, unsaved');
    expect(failed?.blocks).toHaveLength(2);
    expect(outcomes(a).filter((e) => e.status === 'confirmed')).toEqual([]);

    await until(() => a.r.h.vault.getSnapshot().save !== 'saving');
    // Retrying completes the vault's unfinished save rather than storing the artifact again.
    expect(await a.assistant.saveOutcome(viewId)).toBe(true);
    expect(lastRun(a)?.save.state).toBe('saved');
    expect(outcomes(a)).toHaveLength(1);
    // Each artifact is recorded once, and every recorded artifact can be read back.
    const sources = a.r.h.vault.getSnapshot().selectedMatter?.sources ?? [];
    const labelled = (prefix: string) =>
      sources.filter((source) => source.label.startsWith(prefix));
    expect(labelled(ANALYSIS_LABEL)).toHaveLength(1);
    expect(labelled(AGENT_CONFIG_LABEL)).toHaveLength(1);
    for (const source of [...labelled(ANALYSIS_LABEL), ...labelled(AGENT_CONFIG_LABEL)]) {
      expect((await a.r.h.vault.readSource(a.r.matterId, source.documentVersionId)).ok).toBe(true);
    }
    expect(a.r.h.server.objects.objects.size).toBeGreaterThan(objectsBefore);
    dispose(a);
  });

  it('a lock during saving never shows saved', async () => {
    const { a, viewId } = await completed();
    const saving = a.assistant.saveOutcome(viewId);
    a.r.h.vault.lock();
    expect(await saving).toBe(false);
    expect(a.assistant.getSnapshot().conversation).toEqual([]);
    dispose(a);
  });

  it('saves a device-local check with no model recorded', async () => {
    const a = await assistantRig([]);
    await a.assistant.submit('/check-payments');
    const run = lastRun(a);
    expect(await a.assistant.saveOutcome(run?.id ?? '')).toBe(true);
    const stored = decodeOutcome(outcomes(a)[0]?.text ?? '');
    expect(stored?.modelExecution).toBe('none');
    const config = JSON.parse(
      new TextDecoder().decode(
        must(await a.r.h.vault.readSource(a.r.matterId, stored?.agentConfigVersionId ?? '')),
      ),
    ) as Record<string, unknown>;
    expect(config).toMatchObject({
      modelExecution: 'none',
      provider: null,
      prompts: null,
      parameters: null,
      budget: null,
    });
    expect((config.usage as { provenance: string }).provenance).toBe('none');
    dispose(a);
  });
});
