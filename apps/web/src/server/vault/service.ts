import { artifactDigest } from '@lexaegis/protocol/v1';
import {
  ACCOUNT_PROFILE_ID,
  CRYPTO_PROFILE,
  DESCRIPTOR_SCHEMA,
  VAULT_LIMITS,
  decodeEnvelope,
  encodeEnvelope,
  referenceOf,
  vaultObjectRefSchema,
  type VaultHeadV1,
  type VaultObjectRefV1,
} from '@lexaegis/vault/v1';
import { z } from 'zod';
import {
  createRequestSchema,
  discoveryResponseSchema,
  putHeadRequestSchema,
  putObjectResponseSchema,
  type VaultApiErrorCode,
  type VaultView,
} from '@/lib/vault-schema';
import {
  ObjectStoreError,
  objectKey,
  probeConditionalCreate,
  type ObjectStore,
} from './object-store';
import type { HeadRow, VaultRepository, VaultRow } from './repository';

/*
 * Vault storage operations, independent of HTTP so they are tested directly and against real
 * PostgreSQL and an S3-compatible server. Ownership comes only from the authenticated session
 * address and the database, never from a body, header or path value. An unknown vault, an
 * unknown object and another account's are indistinguishable.
 */

export interface VaultServiceDeps {
  readonly repo: VaultRepository | null;
  readonly objects: ObjectStore | null;
  /** The configured relying-party ID; vault descriptors must match it exactly. */
  readonly rpId: string | null;
  readonly now: () => Date;
  readonly randomId: () => string;
  /** Shared-store rate limit: true while under `limit` in the window. */
  readonly allow: (bucket: string, windowStart: Date, limit: number) => Promise<boolean>;
}

export type VaultReply =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'bytes'; readonly status: 200; readonly bytes: Uint8Array };

const ERROR_STATUS: Record<VaultApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA: 413,
  TOO_LARGE: 413,
  INVALID: 400,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
  UNAVAILABLE: 503,
  UNCERTAIN: 503,
  MISSING: 404,
  CORRUPT: 502,
};

const CATALOG_WIRE_LIMIT = Math.ceil((VAULT_LIMITS.maxStructuredBytes * 4) / 3) + 8192;
const MAX_CONCURRENT_UPLOADS = 4;
const MINUTE = 60_000;
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export function createVaultService(deps: VaultServiceDeps) {
  const fail = (code: VaultApiErrorCode, requestId: string, extra: object = {}): VaultReply => ({
    kind: 'json',
    status: ERROR_STATUS[code],
    body: { ok: false, error: { code, requestId }, ...extra },
  });
  const json = (status: number, body: unknown): VaultReply => ({ kind: 'json', status, body });

  let capability: Promise<boolean> | undefined;
  let uploading = 0;

  /** Verified once per process: the provider really refuses to overwrite. Otherwise no writes. */
  async function conditionalCreateWorks(): Promise<boolean> {
    if (deps.objects === null) return false;
    capability ??= probeConditionalCreate(deps.objects, deps.randomId).then((works) => {
      // A failed probe may be transient: allow another attempt next time.
      if (!works) capability = undefined;
      return works;
    });
    return capability;
  }

  const windowStart = (now: Date) => new Date(Math.floor(now.getTime() / MINUTE) * MINUTE);

  async function guard(
    address: string,
    kind: 'read' | 'write',
    requestId: string,
  ): Promise<VaultReply | null> {
    if (deps.repo === null || deps.objects === null || deps.rpId === null) {
      return fail('NOT_CONFIGURED', requestId);
    }
    const allowed = await deps.allow(
      `vault:${kind}:${address}`,
      windowStart(deps.now()),
      kind === 'read' ? 600 : 240,
    );
    return allowed ? null : fail('RATE_LIMITED', requestId);
  }

  const toView = (vault: VaultRow, head: HeadRow): VaultView => ({
    descriptor: {
      schema: DESCRIPTOR_SCHEMA,
      vaultId: vault.vaultId,
      ownerAddress: vault.ownerAddress,
      rpId: vault.rpId,
      accountProfileId: ACCOUNT_PROFILE_ID,
      cryptoProfileId: CRYPTO_PROFILE,
    },
    head: toHead(head),
  });
  const toHead = (head: HeadRow): VaultHeadV1 => ({
    revision: head.revision,
    catalog: {
      objectId: head.catalog.objectId,
      envelopeSha256: head.catalog.sha256,
      envelopeByteLength: head.catalog.byteLength,
    },
  });

  /** Stores exact bytes immutably and marks the object ready only after reading them back. */
  async function storeVerified(
    vaultId: string,
    ref: VaultObjectRefV1,
    wire: Uint8Array,
    repo: VaultRepository,
    objects: ObjectStore,
  ) {
    const key = objectKey(vaultId, ref.objectId);
    const outcome = await objects.putIfAbsent(key, wire);
    // Whether we created it or it was already there, the stored bytes must be exactly these.
    const stored = await objects.get(key);
    if (stored === null) throw new ObjectStoreError('UNCERTAIN');
    const same =
      stored.byteLength === wire.byteLength &&
      (await artifactDigest(stored)) === ref.envelopeSha256;
    if (!same) return 'conflict' as const;
    await repo.markReady(vaultId, ref.objectId, deps.now());
    return outcome === 'created' ? ('created' as const) : ('duplicate' as const);
  }

  async function withUploadSlot<T>(
    requestId: string,
    work: () => Promise<T>,
  ): Promise<T | VaultReply> {
    if (uploading >= MAX_CONCURRENT_UPLOADS) return fail('RATE_LIMITED', requestId);
    uploading += 1;
    try {
      return await work();
    } finally {
      uploading -= 1;
    }
  }

  const translate = (error: unknown, requestId: string): VaultReply => {
    if (error instanceof ObjectStoreError)
      return fail(error.kind === 'UNCERTAIN' ? 'UNCERTAIN' : 'UNAVAILABLE', requestId);
    throw error;
  };

  return {
    /** The account's vault, or explicit absence. An outage is never reported as absence. */
    async discover(address: string, requestId: string): Promise<VaultReply> {
      const blocked = await guard(address, 'read', requestId);
      if (blocked !== null) return blocked;
      const { repo, rpId } = deps;
      if (repo === null || rpId === null) return fail('NOT_CONFIGURED', requestId);
      const vault = await repo.findReady(address, rpId, ACCOUNT_PROFILE_ID);
      if (vault === null) return json(200, discoveryResponseSchema.parse({ vault: null }));
      const head = await repo.getHead(vault.vaultId);
      if (head === null) return fail('UNAVAILABLE', requestId);
      return json(200, discoveryResponseSchema.parse({ vault: toView(vault, head) }));
    },

    /** Creates the descriptor and its encrypted initial catalog. Never overwrites an existing vault. */
    async create(address: string, bodyBytes: Uint8Array, requestId: string): Promise<VaultReply> {
      const blocked = await guard(address, 'write', requestId);
      if (blocked !== null) return blocked;
      const { repo, objects, rpId } = deps;
      if (repo === null || objects === null || rpId === null)
        return fail('NOT_CONFIGURED', requestId);
      if (!(await conditionalCreateWorks())) return fail('UNAVAILABLE', requestId);

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes));
      } catch {
        return fail('INVALID', requestId);
      }
      const request = createRequestSchema.safeParse(parsedBody);
      if (!request.success) return fail('INVALID', requestId);
      const { descriptor, catalog } = request.data;
      const { header } = catalog;
      if (
        descriptor.ownerAddress !== address ||
        descriptor.rpId !== rpId ||
        header.vaultId !== descriptor.vaultId ||
        header.ownerAddress !== descriptor.ownerAddress ||
        header.rpId !== descriptor.rpId
      ) {
        return fail('INVALID', requestId);
      }
      const wire = encodeEnvelope(catalog);
      if (!wire.ok || wire.data.byteLength > CATALOG_WIRE_LIMIT)
        return fail('TOO_LARGE', requestId);
      const ref = await referenceOf(header.objectId, wire.data);

      const begun = await repo.beginCreate(
        {
          vaultId: descriptor.vaultId,
          ownerAddress: address,
          rpId,
          accountProfileId: ACCOUNT_PROFILE_ID,
          now: deps.now(),
        },
        { objectId: ref.objectId, sha256: ref.envelopeSha256, byteLength: wire.data.byteLength },
      );
      // Someone (possibly another device) already created this account's vault: recover, never replace.
      if (begun.kind === 'exists' || begun.kind === 'conflict') return fail('CONFLICT', requestId);

      try {
        const stored = await withUploadSlot(requestId, () =>
          storeVerified(descriptor.vaultId, ref, wire.data, repo, objects),
        );
        if (typeof stored !== 'string') return stored;
        if (stored === 'conflict') return fail('CONFLICT', requestId);
        await repo.completeCreate(descriptor.vaultId, ref.objectId, deps.now());
      } catch (error) {
        return translate(error, requestId);
      }
      const vault = await repo.getOwned(descriptor.vaultId, address);
      const head = await repo.getHead(descriptor.vaultId);
      return vault === null || head === null
        ? fail('UNAVAILABLE', requestId)
        : json(201, toView(vault, head));
    },

    async getHead(address: string, vaultId: string, requestId: string): Promise<VaultReply> {
      const blocked = await guard(address, 'read', requestId);
      if (blocked !== null) return blocked;
      const { repo } = deps;
      if (repo === null || !uuid.safeParse(vaultId).success) return fail('NOT_FOUND', requestId);
      const vault = await repo.getOwned(vaultId, address);
      const head = vault === null ? null : await repo.getHead(vaultId);
      return head === null ? fail('NOT_FOUND', requestId) : json(200, toHead(head));
    },

    /** Compare-and-swap to an uploaded catalog. A conflict returns the head that won; nothing is overwritten. */
    async putHead(
      address: string,
      vaultId: string,
      bodyBytes: Uint8Array,
      requestId: string,
    ): Promise<VaultReply> {
      const blocked = await guard(address, 'write', requestId);
      if (blocked !== null) return blocked;
      const { repo } = deps;
      if (repo === null || !uuid.safeParse(vaultId).success) return fail('NOT_FOUND', requestId);
      // Ownership first: another account's vault answers like an unknown one, whatever the body says.
      if ((await repo.getOwned(vaultId, address)) === null) return fail('NOT_FOUND', requestId);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes));
      } catch {
        return fail('INVALID', requestId);
      }
      const request = putHeadRequestSchema.safeParse(body);
      if (!request.success) return fail('INVALID', requestId);

      const { expectedRevision, catalog } = request.data;
      const stored = await repo.getObject(vaultId, catalog.objectId);
      if (stored === null || stored.state !== 'ready') return fail('INVALID', requestId);
      if (
        stored.sha256 !== catalog.envelopeSha256 ||
        stored.byteLength !== catalog.envelopeByteLength
      ) {
        return fail('INVALID', requestId);
      }
      const outcome = await repo.swapHead(vaultId, expectedRevision, catalog.objectId, deps.now());
      const head = await repo.getHead(vaultId);
      if (head === null) return fail('UNAVAILABLE', requestId);
      if (outcome === 'ok' || outcome === 'already_applied') return json(200, toHead(head));
      return fail('CONFLICT', requestId, { head: toHead(head) });
    },

    async getObject(
      address: string,
      vaultId: string,
      objectId: string,
      requestId: string,
    ): Promise<VaultReply> {
      const blocked = await guard(address, 'read', requestId);
      if (blocked !== null) return blocked;
      const { repo, objects } = deps;
      if (
        repo === null ||
        objects === null ||
        !uuid.safeParse(vaultId).success ||
        !uuid.safeParse(objectId).success
      ) {
        return fail('NOT_FOUND', requestId);
      }
      if ((await repo.getOwned(vaultId, address)) === null) return fail('NOT_FOUND', requestId);
      const row = await repo.getObject(vaultId, objectId);
      if (row === null || row.state !== 'ready') return fail('NOT_FOUND', requestId);
      let bytes: Uint8Array | null;
      try {
        bytes = await objects.get(objectKey(vaultId, objectId));
      } catch (error) {
        return translate(error, requestId);
      }
      // An owned, recorded object that storage no longer has is MISSING; one whose bytes no
      // longer match the recorded digest is CORRUPT. Neither is ever reported as an unknown ID,
      // and an unreachable store (above) is an outage, never "not found".
      if (bytes === null) return fail('MISSING', requestId);
      if (
        (await artifactDigest(bytes)) !== row.sha256 ||
        String(bytes.byteLength) !== row.byteLength
      ) {
        return fail('CORRUPT', requestId);
      }
      return { kind: 'bytes', status: 200, bytes };
    },

    /** One immutable envelope. Exact retries succeed; changed bytes under a used ID fail. */
    async putObject(
      address: string,
      vaultId: string,
      objectId: string,
      bytes: Uint8Array,
      requestId: string,
    ): Promise<VaultReply> {
      const blocked = await guard(address, 'write', requestId);
      if (blocked !== null) return blocked;
      const { repo, objects } = deps;
      if (repo === null || objects === null) return fail('NOT_CONFIGURED', requestId);
      if (!uuid.safeParse(vaultId).success || !uuid.safeParse(objectId).success)
        return fail('NOT_FOUND', requestId);
      const vault = await repo.getOwned(vaultId, address);
      if (vault === null) return fail('NOT_FOUND', requestId);
      if (!(await conditionalCreateWorks())) return fail('UNAVAILABLE', requestId);

      const envelope = decodeEnvelope(bytes);
      if (!envelope.ok)
        return fail(envelope.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID', requestId);
      const { header } = envelope.data;
      if (
        header.objectId !== objectId ||
        header.vaultId !== vault.vaultId ||
        header.ownerAddress !== vault.ownerAddress ||
        header.rpId !== vault.rpId
      ) {
        return fail('INVALID', requestId);
      }
      const ref = vaultObjectRefSchema.parse(await referenceOf(objectId, bytes));
      const reserved = await repo.reserveObject(
        vaultId,
        { objectId, sha256: ref.envelopeSha256, byteLength: bytes.byteLength },
        deps.now(),
      );
      if (reserved === 'quota') return fail('QUOTA', requestId);
      if (reserved === 'conflict') return fail('CONFLICT', requestId);

      try {
        const stored = await withUploadSlot(requestId, () =>
          storeVerified(vaultId, ref, bytes, repo, objects),
        );
        if (typeof stored !== 'string') return stored;
        if (stored === 'conflict') return fail('CONFLICT', requestId);
      } catch (error) {
        return translate(error, requestId);
      }
      return json(200, putObjectResponseSchema.parse({ ref }));
    },
  };
}

export type VaultService = ReturnType<typeof createVaultService>;
