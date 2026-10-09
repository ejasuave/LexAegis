import 'server-only';
import { unavailable, type Result } from '@lexaegis/protocol';
import type {
  AssistantEvent,
  AssistantRequest,
  AssistantRunState,
  CancelRunInput,
} from './contracts';

export interface StartRunContext {
  /** Authenticated owner, derived from the server session. */
  readonly ownerId: string;
  readonly signal: AbortSignal;
}

/**
 * Server-side review agent. The model proposes; deterministic code decides.
 * No method here can approve, sign, revoke or supersede anything.
 */
export interface ReviewAgent {
  start(request: AssistantRequest, context: StartRunContext): Promise<Result<{ runId: string }>>;
  events(runId: string, ownerId: string, signal: AbortSignal): AsyncIterable<AssistantEvent>;
  cancel(input: CancelRunInput, signal: AbortSignal): Promise<Result<{ state: AssistantRunState }>>;
}

/** Adapter used until Chapter 9 supplies the Qwen runtime. It reports NOT_IMPLEMENTED and does nothing else. */
export function createUnavailableReviewAgent(): ReviewAgent {
  return {
    start: () => Promise.resolve(unavailable('NOT_IMPLEMENTED', 'The review assistant')),
    // An unavailable agent has no events to emit, so the stream is empty and finishes immediately.
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
    cancel: () => Promise.resolve(unavailable('NOT_IMPLEMENTED', 'Run cancellation')),
  };
}
