import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_FAULT_CANARIES, FAULTS, applyFault, judgeFault } from './faults';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const context = { receiverUrl: 'http://127.0.0.1:1/collect' };

describe('negative-control faults', () => {
  it('each fault still has exactly one place to go in the module that owns its boundary', () => {
    // A control whose anchor has drifted would crash instead of testing anything.
    for (const fault of FAULTS) {
      const source = readFileSync(join(ROOT, fault.file), 'utf8');
      const applied = applyFault(fault, source, context);
      expect(applied.ok, fault.id).toBe(true);
      if (!applied.ok) continue;
      expect(applied.text, fault.id).not.toBe(source);
      // The original statement is kept: a fault adds a mistake, it does not remove behaviour.
      expect(applied.text.length, fault.id).toBeGreaterThan(source.length);
    }
  });

  it('covers every boundary the task names, with unique IDs and synthetic markers only', () => {
    expect(new Set(FAULTS.map((fault) => fault.id)).size).toBe(FAULTS.length);
    const boundaries = FAULTS.map((fault) => fault.boundary).join('\n');
    for (const needed of [
      'built browser assets',
      'localStorage',
      'sessionStorage',
      'IndexedDB',
      'cookies',
      'Cache storage',
      'transient write',
      'CryptoKey',
      'application logger',
      'error path',
      'browser network',
      'server network',
      'inside a consented request',
    ]) {
      expect(boundaries, needed).toContain(needed);
    }
    expect(new Set(ALL_FAULT_CANARIES.map((canary) => canary.value)).size).toBe(
      ALL_FAULT_CANARIES.length,
    );
    for (const canary of ALL_FAULT_CANARIES) expect(canary.id).toMatch(/^fault-/);
  });

  it('reports an anchor that is missing or ambiguous instead of applying a fault somewhere else', () => {
    const fault = FAULTS[0];
    if (fault === undefined) throw new Error('no fault');
    expect(applyFault(fault, 'export const other = 1;', context)).toEqual({
      ok: false,
      reason: 'ANCHOR_MISSING',
    });
    expect(applyFault(fault, `${fault.find}\n${fault.find}`, context)).toEqual({
      ok: false,
      reason: 'ANCHOR_AMBIGUOUS',
    });
  });

  it('counts a fault as detected only by its own rule, boundary and canary', () => {
    const fault = FAULTS.find((item) => item.id === 'S1-signing-key-in-localStorage');
    if (fault === undefined) throw new Error('fault S1 is missing');
    const right =
      'CANARY_IN_FORBIDDEN_DESTINATION hud browser.localStorage signing_key fault-signing-key @ localStorage write "lexaegis.negative-control" during before-account';
    expect(judgeFault(fault, [right, 'JOURNEY_FAILED hud (exit 1)'])).toMatchObject({
      detected: true,
      matched: [right],
    });
    // A crash, another store or another canary is not a detection of this fault.
    for (const wrong of [
      'JOURNEY_FAILED hud (exit 1)',
      'OBSERVATIONS_MISSING hud',
      'CANARY_IN_FORBIDDEN_DESTINATION hud browser.sessionStorage signing_key fault-signing-key @ sessionStorage write "x" during before-account',
      'CANARY_IN_FORBIDDEN_DESTINATION hud browser.localStorage prf_output fault-prf-output @ localStorage write "x" during before-account',
    ]) {
      expect(judgeFault(fault, [wrong]).detected, wrong).toBe(false);
    }
  });

  it('the transient-write control fails if a snapshot, not the intercepted write, saw the value', () => {
    const fault = FAULTS.find((item) => item.id === 'S6-secret-written-then-deleted');
    if (fault === undefined) throw new Error('fault S6 is missing');
    const write =
      'CANARY_IN_FORBIDDEN_DESTINATION hud browser.localStorage prf_output fault-transient-secret @ localStorage write "lexaegis.negative-control.tmp" during before-account';
    const snapshot =
      'CANARY_IN_FORBIDDEN_DESTINATION hud browser.localStorage prf_output fault-transient-secret @ localStorage "lexaegis.negative-control.tmp" at after-lock';
    expect(judgeFault(fault, [write]).detected).toBe(true);
    expect(judgeFault(fault, [write, snapshot]).detected).toBe(false);
  });
});
