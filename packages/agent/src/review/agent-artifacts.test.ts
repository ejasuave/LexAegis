import { describe, expect, it } from 'vitest';
import type { AnswerBlock, ToolResult } from '../contracts';
import { agentConfigSchema } from '../contracts';
import { TEST_IDS, syntheticContext, syntheticMatter } from '../testing/fixtures';
import {
  agentConfigArtifactBytes,
  analysisArtifactBytes,
  analysisArtifactSchema,
  buildAnalysisArtifact,
  citedHandles,
  localAgentConfig,
  type AnalysisInput,
} from './agent-artifacts';
import { canonicalBytes, sha256Bytes } from './hash';
import { reconcilePayments } from './payments';
import { paymentInputFromFacts } from './checks';

async function input(): Promise<AnalysisInput> {
  const matter = await syntheticMatter();
  const context = syntheticContext(matter);
  const payment: ToolResult = {
    schema: 'lexaegis.tool-result.v1',
    handle: 'T1',
    toolCallId: 'call_1',
    toolName: 'check_payments',
    toolVersion: '1',
    outcome: 'succeeded',
    code: 'OK',
    output: {
      tool: 'check_payments',
      result: reconcilePayments(paymentInputFromFacts(matter.facts, 'settlement')),
    },
  };
  const unused: ToolResult = { ...payment, handle: 'T2', toolCallId: 'call_2' };
  const blocks: AnswerBlock[] = [
    { kind: 'calculation', tool: 'T1', comment: 'The schedule is lower than the total.' },
    { kind: 'quotation', source: 'S1', comment: '' },
    {
      kind: 'finding',
      text: 'Advice evidence is not linked.',
      basis: 'interpretation',
      sources: [],
      rules: ['independent-advice'],
      tools: [],
    },
  ];
  return {
    matterId: TEST_IDS.matter,
    documentVersionId: TEST_IDS.version,
    snapshotDigest: matter.snapshotDigest,
    run: {
      runId: '99999999-0000-4000-8000-000000000001',
      intent: 'check_payments',
      outcome: 'completed',
      startedAt: '2026-10-10T09:05:11.000Z',
      modelExecution: 'scripted-test',
    },
    blocks,
    summary: {
      intent: 'check_payments',
      outcome: 'completed',
      modelExecution: 'scripted-test',
      factProposals: [
        {
          proposalId: 'P1',
          field: 'employer',
          group: 'settlement',
          slot: 'employer',
          value: 'PROPOSED-ONLY Ltd',
          sources: ['S1'],
        },
      ],
      unresolved: [],
      questions: [],
      scopeLimitations: ['Only the selected excerpts were read.'],
      nextActions: ['confirm_fact'],
      blockCount: blocks.length,
    },
    catalog: context.sources,
    tools: [payment, unused],
  };
}

describe('analysis artifact', () => {
  it('holds the validated answer, only what it cites, and the input snapshot binding', async () => {
    const data = await input();
    const artifact = buildAnalysisArtifact(data);
    expect(analysisArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(citedHandles(data.blocks)).toEqual({
      sources: ['S1'],
      rules: ['independent-advice'],
      tools: ['T1'],
    });
    expect(artifact.sources.map((s) => s.handle)).toEqual(['S1']);
    expect(artifact.sources[0]?.reference).toEqual(data.catalog[0]?.reference);
    expect(artifact.toolResults.map((t) => t.handle)).toEqual(['T1']);
    expect(artifact.inputSnapshotDigest).toBe(data.snapshotDigest);
    expect(artifact.provenance).toEqual({ aiAnalysis: true, modelExecution: 'scripted-test' });
  });

  it('leaves out unconfirmed proposals and anything resembling a transcript, prompt or credential', async () => {
    const data = await input();
    const text = new TextDecoder().decode((await analysisArtifactBytes(data)).bytes);
    expect(text).not.toContain('PROPOSED-ONLY');
    expect(text).toContain('"factProposalsNotIncluded":1');
    for (const absent of [
      'reasoning',
      'apiKey',
      'authorization',
      'baseUrl',
      'messages',
      'system',
      'prompt',
    ]) {
      expect(text).not.toContain(`"${absent}"`);
    }
    expect(Object.keys(buildAnalysisArtifact(data)).sort()).toEqual([
      'documentVersionId',
      'engineVersion',
      'inputSnapshotDigest',
      'limitations',
      'matterId',
      'provenance',
      'response',
      'rules',
      'run',
      'schema',
      'sources',
      'toolResults',
    ]);
  });

  it('is canonical and reproducible: the same run gives the same bytes, and the digest is outside them', async () => {
    const data = await input();
    const first = await analysisArtifactBytes(data);
    const second = await analysisArtifactBytes(structuredClone(data));
    expect(first.sha256).toBe(second.sha256);
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.sha256).toBe(await sha256Bytes(first.bytes));
    expect(new TextDecoder().decode(first.bytes)).not.toContain(first.sha256);
    // The recorded timestamp is kept as recorded; nothing regenerates it.
    expect(new TextDecoder().decode(first.bytes)).toContain('2026-10-10T09:05:11.000Z');
    const reparsed = canonicalBytes(JSON.parse(new TextDecoder().decode(first.bytes)));
    expect(Buffer.from(reparsed).equals(Buffer.from(first.bytes))).toBe(true);
    const changed = await analysisArtifactBytes({
      ...data,
      snapshotDigest: `0x${'00'.repeat(32)}`,
    });
    expect(changed.sha256).not.toBe(first.sha256);
  });
});

describe('agent configuration artifact', () => {
  it('records a device-local check with no model, provider, prompts, parameters, budget or usage', async () => {
    const config = localAgentConfig({
      viewId: 'local-view-1',
      intent: 'check_payments',
      startedAt: '2026-10-10T09:05:11.000Z',
      finishedAt: '2026-10-10T09:05:11.000Z',
      toolExecutions: 1,
    });
    expect(config).toMatchObject({
      modelExecution: 'none',
      provider: null,
      prompts: null,
      parameters: null,
      budget: null,
      usage: {
        provenance: 'none',
        providerAttempts: 0,
        reportedInputTokens: null,
        reportedOutputTokens: null,
      },
    });
    const artifact = await agentConfigArtifactBytes(config);
    expect(artifact.sha256).toBe(await sha256Bytes(artifact.bytes));
    expect(
      agentConfigSchema.safeParse(JSON.parse(new TextDecoder().decode(artifact.bytes))).success,
    ).toBe(true);
  });

  it('refuses a configuration that claims a model without a provider, or a provider without a model', async () => {
    const config = localAgentConfig({
      viewId: 'v',
      intent: null,
      startedAt: '2026-10-10T09:05:11.000Z',
      finishedAt: '2026-10-10T09:05:11.000Z',
      toolExecutions: 0,
    });
    await expect(agentConfigArtifactBytes({ ...config, modelExecution: 'qwen' })).rejects.toThrow();
    await expect(
      agentConfigArtifactBytes({
        ...config,
        usage: { ...config.usage, provenance: 'provider_reported', reportedInputTokens: 10 },
      }),
    ).rejects.toThrow();
  });
});
