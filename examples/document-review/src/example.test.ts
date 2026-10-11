import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareExample } from './prepare';
import { PROFILE } from './profile';
import { verifyExample } from './verify';

const context = {
  chainId: '10143',
  registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
  reviewerAddress: '0x2222222222222222222222222222222222222222',
};

describe('document-review example', () => {
  it('prepares an unapproved package with a fresh random opening each time', async () => {
    const [a, b] = await Promise.all([prepareExample(context), prepareExample(context)]);
    expect(a.reference.commitment).not.toBe(b.reference.commitment);
    expect(a.prepared.opening.manifest.profile).toEqual(PROFILE);
    expect(a.typedData).toBeNull();
  });

  it('verifies its own bundle against an explicit expected reference, offline', async () => {
    const { exportBytes, reference } = await prepareExample(context);
    const output = await verifyExample({ bundle: exportBytes, expectedReference: reference });
    expect(output.ok && output.report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      referenceOrigin: 'independent',
      chainStatus: 'unknown',
      signerAcceptance: 'unknown',
      profileSemantics: 'not_evaluated',
    });
  });

  it('a different package is not accepted under the reference you expected', async () => {
    const original = await prepareExample(context);
    const other = await prepareExample(context);
    const output = await verifyExample({
      bundle: other.exportBytes,
      expectedReference: original.reference,
    });
    expect(output.ok && output.report.manifestIntegrity).toBe('mismatch');
  });

  it('rejects the wrong kind of file with a specific code', async () => {
    const output = await verifyExample({
      bundle: new TextEncoder().encode('{"schema":"lexaegis.encrypted-review-export.v1"}'),
      expectedReference: {},
    });
    expect(output).toEqual({ ok: false, code: 'WRONG_FORMAT_ENCRYPTED_BACKUP' });
  });

  it('builds typed signing data from explicit nonce and deadline and signs nothing', async () => {
    const result = await prepareExample({ ...context, nonce: '7', deadline: '1900000000' });
    expect(result.typedData).toMatchObject({
      primaryType: 'ReviewAction',
      domain: { chainId: '10143', verifyingContract: context.registryAddress },
      message: { nonce: '7', deadline: '1900000000', commitment: result.reference.commitment },
    });
    expect(JSON.stringify(result.typedData)).not.toMatch(/signature|privateKey/i);
    await expect(prepareExample({ ...context, nonce: '7' })).rejects.toThrow();
  });

  it('uses only public entry points and no employment, model, wallet or app code', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const name of readdirSync(dir).filter(
      (file) => /\.ts$/.test(file) && !/test/.test(file),
    )) {
      const text = readFileSync(join(dir, name), 'utf8');
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        expect(specifier, `${name} imports ${specifier}`).toMatch(
          /^(?:\.\/|node:|@lexaegis\/(?:protocol(?:\/v1|\/portable)?|sdk(?:\/(?:portable|registry|offline|verify))?)$)/,
        );
      }
      expect(text).not.toMatch(/employment|qwen|mera|privateKey|process\.argv.*key/i);
    }
  });
});
