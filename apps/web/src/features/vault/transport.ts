import { type z } from 'zod';
import {
  vaultHeadSchema,
  vaultObjectRefSchema,
  type VaultDescriptorV1,
  type VaultHeadV1,
  type VaultObjectRefV1,
} from '@lexaegis/vault/v1';
import {
  type VAULT_API_ERROR_CODES,
  discoveryResponseSchema,
  putObjectResponseSchema,
  vaultErrorBodySchema,
  vaultViewSchema,
  type VaultView,
} from '@/lib/vault-schema';
import { REQUEST_HEADER } from '@/lib/auth-schema';

/*
 * Typed browser transport for the vault routes. It sends and receives ciphertext and public
 * metadata only. A network failure on a write is reported as NETWORK: the write may have
 * committed, so the controller reconciles from the authoritative head instead of assuming.
 */

export type TransportFailure = (typeof VAULT_API_ERROR_CODES)[number] | 'NETWORK' | 'MALFORMED';

export type TransportResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: TransportFailure; readonly head?: VaultHeadV1 };

export interface VaultTransport {
  discover(signal?: AbortSignal): Promise<TransportResult<VaultView | null>>;
  create(
    descriptor: VaultDescriptorV1,
    catalogBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<TransportResult<VaultView>>;
  getHead(vaultId: string, signal?: AbortSignal): Promise<TransportResult<VaultHeadV1>>;
  putHead(
    vaultId: string,
    expectedRevision: string,
    catalog: VaultObjectRefV1,
    signal?: AbortSignal,
  ): Promise<TransportResult<VaultHeadV1>>;
  getObject(
    vaultId: string,
    objectId: string,
    signal?: AbortSignal,
  ): Promise<TransportResult<Uint8Array>>;
  putObject(
    vaultId: string,
    objectId: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<TransportResult<VaultObjectRefV1>>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'content-type': 'application/json', [REQUEST_HEADER]: '1' };

async function failureOf(response: Response): Promise<TransportResult<never>> {
  try {
    const body = vaultErrorBodySchema.safeParse(await response.json());
    if (body.success) {
      return {
        ok: false,
        code: body.data.error.code,
        ...(body.data.head !== undefined && { head: body.data.head }),
      };
    }
  } catch {
    // Fall through to the status.
  }
  if (response.status === 401) return { ok: false, code: 'UNAUTHENTICATED' };
  return { ok: false, code: response.status >= 500 ? 'UNAVAILABLE' : 'MALFORMED' };
}

export function createVaultTransport(
  fetcher: Fetch = (input, init) => fetch(input, init),
): VaultTransport {
  async function request<T>(
    path: string,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<TransportResult<T>> {
    let response: Response;
    try {
      response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', ...init });
    } catch {
      return { ok: false, code: 'NETWORK' };
    }
    if (!response.ok) return failureOf(response);
    try {
      const data = await parse(response);
      return data === null ? { ok: false, code: 'MALFORMED' } : { ok: true, data };
    } catch {
      return { ok: false, code: 'MALFORMED' };
    }
  }
  const parsedJson =
    <S extends z.ZodType>(schema: S) =>
    async (response: Response): Promise<z.infer<S> | null> => {
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    };
  const withSignal = (signal: AbortSignal | undefined): RequestInit =>
    signal === undefined ? {} : { signal };
  const enc = encodeURIComponent;

  return {
    discover: (signal) =>
      request('/api/vault', { method: 'GET', ...withSignal(signal) }, async (response) => {
        const parsed = discoveryResponseSchema.safeParse(await response.json());
        // `undefined` marks an unparseable body, `null` explicit absence.
        return parsed.success ? { vault: parsed.data.vault } : null;
      }).then((result) => (result.ok ? { ok: true as const, data: result.data.vault } : result)),

    create: (descriptor, catalogBytes, signal) => {
      const body = `{"descriptor":${JSON.stringify(descriptor)},"catalog":${new TextDecoder().decode(catalogBytes)}}`;
      return request(
        '/api/vault',
        { method: 'POST', headers: JSON_HEADERS, body, ...withSignal(signal) },
        parsedJson(vaultViewSchema),
      );
    },

    getHead: (vaultId, signal) =>
      request(
        `/api/vault/${enc(vaultId)}/head`,
        { method: 'GET', ...withSignal(signal) },
        parsedJson(vaultHeadSchema),
      ),

    putHead: (vaultId, expectedRevision, catalog, signal) =>
      request(
        `/api/vault/${enc(vaultId)}/head`,
        {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ expectedRevision, catalog: vaultObjectRefSchema.parse(catalog) }),
          ...withSignal(signal),
        },
        parsedJson(vaultHeadSchema),
      ),

    getObject: (vaultId, objectId, signal) =>
      request(
        `/api/vault/${enc(vaultId)}/objects/${enc(objectId)}`,
        { method: 'GET', ...withSignal(signal) },
        async (response) => {
          return new Uint8Array(await response.arrayBuffer());
        },
      ),

    putObject: (vaultId, objectId, bytes, signal) =>
      request(
        `/api/vault/${enc(vaultId)}/objects/${enc(objectId)}`,
        { method: 'PUT', headers: JSON_HEADERS, body: bytes as BodyInit, ...withSignal(signal) },
        async (response) => {
          const parsed = putObjectResponseSchema.safeParse(await response.json());
          return parsed.success ? parsed.data.ref : null;
        },
      ),
  };
}
