import {
  historyHealthSchema,
  historyPageSchema,
  historyResetSchema,
  receiptHistorySchema,
  type HistoryHealth,
  type HistoryPage,
  type HistoryReset,
  type ReceiptHistory,
} from '@/domain/history/response';

/*
 * Browser client for the read-only /api/history routes. Every response is validated against a
 * closed schema; a failure is a typed result, never an empty list. Requests carry no credentials
 * and never include a private matter title, document label or any vault-derived value.
 */

export type HistoryFailure = 'unavailable' | 'invalid_response' | 'rate_limited' | 'rejected';

export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'reset'; readonly reset: HistoryReset }
  | { readonly kind: 'unavailable'; readonly health: HistoryHealth | null }
  | { readonly kind: 'failed'; readonly failure: HistoryFailure };

export interface HistoryApi {
  status(signal?: AbortSignal): Promise<ApiResult<HistoryHealth>>;
  page(
    reviewer: string,
    options: { readonly cursor: string | null; readonly limit: number },
    signal?: AbortSignal,
  ): Promise<ApiResult<HistoryPage>>;
  receipt(
    reviewer: string,
    commitment: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<ReceiptHistory>>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function healthOf(body: unknown): HistoryHealth | null {
  if (typeof body !== 'object' || body === null || !('health' in body)) return null;
  const parsed = historyHealthSchema.safeParse(body.health);
  return parsed.success ? parsed.data : null;
}

export function createHistoryApi(
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): HistoryApi {
  async function get<T>(
    path: string,
    parse: (body: unknown) => T | null,
    signal: AbortSignal | undefined,
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchFn(path, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return { kind: 'failed', failure: 'unavailable' };
    }
    const body = await readJson(response);
    if (response.status === 409) {
      const reset = historyResetSchema.safeParse(body);
      return reset.success
        ? { kind: 'reset', reset: reset.data }
        : { kind: 'failed', failure: 'invalid_response' };
    }
    if (response.status === 429) return { kind: 'failed', failure: 'rate_limited' };
    if (response.status === 400) return { kind: 'failed', failure: 'rejected' };
    if (response.status === 503) return { kind: 'unavailable', health: healthOf(body) };
    if (!response.ok) return { kind: 'failed', failure: 'unavailable' };
    const value = parse(body);
    return value === null ? { kind: 'failed', failure: 'invalid_response' } : { kind: 'ok', value };
  }

  return {
    status: (signal) =>
      get(
        '/api/history/status',
        (body) => {
          const parsed = historyHealthSchema.safeParse(
            typeof body === 'object' && body !== null
              ? (body as { health?: unknown }).health
              : null,
          );
          return parsed.success ? parsed.data : null;
        },
        signal,
      ),
    page: (reviewer, { cursor, limit }, signal) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) params.set('cursor', cursor);
      return get(
        `/api/history/reviewers/${reviewer}?${params.toString()}`,
        (body) => {
          if (typeof body !== 'object' || body === null) return null;
          const { ok: _ok, ...rest } = body as Record<string, unknown>;
          const parsed = historyPageSchema.safeParse(rest);
          return parsed.success ? parsed.data : null;
        },
        signal,
      );
    },
    receipt: (reviewer, commitment, signal) =>
      get(
        `/api/history/receipts/${reviewer}/${commitment}`,
        (body) => {
          if (typeof body !== 'object' || body === null) return null;
          const { ok: _ok, ...rest } = body as Record<string, unknown>;
          const parsed = receiptHistorySchema.safeParse(rest);
          return parsed.success ? parsed.data : null;
        },
        signal,
      ),
  };
}
