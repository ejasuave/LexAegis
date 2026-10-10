import 'server-only';
import {
  readChainCheckpoint,
  readLiveReceipt,
  type ChainCheckpoint,
  type ChainPolicy,
  type LiveChainClient,
} from '@lexaegis/sdk/registry';
import { decodeCursor, encodeCursor } from './cursor';
import {
  ENVIO_LIMITS,
  type EnvioClient,
  type EnvioFailure,
  type HistoryMetaRead,
} from './envio-client';
import { computeLag } from './lag';
import {
  historyHealthSchema,
  historyPageSchema,
  receiptHistorySchema,
  type HistoryAction,
  type HistoryHealth,
  type HistoryPage,
  type HistoryReason,
  type HistoryReset,
  type ReceiptHistory,
  type WireAction,
  type WireReceipt,
  type WireRegistryState,
} from './schemas';

/*
 * Derived history status. Index failure never disables live verification and live failure never
 * leaves a green current-verification claim. Nothing here confirms a transaction, authorises a
 * signature or satisfies the human-review gate.
 */

export const MAX_REORG_DEPTH = 200n;

export interface HistoryDeps {
  readonly envio: EnvioClient | null;
  readonly chain: { readonly live: LiveChainClient; readonly policy: ChainPolicy } | null;
  readonly now: () => Date;
  readonly continuity?: Continuity;
}

/** Last coherent observation, used to notice rebuilds and rollbacks across requests. */
export interface Continuity {
  previous: { readonly generation: string; readonly progress: bigint } | null;
}
const processContinuity: Continuity = { previous: null };

export interface Configured {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly startBlock: string;
}

export const configuredFrom = (policy: ChainPolicy): Configured => ({
  chainId: policy.chainId,
  registryAddress: policy.registryAddress,
  startBlock: policy.deploymentBlock,
});

export interface ConsistencyInput {
  readonly configured: Configured;
  readonly read: HistoryMetaRead;
  readonly previous: Continuity['previous'];
}
export interface Consistency {
  readonly value: HistoryHealth['indexConsistency'];
  readonly reasons: readonly HistoryReason[];
}

/** Pure evaluation of whether the index is the one configured and is coherent. */
export function evaluateConsistency(input: ConsistencyInput): Consistency {
  const { configured, read, previous } = input;
  const { meta, state } = read;
  if (meta.chainId !== configured.chainId || meta.startBlock !== configured.startBlock) {
    return { value: 'inconsistent', reasons: ['DEPLOYMENT_MISMATCH'] };
  }
  if (state !== null) {
    if (
      state.chainId !== configured.chainId ||
      state.registryAddress !== configured.registryAddress ||
      state.startBlock !== configured.startBlock
    ) {
      return { value: 'inconsistent', reasons: ['DEPLOYMENT_MISMATCH'] };
    }
    if (state.pendingSupersessions > 0) {
      return { value: 'inconsistent', reasons: ['INCOMPLETE_SUPERSESSION'] };
    }
  }
  const progress = BigInt(meta.progressBlock);
  if (previous !== null && state !== null) {
    if (previous.generation !== state.generation) {
      return { value: 'recovering', reasons: ['GENERATION_CHANGED'] };
    }
    if (progress < previous.progress) {
      return previous.progress - progress > MAX_REORG_DEPTH
        ? { value: 'inconsistent', reasons: ['REORG_BEYOND_WINDOW'] }
        : { value: 'recovering', reasons: ['COVERAGE_REGRESSED'] };
    }
  }
  return { value: 'consistent', reasons: state === null ? ['NO_EVENTS_INDEXED'] : [] };
}

type Failure = { readonly ok: false; readonly failure: EnvioFailure };
const reasonForFailure = (failure: EnvioFailure): HistoryReason =>
  failure === 'NOT_CONFIGURED'
    ? 'INDEX_NOT_CONFIGURED'
    : failure === 'RESPONSE_INVALID' ||
        failure === 'GRAPHQL_ERROR' ||
        failure === 'RESPONSE_TOO_LARGE'
      ? 'INDEX_RESPONSE_INVALID'
      : 'INDEX_UNAVAILABLE';

const sameObservation = (a: HistoryMetaRead, b: HistoryMetaRead): boolean =>
  a.meta.progressBlock === b.meta.progressBlock &&
  a.state?.generation === b.state?.generation &&
  a.state?.configFingerprint === b.state?.configFingerprint &&
  a.state?.lastEventId === b.state?.lastEventId;

async function liveCheckpoint(deps: HistoryDeps): Promise<ChainCheckpoint | null> {
  if (deps.chain === null) return null;
  const read = await readChainCheckpoint(deps.chain.live, deps.chain.policy, deps.now);
  return read.status === 'ok' ? read.data : null;
}

export type HealthRead = {
  readonly health: HistoryHealth;
  readonly read: HistoryMetaRead | null;
  readonly checkpoint: ChainCheckpoint | null;
};

function unavailable(
  deps: HistoryDeps,
  configured: Configured,
  reasons: readonly HistoryReason[],
  consistency: HistoryHealth['indexConsistency'] = 'unknown',
): HistoryHealth {
  return historyHealthSchema.parse({
    schema: 'lexaegis.history-health.v1',
    availability: 'unavailable',
    freshness: 'unknown',
    indexConsistency: consistency,
    observedAt: deps.now().toISOString(),
    configured,
    index: null,
    live: null,
    lag: { sourceLag: null, confirmedLag: null },
    reasons,
  });
}

/** One bracketed observation: metadata read twice around any work; a change retries once. */
export async function observe(
  deps: HistoryDeps,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly kind: 'ok'; readonly read: HistoryMetaRead }
  | { readonly kind: 'failed'; readonly failure: EnvioFailure | 'METADATA_CHANGED' }
> {
  if (deps.envio === null) return { kind: 'failed', failure: 'NOT_CONFIGURED' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await deps.envio.readMeta(signal);
    if (!before.ok) return { kind: 'failed', failure: before.failure };
    const after = await deps.envio.readMeta(signal);
    if (!after.ok) return { kind: 'failed', failure: after.failure };
    if (sameObservation(before.data, after.data)) return { kind: 'ok', read: after.data };
  }
  return { kind: 'failed', failure: 'METADATA_CHANGED' };
}

export async function readHealth(
  deps: HistoryDeps,
  configured: Configured,
  signal?: AbortSignal,
): Promise<HealthRead> {
  const observed = await observe(deps, signal);
  const checkpoint = await liveCheckpoint(deps);
  if (observed.kind === 'failed') {
    const reason: HistoryReason =
      observed.failure === 'METADATA_CHANGED'
        ? 'METADATA_CHANGED'
        : reasonForFailure(observed.failure);
    return {
      health: unavailable(deps, configured, [
        reason,
        ...(checkpoint === null ? (['LIVE_CHECKPOINT_UNAVAILABLE'] as const) : []),
      ]),
      read: null,
      checkpoint,
    };
  }
  const { read } = observed;
  const continuity = deps.continuity ?? processContinuity;
  const consistency = evaluateConsistency({ configured, read, previous: continuity.previous });
  if (read.state !== null) {
    continuity.previous = {
      generation: read.state.generation,
      progress: BigInt(read.meta.progressBlock),
    };
  }
  const coherent = consistency.value === 'consistent';
  const lag = computeLag({
    progressBlock: read.meta.progressBlock,
    sourceBlock: read.meta.sourceBlock,
    liveCheckpointBlock: checkpoint?.blockNumber ?? null,
    coherent,
  });
  const state = read.state;
  const health = historyHealthSchema.parse({
    schema: 'lexaegis.history-health.v1',
    availability: coherent ? 'available' : 'unavailable',
    freshness: lag.freshness,
    indexConsistency: consistency.value,
    observedAt: deps.now().toISOString(),
    configured,
    index:
      state === null
        ? null
        : {
            configFingerprint: state.configFingerprint,
            generation: state.generation,
            projectionVersion: state.projectionVersion,
            progressBlock: read.meta.progressBlock,
            sourceBlock: read.meta.sourceBlock,
            isReady: read.meta.isReady,
            lastEventBlock: state.lastEventBlockNumber,
            rawEventCount: state.rawEventCount,
            pendingSupersessions: state.pendingSupersessions,
          },
    live:
      checkpoint === null
        ? null
        : { checkpointBlock: checkpoint.blockNumber, checkpointHash: checkpoint.blockHash },
    lag: { sourceLag: lag.sourceLag, confirmedLag: lag.confirmedLag },
    reasons: [...consistency.reasons, ...lag.reasons].slice(0, 16),
  });
  return { health, read, checkpoint };
}

// ---- Anchors -------------------------------------------------------------------------------

/** Canonical block hash from the RPC provider for a small, bounded set of anchors. */
export async function verifyAnchors(
  deps: HistoryDeps,
  anchors: readonly { readonly number: string; readonly hash: string }[],
): Promise<'ok' | 'mismatch' | 'unverified'> {
  if (deps.chain === null) return 'unverified';
  try {
    for (const anchor of anchors.slice(0, 2)) {
      const block = await deps.chain.live.getBlock({ blockNumber: BigInt(anchor.number) });
      if (block === null) return 'unverified';
      if (block.hash.toLowerCase() !== anchor.hash) return 'mismatch';
    }
    return 'ok';
  } catch {
    return 'unverified';
  }
}

// ---- Pages ---------------------------------------------------------------------------------

type Observed = {
  readonly progress: string;
  readonly generation: string | null;
  readonly lastEventId: string | null;
};
export type PageOutcome =
  | { readonly kind: 'ok'; readonly page: HistoryPage }
  | { readonly kind: 'reset'; readonly body: HistoryReset }
  | { readonly kind: 'unavailable'; readonly health: HistoryHealth }
  | { readonly kind: 'invalid_input' };

const dec = (n: string): bigint => BigInt(n);

function toHistoryAction(action: WireAction, checkpoint: ChainCheckpoint | null): HistoryAction {
  return {
    id: action.id,
    kind: action.kind,
    consumedNonce: action.consumedNonce,
    commitment: action.commitment,
    relatedCommitment: action.relatedCommitment,
    reviewer: action.reviewer,
    executor: action.executor,
    transactionHash: action.transactionHash,
    blockNumber: action.blockNumber,
    blockHash: action.blockHash,
    timestamp: action.timestamp,
    eventCount: action.eventCount,
    firstLogIndex: action.firstLogIndex,
    lastLogIndex: action.lastLogIndex,
    provisional: checkpoint === null || dec(action.blockNumber) > dec(checkpoint.blockNumber),
  };
}

const registryKeyOf = (state: WireRegistryState): string =>
  `${state.chainId}:${state.genesisHash}:${state.registryAddress}`;
const actionIdOf = (state: WireRegistryState, reviewer: string, nonce: string): string =>
  `${registryKeyOf(state)}:${reviewer}:${nonce}`;

function orderedWithin(rows: readonly WireAction[], reviewer: string, upper: bigint): boolean {
  let previous: bigint | null = null;
  for (const row of rows) {
    const nonce = dec(row.consumedNonce);
    if (row.reviewer !== reviewer || nonce > upper) return false;
    if (previous !== null && nonce >= previous) return false;
    previous = nonce;
  }
  return true;
}

async function pageOnce(
  deps: HistoryDeps,
  configured: Configured,
  input: { readonly reviewer: string; readonly cursor: string | null; readonly limit: number },
  signal?: AbortSignal,
): Promise<PageOutcome> {
  const limit = Math.min(Math.max(input.limit, 1), ENVIO_LIMITS.maxPageSize);
  const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
  if (input.cursor !== null && cursor === null) {
    return { kind: 'reset', body: reset('CURSOR_INVALID') };
  }
  const first = await readHealth(deps, configured, signal);
  if (first.health.availability !== 'available' || first.read === null || deps.envio === null) {
    return { kind: 'unavailable', health: first.health };
  }
  const envio = deps.envio;
  const health = first.health;
  const checkpoint = first.checkpoint;
  const state = first.read.state;

  if (state === null) {
    // Coherent coverage and nothing indexed yet.
    if (cursor !== null) return { kind: 'reset', body: reset('GENERATION_CHANGED') };
    return {
      kind: 'ok',
      page: historyPageSchema.parse({
        schema: 'lexaegis.history-page.v1',
        status: 'ok',
        health,
        reviewer: input.reviewer,
        items: [],
        nextCursor: null,
        anchor: null,
        empty: true,
      }),
    };
  }
  if (cursor !== null) {
    if (cursor.fp !== state.configFingerprint || cursor.gen !== state.generation) {
      return { kind: 'reset', body: reset('GENERATION_CHANGED') };
    }
    if (cursor.r !== input.reviewer) return { kind: 'reset', body: reset('CURSOR_INVALID') };
    if (dec(first.read.meta.progressBlock) < 0n)
      return { kind: 'reset', body: reset('COVERAGE_BELOW_ANCHOR') };
  }

  const key = `${registryKeyOf(state)}:${input.reviewer}`;
  let upper: string;
  let upperHash: string | null = null;
  let before: string; // inclusive upper bound for this query
  if (cursor === null) {
    const summary = await envio.readSummary(key, signal);
    if (!summary.ok) return { kind: 'unavailable', health: failed(deps, configured, summary) };
    if (summary.data === null || dec(summary.data.nextNonce) === 0n) {
      return {
        kind: 'ok',
        page: historyPageSchema.parse({
          schema: 'lexaegis.history-page.v1',
          status: 'ok',
          health,
          reviewer: input.reviewer,
          items: [],
          nextCursor: null,
          anchor: null,
          empty: true,
        }),
      };
    }
    upper = (dec(summary.data.nextNonce) - 1n).toString();
    before = upper;
  } else {
    upper = cursor.upper;
    upperHash = cursor.upperHash;
    if (dec(cursor.last) === 0n) {
      return {
        kind: 'ok',
        page: historyPageSchema.parse({
          schema: 'lexaegis.history-page.v1',
          status: 'ok',
          health,
          reviewer: input.reviewer,
          items: [],
          nextCursor: null,
          anchor: { upperNonce: upper, blockHash: upperHash },
          empty: false,
        }),
      };
    }
    before = (dec(cursor.last) - 1n).toString();
    const anchors = await envio.readAnchors(
      [
        actionIdOf(state, input.reviewer, cursor.upper),
        actionIdOf(state, input.reviewer, cursor.last),
      ],
      signal,
    );
    if (!anchors.ok) return { kind: 'unavailable', health: failed(deps, configured, anchors) };
    const byNonce = new Map(anchors.data.map((a) => [a.consumedNonce, a.blockHash]));
    if (
      byNonce.get(cursor.upper) !== cursor.upperHash ||
      byNonce.get(cursor.last) !== cursor.lastHash
    ) {
      return { kind: 'reset', body: reset('ANCHOR_CHANGED') };
    }
  }

  const rows = await envio.readActions({ reviewer: input.reviewer, upper: before, limit }, signal);
  if (!rows.ok) return { kind: 'unavailable', health: failed(deps, configured, rows) };
  if (!orderedWithin(rows.data, input.reviewer, dec(before))) {
    return {
      kind: 'unavailable',
      health: unavailable(deps, configured, ['INDEX_RESPONSE_INVALID'], 'inconsistent'),
    };
  }
  const items = rows.data.slice(0, limit);
  const head = items[0];
  if (cursor === null) {
    if (head === undefined || head.consumedNonce !== upper) {
      return { kind: 'unavailable', health: unavailable(deps, configured, ['METADATA_CHANGED']) };
    }
    upperHash = head.blockHash;
  }
  if (upperHash === null)
    return { kind: 'unavailable', health: unavailable(deps, configured, ['METADATA_CHANGED']) };

  // Canonical hashes for the page anchor and the newest indexed event, never one call per row.
  const toCheck = [{ number: head?.blockNumber ?? '0', hash: head?.blockHash ?? upperHash }].filter(
    () => head !== undefined,
  );
  const anchorState = await verifyAnchors(deps, toCheck);
  if (anchorState === 'mismatch') {
    return cursor === null
      ? {
          kind: 'unavailable',
          health: unavailable(deps, configured, ['ANCHOR_HASH_MISMATCH'], 'inconsistent'),
        }
      : { kind: 'reset', body: reset('ANCHOR_CHANGED') };
  }
  const pageHealth: HistoryHealth =
    anchorState === 'unverified'
      ? {
          ...health,
          reasons: [...health.reasons, 'ANCHOR_UNVERIFIED'].slice(0, 16) as HistoryReason[],
        }
      : health;

  const last = items.at(-1);
  const hasMore = rows.data.length > limit && last !== undefined && dec(last.consumedNonce) > 0n;
  return {
    kind: 'ok',
    page: historyPageSchema.parse({
      schema: 'lexaegis.history-page.v1',
      status: 'ok',
      health: pageHealth,
      reviewer: input.reviewer,
      items: items.map((a) => toHistoryAction(a, checkpoint)),
      nextCursor: hasMore
        ? encodeCursor({
            v: 1,
            fp: state.configFingerprint,
            gen: state.generation,
            r: input.reviewer,
            upper,
            upperHash,
            last: last.consumedNonce,
            lastHash: last.blockHash,
          })
        : null,
      anchor: { upperNonce: upper, blockHash: upperHash },
      empty: false,
    }),
  };
}

const reset = (reason: HistoryReset['reason']): HistoryReset => ({
  schema: 'lexaegis.history-error.v1',
  status: 'history_reset_required',
  reason,
});

function failed(deps: HistoryDeps, configured: Configured, failure: Failure): HistoryHealth {
  return unavailable(deps, configured, [reasonForFailure(failure.failure)]);
}

// ---- Receipt detail ------------------------------------------------------------------------

const LIFECYCLE_TO_LIVE = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
  SUPERSEDED: 'superseded',
} as const;

export type ReceiptOutcome =
  | { readonly kind: 'ok'; readonly body: ReceiptHistory }
  | { readonly kind: 'unavailable'; readonly health: HistoryHealth };

export async function readReceiptHistory(
  deps: HistoryDeps,
  configured: Configured,
  input: { readonly reviewer: string; readonly commitment: string },
  signal?: AbortSignal,
): Promise<ReceiptOutcome> {
  const { health, read } = await readHealth(deps, configured, signal);
  if (health.availability !== 'available' || read === null || deps.envio === null) {
    return { kind: 'unavailable', health };
  }
  let indexed: WireReceipt | null = null;
  if (read.state !== null) {
    const id = `${registryKeyOf(read.state)}:${input.reviewer}:${input.commitment}`;
    const result = await deps.envio.readReceipt(id, signal);
    if (!result.ok) return { kind: 'unavailable', health: failed(deps, configured, result) };
    indexed = result.data;
  }
  const zero = `0x${'0'.repeat(64)}`;

  let live: ReceiptHistory['live'] = { status: 'unknown', reason: 'RPC_UNAVAILABLE' };
  let liveLifecycle: string | null = null;
  let liveBlock: bigint | null = null;
  if (deps.chain !== null) {
    const read2 = await readLiveReceipt(
      deps.chain.live,
      deps.chain.policy,
      {
        reference: {
          schema: 'lexaegis.receipt-ref.v1',
          chainId: deps.chain.policy.chainId,
          registryAddress: deps.chain.policy.registryAddress,
          reviewerAddress: input.reviewer,
          commitment: input.commitment,
        } as never,
      },
      deps.now,
    );
    if (read2.status === 'ok') {
      liveLifecycle = read2.data.receipt.receiptLifecycle;
      liveBlock = BigInt(read2.data.checkpoint.blockNumber);
      live = {
        status: 'ok',
        receiptStatus: read2.data.receipt.receiptLifecycle,
        checkpointBlock: read2.data.checkpoint.blockNumber,
        checkpointHash: read2.data.checkpoint.blockHash,
      };
    } else {
      live = { status: 'unknown', reason: read2.reason };
    }
  }

  const progress = health.index === null ? null : BigInt(health.index.progressBlock);
  const indexedLive = indexed === null ? 'not_found' : LIFECYCLE_TO_LIVE[indexed.status];
  let comparison: ReceiptHistory['comparison'] = 'unavailable';
  if (liveLifecycle !== null && liveBlock !== null && progress !== null) {
    comparison =
      progress === liveBlock
        ? indexedLive === liveLifecycle
          ? 'same_block_match'
          : 'same_block_mismatch'
        : 'different_checkpoints';
  } else if (liveLifecycle !== null && liveBlock !== null && health.index === null) {
    // No events indexed at all: only the configured start coverage exists.
    comparison = 'different_checkpoints';
  }

  return {
    kind: 'ok',
    body: receiptHistorySchema.parse({
      schema: 'lexaegis.receipt-history.v1',
      status: 'ok',
      health,
      reviewer: input.reviewer,
      commitment: input.commitment,
      indexed:
        indexed === null
          ? { state: 'not_indexed' }
          : {
              state: 'indexed',
              lifecycle: indexed.status,
              predecessor: indexed.predecessor === zero ? null : indexed.predecessor,
              successor: indexed.successor === zero ? null : indexed.successor,
              issuedAt: indexed.issuedAt,
              updatedAt: indexed.updatedAt,
            },
      live,
      comparison,
      provisionalNewerThanLive: progress !== null && liveBlock !== null && progress > liveBlock,
    }),
  };
}

const observationOf = (read: HistoryMetaRead): Observed => ({
  progress: read.meta.progressBlock,
  generation: read.state?.generation ?? null,
  lastEventId: read.state?.lastEventId ?? null,
});

/**
 * A page read is bracketed: the index must report the same progress, generation and newest event
 * after the rows were read as before. One change retries; a second returns retryable uncertainty.
 * This is not a trustless snapshot.
 */
export async function readHistoryPage(
  deps: HistoryDeps,
  configured: Configured,
  input: { readonly reviewer: string; readonly cursor: string | null; readonly limit: number },
  signal?: AbortSignal,
): Promise<PageOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await pageOnce(deps, configured, input, signal);
    if (outcome.kind !== 'ok' || deps.envio === null) return outcome;
    const after = await deps.envio.readMeta(signal);
    if (!after.ok)
      return {
        kind: 'unavailable',
        health: unavailable(deps, configured, [reasonForFailure(after.failure)]),
      };
    const seen = observationOf(after.data);
    const idx = outcome.page.health.index;
    const same =
      idx !== null
        ? seen.progress === idx.progressBlock && seen.generation === idx.generation
        : seen.generation === null;
    if (same) return outcome;
  }
  return { kind: 'unavailable', health: unavailable(deps, configured, ['METADATA_CHANGED']) };
}
