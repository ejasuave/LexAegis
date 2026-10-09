import type { QuoteInput } from '@/features/account/public';

/*
 * Same-origin client for /api/chain. Requests carry the X-LexAegis-Request header the server
 * requires; responses are parsed defensively. No RPC URL, key or signature-bearing log lives here.
 */

export type PublicRequest =
  | { readonly kind: 'execute'; readonly action: unknown; readonly packageReference: unknown }
  | { readonly kind: 'invalidate_nonce'; readonly expectedNonce: string };

export type Phase =
  | 'reserved'
  | 'quoted'
  | 'submitting'
  | 'submitted'
  | 'pending'
  | 'included'
  | 'confirmed'
  | 'reverted'
  | 'replaced'
  | 'unknown'
  | 'cancelled';

export interface OperationView {
  readonly operationId: string;
  readonly kind: 'execute' | 'invalidate_nonce';
  readonly phase: Phase;
  readonly account: string;
  readonly commitment: string | null;
  readonly registryNonce: string;
  readonly transactionNonce: string | null;
  readonly transactionHash: string | null;
  readonly blockNumber: string | null;
  readonly chargedFeeWei: string | null;
  readonly executedViaAnotherTransaction: boolean;
}

export type ApiOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: string; readonly network: boolean };

export interface ChainApi {
  create(
    idempotencyKey: string,
    request: PublicRequest,
  ): Promise<ApiOutcome<{ operation: OperationView }>>;
  quote(
    operationId: string,
    request: PublicRequest,
    signature: string | null,
  ): Promise<ApiOutcome<{ quote: QuoteInput & Record<string, unknown>; operation: OperationView }>>;
  submit(
    operationId: string,
    body: { request: PublicRequest; quote: unknown; signedTransaction: string },
  ): Promise<ApiOutcome<{ operation: OperationView; transactionHash: string }>>;
  refresh(
    operationId: string,
    request: PublicRequest,
  ): Promise<ApiOutcome<{ operation: OperationView }>>;
  listUnresolved(): Promise<ApiOutcome<{ operations: OperationView[] }>>;
}

async function call<T>(
  fetchFn: typeof fetch,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiOutcome<T>> {
  try {
    const response = await fetchFn(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-lexaegis-request': '1' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await response.json().catch(() => null)) as {
      ok?: boolean;
      reason?: string;
      error?: { code?: string };
    } | null;
    if (response.ok && json?.ok === true) return { ok: true, data: json as T };
    return { ok: false, reason: json?.reason ?? json?.error?.code ?? 'REJECTED', network: false };
  } catch {
    // The request may or may not have reached the server.
    return { ok: false, reason: 'NETWORK', network: true };
  }
}

export function createChainApi(fetchFn: typeof fetch = fetch): ChainApi {
  return {
    create: (idempotencyKey, request) =>
      call(fetchFn, 'POST', '/api/chain/operations', { idempotencyKey, request }),
    quote: (id, request, signature) =>
      call(fetchFn, 'POST', `/api/chain/operations/${id}/quote`, { request, signature }),
    submit: (id, body) => call(fetchFn, 'POST', `/api/chain/operations/${id}/submit`, body),
    refresh: (id, request) => call(fetchFn, 'POST', `/api/chain/operations/${id}`, { request }),
    listUnresolved: () => call(fetchFn, 'GET', '/api/chain/operations'),
  };
}
