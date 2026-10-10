import { describe, expect, it } from 'vitest';
import { createMemoryRunStore } from '../testing/memory-run-store';
import { describeRunStore } from '../testing/run-store-contract';
import { DEFAULT_ADMISSION, resolveAdmission } from './run-store';

describeRunStore('in-memory (tests only)', () => createMemoryRunStore());

describe('admission limits', () => {
  it('can be lowered by configuration and never raised', () => {
    expect(resolveAdmission()).toEqual(DEFAULT_ADMISSION);
    expect(resolveAdmission({ activeGlobal: 1, dailyPerOwner: 5, dailyGlobal: 10 })).toEqual({
      activePerOwner: 1,
      activeGlobal: 1,
      dailyPerOwner: 5,
      dailyGlobal: 10,
    });
    expect(resolveAdmission({ activeGlobal: 50, dailyPerOwner: 1000, dailyGlobal: 0 })).toEqual(
      DEFAULT_ADMISSION,
    );
  });
});
