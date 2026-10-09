import { describe, expect, it } from 'vitest';
import {
  assistantEventSchema,
  assistantRequestSchema,
  assistantToolNameSchema,
  cancelRunInputSchema,
} from './assistant';

const base = {
  schema: 'lexaegis.assistant-event.v1',
  runId: 'run_1',
  matterId: 'matter_1',
  documentVersionId: 'docver_1',
  seq: 1,
  timestamp: '2026-10-08T12:00:00.000Z',
} as const;

describe('assistant events', () => {
  it('accepts a terminal completion event with an empty payload', () => {
    const result = assistantEventSchema.safeParse({ ...base, type: 'run_completed', payload: {} });
    expect(result.success).toBe(true);
  });

  it('a run-completed event cannot assert a receipt confirmation, approval or signature', () => {
    for (const claim of [
      { receiptConfirmed: true },
      { approved: true },
      { transactionHash: `0x${'ab'.repeat(32)}` },
    ]) {
      const parsed = assistantEventSchema.safeParse({
        ...base,
        type: 'run_completed',
        payload: claim,
      });
      expect(parsed.success).toBe(false);
    }
    expect(
      assistantEventSchema.safeParse({
        ...base,
        type: 'run_completed',
        payload: {},
        receiptConfirmed: true,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown event types and payloads that do not match their type', () => {
    expect(assistantEventSchema.safeParse({ ...base, type: 'sign', payload: {} }).success).toBe(
      false,
    );
    expect(
      assistantEventSchema.safeParse({
        ...base,
        type: 'state_changed',
        payload: { state: 'approved' },
      }).success,
    ).toBe(false);
    expect(
      assistantEventSchema.safeParse({
        ...base,
        type: 'tool_started',
        payload: { toolCallId: 'call_1', toolName: 'sign_transaction' },
      }).success,
    ).toBe(false);
  });

  it('requires run, matter and a positive monotonic sequence number', () => {
    const { runId: _runId, ...withoutRun } = base;
    expect(
      assistantEventSchema.safeParse({ ...withoutRun, type: 'run_cancelled', payload: {} }).success,
    ).toBe(false);
    expect(
      assistantEventSchema.safeParse({ ...base, seq: 0, type: 'run_cancelled', payload: {} })
        .success,
    ).toBe(false);
    expect(
      assistantEventSchema.safeParse({
        ...base,
        documentVersionId: null,
        type: 'run_cancelled',
        payload: {},
      }).success,
    ).toBe(true);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      assistantEventSchema.safeParse({ ...base, type: 'run_cancelled', payload: {}, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('assistant request and tools', () => {
  const request = {
    schema: 'lexaegis.assistant-request.v1',
    clientRequestId: 'req_1',
    intent: 'check_payments',
    utterance: 'Why do these payments not add up?',
    context: { matterId: 'matter_1', documentVersionId: null, sourceReferences: [] },
  };

  it('accepts only the documented intents', () => {
    expect(assistantRequestSchema.safeParse(request).success).toBe(true);
    for (const intent of ['sign', 'approve', 'revoke', 'send_message', 'stop']) {
      expect(assistantRequestSchema.safeParse({ ...request, intent }).success).toBe(false);
    }
  });

  it('rejects unexpected request fields such as an approval flag or owner override', () => {
    expect(assistantRequestSchema.safeParse({ ...request, approved: true }).success).toBe(false);
    expect(assistantRequestSchema.safeParse({ ...request, ownerId: 'someone' }).success).toBe(
      false,
    );
  });

  it('exposes no signing, approval or arbitrary-execution tool to the model', () => {
    const names = assistantToolNameSchema.options;
    for (const forbidden of ['sign', 'approve', 'revoke', 'supersede', 'send_message', 'exec']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });

  it('binds cancellation to a run and its owner', () => {
    expect(cancelRunInputSchema.safeParse({ runId: 'run_1', ownerId: 'acct_1' }).success).toBe(
      true,
    );
    expect(cancelRunInputSchema.safeParse({ runId: 'run_1' }).success).toBe(false);
  });
});
