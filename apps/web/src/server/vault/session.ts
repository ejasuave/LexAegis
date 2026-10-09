import 'server-only';
import { createApplicationError } from '@lexaegis/protocol';
import { randomUUID } from 'node:crypto';
import { loadPublicConfig, readPublicEnv } from '@/config/public';
import { vaultErrorBodySchema } from '@/lib/vault-schema';
import { getAuthService, requireAccountSession } from '../auth/session';
import { AUTH_BODY_LIMIT, readGuardedBytes } from '../auth/request-guard';
import { createPostgresAuthStore } from '../auth/store';
import { getPool } from '../db/pool';
import { errorResponse, jsonResponse } from '../http';
import { loadServerConfig } from '../env';
import { createS3ObjectStore, type ObjectStore } from './object-store';
import { createPostgresVaultRepository } from './repository';
import { createVaultService, type VaultReply, type VaultService } from './service';

/** The 16 MiB limit for ciphertext objects and the initial catalog. Control JSON stays at 16 KiB. */
export const OBJECT_BODY_LIMIT = 16 * 1024 * 1024;

let service: VaultService | undefined;

function buildObjectStore(): ObjectStore | null {
  const loaded = loadServerConfig(process.env);
  if (!loaded.ok) return null;
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = loaded.config.storage;
  if (
    endpoint === undefined ||
    bucket === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    return null;
  }
  return createS3ObjectStore({ endpoint, bucket, region, accessKeyId, secretAccessKey });
}

/** Missing database, storage or relying-party configuration yields NOT_CONFIGURED; there is no in-process fallback. */
export function getVaultService(): VaultService {
  if (service === undefined) {
    const pool = getPool();
    const publicConfig = loadPublicConfig(readPublicEnv());
    const auth = pool === null ? null : createPostgresAuthStore(pool);
    service = createVaultService({
      repo: pool === null ? null : createPostgresVaultRepository(pool),
      objects: buildObjectStore(),
      rpId: publicConfig.ok ? (publicConfig.config.webauthnRpId ?? null) : null,
      now: () => new Date(),
      randomId: () => randomUUID(),
      allow: (bucket, windowStart, limit) =>
        auth === null ? Promise.resolve(false) : auth.allow(bucket, windowStart, limit),
    });
  }
  return service;
}

export function replyResponse(reply: VaultReply, requestId: string): Response {
  if (reply.kind === 'bytes') {
    return new Response(reply.bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId,
      },
    });
  }
  // Closed error bodies only: nothing from the private request is echoed.
  const body = reply.status >= 400 ? vaultErrorBodySchema.parse(reply.body) : reply.body;
  return jsonResponse(body, reply.status, requestId);
}

/** Authenticates, applies the Chapter 4 request protections to a write, and reads the bounded body. */
export async function authorizedWrite(
  request: Request,
  requestId: string,
  limit: number = AUTH_BODY_LIMIT,
): Promise<{ address: string; bytes: Uint8Array } | Response> {
  const session = await requireAccountSession(request);
  if (!session.ok)
    return errorResponse(
      session.error.code === 'UNAUTHENTICATED'
        ? { ...session.error, requestId }
        : { ...session.error, requestId },
    );
  const { origin } = getAuthService();
  if (origin === null) {
    return errorResponse(
      createApplicationError('NOT_CONFIGURED', 'Account sign-in is not configured.', requestId),
    );
  }
  const guarded = await readGuardedBytes(request, origin, limit);
  if (!guarded.ok) {
    return errorResponse(
      createApplicationError(
        guarded.reason === 'ORIGIN' || guarded.reason === 'HEADER' ? 'FORBIDDEN' : 'INVALID_INPUT',
        'The request was not accepted.',
        requestId,
      ),
    );
  }
  return { address: session.data.address, bytes: guarded.bytes };
}

export async function authorizedRead(
  request: Request,
  requestId: string,
): Promise<{ address: string } | Response> {
  const session = await requireAccountSession(request);
  if (!session.ok) return errorResponse({ ...session.error, requestId });
  return { address: session.data.address };
}
