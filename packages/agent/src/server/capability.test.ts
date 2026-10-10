import { describe, expect, it } from 'vitest';
import {
  createScriptedProvider,
  failure,
  hangUntilAborted,
  json,
  text,
  toolCall,
} from '../testing/scripted-provider';
import { capabilityRecordSchema, runCapabilityChecks } from './capability';

const options = {
  now: () => new Date('2026-10-10T10:00:00Z'),
  signal: new AbortController().signal,
};
const toolOk = toolCall('get_status', { scope: 'matter' });
const outputOk = json({ intent: 'summarise' });
const good = [toolOk, outputOk, hangUntilAborted];

describe('capability checks', () => {
  it('verifies a configuration only when tool calls, the output mode and cancellation all pass', async () => {
    const provider = createScriptedProvider(good);
    const record = await runCapabilityChecks(provider, options);
    expect(capabilityRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      fingerprint: provider.descriptor.fingerprint,
      provider: 'scripted-test',
      outputMode: 'json_schema',
      nativeToolCalls: true,
      structuredOutput: true,
      usageReported: true,
      cancellation: true,
      verified: true,
      failures: [],
      checkedAt: '2026-10-10T10:00:00.000Z',
    });
    // Tools are offered on the tool check only; the structured check carries the response format.
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(['get_status']);
    expect(provider.requests[1]?.tools).toBeUndefined();
    expect(provider.requests[1]?.responseFormat?.mode).toBe('json_schema');
  });

  it('does not accept prose that describes a tool call, or an unknown function', async () => {
    for (const first of [
      text('I will call get_status(scope="matter") now.'),
      text('<tool_call>{"name":"get_status","arguments":{"scope":"matter"}}</tool_call>'),
      toolCall('delete_everything', {}),
      toolCall('get_status', { scope: 'everything' }),
    ]) {
      const record = await runCapabilityChecks(
        createScriptedProvider([first, outputOk, hangUntilAborted]),
        options,
      );
      expect(record).toMatchObject({ nativeToolCalls: false, verified: false });
      expect(record.failures).toContain('TOOL_CALL_NOT_NATIVE');
    }
  });

  it('records an unsupported output mode and never falls back to another', async () => {
    const provider = createScriptedProvider([toolOk, failure('capability'), hangUntilAborted]);
    const record = await runCapabilityChecks(provider, options);
    expect(record).toMatchObject({
      structuredOutput: false,
      verified: false,
      outputMode: 'json_schema',
    });
    expect(record.failures).toContain('OUTPUT_MODE_CAPABILITY');
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.filter((r) => r.responseFormat?.mode === 'json_object')).toHaveLength(
      0,
    );
  });

  it('rejects invalid or truncated structured output', async () => {
    for (const second of [
      text('{"intent":"summar'),
      json({ intent: 'summarise' }, { finishReason: 'length' }),
      json({ answer: 1 }),
    ]) {
      const record = await runCapabilityChecks(
        createScriptedProvider([toolOk, second, hangUntilAborted]),
        options,
      );
      expect(record).toMatchObject({ structuredOutput: false, verified: false });
    }
  });

  it('keeps missing usage as not reported without blocking verification', async () => {
    const record = await runCapabilityChecks(
      createScriptedProvider([
        toolOk,
        json({ intent: 'summarise' }, { usage: null }),
        hangUntilAborted,
      ]),
      options,
    );
    expect(record).toMatchObject({ usageReported: false, verified: true });
  });

  it('fails when cancellation is not observed', async () => {
    const record = await runCapabilityChecks(
      createScriptedProvider([toolOk, outputOk, text('one two three')]),
      options,
    );
    expect(record).toMatchObject({ cancellation: false, verified: false });
  });
});
