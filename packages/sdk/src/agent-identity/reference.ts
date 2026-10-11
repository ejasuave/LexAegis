import { agentIdentityRefSchema, type AgentIdentityRef } from '@lexaegis/protocol';

/*
 * Reads the optional ERC-8004 reference from the BYTES of a review package's agent-configuration
 * artifact. Call it only after those bytes passed integrity checks; hash-correct bytes still prove
 * nothing about the claims inside, so a malformed or unsupported artifact is reported as such and
 * never as a failed receipt. Only the identity field is read here; the artifact's other fields are
 * the application's business, not this library's.
 */

export type AgentIdentityExtraction =
  | { readonly status: 'not_included' }
  | { readonly status: 'included'; readonly reference: AgentIdentityRef }
  | { readonly status: 'malformed' }
  | { readonly status: 'unsupported_version' };

const MAX_ARTIFACT_BYTES = 1024 * 1024;

/**
 * Extracts the identity reference from an agent-configuration artifact's exact bytes.
 *
 * @example
 * ```ts
 * import { extractAgentIdentity } from '@lexaegis/sdk/agent-identity';
 *
 * declare const bytes: Uint8Array; // an integrity-checked agent-config artifact
 * const found = extractAgentIdentity(bytes);
 * if (found.status === 'included') console.log(found.reference.agentId);
 * ```
 */
export function extractAgentIdentity(bytes: Uint8Array): AgentIdentityExtraction {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) return { status: 'malformed' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { status: 'malformed' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { status: 'malformed' };
  const record = value as Record<string, unknown>;
  if (record.schema === 'lexaegis.agent-config.v1') {
    // v1 predates the field: a v1 artifact that carries one is not a valid v1 artifact.
    return 'agentIdentity' in record ? { status: 'malformed' } : { status: 'not_included' };
  }
  if (record.schema !== 'lexaegis.agent-config.v2') return { status: 'unsupported_version' };
  if (!('agentIdentity' in record)) return { status: 'not_included' };
  const reference = agentIdentityRefSchema.safeParse(record.agentIdentity);
  return reference.success
    ? { status: 'included', reference: reference.data }
    : { status: 'malformed' };
}
