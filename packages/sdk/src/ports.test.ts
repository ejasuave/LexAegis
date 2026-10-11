import { describe, expect, it } from 'vitest';
import * as v1 from '@lexaegis/protocol/v1';
import * as sdk from './index';
import {
  createReceiptClient,
  createUnavailableReceiptIndexer,
  indexedHistorySchema,
  prepareReviewPackage,
  receiptLookupSchema,
} from './index';

const lookup = {
  chainId: '10143',
  registryAddress: `0x${'11'.repeat(20)}`,
  reviewerAddress: `0x${'22'.repeat(20)}`,
  commitment: `0x${'33'.repeat(32)}`,
};

describe('receipt client', () => {
  it('keeps contract reads and submission unavailable, never returning a lifecycle result', async () => {
    const client = createReceiptClient();
    const transport = { request: () => Promise.reject(new Error('must not be called')) };
    const results = await Promise.all([
      client.readStatus(lookup, { transport }),
      client.submit({}),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('prepares through the protocol implementation and fails closed on bad input', async () => {
    const client = createReceiptClient();
    expect(Reflect.get(client, 'prepare')).toBe(prepareReviewPackage);
    const result = await client.prepare({ schema: 'lexaegis.review-package.v9' }, new Map());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('UNSUPPORTED_VERSION');
  });

  it('indexer reports NOT_IMPLEMENTED instead of empty successful history', async () => {
    const result = await createUnavailableReceiptIndexer().history({
      reviewerAddress: lookup.reviewerAddress,
      limit: 20,
    });
    expect(result.ok).toBe(false);
  });
});

describe('SDK re-exports', () => {
  it('exposes the protocol functions themselves rather than copies', () => {
    expect(sdk.prepareReviewPackage).toBe(v1.prepareReviewPackage);
    expect(sdk.verifyReviewPackage).toBe(v1.verifyReviewPackage);
    expect(sdk.verifyManifestOpening).toBe(v1.verifyManifestOpening);
    expect(sdk.computeCommitment).toBe(v1.computeCommitment);
    expect(sdk.canonicalizeReviewPackage).toBe(v1.canonicalizeReviewPackage);
  });

  it('does not export signing, submission or lifecycle operations from the offline entry point', () => {
    // Data identifiers (issue codes, signer policies) are fine; operations that act are not.
    const operation =
      /^(?:sign(?!er)|submit|broadcast|revoke|supersede|issue|build(?:Issue|Revoke|Supersede))/i;
    for (const [name, value] of Object.entries(sdk)) {
      if (typeof value === 'function') expect(name).not.toMatch(operation);
    }
  });
});

describe('SDK schemas', () => {
  it('requires the full chain/registry/reviewer/commitment tuple', () => {
    expect(receiptLookupSchema.safeParse(lookup).success).toBe(true);
    const { registryAddress: _omitted, ...partial } = lookup;
    expect(receiptLookupSchema.safeParse(partial).success).toBe(false);
    expect(receiptLookupSchema.safeParse({ ...lookup, chainId: '0' }).success).toBe(false);
  });

  it('indexed history carries checkpoint metadata and no lifecycle verdict', () => {
    const parsed = indexedHistorySchema.safeParse({
      items: [],
      checkpoint: { progressBlock: null, observedAt: '2026-10-08T12:00:00Z' },
    });
    expect(parsed.success).toBe(true);
    expect(
      indexedHistorySchema.safeParse({
        items: [],
        checkpoint: { progressBlock: null, observedAt: '2026-10-08T12:00:00Z' },
        receiptLifecycle: 'active',
      }).success,
    ).toBe(false);
  });
});
