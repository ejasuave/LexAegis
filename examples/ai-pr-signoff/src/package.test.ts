import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyReviewPackage } from '@lexaegis/protocol/v1';
import { prepareSignoffPackage, validateDecision, type PackageInputs } from './package.js';
import { PROFILE } from './profile.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, name)));
const inputs = (): PackageInputs => ({
  diff: read('pr-42.diff'),
  summary: read('ai-review-summary.md'),
  decision: read('decision.json'),
});
const context = {
  chainId: '10143',
  registryAddress: '0x453bfd1602d8a8666f55bf9a8d87b127cb94048f',
  reviewerAddress: '0x2222222222222222222222222222222222222222',
};
const withDecision = (patch: Record<string, unknown>): PackageInputs => ({
  ...inputs(),
  decision: new TextEncoder().encode(
    JSON.stringify({ ...JSON.parse(new TextDecoder().decode(inputs().decision)), ...patch }),
  ),
});

describe('AI-assisted PR sign-off package', () => {
  it('maps the three inputs onto existing roles in a valid generic package', async () => {
    const result = await prepareSignoffPackage(inputs(), context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = result.prepared.opening.manifest;
    expect(manifest.profile).toEqual(PROFILE);
    expect(manifest.artifacts.map((artifact) => artifact.role)).toEqual([
      'source',
      'analysis',
      'decision-log',
    ]);
    expect(new Set(manifest.approval.scopeArtifactIds).size).toBe(3);
    expect(manifest.approval.decisionLogArtifactId).toBe(manifest.artifacts[2]?.id);
    // The package verifies under the independent reference, with the original bytes.
    const verified = await verifyReviewPackage(
      result.prepared.opening,
      result.prepared.artifacts(),
      result.prepared.reference,
    );
    expect(verified.ok && verified.data.artifactIntegrity).toBe('match');
  });

  it('uses a fresh random opening each time', async () => {
    const [a, b] = await Promise.all([
      prepareSignoffPackage(inputs(), context),
      prepareSignoffPackage(inputs(), context),
    ]);
    expect(
      a.ok && b.ok && a.prepared.reference.commitment !== b.prepared.reference.commitment,
    ).toBe(true);
  });

  it('an altered diff or summary no longer matches the decision, nor the original reference', async () => {
    const original = await prepareSignoffPackage(inputs(), context);
    if (!original.ok) throw new Error('fixture');
    const altered = { ...inputs(), diff: new TextEncoder().encode('different diff\n') };
    expect(await prepareSignoffPackage(altered, context)).toEqual({
      ok: false,
      code: 'DECISION_DIFF_MISMATCH',
    });
    const summary = { ...inputs(), summary: new TextEncoder().encode('different summary\n') };
    expect(await prepareSignoffPackage(summary, context)).toEqual({
      ok: false,
      code: 'DECISION_SUMMARY_MISMATCH',
    });
    // Replacing a committed artifact's bytes breaks verification against the original reference.
    const artifacts = new Map(original.prepared.artifacts());
    const firstId = original.prepared.artifactIds[0];
    if (firstId === undefined) throw new Error('fixture');
    artifacts.set(firstId, new TextEncoder().encode('tampered'));
    const verified = await verifyReviewPackage(
      original.prepared.opening,
      artifacts,
      original.prepared.reference,
    );
    expect(verified.ok && verified.data.artifactIntegrity).toBe('mismatch');
  });

  it.each([
    ['not JSON', { decision: new Uint8Array([1, 2, 3]) }, 'DECISION_NOT_JSON'],
    ['an unknown field', withDecision({ extra: true }), 'DECISION_SCHEMA_INVALID'],
    ['another decision', withDecision({ decision: 'reject' }), 'DECISION_SCHEMA_INVALID'],
    ['a long rationale', withDecision({ rationale: 'x'.repeat(2001) }), 'DECISION_SCHEMA_INVALID'],
    [
      'a bad time',
      withDecision({ decidedAt: '2026-13-40T00:00:00.000Z' }),
      'DECISION_SCHEMA_INVALID',
    ],
    [
      'another reviewer',
      withDecision({ reviewer: '0x3333333333333333333333333333333333333333' }),
      'DECISION_REVIEWER_MISMATCH',
    ],
  ] as const)('rejects a decision file that is %s', async (_name, patch, code) => {
    const merged = 'diff' in patch ? patch : { ...inputs(), ...patch };
    expect(await validateDecision(merged, context)).toEqual({ ok: false, code });
  });

  it('does not touch the legal profile: no settlement artifact or legal-app import', () => {
    const text = readFileSync(join(fixtures, '..', 'src', 'package.ts'), 'utf8');
    expect(text).not.toMatch(/employment|settlement|apps\/web/i);
  });
});
