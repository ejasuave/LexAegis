import { describe, expect, it } from 'vitest';
import { parseConfirmedLifecycle, parseLiveState } from './live-state';

const ok = {
  status: 'ok',
  blockNumber: '12',
  blockTimestamp: '1700000000',
  observedAt: '2026-10-11T10:00:00.000Z',
  registryNonce: '3',
  receiptLifecycle: 'not_found',
};

describe('live state parsing', () => {
  it('accepts exactly the route shape', () => {
    expect(parseLiveState(ok)).toMatchObject({ status: 'ok', registryNonce: '3' });
  });
  it('treats anything malformed as unknown, never as absent', () => {
    for (const bad of [
      null,
      'x',
      { ...ok, receiptLifecycle: 'valid' },
      { ...ok, registryNonce: '-1' },
      { ...ok, observedAt: 'yesterday' },
      { status: 'unknown', reason: 'RPC_UNAVAILABLE' },
    ]) {
      expect(parseLiveState(bad).status).toBe('unknown');
    }
  });
  it('reads the confirmed lifecycle with its block, and never invents one', () => {
    const good = parseConfirmedLifecycle({
      status: 'ok',
      receipt: { receiptLifecycle: 'revoked' },
      checkpoint: { blockNumber: '9', blockTimestamp: '1', observedAt: 'x' },
    });
    expect(good).toMatchObject({ status: 'ok', receiptLifecycle: 'revoked', blockNumber: '9' });
    expect(
      parseConfirmedLifecycle({ status: 'ok', receipt: { receiptLifecycle: 'active' } }).status,
    ).toBe('unknown');
    expect(parseConfirmedLifecycle({ status: 'unknown', reason: 'RPC_UNAVAILABLE' })).toEqual({
      status: 'unknown',
      reason: 'RPC_UNAVAILABLE',
    });
  });
});
