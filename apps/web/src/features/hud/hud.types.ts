/*
 * Plain input and output shapes of the HUD selectors. Inputs are small copies of what existing
 * controllers already expose, so this module imports no controller, account, vault, approval or
 * Mera code and cannot reach one. Each concern is its own field: there is no combined "secure",
 * "verified" or "success" flag.
 */

export type Tone = 'ok' | 'attention' | 'warn' | 'bad' | 'muted';

export interface Reading {
  readonly id:
    | 'matter'
    | 'network'
    | 'indexer'
    | 'mera-session'
    | 'public-account'
    | 'vault'
    | 'transaction'
    | 'server-sign-in';
  readonly label: string;
  /** The words that carry the meaning. Colour and icons only supplement them. */
  readonly text: string;
  readonly tone: Tone;
  /** Full value kept for a deliberate reveal, such as a public address. Never a secret. */
  readonly fullValue: string | null;
}

export type Freshness = 'live' | 'stale' | 'unknown';

export interface IndexerInput {
  readonly availability: 'available' | 'unavailable';
  readonly freshness: 'caught_up' | 'catching_up' | 'unknown';
  readonly indexConsistency: 'consistent' | 'recovering' | 'inconsistent' | 'unknown';
  /** When the service last reported; null when never observed. */
  readonly observedAtMs: number | null;
  /** Decimal block numbers. */
  readonly indexedBlock: string | null;
  readonly sourceLag: string | null;
  readonly confirmedLag: string | null;
}

export interface AccountInput {
  readonly availability: 'loading' | 'available' | 'unsupported' | 'misconfigured';
  readonly ceremony: 'idle' | 'awaiting_passkey';
  readonly address: string | null;
  readonly signing: 'locked' | 'unlocked';
  readonly signingExpiresAtMs: number | null;
  readonly lastEvent: string | null;
  readonly backend: 'unknown' | 'signed_out' | 'signing_in' | 'signed_in' | 'unavailable';
}

export type TransactionStageInput =
  | 'idle'
  | 'checking_network'
  | 'awaiting_confirmation'
  | 'signing'
  | 'sending'
  | 'pending'
  | 'checking_execution'
  | 'confirmed'
  | 'reverted'
  | 'unknown'
  | 'failed'
  | 'cancelled';

export interface CeilingInput {
  readonly nowMs: number;
  readonly matterTitle: string | null;
  readonly selectedVersionIds: readonly string[];
  readonly networkLabel: string;
  /** Decimal chain id, null when not configured. */
  readonly chainId: string | null;
  readonly account: AccountInput;
  /** The vault controller's own label, already worded; the selector adds only a tone. */
  readonly vaultLabel: string;
  readonly transaction: {
    readonly stage: TransactionStageInput;
    readonly mayHaveBroadcast: boolean;
  };
  readonly indexer: IndexerInput | null;
}

export type ActivityState =
  | 'idle'
  | 'queued'
  | 'awaiting_user'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'stale'
  | 'offline'
  | 'unavailable';

export type RunStateInput =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'stopping'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export interface ActiveRunInput {
  readonly state: RunStateInput;
  /** Tool calls started and finished in this run. */
  readonly toolsStarted: number;
  readonly toolsFinished: number;
  readonly stepsCompleted: number;
  /** Null while the plan has not said how many steps there are. */
  readonly stepsTotal: number | null;
  /** Plain operation name, such as "payment check". */
  readonly operation: string;
  /** The reviewer's inputs changed after this result was produced. */
  readonly outOfDate: boolean;
  readonly failureMessage: string | null;
  /** When the last accepted event for this run arrived; null when none has. */
  readonly lastEventAtMs: number | null;
}

export interface AssistantInput {
  readonly phase: 'idle' | 'preview' | 'running' | 'stopping';
  readonly orb: 'unavailable' | 'ready' | RunStateInput;
  readonly availability: 'unknown' | 'loading' | 'ready' | 'signed_out' | 'unreachable';
  readonly activeRun: ActiveRunInput | null;
}

export interface FindingInput {
  readonly id: string;
  readonly state: 'ok' | 'attention' | 'needs_input' | 'not_comparable' | 'technical_failure';
  /** The reviewer has recorded a disposition for it. */
  readonly resolved: boolean;
  /** Currently rendered in the viewport, so a branch may end at its marker. */
  readonly visible: boolean;
  readonly selected: boolean;
}

export interface HudInput {
  readonly ceiling: CeilingInput;
  readonly assistant: AssistantInput;
  readonly findings: readonly FindingInput[];
  /** The vault is unlocked: private anchors and content may be shown. */
  readonly vaultUnlocked: boolean;
  readonly matterSelected: boolean;
}

export type Connection = 'live' | 'stale' | 'offline' | 'unknown';

export interface ActivityView {
  readonly state: ActivityState;
  /** One plain-language sentence for the stage; always states what is actually true. */
  readonly statusText: string;
  /** True only while a tool is executing in a run whose activity can still be verified. */
  readonly toolsRunning: boolean;
  readonly stepsCompleted: number;
  readonly stepsTotal: number | null;
  readonly connection: Connection;
}

export interface AttentionView {
  /** Unresolved findings that need the reviewer, including those not on screen. */
  readonly unresolvedCount: number;
  /** A technical failure or missing input blocks progress. */
  readonly blocking: boolean;
  /** At most three finding ids to draw: the selected one first, then by priority. */
  readonly highlighted: readonly string[];
  /** Unresolved findings that are not visible: the canvas points at the Findings control. */
  readonly offscreenUnresolved: number;
  readonly severityById: Readonly<Record<string, 'alert' | 'failure' | 'input'>>;
}

export interface HudView {
  readonly readings: readonly Reading[];
  readonly activity: ActivityView;
  readonly attention: AttentionView;
  /** Lock clears sensitive anchors at once; it never erases public transaction history. */
  readonly clearPrivateAnchors: boolean;
}
