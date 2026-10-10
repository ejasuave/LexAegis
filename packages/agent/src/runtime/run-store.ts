import {
  isTerminalRunState,
  type AgentRunMetadataV1,
  type AssistantRunState,
  type RunOutcome,
  type RunUsage,
} from '../contracts';
import type { CapabilityRecord } from '../server/capability-record';
import { usageOf } from './budget';

/*
 * Operational run storage: the port the runtime needs for atomic admission, leases, durable
 * cancellation and shared quotas. A row holds opaque IDs, the authenticated owner, state,
 * deadlines and counters only. It never holds a matter ID, a title, a document reference, a
 * source hash, a snapshot digest, a prompt, an answer or a tool payload.
 */

export interface AdmissionLimits {
  readonly activePerOwner: number;
  readonly activeGlobal: number;
  readonly dailyPerOwner: number;
  readonly dailyGlobal: number;
}

export const DEFAULT_ADMISSION: AdmissionLimits = Object.freeze({
  activePerOwner: 1,
  activeGlobal: 3,
  dailyPerOwner: 20,
  dailyGlobal: 100,
});

/** Operator overrides can lower a limit, never raise it. */
export function resolveAdmission(
  overrides: Partial<Record<'activeGlobal' | 'dailyPerOwner' | 'dailyGlobal', number>> = {},
): AdmissionLimits {
  const lower = (value: number | undefined, ceiling: number): number =>
    value === undefined || !Number.isInteger(value) || value < 1
      ? ceiling
      : Math.min(value, ceiling);
  return {
    activePerOwner: DEFAULT_ADMISSION.activePerOwner,
    activeGlobal: lower(overrides.activeGlobal, DEFAULT_ADMISSION.activeGlobal),
    dailyPerOwner: lower(overrides.dailyPerOwner, DEFAULT_ADMISSION.dailyPerOwner),
    dailyGlobal: lower(overrides.dailyGlobal, DEFAULT_ADMISSION.dailyGlobal),
  };
}

/** A lease lasts this long without a heartbeat. An expired lease is an interrupted run. */
export const LEASE_MS = 15_000;
export const HEARTBEAT_MS = 1_000;
/** Terminal rows are removed after this; quota buckets after two UTC days. */
export const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
export const QUOTA_RETENTION_DAYS = 2;

export interface RunCounters {
  readonly providerAttempts: number;
  readonly toolExecutions: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reportedInputTokens: number | null;
  readonly reportedOutputTokens: number | null;
  readonly usageProvenance: RunUsage['provenance'];
}

export const ZERO_COUNTERS: RunCounters = Object.freeze({
  providerAttempts: 0,
  toolExecutions: 0,
  reservedInputTokens: 0,
  reservedOutputTokens: 0,
  reportedInputTokens: null,
  reportedOutputTokens: null,
  usageProvenance: 'none',
});

export interface RunRow extends RunCounters {
  readonly runId: string;
  readonly owner: string;
  readonly clientRequestId: string;
  readonly state: AssistantRunState;
  readonly outcome: RunOutcome | null;
  readonly cancelRequested: boolean;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdmitInput {
  readonly runId: string;
  readonly owner: string;
  readonly clientRequestId: string;
  readonly leaseToken: string;
  readonly now: Date;
  readonly deadlineAt: Date;
  readonly limits: AdmissionLimits;
}

export type AdmissionDenial = 'OWNER_ACTIVE' | 'GLOBAL_ACTIVE' | 'OWNER_DAILY' | 'GLOBAL_DAILY';

export type AdmitResult =
  | { readonly kind: 'admitted'; readonly row: RunRow }
  /** The same owner and request ID were admitted before. Nothing runs again. */
  | { readonly kind: 'duplicate'; readonly row: RunRow }
  | { readonly kind: 'denied'; readonly reason: AdmissionDenial };

export type TerminalState = Extract<
  AssistantRunState,
  'completed' | 'awaiting_input' | 'cancelled' | 'failed' | 'interrupted'
>;

export interface RunStore {
  /** Atomic across replicas: duplicate check, active limits, daily quotas and the insert. */
  admit(input: AdmitInput): Promise<AdmitResult>;
  /** Owner-bound lookup. Another owner's run is indistinguishable from a missing one. */
  get(runId: string, owner: string): Promise<RunRow | null>;
  /** queued -> running for the lease holder. False when cancelled meanwhile or fenced. */
  begin(runId: string, leaseToken: string, now: Date): Promise<boolean>;
  /** Renews the lease, records counters and reads the durable cancellation flag. */
  heartbeat(
    runId: string,
    leaseToken: string,
    now: Date,
    counters: RunCounters,
  ): Promise<{ readonly owned: boolean; readonly cancelRequested: boolean }>;
  /** Sets the durable flag; an active run becomes stopping. Idempotent. Owner-bound. */
  requestCancel(runId: string, owner: string, now: Date): Promise<RunRow | null>;
  /**
   * The single terminal transition, for the lease holder only. If cancellation was requested the
   * run ends cancelled whatever was asked for, so a completion and a cancel can never both win.
   * Null when the lease was lost or the run is already terminal.
   */
  finish(
    runId: string,
    leaseToken: string,
    desired: { readonly state: TerminalState; readonly outcome: RunOutcome },
    counters: RunCounters,
    now: Date,
  ): Promise<RunRow | null>;
  /** Expired leases become interrupted; old terminal rows and quota buckets are removed. */
  sweep(now: Date): Promise<{ readonly interrupted: number; readonly removed: number }>;
  capability(fingerprint: string): Promise<CapabilityRecord | null>;
  saveCapability(record: CapabilityRecord): Promise<void>;
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export function terminalFor(
  row: Pick<RunRow, 'cancelRequested'>,
  desired: {
    state: TerminalState;
    outcome: RunOutcome;
  },
): { state: TerminalState; outcome: RunOutcome } {
  return row.cancelRequested && desired.state !== 'interrupted'
    ? { state: 'cancelled', outcome: 'cancelled' }
    : desired;
}

/** The operational view of a run. This is all a status lookup ever returns. */
export function toRunMetadata(row: RunRow, repeatedAdmission = false): AgentRunMetadataV1 {
  return {
    schema: 'lexaegis.agent-run-metadata.v1',
    runId: row.runId,
    clientRequestId: row.clientRequestId,
    state: row.state,
    outcome: row.outcome,
    cancelRequested: row.cancelRequested,
    repeatedAdmission,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    usage: usageOf(row),
  };
}

export const isActive = (state: AssistantRunState): boolean => !isTerminalRunState(state);
