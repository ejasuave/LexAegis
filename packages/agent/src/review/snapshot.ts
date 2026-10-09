import {
  REVIEW_ENGINE_VERSION,
  REVIEW_PROFILE,
  type ConfirmedFactV1,
  type EvidenceSelectionV1,
} from '../contracts/review';
import { canonicalDigest } from './hash';

/*
 * ReviewInputSnapshot: the exact inputs a result was computed from. It binds content hashes, not
 * revision numbers alone. Its digest is a private application value, distinct from Chapter 2's
 * blinded public commitment, and never leaves the encrypted vault.
 */

export interface ReviewInputSnapshot {
  readonly matterId: string;
  readonly sources: readonly {
    documentVersionId: string;
    sourceSha256: string;
    extractionSha256: string;
  }[];
  readonly facts: readonly { factId: string; revision: number; contentSha256: string }[];
  readonly evidence: readonly EvidenceSelectionV1[];
  readonly rulePackDigest: string;
  readonly reviewRecordState: string;
  readonly engineVersion: string;
  readonly profile: string;
}

export function buildSnapshot(input: {
  matterId: string;
  sources: readonly { documentVersionId: string; sourceSha256: string; extractionSha256: string }[];
  facts: readonly ConfirmedFactV1[];
  evidence: readonly EvidenceSelectionV1[];
  rulePackDigest: string;
  reviewRecordState: string;
}): ReviewInputSnapshot {
  return {
    matterId: input.matterId,
    sources: [...input.sources].sort((a, b) =>
      a.documentVersionId < b.documentVersionId ? -1 : 1,
    ),
    facts: input.facts
      .map((f) => ({ factId: f.factId, revision: f.revision, contentSha256: f.contentSha256 }))
      .sort((a, b) => (a.factId < b.factId ? -1 : 1)),
    evidence: [...input.evidence].sort((a, b) => (a.requirement < b.requirement ? -1 : 1)),
    rulePackDigest: input.rulePackDigest,
    reviewRecordState: input.reviewRecordState,
    engineVersion: REVIEW_ENGINE_VERSION,
    profile: `${REVIEW_PROFILE.id}@${REVIEW_PROFILE.version}`,
  };
}

export const snapshotDigest = (snapshot: ReviewInputSnapshot): Promise<string> =>
  canonicalDigest(snapshot);

/** Content hash of a fact as confirmed (everything except the hash itself). */
export function factContentDigest(fact: Omit<ConfirmedFactV1, 'contentSha256'>): Promise<string> {
  return canonicalDigest(fact);
}
