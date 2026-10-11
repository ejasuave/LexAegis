import { describeArtifact, type ArtifactRefV1, type ReviewPackageV1 } from '@lexaegis/protocol/v1';

/*
 * A generic, non-legal application profile. The protocol does not interpret it: the profile id and
 * version are declared data, and what the artifacts mean is entirely this application's business.
 */
export const PROFILE = { id: 'example.document-review', version: '1' } as const;

export interface ExampleContext {
  readonly chainId: string;
  readonly registryAddress: string;
  readonly reviewerAddress: string;
}

export interface SyntheticPackage {
  readonly manifest: ReviewPackageV1;
  readonly artifacts: Map<string, Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * Builds a package from SYNTHETIC bytes: one source document and one decision log. The decision
 * log is a generic record of what the reviewer decided; it satisfies the protocol's role and scope
 * rules (exactly one decision-log artifact, every artifact in scope exactly once).
 */
export async function buildSyntheticPackage(
  context: ExampleContext,
  now: Date = new Date(),
): Promise<SyntheticPackage> {
  const source = encoder.encode(
    'Synthetic example document.\nThis text is made up for a demonstration and is not a real document.\n',
  );
  const decisionLog = encoder.encode(
    JSON.stringify({
      schema: 'example.decision-log.v1',
      decisions: [{ item: 'synthetic-item-1', decision: 'acknowledged', note: 'Synthetic.' }],
    }),
  );
  const sourceId = crypto.randomUUID();
  const logId = crypto.randomUUID();
  const refs: ArtifactRefV1[] = [
    await describeArtifact(
      { id: sourceId, role: 'source', mediaType: 'text/plain', label: 'Synthetic document' },
      source,
    ),
    await describeArtifact(
      { id: logId, role: 'decision-log', mediaType: 'application/json', label: 'Decisions' },
      decisionLog,
    ),
  ];
  const manifest: ReviewPackageV1 = {
    schema: 'lexaegis.review-package.v1',
    packageId: crypto.randomUUID(),
    preparedAt: now.toISOString(),
    profile: PROFILE,
    context,
    supersedes: null,
    artifacts: refs,
    approval: {
      intent: 'approve-review-package',
      scopeArtifactIds: [sourceId, logId],
      decisionLogArtifactId: logId,
    },
  };
  return {
    manifest,
    artifacts: new Map([
      [sourceId, source],
      [logId, decisionLog],
    ]),
  };
}
