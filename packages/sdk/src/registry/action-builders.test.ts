import { describe, expect, it, vi } from 'vitest';
import type { PreparedReviewPackage } from '@lexaegis/protocol/v1';
import {
  buildIssueAction,
  buildRevokeAction,
  buildSupersedeAction,
  defaultActionDeadline,
} from './action-builders';
import {
  DEADLINE,
  expectOk,
  failureCode,
  NONCE,
  prepareCase,
  protocolCase,
  UINT256_MAX_DECIMAL,
  ZERO32,
} from './test-helpers';
import { buildTypedData, hashReviewAction } from './typed-data';

const legalReference = protocolCase('legal').expected.reference;

describe('buildIssueAction', () => {
  it('binds reviewer, chain, registry and commitment to the prepared snapshot', async () => {
    const prepared = await prepareCase('legal');
    const bound = expectOk(buildIssueAction(prepared, NONCE, DEADLINE));

    expect(bound).toEqual({
      chainId: prepared.reference.chainId,
      registryAddress: prepared.reference.registryAddress,
      action: {
        reviewer: prepared.reference.reviewerAddress,
        action: 0,
        commitment: prepared.reference.commitment,
        replacementCommitment: ZERO32,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.action)).toBe(true);
  });

  it('requires the manifest to supersede nothing', async () => {
    const revised = await prepareCase('legal-revised');
    expect(failureCode(buildIssueAction(revised, NONCE, DEADLINE))).toBe('SUPERSEDES_UNEXPECTED');
  });

  it('accepts only a real PreparedReviewPackage, never a look-alike', async () => {
    const prepared = await prepareCase('legal');
    const lookAlikes: unknown[] = [
      { reference: prepared.reference, opening: prepared.opening },
      structuredClone(prepared.opening),
      prepared.reference,
      JSON.parse(JSON.stringify(prepared)),
      null,
      undefined,
      'prepared',
    ];
    for (const candidate of lookAlikes) {
      expect(failureCode(buildIssueAction(candidate, NONCE, DEADLINE))).toBe('SNAPSHOT_INVALID');
    }
  });

  it('takes the nonce and deadline explicitly and validates them strictly', async () => {
    const prepared = await prepareCase('legal');
    expect(expectOk(buildIssueAction(prepared, '0', DEADLINE)).action.nonce).toBe('0');
    expect(
      expectOk(buildIssueAction(prepared, UINT256_MAX_DECIMAL, UINT256_MAX_DECIMAL)).action,
    ).toMatchObject({ nonce: UINT256_MAX_DECIMAL, deadline: UINT256_MAX_DECIMAL });

    for (const nonce of [
      0,
      0n,
      '',
      '01',
      '-1',
      '1.0',
      '0x0',
      null,
      undefined,
      (2n ** 256n).toString(),
    ]) {
      expect(failureCode(buildIssueAction(prepared, nonce, DEADLINE))).toBe('NONCE_INVALID');
    }
    for (const deadline of [1800000600, '0', '', '00', null, undefined, (2n ** 256n).toString()]) {
      expect(failureCode(buildIssueAction(prepared, NONCE, deadline))).toBe('DEADLINE_INVALID');
    }
  });
});

describe('buildRevokeAction', () => {
  it('targets exactly the referenced receipt', () => {
    expect(expectOk(buildRevokeAction(legalReference, '7', DEADLINE))).toEqual({
      chainId: legalReference.chainId,
      registryAddress: legalReference.registryAddress,
      action: {
        reviewer: legalReference.reviewerAddress,
        action: 1,
        commitment: legalReference.commitment,
        replacementCommitment: ZERO32,
        nonce: '7',
        deadline: DEADLINE,
      },
    });
  });

  it('rejects unsupported versions, extra fields and a zero commitment', () => {
    expect(
      failureCode(
        buildRevokeAction(
          { ...legalReference, schema: 'lexaegis.receipt-ref.v2' },
          NONCE,
          DEADLINE,
        ),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(buildRevokeAction({ ...legalReference, label: 'private' }, NONCE, DEADLINE)).toEqual({
      ok: false,
      error: { code: 'REFERENCE_INVALID' },
    });
    expect(
      failureCode(
        buildRevokeAction(
          { ...legalReference, reviewerAddress: legalReference.reviewerAddress.toUpperCase() },
          NONCE,
          DEADLINE,
        ),
      ),
    ).toBe('REFERENCE_INVALID');
    expect(
      failureCode(buildRevokeAction({ ...legalReference, commitment: ZERO32 }, NONCE, DEADLINE)),
    ).toBe('ZERO_COMMITMENT');
    expect(failureCode(buildRevokeAction(legalReference, '01', DEADLINE))).toBe('NONCE_INVALID');
  });
});

describe('buildSupersedeAction', () => {
  it('replaces the declared predecessor with the prepared snapshot', async () => {
    const revised = await prepareCase('legal-revised');
    const bound = expectOk(buildSupersedeAction(legalReference, revised, '1', DEADLINE));

    expect(bound).toEqual({
      chainId: legalReference.chainId,
      registryAddress: legalReference.registryAddress,
      action: {
        reviewer: legalReference.reviewerAddress,
        action: 2,
        commitment: legalReference.commitment,
        replacementCommitment: revised.reference.commitment,
        nonce: '1',
        deadline: DEADLINE,
      },
    });
  });

  it('requires the manifest to name exactly that predecessor', async () => {
    const revised = await prepareCase('legal-revised');
    const legal = await prepareCase('legal');

    // A snapshot that was not prepared as a replacement.
    expect(failureCode(buildSupersedeAction(legalReference, legal, NONCE, DEADLINE))).toBe(
      'SUPERSEDES_REQUIRED',
    );
    // Any difference in the predecessor tuple.
    const others = [
      { ...legalReference, commitment: `0x${'ab'.repeat(32)}` },
      { ...legalReference, chainId: '10143' },
      { ...legalReference, registryAddress: `0x${'12'.repeat(20)}` },
      { ...legalReference, reviewerAddress: `0x${'23'.repeat(20)}` },
    ];
    for (const other of others) {
      expect(failureCode(buildSupersedeAction(other, revised, NONCE, DEADLINE))).toBe(
        'SUPERSEDES_MISMATCH',
      );
    }
    expect(failureCode(buildSupersedeAction(legalReference, {}, NONCE, DEADLINE))).toBe(
      'SNAPSHOT_INVALID',
    );
    expect(
      failureCode(
        buildSupersedeAction({ ...legalReference, schema: 'x' }, revised, NONCE, DEADLINE),
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(failureCode(buildSupersedeAction(legalReference, revised, NONCE, '0'))).toBe(
      'DEADLINE_INVALID',
    );
  });
});

describe('builders and the signing domain', () => {
  it('only allow typed data for the chain and registry the package was prepared for', async () => {
    const prepared = await prepareCase('legal');
    const bound = expectOk(buildIssueAction(prepared, NONCE, DEADLINE));
    const { chainId, registryAddress } = prepared.reference;

    const typedData = expectOk(buildTypedData(bound, chainId, registryAddress));
    expect(typedData.message.commitment).toBe(prepared.reference.commitment);
    expect(expectOk(hashReviewAction(typedData))).toMatch(/^0x[0-9a-f]{64}$/);

    expect(failureCode(buildTypedData(bound, '10143', registryAddress))).toBe('DOMAIN_MISMATCH');
    expect(failureCode(buildTypedData(bound, chainId, `0x${'12'.repeat(20)}`))).toBe(
      'DOMAIN_MISMATCH',
    );
  });

  it('reuse the captured snapshot: no new randomness and the same commitment every time', async () => {
    const prepared = await prepareCase('legal');
    const randomness = vi.spyOn(globalThis.crypto, 'getRandomValues');
    try {
      const first = expectOk(buildIssueAction(prepared, NONCE, DEADLINE));
      const retry = expectOk(buildIssueAction(prepared, '1', '1800001200'));
      expect(retry.action.commitment).toBe(first.action.commitment);
      expect(randomness).not.toHaveBeenCalled();
    } finally {
      randomness.mockRestore();
    }
  });

  it('expose no private opening material', async () => {
    const prepared: PreparedReviewPackage = await prepareCase('legal-revised');
    const bound = expectOk(buildSupersedeAction(legalReference, prepared, NONCE, DEADLINE));
    const typedData = expectOk(buildTypedData(bound, bound.chainId, bound.registryAddress));
    const serialized = JSON.stringify([bound, typedData]);

    expect(serialized).not.toContain(prepared.opening.blindingNonce.slice(2));
    expect(serialized).not.toContain(prepared.packageDigest.slice(2));
    for (const artifact of prepared.opening.manifest.artifacts) {
      expect(serialized).not.toContain(artifact.sha256.slice(2));
      expect(serialized).not.toContain(artifact.id);
    }
    expect(serialized).not.toContain(prepared.opening.manifest.packageId);
  });
});

describe('defaultActionDeadline', () => {
  it('adds 600 seconds to the supplied Unix time in seconds', () => {
    expect(expectOk(defaultActionDeadline('1800000000'))).toBe('1800000600');
    expect(expectOk(defaultActionDeadline('0'))).toBe('600');
  });

  it('never reads a clock and rejects non-canonical input', () => {
    expect(failureCode(defaultActionDeadline(1800000000))).toBe('DEADLINE_INVALID');
    expect(failureCode(defaultActionDeadline(undefined))).toBe('DEADLINE_INVALID');
    expect(failureCode(defaultActionDeadline(UINT256_MAX_DECIMAL))).toBe('DEADLINE_INVALID');
  });
});
