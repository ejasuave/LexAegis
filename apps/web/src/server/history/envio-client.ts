import 'server-only';
import { z } from 'zod';
import { OPERATIONS, type OperationName } from './queries';
import {
  wireActionSchema,
  wireMetaSchema,
  wireReceiptSchema,
  wireRegistryStateSchema,
  wireSummarySchema,
  type WireAction,
  type WireReceipt,
  type WireRegistryState,
} from './schemas';

export const ENVIO_LIMITS = Object.freeze({
  defaultPageSize: 20,
  maxPageSize: 50,
  maxResponseBytes: 1024 * 1024,
  timeoutMs: 5000,
  transientRetries: 1,
});

export type EnvioFailure =
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'GRAPHQL_ERROR'
  | 'RESPONSE_INVALID';

export type EnvioResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly failure: EnvioFailure };

const fail = (failure: EnvioFailure): { ok: false; failure: EnvioFailure } => ({
  ok: false,
  failure,
});

export interface EnvioConfig {
  readonly url: string;
  /** Sent only as a header to the configured endpoint. Never logged or returned. */
  readonly token?: string;
  /** Hasura admin secret for a local or private service. Header only; never logged or returned. */
  readonly adminSecret?: string;
  readonly fetchFn?: typeof fetch;
}

export type WireMeta = z.infer<typeof wireMetaSchema>;

export interface HistoryMetaRead {
  readonly meta: WireMeta;
  readonly state: WireRegistryState | null;
}

export interface EnvioClient {
  readMeta(signal?: AbortSignal): Promise<EnvioResult<HistoryMetaRead>>;
  readSummary(
    reviewerKey: string,
    signal?: AbortSignal,
  ): Promise<EnvioResult<z.infer<typeof wireSummarySchema> | null>>;
  readActions(
    args: { reviewer: string; upper: string; limit: number },
    signal?: AbortSignal,
  ): Promise<EnvioResult<WireAction[]>>;
  readAnchors(ids: readonly string[], signal?: AbortSignal): Promise<EnvioResult<WireAction[]>>;
  readReceipt(id: string, signal?: AbortSignal): Promise<EnvioResult<WireReceipt | null>>;
  readLink(id: string, signal?: AbortSignal): Promise<EnvioResult<WireReceipt | null>>;
}

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.unknown().optional(),
});

async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > ENVIO_LIMITS.maxResponseBytes) return null;
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ENVIO_LIMITS.maxResponseBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function isAllowedEnvioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Server-only GraphQL client for one configured endpoint. Read-only: it can only send the named
 * operations above. Every failure is typed; none becomes an empty successful result.
 */
export function createEnvioClient(config: EnvioConfig): EnvioClient | null {
  if (!isAllowedEnvioUrl(config.url)) return null;
  const doFetch = config.fetchFn ?? fetch;

  async function once(
    name: OperationName,
    variables: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<EnvioResult<unknown>> {
    const timeout = AbortSignal.timeout(ENVIO_LIMITS.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await doFetch(config.url, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }),
          ...(config.adminSecret === undefined
            ? {}
            : { 'x-hasura-admin-secret': config.adminSecret }),
        },
        body: JSON.stringify({ operationName: name, query: OPERATIONS[name], variables }),
      });
    } catch {
      return fail(timeout.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    if (response.status >= 500) return fail('UNAVAILABLE');
    if (!response.ok) return fail('GRAPHQL_ERROR');
    let text: string | null;
    try {
      text = await readBounded(response);
    } catch {
      return fail(timeout.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    if (text === null) return fail('RESPONSE_TOO_LARGE');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail('RESPONSE_INVALID');
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return fail('RESPONSE_INVALID');
    // Partial data with errors is never accepted.
    if (envelope.data.errors !== undefined) return fail('GRAPHQL_ERROR');
    if (envelope.data.data === undefined || envelope.data.data === null)
      return fail('RESPONSE_INVALID');
    return { ok: true, data: envelope.data.data };
  }

  async function run<T>(
    name: OperationName,
    variables: Record<string, unknown>,
    parse: (data: unknown) => T | null,
    signal: AbortSignal | undefined,
  ): Promise<EnvioResult<T>> {
    let last: EnvioResult<unknown> = fail('UNAVAILABLE');
    for (let attempt = 0; attempt <= ENVIO_LIMITS.transientRetries; attempt += 1) {
      if (signal?.aborted === true) return fail('UNAVAILABLE');
      last = await once(name, variables, signal);
      if (last.ok) {
        const parsed = parse(last.data);
        return parsed === null ? fail('RESPONSE_INVALID') : { ok: true, data: parsed };
      }
      if (last.failure !== 'UNAVAILABLE' && last.failure !== 'TIMEOUT') return last;
    }
    return last;
  }

  const rows = <S extends z.ZodType>(schema: S, max: number) => z.array(schema).max(max);
  const root = z.record(z.string(), z.unknown());

  return {
    readMeta: (signal) =>
      run(
        'HistoryMeta',
        {},
        (data) => {
          const r = root.safeParse(data);
          if (!r.success) return null;
          // Hasura returns _meta as a list with one entry per indexed chain; exactly one is expected.
          const metaRows = z.array(z.unknown()).max(2).safeParse(r.data['_meta']);
          if (!metaRows.success || metaRows.data.length !== 1) return null;
          const meta = wireMetaSchema.safeParse(metaRows.data[0]);
          const states = rows(wireRegistryStateSchema, 2).safeParse(r.data['RegistryState']);
          // More than one registry row means this index is not the one that was configured.
          if (!meta.success || !states.success || states.data.length > 1) return null;
          return { meta: meta.data, state: states.data[0] ?? null };
        },
        signal,
      ),
    readSummary: (id, signal) =>
      run(
        'ReviewerSummary',
        { id },
        (data) => {
          const r = root.safeParse(data);
          if (!r.success) return null;
          const value = r.data['ReviewerSummary_by_pk'];
          if (value === null) return { value: null };
          const parsed = wireSummarySchema.safeParse(value);
          return parsed.success ? { value: parsed.data } : null;
        },
        signal,
      ).then((result) => (result.ok ? { ok: true as const, data: result.data.value } : result)),
    readActions: ({ reviewer, upper, limit }, signal) =>
      run(
        'ReviewerActions',
        {
          reviewer,
          upper,
          limit: Math.min(Math.max(limit, 1), ENVIO_LIMITS.maxPageSize) + 1,
        },
        (data) => {
          const r = root.safeParse(data);
          if (!r.success) return null;
          const parsed = rows(wireActionSchema, ENVIO_LIMITS.maxPageSize + 1).safeParse(
            r.data['IndexedAction'],
          );
          return parsed.success ? parsed.data : null;
        },
        signal,
      ),
    readAnchors: (ids, signal) =>
      run(
        'ActionAnchors',
        { ids: ids.slice(0, 2) },
        (data) => {
          const r = root.safeParse(data);
          if (!r.success) return null;
          const parsed = rows(wireActionSchema, 2).safeParse(r.data['IndexedAction']);
          return parsed.success ? parsed.data : null;
        },
        signal,
      ),
    readReceipt: (id, signal) => receipt('ReceiptDetail', id, signal),
    readLink: (id, signal) => receipt('ReceiptLink', id, signal),
  };

  function receipt(
    name: 'ReceiptDetail' | 'ReceiptLink',
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<EnvioResult<WireReceipt | null>> {
    return run(
      name,
      { id },
      (data) => {
        const r = root.safeParse(data);
        if (!r.success) return null;
        const value = r.data['IndexedReceipt_by_pk'];
        if (value === null) return { value: null };
        const parsed = wireReceiptSchema.safeParse(value);
        return parsed.success ? { value: parsed.data } : null;
      },
      signal,
    ).then((result) => (result.ok ? { ok: true as const, data: result.data.value } : result));
  }
}
