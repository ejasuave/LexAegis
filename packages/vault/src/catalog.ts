import { z } from 'zod';
import { uuidSchema } from '@lexaegis/protocol/v1';
import type { VaultKeys } from './crypto/browser-crypto';
import { CATALOG_SCHEMA, UINT64_MAX, VAULT_LIMITS } from './v1/constants';
import { encodeJcs, parseJsonBytes } from './v1/encoding';
import { err, ok, type VaultResult } from './v1/errors';
import {
  revisionSchema,
  vaultObjectRefSchema,
  type VaultBinding,
  type VaultObjectRefV1,
} from './v1/schemas';
import { digestSchema } from '@lexaegis/protocol/v1';

/*
 * The encrypted catalog is the root of a vault. It lists matters by opaque reference and binds
 * the digest of the catalog before it, forming a revision chain. The chain detects regression
 * against a head already seen in this session. It does NOT prove global freshness: a storage
 * service that replays a complete older snapshot to a client that has lost all local state
 * cannot be detected, and nothing here claims rollback-proof storage.
 */

export const vaultCatalogSchema = z
  .strictObject({
    schema: z.literal(CATALOG_SCHEMA),
    vaultId: uuidSchema,
    revision: revisionSchema,
    previousCatalogDigest: digestSchema.nullable(),
    matters: z
      .array(z.strictObject({ matterId: uuidSchema, matter: vaultObjectRefSchema }))
      .max(VAULT_LIMITS.maxMatters),
  })
  .check((ctx) => {
    if (ctx.issues.length > 0) return;
    const { revision, previousCatalogDigest, matters } = ctx.value;
    const initial = revision === '0';
    if (initial !== (previousCatalogDigest === null)) {
      ctx.issues.push({
        code: 'custom',
        message: 'revision and previous digest disagree',
        input: ctx.value,
        path: ['previousCatalogDigest'],
      });
    }
    if (new Set(matters.map((entry) => entry.matterId)).size !== matters.length) {
      ctx.issues.push({
        code: 'custom',
        message: 'duplicate matter',
        input: ctx.value,
        path: ['matters'],
      });
    }
    const objects = matters.map((entry) => entry.matter.objectId);
    if (new Set(objects).size !== objects.length) {
      ctx.issues.push({
        code: 'custom',
        message: 'duplicate object',
        input: ctx.value,
        path: ['matters'],
      });
    }
  });
export type VaultCatalogV1 = z.infer<typeof vaultCatalogSchema>;

export function emptyCatalog(vaultId: string): VaultCatalogV1 {
  return {
    schema: CATALOG_SCHEMA,
    vaultId,
    revision: '0',
    previousCatalogDigest: null,
    matters: [],
  };
}

/** The next catalog: revision + 1, bound to the digest of the catalog envelope it replaces. */
export function nextCatalog(
  previous: { readonly catalog: VaultCatalogV1; readonly ref: VaultObjectRefV1 },
  matters: VaultCatalogV1['matters'],
): VaultResult<VaultCatalogV1> {
  const revision = BigInt(previous.catalog.revision) + 1n;
  if (revision > UINT64_MAX) return err('INVALID_INPUT');
  const next = {
    schema: CATALOG_SCHEMA,
    vaultId: previous.catalog.vaultId,
    revision: revision.toString(),
    previousCatalogDigest: previous.ref.envelopeSha256,
    matters,
  } as const;
  const parsed = vaultCatalogSchema.safeParse(next);
  return parsed.success
    ? ok(parsed.data)
    : err(matters.length > VAULT_LIMITS.maxMatters ? 'QUOTA' : 'INVALID_INPUT');
}

export async function sealCatalog(keys: VaultKeys, binding: VaultBinding, catalog: VaultCatalogV1) {
  const encoded = encodeJcs(vaultCatalogSchema.parse(catalog), VAULT_LIMITS.maxStructuredBytes);
  if (!encoded.ok) return encoded;
  return keys.encrypt(binding, encoded.data, 'structured');
}

/**
 * Authenticates and decrypts a catalog, then checks it against what the server claimed: the
 * vault ID, the head revision and the previous-catalog digest.
 */
export async function openCatalog(
  keys: VaultKeys,
  binding: VaultBinding,
  envelopeBytes: Uint8Array,
  expected: { readonly ref: VaultObjectRefV1; readonly revision: string },
): Promise<VaultResult<VaultCatalogV1>> {
  const plaintext = await keys.decrypt(
    envelopeBytes,
    { ...binding, ref: expected.ref },
    'structured',
  );
  if (!plaintext.ok) return plaintext;
  const parsed = parseJsonBytes(plaintext.data, VAULT_LIMITS.maxStructuredBytes);
  plaintext.data.fill(0);
  if (!parsed.ok) return err('INTEGRITY');
  const catalog = vaultCatalogSchema.safeParse(parsed.data);
  if (!catalog.success) return err('INTEGRITY');
  if (catalog.data.vaultId !== binding.vaultId || catalog.data.revision !== expected.revision)
    return err('INTEGRITY');
  return ok(catalog.data);
}

/** A head older than one already observed in this session is a regression and must not be shown as current. */
export function isRegression(observedRevision: string | null, candidateRevision: string): boolean {
  return observedRevision !== null && BigInt(candidateRevision) < BigInt(observedRevision);
}
