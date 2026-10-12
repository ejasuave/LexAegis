import {
  artifactDigest,
  describeArtifact,
  prepareReviewPackage,
  type PreparedReviewPackage,
  type ReviewPackageV1,
} from '@lexaegis/protocol/v1';
import { DECISION_SCHEMA, PROFILE, decisionSchema, type DecisionV1 } from './profile.js';

export interface PackageContext {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewerAddress: string;
}

export interface PackageInputs {
  readonly diff: Uint8Array;
  readonly summary: Uint8Array;
  readonly decision: Uint8Array;
}

export type PreparationFailure =
  | 'DECISION_NOT_JSON'
  | 'DECISION_SCHEMA_INVALID'
  | 'DECISION_REVIEWER_MISMATCH'
  | 'DECISION_DIFF_MISMATCH'
  | 'DECISION_SUMMARY_MISMATCH'
  | 'PACKAGE_REJECTED';

export type PreparationResult =
  | { readonly ok: true; readonly prepared: PreparedReviewPackage; readonly decision: DecisionV1 }
  | { readonly ok: false; readonly code: PreparationFailure };

const decoder = new TextDecoder('utf-8', { fatal: true });

/** SHA-256 digests of the exact diff and summary bytes, for the reviewer to place in the decision file. */
export async function inputDigests(
  diff: Uint8Array,
  summary: Uint8Array,
): Promise<{ readonly diffSha256: string; readonly summarySha256: string }> {
  return { diffSha256: await artifactDigest(diff), summarySha256: await artifactDigest(summary) };
}

/** Parses and validates the decision file against the actual inputs. Nothing here approves anything. */
export async function validateDecision(
  inputs: PackageInputs,
  context: PackageContext,
): Promise<
  | { readonly ok: true; readonly decision: DecisionV1 }
  | { readonly ok: false; readonly code: PreparationFailure }
> {
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(inputs.decision));
  } catch {
    return { ok: false, code: 'DECISION_NOT_JSON' };
  }
  const parsed = decisionSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'DECISION_SCHEMA_INVALID' };
  if (parsed.data.reviewer !== context.reviewerAddress)
    return { ok: false, code: 'DECISION_REVIEWER_MISMATCH' };
  const digests = await inputDigests(inputs.diff, inputs.summary);
  if (parsed.data.diffSha256 !== digests.diffSha256)
    return { ok: false, code: 'DECISION_DIFF_MISMATCH' };
  if (parsed.data.summarySha256 !== digests.summarySha256)
    return { ok: false, code: 'DECISION_SUMMARY_MISMATCH' };
  return { ok: true, decision: parsed.data };
}

/**
 * Maps the diff to `source`, the AI-review summary to `analysis` and the decision to
 * `decision-log` (existing roles only), puts every artifact in scope exactly once and points the
 * approval's decision log at the decision. The result is an UNAPPROVED, immutable snapshot with a
 * fresh random opening: a file that says "approved" is not authority to broadcast anything.
 */
export async function prepareSignoffPackage(
  inputs: PackageInputs,
  context: PackageContext,
  now: Date = new Date(),
): Promise<PreparationResult> {
  const checked = await validateDecision(inputs, context);
  if (!checked.ok) return checked;
  const ids = {
    diff: crypto.randomUUID(),
    summary: crypto.randomUUID(),
    decision: crypto.randomUUID(),
  };
  const artifacts = [
    await describeArtifact(
      { id: ids.diff, role: 'source', mediaType: 'text/x-diff', label: 'Pull request diff' },
      inputs.diff,
    ),
    await describeArtifact(
      { id: ids.summary, role: 'analysis', mediaType: 'text/markdown', label: 'AI review summary' },
      inputs.summary,
    ),
    await describeArtifact(
      {
        id: ids.decision,
        role: 'decision-log',
        mediaType: 'application/json',
        label: 'Reviewer decision',
      },
      inputs.decision,
    ),
  ];
  const manifest: ReviewPackageV1 = {
    schema: 'lexaegis.review-package.v1',
    packageId: crypto.randomUUID(),
    preparedAt: now.toISOString(),
    profile: PROFILE,
    context,
    supersedes: null,
    artifacts,
    approval: {
      intent: 'approve-review-package',
      scopeArtifactIds: [ids.diff, ids.summary, ids.decision],
      decisionLogArtifactId: ids.decision,
    },
  };
  const prepared = await prepareReviewPackage(
    manifest,
    new Map([
      [ids.diff, inputs.diff],
      [ids.summary, inputs.summary],
      [ids.decision, inputs.decision],
    ]),
  );
  if (!prepared.ok) return { ok: false, code: 'PACKAGE_REJECTED' };
  return { ok: true, prepared: prepared.data, decision: checked.decision };
}

export { DECISION_SCHEMA };
