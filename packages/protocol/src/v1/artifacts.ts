import { assertUsableBytes, type Bytes } from './bytes';
import { LIMITS } from './constants';
import { ProtocolError } from './errors';
import { isUuid } from './primitives';
import type { ReviewPackageV1 } from './schemas';

/** Supplied artifact bytes keyed by artifact ID: a Map or any iterable of [id, bytes] pairs. */
export type ArtifactBytesInput = Iterable<readonly [string, Uint8Array]>;

export interface CollectedArtifacts {
  /** Independent copies of supplied bytes whose length equals the manifest's declared length. */
  readonly captured: Map<string, Bytes>;
  readonly lengthMismatch: string[];
  readonly missing: string[];
  /** IDs supplied but not committed by the manifest (only well-formed UUIDs are echoed). */
  readonly extra: (string | null)[];
}

/**
 * Synchronously classifies and copies the supplied artifact bytes. It runs before any await so
 * that later caller mutation cannot change the captured snapshot. Malformed input (non-bytes,
 * shared or detached buffers, duplicate IDs) is a typed failure; lengths are compared before
 * anything is copied, and only bytes that will actually be hashed are copied.
 */
export function collectArtifacts(manifest: ReviewPackageV1, input: unknown): CollectedArtifacts {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
  ) {
    throw new ProtocolError('ARTIFACT_INPUT_INVALID');
  }
  const declared = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const seen = new Set<string>();
  const captured = new Map<string, Bytes>();
  const lengthMismatch: string[] = [];
  const extra: (string | null)[] = [];

  for (const entry of input as Iterable<unknown>) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ProtocolError('ARTIFACT_INPUT_INVALID');
    }
    const [id, bytes] = entry as [unknown, unknown];
    if (typeof id !== 'string') throw new ProtocolError('ARTIFACT_INPUT_INVALID');
    const artifactId = isUuid(id) ? id : null;
    if (seen.has(id)) {
      throw new ProtocolError('ARTIFACT_DUPLICATE', artifactId === null ? {} : { artifactId });
    }
    seen.add(id);
    assertUsableBytes(bytes);

    const reference = declared.get(id);
    if (reference === undefined) {
      extra.push(artifactId);
      // An unbounded stream of uncommitted entries is malformed input, not something to enumerate.
      if (extra.length > LIMITS.maxArtifacts) throw new ProtocolError('ARTIFACT_EXTRA');
    } else if (BigInt(bytes.byteLength) !== BigInt(reference.byteLength)) {
      lengthMismatch.push(id);
    } else {
      captured.set(id, bytes.slice());
    }
  }

  const missing = manifest.artifacts.map((artifact) => artifact.id).filter((id) => !seen.has(id));
  return { captured, lengthMismatch, missing, extra };
}
