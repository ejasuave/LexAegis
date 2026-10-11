import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import { expectedReviewersPolicy } from '@lexaegis/sdk/offline';
import { verifyReviewExport } from '@lexaegis/sdk/verify';
import { prepareLocalPackage } from './harness';
import { exportBytes, startLocalRegistry, type LocalRegistry } from './local-registry';

/*
 * LOCAL COMPATIBILITY EVIDENCE ONLY (Anvil, chain 31337). The SDK README's ten-line example is
 * extracted from the README itself and executed as a separate process against the unchanged
 * compiled registry, using only public entry points. Not Monad evidence, not package publication.
 */

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, '..', '..', 'packages', 'sdk', 'README.md'), 'utf8');
const example = /```ts\n(import \{ readFile \}[\s\S]*?)```/.exec(readme)?.[1] ?? '';
// The README documents `allowLoopbackHttp` for a throwaway local chain: only that is added.
const TRANSPORT = "transport: { kind: 'rpc', url: process.env.REVIEW_RPC_URL ?? '' }";
const local = (source: string) =>
  source.replace(
    TRANSPORT,
    "transport: { kind: 'rpc', url: process.env.REVIEW_RPC_URL ?? '', allowLoopbackHttp: true }",
  );

let chain: LocalRegistry;
let prepared: PreparedReviewPackage;
const scratch: string[] = [];

/** Runs the extracted README example in a fresh directory containing only its documented inputs. */
function runReadme(inputs: { file: Uint8Array; expected: unknown; policy: unknown; rpc: string }) {
  const directory = mkdtempSync(join(here, '.readme-run-'));
  scratch.push(directory);
  writeFileSync(join(directory, 'review-export.json'), inputs.file);
  writeFileSync(join(directory, 'expected-reference.json'), JSON.stringify(inputs.expected));
  writeFileSync(join(directory, 'registry-policy.json'), JSON.stringify(inputs.policy));
  writeFileSync(join(directory, 'example.mts'), local(example));
  const run = spawnSync('pnpm', ['exec', 'tsx', 'example.mts'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_RPC_URL: inputs.rpc },
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  chain = await startLocalRegistry();
  prepared = await prepareLocalPackage('legal', chain.binding, null);
  await chain.mine();
});
afterAll(async () => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
  await chain.stop();
});

describe('SDK README example against the real local registry', () => {
  it('the README example is present and unmodified except for the documented loopback flag', () => {
    expect(example).toContain('verifyReviewExport');
    expect(example).toContain(TRANSPORT);
    expect(
      example.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('import')).length,
    ).toBeLessThanOrEqual(12);
  });

  it('reports not_found before issue, from a verified read, with local integrity intact', () => {
    const report = runReadme({
      file: exportBytes(prepared),
      expected: prepared.reference,
      policy: chain.policy,
      rpc: chain.local.rpcUrl,
    });
    expect(report).toMatchObject({
      referenceOrigin: 'independent',
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      registryIdentity: 'match',
      chainStatus: 'not_found',
      signerAcceptance: 'unknown',
    });
  });

  it('reports active, then revoked, from real contract records', async () => {
    await chain.issue(prepared);
    const inputs = {
      file: exportBytes(prepared),
      expected: prepared.reference,
      policy: chain.policy,
      rpc: chain.local.rpcUrl,
    };
    expect(runReadme(inputs)).toMatchObject({
      chainStatus: 'active',
      receiptBinding: 'match',
      registryIdentity: 'match',
    });
    await chain.revoke(prepared.reference);
    expect(runReadme(inputs)).toMatchObject({ chainStatus: 'revoked', artifactIntegrity: 'match' });
  });

  it('keeps local integrity when the RPC is unavailable and never calls that not_found', () => {
    const report = runReadme({
      file: exportBytes(prepared),
      expected: prepared.reference,
      policy: chain.policy,
      rpc: 'http://127.0.0.1:9',
    });
    expect(report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      chainStatus: 'unknown',
    });
  });

  it('a caller policy that does not accept the reviewer stays a rejection, even for an active receipt', async () => {
    const second = await prepareLocalPackage('legal-revised', chain.binding, null);
    await chain.issue(second);
    const result = await verifyReviewExport({
      file: exportBytes(second),
      expectedReference: second.reference,
      live: {
        policy: chain.policy,
        transport: { kind: 'rpc', url: `${chain.local.rpcUrl}/`, allowLoopbackHttp: true },
      },
      signerPolicy: expectedReviewersPolicy('test.someone-else', [`0x${'99'.repeat(20)}`]),
    });
    expect(result.ok && result.data.report).toMatchObject({
      chainStatus: 'active',
      signerAcceptance: 'rejected',
    });
  });

  it('a substituted bundle is caught by the independent reference on the real chain', async () => {
    const other = await prepareLocalPackage('legal-revised', chain.binding, null);
    const report = runReadme({
      file: exportBytes(other), // a different, internally consistent package
      expected: prepared.reference, // the receipt the recipient actually expects
      policy: chain.policy,
      rpc: chain.local.rpcUrl,
    });
    expect(report).toMatchObject({ manifestIntegrity: 'mismatch', artifactIntegrity: 'unknown' });
  });
});
