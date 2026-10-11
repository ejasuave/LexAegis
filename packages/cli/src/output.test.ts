import { describe, expect, it } from 'vitest';
import type { VerificationReportV1 } from '@lexaegis/sdk';
import { EXIT } from './exit';
import {
  RESULT_SCHEMA,
  escapeText,
  formatJson,
  formatText,
  projectReport,
  type CliResult,
} from './output';
import { HELP } from './help';

const reference = {
  schema: 'lexaegis.receipt-ref.v1',
  chainId: '10143',
  registryAddress: `0x${'11'.repeat(20)}`,
  reviewerAddress: `0x${'22'.repeat(20)}`,
  commitment: `0x${'ab'.repeat(32)}`,
} as const;

const report: VerificationReportV1 = {
  schema: 'lexaegis.verification-report.v1',
  mode: 'full-package',
  expectedReference: reference,
  referenceOrigin: 'independent',
  manifestIntegrity: 'match',
  artifactIntegrity: 'mismatch',
  registryIdentity: 'unknown',
  receiptBinding: 'unknown',
  chainStatus: 'unknown',
  signerAcceptance: 'unknown',
  checkpoint: null,
  registryPolicyId: null,
  signerPolicyId: null,
  profile: { id: 'private.profile', version: '1' },
  profileSemantics: 'not_evaluated',
  history: null,
  observedAt: '2026-10-11T12:00:00.000Z',
  issues: [
    { code: 'ARTIFACT_DIGEST_MISMATCH', artifactId: 'd0000000-0000-4000-8000-000000000001' },
  ],
};

const result = (extra: Partial<CliResult> = {}): CliResult => ({
  command: 'verify',
  exit: EXIT.INTEGRITY,
  filesEvaluated: true,
  report: projectReport(report),
  error: null,
  rpcSource: null,
  notes: [],
  ...extra,
});

describe('terminal escaping', () => {
  it('escapes control, format and bidirectional characters', () => {
    expect(escapeText('a\u001b[31mred\u0007\r\n‮evil \u0000')).toBe(
      'a\\u001b[31mred\\u0007\\u000d\\u000a\\u202eevil\\u2028\\u0000',
    );
    expect(escapeText('plain ✓ ünïcode 😀')).toBe('plain ✓ ünïcode 😀');
  });

  it('text output of hostile values contains no raw control character', () => {
    const hostile = result({
      error: { source: 'cli', code: 'X\u001b]0;pwned\u0007', subject: '--rpc\r\n‮' },
      notes: ['note\u001b[2J'],
    });
    // eslint-disable-next-line no-control-regex
    expect(formatText(hostile).replace(/\n/g, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
  });
});

describe('public projection', () => {
  it('drops artifact IDs, the profile and every private field', () => {
    const projected = projectReport(report);
    const text = JSON.stringify(projected);
    expect(text).not.toContain('d0000000');
    expect(text).not.toContain('private.profile');
    expect('profile' in projected).toBe(false);
    expect(projected.issues).toEqual([{ code: 'ARTIFACT_DIGEST_MISMATCH' }]);
  });

  it('has no combined valid field and keeps a deterministic field order', () => {
    const json = JSON.parse(formatJson(result())) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'schema',
      'command',
      'exit',
      'filesEvaluated',
      'signerRequirements',
      'rpcSource',
      'report',
      'error',
    ]);
    expect(json.schema).toBe(RESULT_SCHEMA);
    expect(JSON.stringify(json)).not.toMatch(/"valid"/);
    expect(json.signerRequirements).toBe('not_evaluated');
    expect(formatJson(result())).toBe(formatJson(result()));
  });

  it('text mode states the limits and never says valid', () => {
    const text = formatText(result());
    expect(text).toContain('does not establish signer acceptance');
    expect(text).not.toMatch(/\bvalid\b/i);
    expect(text).toContain('not evaluated');
  });
});

describe('help', () => {
  it('documents every exit code and its precedence', () => {
    for (const code of ['2', '10', '20', '11', '12', '13', '0', '130']) {
      expect(HELP).toMatch(new RegExp(`^\\s+${code}\\s`, 'm'));
    }
    expect(HELP).toContain('first match wins');
    expect(HELP).toContain('shell history');
    expect(HELP).toContain('no signer-policy editor');
  });
});
