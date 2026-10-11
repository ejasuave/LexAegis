import {
  LIMITS,
  prepareReviewPackage,
  reviewPackageV1Schema,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
  type ReviewPackageV1,
} from '@lexaegis/protocol/v1';
import { agentConfigArtifactBytes, localAgentConfig, sha256Bytes } from '@lexaegis/agent/review';
import type { RecoverableCapture } from '@lexaegis/vault';
import {
  LEGAL_PROFILE_ID,
  LEGAL_PROFILE_VERSION,
  checkLegalProfilePresence,
} from '@/domain/legal/profile';
import type { DecisionSnapshot } from './decisions';
import type { ReviewSnapshot } from './controller';

/*
 * Package preview and freeze. The preview shows the exact proposed contents; Freeze captures
 * immutable bytes with Chapter 2's private random opening and hands that exact capture to the
 * encrypted persistence and read-back gate. Frozen and saved do not mean approved or issued, and
 * a signature, chain result or later edit never enters the hashed contents.
 */

export type PackageStatus = 'empty' | 'preview' | 'freezing' | 'saving' | 'recoverable' | 'failed';

export type PackageFailure =
  | 'NOT_READY'
  | 'ACCOUNT_LOCKED'
  | 'NO_REGISTRY'
  | 'DECISIONS_NOT_RECORDED'
  | 'DRAFT_FAILED'
  | 'MANIFEST_INVALID'
  | 'PROFILE_INCOMPLETE'
  | 'STALE'
  | 'NO_PREVIEW'
  | 'PREPARE_FAILED'
  | 'SAVE_FAILED'
  | 'NOT_VERIFIED'
  | 'BUSY';

export interface PreviewArtifact {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PackagePreview {
  readonly packageId: string;
  readonly preparedAt: string;
  readonly reviewer: string;
  readonly chainId: string;
  readonly registryAddress: string;
  readonly artifacts: readonly PreviewArtifact[];
  readonly scopeArtifactIds: readonly string[];
  readonly decisionLogArtifactId: string;
  readonly modelExecution: 'none' | 'provider';
  readonly supersedes: ReceiptReferenceV1 | null;
  readonly rulePackReviewState: 'demo_draft' | 'reviewed' | 'unknown';
  readonly decisionCount: number;
  /** Concerns the reviewer accepted, with their own reasons, for display before approval. */
  readonly acceptedConcerns: readonly { readonly findingId: string; readonly reason: string }[];
  readonly limitations: readonly string[];
}

export interface FrozenView {
  readonly commitment: string;
  readonly reference: ReceiptReferenceV1;
  readonly packageId: string;
  readonly preparedAt: string;
  readonly artifactCount: number;
  readonly state: 'saving' | 'recoverable' | 'failed';
  readonly failure: string | null;
}

export interface PackageSnapshot {
  readonly status: PackageStatus;
  readonly preview: PackagePreview | null;
  readonly frozen: FrozenView | null;
  readonly failure: PackageFailure | null;
  /** Working inputs changed after the current frozen package; it stays inspectable and immutable. */
  readonly workingChangedSinceFreeze: boolean;
  readonly notice: string;
}

const EMPTY: PackageSnapshot = Object.freeze({
  status: 'empty',
  preview: null,
  frozen: null,
  failure: null,
  workingChangedSinceFreeze: false,
  notice: '',
});
export const EMPTY_PACKAGE_SNAPSHOT = EMPTY;

export interface PackageReviewPort {
  getSnapshot(): ReviewSnapshot;
  subscribe(listener: () => void): () => void;
  draftArtifacts(agent?: {
    readonly analysisVersionId: string;
    readonly agentConfigVersionId: string;
  }): Promise<
    | {
        ok: true;
        artifacts: readonly {
          id: string;
          role: string;
          mediaType: string;
          label: string;
          bytes: Uint8Array;
          sha256: string;
        }[];
        outstanding: readonly { code: string; detail: string }[];
      }
    | { ok: false; code: string }
  >;
}

export interface PackageDecisionPort {
  getSnapshot(): DecisionSnapshot;
  subscribe(listener: () => void): () => void;
}

export type SaveOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: string };

export interface PackageVaultPort {
  getSnapshot(): { readonly generation: number; readonly selectedMatterId: string | null };
  subscribe(listener: () => void): () => void;
  commands: {
    saveFrozenReview(matterId: string, source: PreparedReviewPackage): Promise<SaveOutcome>;
    retryPendingCapture(commitment: string): Promise<SaveOutcome>;
    verifyStoredCapture(matterId: string, commitment: string): Promise<SaveOutcome>;
  };
  recoverableSubject(
    commitment: string,
  ): { capture: RecoverableCapture; reference: ReceiptReferenceV1 } | null;
}

export interface PackageDeps {
  readonly review: PackageReviewPort;
  readonly decisions: PackageDecisionPort;
  readonly vault: PackageVaultPort;
  readonly account: () => string | null;
  readonly config: () => { readonly chainId: string; readonly registryAddress: string | null };
  readonly now: () => Date;
  readonly newId: () => string;
  /** Test seam: the real protocol preparation by default. */
  readonly prepare?: typeof prepareReviewPackage;
}

interface Draft {
  readonly manifest: ReviewPackageV1;
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  readonly scope: string;
}

const LIMITATIONS = [
  'Approving this package approves the package, not the settlement agreement or its legal correctness.',
  'Hashes show the package is consistent with what you reviewed; they do not show it is true or complete.',
  'The rule pack is a demonstration draft unless its review record says otherwise.',
] as const;

export class PackageController {
  readonly #deps: PackageDeps;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribes: (() => void)[] = [];
  #state: PackageSnapshot = EMPTY;
  #draft: Draft | null = null;
  #prepared: PreparedReviewPackage | null = null;
  #epoch = 0;
  #generation = 0;
  #matterId: string | null = null;
  #scopeAtFreeze: string | null = null;
  #busy = false;

  constructor(deps: PackageDeps) {
    this.#deps = deps;
    this.#generation = deps.vault.getSnapshot().generation;
    this.#matterId = deps.vault.getSnapshot().selectedMatterId;
    const react = () => this.#onChange();
    this.#unsubscribes.push(
      deps.review.subscribe(react),
      deps.decisions.subscribe(react),
      deps.vault.subscribe(react),
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): PackageSnapshot => this.#state;

  dispose(): void {
    for (const off of this.#unsubscribes) off();
    this.#reset();
  }

  #publish(patch: Partial<PackageSnapshot>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  #reset(): void {
    this.#epoch++;
    this.#draft = null;
    this.#prepared = null;
    this.#scopeAtFreeze = null;
    this.#busy = false;
    this.#state = EMPTY;
    for (const listener of this.#listeners) listener();
  }

  /** The identity a preview or freeze was computed under. Any difference rejects stale work. */
  #scope(): string {
    const review = this.#deps.review.getSnapshot();
    const decisions = this.#deps.decisions.getSnapshot();
    return JSON.stringify([
      this.#deps.account(),
      this.#deps.vault.getSnapshot().generation,
      review.matterId,
      review.checks.snapshotDigest,
      review.documents.filter((d) => d.selected).map((d) => d.documentVersionId),
      decisions.log?.digest ?? null,
    ]);
  }

  #onChange(): void {
    const vault = this.#deps.vault.getSnapshot();
    if (vault.generation !== this.#generation || vault.selectedMatterId !== this.#matterId) {
      // Lock, unlock, account or matter change: private state does not survive it.
      this.#generation = vault.generation;
      this.#matterId = vault.selectedMatterId;
      this.#reset();
      return;
    }
    if (
      this.#draft !== null &&
      this.#state.status === 'preview' &&
      this.#draft.scope !== this.#scope()
    ) {
      // A relevant working change invalidates a pending preview. Nothing frozen is touched.
      this.#epoch++;
      this.#draft = null;
      this.#publish({
        status: 'empty',
        preview: null,
        failure: 'STALE',
        notice: 'Your working review changed, so the preview was discarded. Build it again.',
      });
      return;
    }
    if (
      this.#scopeAtFreeze !== null &&
      this.#state.frozen !== null &&
      this.#scopeAtFreeze !== this.#scope() &&
      !this.#state.workingChangedSinceFreeze
    ) {
      this.#publish({ workingChangedSinceFreeze: true });
    }
  }

  /** Assembles the exact proposed contents. Saves and freezes nothing. */
  async buildPreview(
    options: {
      readonly agent?: {
        readonly analysisVersionId: string;
        readonly agentConfigVersionId: string;
      };
      readonly supersedes?: ReceiptReferenceV1 | null;
    } = {},
  ): Promise<PackageSnapshot> {
    if (this.#busy) return this.#fail('BUSY');
    const account = this.#deps.account();
    if (account === null) return this.#fail('ACCOUNT_LOCKED');
    const { chainId, registryAddress } = this.#deps.config();
    if (registryAddress === null) return this.#fail('NO_REGISTRY');
    const decisions = this.#deps.decisions.getSnapshot();
    const log = decisions.log;
    if (log === null || !decisions.recorded || log.record.reviewer !== account)
      return this.#fail('DECISIONS_NOT_RECORDED');
    const review = this.#deps.review.getSnapshot();
    if (
      review.checks.status !== 'fresh' ||
      log.record.snapshotDigest !== review.checks.snapshotDigest
    )
      return this.#fail('STALE');

    const epoch = ++this.#epoch;
    const scope = this.#scope();
    const drafted = await this.#deps.review.draftArtifacts(options.agent);
    if (epoch !== this.#epoch || scope !== this.#scope()) return this.#fail('STALE');
    if (!drafted.ok) return this.#fail('DRAFT_FAILED');

    // Copy the bytes now; later mutation by anyone cannot change what is frozen.
    const entries: { ref: PreviewArtifact; bytes: Uint8Array }[] = [];
    let hasConfig = false;
    let usesModel = false;
    for (const artifact of drafted.artifacts) {
      entries.push({
        ref: {
          id: artifact.id,
          role: artifact.role,
          label: artifact.label,
          mediaType: artifact.mediaType,
          byteLength: artifact.bytes.byteLength,
          sha256: artifact.sha256,
        },
        bytes: artifact.bytes.slice(),
      });
      if (artifact.role === 'agent-config') {
        hasConfig = true;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(artifact.bytes)) as {
            modelExecution?: string;
          };
          usesModel = parsed.modelExecution !== 'none';
        } catch {
          usesModel = true;
        }
      }
    }
    if (!hasConfig) {
      // Code-only work records modelExecution "none"; nothing about a model is invented.
      const nowIso = this.#deps.now().toISOString();
      const config = localAgentConfig({
        viewId: this.#deps.newId(),
        intent: null,
        startedAt: nowIso,
        finishedAt: nowIso,
        toolExecutions: 0,
      });
      const made = await agentConfigArtifactBytes(config);
      entries.push({
        ref: {
          id: this.#deps.newId(),
          role: 'agent-config',
          label: 'agent configuration (no model)',
          mediaType: 'application/json',
          byteLength: made.bytes.byteLength,
          sha256: made.sha256,
        },
        bytes: made.bytes,
      });
    }
    const logId = this.#deps.newId();
    entries.push({
      ref: {
        id: logId,
        role: 'decision-log',
        label: 'review decision log',
        mediaType: 'application/json',
        byteLength: log.bytes.byteLength,
        sha256: await sha256Bytes(log.bytes),
      },
      bytes: log.bytes.slice(),
    });
    if (epoch !== this.#epoch || scope !== this.#scope()) return this.#fail('STALE');

    const manifestInput = {
      schema: 'lexaegis.review-package.v1',
      packageId: this.#deps.newId(),
      preparedAt: this.#deps.now().toISOString(),
      profile: { id: LEGAL_PROFILE_ID, version: LEGAL_PROFILE_VERSION },
      context: { chainId, registryAddress, reviewerAddress: account },
      supersedes: options.supersedes ?? null,
      artifacts: entries.map(({ ref }) => ({
        id: ref.id,
        role: ref.role,
        mediaType: ref.mediaType,
        label: ref.label,
        byteLength: String(ref.byteLength),
        sha256: ref.sha256,
      })),
      approval: {
        intent: 'approve-review-package',
        scopeArtifactIds: entries.map(({ ref }) => ref.id),
        decisionLogArtifactId: logId,
      },
    };
    const manifest = reviewPackageV1Schema.safeParse(manifestInput);
    if (!manifest.success) return this.#fail('MANIFEST_INVALID');
    const presence = checkLegalProfilePresence(manifest.data);
    if (presence.applicable && !presence.complete) return this.#fail('PROFILE_INCOMPLETE');
    if (entries.reduce((sum, e) => sum + e.bytes.byteLength, 0) > LIMITS.maxTotalArtifactBytes)
      return this.#fail('MANIFEST_INVALID');

    this.#draft = {
      manifest: manifest.data,
      bytes: new Map(entries.map(({ ref, bytes }) => [ref.id, bytes])),
      scope,
    };
    const preview: PackagePreview = {
      packageId: manifest.data.packageId,
      preparedAt: manifest.data.preparedAt,
      reviewer: account,
      chainId,
      registryAddress,
      artifacts: entries.map(({ ref }) => ref),
      scopeArtifactIds: manifest.data.approval.scopeArtifactIds,
      decisionLogArtifactId: logId,
      modelExecution: usesModel ? 'provider' : 'none',
      supersedes: manifest.data.supersedes,
      rulePackReviewState: log.record.rulePack.reviewState,
      decisionCount: log.record.dispositions.length,
      acceptedConcerns: log.record.dispositions
        .filter((d) => d.kind === 'accepted_unresolved' || d.kind === 'not_applicable')
        .map((d) => ({ findingId: d.findingId, reason: d.reason })),
      limitations: LIMITATIONS,
    };
    this.#publish({ status: 'preview', preview, failure: null, notice: '' });
    return this.#state;
  }

  #fail(failure: PackageFailure): PackageSnapshot {
    this.#publish({ failure, notice: '' });
    return this.#state;
  }

  /**
   * Explicit Freeze review package. Captures the exact preview with a fresh private opening and
   * passes that capture to the encrypted save and read-back gate. A retry never builds a second
   * capture: it reuses this one.
   */
  async freeze(): Promise<PackageSnapshot> {
    if (this.#busy) return this.#fail('BUSY');
    const draft = this.#draft;
    const matterId = this.#matterId;
    if (draft === null || this.#state.status !== 'preview' || matterId === null)
      return this.#fail('NO_PREVIEW');
    if (draft.scope !== this.#scope()) return this.#fail('STALE');
    this.#busy = true;
    const epoch = this.#epoch;
    this.#publish({ status: 'freezing', failure: null });
    const prepare = this.#deps.prepare ?? prepareReviewPackage;
    // Inputs are copied before the first await; the draft cannot be changed underneath.
    const prepared = await prepare(structuredClone(draft.manifest), new Map(draft.bytes));
    if (epoch !== this.#epoch) return this.#state;
    if (!prepared.ok) {
      this.#busy = false;
      this.#publish({ status: 'preview', failure: 'PREPARE_FAILED' });
      return this.#state;
    }
    this.#prepared = prepared.data;
    this.#scopeAtFreeze = draft.scope;
    return this.#save(epoch, (source) =>
      this.#deps.vault.commands.saveFrozenReview(matterId, source),
    );
  }

  /** Resumes an uncertain or failed save with the same opening, nonce, commitment and artifacts. */
  async retry(): Promise<PackageSnapshot> {
    const prepared = this.#prepared;
    if (this.#busy || prepared === null) return this.#fail(this.#busy ? 'BUSY' : 'NO_PREVIEW');
    this.#busy = true;
    const epoch = this.#epoch;
    this.#publish({ status: 'saving', failure: null });
    return this.#save(epoch, () =>
      this.#deps.vault.commands.retryPendingCapture(prepared.reference.commitment),
    );
  }

  async #save(
    epoch: number,
    run: (source: PreparedReviewPackage) => Promise<SaveOutcome>,
  ): Promise<PackageSnapshot> {
    const prepared = this.#prepared;
    if (prepared === null) {
      this.#busy = false;
      return this.#fail('NO_PREVIEW');
    }
    const frozen = (state: FrozenView['state'], failure: string | null): FrozenView => ({
      commitment: prepared.reference.commitment,
      reference: prepared.reference,
      packageId: prepared.opening.manifest.packageId,
      preparedAt: prepared.opening.manifest.preparedAt,
      artifactCount: prepared.artifactIds.length,
      state,
      failure,
    });
    this.#publish({ status: 'saving', frozen: frozen('saving', null) });
    const outcome = await run(prepared);
    if (epoch !== this.#epoch) return this.#state;
    this.#busy = false;
    if (!outcome.ok) {
      this.#publish({
        status: 'failed',
        failure: 'SAVE_FAILED',
        frozen: frozen('failed', outcome.failure),
        notice:
          outcome.failure === 'UNKNOWN_OUTCOME'
            ? 'The save outcome is unknown. Retry checks storage first and reuses the same package.'
            : 'The package was not saved. Retry reuses the same package.',
      });
      return this.#state;
    }
    // The capture is accepted only if the vault controller itself rebuilt it by read-back.
    const subject = this.#deps.vault.recoverableSubject(prepared.reference.commitment);
    if (subject === null) {
      this.#publish({
        status: 'failed',
        failure: 'NOT_VERIFIED',
        frozen: frozen('failed', 'NOT_VERIFIED'),
        notice: 'The saved package could not be verified in this unlock.',
      });
      return this.#state;
    }
    this.#draft = null;
    this.#publish({
      status: 'recoverable',
      failure: null,
      frozen: frozen('recoverable', null),
      notice: 'Frozen and saved. This is not approval, a signature or a receipt.',
    });
    return this.#state;
  }

  /**
   * After a reload: rebuild readiness for a stored package by retrieval, decryption and
   * verification in this unlock. Nothing persisted can claim it.
   */
  async reconnect(commitment: string): Promise<boolean> {
    const matterId = this.#matterId;
    if (matterId === null) return false;
    const epoch = this.#epoch;
    const outcome = await this.#deps.vault.commands.verifyStoredCapture(matterId, commitment);
    if (epoch !== this.#epoch || !outcome.ok) return false;
    const subject = this.#deps.vault.recoverableSubject(commitment);
    if (subject === null) return false;
    this.#publish({
      status: 'recoverable',
      frozen: {
        commitment,
        reference: subject.reference,
        packageId: '',
        preparedAt: '',
        artifactCount: subject.capture.objectCount,
        state: 'recoverable',
        failure: null,
      },
      notice: 'Stored package verified in this unlock. This is not approval or a receipt.',
    });
    return true;
  }

  discardPreview(): void {
    if (this.#state.status !== 'preview') return;
    this.#epoch++;
    this.#draft = null;
    this.#publish({ status: 'empty', preview: null, failure: null, notice: '' });
  }
}
