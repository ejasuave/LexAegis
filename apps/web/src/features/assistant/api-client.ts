import { z } from 'zod';
import { applicationErrorSchema } from '@lexaegis/protocol';
import {
  agentRunMetadataSchema,
  assistantAvailabilitySchema,
  assistantRunStateSchema,
  type AgentRunMetadataV1,
  type AssistantAvailability,
  type AssistantRequest,
  type AssistantRunState,
} from '@lexaegis/agent/contracts';
import { readSse, type SseItem } from './sse-reader';

/*
 * The authenticated runtime client. Same-origin requests with the session cookie; a start request
 * is a POST whose response is consumed as server-sent events. Private data goes in the body,
 * never in a URL or query string, and nothing here writes to browser storage.
 */

export type TransportFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly reason: string | null;
};

export type StartResult =
  | { readonly kind: 'stream'; readonly events: AsyncIterable<SseItem> }
  | { readonly kind: 'repeated'; readonly metadata: AgentRunMetadataV1 }
  | ({ readonly kind: 'error' } & Omit<TransportFailure, 'ok'>);

export interface AssistantTransport {
  availability(): Promise<{ ok: true; availability: AssistantAvailability } | TransportFailure>;
  start(request: AssistantRequest, signal: AbortSignal): Promise<StartResult>;
  cancel(
    runId: string,
  ): Promise<{ ok: true; state: AssistantRunState; acknowledged: boolean } | TransportFailure>;
  status(runId: string): Promise<{ ok: true; metadata: AgentRunMetadataV1 } | TransportFailure>;
}

const failureSchema = z.object({
  error: applicationErrorSchema,
  reason: z.string().max(60).optional(),
});
const UNREACHABLE: TransportFailure = {
  ok: false,
  code: 'UNAVAILABLE',
  message: 'The assistant service could not be reached.',
  reason: null,
};

async function failureOf(response: Response): Promise<TransportFailure> {
  try {
    const parsed = failureSchema.safeParse(await response.json());
    if (parsed.success) {
      return {
        ok: false,
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        reason: parsed.data.reason ?? null,
      };
    }
  } catch {
    // Fall through: an unreadable error body is reported as unreachable, never guessed at.
  }
  return UNREACHABLE;
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-lexaegis-request': '1' };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createAssistantTransport(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): AssistantTransport {
  const common: RequestInit = { credentials: 'same-origin', cache: 'no-store' };
  return {
    async availability() {
      try {
        const response = await fetchImpl('/api/assistant', common);
        if (!response.ok) return await failureOf(response);
        const parsed = z
          .object({ availability: assistantAvailabilitySchema })
          .safeParse(await response.json());
        return parsed.success ? { ok: true, availability: parsed.data.availability } : UNREACHABLE;
      } catch {
        return UNREACHABLE;
      }
    },

    async start(request, signal) {
      let response: Response;
      try {
        response = await fetchImpl('/api/assistant/runs', {
          ...common,
          method: 'POST',
          headers: { ...WRITE_HEADERS, accept: 'text/event-stream' },
          body: JSON.stringify(request),
          signal,
        });
      } catch {
        return {
          kind: 'error',
          code: UNREACHABLE.code,
          message: UNREACHABLE.message,
          reason: null,
        };
      }
      if (!response.ok) {
        const { ok: _ok, ...failure } = await failureOf(response);
        return { kind: 'error', ...failure };
      }
      if ((response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        return response.body === null
          ? { kind: 'error', code: UNREACHABLE.code, message: UNREACHABLE.message, reason: null }
          : { kind: 'stream', events: readSse(response.body) };
      }
      const repeated = z
        .object({ repeated: z.literal(true), metadata: agentRunMetadataSchema })
        .safeParse(await response.json().catch(() => null));
      return repeated.success
        ? { kind: 'repeated', metadata: repeated.data.metadata }
        : { kind: 'error', code: UNREACHABLE.code, message: UNREACHABLE.message, reason: null };
    },

    async cancel(runId) {
      try {
        const response = await fetchImpl(
          `/api/assistant/runs/${encodeURIComponent(runId)}/cancel`,
          {
            ...common,
            method: 'POST',
            headers: WRITE_HEADERS,
            body: '{}',
          },
        );
        if (!response.ok) return await failureOf(response);
        const parsed = z
          .object({ state: assistantRunStateSchema, acknowledged: z.boolean() })
          .safeParse(await response.json());
        return parsed.success ? { ok: true, ...parsed.data } : UNREACHABLE;
      } catch {
        return UNREACHABLE;
      }
    },

    async status(runId) {
      try {
        const response = await fetchImpl(
          `/api/assistant/runs/${encodeURIComponent(runId)}`,
          common,
        );
        if (!response.ok) return await failureOf(response);
        const parsed = z
          .object({ metadata: agentRunMetadataSchema })
          .safeParse(await response.json());
        return parsed.success ? { ok: true, metadata: parsed.data.metadata } : UNREACHABLE;
      } catch {
        return UNREACHABLE;
      }
    },
  };
}
