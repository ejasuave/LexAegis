import type { AssistantEvent, SourceReferenceV1 } from '@lexaegis/agent/contracts';
import { agentHarness, type ScriptStep } from '@lexaegis/agent/testing';
import type { AssistantTransport } from '@/features/assistant/api-client';
import { AssistantController } from '@/features/assistant/controller';
import type { SseItem } from '@/features/assistant/sse-reader';
import { confirm, importAndWait, port, range, rig, type Rig } from './review-rig';

/*
 * lexaegis-test-only
 * Test rig: the real browser assistant controller on the real review and vault controllers, with
 * a transport that calls the real runtime in process (scripted provider, in-memory run store).
 * `tamper` lets a test corrupt the event stream. Test code only.
 */

export const PAYMENT_FACTS = [
  { field: 'payment_total', slot: 'total', value: '2400000', quote: '24,000', page: 2 },
  { field: 'payment_instalment', slot: 'i1', value: '1000000', quote: '10,000', page: 2 },
  { field: 'payment_instalment', slot: 'i2', value: '1200000', quote: '12,000', page: 2 },
  { field: 'payment_basis', slot: 'basis', value: 'gross', quote: 'gross', page: 2 },
];

export type Tamper = (event: AssistantEvent, index: number) => (AssistantEvent | string)[];

export interface AssistantRig {
  readonly r: Rig;
  readonly h: ReturnType<typeof agentHarness>;
  readonly assistant: AssistantController;
  readonly documentVersionId: string;
  readonly clause: SourceReferenceV1;
  readonly transportCalls: { start: number; cancel: string[]; status: string[] };
  tamper: Tamper | null;
  /** Makes the next start resolve like a network that never delivers a stream end. */
  dropStreamAfter: number | null;
}

export async function assistantRig(
  script: readonly ScriptStep[],
  options: Parameters<typeof agentHarness>[1] & { facts?: boolean; signedIn?: boolean } = {},
): Promise<AssistantRig> {
  const r = await rig();
  const doc = await importAndWait(r, 'discrepancy-2000');
  const documentVersionId = doc.documentVersionId;
  if (options.facts !== false) {
    for (const spec of PAYMENT_FACTS) await confirm(r, documentVersionId, spec);
  }
  const text = r.controller.extraction(documentVersionId)?.pages[1]?.text ?? '';
  const made = r.controller.createReference({
    documentVersionId,
    page: 2,
    ...range(text, '24,000'),
  });
  if (!made.ok) throw new Error(made.code);

  const h = agentHarness(script, options);
  const owner = r.h.controller.getSnapshot().account?.address.toLowerCase() ?? '';
  const calls = { start: 0, cancel: [] as string[], status: [] as string[] };
  const signal = new AbortController().signal;
  const state: Pick<AssistantRig, 'tamper' | 'dropStreamAfter'> = {
    tamper: null,
    dropStreamAfter: null,
  };

  const transport: AssistantTransport = {
    async availability() {
      if (options.signedIn === false)
        return { ok: false, code: 'UNAUTHENTICATED', message: 'Not signed in.', reason: null };
      return { ok: true, availability: await h.agent.availability() };
    },
    async start(request, abort) {
      calls.start += 1;
      const connection = new AbortController();
      abort.addEventListener('abort', () => connection.abort(), { once: true });
      const started = await h.agent.start(request, {
        ownerId: owner,
        signal: connection.signal,
        sessionValid: () => Promise.resolve(h.session.valid),
      });
      if (!started.ok) {
        return {
          kind: 'error',
          code: started.error.code,
          message: started.error.message,
          reason: null,
        };
      }
      const { events, metadata } = started.data;
      if (events === null) return { kind: 'repeated', metadata };
      async function* items(): AsyncGenerator<SseItem> {
        let index = 0;
        for await (const event of events ?? []) {
          const out = state.tamper === null ? [event] : state.tamper(event, index);
          index += 1;
          for (const one of out) {
            yield { kind: 'event', data: typeof one === 'string' ? one : JSON.stringify(one) };
          }
          if (state.dropStreamAfter !== null && index >= state.dropStreamAfter) return;
        }
      }
      return { kind: 'stream', events: items() };
    },
    async cancel(runId) {
      calls.cancel.push(runId);
      const cancelled = await h.agent.cancel({ runId, ownerId: owner }, signal);
      return cancelled.ok
        ? { ok: true, state: cancelled.data.state, acknowledged: cancelled.data.acknowledged }
        : { ok: false, code: cancelled.error.code, message: cancelled.error.message, reason: null };
    },
    async status(runId) {
      calls.status.push(runId);
      const status = await h.agent.status(runId, owner);
      return status.ok
        ? { ok: true, metadata: status.data }
        : { ok: false, code: status.error.code, message: status.error.message, reason: null };
    },
  };

  const assistant = new AssistantController({
    review: r.controller,
    vault: port(r.h),
    account: () => ({ present: true, unlocked: true }),
    transport,
    // The runtime's clock, so a consent is fresh for the server that checks it.
    now: h.now,
    newId: () => crypto.randomUUID(),
  });
  await assistant.refreshAvailability();
  return Object.assign(state, {
    r,
    h,
    assistant,
    documentVersionId,
    clause: made.data,
    transportCalls: calls,
  });
}

export const lastRun = (a: AssistantRig) =>
  [...a.assistant.getSnapshot().conversation].reverse().find((item) => item.run !== null)?.run ??
  null;

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function dispose(a: AssistantRig): void {
  a.assistant.dispose();
  a.r.controller.dispose();
}
