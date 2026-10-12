import { parseReceiptReference, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import { parseRpcEndpoint } from '@lexaegis/sdk/verify';
import { parseOrigin, type ResolvedConfig } from './config';

/*
 * Observed attributes become one immutable, validated snapshot per refresh. The chain ID stays a
 * decimal string end to end (never a JavaScript Number) and the whole chain/registry/reviewer/
 * commitment tuple identifies the receipt: a commitment alone never does.
 */

export const OBSERVED_ATTRIBUTES = [
  'chain-id',
  'registry',
  'reviewer',
  'commitment',
  'rpc-url',
  'package-url',
] as const;

export const INPUT_REASONS = [
  'ATTRIBUTE_MISSING',
  'REFERENCE_INVALID',
  'RPC_URL_NOT_ALLOWED',
  'DEPLOYMENT_NOT_TRUSTED',
] as const;
export type InputReason = (typeof INPUT_REASONS)[number];

export interface InputSnapshot {
  readonly reference: ReceiptReferenceV1;
  /** The endpoint a status read uses: an allowed `rpc-url`, else the host's configured one. */
  readonly rpcUrl: string;
  /** Null when the attribute is unset or rejected. Validated against the host's approved origins. */
  readonly packageUrl: string | null;
  /** True when a package-url was given but is not allowed: only Check files is unavailable. */
  readonly packageRejected: boolean;
}

export type InputResult =
  | { readonly ok: true; readonly input: InputSnapshot }
  | { readonly ok: false; readonly reason: InputReason };

export interface RawAttributes {
  readonly chainId: string | null;
  readonly registry: string | null;
  readonly reviewer: string | null;
  readonly commitment: string | null;
  readonly rpcUrl: string | null;
  readonly packageUrl: string | null;
}

/** Package URL rules shared by the element and the fetch step; nothing is requested here. */
export function checkPackageUrl(value: string, config: ResolvedConfig): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const origin = parseOrigin(url.origin, config.allowLoopbackHttp);
  if (origin === null || !config.packageOrigins.has(origin)) return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  return url.toString();
}

export function snapshotInputs(raw: RawAttributes, config: ResolvedConfig): InputResult {
  if (
    raw.chainId === null ||
    raw.registry === null ||
    raw.reviewer === null ||
    raw.commitment === null
  )
    return { ok: false, reason: 'ATTRIBUTE_MISSING' };
  const reference = parseReceiptReference({
    schema: 'lexaegis.receipt-ref.v1',
    chainId: raw.chainId,
    registryAddress: raw.registry,
    reviewerAddress: raw.reviewer,
    commitment: raw.commitment,
  });
  if (!reference.ok) return { ok: false, reason: 'REFERENCE_INVALID' };
  const deployment = config.deployments.get(
    `${reference.data.chainId}:${reference.data.registryAddress}`,
  );
  if (deployment === undefined) return { ok: false, reason: 'DEPLOYMENT_NOT_TRUSTED' };

  let rpcUrl = deployment.rpcUrl;
  if (raw.rpcUrl !== null) {
    const endpoint = parseRpcEndpoint(raw.rpcUrl, { allowLoopbackHttp: config.allowLoopbackHttp });
    if (!endpoint.ok || !config.rpcOrigins.has(endpoint.origin))
      return { ok: false, reason: 'RPC_URL_NOT_ALLOWED' };
    rpcUrl = endpoint.url;
  }

  const packageUrl = raw.packageUrl === null ? null : checkPackageUrl(raw.packageUrl, config);
  return {
    ok: true,
    input: Object.freeze({
      reference: reference.data,
      rpcUrl,
      packageUrl,
      packageRejected: raw.packageUrl !== null && packageUrl === null,
    }),
  };
}
