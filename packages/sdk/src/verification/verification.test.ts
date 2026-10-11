import { describe, expect, it } from 'vitest';
import { toBase64Url } from '@lexaegis/protocol/portable';
import { artifactBytes, protocolCase } from '../registry/test-helpers';
import { parseReviewExport } from '../portable';
import { verifyOffline, type OfflineInput } from './offline';
import { expectedReviewersPolicy, type SignerAcceptancePolicy } from './signer-policy';
import { verifyReceipt } from './verify-receipt';
import { hashOf, scriptedPolicy, scriptedRegistry, caseReference } from './test-helpers';

const NOW = () => new Date('2026-10-09T12:00:00.000Z');

function inputFor(
  id: 'generic' | 'legal' | 'legal-revised',
  extra: Partial<OfflineInput> = {},
): OfflineInput {
  const vector = protocolCase(id);
  return {
    mode: 'full-package',
    expectedReference: vector.expected.reference,
    referenceOrigin: 'independent',
    opening: vector.opening,
    artifacts: artifactBytes(vector),
    ...extra,
  };
}

const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('offline verification modes', () => {
  it('reference-only never claims manifest or artifact integrity', async () => {
    const result = await verifyOffline({
      mode: 'reference-only',
      expectedReference: caseReference('legal'),
      referenceOrigin: 'independent',
    });
    expect(result.ok && [result.data.manifestIntegrity, result.data.artifactIntegrity]).toEqual([
      'unknown',
      'unknown',
    ]);
  });

  it('manifest-only matches the opening but leaves artifact integrity unknown', async () => {
    const result = await verifyOffline(
      inputFor('legal', { mode: 'manifest-only', artifacts: undefined }),
    );
    expect(result.ok && [result.data.manifestIntegrity, result.data.artifactIntegrity]).toEqual([
      'match',
      'unknown',
    ]);
  });

  it('full-package matches the exact committed artifact set', async () => {
    const result = await verifyOffline(inputFor('legal'));
    expect(
      result.ok && [
        result.data.manifestIntegrity,
        result.data.artifactIntegrity,
        result.data.profile,
      ],
    ).toEqual(['match', 'match', { id: 'lexaegis.employment-settlement.ew', version: '1' }]);
  });

  it('missing artifacts are unknown, a changed artifact is a mismatch', async () => {
    const vector = protocolCase('legal');
    const bytes = artifactBytes(vector);
    const [firstId] = [...bytes.keys()];
    if (firstId === undefined) throw new Error('no artifact');
    const missing = new Map(bytes);
    missing.delete(firstId);
    const incomplete = await verifyOffline(inputFor('legal', { artifacts: missing }));
    expect(incomplete.ok && incomplete.data.artifactIntegrity).toBe('unknown');
    const changed = new Map(bytes);
    const altered = Uint8Array.from(changed.get(firstId) ?? []);
    altered[0] = (altered[0] ?? 0) ^ 1;
    changed.set(firstId, altered);
    const result = await verifyOffline(inputFor('legal', { artifacts: changed }));
    expect(result.ok && result.data.artifactIntegrity).toBe('mismatch');
    expect(result.ok && result.data.manifestIntegrity).toBe('match');
  });

  it('a wholly replaced, internally consistent bundle is caught only by the independent reference', async () => {
    // The attacker ships a different, self-consistent package and declares its own reference.
    const substitute = inputFor('generic');
    const original = caseReference('legal');
    const independent = await verifyOffline({
      ...substitute,
      expectedReference: original,
      declaredReference: caseReference('generic'),
    });
    expect(independent.ok && independent.data.manifestIntegrity).toBe('mismatch');
    expect(independent.ok && codes(independent.data.issues)).toContain(
      'DECLARED_REFERENCE_CONFLICT',
    );
    // Without an independent expectation the file can only agree with itself, and says so.
    const selfDeclared = await verifyOffline({
      ...substitute,
      expectedReference: caseReference('generic'),
      referenceOrigin: 'file-declared',
      declaredReference: caseReference('generic'),
    });
    expect(selfDeclared.ok && selfDeclared.data.manifestIntegrity).toBe('match');
    expect(selfDeclared.ok && codes(selfDeclared.data.issues)).toContain('EXPECTATION_FROM_FILE');
  });

  it('files changed with the manifest and opening rewritten do not match the original reference', async () => {
    const vector = protocolCase('legal');
    const opening = structuredClone(vector.opening);
    const [first] = opening.manifest.artifacts;
    if (first === undefined) throw new Error('no artifact');
    first.sha256 = hashOf(5n);
    const result = await verifyOffline(inputFor('legal', { opening }));
    expect(result.ok && result.data.manifestIntegrity).toBe('mismatch');
    expect(result.ok && result.data.artifactIntegrity).toBe('unknown');
  });

  it('wrong chain, registry or reviewer in the expected reference is a mismatch', async () => {
    for (const patch of [
      { chainId: '10143' },
      { registryAddress: `0x${'33'.repeat(20)}` },
      { reviewerAddress: `0x${'44'.repeat(20)}` },
    ]) {
      const result = await verifyOffline(
        inputFor('legal', { expectedReference: { ...caseReference('legal'), ...patch } }),
      );
      expect(result.ok && result.data.manifestIntegrity, JSON.stringify(patch)).toBe('mismatch');
    }
  });

  it('malformed input is a typed failure, never a partial success', async () => {
    expect((await verifyOffline(inputFor('legal', { expectedReference: { nope: 1 } }))).ok).toBe(
      false,
    );
    expect((await verifyOffline(inputFor('legal', { opening: { nope: 1 } }))).ok).toBe(false);
    expect((await verifyOffline(inputFor('legal', { artifacts: undefined }))).ok).toBe(false);
    expect(
      (await verifyOffline(inputFor('legal', { mode: 'manifest-only', opening: undefined }))).ok,
    ).toBe(false);
    const wrongBytes = await verifyOffline(inputFor('legal', { artifacts: 5 as never }));
    expect(wrongBytes.ok).toBe(false);
  });

  it('does not mutate caller bytes and ignores later mutation', async () => {
    const vector = protocolCase('legal');
    const bytes = artifactBytes(vector);
    const pending = verifyOffline(inputFor('legal', { artifacts: bytes }));
    for (const value of bytes.values()) value.fill(0);
    const result = await pending;
    expect(result.ok && result.data.artifactIntegrity).toBe('match');
  });
});

describe('verifyReceipt', () => {
  const legal = caseReference('legal');
  const revised = caseReference('legal-revised');
  const live = (
    registry: ReturnType<typeof scriptedRegistry>,
    extra: { inspectSuccessors?: boolean; policy?: unknown } = {},
  ) => ({
    policy: extra.policy ?? scriptedPolicy(),
    transport: { kind: 'client', client: registry.client } as const,
    ...(extra.inspectSuccessors === true && { inspectSuccessors: true }),
  });

  it('performs no network read unless live options are supplied', async () => {
    const result = await verifyReceipt({ ...inputFor('legal'), now: NOW, generation: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.generation).toBe(7);
    const { report } = result.data;
    expect(report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      registryIdentity: 'unknown',
      receiptBinding: 'unknown',
      chainStatus: 'unknown',
      signerAcceptance: 'unknown',
      checkpoint: null,
      profileSemantics: 'not_evaluated',
      observedAt: '2026-10-09T12:00:00.000Z',
    });
    expect(codes(report.issues)).toContain('NETWORK_NOT_REQUESTED');
    expect(codes(report.issues)).toContain('SIGNER_POLICY_ABSENT');
    expect(JSON.stringify(report)).not.toMatch(/valid/i);
  });

  it('reports Active at a verified checkpoint, bound to the opening', async () => {
    const registry = scriptedRegistry({ [legal.commitment]: { status: 1 } });
    const result = await verifyReceipt({
      ...inputFor('legal'),
      live: live(registry),
      signerPolicy: expectedReviewersPolicy('test.reviewers', [legal.reviewerAddress]),
      now: NOW,
    });
    expect(result.ok && result.data.report).toMatchObject({
      registryIdentity: 'match',
      receiptBinding: 'match',
      chainStatus: 'active',
      signerAcceptance: 'accepted',
      checkpoint: { blockNumber: '97', finalizedHeight: '100' },
      registryPolicyId: 'test.scripted-registry',
      signerPolicyId: 'test.reviewers',
    });
    // Reads were pinned at the checkpoint, and never at latest.
    expect(registry.calls).not.toContain('tag:latest');
  });

  it('an active on-chain receipt cannot erase an integrity mismatch', async () => {
    const registry = scriptedRegistry({ [legal.commitment]: { status: 1 } });
    const vector = protocolCase('legal');
    const bytes = artifactBytes(vector);
    const [firstId] = [...bytes.keys()];
    if (firstId === undefined) throw new Error('no artifact');
    bytes.set(firstId, Uint8Array.from([1, 2, 3]));
    const result = await verifyReceipt({
      ...inputFor('legal', { artifacts: bytes }),
      live: live(registry),
      now: NOW,
    });
    expect(result.ok && result.data.report).toMatchObject({
      artifactIntegrity: 'mismatch',
      chainStatus: 'active',
    });
  });

  it('absent signer policy stays unknown; a rejected policy stays rejected; policy errors are unknown', async () => {
    const stranger = expectedReviewersPolicy('test.others', [`0x${'55'.repeat(20)}`]);
    const rejected = await verifyReceipt({
      ...inputFor('legal'),
      signerPolicy: stranger,
      now: NOW,
    });
    expect(rejected.ok && rejected.data.report.signerAcceptance).toBe('rejected');
    const throwing: SignerAcceptancePolicy = {
      id: 'test.throws',
      evaluate: () => {
        throw new Error('boom');
      },
    };
    const errored = await verifyReceipt({ ...inputFor('legal'), signerPolicy: throwing, now: NOW });
    expect(errored.ok && errored.data.report.signerAcceptance).toBe('unknown');
    expect(errored.ok && codes(errored.data.report.issues)).toContain('SIGNER_POLICY_ERROR');
    const nonsense = await verifyReceipt({
      ...inputFor('legal'),
      signerPolicy: { id: 'test.nonsense', evaluate: () => 'valid' as never },
      now: NOW,
    });
    expect(nonsense.ok && nonsense.data.report.signerAcceptance).toBe('unknown');
  });

  it('imported labels and the file reviewer field are not acceptance policy', async () => {
    // The policy names someone else; the file claims a friendly reviewer. The file has no say.
    const result = await verifyReceipt({
      ...inputFor('legal'),
      signerPolicy: expectedReviewersPolicy('test.others', [`0x${'55'.repeat(20)}`]),
      now: NOW,
    });
    expect(result.ok && result.data.report.signerAcceptance).toBe('rejected');
  });

  it('not_found requires a successful verified registry read', async () => {
    const empty = scriptedRegistry({});
    const found = await verifyReceipt({ ...inputFor('legal'), live: live(empty), now: NOW });
    expect(found.ok && found.data.report).toMatchObject({
      chainStatus: 'not_found',
      registryIdentity: 'match',
      receiptBinding: 'unknown',
    });
    for (const broken of [
      scriptedRegistry({}, { fail: true }),
      scriptedRegistry({}, { code: '0x' }),
      scriptedRegistry({}, { code: '0x6002' }),
      scriptedRegistry({}, { finalized: null }),
    ]) {
      const result = await verifyReceipt({ ...inputFor('legal'), live: live(broken), now: NOW });
      expect(result.ok && result.data.report.chainStatus).toBe('unknown');
      // Local integrity survives a network failure.
      expect(result.ok && result.data.report.artifactIntegrity).toBe('match');
    }
  });

  it('wrong chain, genesis, code or an untrusted deployment is a registry identity mismatch', async () => {
    const wrongChain = await verifyReceipt({
      ...inputFor('legal'),
      live: live(scriptedRegistry({}, { chainId: 10143 })),
      now: NOW,
    });
    expect(wrongChain.ok && wrongChain.data.report.registryIdentity).toBe('mismatch');
    const genesis = await verifyReceipt({
      ...inputFor('legal'),
      live: live(scriptedRegistry({}, { genesis: hashOf(99n) })),
      now: NOW,
    });
    expect(genesis.ok && codes(genesis.data.report.issues)).toContain('LIVE_GENESIS_MISMATCH');
    const code = await verifyReceipt({
      ...inputFor('legal'),
      live: live(scriptedRegistry({}, { code: '0x6002' })),
      now: NOW,
    });
    expect(code.ok && code.data.report.registryIdentity).toBe('mismatch');
    // A package cannot choose the authority: a policy for another registry reads nothing at all.
    const registry = scriptedRegistry({});
    const other = await verifyReceipt({
      ...inputFor('legal'),
      live: live(registry, { policy: scriptedPolicy({ registryAddress: `0x${'77'.repeat(20)}` }) }),
      now: NOW,
    });
    expect(other.ok && other.data.report.registryIdentity).toBe('mismatch');
    expect(registry.calls).toEqual([]);
    const invalid = await verifyReceipt({
      ...inputFor('legal'),
      live: live(registry, { policy: { chainId: '31337' } }),
      now: NOW,
    });
    expect(invalid.ok && codes(invalid.data.report.issues)).toContain('REGISTRY_POLICY_INVALID');
    expect(registry.calls).toEqual([]);
  });

  it('a manifest mismatch is not overwritten by an existing receipt, and binding stays unknown', async () => {
    const registry = scriptedRegistry({ [legal.commitment]: { status: 1 } });
    const vector = protocolCase('legal');
    const opening = structuredClone(vector.opening);
    opening.blindingNonce = hashOf(1n);
    const result = await verifyReceipt({
      ...inputFor('legal', { opening }),
      live: live(registry),
      now: NOW,
    });
    expect(result.ok && result.data.report).toMatchObject({
      manifestIntegrity: 'mismatch',
      receiptBinding: 'unknown',
      chainStatus: 'active',
    });
  });

  it('requires the on-chain predecessor to equal manifest.supersedes', async () => {
    const good = scriptedRegistry({
      [revised.commitment]: { status: 1, predecessor: legal.commitment },
    });
    const bound = await verifyReceipt({ ...inputFor('legal-revised'), live: live(good), now: NOW });
    expect(bound.ok && bound.data.report.receiptBinding).toBe('match');
    const wrong = scriptedRegistry({
      [revised.commitment]: { status: 1, predecessor: hashOf(9n) },
    });
    const mismatch = await verifyReceipt({
      ...inputFor('legal-revised'),
      live: live(wrong),
      now: NOW,
    });
    expect(mismatch.ok && mismatch.data.report).toMatchObject({
      receiptBinding: 'mismatch',
      chainStatus: 'unknown',
    });
    expect(mismatch.ok && codes(mismatch.data.report.issues)).toContain('PREDECESSOR_MISMATCH');
    // A receipt with a predecessor where the manifest declares none is also a mismatch.
    const unexpected = scriptedRegistry({
      [legal.commitment]: { status: 1, predecessor: hashOf(9n) },
    });
    const extra = await verifyReceipt({ ...inputFor('legal'), live: live(unexpected), now: NOW });
    expect(extra.ok && extra.data.report.receiptBinding).toBe('mismatch');
  });

  describe('successor inspection', () => {
    const chain = (
      ...links: {
        commitment: string;
        status: 1 | 2 | 3;
        predecessor?: string;
        successor?: string;
      }[]
    ) => Object.fromEntries(links.map((link) => [link.commitment, link]));

    it('reads a bounded successor chain at the same checkpoint and never reactivates the original', async () => {
      const registry = scriptedRegistry(
        chain(
          { commitment: legal.commitment, status: 3, successor: revised.commitment },
          { commitment: revised.commitment, status: 2, predecessor: legal.commitment },
        ),
      );
      const result = await verifyReceipt({
        ...inputFor('legal'),
        live: live(registry, { inspectSuccessors: true }),
        now: NOW,
      });
      expect(result.ok && result.data.report).toMatchObject({
        chainStatus: 'superseded',
        history: {
          complete: true,
          successors: [{ chainStatus: 'revoked', packageIntegrity: 'unknown' }],
        },
      });
    });

    it('detects a cycle, a non-reciprocal link and an exhausted limit as incomplete history', async () => {
      const third = hashOf(321n);
      const cycle = scriptedRegistry(
        chain(
          { commitment: legal.commitment, status: 3, successor: revised.commitment },
          {
            commitment: revised.commitment,
            status: 3,
            predecessor: legal.commitment,
            successor: third,
          },
          {
            commitment: third,
            status: 3,
            predecessor: revised.commitment,
            successor: legal.commitment,
          },
        ),
      );
      const looped = await verifyReceipt({
        ...inputFor('legal'),
        live: live(cycle, { inspectSuccessors: true }),
        now: NOW,
      });
      expect(looped.ok && looped.data.report.history?.complete).toBe(false);
      expect(looped.ok && codes(looped.data.report.issues)).toContain('SUCCESSOR_CYCLE');

      const broken = scriptedRegistry(
        chain(
          { commitment: legal.commitment, status: 3, successor: revised.commitment },
          { commitment: revised.commitment, status: 1, predecessor: hashOf(9n) },
        ),
      );
      const invalid = await verifyReceipt({
        ...inputFor('legal'),
        live: live(broken, { inspectSuccessors: true }),
        now: NOW,
      });
      expect(invalid.ok && codes(invalid.data.report.issues)).toContain('SUCCESSOR_LINK_INVALID');

      // A chain of ten replacements: only eight links are read.
      const ids = Array.from({ length: 11 }, (_, index) => hashOf(BigInt(1000 + index)));
      const links = ids.map((commitment, index) => ({
        commitment: index === 0 ? legal.commitment : commitment,
        status: index === ids.length - 1 ? (1 as const) : (3 as const),
        ...(index > 0 && { predecessor: index === 1 ? legal.commitment : (ids[index - 1] ?? '') }),
        ...(index < ids.length - 1 && { successor: ids[index + 1] ?? '' }),
      }));
      const long = scriptedRegistry(chain(...links));
      const limited = await verifyReceipt({
        ...inputFor('legal'),
        live: live(long, { inspectSuccessors: true }),
        now: NOW,
      });
      expect(limited.ok && limited.data.report.history).toMatchObject({ complete: false });
      expect(limited.ok && limited.data.report.history?.successors).toHaveLength(8);
      expect(limited.ok && codes(limited.data.report.issues)).toContain(
        'SUCCESSOR_LIMIT_EXHAUSTED',
      );
    });
  });

  it('stays within the 20 s / 64 attempt / four-read budget and reports a deadline honestly', async () => {
    const slow = scriptedRegistry({}, { delayMs: 200 });
    const result = await verifyReceipt({
      ...inputFor('legal'),
      live: live(slow),
      budget: { totalMs: 150 },
      now: NOW,
    });
    expect(result.ok && result.data.report.chainStatus).toBe('unknown');
    expect(result.ok && codes(result.data.report.issues)).toContain('LIVE_DEADLINE');
    expect(result.ok && result.data.report.artifactIntegrity).toBe('match');

    const limited = await verifyReceipt({
      ...inputFor('legal'),
      live: live(scriptedRegistry({})),
      budget: { maxAttempts: 2 },
      now: NOW,
    });
    expect(limited.ok && codes(limited.data.report.issues)).toContain('LIVE_ATTEMPTS_EXHAUSTED');
  });

  it('cancels on abort: a started check is reported aborted; an already-aborted one is refused', async () => {
    const controller = new AbortController();
    const slow = scriptedRegistry({}, { delayMs: 200 });
    const pending = verifyReceipt({
      ...inputFor('legal'),
      live: live(slow),
      signal: controller.signal,
      now: NOW,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(result.ok && codes(result.data.report.issues)).toContain('LIVE_ABORTED');
    controller.abort();
    expect(await verifyReceipt({ ...inputFor('legal'), signal: controller.signal })).toEqual({
      ok: false,
      error: { code: 'ABORTED' },
    });
  });

  it('echoes the generation so a stale result can be discarded', async () => {
    const [a, b] = await Promise.all([
      verifyReceipt({ ...inputFor('legal'), generation: 1, now: NOW }),
      verifyReceipt({ ...inputFor('legal'), generation: 2, now: NOW }),
    ]);
    expect([a.ok && a.data.generation, b.ok && b.data.generation]).toEqual([1, 2]);
  });
});

describe('parseReviewExport feeds verifyReceipt', () => {
  it('decodes a readable bundle, keeps the declared reference apart, and verifies against the independent one', async () => {
    const vector = protocolCase('legal');
    const bytes = artifactBytes(vector);
    const file = new TextEncoder().encode(
      JSON.stringify({
        schema: 'lexaegis.review-export.v1',
        receiptReference: vector.expected.reference,
        opening: vector.opening,
        artifacts: vector.opening.manifest.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          bytes: toBase64Url(bytes.get(artifact.id) ?? new Uint8Array()),
        })),
      }),
    );
    const decoded = parseReviewExport(file);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const result = await verifyReceipt({
      mode: 'full-package',
      expectedReference: vector.expected.reference,
      referenceOrigin: 'independent',
      declaredReference: decoded.data.declaredReference,
      opening: decoded.data.opening,
      artifacts: decoded.data.artifacts,
      now: NOW,
    });
    expect(result.ok && result.data.report).toMatchObject({
      manifestIntegrity: 'match',
      artifactIntegrity: 'match',
      referenceOrigin: 'independent',
    });
  });
});
