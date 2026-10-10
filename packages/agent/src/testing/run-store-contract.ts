import { describe, expect, it } from 'vitest';
import type { CapabilityRecord } from '../server/capability-record';
import {
  DEFAULT_ADMISSION,
  LEASE_MS,
  ZERO_COUNTERS,
  toRunMetadata,
  type AdmitInput,
  type RunCounters,
  type RunStore,
} from '../runtime/run-store';

/*
 * lexaegis-test-only
 * The behaviour every RunStore must have, run against the in-memory store and against real
 * PostgreSQL. Imported by tests only.
 */

const T0 = new Date('2026-10-10T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const OWNER_A = `0x${'aa'.repeat(20)}`;
const OWNER_B = `0x${'bb'.repeat(20)}`;
let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;

const input = (over: Partial<AdmitInput> = {}): AdmitInput => ({
  runId: uuid(),
  owner: OWNER_A,
  clientRequestId: uuid(),
  leaseToken: uuid(),
  now: T0,
  deadlineAt: at(120_000),
  limits: DEFAULT_ADMISSION,
  ...over,
});

const counters: RunCounters = {
  providerAttempts: 2,
  toolExecutions: 1,
  reservedInputTokens: 9000,
  reservedOutputTokens: 2560,
  reportedInputTokens: 700,
  reportedOutputTokens: 90,
  usageProvenance: 'provider_reported',
};

export function describeRunStore(name: string, create: () => Promise<RunStore> | RunStore): void {
  describe(`RunStore contract: ${name}`, () => {
    it('admits a run as queued with zero counters and a lease', async () => {
      const store = await create();
      const run = input();
      const admitted = await store.admit(run);
      expect(admitted.kind).toBe('admitted');
      if (admitted.kind !== 'admitted') return;
      expect(admitted.row).toMatchObject({
        runId: run.runId,
        owner: OWNER_A,
        state: 'queued',
        outcome: null,
        cancelRequested: false,
        ...ZERO_COUNTERS,
      });
      expect(admitted.row.leaseExpiresAt.getTime()).toBe(T0.getTime() + LEASE_MS);
      expect(toRunMetadata(admitted.row)).toMatchObject({
        state: 'queued',
        repeatedAdmission: false,
      });
    });

    it('treats a repeated request ID as repeated admission and returns the existing run', async () => {
      const store = await create();
      const first = input();
      await store.admit(first);
      const again = await store.admit(input({ clientRequestId: first.clientRequestId }));
      expect(again.kind).toBe('duplicate');
      expect(again.kind === 'duplicate' && again.row.runId).toBe(first.runId);
      // The same request ID under another owner is a different run.
      const other = await store.admit(
        input({ clientRequestId: first.clientRequestId, owner: OWNER_B }),
      );
      expect(other.kind).toBe('admitted');
    });

    it('allows one active run per account and three globally', async () => {
      const store = await create();
      expect((await store.admit(input())).kind).toBe('admitted');
      expect(await store.admit(input())).toEqual({ kind: 'denied', reason: 'OWNER_ACTIVE' });
      expect((await store.admit(input({ owner: OWNER_B }))).kind).toBe('admitted');
      expect((await store.admit(input({ owner: `0x${'cc'.repeat(20)}` }))).kind).toBe('admitted');
      expect(await store.admit(input({ owner: `0x${'dd'.repeat(20)}` }))).toEqual({
        kind: 'denied',
        reason: 'GLOBAL_ACTIVE',
      });
    });

    it('lets exactly one of many concurrent admissions for an account win', async () => {
      const store = await create();
      const results = await Promise.all(Array.from({ length: 12 }, () => store.admit(input())));
      expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'denied')).toHaveLength(11);
    });

    it('enforces daily quotas per account and globally, per UTC day', async () => {
      const store = await create();
      const limits = { ...DEFAULT_ADMISSION, dailyPerOwner: 2, dailyGlobal: 3 };
      const runAndFinish = async (owner: string, now: Date) => {
        const run = input({ owner, now, limits, deadlineAt: new Date(now.getTime() + 120_000) });
        const admitted = await store.admit(run);
        if (admitted.kind === 'admitted') {
          await store.finish(
            run.runId,
            run.leaseToken,
            { state: 'completed', outcome: 'completed' },
            ZERO_COUNTERS,
            now,
          );
        }
        return admitted;
      };
      expect((await runAndFinish(OWNER_A, T0)).kind).toBe('admitted');
      expect((await runAndFinish(OWNER_A, T0)).kind).toBe('admitted');
      expect(await runAndFinish(OWNER_A, T0)).toEqual({ kind: 'denied', reason: 'OWNER_DAILY' });
      expect((await runAndFinish(OWNER_B, T0)).kind).toBe('admitted');
      expect(await runAndFinish(OWNER_B, T0)).toEqual({ kind: 'denied', reason: 'GLOBAL_DAILY' });
      // A denied admission consumes nothing, and the next UTC day starts fresh.
      const tomorrow = at(24 * 60 * 60 * 1000);
      expect((await runAndFinish(OWNER_A, tomorrow)).kind).toBe('admitted');
    });

    it('binds lookups and cancellation to the owner without revealing a run of another account', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      expect(await store.get(run.runId, OWNER_B)).toBeNull();
      expect(await store.requestCancel(run.runId, OWNER_B, at(10))).toBeNull();
      expect(await store.get(uuid(), OWNER_A)).toBeNull();
      expect((await store.get(run.runId, OWNER_A))?.cancelRequested).toBe(false);
    });

    it('moves through running to one terminal state and records counters', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      expect(await store.begin(run.runId, run.leaseToken, at(5))).toBe(true);
      expect(await store.begin(run.runId, run.leaseToken, at(6))).toBe(false);
      expect(await store.heartbeat(run.runId, run.leaseToken, at(1000), counters)).toEqual({
        owned: true,
        cancelRequested: false,
      });
      const done = await store.finish(
        run.runId,
        run.leaseToken,
        { state: 'awaiting_input', outcome: 'needs_input' },
        counters,
        at(2000),
      );
      expect(done).toMatchObject({ state: 'awaiting_input', outcome: 'needs_input', ...counters });
      // A second terminal transition is refused: one outcome only.
      expect(
        await store.finish(
          run.runId,
          run.leaseToken,
          { state: 'failed', outcome: 'failed' },
          counters,
          at(2001),
        ),
      ).toBeNull();
      expect((await store.get(run.runId, OWNER_A))?.state).toBe('awaiting_input');
      // The account may start another run once this one is terminal.
      expect((await store.admit(input({ now: at(3000), deadlineAt: at(123_000) }))).kind).toBe(
        'admitted',
      );
    });

    it('makes cancellation durable and lets it win a race with completion', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      await store.begin(run.runId, run.leaseToken, at(5));
      const stopping = await store.requestCancel(run.runId, OWNER_A, at(500));
      expect(stopping).toMatchObject({ state: 'stopping', cancelRequested: true });
      // Seen from any replica through the durable flag.
      expect(await store.heartbeat(run.runId, run.leaseToken, at(600), counters)).toEqual({
        owned: true,
        cancelRequested: true,
      });
      // Repeated Stop is idempotent.
      expect(await store.requestCancel(run.runId, OWNER_A, at(650))).toMatchObject({
        state: 'stopping',
      });
      const finished = await store.finish(
        run.runId,
        run.leaseToken,
        { state: 'completed', outcome: 'completed' },
        counters,
        at(700),
      );
      expect(finished).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
      // Stop after the end changes nothing.
      expect(await store.requestCancel(run.runId, OWNER_A, at(800))).toMatchObject({
        state: 'cancelled',
      });
    });

    it('cancels a queued run before it starts', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      await store.requestCancel(run.runId, OWNER_A, at(1));
      expect(await store.begin(run.runId, run.leaseToken, at(2))).toBe(false);
      expect(
        await store.finish(
          run.runId,
          run.leaseToken,
          { state: 'cancelled', outcome: 'cancelled' },
          ZERO_COUNTERS,
          at(3),
        ),
      ).toMatchObject({ state: 'cancelled' });
    });

    it('turns an expired lease into interrupted, never completed, and fences the old worker', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      await store.begin(run.runId, run.leaseToken, at(5));
      expect(await store.sweep(at(LEASE_MS - 1000))).toMatchObject({ interrupted: 0 });
      expect(await store.sweep(at(LEASE_MS + 1000))).toMatchObject({ interrupted: 1 });
      expect(await store.get(run.runId, OWNER_A)).toMatchObject({
        state: 'interrupted',
        outcome: 'interrupted',
      });
      expect(
        await store.heartbeat(run.runId, run.leaseToken, at(LEASE_MS + 1500), counters),
      ).toMatchObject({
        owned: false,
      });
      expect(
        await store.finish(
          run.runId,
          run.leaseToken,
          { state: 'completed', outcome: 'completed' },
          counters,
          at(LEASE_MS + 2000),
        ),
      ).toBeNull();
      // The interrupted run no longer blocks the account.
      const next = input({ now: at(LEASE_MS + 3000), deadlineAt: at(LEASE_MS + 123_000) });
      expect((await store.admit(next)).kind).toBe('admitted');
    });

    it('a stale lease token cannot heartbeat or finish a run', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      await store.begin(run.runId, run.leaseToken, at(5));
      const wrong = uuid();
      expect(await store.heartbeat(run.runId, wrong, at(10), counters)).toMatchObject({
        owned: false,
      });
      expect(
        await store.finish(
          run.runId,
          wrong,
          { state: 'completed', outcome: 'completed' },
          counters,
          at(11),
        ),
      ).toBeNull();
      expect((await store.get(run.runId, OWNER_A))?.state).toBe('running');
    });

    it('removes terminal rows after 24 hours and keeps recent ones', async () => {
      const store = await create();
      const run = input();
      await store.admit(run);
      await store.finish(
        run.runId,
        run.leaseToken,
        { state: 'completed', outcome: 'completed' },
        counters,
        at(1000),
      );
      const day = 24 * 60 * 60 * 1000;
      expect(await store.sweep(at(day - 1000))).toMatchObject({ removed: 0 });
      expect(await store.sweep(at(day + 2000))).toMatchObject({ removed: 1 });
      expect(await store.get(run.runId, OWNER_A)).toBeNull();
    });

    it('stores a capability record by configuration fingerprint only', async () => {
      const store = await create();
      const record: CapabilityRecord = {
        schema: 'lexaegis.assistant-capability.v1',
        fingerprint: `0x${'7e'.repeat(32)}`,
        provider: 'scripted-test',
        model: 'qwen3.8-max',
        region: 'test-loopback',
        outputMode: 'json_schema',
        nativeToolCalls: true,
        structuredOutput: true,
        usageReported: true,
        cancellation: true,
        returnedModel: 'scripted-test-model',
        requestIds: ['scripted-1'],
        failures: [],
        checkedAt: '2026-10-10T12:00:00.000Z',
        verified: true,
      };
      expect(await store.capability(record.fingerprint)).toBeNull();
      await store.saveCapability(record);
      expect(await store.capability(record.fingerprint)).toEqual(record);
      // A changed endpoint, model or output mode has another fingerprint and no record.
      expect(await store.capability(`0x${'7f'.repeat(32)}`)).toBeNull();
      await store.saveCapability({ ...record, verified: false, cancellation: false });
      expect((await store.capability(record.fingerprint))?.verified).toBe(false);
    });
  });
}
