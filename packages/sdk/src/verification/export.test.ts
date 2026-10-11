import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@lexaegis/protocol/portable';
import { artifactBytes, protocolCase } from '../registry/test-helpers';
import { expectedReviewersPolicy } from './signer-policy';
import { verifyReviewExport, type VerifyReviewExportInput } from './export';
import { caseReference, scriptedPolicy, scriptedRegistry } from './test-helpers';

const NOW = () => new Date('2026-10-09T12:00:00.000Z');

function exportFile(
  id: 'generic' | 'legal' | 'legal-revised',
  mutate?: (json: Record<string, unknown>) => void,
) {
  const vector = protocolCase(id);
  const bytes = artifactBytes(vector);
  const json: Record<string, unknown> = {
    schema: 'lexaegis.review-export.v1',
    receiptReference: vector.expected.reference,
    opening: vector.opening,
    artifacts: vector.opening.manifest.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      bytes: toBase64Url(bytes.get(artifact.id) ?? new Uint8Array()),
    })),
  };
  mutate?.(json);
  return new TextEncoder().encode(JSON.stringify(json));
}

const base = (extra: Partial<VerifyReviewExportInput> = {}): VerifyReviewExportInput => ({
  file: exportFile('legal'),
  expectedReference: caseReference('legal'),
  now: NOW,
  ...extra,
});

describe('verifyReviewExport', () => {
  it('verifies a file against an independent reference and makes no network request', async () => {
    const result = await verifyReviewExport(base());
    expect(result.ok && result.data.report).toMatchObject({
      mode: 'full-package',
      referenceOrigin: 'independent',
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      chainStatus: 'unknown',
      signerAcceptance: 'unknown',
      registryIdentity: 'unknown',
    });
    expect(result.ok && result.data.report.issues.map((issue) => issue.code)).toEqual([
      'NETWORK_NOT_REQUESTED',
      'SIGNER_POLICY_ABSENT',
    ]);
    expect(result.ok && 'valid' in result.data.report).toBe(false);
  });

  it('without an expected reference the file checks itself and says so', async () => {
    const result = await verifyReviewExport({ file: exportFile('legal'), now: NOW });
    expect(result.ok && result.data.report.referenceOrigin).toBe('file-declared');
    expect(result.ok && result.data.report.issues.map((issue) => issue.code)).toContain(
      'EXPECTATION_FROM_FILE',
    );
  });

  it('a bundle rewritten consistently is caught only by the independent reference', async () => {
    // A different package, internally consistent, declaring its own reference.
    const substituted = exportFile('legal-revised');
    const selfChecked = await verifyReviewExport({ file: substituted, now: NOW });
    expect(selfChecked.ok && selfChecked.data.report.manifestIntegrity).toBe('match');
    const independent = await verifyReviewExport({
      file: substituted,
      expectedReference: caseReference('legal'),
      now: NOW,
    });
    expect(independent.ok && independent.data.report).toMatchObject({
      manifestIntegrity: 'mismatch',
      artifactIntegrity: 'unknown',
    });
    expect(independent.ok && independent.data.report.issues.map((issue) => issue.code)).toContain(
      'DECLARED_REFERENCE_CONFLICT',
    );
  });

  it('a malformed file is a typed export failure, not a verification result', async () => {
    const result = await verifyReviewExport({ file: new TextEncoder().encode('{"schema":"x"}') });
    expect(result).toEqual({
      ok: false,
      error: { source: 'export', failure: { code: 'UNRECOGNISED_FORMAT', path: 'schema' } },
    });
  });

  it('an invalid expected reference is a typed verification failure', async () => {
    const result = await verifyReviewExport(base({ expectedReference: { schema: 'nope' } }));
    expect(!result.ok && result.error.source).toBe('verification');
  });

  it('reports altered and missing artifacts separately', async () => {
    const altered = await verifyReviewExport(
      base({
        file: exportFile('legal', (json) => {
          const entries = json.artifacts as { bytes: string }[];
          entries[0] = { ...entries[0], bytes: toBase64Url(new Uint8Array([9, 9, 9])) };
        }),
      }),
    );
    expect(altered.ok && altered.data.report.artifactIntegrity).toBe('mismatch');
  });

  it('keeps local integrity results when the RPC is unavailable and never reads unknown as not_found', async () => {
    const result = await verifyReviewExport(
      base({
        live: {
          policy: scriptedPolicy(),
          transport: { kind: 'client', client: scriptedRegistry({}, { fail: true }).client },
        },
      }),
    );
    expect(result.ok && result.data.report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      chainStatus: 'unknown',
      registryIdentity: 'unknown',
    });
  });

  it('a caller policy that rejects the reviewer stays a rejection', async () => {
    const legal = caseReference('legal');
    const registry = scriptedRegistry({ [legal.commitment]: { status: 1 } });
    const result = await verifyReviewExport(
      base({
        live: { policy: scriptedPolicy(), transport: { kind: 'client', client: registry.client } },
        signerPolicy: expectedReviewersPolicy('test.other', [`0x${'99'.repeat(20)}`]),
      }),
    );
    expect(result.ok && result.data.report).toMatchObject({
      chainStatus: 'active',
      signerAcceptance: 'rejected',
    });
  });

  it('reads the file synchronously: mutating it afterwards cannot change the result', async () => {
    const file = exportFile('legal');
    const pending = verifyReviewExport(base({ file }));
    file.fill(0);
    const result = await pending;
    expect(result.ok && result.data.report.artifactIntegrity).toBe('match');
  });
});
