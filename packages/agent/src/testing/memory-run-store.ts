import type { CapabilityRecord } from '../server/capability-record';
import {
  LEASE_MS,
  QUOTA_RETENTION_DAYS,
  TERMINAL_RETENTION_MS,
  ZERO_COUNTERS,
  isActive,
  terminalFor,
  utcDay,
  type RunRow,
  type RunStore,
} from '../runtime/run-store';

/*
 * In-memory RunStore for tests of the runtime state machine. It follows the same contract suite
 * as the PostgreSQL store. It coordinates nothing across processes and is never used in
 * production: without DATABASE_URL the assistant is unavailable.
 */

export interface MemoryRunStore extends RunStore {
  readonly rows: Map<string, RunRow>;
  readonly quota: Map<string, number>;
}

export function createMemoryRunStore(): MemoryRunStore {
  const rows = new Map<string, RunRow>();
  const quota = new Map<string, number>();
  const capabilities = new Map<string, CapabilityRecord>();
  const put = (row: RunRow) => {
    rows.set(row.runId, row);
    return row;
  };
  const active = () => [...rows.values()].filter((row) => isActive(row.state));

  const sweep: RunStore['sweep'] = (now) => {
    let interrupted = 0;
    let removed = 0;
    for (const row of [...rows.values()]) {
      if (isActive(row.state) && row.leaseExpiresAt.getTime() < now.getTime()) {
        put({ ...row, state: 'interrupted', outcome: 'interrupted', updatedAt: now });
        interrupted += 1;
      } else if (
        !isActive(row.state) &&
        row.updatedAt.getTime() < now.getTime() - TERMINAL_RETENTION_MS
      ) {
        rows.delete(row.runId);
        removed += 1;
      }
    }
    const oldest = utcDay(new Date(now.getTime() - QUOTA_RETENTION_DAYS * 86_400_000));
    for (const key of [...quota.keys()]) {
      if ((key.split('|')[1] ?? '') < oldest) quota.delete(key);
    }
    return Promise.resolve({ interrupted, removed });
  };

  return {
    rows,
    quota,
    sweep,
    async admit(input) {
      await sweep(input.now);
      const existing = [...rows.values()].find(
        (row) => row.owner === input.owner && row.clientRequestId === input.clientRequestId,
      );
      if (existing !== undefined) return { kind: 'duplicate', row: existing };
      const day = utcDay(input.now);
      const ownerKey = `owner:${input.owner}|${day}`;
      const globalKey = `global|${day}`;
      const { limits } = input;
      if (active().filter((row) => row.owner === input.owner).length >= limits.activePerOwner)
        return { kind: 'denied', reason: 'OWNER_ACTIVE' };
      if (active().length >= limits.activeGlobal)
        return { kind: 'denied', reason: 'GLOBAL_ACTIVE' };
      if ((quota.get(ownerKey) ?? 0) >= limits.dailyPerOwner)
        return { kind: 'denied', reason: 'OWNER_DAILY' };
      if ((quota.get(globalKey) ?? 0) >= limits.dailyGlobal)
        return { kind: 'denied', reason: 'GLOBAL_DAILY' };
      quota.set(ownerKey, (quota.get(ownerKey) ?? 0) + 1);
      quota.set(globalKey, (quota.get(globalKey) ?? 0) + 1);
      return {
        kind: 'admitted',
        row: put({
          ...ZERO_COUNTERS,
          runId: input.runId,
          owner: input.owner,
          clientRequestId: input.clientRequestId,
          state: 'queued',
          outcome: null,
          cancelRequested: false,
          leaseToken: input.leaseToken,
          leaseExpiresAt: new Date(input.now.getTime() + LEASE_MS),
          deadlineAt: input.deadlineAt,
          createdAt: input.now,
          updatedAt: input.now,
        }),
      };
    },
    get(runId, owner) {
      const row = rows.get(runId);
      return Promise.resolve(row !== undefined && row.owner === owner ? row : null);
    },
    begin(runId, leaseToken, now) {
      const row = rows.get(runId);
      if (row === undefined || row.leaseToken !== leaseToken || row.state !== 'queued')
        return Promise.resolve(false);
      put({
        ...row,
        state: 'running',
        updatedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      });
      return Promise.resolve(true);
    },
    heartbeat(runId, leaseToken, now, counters) {
      const row = rows.get(runId);
      if (row === undefined || row.leaseToken !== leaseToken || !isActive(row.state))
        return Promise.resolve({ owned: false, cancelRequested: row?.cancelRequested ?? false });
      put({
        ...row,
        ...counters,
        updatedAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      });
      return Promise.resolve({ owned: true, cancelRequested: row.cancelRequested });
    },
    requestCancel(runId, owner, now) {
      const row = rows.get(runId);
      if (row === undefined || row.owner !== owner) return Promise.resolve(null);
      if (!isActive(row.state)) return Promise.resolve(row);
      return Promise.resolve(
        put({ ...row, cancelRequested: true, state: 'stopping', updatedAt: now }),
      );
    },
    finish(runId, leaseToken, desired, counters, now) {
      const row = rows.get(runId);
      if (row === undefined || row.leaseToken !== leaseToken || !isActive(row.state))
        return Promise.resolve(null);
      return Promise.resolve(
        put({ ...row, ...counters, ...terminalFor(row, desired), updatedAt: now }),
      );
    },
    capability: (fingerprint) => Promise.resolve(capabilities.get(fingerprint) ?? null),
    saveCapability(record) {
      capabilities.set(record.fingerprint, record);
      return Promise.resolve();
    },
  };
}
