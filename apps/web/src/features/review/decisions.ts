import { z } from 'zod';
import type { CheckFindingV1, ConfirmedFactV1 } from '@lexaegis/agent/contracts';
import { canonicalBytes, canonicalDigest } from '@lexaegis/agent/review';
import type { ReviewSnapshot } from './controller';

/*
 * The genuine human-review gate. Application schemas, outside the generic receipt protocol:
 * a disposition is the reviewer's own choice about one finding; the decision log is the artifact
 * built only from dispositions actually recorded after an explicit "Record review decisions".
 *
 * A disposition never changes what a check found. It cannot turn a mismatch into a match, prove
 * missing evidence exists, waive a technical failure or establish that anything is legally valid.
 * Recording decisions is not cryptographic approval; approval is a later, separate action.
 */

export const DISPOSITION_SCHEMA = 'lexaegis.review-disposition.v1';
export const DECISION_LOG_SCHEMA = 'lexaegis.review-decision-log.v1';
export const DECISION_ENTRY_PREFIX = 'lexaegis.decision.v1:';
export const MAX_REASON_BYTES = 2048;
export const MAX_DISPOSITIONS = 128;

export const DISPOSITION_KINDS = [
  'acknowledged',
  'accepted_unresolved',
  'not_applicable',
  'requires_change',
] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

const digest = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const utf8 = (value: string) => new TextEncoder().encode(value).length;

/** Dispositions that need a stated reason: a concern kept, or a check set aside. */
export const REASON_REQUIRED: ReadonlySet<DispositionKind> = new Set([
  'accepted_unresolved',
  'not_applicable',
]);

export const reviewDispositionSchema = z
  .strictObject({
    schema: z.literal(DISPOSITION_SCHEMA),
    dispositionId: uuid,
    findingId: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
    /** Digest of the exact finding (inputs and result) the reviewer saw. */
    findingDigest: digest,
    /** The review snapshot the finding belonged to. */
    snapshotDigest: digest,
    reviewer: address,
    kind: z.enum(DISPOSITION_KINDS),
    reason: z.string().refine((value) => utf8(value) <= MAX_REASON_BYTES, 'reason too long'),
    recordedAt: timestamp,
  })
  .check((ctx) => {
    const d = ctx.value;
    if (REASON_REQUIRED.has(d.kind) && d.reason.trim() === '')
      ctx.issues.push({ code: 'custom', message: 'reason required', input: d, path: ['reason'] });
  });
export type ReviewDispositionV1 = z.infer<typeof reviewDispositionSchema>;

export const decisionLogSchema = z.strictObject({
  schema: z.literal(DECISION_LOG_SCHEMA),
  matterId: uuid,
  reviewer: address,
  snapshotDigest: digest,
  recordedAt: timestamp,
  rulePack: z.strictObject({
    digest,
    reviewState: z.enum(['demo_draft', 'reviewed']),
  }),
  sources: z
    .array(z.strictObject({ documentVersionId: uuid, sourceArtifactId: uuid }))
    .min(1)
    .max(64),
  facts: z.array(z.strictObject({ factId: z.string().max(200), contentSha256: digest })).max(512),
  /** Every finding the log speaks for. A finding without a disposition here was a clean pass. */
  scope: z.strictObject({
    findingIds: z.array(z.string().max(120)).max(512),
    cleanPassIds: z.array(z.string().max(120)).max(512),
  }),
  dispositions: z.array(reviewDispositionSchema).max(MAX_DISPOSITIONS),
  limitations: z.array(z.string().max(300)).max(8),
});
export type ReviewDecisionLogV1 = z.infer<typeof decisionLogSchema>;

export const LOG_LIMITATIONS = [
  'Recording decisions is not cryptographic approval.',
  'A decision does not change what a check found and does not establish legal validity.',
  'Dispositions are the named reviewer account’s own choices, not a professional qualification.',
] as const;

/** What a reviewer may choose for a finding in each result state. Technical failures allow nothing. */
export const ALLOWED_KINDS: Readonly<Record<CheckFindingV1['state'], readonly DispositionKind[]>> =
  {
    ok: ['acknowledged'],
    attention: ['acknowledged', 'accepted_unresolved', 'requires_change'],
    needs_input: ['acknowledged', 'accepted_unresolved', 'not_applicable', 'requires_change'],
    not_comparable: ['acknowledged', 'accepted_unresolved', 'not_applicable', 'requires_change'],
    technical_failure: [],
  };

export type DecisionFailure =
  | 'NOT_READY'
  | 'ACCOUNT_LOCKED'
  | 'STALE'
  | 'FINDING_NOT_FOUND'
  | 'NOT_WAIVABLE'
  | 'KIND_NOT_ALLOWED'
  | 'REASON_REQUIRED'
  | 'REASON_TOO_LONG'
  | 'TOO_MANY'
  | 'ENTRY_TOO_LARGE'
  | 'VAULT'
  | 'OUTSTANDING'
  | 'TECHNICAL_FAILURE'
  | 'REQUIRES_CHANGE';

export type DecisionResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: DecisionFailure };
const good = <T>(data: T): DecisionResult<T> => ({ ok: true, data });
const bad = (code: DecisionFailure): DecisionResult<never> => ({ ok: false, code });

export interface DecisionVaultPort {
  getSnapshot(): {
    readonly selectedMatter: {
      readonly context: {
        readonly entries: readonly { readonly entryId: string; readonly text: string }[];
      };
    } | null;
  };
  commands: {
    addEntry(
      matterId: string,
      input: { kind: 'note'; text: string; confirmed: boolean },
    ): { readonly ok: boolean };
    removeEntry(matterId: string, entryId: string): { readonly ok: boolean };
  };
}

export interface DecisionReviewPort {
  getSnapshot(): ReviewSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface DecisionDeps {
  readonly review: DecisionReviewPort;
  readonly vault: DecisionVaultPort;
  /** The verified account address while its passkey session is live. */
  readonly account: () => string | null;
  readonly now: () => Date;
  readonly newId: () => string;
}

export interface RecordedLog {
  readonly record: ReviewDecisionLogV1;
  /** Canonical bytes, exactly as they would be stored in a package. Never includes its own digest. */
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface FindingView {
  readonly finding: CheckFindingV1;
  readonly findingDigest: string;
  readonly allowed: readonly DispositionKind[];
  readonly disposition: ReviewDispositionV1 | null;
}

export interface DecisionSnapshot {
  readonly matterId: string | null;
  readonly snapshotDigest: string | null;
  readonly findings: readonly FindingView[];
  readonly dispositions: readonly ReviewDispositionV1[];
  /** True only after an explicit Record review decisions on the current snapshot. */
  readonly recorded: boolean;
  /** Decisions existed for inputs that have since changed. */
  readonly stale: boolean;
  readonly log: RecordedLog | null;
}

const EMPTY: DecisionSnapshot = Object.freeze({
  matterId: null,
  snapshotDigest: null,
  findings: Object.freeze([]),
  dispositions: Object.freeze([]),
  recorded: false,
  stale: false,
  log: null,
});
export const EMPTY_DECISION_SNAPSHOT = EMPTY;

export function validateReason(kind: DispositionKind, reason: string): DecisionResult<string> {
  if (utf8(reason) > MAX_REASON_BYTES) return bad('REASON_TOO_LONG');
  if (REASON_REQUIRED.has(kind) && reason.trim() === '') return bad('REASON_REQUIRED');
  return good(reason.trim());
}

export class DecisionController {
  readonly #deps: DecisionDeps;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #state: DecisionSnapshot = EMPTY;
  #dispositions = new Map<string, ReviewDispositionV1>();
  #entryIds = new Map<string, string>();
  #log: RecordedLog | null = null;
  #stale = false;
  #epoch = 0;
  #matterId: string | null = null;
  #digests = new Map<string, string>();
  #disposed = false;

  constructor(deps: DecisionDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.review.subscribe(() => void this.#onReview());
    void this.#onReview();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): DecisionSnapshot => this.#state;

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    this.#clear();
  }

  #clear(): void {
    this.#epoch++;
    this.#dispositions = new Map();
    this.#entryIds = new Map();
    this.#digests = new Map();
    this.#log = null;
    this.#stale = false;
    this.#matterId = null;
    this.#state = EMPTY;
    for (const listener of this.#listeners) listener();
  }

  #publish(): void {
    const review = this.#deps.review.getSnapshot();
    const fresh = review.checks.status === 'fresh';
    const findings: FindingView[] = fresh
      ? review.checks.findings.map((finding) => ({
          finding,
          findingDigest: this.#digests.get(finding.findingId) ?? '',
          allowed: ALLOWED_KINDS[finding.state],
          disposition: this.#dispositions.get(finding.findingId) ?? null,
        }))
      : [];
    this.#state = Object.freeze({
      matterId: this.#matterId,
      snapshotDigest: fresh ? review.checks.snapshotDigest : null,
      findings: Object.freeze(findings),
      dispositions: Object.freeze([...this.#dispositions.values()]),
      recorded: this.#log !== null && !this.#stale,
      stale: this.#stale,
      log: this.#stale ? null : this.#log,
    });
    for (const listener of this.#listeners) listener();
  }

  /** Reacts to review changes: a changed input digest drops dependent dispositions and any log. */
  async #onReview(): Promise<void> {
    if (this.#disposed) return;
    const review = this.#deps.review.getSnapshot();
    if (review.matterId !== this.#matterId) {
      this.#clear();
      this.#matterId = review.matterId;
    }
    if (review.checks.status !== 'fresh') {
      // Results are out of date or missing: nothing recorded against them can stand.
      if (this.#dispositions.size > 0 || this.#log !== null) {
        this.#stale = this.#stale || this.#log !== null;
        this.#log = null;
      }
      this.#publish();
      return;
    }
    const epoch = ++this.#epoch;
    const digests = new Map<string, string>();
    for (const finding of review.checks.findings)
      digests.set(finding.findingId, await canonicalDigest(finding));
    if (epoch !== this.#epoch) return;
    this.#digests = digests;
    const snapshotDigest = review.checks.snapshotDigest;
    let invalidated = false;
    for (const [findingId, disposition] of [...this.#dispositions]) {
      if (
        digests.get(findingId) !== disposition.findingDigest ||
        disposition.snapshotDigest !== snapshotDigest
      ) {
        this.#dispositions.delete(findingId);
        this.#removeEntry(findingId);
        invalidated = true;
      }
    }
    if (this.#log !== null && (invalidated || this.#log.record.snapshotDigest !== snapshotDigest)) {
      this.#log = null;
      this.#stale = true;
    }
    this.#loadSaved(review, snapshotDigest);
    this.#publish();
  }

  /** Rebuilds working decisions from the encrypted record, keeping only those that still match. */
  #loadSaved(review: ReviewSnapshot, snapshotDigest: string | null): void {
    const matter = this.#deps.vault.getSnapshot().selectedMatter;
    const account = this.#deps.account();
    if (matter === null || account === null || review.matterId === null) return;
    for (const entry of matter.context.entries) {
      if (!entry.text.startsWith(DECISION_ENTRY_PREFIX)) continue;
      let parsed;
      try {
        parsed = reviewDispositionSchema.safeParse(
          JSON.parse(entry.text.slice(DECISION_ENTRY_PREFIX.length)),
        );
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const d = parsed.data;
      if (this.#dispositions.has(d.findingId)) continue;
      if (
        d.reviewer === account &&
        d.snapshotDigest === snapshotDigest &&
        this.#digests.get(d.findingId) === d.findingDigest &&
        review.checks.findings.some(
          (f) => f.findingId === d.findingId && ALLOWED_KINDS[f.state].includes(d.kind),
        )
      ) {
        this.#dispositions.set(d.findingId, d);
        this.#entryIds.set(d.findingId, entry.entryId);
      } else {
        // Left over from other inputs or another account: stale working data, safe to drop.
        this.#deps.vault.commands.removeEntry(review.matterId, entry.entryId);
      }
    }
  }

  #removeEntry(findingId: string): void {
    const entryId = this.#entryIds.get(findingId);
    const matterId = this.#matterId;
    if (entryId !== undefined && matterId !== null)
      this.#deps.vault.commands.removeEntry(matterId, entryId);
    this.#entryIds.delete(findingId);
  }

  /**
   * The reviewer's own choice for one finding. Only an interface control calls this; it takes no
   * ticket and grants nothing, and a model, chat or voice input has no path to it.
   */
  decide(input: {
    readonly findingId: string;
    readonly kind: DispositionKind;
    readonly reason: string;
  }): DecisionResult<ReviewDispositionV1> {
    const review = this.#deps.review.getSnapshot();
    const account = this.#deps.account();
    if (account === null) return bad('ACCOUNT_LOCKED');
    const matterId = this.#matterId;
    if (
      matterId === null ||
      review.checks.status !== 'fresh' ||
      review.checks.snapshotDigest === null
    )
      return bad('NOT_READY');
    const finding = review.checks.findings.find((f) => f.findingId === input.findingId);
    if (finding === undefined) return bad('FINDING_NOT_FOUND');
    const findingDigest = this.#digests.get(finding.findingId);
    if (findingDigest === undefined) return bad('STALE');
    // A technical failure (missing bytes, hash mismatch, invalid binding, corrupt capture, stale
    // snapshot) is never waived by a person.
    if (finding.state === 'technical_failure') return bad('NOT_WAIVABLE');
    if (!ALLOWED_KINDS[finding.state].includes(input.kind)) return bad('KIND_NOT_ALLOWED');
    const reason = validateReason(input.kind, input.reason);
    if (!reason.ok) return reason;
    if (!this.#dispositions.has(finding.findingId) && this.#dispositions.size >= MAX_DISPOSITIONS)
      return bad('TOO_MANY');

    const candidate = {
      schema: DISPOSITION_SCHEMA,
      dispositionId: this.#deps.newId(),
      findingId: finding.findingId,
      findingDigest,
      snapshotDigest: review.checks.snapshotDigest,
      reviewer: account,
      kind: input.kind,
      reason: reason.data,
      recordedAt: this.#deps.now().toISOString(),
    };
    const parsed = reviewDispositionSchema.safeParse(candidate);
    if (!parsed.success) return bad('REASON_REQUIRED');
    const text = `${DECISION_ENTRY_PREFIX}${JSON.stringify(parsed.data)}`;
    if (utf8(text) > 4096) return bad('ENTRY_TOO_LARGE');

    const previous = this.#entryIds.get(finding.findingId);
    const vault = this.#deps.vault.commands;
    if (previous !== undefined) vault.removeEntry(matterId, previous);
    const added = vault.addEntry(matterId, { kind: 'note', text, confirmed: true });
    if (!added.ok) return bad('VAULT');
    const entry = this.#deps.vault
      .getSnapshot()
      .selectedMatter?.context.entries.find((e) => e.text === text);
    if (entry !== undefined) this.#entryIds.set(finding.findingId, entry.entryId);
    this.#dispositions.set(finding.findingId, parsed.data);
    // Any change to a disposition invalidates a log that was already recorded.
    if (this.#log !== null) {
      this.#log = null;
      this.#stale = true;
    }
    this.#publish();
    return good(parsed.data);
  }

  withdraw(findingId: string): void {
    if (!this.#dispositions.delete(findingId)) return;
    this.#removeEntry(findingId);
    if (this.#log !== null) {
      this.#log = null;
      this.#stale = true;
    }
    this.#publish();
  }

  /**
   * The explicit "Record review decisions" action. It builds the decision log only from the
   * dispositions actually recorded above. It refuses while any finding awaits a decision, a
   * technical failure exists or a reviewer marked a finding as requiring change.
   */
  async record(): Promise<DecisionResult<RecordedLog>> {
    const review = this.#deps.review.getSnapshot();
    const account = this.#deps.account();
    if (account === null) return bad('ACCOUNT_LOCKED');
    const { checks } = review;
    if (
      this.#matterId === null ||
      checks.status !== 'fresh' ||
      checks.snapshotDigest === null ||
      checks.reviewRecord === null
    )
      return bad('NOT_READY');
    const epoch = this.#epoch;
    if (checks.findings.some((f) => f.state === 'technical_failure'))
      return bad('TECHNICAL_FAILURE');
    const outstanding = checks.findings.filter(
      (f) => f.state !== 'ok' && !this.#dispositions.has(f.findingId),
    );
    if (outstanding.length > 0) return bad('OUTSTANDING');
    const dispositions = [...this.#dispositions.values()].sort((a, b) =>
      a.findingId < b.findingId ? -1 : 1,
    );
    if (dispositions.some((d) => d.kind === 'requires_change')) return bad('REQUIRES_CHANGE');
    const selected = review.documents.filter((d) => d.selected);
    const log = {
      schema: DECISION_LOG_SCHEMA,
      matterId: this.#matterId,
      reviewer: account,
      snapshotDigest: checks.snapshotDigest,
      recordedAt: this.#deps.now().toISOString(),
      rulePack: { digest: checks.reviewRecord.packDigest, reviewState: checks.reviewRecord.state },
      sources: selected.map((d) => ({
        documentVersionId: d.documentVersionId,
        sourceArtifactId: d.sourceArtifactId,
      })),
      facts: review.facts.map((f: ConfirmedFactV1) => ({
        factId: f.factId,
        contentSha256: f.contentSha256,
      })),
      scope: {
        findingIds: dispositions.map((d) => d.findingId),
        cleanPassIds: checks.findings.filter((f) => f.state === 'ok').map((f) => f.findingId),
      },
      dispositions,
      limitations: [...LOG_LIMITATIONS],
    };
    const parsed = decisionLogSchema.safeParse(log);
    if (!parsed.success) return bad('NOT_READY');
    const bytes = canonicalBytes(parsed.data);
    const logDigest = await canonicalDigest(parsed.data);
    // Inputs may have changed while hashing.
    if (
      epoch !== this.#epoch ||
      this.#deps.review.getSnapshot().checks.snapshotDigest !== checks.snapshotDigest
    )
      return bad('STALE');
    this.#log = Object.freeze({ record: parsed.data, bytes, digest: logDigest });
    this.#stale = false;
    this.#publish();
    return good(this.#log);
  }
}
