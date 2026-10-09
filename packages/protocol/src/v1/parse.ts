import type { z } from 'zod';
import { deepFreeze } from './bytes';
import { OPENING_SCHEMA, PACKAGE_SCHEMA, REFERENCE_SCHEMA } from './constants';
import { isProtocolErrorCode, ProtocolError, toResult, type ProtocolResult } from './errors';
import { readJsonInput, type JsonValue } from './parse-json';
import {
  commitmentOpeningV1Schema,
  receiptReferenceV1Schema,
  reviewPackageV1Schema,
  type CommitmentOpeningV1,
  type ReceiptReferenceV1,
  type ReviewPackageV1,
} from './schemas';

function field(value: JsonValue, key: string): JsonValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/**
 * Version dispatch. An envelope whose identifier is not exactly the supported one is rejected
 * outright; it is never stripped of unfamiliar fields or reinterpreted as v1.
 */
function requireSchema(value: JsonValue, expected: string, path: string): void {
  const actual = field(value, 'schema');
  if (typeof actual !== 'string') throw new ProtocolError('SCHEMA_INVALID', { path });
  if (actual !== expected) throw new ProtocolError('UNSUPPORTED_VERSION', { path });
}

function toProtocolError(error: z.ZodError): ProtocolError {
  const issue = error.issues[0];
  if (issue === undefined) return new ProtocolError('SCHEMA_INVALID');
  const path = issue.path.map(String).join('.');
  const detail = path === '' ? {} : { path };
  if (issue.code === 'custom') {
    const code: unknown = issue.params?.protocolCode;
    if (isProtocolErrorCode(code)) return new ProtocolError(code, detail);
  }
  if (issue.code === 'unrecognized_keys') return new ProtocolError('UNKNOWN_FIELD', detail);
  if (issue.code === 'too_big' && /(^|\.)artifacts$/.test(path)) {
    return new ProtocolError('TOO_MANY_ARTIFACTS', detail);
  }
  return new ProtocolError('SCHEMA_INVALID', detail);
}

function validate<T>(schema: z.ZodType<T>, value: JsonValue): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw toProtocolError(parsed.error);
  return deepFreeze(parsed.data);
}

/** Strictly reads a manifest from raw JSON bytes, JSON text or plain data. Throws ProtocolError. */
export function readReviewPackage(input: unknown): ReviewPackageV1 {
  const value = readJsonInput(input);
  requireSchema(value, PACKAGE_SCHEMA, 'schema');
  const supersedes = field(value, 'supersedes');
  if (supersedes !== undefined && supersedes !== null) {
    requireSchema(supersedes, REFERENCE_SCHEMA, 'supersedes.schema');
  }
  return validate(reviewPackageV1Schema, value);
}

export function readReceiptReference(input: unknown): ReceiptReferenceV1 {
  const value = readJsonInput(input);
  requireSchema(value, REFERENCE_SCHEMA, 'schema');
  return validate(receiptReferenceV1Schema, value);
}

export function readCommitmentOpening(input: unknown): CommitmentOpeningV1 {
  const value = readJsonInput(input);
  requireSchema(value, OPENING_SCHEMA, 'schema');
  const manifest = field(value, 'manifest');
  if (manifest !== undefined) {
    requireSchema(manifest, PACKAGE_SCHEMA, 'manifest.schema');
    const supersedes = field(manifest, 'supersedes');
    if (supersedes !== undefined && supersedes !== null) {
      requireSchema(supersedes, REFERENCE_SCHEMA, 'manifest.supersedes.schema');
    }
  }
  return validate(commitmentOpeningV1Schema, value);
}

export function parseReviewPackage(input: unknown): ProtocolResult<ReviewPackageV1> {
  return toResult(() => readReviewPackage(input));
}

export function parseReceiptReference(input: unknown): ProtocolResult<ReceiptReferenceV1> {
  return toResult(() => readReceiptReference(input));
}

export function parseCommitmentOpening(input: unknown): ProtocolResult<CommitmentOpeningV1> {
  return toResult(() => readCommitmentOpening(input));
}
