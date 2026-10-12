import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import deployment from '../../../../../contracts/deployments/monad-testnet.json';
import { activeDeploymentFile, localTestChainRequested, resolveDeployment } from './config';

/*
 * The loopback test-chain seam is inert unless the test chain flag, a test mode AND a record path are
 * all set. A deployed environment sets none of them, so production resolves the committed artifact.
 */

const directory = mkdtempSync(join(tmpdir(), 'seam-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const local = {
  ...deployment,
  registryAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  genesisHash: `0x${'11'.repeat(32)}`,
};
const file = join(directory, 'local.json');
writeFileSync(file, JSON.stringify(local));

describe('local test-chain seam', () => {
  it('is off by default and uses the committed testnet artifact', () => {
    expect(localTestChainRequested({})).toBe(false);
    expect(activeDeploymentFile({})).toBe(deployment);
  });

  it.each([
    ['no test mode', { LEXAEGIS_TEST_CHAIN: 'local-anvil', LEXAEGIS_TEST_CHAIN_DEPLOYMENT: file }],
    [
      'no record path',
      { LEXAEGIS_TEST_CHAIN: 'local-anvil', LEXAEGIS_TEST_MODE: 'scripted-assistant' },
    ],
    ['no flag', { LEXAEGIS_TEST_MODE: 'scripted-assistant', LEXAEGIS_TEST_CHAIN_DEPLOYMENT: file }],
    [
      'another flag value',
      {
        LEXAEGIS_TEST_CHAIN: 'public',
        LEXAEGIS_TEST_MODE: 'scripted-assistant',
        LEXAEGIS_TEST_CHAIN_DEPLOYMENT: file,
      },
    ],
  ])('stays off with %s', (_name, env) => {
    expect(localTestChainRequested(env)).toBe(false);
    expect(activeDeploymentFile(env)).toBe(deployment);
  });

  it('reads the local record only when all three are set', () => {
    const env = {
      LEXAEGIS_TEST_CHAIN: 'local-anvil',
      LEXAEGIS_TEST_MODE: 'scripted-assistant',
      LEXAEGIS_TEST_CHAIN_DEPLOYMENT: file,
    };
    expect(localTestChainRequested(env)).toBe(true);
    expect(activeDeploymentFile(env)).toEqual(local);
    expect(resolveDeployment(activeDeploymentFile(env))).toMatchObject({
      state: 'ready',
      policy: { registryAddress: local.registryAddress },
    });
  });

  it('an unreadable or invalid test record is invalid, never the public artifact', () => {
    const env = {
      LEXAEGIS_TEST_CHAIN: 'local-anvil',
      LEXAEGIS_TEST_MODE: 'scripted-assistant',
      LEXAEGIS_TEST_CHAIN_DEPLOYMENT: join(directory, 'absent.json'),
    };
    expect(activeDeploymentFile(env)).toBeNull();
    expect(resolveDeployment(activeDeploymentFile(env))).toEqual({ state: 'invalid' });
  });
});
