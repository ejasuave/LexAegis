import { LIVE_CLASSES, isCurrent, type EvidenceClass, type EvidenceResult } from './state';
import { instant, isAfter } from './time';

/*
 * Gate A–D predicates (Chapter 14.3). Pure: recorded evidence goes in, a computed
 * pass|fail|unknown comes out. Evidence is never edited by evaluating it.
 */

export const GATE_IDS = ['A', 'B', 'C', 'D'] as const;
export type GateId = (typeof GATE_IDS)[number];
export type GateOutcome = 'pass' | 'fail' | 'unknown';

export const CHAIN_ID = '10143';

export const GATE_CUTOFFS: Readonly<Record<GateId, string>> = {
  A: '2026-10-06T23:59:59+01:00',
  B: '2026-10-08T23:59:59+01:00',
  C: '2026-10-10T23:59:59+01:00',
  D: '2026-10-11T23:59:59+01:00',
};

/** Distinct from the gates and never moved automatically. */
export const SUBMISSION_TARGETS = {
  internalTarget: '2026-10-12',
  latestPlanned: '2026-10-13T22:00:00+01:00',
  hardDeadline: '2026-10-14T04:59:00+01:00',
} as const;

/** Gate C is entered when Gate B closes (or at C's own cutoff, whichever is first). */
export const GATE_C_ENTRY = GATE_CUTOFFS.B;

export interface Requirement {
  readonly id: string;
  /** Result subject that must carry the evidence. */
  readonly subject: string;
  /** Evidence classes allowed to satisfy it. */
  readonly classes: ReadonlySet<EvidenceClass>;
  /** Additional exact facts the passing result must record. */
  readonly facts?: (facts: Readonly<Record<string, string | boolean>>) => RequirementFailure | null;
  /** Another requirement whose result must carry the same value for `linkKey`. */
  readonly linkKey?: string;
  /** Wording shown to people when this is missing. */
  readonly label: string;
}

export type RequirementFailure = 'WRONG_NETWORK' | 'IDENTITY_MISMATCH' | 'PROVENANCE_INVALID';

export type RequirementState =
  | 'satisfied'
  | 'missing'
  | 'stale'
  | 'insufficient_class'
  | 'failed'
  | RequirementFailure
  | 'link_mismatch';

const ANY_LOCAL_OR_LIVE: ReadonlySet<EvidenceClass> = new Set([
  'offline_unit',
  'local_scripted',
  'local_anvil',
  'virtual_authenticator',
  'real_device',
  'live_testnet',
]);
const LIVE_ONLY: ReadonlySet<EvidenceClass> = LIVE_CLASSES;

const onTestnet = (facts: Readonly<Record<string, string | boolean>>): RequirementFailure | null =>
  facts.chainId === CHAIN_ID ? null : 'WRONG_NETWORK';

export const REQUIREMENTS: Readonly<Record<GateId, readonly Requirement[]>> = {
  A: [
    {
      id: 'A1',
      subject: 'chapters-1-3-checks',
      classes: ANY_LOCAL_OR_LIVE,
      label: 'Chapters 1–3 build and tests pass',
    },
    {
      id: 'A2',
      subject: 'registry-deployment',
      classes: LIVE_ONLY,
      label: 'Registry deployed on Monad testnet (observed receipt, matching identity)',
      facts: (facts) => {
        if (facts.chainId !== CHAIN_ID) return 'WRONG_NETWORK';
        const present = ['registryAddress', 'transactionHash', 'sourceCommit'].every(
          (key) => typeof facts[key] === 'string' && facts[key] !== '',
        );
        // A populated address is not enough: the receipt must have been observed and matched.
        return present && facts.receiptStatus === 'success' && facts.identityMatches === true
          ? null
          : 'IDENTITY_MISMATCH';
      },
    },
  ],
  B: [
    {
      id: 'B1',
      subject: 'mera-signature',
      classes: LIVE_ONLY,
      label: 'A real Mera account signed the exact action',
      linkKey: 'actionDigest',
      facts: (facts) => (facts.chainId === CHAIN_ID ? null : 'WRONG_NETWORK'),
    },
    {
      id: 'B2',
      subject: 'registry-transaction',
      classes: LIVE_ONLY,
      label: 'Registry transaction confirmed through Alchemy',
      linkKey: 'actionDigest',
      facts: (facts) =>
        facts.chainId === CHAIN_ID && facts.provider === 'alchemy' && facts.confirmed === true
          ? null
          : facts.chainId === CHAIN_ID
            ? 'PROVENANCE_INVALID'
            : 'WRONG_NETWORK',
    },
    {
      id: 'B3',
      subject: 'verifier-read',
      classes: LIVE_ONLY,
      label: 'Verifier read the resulting state',
      linkKey: 'actionDigest',
      facts: onTestnet,
    },
  ],
  C: [
    {
      id: 'C1',
      subject: 'qwen-run',
      classes: LIVE_ONLY,
      label: 'Genuine Qwen run with bounded tools and valid source-linked findings',
      facts: (facts) =>
        facts.provenance === 'live-provider' && facts.replayed !== true
          ? null
          : 'PROVENANCE_INVALID',
    },
    {
      id: 'C2',
      subject: 'browser-t0-journey',
      classes: LIVE_ONLY,
      label: 'Complete T0 browser journey',
      facts: (facts) =>
        facts.chainId !== CHAIN_ID
          ? 'WRONG_NETWORK'
          : facts.transactionChecked === true && facts.verificationChecked === true
            ? null
            : 'PROVENANCE_INVALID',
    },
  ],
  D: [
    {
      id: 'D1',
      subject: 'feature-freeze',
      classes: ANY_LOCAL_OR_LIVE,
      label: 'Feature freeze recorded',
    },
    {
      id: 'D2',
      subject: 'verifier-deliverable',
      classes: ANY_LOCAL_OR_LIVE,
      label: 'Verifier passes',
    },
    { id: 'D3', subject: 'sdk-deliverable', classes: ANY_LOCAL_OR_LIVE, label: 'SDK passes' },
    { id: 'D4', subject: 'cli-deliverable', classes: ANY_LOCAL_OR_LIVE, label: 'CLI passes' },
    { id: 'D5', subject: 'judge-path', classes: ANY_LOCAL_OR_LIVE, label: 'Judge path passes' },
    {
      id: 'D6',
      subject: 'public-repository',
      classes: LIVE_ONLY,
      label: 'Anonymously accessible public repository',
      facts: (facts) => (facts.anonymousAccess === true ? null : 'PROVENANCE_INVALID'),
    },
  ],
};

/** Gates whose prerequisites must also hold. */
export const GATE_PREREQUISITES: Readonly<Record<GateId, readonly GateId[]>> = {
  A: [],
  B: ['A'],
  C: ['B'],
  D: ['C'],
};

export interface RequirementEvaluation {
  readonly id: string;
  readonly label: string;
  readonly state: RequirementState;
  readonly resultId: string | null;
}

export interface GateEvaluation {
  readonly gate: GateId;
  readonly target: string;
  readonly outcome: GateOutcome;
  readonly requirements: readonly RequirementEvaluation[];
  /** Reason codes, e.g. MISSING:A2. Includes UNPROVEN_AT_CUTOFF for a due gate. */
  readonly reasons: readonly string[];
  /** Latest checkedAt among the evidence used, else null. */
  readonly observedAt: string | null;
}

export interface EvaluationContext {
  readonly now: string;
  readonly currentFingerprint: string;
}

function latest(results: readonly EvidenceResult[], subject: string): EvidenceResult | undefined {
  return results
    .filter((result) => result.subject === subject)
    .sort((a, b) => instant(b.checkedAt) - instant(a.checkedAt))[0];
}

function evaluateRequirement(
  requirement: Requirement,
  results: readonly EvidenceResult[],
  context: EvaluationContext,
): { evaluation: RequirementEvaluation; result: EvidenceResult | undefined } {
  const make = (state: RequirementState, result?: EvidenceResult) => ({
    evaluation: {
      id: requirement.id,
      label: requirement.label,
      state,
      resultId: result?.id ?? null,
    },
    result,
  });
  const result = latest(results, requirement.subject);
  if (result === undefined) return make('missing');
  if (!requirement.classes.has(result.evidenceClass)) return make('insufficient_class', result);
  // A real failure stays a failure, current or not.
  if (result.outcome === 'fail') return make('failed', result);
  if (result.outcome !== 'pass') return make('missing', result);
  if (!isCurrent(result, context.currentFingerprint)) return make('stale', result);
  const problem = requirement.facts?.(result.facts ?? {}) ?? null;
  return problem === null ? make('satisfied', result) : make(problem, result);
}

const FAILURES: ReadonlySet<RequirementState> = new Set([
  'failed',
  'WRONG_NETWORK',
  'IDENTITY_MISMATCH',
  'PROVENANCE_INVALID',
  'link_mismatch',
]);

/** Evaluates one gate's own requirements (prerequisite gates are combined by evaluateGates). */
export function evaluateGate(
  gate: GateId,
  results: readonly EvidenceResult[],
  context: EvaluationContext,
): GateEvaluation {
  const target = GATE_CUTOFFS[gate];
  const evaluated = REQUIREMENTS[gate].map((requirement) => ({
    requirement,
    ...evaluateRequirement(requirement, results, context),
  }));

  // Linked evidence must describe the same action, registry and network.
  const linkKeys = new Set(
    evaluated.map((item) => item.requirement.linkKey).filter((key) => key !== undefined),
  );
  for (const key of linkKeys) {
    const values = new Set(
      evaluated
        .filter((item) => item.requirement.linkKey === key && item.evaluation.state === 'satisfied')
        .map(
          (item) =>
            `${String(item.result?.facts?.[key])}|${String(item.result?.facts?.registryAddress)}`,
        ),
    );
    if (values.size > 1) {
      for (const item of evaluated) {
        if (item.requirement.linkKey === key && item.evaluation.state === 'satisfied') {
          (item.evaluation as { state: RequirementState }).state = 'link_mismatch';
        }
      }
    }
  }

  const reasons = evaluated
    .filter((item) => item.evaluation.state !== 'satisfied')
    .map((item) => `${item.evaluation.state.toUpperCase()}:${item.requirement.id}`);
  const used = evaluated.flatMap((item) =>
    item.result === undefined ? [] : [item.result.checkedAt],
  );
  const observedAt = used.sort((a, b) => instant(b) - instant(a))[0] ?? null;

  const anyFailure = evaluated.some((item) => FAILURES.has(item.evaluation.state));
  const allSatisfied = evaluated.every((item) => item.evaluation.state === 'satisfied');
  const due = isAfter(context.now, target);

  let outcome: GateOutcome;
  if (allSatisfied) outcome = 'pass';
  else if (anyFailure) outcome = 'fail';
  else if (due) {
    // Unproven at the cutoff is recorded as a failure to meet the gate, not as an open question.
    outcome = 'fail';
    reasons.push('UNPROVEN_AT_CUTOFF');
  } else outcome = 'unknown';

  return {
    gate,
    target,
    outcome,
    requirements: evaluated.map((item) => item.evaluation),
    reasons,
    observedAt,
  };
}

/** Evaluates A–D in order; a gate cannot pass unless every prerequisite gate passes. */
export function evaluateGates(
  results: readonly EvidenceResult[],
  context: EvaluationContext,
): GateEvaluation[] {
  const done = new Map<GateId, GateEvaluation>();
  for (const gate of GATE_IDS) {
    const own = evaluateGate(gate, results, context);
    const blocked = GATE_PREREQUISITES[gate].filter((id) => done.get(id)?.outcome !== 'pass');
    if (own.outcome === 'pass' && blocked.length > 0) {
      done.set(gate, {
        ...own,
        outcome: 'unknown',
        reasons: [...own.reasons, ...blocked.map((id) => `PREREQUISITE_GATE_NOT_PASSED:${id}`)],
      });
    } else {
      done.set(gate, own);
    }
  }
  return GATE_IDS.map((gate) => {
    const value = done.get(gate);
    if (value === undefined) throw new Error('unreachable');
    return value;
  });
}

/** Gate ids that must be enforced for `--require X`: X and its prerequisites. */
export function gatesRequiredFor(gate: GateId): GateId[] {
  const chain: GateId[] = [];
  for (const id of GATE_IDS) {
    chain.push(id);
    if (id === gate) break;
  }
  return chain;
}

export interface GateConsequences {
  readonly meraBountyClaimsWithdrawn: boolean;
  readonly releaseBlockers: readonly string[];
}

/**
 * If Gate B is failed or unproven at its cutoff, both Mera bounty claims are withdrawn. That
 * neither supplies a deployable signer nor completes hosted T0, so the release blocker remains,
 * and no gate is relaxed and no other wallet stack is added.
 */
export function gateConsequences(gateB: GateEvaluation, now: string): GateConsequences {
  const failed =
    gateB.outcome === 'fail' || (gateB.outcome !== 'pass' && isAfter(now, GATE_CUTOFFS.B));
  return failed
    ? {
        meraBountyClaimsWithdrawn: true,
        releaseBlockers: [
          'NO_DEPLOYABLE_SIGNER: development-only signers cannot pass Gate B or enter production',
          'HOSTED_T0_INCOMPLETE: dropping the bounties does not complete the hosted golden path',
        ],
      }
    : { meraBountyClaimsWithdrawn: false, releaseBlockers: [] };
}

/** Whether a pending T0 smoke step fails the run (from Gate C entry on). */
export function pendingT0IsFailure(now: string): boolean {
  return instant(now) > instant(GATE_C_ENTRY);
}
