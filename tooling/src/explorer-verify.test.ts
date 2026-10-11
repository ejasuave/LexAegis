import { describe, expect, it } from 'vitest';
import { checkOutgoing, explorerOutcome } from './explorer-verify';

const payload = (
  sources: Record<string, string>,
  settings: Record<string, unknown> = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'osaka',
  },
) =>
  JSON.stringify({
    language: 'Solidity',
    sources: Object.fromEntries(
      Object.entries(sources).map(([path, content]) => [path, { content }]),
    ),
    settings,
  });
const registry = { 'src/ProofOfReviewRegistry.sol': 'contract R {}' };

describe('outgoing source allowlist', () => {
  it('allows only registry sources, pinned OpenZeppelin sources and compiler settings', () => {
    const check = checkOutgoing(
      payload({
        ...registry,
        'node_modules/@openzeppelin/contracts/utils/Panic.sol': 'library P {}',
      }),
    );
    expect(check).toMatchObject({ ok: true, issues: [] });
    expect(check.sources.map((source) => source.path)).toEqual([
      'src/ProofOfReviewRegistry.sol',
      'node_modules/@openzeppelin/contracts/utils/Panic.sol',
    ]);
  });
  it('stops on an environment file, a broadcast log, a test, another dependency or a traversal', () => {
    for (const path of [
      '.env',
      'broadcast/DeployRegistry.s.sol/10143/run-latest.json',
      'test/Authorization.t.sol',
      'node_modules/forge-std/src/Vm.sol',
      'src/../.env.sol',
      'src/.hidden.sol',
      'deployments/monad-testnet.json',
    ]) {
      const check = checkOutgoing(payload({ ...registry, [path]: 'x' }));
      expect(check.ok, path).toBe(false);
      expect(check.issues).toEqual([`SOURCE_NOT_ALLOWED ${path}`]);
    }
  });
  it('stops on an unknown settings key, a missing registry source and an unreadable payload', () => {
    expect(checkOutgoing(payload(registry, { optimizer: {}, apiKey: 'x' })).issues).toEqual([
      'SETTING_NOT_ALLOWED apiKey',
    ]);
    expect(checkOutgoing(payload({ 'src/Other.sol': 'x' })).issues).toEqual([
      'REGISTRY_SOURCE_MISSING',
    ]);
    expect(checkOutgoing('not json')).toMatchObject({ ok: false, issues: ['PAYLOAD_UNREADABLE'] });
    expect(
      checkOutgoing(JSON.stringify({ language: 'Solidity', sources: {}, settings: {}, extra: 1 }))
        .ok,
    ).toBe(false);
  });
});

describe('explorer outcome', () => {
  const expected = { chainId: '10143', address: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f' };
  const status = (match: string | null, over: object = {}) => ({
    match,
    creationMatch: match,
    runtimeMatch: match,
    chainId: '10143',
    address: '0x453BFd1602d8A8666F55bF9A8D87B127cB94048f',
    ...over,
  });
  it('is verified only for a non-null match on exactly this chain and address', () => {
    expect(explorerOutcome(status('match'), expected)).toBe('verified');
    expect(explorerOutcome(status('exact_match'), expected)).toBe('verified');
    expect(explorerOutcome(status(null), expected)).toBe('not_verified');
    expect(explorerOutcome(null, expected)).toBe('unavailable');
    expect(explorerOutcome(status('match', { chainId: '143' }), expected)).toBe('unavailable');
    expect(explorerOutcome(status('match', { address: `0x${'11'.repeat(20)}` }), expected)).toBe(
      'unavailable',
    );
  });
});
