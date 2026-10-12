import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bytesToHex, verifyReviewPackage } from '@lexaegis/protocol/v1';
import { prepareSignoffPackage } from './package.js';

/*
 * INDEPENDENT CROSS-CHECK. The new profile's package is verified by Chapter 15's Python checker, which
 * uses only the standard library and the written specification. The expected values below come from
 * the TypeScript implementation (there is no frozen golden for a package that did not exist when the
 * vectors were published), so this proves the two implementations agree on the new profile; it is not
 * an independent source of truth. The published vectors are not touched.
 */

const repository = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const fixtures = join(repository, 'examples', 'ai-pr-signoff', 'fixtures');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, name)));
const utf8 = (value: unknown): { encoding: 'utf8'; value: string } => ({
  encoding: 'utf8',
  value: typeof value === 'string' ? value : JSON.stringify(value),
});
const b64 = (data: Uint8Array): { encoding: 'base64'; value: string } => ({
  encoding: 'base64',
  value: Buffer.from(data).toString('base64'),
});

describe('Python cross-check of the lexaegis.ai-pr-signoff profile', () => {
  it('agrees with the TypeScript implementation on every operation, including a tampered file', async () => {
    const result = await prepareSignoffPackage(
      {
        diff: bytes('pr-42.diff'),
        summary: bytes('ai-review-summary.md'),
        decision: bytes('decision.json'),
      },
      {
        chainId: '10143',
        registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
        reviewerAddress: '0x2222222222222222222222222222222222222222',
      },
    );
    if (!result.ok) throw new Error('fixture');
    const { prepared } = result;
    const opening = utf8(prepared.opening);
    const artifacts = prepared.artifactIds.map((id) => ({
      id,
      ...b64(prepared.artifactBytes(id)),
    }));
    const reference = utf8(prepared.reference);

    const tamperedArtifacts = artifacts.map((item, index) =>
      index === 0 ? { id: item.id, ...b64(new TextEncoder().encode('tampered')) } : item,
    );
    const tampered = await verifyReviewPackage(
      prepared.opening,
      new Map(
        tamperedArtifacts.map((item) => [
          item.id,
          new Uint8Array(Buffer.from(item.value, 'base64')),
        ]),
      ),
      prepared.reference,
    );
    if (!tampered.ok) throw new Error('fixture');

    const cases = [
      {
        id: 'signoff-canonical-manifest',
        stage: 'canonicalization',
        operation: 'canonical-manifest',
        input: opening,
        expected: {
          outcome: 'ok',
          canonicalUtf8Hex: bytesToHex(prepared.canonicalManifestBytes()),
        },
      },
      {
        id: 'signoff-package-digest',
        stage: 'digest',
        operation: 'package-digest',
        input: { encoding: 'hex', value: bytesToHex(prepared.canonicalManifestBytes()) },
        expected: { outcome: 'ok', digest: prepared.packageDigest },
      },
      {
        id: 'signoff-commitment',
        stage: 'commitment',
        operation: 'commitment',
        input: {
          blindingNonce: prepared.opening.blindingNonce,
          packageDigest: prepared.packageDigest,
        },
        expected: { outcome: 'ok', commitment: prepared.reference.commitment },
      },
      {
        id: 'signoff-verify-full',
        stage: 'verification',
        operation: 'verify-package',
        input: { opening, artifacts, expectedReference: reference },
        expected: {
          outcome: 'ok',
          manifestIntegrity: 'match',
          artifactIntegrity: 'match',
          issues: [],
        },
      },
      {
        id: 'signoff-verify-tampered-diff',
        stage: 'verification',
        operation: 'verify-package',
        input: { opening, artifacts: tamperedArtifacts, expectedReference: reference },
        expected: {
          outcome: 'ok',
          manifestIntegrity: tampered.data.manifestIntegrity,
          artifactIntegrity: tampered.data.artifactIntegrity,
          issues: tampered.data.issues.map((issue) => ({
            code: issue.code,
            artifactId: issue.artifactId,
          })),
        },
      },
    ];
    expect(tampered.data.artifactIntegrity).toBe('mismatch');

    const directory = mkdtempSync(join(tmpdir(), 'signoff-interop-'));
    try {
      const file = join(directory, 'vectors.json');
      writeFileSync(
        file,
        JSON.stringify({
          format: 'lexaegis.protocol-test-vectors/1',
          protocolVersion: '1',
          domains: {
            package: 'lexaegis:review-package:v1',
            commitment: 'lexaegis:review-commitment:v1',
          },
          goldens: [],
          cases,
        }),
      );
      const python = spawnSync(
        'python3',
        [
          '-I',
          join(repository, 'examples', 'python-verify', 'verify_vectors.py'),
          '--vectors',
          file,
          '--table',
        ],
        { encoding: 'utf8' },
      );
      expect(python.stdout, python.stderr).toContain('cases=5 passed=5 failed=0');
      expect(python.status).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
