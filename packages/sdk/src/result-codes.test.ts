import { describe, expect, it } from 'vitest';
import { PORTABLE_ERROR_CODES } from '@lexaegis/protocol/portable';
import { PROTOCOL_ERROR_CODES } from '@lexaegis/protocol/v1';
import { BUDGET_FAILURES } from './registry/budget';
import { REGISTRY_ERROR_CODES } from './registry/errors';
import { LIVE_UNKNOWN_REASONS } from './registry/live-reader';
import { RPC_CONFIG_ERRORS } from './registry/rpc-client';
import { REPORT_ISSUE_CODES } from './verification/report';
import { RESULT_CODE_CATALOG, describeResultCode, type ResultCodeFamily } from './result-codes';

const SOURCES: Record<ResultCodeFamily, readonly string[]> = {
  protocol: PROTOCOL_ERROR_CODES,
  export: PORTABLE_ERROR_CODES,
  registry: REGISTRY_ERROR_CODES,
  'report-issue': REPORT_ISSUE_CODES,
  'live-reason': LIVE_UNKNOWN_REASONS,
  budget: BUDGET_FAILURES,
  'rpc-config': RPC_CONFIG_ERRORS,
};

describe('result-code catalog', () => {
  it.each(Object.entries(SOURCES))(
    'documents exactly the %s codes the source defines',
    (family, codes) => {
      const documented = RESULT_CODE_CATALOG.filter((entry) => entry.family === family).map(
        (entry) => entry.code,
      );
      expect(documented).toEqual([...codes]);
    },
  );

  it('gives every code a cause and a retryability, and no duplicate within a family', () => {
    const seen = new Set<string>();
    for (const entry of RESULT_CODE_CATALOG) {
      expect(entry.cause.length, entry.code).toBeGreaterThan(10);
      expect(['no', 'after-fix', 'transient', 'informational']).toContain(entry.retry);
      const key = `${entry.family}:${entry.code}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('never treats an unavailable chain as a final answer', () => {
    for (const code of ['LIVE_RPC_UNAVAILABLE', 'LIVE_TIMEOUT', 'LIVE_DEADLINE', 'LIVE_ABORTED']) {
      expect(describeResultCode('report-issue', code)?.retry).toBe('transient');
    }
    expect(describeResultCode('report-issue', 'COMMITMENT_MISMATCH')?.retry).toBe('no');
    expect(describeResultCode('report-issue', 'NOT_A_CODE')).toBeUndefined();
  });
});
