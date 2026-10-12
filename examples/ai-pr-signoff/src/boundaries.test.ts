import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildIssueAction } from '@lexaegis/sdk/registry';
import { bindIssue } from './issue.js';
import { prepareSignoffPackage } from './package.js';

const src = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(src).filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name));
const text = (name: string): string => readFileSync(join(src, name), 'utf8');

describe('example boundaries', () => {
  it('binds the same ISSUE action as the SDK builder', async () => {
    const encoder = new TextEncoder();
    const diff = encoder.encode('d\n');
    const summary = encoder.encode('s\n');
    const { inputDigests } = await import('./package.js');
    const digests = await inputDigests(diff, summary);
    const reviewer = '0x2222222222222222222222222222222222222222';
    const decision = encoder.encode(
      JSON.stringify({
        schema: 'lexaegis.ai-pr-signoff.decision.v1',
        reviewer,
        decision: 'approve-review-package',
        ...digests,
        rationale: 'r',
        decidedAt: '2026-10-12T09:00:00.000Z',
      }),
    );
    const prepared = await prepareSignoffPackage(
      { diff, summary, decision },
      {
        chainId: '10143',
        registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
        reviewerAddress: reviewer,
      },
    );
    if (!prepared.ok) throw new Error('fixture');
    const sdk = buildIssueAction(prepared.prepared, '3', '1900000000');
    expect(sdk.ok && sdk.data).toEqual(bindIssue(prepared.prepared.reference, '3', '1900000000'));
  });

  it('imports no legal-app, reference-account, agent or CLI code', () => {
    for (const name of sources) {
      for (const match of text(name).matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        expect(specifier, `${name} imports ${specifier}`).toMatch(
          /^(?:\.\/|node:|viem(?:\/accounts)?$|zod$|@lexaegis\/(?:protocol(?:\/v1|\/portable)?|sdk(?:\/(?:registry|offline|verify|transactions))?|vault(?:\/v1)?)$)/,
        );
      }
    }
  });

  it('only the issue command can read the operator key; verify and export never do', () => {
    const cli = text('cli.ts');
    expect(cli.match(/AI_PR_SIGNOFF_OPERATOR_KEY/g)?.length).toBeGreaterThan(0);
    for (const name of [
      'verify.ts',
      'export.ts',
      'storage.ts',
      'package.ts',
      'guards.ts',
      'inputs.ts',
      'issue.ts',
      'chain.ts',
    ])
      expect(text(name), name).not.toMatch(/OPERATOR_KEY|process\.env/);
    const verifyBranch = cli.slice(
      cli.indexOf("command === 'verify'"),
      cli.indexOf("command === 'export'"),
    );
    expect(verifyBranch).not.toMatch(/OPERATOR_KEY|privateKeyToAccount/);
    const exportBranch = cli.slice(cli.indexOf("command === 'export'"));
    expect(exportBranch).not.toMatch(/OPERATOR_KEY|privateKeyToAccount/);
  });

  it('never derives the storage key from, or writes it beside, anything', () => {
    const storage = text('storage.ts');
    expect(storage).not.toMatch(/privateKey|signTypedData/);
    expect(text('cli.ts')).toMatch(/storage key must differ from the signing key/);
  });
});
