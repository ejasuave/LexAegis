import { createHash } from 'node:crypto';

/*
 * Safety guards run BEFORE any setup or cleanup. They refuse public chains, production datasets and
 * wildcard resources. A refusal is a typed result, never an exception that a caller might swallow into
 * a pass.
 */

export type GuardFailure =
  | 'ENDPOINT_NOT_LOOPBACK'
  | 'CHAIN_IS_PUBLIC_NETWORK'
  | 'CHAIN_NOT_LOCAL_NODE'
  | 'DATABASE_NOT_TEST_NAMESPACE'
  | 'BUCKET_NOT_TEST_NAMESPACE'
  | 'WILDCARD_RESOURCE'
  | 'NOT_TEST_MODE';
export type Guarded = { readonly ok: true } | { readonly ok: false; readonly code: GuardFailure };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Public networks a default test may never mutate (Monad mainnet and the public Monad testnet). */
const PUBLIC_CHAIN_IDS = new Set(['143', '10143']);

export function checkLoopback(endpoint: string): Guarded {
  try {
    const url = new URL(endpoint);
    return LOOPBACK.has(url.hostname) ? { ok: true } : { ok: false, code: 'ENDPOINT_NOT_LOOPBACK' };
  } catch {
    return { ok: false, code: 'ENDPOINT_NOT_LOOPBACK' };
  }
}

export interface ChainProbe {
  readonly chainId: string;
  /** The node's own client version string (`web3_clientVersion`). */
  readonly clientVersion: string;
}

/**
 * The actual chain identity must be a loopback local node. The public Monad chain IDs are refused
 * even on a loopback endpoint unless the node identifies itself as the throwaway Anvil (the browser
 * journey runs Anvil under chain ID 10143 so the unchanged application configuration applies).
 */
export function checkLocalChain(
  endpoint: string,
  probe: ChainProbe,
  options: { readonly allowPublicChainIdOnAnvil?: boolean } = {},
): Guarded {
  const loop = checkLoopback(endpoint);
  if (!loop.ok) return loop;
  const anvil = /anvil/i.test(probe.clientVersion);
  if (!anvil) return { ok: false, code: 'CHAIN_NOT_LOCAL_NODE' };
  if (PUBLIC_CHAIN_IDS.has(probe.chainId) && options.allowPublicChainIdOnAnvil !== true)
    return { ok: false, code: 'CHAIN_IS_PUBLIC_NETWORK' };
  return { ok: true };
}

/** A database must be a loopback server and either the embedded harness or an explicitly test-named one. */
export function checkDatabase(url: string): Guarded {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'DATABASE_NOT_TEST_NAMESPACE' };
  }
  if (!LOOPBACK.has(parsed.hostname)) return { ok: false, code: 'DATABASE_NOT_TEST_NAMESPACE' };
  const name = parsed.pathname.replace(/^\//, '');
  return /^(?:lexaegis|lexaegis_test(?:_[a-z0-9]+)*)$/.test(name) &&
    (parsed.username === 'lexaegis' || /test/.test(parsed.username))
    ? { ok: true }
    : { ok: false, code: 'DATABASE_NOT_TEST_NAMESPACE' };
}

export function checkBucket(endpoint: string, bucket: string): Guarded {
  const loop = checkLoopback(endpoint);
  if (!loop.ok) return { ok: false, code: 'BUCKET_NOT_TEST_NAMESPACE' };
  return /^lexvault(?:-test-[a-z0-9]+)?$/.test(bucket) || /^lex-test-[a-z0-9-]+$/.test(bucket)
    ? { ok: true }
    : { ok: false, code: 'BUCKET_NOT_TEST_NAMESPACE' };
}

export function checkTestMode(env: Readonly<Record<string, string | undefined>>): Guarded {
  return env.LEXAEGIS_TEST_MODE === undefined || env.LEXAEGIS_TEST_MODE === ''
    ? { ok: false, code: 'NOT_TEST_MODE' }
    : { ok: true };
}

/** A per-run, per-worker namespace tag: lowercase letters and digits only. */
export function namespace(runId: string, worker: number): string {
  const digest = createHash('sha256')
    .update(`${runId}:${String(worker)}`)
    .digest('hex')
    .slice(0, 10);
  return `t${digest}`;
}

/** Refuse a resource name that could match more than the one thing this run created. */
export function checkExactResource(name: string): Guarded {
  return /[*?%\\]|^\.{1,2}$|^$/.test(name)
    ? { ok: false, code: 'WILDCARD_RESOURCE' }
    : { ok: true };
}
