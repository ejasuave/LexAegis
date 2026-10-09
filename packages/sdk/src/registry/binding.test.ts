import { describe, expect, it } from 'vitest';
import { receiptBindingSchema, validateReceiptBinding } from './binding';
import type { ObservedReceipt } from './decode';
import { expectOk, failureCode, protocolCase } from './test-helpers';

const legal = protocolCase('legal');
const revised = protocolCase('legal-revised');
const legalCommitment = legal.expected.reference.commitment;
const revisedCommitment = revised.expected.reference.commitment;
const OTHER = `0x${'cd'.repeat(32)}`;

function record(
  reference: typeof legal.expected.reference,
  fields: Partial<ObservedReceipt>,
): ObservedReceipt {
  return {
    chainId: reference.chainId,
    registryAddress: reference.registryAddress,
    reviewerAddress: reference.reviewerAddress,
    commitment: reference.commitment,
    receiptLifecycle: 'active',
    predecessor: null,
    successor: null,
    issuedAt: '1800000000',
    updatedAt: '1800000000',
    ...fields,
  };
}

function bind(vector: typeof legal, fields: Partial<ObservedReceipt>) {
  return expectOk(
    validateReceiptBinding({
      opening: vector.opening,
      reference: vector.expected.reference,
      observed: record(vector.expected.reference, fields),
    }),
  );
}

describe('validateReceiptBinding', () => {
  it('matches an Active record with no predecessor for a package that supersedes nothing', () => {
    expect(bind(legal, {})).toEqual({ binding: 'match', receiptLifecycle: 'active', issues: [] });
  });

  it('requires the predecessor the manifest declares', () => {
    expect(bind(revised, { predecessor: legalCommitment })).toEqual({
      binding: 'match',
      receiptLifecycle: 'active',
      issues: [],
    });
    // Issued without the declared predecessor, or with a different one.
    expect(bind(revised, {})).toEqual({
      binding: 'mismatch',
      receiptLifecycle: 'unknown',
      issues: ['PREDECESSOR_MISMATCH'],
    });
    expect(bind(revised, { predecessor: OTHER }).issues).toEqual(['PREDECESSOR_MISMATCH']);
    // An unexpected link on a package that supersedes nothing.
    expect(bind(legal, { predecessor: OTHER })).toEqual({
      binding: 'mismatch',
      receiptLifecycle: 'unknown',
      issues: ['PREDECESSOR_MISMATCH'],
    });
  });

  it('reports a missing receipt as absent, not as a match', () => {
    expect(bind(legal, { receiptLifecycle: 'not_found', issuedAt: '0', updatedAt: '0' })).toEqual({
      binding: 'absent',
      receiptLifecycle: 'not_found',
      issues: [],
    });
    // Even for a package that declares a predecessor: there is simply no record yet.
    expect(
      bind(revised, { receiptLifecycle: 'not_found', issuedAt: '0', updatedAt: '0' }).binding,
    ).toBe('absent');
  });

  it('reports Revoked and Superseded as terminal statuses', () => {
    expect(bind(legal, { receiptLifecycle: 'revoked', updatedAt: '1800000500' })).toEqual({
      binding: 'match',
      receiptLifecycle: 'revoked',
      issues: [],
    });
    expect(
      bind(legal, {
        receiptLifecycle: 'superseded',
        successor: revisedCommitment,
        updatedAt: '1800000500',
      }),
    ).toEqual({ binding: 'match', receiptLifecycle: 'superseded', issues: [] });
  });

  it('never turns a Superseded receipt back into Active', () => {
    // The helper sees one record. Whatever later happened to the successor (for example its
    // revocation) is not an input, so it cannot change this receipt's status.
    const superseded = bind(legal, {
      receiptLifecycle: 'superseded',
      successor: revisedCommitment,
      updatedAt: '1800000500',
    });
    const successorLaterRevoked = bind(revised, {
      receiptLifecycle: 'revoked',
      predecessor: legalCommitment,
      updatedAt: '1800000900',
    });
    expect(superseded.receiptLifecycle).toBe('superseded');
    expect(successorLaterRevoked.receiptLifecycle).toBe('revoked');
    expect([superseded.receiptLifecycle, successorLaterRevoked.receiptLifecycle]).not.toContain(
      'active',
    );
  });

  it('rejects a record for another chain, registry, reviewer or commitment', () => {
    const others: Partial<ObservedReceipt>[] = [
      { chainId: '10143' },
      { registryAddress: `0x${'12'.repeat(20)}` },
      { reviewerAddress: `0x${'23'.repeat(20)}` },
      { commitment: OTHER },
    ];
    for (const other of others) {
      expect(bind(legal, other)).toEqual({
        binding: 'mismatch',
        receiptLifecycle: 'unknown',
        issues: ['RECEIPT_TUPLE_MISMATCH'],
      });
    }
  });

  it('rejects an opening prepared for a different context than the reference', () => {
    const reference = { ...legal.expected.reference, chainId: '10143' };
    const result = expectOk(
      validateReceiptBinding({
        opening: legal.opening,
        reference,
        observed: record(reference, {}),
      }),
    );
    expect(result).toEqual({
      binding: 'mismatch',
      receiptLifecycle: 'unknown',
      issues: ['OPENING_CONTEXT_MISMATCH'],
    });
  });

  it.each<[string, Partial<ObservedReceipt>]>([
    ['Active with a successor', { successor: OTHER }],
    ['Active changed after issuance', { updatedAt: '1800000001' }],
    ['Active with no issuance time', { issuedAt: '0', updatedAt: '0' }],
    ['updated before it was issued', { receiptLifecycle: 'revoked', updatedAt: '1799999999' }],
    ['Revoked with a successor', { receiptLifecycle: 'revoked', successor: OTHER }],
    ['Superseded without a successor', { receiptLifecycle: 'superseded' }],
    ['superseded by itself', { receiptLifecycle: 'superseded', successor: legalCommitment }],
    ['NotFound with a timestamp', { receiptLifecycle: 'not_found' }],
    [
      'NotFound with a link',
      { receiptLifecycle: 'not_found', issuedAt: '0', updatedAt: '0', successor: OTHER },
    ],
  ])('treats an impossible record as a mismatch: %s', (_label, fields) => {
    const result = bind(legal, fields);
    expect(result.binding).toBe('mismatch');
    expect(result.receiptLifecycle).toBe('unknown');
    expect(result.issues).toContain('IMPOSSIBLE_RECORD');
  });

  it('treats a predecessor equal to the successor or to itself as impossible', () => {
    expect(
      bind(revised, {
        receiptLifecycle: 'superseded',
        predecessor: legalCommitment,
        successor: legalCommitment,
        updatedAt: '1800000500',
      }).issues,
    ).toEqual(['IMPOSSIBLE_RECORD']);
    expect(bind(legal, { predecessor: legalCommitment }).issues).toEqual([
      'IMPOSSIBLE_RECORD',
      'PREDECESSOR_MISMATCH',
    ]);
  });

  it('fails closed on malformed inputs', () => {
    const observed = record(legal.expected.reference, {});
    const { reference } = legal.expected;
    expect(
      failureCode(validateReceiptBinding({ opening: legal.opening, reference: {}, observed })),
    ).toBe('REFERENCE_INVALID');
    expect(
      failureCode(
        validateReceiptBinding({ opening: { ...legal.opening, extra: 1 }, reference, observed }),
      ),
    ).toBe('OPENING_INVALID');
    for (const bad of [
      { ...observed, receiptLifecycle: 'unknown' },
      { ...observed, valid: true },
      { ...observed, issuedAt: 1800000000 },
      { ...observed, predecessor: `0x${'00'.repeat(31)}` },
      null,
    ]) {
      expect(
        failureCode(validateReceiptBinding({ opening: legal.opening, reference, observed: bad })),
      ).toBe('OBSERVATION_INVALID');
    }
  });

  it('has no combined validity flag', () => {
    const result = bind(legal, {});
    expect(Object.keys(result).sort()).toEqual(['binding', 'issues', 'receiptLifecycle']);
    expect(receiptBindingSchema.safeParse({ ...result, valid: true }).success).toBe(false);
  });
});
