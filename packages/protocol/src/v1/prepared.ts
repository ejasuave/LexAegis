import { ProtocolError } from './errors';
import type { Bytes } from './bytes';
import type { CommitmentOpeningV1, ReceiptReferenceV1 } from './schemas';

const INTERNAL = Symbol('lexaegis.prepared-review-package');

export interface PreparedParts {
  readonly opening: CommitmentOpeningV1;
  readonly reference: ReceiptReferenceV1;
  readonly packageDigest: string;
  readonly canonicalManifest: Bytes;
  readonly artifacts: ReadonlyMap<string, Bytes>;
}

/**
 * An immutable captured snapshot: the private opening, package digest, public reference and the
 * exact artifact bytes. It is NOT an approved or issued receipt. Signing code must consume this
 * object rather than rebuilding a package from mutable UI state, and must reuse it (and its
 * nonce) when retrying the same intended approval.
 *
 * State lives in private fields, metadata is deep-frozen and bytes are only ever handed out as
 * copies, so nothing a caller does can alter what was captured.
 */
export class PreparedReviewPackage {
  readonly #opening: CommitmentOpeningV1;
  readonly #reference: ReceiptReferenceV1;
  readonly #packageDigest: string;
  readonly #canonicalManifest: Bytes;
  readonly #artifacts: ReadonlyMap<string, Bytes>;

  /** @internal Only prepareReviewPackage can construct a snapshot. */
  constructor(token: symbol, parts: PreparedParts) {
    if (token !== INTERNAL)
      throw new TypeError('PreparedReviewPackage cannot be constructed directly');
    this.#opening = parts.opening;
    this.#reference = parts.reference;
    this.#packageDigest = parts.packageDigest;
    this.#canonicalManifest = parts.canonicalManifest;
    this.#artifacts = parts.artifacts;
    Object.freeze(this);
  }

  /** True only for snapshots produced by prepareReviewPackage; a look-alike object fails. */
  static isPrepared(value: unknown): value is PreparedReviewPackage {
    return typeof value === 'object' && value !== null && #opening in value;
  }

  /** PRIVATE opening material (manifest and blinding nonce), deep-frozen. Never log or publish it. */
  get opening(): CommitmentOpeningV1 {
    return this.#opening;
  }

  /** The only projection suitable for public use. */
  get reference(): ReceiptReferenceV1 {
    return this.#reference;
  }

  /** PRIVATE lowercase 0x-prefixed package digest. */
  get packageDigest(): string {
    return this.#packageDigest;
  }

  /** Artifact IDs in manifest order. */
  get artifactIds(): readonly string[] {
    return this.#opening.manifest.artifacts.map((artifact) => artifact.id);
  }

  /** A copy of the exact canonical manifest bytes that were hashed. */
  canonicalManifestBytes(): Bytes {
    return this.#canonicalManifest.slice();
  }

  /** A copy of one captured artifact's exact bytes. */
  artifactBytes(artifactId: string): Bytes {
    const bytes = this.#artifacts.get(artifactId);
    if (bytes === undefined) throw new ProtocolError('UNRESOLVED_ARTIFACT_REFERENCE');
    return bytes.slice();
  }

  /** Fresh copies of every captured artifact, in manifest order. */
  artifacts(): Map<string, Bytes> {
    return new Map(this.artifactIds.map((id) => [id, this.artifactBytes(id)]));
  }

  /** Serialization exposes the public reference only, so a logged snapshot cannot leak the opening. */
  toJSON(): { reference: ReceiptReferenceV1 } {
    return { reference: this.#reference };
  }
}

/** @internal Not exported from the package entry point. */
export function createPrepared(parts: PreparedParts): PreparedReviewPackage {
  return new PreparedReviewPackage(INTERNAL, parts);
}
