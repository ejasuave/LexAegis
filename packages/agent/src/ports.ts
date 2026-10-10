import 'server-only';
import { unavailable, type Result } from '@lexaegis/protocol';
import type {
  AgentRunMetadataV1,
  AssistantAvailability,
  AssistantEvent,
  AssistantRequest,
  AssistantRunState,
  CancelRunInput,
} from './contracts';

export interface StartRunContext {
  /** Authenticated owner, derived from the server session. */
  readonly ownerId: string;
  /** Aborts when the client disconnects; the run is then cancelled, never continued. */
  readonly signal: AbortSignal;
  /** Re-checked before every dispatch. False (signed out, expired, revoked) ends the run. */
  readonly sessionValid: () => Promise<boolean>;
}

export interface StartedRun {
  readonly metadata: AgentRunMetadataV1;
  /**
   * The live events of this admission. Null for a repeated admission of the same request ID:
   * nothing runs again and no private result is replayed.
   */
  readonly events: AsyncIterable<AssistantEvent> | null;
}

export interface CancelOutcome {
  readonly state: AssistantRunState;
  /** True once the worker confirmed that nothing further will be dispatched. */
  readonly acknowledged: boolean;
  readonly metadata: AgentRunMetadataV1;
}

/**
 * Server-side review agent. The model proposes; deterministic code decides.
 * No method here can approve, sign, revoke or supersede anything.
 */
export interface ReviewAgent {
  availability(): Promise<AssistantAvailability>;
  start(request: AssistantRequest, context: StartRunContext): Promise<Result<StartedRun>>;
  /** Owner-bound operational status only: never a prompt, an answer or a tool payload. */
  status(runId: string, ownerId: string): Promise<Result<AgentRunMetadataV1>>;
  cancel(input: CancelRunInput, signal: AbortSignal): Promise<Result<CancelOutcome>>;
}

/** Used when no provider is configured. It reports that and does nothing else. */
export function createUnavailableReviewAgent(
  code: 'NOT_IMPLEMENTED' | 'NOT_CONFIGURED' = 'NOT_CONFIGURED',
): ReviewAgent {
  return {
    availability: () =>
      Promise.resolve({
        schema: 'lexaegis.assistant-availability.v1',
        state: 'not_configured',
        providerScope: null,
        notices: [],
        briefingEnabled: false,
      }),
    start: () => Promise.resolve(unavailable(code, 'The review assistant')),
    status: () => Promise.resolve(unavailable(code, 'The review assistant')),
    cancel: () => Promise.resolve(unavailable(code, 'Run cancellation')),
  };
}
