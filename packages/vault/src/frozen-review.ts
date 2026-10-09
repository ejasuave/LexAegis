import { z } from 'zod';
import {
  PreparedReviewPackage,
  canonicalizeReviewPackage,
  packageDigest,
  parseCommitmentOpening,
  receiptReferenceV1Schema,
  uuidSchema,
  verifyReviewPackage,
  type Bytes,
  type CommitmentOpeningV1,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import type { SealedObject, VaultKeys } from './crypto/browser-crypto';
import { FROZEN_REVIEW_SCHEMA, VAULT_LIMITS } from './v1/constants';
import { encodeJcs, matchesReference, parseJsonBytes } from './v1/encoding';
import { err, ok, type VaultResult } from './v1/errors';
import { vaultObjectRefSchema, type VaultBinding, type VaultObjectRefV1 } from './v1/schemas';

/*
 * A frozen review is an immutable, encrypted snapshot of one Chapter 2 package: the exact
 * opening (with its blinding nonce) and every original artifact byte, plus a small record that
 * names them. Saving is only complete once every object has been read back through real
 * storage, decrypted and run through the Chapter 2 package verification.
 */

export const frozenReviewSchema = z.strictObject({
  schema: z.literal(FROZEN_REVIEW_SCHEMA),
  packageId: uuidSchema,
  receiptReference: receiptReferenceV1Schema,
  opening: vaultObjectRefSchema,
  artifacts: z
    .array(z.strictObject({ artifactId: uuidSchema, object: vaultObjectRefSchema }))
    .max(VAULT_LIMITS.maxArtifacts),
});
export type FrozenReviewV1 = z.infer<typeof frozenReviewSchema>;

/** A verified review recovered from encrypted storage or a bundle. The only other way to seal one. */
export class VerifiedReview {
  readonly #opening: CommitmentOpeningV1;
  readonly #reference: ReceiptReferenceV1;
  readonly #artifacts: ReadonlyMap<string, Bytes>;
  static #token = Symbol('lexaegis.verified-review');

  /** @internal */
  constructor(
    token: symbol,
    opening: CommitmentOpeningV1,
    reference: ReceiptReferenceV1,
    artifacts: ReadonlyMap<string, Bytes>,
  ) {
    if (token !== VerifiedReview.#token)
      throw new TypeError('VerifiedReview cannot be constructed directly');
    this.#opening = opening;
    this.#reference = reference;
    this.#artifacts = artifacts;
    Object.freeze(this);
  }

  /** @internal */
  static create(
    opening: CommitmentOpeningV1,
    reference: ReceiptReferenceV1,
    artifacts: ReadonlyMap<string, Bytes>,
  ): VerifiedReview {
    return new VerifiedReview(VerifiedReview.#token, opening, reference, artifacts);
  }

  static isVerified(value: unknown): value is VerifiedReview {
    return typeof value === 'object' && value !== null && #opening in value;
  }

  get opening(): CommitmentOpeningV1 {
    return this.#opening;
  }
  get reference(): ReceiptReferenceV1 {
    return this.#reference;
  }
  get artifactIds(): readonly string[] {
    return this.#opening.manifest.artifacts.map((artifact) => artifact.id);
  }
  /** A copy of one artifact's exact bytes. */
  artifactBytes(artifactId: string): Bytes | null {
    return this.#artifacts.get(artifactId)?.slice() ?? null;
  }
}

/** What may be sealed as a frozen review: a Chapter 2 snapshot, or a review verified from storage. */
export type FrozenCaptureSource = PreparedReviewPackage | VerifiedReview;

interface CaptureParts {
  readonly opening: CommitmentOpeningV1;
  readonly reference: ReceiptReferenceV1;
  readonly artifactIds: readonly string[];
  artifactBytes(id: string): Bytes | null;
}

function partsOf(source: unknown): CaptureParts | null {
  if (PreparedReviewPackage.isPrepared(source)) {
    return {
      opening: source.opening,
      reference: source.reference,
      artifactIds: source.artifactIds,
      artifactBytes: (id) => {
        try {
          return source.artifactBytes(id);
        } catch {
          return null;
        }
      },
    };
  }
  if (VerifiedReview.isVerified(source)) {
    return {
      opening: source.opening,
      reference: source.reference,
      artifactIds: source.artifactIds,
      artifactBytes: (id) => source.artifactBytes(id),
    };
  }
  return null;
}

export interface SealedFrozenReview {
  /** Every object to upload, leaves first and the frozen-review record last. */
  readonly objects: readonly SealedObject[];
  readonly frozen: SealedObject;
  readonly record: FrozenReviewV1;
  /** Artifacts whose existing encrypted object was reused after an exact byte check. */
  readonly reused: readonly string[];
}

export interface SealOptions {
  /**
   * Return an existing encrypted object for these exact bytes, but only after having decrypted
   * it and compared it with `bytes`. Never deduplicate by a plaintext hash held by the backend.
   */
  readonly reuse?: (artifactId: string, bytes: Bytes) => Promise<VaultObjectRefV1 | null>;
}

/**
 * Encrypts a validated capture. Uses the capture's own opening and nonce: nothing is refrozen
 * and no randomness is regenerated except the per-object encryption entropy. The caller keeps
 * the returned envelope bytes and resends them on any retry of the same operation.
 */
export async function sealFrozenReview(
  keys: VaultKeys,
  binding: VaultBinding,
  source: FrozenCaptureSource,
  options: SealOptions = {},
): Promise<VaultResult<SealedFrozenReview>> {
  const parts = partsOf(source);
  if (parts === null) return err('INVALID_INPUT');
  const { manifest } = parts.opening;
  if (
    manifest.context.chainId !== parts.reference.chainId ||
    manifest.context.registryAddress !== parts.reference.registryAddress ||
    manifest.context.reviewerAddress !== parts.reference.reviewerAddress ||
    manifest.artifacts.length > VAULT_LIMITS.maxArtifacts
  ) {
    return err('CAPTURE_MISMATCH');
  }
  // One-to-one coverage of the manifest's artifacts.
  const ids = manifest.artifacts.map((artifact) => artifact.id);
  if (
    new Set(parts.artifactIds).size !== ids.length ||
    !ids.every((id) => parts.artifactIds.includes(id))
  ) {
    return err('CAPTURE_INCOMPLETE');
  }

  const objects: SealedObject[] = [];
  const reused: string[] = [];
  const artifactRefs: { artifactId: string; object: VaultObjectRefV1 }[] = [];
  let total = 0;
  for (const artifact of manifest.artifacts) {
    const bytes = parts.artifactBytes(artifact.id);
    if (bytes === null) return err('CAPTURE_INCOMPLETE');
    total += bytes.byteLength;
    if (total > VAULT_LIMITS.maxTotalArtifactBytes) return err('TOO_LARGE');
    const existing = (await options.reuse?.(artifact.id, bytes)) ?? null;
    if (existing !== null) {
      reused.push(artifact.id);
      artifactRefs.push({ artifactId: artifact.id, object: existing });
      continue;
    }
    const sealed = await keys.encrypt(binding, bytes, 'artifact');
    if (!sealed.ok) return sealed;
    objects.push(sealed.data);
    artifactRefs.push({ artifactId: artifact.id, object: sealed.data.ref });
  }

  const openingBytes = encodeJcs(parts.opening, VAULT_LIMITS.maxStructuredBytes);
  if (!openingBytes.ok) return openingBytes;
  const opening = await keys.encrypt(binding, openingBytes.data, 'structured');
  if (!opening.ok) return opening;
  objects.push(opening.data);

  const record = frozenReviewSchema.parse({
    schema: FROZEN_REVIEW_SCHEMA,
    packageId: manifest.packageId,
    receiptReference: parts.reference,
    opening: opening.data.ref,
    artifacts: artifactRefs,
  });
  const recordBytes = encodeJcs(record, VAULT_LIMITS.maxStructuredBytes);
  if (!recordBytes.ok) return recordBytes;
  const frozen = await keys.encrypt(binding, recordBytes.data, 'structured');
  if (!frozen.ok) return frozen;
  objects.push(frozen.data);
  return ok({ objects, frozen: frozen.data, record, reused });
}

/** Fetches one stored envelope by reference. Null means the object is missing. */
export type FetchObject = (ref: VaultObjectRefV1) => Promise<Uint8Array | null>;

/**
 * Proof that a capture was read back and verified. Private to the controller that produced it:
 * it cannot be built from model text, imported JSON or an HTTP caller, and it is bound to the
 * account, vault and controller generation it was verified under.
 */
export class RecoverableCapture {
  static #token = Symbol('lexaegis.recoverable-capture');
  readonly ownerAddress: string;
  readonly vaultId: string;
  readonly generation: number;
  readonly packageDigest: string;
  readonly commitment: string;
  readonly captureDigest: string;
  readonly objectCount: number;

  /** @internal */
  constructor(
    token: symbol,
    fields: Pick<
      RecoverableCapture,
      | 'ownerAddress'
      | 'vaultId'
      | 'generation'
      | 'packageDigest'
      | 'commitment'
      | 'captureDigest'
      | 'objectCount'
    >,
  ) {
    if (token !== RecoverableCapture.#token)
      throw new TypeError('RecoverableCapture cannot be constructed directly');
    this.ownerAddress = fields.ownerAddress;
    this.vaultId = fields.vaultId;
    this.generation = fields.generation;
    this.packageDigest = fields.packageDigest;
    this.commitment = fields.commitment;
    this.captureDigest = fields.captureDigest;
    this.objectCount = fields.objectCount;
    Object.freeze(this);
  }

  /** @internal Only verifyFrozenReview calls this. */
  static issue(fields: ConstructorParameters<typeof RecoverableCapture>[1]): RecoverableCapture {
    return new RecoverableCapture(RecoverableCapture.#token, fields);
  }

  static isRecoverable(value: unknown): value is RecoverableCapture {
    return value instanceof RecoverableCapture && Object.isFrozen(value);
  }

  /** True only for this exact account, vault and controller generation. A persisted or replayed object fails. */
  matches(ownerAddress: string, vaultId: string, generation: number): boolean {
    return (
      this.ownerAddress === ownerAddress &&
      this.vaultId === vaultId &&
      this.generation === generation
    );
  }

  toJSON(): never {
    // Not serializable: it is a live gate, not data.
    throw new TypeError('A recoverable-capture result cannot be serialized');
  }
}

export interface VerifiedFrozenReview {
  readonly review: VerifiedReview;
  readonly capture: RecoverableCapture;
  /** Every envelope that was read, by object ID, in the form they were stored. */
  readonly envelopes: ReadonlyMap<string, Uint8Array>;
  /** Object references traversed: the frozen record, the opening and each artifact. */
  readonly refs: readonly VaultObjectRefV1[];
}

/**
 * Retrieves every object of a frozen review through `fetch`, authenticates and decrypts it, and
 * runs the Chapter 2 opening and full-package verification against the receipt reference stored
 * with the capture. A missing or modified object blocks readiness. This records a successful
 * read-back, not availability forever, human approval, legal correctness or an active receipt.
 */
export async function verifyFrozenReview(
  keys: VaultKeys,
  binding: VaultBinding,
  frozenRef: VaultObjectRefV1,
  fetch: FetchObject,
  generation: number,
): Promise<VaultResult<VerifiedFrozenReview>> {
  const envelopes = new Map<string, Uint8Array>();
  const load = async (
    ref: VaultObjectRefV1,
    kind: 'artifact' | 'structured',
  ): Promise<VaultResult<Bytes>> => {
    if (envelopes.has(ref.objectId)) return err('CONFLICT');
    const wire = await fetch(ref);
    if (wire === null) return err('MISSING_OBJECT');
    if (!(await matchesReference(ref, wire))) return err('REFERENCE_MISMATCH');
    envelopes.set(ref.objectId, wire);
    return keys.decrypt(wire, { ...binding, ref }, kind);
  };

  const recordPlain = await load(frozenRef, 'structured');
  if (!recordPlain.ok) return recordPlain;
  const recordJson = parseJsonBytes(recordPlain.data, VAULT_LIMITS.maxStructuredBytes);
  recordPlain.data.fill(0);
  if (!recordJson.ok) return err('INTEGRITY');
  const record = frozenReviewSchema.safeParse(recordJson.data);
  if (!record.success) return err('INTEGRITY');

  const ids = record.data.artifacts.map((artifact) => artifact.artifactId);
  const objectIds = [
    record.data.opening.objectId,
    ...record.data.artifacts.map((artifact) => artifact.object.objectId),
  ];
  if (
    new Set(ids).size !== ids.length ||
    new Set([...objectIds, frozenRef.objectId]).size !== objectIds.length + 1
  ) {
    return err('CONFLICT');
  }

  const openingPlain = await load(record.data.opening, 'structured');
  if (!openingPlain.ok) return openingPlain;
  const opening = parseCommitmentOpening(openingPlain.data);
  openingPlain.data.fill(0);
  if (!opening.ok) return err('INTEGRITY');

  const manifestIds = opening.data.manifest.artifacts.map((artifact) => artifact.id);
  if (manifestIds.length !== ids.length || !manifestIds.every((id) => ids.includes(id)))
    return err('CAPTURE_INCOMPLETE');
  if (opening.data.manifest.packageId !== record.data.packageId) return err('CAPTURE_MISMATCH');

  const artifacts = new Map<string, Bytes>();
  let total = 0;
  for (const entry of record.data.artifacts) {
    const plain = await load(entry.object, 'artifact');
    if (!plain.ok) return plain;
    total += plain.data.byteLength;
    if (total > VAULT_LIMITS.maxTotalArtifactBytes) return err('TOO_LARGE');
    artifacts.set(entry.artifactId, plain.data);
  }

  const verification = await verifyReviewPackage(
    opening.data,
    artifacts,
    record.data.receiptReference,
  );
  if (!verification.ok) return err('INTEGRITY');
  const { manifestIntegrity, artifactIntegrity } = verification.data;
  if (manifestIntegrity !== 'match' || artifactIntegrity !== 'match') return err('INTEGRITY');

  const digest = await packageDigest(canonicalizeReviewPackage(opening.data.manifest));
  const capture = RecoverableCapture.issue({
    ownerAddress: binding.ownerAddress,
    vaultId: binding.vaultId,
    generation,
    packageDigest: digest,
    commitment: record.data.receiptReference.commitment,
    captureDigest: frozenRef.envelopeSha256,
    objectCount: envelopes.size,
  });
  return ok({
    review: VerifiedReview.create(opening.data, record.data.receiptReference, artifacts),
    capture,
    envelopes,
    refs: [
      frozenRef,
      record.data.opening,
      ...record.data.artifacts.map((artifact) => artifact.object),
    ],
  });
}
