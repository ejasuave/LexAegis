import { describe, expect, it } from 'vitest';
import { runVerificationJob, type JobProgress } from './verification-job';
import { exportBytes, openingBytes, referenceOf } from './test-helpers';

const run = (
  bytes: Uint8Array<ArrayBuffer>,
  kind: 'file' | 'opening',
  reference?: unknown,
  progress?: (update: JobProgress) => void,
) =>
  runVerificationJob(
    {
      kind,
      bytes: bytes.buffer,
      expectedReference: reference,
      hasExpectedReference: reference !== undefined,
    },
    progress,
  );

describe('local verification job', () => {
  it('checks a readable export against the reference it declares and says so', async () => {
    const outcome = await run(exportBytes('legal'), 'file');
    expect(outcome.ok && outcome.result.offline).toMatchObject({
      mode: 'full-package',
      referenceOrigin: 'file-declared',
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
    });
    expect(outcome.ok && outcome.result.inventory.every((item) => item.check === 'match')).toBe(
      true,
    );
    expect(outcome.ok && outcome.result.offline.issues.map((i) => i.code)).toContain(
      'EXPECTATION_FROM_FILE',
    );
  });

  it('uses an independently supplied reference and catches a wholly replaced bundle', async () => {
    const same = await run(exportBytes('legal'), 'file', referenceOf('legal'));
    expect(
      same.ok && [same.result.offline.referenceOrigin, same.result.offline.manifestIntegrity],
    ).toEqual(['independent', 'match']);
    const substituted = await run(exportBytes('generic'), 'file', referenceOf('legal'));
    expect(substituted.ok && substituted.result.offline.manifestIntegrity).toBe('mismatch');
    expect(
      substituted.ok && substituted.result.inventory.every((i) => i.check === 'not_evaluated'),
    ).toBe(true);
  });

  it('reports a changed artifact distinctly from a missing one', async () => {
    const changed = await run(
      exportBytes('legal', (envelope) => {
        const artifacts = envelope.artifacts as { artifactId: string; bytes: string }[];
        const [first] = artifacts;
        if (first !== undefined) first.bytes = 'AAAA';
      }),
      'file',
      referenceOf('legal'),
    );
    // A substituted artifact of a different length: the manifest still matches, the artifact does not.
    expect(changed.ok && changed.result.offline.manifestIntegrity).toBe('match');
    expect(changed.ok && changed.result.inventory.some((i) => i.check === 'mismatch')).toBe(true);
  });

  it('requires a separate reference for an opening and verifies only the manifest', async () => {
    expect(await run(openingBytes('legal'), 'opening')).toEqual({
      ok: false,
      code: 'REFERENCE_REQUIRED',
    });
    const outcome = await run(openingBytes('legal'), 'opening', referenceOf('legal'));
    expect(outcome.ok && outcome.result.offline).toMatchObject({
      mode: 'manifest-only',
      manifestIntegrity: 'match',
      artifactIntegrity: 'unknown',
    });
    expect(outcome.ok && outcome.result.inventory.every((i) => i.check === 'not_supplied')).toBe(
      true,
    );
    // An opening dropped in as a "file" is recognised by its content and told what it needs.
    expect(await run(openingBytes('legal'), 'file')).toEqual({
      ok: false,
      code: 'REFERENCE_REQUIRED',
    });
  });

  it('gives actionable wrong-format results by content, not by file name', async () => {
    const wrap = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(await run(wrap({ schema: 'lexaegis.encrypted-review-export.v1' }), 'file')).toEqual({
      ok: false,
      code: 'WRONG_FORMAT_ENCRYPTED_BACKUP',
    });
    expect(await run(wrap({ schema: 'lexaegis.matter-context-export.v1' }), 'file')).toEqual({
      ok: false,
      code: 'WRONG_FORMAT_CONTEXT_EXPORT',
    });
    expect(await run(wrap({ schema: 'lexaegis.verification-result.v1' }), 'file')).toEqual({
      ok: false,
      code: 'UNRECOGNISED_FORMAT',
    });
    expect(await run(new TextEncoder().encode('not json'), 'file')).toEqual({
      ok: false,
      code: 'INPUT_MALFORMED',
    });
  });

  it('rejects an invalid expected reference and malformed job input', async () => {
    expect(await run(exportBytes('legal'), 'file', { nope: 1 })).toEqual({
      ok: false,
      code: 'REFERENCE_INVALID',
    });
    expect(await runVerificationJob({ kind: 'file' } as never)).toEqual({
      ok: false,
      code: 'SCHEMA_INVALID',
    });
  });

  it('reports real progress counts and zeroes the buffer afterwards (best effort)', async () => {
    const updates: JobProgress[] = [];
    const bytes = exportBytes('legal');
    await run(bytes, 'file', undefined, (update) => updates.push(update));
    expect(updates.map((u) => u.stage)).toEqual(['parsing', 'decoded', 'hashing']);
    expect(updates[1]).toMatchObject({ stage: 'decoded', artifacts: 8 });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});
