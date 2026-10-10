import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQwenProvider, validateTestBaseUrl } from '@lexaegis/agent';
import {
  createMemoryRunStore,
  createScriptedProvider,
  failure,
  text,
} from '@lexaegis/agent/testing';
import {
  startScriptedQwenServer,
  type ScriptedQwenServer,
} from '@/test-support/scripted-qwen-server';
import { runSmoke } from '../../../scripts/qwen-smoke-core';

/*
 * The smoke check's own code path (fixture extraction with the real pdf.js, the real runtime, the
 * real HTTP adapter) driven against the loopback scripted provider. It shows the check works as a
 * program. It is recorded as "scripted" and is never live Qwen evidence.
 */

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
let server: ScriptedQwenServer;
beforeAll(async () => {
  server = await startScriptedQwenServer();
});
afterAll(async () => {
  await server.stop();
});

function provider() {
  const endpoint = validateTestBaseUrl(server.baseUrl);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  return createQwenProvider({
    id: 'scripted-test',
    apiKey: 'scripted-test-no-key',
    endpoint,
    model: 'qwen3.8-max',
    outputMode: 'json_schema',
  });
}

describe('smoke check program', () => {
  it('passes its assertions over the synthetic fixture and labels the record scripted', async () => {
    const store = createMemoryRunStore();
    const result = await runSmoke({
      root: ROOT,
      provider: provider(),
      store,
      storedForApplication: false,
      evidenceKind: 'scripted',
      now: () => new Date(),
      cancelUtterance: 'Summarise the selected clauses SLOW-TEST',
    });
    expect(result.assertions.map((a) => [a.id, a.ok])).toEqual([
      ['run_completed_with_validated_output', true],
      ['model_requested_two_read_only_tools', true],
      ['answer_cites_resolvable_sources', true],
      ['payment_discrepancy_or_evidence_gap_from_code', true],
      ['scope_limitations_stated', true],
      ['user_input_requirement', true],
      ['cancellation_acknowledged', true],
    ]);
    expect(result.outcome).toBe('pass');
    expect(result.capability).toMatchObject({
      verified: true,
      nativeToolCalls: true,
      structuredOutput: true,
      cancellation: true,
    });
    expect(result.record).toMatchObject({
      schema: 'lexaegis.qwen-smoke.v1',
      evidenceKind: 'scripted',
      provider: {
        id: 'scripted-test',
        region: 'test-loopback',
        requestedModel: 'qwen3.8-max',
        outputMode: 'json_schema',
      },
      fixture: { kind: 'synthetic_fixture' },
    });
    // Model-requested tools executed application code: the real calculator result is recorded.
    const record = JSON.stringify(result.record);
    expect(record).toContain('"differencePence":"200000"');
    expect(record).toContain('"name":"check_payments"');
    // No credential, endpoint or workspace identifier in the evidence.
    for (const secret of [
      'scripted-test-no-key',
      '127.0.0.1',
      'compatible-mode',
      'authorization',
    ]) {
      expect(record).not.toContain(secret);
    }
    // The capability record was saved for this exact configuration.
    expect((await store.capability(result.capability.fingerprint))?.verified).toBe(true);
  });

  it('fails, without any run or fallback, when the capability checks do not pass', async () => {
    const weak = createScriptedProvider(
      [text('I would call get_status.'), failure('capability'), text('one')],
      {
        id: 'qwen',
        region: 'ap-southeast-1',
      },
    );
    const result = await runSmoke({
      root: ROOT,
      provider: weak,
      store: createMemoryRunStore(),
      storedForApplication: false,
      evidenceKind: 'live',
      now: () => new Date(),
    });
    expect(result.outcome).toBe('fail');
    expect(result.assertions).toEqual([]);
    expect(result.record).toMatchObject({ outcome: 'fail' });
    expect(result.capability.failures).toEqual(
      expect.arrayContaining([
        'TOOL_CALL_NOT_NATIVE',
        'OUTPUT_MODE_CAPABILITY',
        'CANCELLATION_NOT_OBSERVED',
      ]),
    );
    // Three capability requests and nothing else: no run was attempted on an unverified configuration.
    expect(weak.requests).toHaveLength(3);
  });
});
