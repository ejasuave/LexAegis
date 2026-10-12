/** Test-only helpers. */
import type { EvidenceClass, EvidenceResult, Outcome } from './state';

export const FINGERPRINT = 'a'.repeat(64);
export const OTHER_FINGERPRINT = 'b'.repeat(64);

let counter = 0;

export function result(
  subject: string,
  overrides: Partial<Omit<EvidenceResult, 'subject'>> & {
    evidenceClass?: EvidenceClass;
    outcome?: Outcome;
  } = {},
): EvidenceResult {
  counter += 1;
  return {
    id: `r${String(counter).padStart(4, '0')}-${subject}`,
    subject,
    sourceRevision: { commit: null, dirtyWorktree: true, contentFingerprint: FINGERPRINT },
    checkedAt: '2026-10-06T12:00:00+01:00',
    command: 'pnpm test',
    environment: { node: 'v24' },
    evidenceClass: 'live_testnet',
    outcome: 'pass',
    reasonCodes: [],
    evidenceRefs: [],
    ...overrides,
  };
}

export const DEPLOYMENT_FACTS = {
  chainId: '10143',
  registryAddress: `0x${'ab'.repeat(20)}`,
  transactionHash: `0x${'cd'.repeat(32)}`,
  sourceCommit: 'f'.repeat(40),
  receiptStatus: 'success',
  identityMatches: true,
};

export function gateAEvidence(): EvidenceResult[] {
  return [
    result('chapters-1-3-checks', { evidenceClass: 'local_scripted' }),
    result('registry-deployment', { facts: { ...DEPLOYMENT_FACTS } }),
  ];
}

export function gateBEvidence(action = '0x' + '11'.repeat(32)): EvidenceResult[] {
  const link = {
    chainId: '10143',
    actionDigest: action,
    registryAddress: DEPLOYMENT_FACTS.registryAddress,
  };
  return [
    result('mera-signature', { evidenceClass: 'real_device', facts: link }),
    result('registry-transaction', {
      facts: { ...link, provider: 'alchemy', confirmed: true },
    }),
    result('verifier-read', { facts: link }),
  ];
}

export const PROVIDER_FACTS = {
  provenance: 'live-provider',
  replayed: false,
  scriptedProvider: false,
  returnedModel: 'qwen3.8-max',
  capabilityVerified: true,
  assertionsPassed: true,
  requestIds: '6',
  toolRequests: '4',
  citedBlocks: '4',
};

export function gateCEvidence(): EvidenceResult[] {
  return [
    result('qwen-run', { evidenceClass: 'live_provider', facts: { ...PROVIDER_FACTS } }),
    result('browser-t0-journey', {
      facts: { chainId: '10143', transactionChecked: true, verificationChecked: true },
    }),
  ];
}

export function gateDEvidence(): EvidenceResult[] {
  return [
    ...[
      'feature-freeze',
      'verifier-deliverable',
      'sdk-deliverable',
      'cli-deliverable',
      'judge-path',
    ].map((subject) => result(subject, { evidenceClass: 'local_scripted' })),
    result('public-repository', { facts: { anonymousAccess: true } }),
  ];
}
