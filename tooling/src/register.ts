/**
 * The authoritative scope register (Chapter 14.1). docs/scope-tiers.md is generated from it and
 * docs/build-state.json must list exactly these features. The owning chapter is the planning
 * assignment from the v3 brief and prompt library; it says who builds a feature, not that it works.
 */

export const TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
export type Tier = (typeof TIERS)[number];

export const FEATURE_STATUSES = ['not-started', 'in-progress', 'verified', 'cut'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface FeatureDefinition {
  readonly id: string;
  readonly tier: Tier;
  /** Two-digit owning chapter, as in docs/build-state.json. */
  readonly chapter: string;
  readonly title: string;
}

const f = (id: string, tier: Tier, chapter: string, title: string): FeatureDefinition => ({
  id,
  tier,
  chapter,
  title,
});

export const FEATURES: readonly FeatureDefinition[] = [
  f('document-import', 'T0', '08', 'Document import'),
  f('consent', 'T0', '10', 'Consent before analysis'),
  f('qwen-source-linked-findings', 'T0', '09', 'Live Qwen-assisted source-linked findings'),
  f('human-decision', 'T0', '10', 'Human decision'),
  f('freeze-and-verified-save', 'T0', '05', 'Immutable freeze and verified save'),
  f('real-signature-approval', 'T0', '04', 'Explicit real-signature approval'),
  f('confirmed-monad-receipt', 'T0', '06', 'Confirmed Monad testnet receipt'),
  f('independent-verification', 'T0', '11', 'Independent verification'),
  f('tamper-detection', 'T0', '11', 'Tamper detection'),
  f('supersession-revocation', 'T0', '03', 'Supersession and revocation'),
  f('deployed-registry', 'T0', '06', 'Deployed registry'),
  f('sdk-verification', 'T0', '11', 'SDK verification'),

  f('mera-recovery', 'T1', '04', 'Mera account recovery'),
  f('encrypted-vault', 'T1', '05', 'Encrypted vault'),
  f('payment-what-if', 'T1', '08', 'Payment what-if'),
  f('compact-labelled-orb', 'T1', '10', 'Compact labelled orb'),
  f('pinned-runtime-prompts', 'T1', '09', 'Pinned runtime prompts'),
  f('cli', 'T1', '15', 'CLI'),
  f('embeddable-widget', 'T1', '18', 'Embeddable widget'),
  f('second-domain-example', 'T1', '18', 'Second-domain example'),
  f('specification-test-vectors', 'T1', '15', 'Specification and test vectors'),
  f('quickstart', 'T1', '15', 'Quickstart'),
  f('judge-path', 'T1', '19', 'Judge path'),

  f('envio-history', 'T2', '07', 'Envio history and derived status'),
  f('matter-notes', 'T2', '10', 'Matter notes'),
  f('agent-identity', 'T2', '16', 'Availability-gated agent identity'),
  f('invariant-tests', 'T2', '17', 'Invariant tests'),
  f('threat-model', 'T2', '17', 'Threat model'),
  f('verified-deployment', 'T2', '17', 'Verified deployment'),
  f('evaluation-fixtures-8', 'T2', '12', 'Eight evaluation fixtures'),

  f('voice', 'T3', '10', 'Voice'),
  f('document-comparison', 'T3', '10', 'Document comparison'),
  f('matter-briefing', 'T3', '10', 'Matter briefing'),
  f('reputation-feedback', 'T3', '16', 'Reputation feedback'),
  f('evaluation-fixtures-12', 'T3', '12', 'Four additional evaluation fixtures (twelve in total)'),
  f('visual-polish', 'T3', '19', 'Additional visual polish'),
];

export const FEATURE_IDS: ReadonlySet<string> = new Set(FEATURES.map((feature) => feature.id));

/** Features that exist in the repository today but have no passing applicable check. */
export const INITIAL_STATUS: Readonly<Record<string, FeatureStatus>> = {
  // Contract-level supersession and revocation are built and tested locally (Chapter 3); the
  // user-facing T0 feature is not, so nothing here is verified.
  'supersession-revocation': 'in-progress',
  'sdk-verification': 'in-progress',
  'deployed-registry': 'in-progress',
  'specification-test-vectors': 'in-progress',
  'invariant-tests': 'in-progress',
  // Chapter 4: accounts are built and tested with a virtual authenticator; real-device evidence
  // and the full approval flow are still missing.
  'real-signature-approval': 'in-progress',
  'mera-recovery': 'in-progress',
  // Chapter 5: the encrypted vault, recovery from remote ciphertext and verified frozen-package
  // saves are built and tested (real PostgreSQL, real S3 server, virtual authenticator); real-device
  // recovery has not been performed, and the review capture itself arrives in Chapters 8 to 10.
  'freeze-and-verified-save': 'in-progress',
  'encrypted-vault': 'in-progress',
};

export function initialStatus(id: string): FeatureStatus {
  return INITIAL_STATUS[id] ?? 'not-started';
}

/** Product flag (apps/web) to register feature. */
export const FLAG_FEATURES: Readonly<Record<string, string>> = {
  voice: 'voice',
  documentComparison: 'document-comparison',
  matterBriefing: 'matter-briefing',
  reputationFeedback: 'reputation-feedback',
  agentIdentity: 'agent-identity',
  matterNotes: 'matter-notes',
};
