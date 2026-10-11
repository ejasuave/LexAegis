import { bytesToHex, hexToBytes } from '../v1/bytes';
import { canonicalizeJson, canonicalizeReviewPackage } from '../v1/canonicalize';
import { computeCommitment } from '../v1/commitment';
import { artifactDigest, packageDigest } from '../v1/hashes';
import { parseStrictJson } from '../v1/parse-json';
import { parseCommitmentOpening, parseReceiptReference } from '../v1/parse';
import { verifyReviewPackage } from '../v1/verify';

/*
 * Runs one published test-vector case through the TypeScript implementation and reports what it
 * actually produced. It computes no expected value and reads no expectation: the caller compares the
 * result with the case's literal expectation (the Vitest runner) or with another implementation (the
 * cross-language comparison).
 */

export type Encoded = { readonly encoding: 'utf8' | 'hex' | 'base64'; readonly value: string };

export interface VectorCase {
  readonly id: string;
  readonly stage: string;
  readonly operation: string;
  readonly input: Record<string, unknown>;
  readonly expected: Outcome & { readonly stage?: string };
}

/** What an implementation produced for a case. Fields not relevant to the operation are absent. */
export interface Outcome {
  readonly outcome: 'ok' | 'error';
  readonly code?: string;
  readonly canonicalUtf8Hex?: string;
  readonly digest?: string;
  readonly commitment?: string;
  readonly manifestIntegrity?: string;
  readonly artifactIntegrity?: string;
  readonly issues?: readonly { readonly code: string; readonly artifactId?: string }[];
}

export function decode(input: Encoded): Uint8Array<ArrayBuffer> {
  if (input.encoding === 'utf8') return new TextEncoder().encode(input.value);
  if (input.encoding === 'hex') return hexToBytes(input.value);
  return Uint8Array.from(atob(input.value), (character) => character.charCodeAt(0));
}

/** Which stages an error code may legitimately belong to (see test-vectors/README.md). */
export const STAGES_OF_CODE: Readonly<Record<string, readonly string[]>> = {
  INPUT_TOO_LARGE: ['strict-json'],
  INVALID_UTF8: ['strict-json'],
  BYTE_ORDER_MARK: ['strict-json'],
  INVALID_JSON: ['strict-json'],
  DUPLICATE_KEY: ['strict-json'],
  NESTING_TOO_DEEP: ['strict-json'],
  UNSAFE_NUMBER: ['strict-json'],
  LONE_SURROGATE: ['strict-json'],
  FORBIDDEN_KEY: ['strict-json'],
  UNSUPPORTED_VERSION: ['version'],
  SCHEMA_INVALID: ['version', 'schema'],
  UNKNOWN_FIELD: ['schema'],
  TOO_MANY_ARTIFACTS: ['schema'],
  ARTIFACT_TOO_LARGE: ['schema'],
  DUPLICATE_ARTIFACT_ID: ['cross-field'],
  SOURCE_ARTIFACT_REQUIRED: ['cross-field'],
  DECISION_LOG_ARTIFACT_INVALID: ['cross-field'],
  DUPLICATE_SCOPE_ID: ['cross-field'],
  UNRESOLVED_ARTIFACT_REFERENCE: ['cross-field'],
  SCOPE_INCOMPLETE: ['cross-field'],
  DECISION_LOG_REFERENCE_INVALID: ['cross-field'],
  SUPERSEDES_CONTEXT_MISMATCH: ['cross-field'],
  ARTIFACTS_TOO_LARGE: ['cross-field'],
};

const failure = (code: string): Outcome => ({ outcome: 'error', code });

export async function outcomeOf(vector: VectorCase): Promise<Outcome> {
  const input = vector.input;
  switch (vector.operation) {
    case 'canonicalize-json': {
      const value = parseStrictJson(decode(input as unknown as Encoded));
      return { outcome: 'ok', canonicalUtf8Hex: bytesToHex(canonicalizeJson(value)) };
    }
    case 'canonical-manifest': {
      const opening = parseCommitmentOpening(decode(input as unknown as Encoded));
      if (!opening.ok) return failure(opening.error.code);
      return {
        outcome: 'ok',
        canonicalUtf8Hex: bytesToHex(canonicalizeReviewPackage(opening.data.manifest)),
      };
    }
    case 'artifact-digest':
      return { outcome: 'ok', digest: await artifactDigest(decode(input as unknown as Encoded)) };
    case 'package-digest':
      return { outcome: 'ok', digest: await packageDigest(decode(input as unknown as Encoded)) };
    case 'commitment': {
      const { blindingNonce, packageDigest: digest } = input as {
        blindingNonce: string;
        packageDigest: string;
      };
      return { outcome: 'ok', commitment: await computeCommitment(blindingNonce, digest) };
    }
    case 'parse-opening': {
      const result = parseCommitmentOpening(decode(input as unknown as Encoded));
      return result.ok ? { outcome: 'ok' } : failure(result.error.code);
    }
    case 'parse-reference': {
      const result = parseReceiptReference(decode(input as unknown as Encoded));
      return result.ok ? { outcome: 'ok' } : failure(result.error.code);
    }
    case 'verify-package': {
      const verification = input as {
        opening: Encoded;
        artifacts: (Encoded & { id: string })[];
        expectedReference: Encoded;
      };
      const supplied = new Map(verification.artifacts.map((item) => [item.id, decode(item)]));
      const result = await verifyReviewPackage(
        decode(verification.opening),
        supplied,
        decode(verification.expectedReference),
      );
      if (!result.ok) return failure(result.error.code);
      return {
        outcome: 'ok',
        manifestIntegrity: result.data.manifestIntegrity,
        artifactIntegrity: result.data.artifactIntegrity,
        issues: result.data.issues.map((issue) =>
          issue.artifactId === undefined
            ? { code: issue.code }
            : { code: issue.code, artifactId: issue.artifactId },
        ),
      };
    }
    default:
      throw new Error(`unsupported operation ${vector.operation} in ${vector.id}`);
  }
}
