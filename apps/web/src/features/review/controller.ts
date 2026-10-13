import {
  REVIEW_LIMITS,
  type CheckFindingV1,
  type ConfirmedFactV1,
  type DocumentComparisonV1,
  type EvidenceChecklistV1,
  type EvidenceSelectionV1,
  type ExtractedDocumentV1,
  type PaymentReconciliationV1,
  type RulePackReviewRecordV1,
  type SelectedContextV1,
} from '@lexaegis/agent/contracts';
import {
  assembleComparison,
  assembleDraft,
  buildSelectedContext,
  buildSnapshot,
  checkSelectionLimits,
  confirmFact as makeConfirmedFact,
  createSourceReference,
  demoDraftReview,
  loadRulePack,
  prepareComparison,
  resolveSourceReference,
  runChecks,
  snapshotDigest,
  verifySourceSet,
  type ContextSelection,
  type DiffOutcome,
  type DraftAgentArtifacts,
  type DraftArtifact,
  type DraftRequirement,
  type LoadedRulePack,
  type LoadedSourceInput,
  type ResolvedSource,
  type SourceSet,
} from '@lexaegis/agent/review';
import type { IntakeResult } from '@/features/documents/pdf-intake';
import type { ExtractIdentity } from '@/features/documents/extract';
import type { VaultCommands, VaultSnapshot } from '@/features/vault/public';
import {
  COMPARISON_LABEL,
  EXTRACTION_LABEL,
  EVIDENCE_PREFIX,
  FACT_PREFIX,
  decodeEvidence,
  decodeFact,
  encodeEvidence,
  encodeFact,
  factIdOfEntry,
} from './persistence';

/*
 * One matter-scoped controller for document intake, extraction, confirmed facts, checks,
 * comparison and encrypted saves. Every asynchronous completion is tagged with an epoch that any
 * lock, matter or account change, input change or Stop advances, so a late result can never
 * repopulate a private pane or restore an old ready state. It sends no plaintext anywhere: the
 * only network traffic is the vault's ciphertext transport and static parser assets.
 */

export interface ReviewVaultPort {
  getSnapshot(): VaultSnapshot;
  subscribe(listener: () => void): () => void;
  commands: Pick<
    VaultCommands,
    | 'addSourceFile'
    | 'readSource'
    | 'addEntry'
    | 'correctEntry'
    | 'confirmEntry'
    | 'removeEntry'
    | 'saveMatter'
  >;
}

export interface IntakePort {
  run(bytes: Uint8Array, identity: Omit<ExtractIdentity, 'sourceSha256'>): Promise<IntakeResult>;
  cancel(): void;
}

export interface ReviewDeps {
  readonly vault: ReviewVaultPort;
  /** The verified account address while its passkey session is live, else null. */
  readonly account: () => string | null;
  readonly intake: IntakePort;
  /** Runs the text diff in a terminable worker. Resolves with an incomplete outcome when stopped. */
  readonly runDiff: (
    oldText: string,
    newText: string,
  ) => { promise: Promise<DiffOutcome>; cancel: () => void };
  readonly now: () => Date;
  readonly newId: () => string;
}

export type IntakeStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly label: string }
  | {
      readonly state: 'done';
      readonly label: string;
      readonly documentVersionId: string;
      readonly coverage: 'complete' | 'partial';
    }
  | { readonly state: 'failed'; readonly label: string; readonly reason: string };

export interface DocumentView {
  readonly documentVersionId: string;
  readonly sourceArtifactId: string;
  readonly label: string;
  readonly byteLength: string;
  readonly extraction: 'ready' | 'missing' | 'invalid';
  readonly coverage: ExtractedDocumentV1['coverage'] | null;
  readonly pageCount: number | null;
  readonly selected: boolean;
}

export interface ChecksView {
  readonly status: 'none' | 'running' | 'fresh' | 'stale';
  readonly findings: readonly CheckFindingV1[];
  readonly checklist: EvidenceChecklistV1 | null;
  readonly payments: readonly PaymentReconciliationV1[];
  readonly snapshotDigest: string | null;
  readonly reviewRecord: RulePackReviewRecordV1 | null;
}

export interface ComparisonView {
  readonly status: 'none' | 'running' | 'ready' | 'failed';
  readonly result: DocumentComparisonV1 | null;
  readonly failure: string | null;
}

export interface ReviewSnapshot {
  readonly matterId: string | null;
  readonly loading: boolean;
  readonly documents: readonly DocumentView[];
  readonly intake: IntakeStatus;
  readonly facts: readonly ConfirmedFactV1[];
  /** Saved facts whose citations no longer resolve; shown, never used by checks. */
  readonly unresolvedFacts: number;
  readonly evidence: readonly EvidenceSelectionV1[];
  readonly checks: ChecksView;
  readonly comparison: ComparisonView;
  readonly save: 'saved' | 'unsaved' | 'saving' | 'error';
  readonly error: string | null;
  /** Advances on every change to sources, selection, facts or evidence, and on lock or matter change. */
  readonly inputRevision: number;
}

/** What an assistant request may disclose, chosen deliberately. Facts are named by ID. */
export interface AssistantContextSelection extends Omit<ContextSelection, 'facts' | 'evidence'> {
  readonly factIds: readonly string[];
  readonly includeEvidence: boolean;
  readonly automaticQuery?: string;
}

export type AssistantContextResult =
  | {
      readonly ok: true;
      readonly context: SelectedContextV1;
      readonly snapshot: { readonly digest: string; readonly revision: number };
      readonly vaultGeneration: number;
    }
  | { readonly ok: false; readonly code: string };

const EMPTY: ReviewSnapshot = Object.freeze({
  matterId: null,
  loading: false,
  documents: Object.freeze([]),
  intake: Object.freeze({ state: 'idle' as const }),
  facts: Object.freeze([]),
  unresolvedFacts: 0,
  evidence: Object.freeze([]),
  checks: Object.freeze({
    status: 'none' as const,
    findings: [],
    checklist: null,
    payments: [],
    snapshotDigest: null,
    reviewRecord: null,
  }),
  comparison: Object.freeze({ status: 'none' as const, result: null, failure: null }),
  save: 'saved' as const,
  error: null,
  inputRevision: 0,
});
export { EMPTY as EMPTY_REVIEW_SNAPSHOT };

type Verified = { input: LoadedSourceInput; label: string; byteLength: string };

export class ReviewController {
  readonly #deps: ReviewDeps;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #state: ReviewSnapshot = EMPTY;
  #epoch = 0;
  #vaultGeneration = -1;
  #matterId: string | null = null;
  #verified = new Map<string, Verified>();
  #set: SourceSet | null = null;
  #selected = new Set<string>();
  #rulePack: LoadedRulePack | null = null;
  #diffCancel: (() => void) | null = null;
  #factEntries = new Map<string, string>();
  #evidenceEntry: string | null = null;
  /** Never reset, so a revision can not repeat across a lock, a matter change or a reload. */
  #revision = 0;
  #cleared = true;

  constructor(deps: ReviewDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.vault.subscribe(() => this.#onVault());
    this.#onVault();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): ReviewSnapshot => this.#state;

  #publish(patch: Partial<ReviewSnapshot>): void {
    this.#cleared = false;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#unsubscribe();
    this.stop();
    this.#clear();
    this.#listeners.clear();
  }

  /** Stop: cancels local extraction, comparison and checking. Saved versions and receipts are untouched. */
  stop(): void {
    this.#epoch += 1;
    this.#deps.intake.cancel();
    this.#diffCancel?.();
    this.#diffCancel = null;
    if (this.#state.intake.state === 'running') this.#publish({ intake: { state: 'idle' } });
    if (this.#state.checks.status === 'running')
      this.#publish({
        checks: {
          ...this.#state.checks,
          status: this.#state.checks.findings.length > 0 ? 'stale' : 'none',
        },
      });
    if (this.#state.comparison.status === 'running')
      this.#publish({ comparison: { status: 'none', result: null, failure: 'cancelled' } });
  }

  #clear(): void {
    this.#verified = new Map();
    this.#set = null;
    this.#selected = new Set();
    this.#factEntries = new Map();
    this.#evidenceEntry = null;
    this.#matterId = null;
    // Already empty (for example repeated vault events while locked): nothing to announce.
    if (this.#cleared) return;
    this.#cleared = true;
    this.#revision += 1;
    this.#state = Object.freeze({ ...EMPTY, inputRevision: this.#revision });
    for (const listener of this.#listeners) listener();
  }

  // ---- Vault binding ------------------------------------------------------------------------------

  #onVault(): void {
    const vault = this.#deps.vault.getSnapshot();
    const open = vault.state === 'unlocked' || vault.state === 'saving';
    const matterId = open ? vault.selectedMatterId : null;
    if (vault.generation !== this.#vaultGeneration || matterId !== this.#matterId || !open) {
      // Lock, account change, matter switch: private panes empty at once, jobs stop.
      const changed = this.#matterId !== null || this.#state.matterId !== null;
      this.#vaultGeneration = vault.generation;
      this.stop();
      if (changed || matterId === null) this.#clear();
      this.#matterId = matterId;
      if (matterId !== null) void this.#load(matterId, this.#epoch);
    }
  }

  async #ensureRulePack(): Promise<LoadedRulePack | null> {
    if (this.#rulePack !== null) return this.#rulePack;
    const loaded = await loadRulePack();
    if (loaded.ok) this.#rulePack = loaded.data;
    return this.#rulePack;
  }

  async #load(matterId: string, epoch: number): Promise<void> {
    this.#publish({ matterId, loading: true });
    const matter = this.#deps.vault.getSnapshot().selectedMatter;
    if (matter === null || matter.matterId !== matterId) return;
    const verified = new Map<string, Verified>();
    const inputs: LoadedSourceInput[] = [];
    for (const source of matter.sources) {
      if (source.mediaType !== 'application/pdf') continue;
      const extractionSource = matter.sources.find(
        (s) => s.label === `${EXTRACTION_LABEL}${source.documentVersionId}`,
      );
      if (extractionSource === undefined) continue;
      const [original, extraction] = await Promise.all([
        this.#deps.vault.commands.readSource(matterId, source.documentVersionId),
        this.#deps.vault.commands.readSource(matterId, extractionSource.documentVersionId),
      ]);
      if (epoch !== this.#epoch) return;
      if (!original.ok || !extraction.ok) continue;
      const input: LoadedSourceInput = {
        documentId: source.documentId,
        documentVersionId: source.documentVersionId,
        sourceArtifactId: source.artifactId,
        sourceSha256: source.sha256,
        sourceBytes: original.data,
        extractionArtifactId: extractionSource.artifactId,
        extractionSha256: extractionSource.sha256,
        extractionBytes: extraction.data,
      };
      verified.set(source.documentVersionId, {
        input,
        label: source.label,
        byteLength: source.byteLength,
      });
      inputs.push(input);
    }
    this.#verified = verified;
    this.#selected = new Set(inputs.map((i) => i.documentVersionId));
    await this.#rebuildSet(epoch);
    if (epoch !== this.#epoch) return;
    await this.#loadEntries(matter.context.entries, epoch);
    if (epoch !== this.#epoch) return;
    this.#publishDocuments({ loading: false });
  }

  /** Verifies the selected sources' hashes and bindings. A failure is reported, not skipped. */
  async #rebuildSet(epoch: number): Promise<void> {
    const matterId = this.#matterId;
    if (matterId === null) return;
    const selected = [...this.#selected].filter((id) => this.#verified.has(id));
    const result = await verifySourceSet(
      matterId,
      selected.map((id) => (this.#verified.get(id) as Verified).input),
      selected,
    );
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      this.#set = null;
      this.#publish({
        error: `A source or extraction failed verification (${result.code.toLowerCase().replaceAll('_', ' ')}).`,
      });
      return;
    }
    this.#set = result.data;
  }

  async #loadEntries(
    entries: readonly { entryId: string; text: string }[],
    epoch: number,
  ): Promise<void> {
    const facts: ConfirmedFactV1[] = [];
    let unresolved = 0;
    this.#factEntries = new Map();
    this.#evidenceEntry = null;
    let evidence: EvidenceSelectionV1[] = [];
    for (const entry of entries) {
      if (entry.text.startsWith(FACT_PREFIX)) {
        const factId = factIdOfEntry(entry.text);
        const decoded = this.#set === null ? null : await decodeFact(entry.text, this.#set);
        if (epoch !== this.#epoch) return;
        if (factId !== null) this.#factEntries.set(factId, entry.entryId);
        if (decoded === null) unresolved += 1;
        else facts.push(decoded);
      } else if (entry.text.startsWith(EVIDENCE_PREFIX)) {
        this.#evidenceEntry = entry.entryId;
        evidence = decodeEvidence(entry.text) ?? [];
      }
    }
    this.#publish({ facts, unresolvedFacts: unresolved, evidence });
  }

  #publishDocuments(extra: Partial<ReviewSnapshot> = {}): void {
    const matter = this.#deps.vault.getSnapshot().selectedMatter;
    const documents: DocumentView[] = [];
    for (const source of matter?.sources ?? []) {
      if (source.mediaType !== 'application/pdf') continue;
      const verified = this.#verified.get(source.documentVersionId);
      const set = this.#set?.sources.get(source.documentVersionId);
      documents.push({
        documentVersionId: source.documentVersionId,
        sourceArtifactId: source.artifactId,
        label: source.label,
        byteLength: source.byteLength,
        extraction:
          verified === undefined
            ? 'missing'
            : set === undefined && this.#selected.has(source.documentVersionId)
              ? 'invalid'
              : 'ready',
        coverage: set?.extraction.coverage ?? null,
        pageCount: set?.extraction.pageCount ?? null,
        selected: this.#selected.has(source.documentVersionId),
      });
    }
    this.#publish({ documents, ...extra });
  }

  /** Any change to sources, facts, evidence or rules marks dependent results stale and clears the draft. */
  #invalidate(): void {
    this.#epoch += 1;
    this.#revision += 1;
    const checks = this.#state.checks;
    this.#publish({
      inputRevision: this.#revision,
      ...(checks.status !== 'none' && { checks: { ...checks, status: 'stale' as const } }),
    });
    if (this.#state.comparison.status === 'running') {
      this.#diffCancel?.();
      this.#diffCancel = null;
      this.#publish({ comparison: { status: 'none', result: null, failure: 'cancelled' } });
    }
  }

  // ---- Documents ----------------------------------------------------------------------------------

  setSelected(documentVersionIds: readonly string[]): Promise<void> {
    this.#selected = new Set(documentVersionIds.filter((id) => this.#verified.has(id)));
    this.#invalidate();
    const epoch = this.#epoch;
    return this.#rebuildSet(epoch).then(() => {
      if (epoch === this.#epoch) this.#publishDocuments();
    });
  }

  /** Imports one PDF: validate, extract in a terminable worker, then store original and extraction encrypted. */
  async importPdf(file: { bytes: Uint8Array; label: string }): Promise<void> {
    const matterId = this.#matterId;
    if (matterId === null) return;
    const epoch = ++this.#epoch;
    const label = file.label.slice(0, 200);
    const sizes = checkSelectionLimits({
      pdfs: [...this.#verified.values()]
        .map((v) => ({
          bytes: Number(v.byteLength),
          pages: this.#set?.sources.get(v.input.documentVersionId)?.extraction.pageCount ?? 0,
        }))
        .concat([{ bytes: file.bytes.byteLength, pages: 0 }]),
      extractionBytes: [],
    });
    if (!sizes.ok) {
      this.#publish({ intake: { state: 'failed', label, reason: sizes.code } });
      return;
    }
    this.#publish({ intake: { state: 'running', label } });
    const documentId = this.#deps.newId();
    const documentVersionId = this.#deps.newId();
    const artifactId = this.#deps.newId();
    const result = await this.#deps.intake.run(file.bytes, {
      documentId,
      documentVersionId,
      sourceArtifactId: artifactId,
    });
    if (epoch !== this.#epoch) return;
    const fail = (reason: string) => this.#publish({ intake: { state: 'failed', label, reason } });
    if (result.status === 'refused') {
      fail(result.reason);
      return;
    }
    if (result.status === 'timeout') {
      fail('timeout');
      return;
    }
    if (result.status === 'stale') return;
    const outcome = result.outcome;
    if (outcome.kind !== 'extracted' && outcome.kind !== 'partial_coverage') {
      fail(
        outcome.kind === 'limit_exceeded'
          ? `limit_exceeded:${outcome.limit}`
          : outcome.kind === 'unsupported'
            ? `unsupported:${outcome.reason}`
            : outcome.kind,
      );
      return;
    }
    if (outcome.bytes.byteLength > REVIEW_LIMITS.extractionArtifactBytes) {
      fail('limit_exceeded:extraction_size');
      return;
    }
    this.#publish({ save: 'saving' });
    const stored = await this.#deps.vault.commands.addSourceFile(matterId, {
      bytes: file.bytes,
      mediaType: 'application/pdf',
      label,
      documentId,
      documentVersionId,
      artifactId,
    });
    if (epoch !== this.#epoch) return;
    if (!stored.ok) {
      this.#publish({
        save: 'error',
        intake: { state: 'failed', label, reason: `save:${stored.failure}` },
      });
      return;
    }
    const extractionArtifactId = this.#deps.newId();
    const saved = await this.#deps.vault.commands.addSourceFile(matterId, {
      bytes: outcome.bytes,
      mediaType: 'application/json',
      label: `${EXTRACTION_LABEL}${documentVersionId}`,
      documentId: this.#deps.newId(),
      artifactId: extractionArtifactId,
    });
    if (epoch !== this.#epoch) return;
    if (!saved.ok) {
      this.#publish({
        save: 'error',
        intake: { state: 'failed', label, reason: `save:${saved.failure}` },
      });
      return;
    }
    // Read both back through the vault (authenticate, decrypt, hash-check) before reporting success.
    const reloadEpoch = this.#epoch;
    await this.#load(matterId, reloadEpoch);
    if (reloadEpoch !== this.#epoch) return;
    this.#invalidate();
    this.#publish({
      save: 'saved',
      intake: {
        state: 'done',
        label,
        documentVersionId,
        coverage: outcome.kind === 'extracted' ? 'complete' : 'partial',
      },
    });
  }

  // ---- Source passages ----------------------------------------------------------------------------

  createReference(input: { documentVersionId: string; page: number; start: number; end: number }) {
    return this.#set === null
      ? { ok: false as const, code: 'VERSION_UNAVAILABLE' as const }
      : createSourceReference(this.#set, input);
  }

  resolve(reference: unknown): ResolvedSource {
    return this.#set === null
      ? { state: 'unavailable' }
      : resolveSourceReference(this.#set, reference);
  }

  extraction(documentVersionId: string): ExtractedDocumentV1 | null {
    return this.#set?.sources.get(documentVersionId)?.extraction ?? null;
  }

  /** Original PDF bytes for the page viewer. A copy: the controller's verified bytes stay private. */
  originalBytes(documentVersionId: string): Uint8Array | null {
    const bytes = this.#verified.get(documentVersionId)?.input.sourceBytes;
    return bytes === undefined ? null : bytes.slice();
  }

  // ---- Facts --------------------------------------------------------------------------------------

  async confirmFact(input: {
    candidate: unknown;
    basis: 'source' | 'reviewer_statement';
    statementReason: string | null;
    replaces?: string;
  }): Promise<{ ok: true } | { ok: false; code: string }> {
    const matterId = this.#matterId;
    const account = this.#deps.account();
    if (matterId === null || this.#set === null) return { ok: false, code: 'NO_SOURCES' };
    if (account === null) return { ok: false, code: 'ACCOUNT_LOCKED' };
    const epoch = this.#epoch;
    const replaces =
      input.replaces === undefined
        ? undefined
        : this.#state.facts.find((f) => f.factId === input.replaces);
    const made = await makeConfirmedFact({
      set: this.#set,
      candidate: input.candidate,
      basis: input.basis,
      statementReason: input.statementReason,
      confirmedBy: account,
      confirmedAt: this.#deps.now().toISOString(),
      existing: this.#state.facts,
      ...(replaces !== undefined && { replaces }),
    });
    if (epoch !== this.#epoch) return { ok: false, code: 'STALE' };
    if (!made.ok) return { ok: false, code: made.code };
    const fact = made.data;
    const text = encodeFact(fact);
    const vault = this.#deps.vault.commands;
    const existingEntry = this.#factEntries.get(fact.factId);
    let outcome;
    if (existingEntry !== undefined) {
      // A correction is a new revision; the old confirmation is gone until this one is accepted.
      outcome = vault.correctEntry(matterId, existingEntry, text);
      if (outcome.ok) outcome = vault.confirmEntry(matterId, existingEntry);
    } else {
      outcome = vault.addEntry(matterId, {
        kind: 'fact',
        text,
        confirmed: true,
        documentVersionId: fact.references[0]?.documentVersionId,
      });
      if (outcome.ok) {
        const entry = this.#deps.vault
          .getSnapshot()
          .selectedMatter?.context.entries.find((e) => factIdOfEntry(e.text) === fact.factId);
        if (entry !== undefined) this.#factEntries.set(fact.factId, entry.entryId);
      }
    }
    if (!outcome.ok) return { ok: false, code: `vault:${outcome.failure}` };
    this.#publish({
      facts: [...this.#state.facts.filter((f) => f.factId !== fact.factId), fact],
      save: 'unsaved',
    });
    this.#invalidate();
    return { ok: true };
  }

  removeFact(factId: string): { ok: boolean } {
    const matterId = this.#matterId;
    const entry = this.#factEntries.get(factId);
    if (matterId === null || entry === undefined) return { ok: false };
    const outcome = this.#deps.vault.commands.removeEntry(matterId, entry);
    if (!outcome.ok) return { ok: false };
    this.#factEntries.delete(factId);
    this.#publish({ facts: this.#state.facts.filter((f) => f.factId !== factId), save: 'unsaved' });
    this.#invalidate();
    return { ok: true };
  }

  setEvidence(selections: readonly EvidenceSelectionV1[]): { ok: boolean } {
    const matterId = this.#matterId;
    if (matterId === null) return { ok: false };
    const vault = this.#deps.vault.commands;
    const text = encodeEvidence(selections);
    const outcome =
      this.#evidenceEntry === null
        ? vault.addEntry(matterId, { kind: 'note', text, confirmed: false })
        : vault.correctEntry(matterId, this.#evidenceEntry, text);
    if (!outcome.ok) return { ok: false };
    if (this.#evidenceEntry === null) {
      this.#evidenceEntry =
        this.#deps.vault
          .getSnapshot()
          .selectedMatter?.context.entries.find((e) => e.text.startsWith(EVIDENCE_PREFIX))
          ?.entryId ?? null;
    }
    this.#publish({ evidence: [...selections], save: 'unsaved' });
    this.#invalidate();
    return { ok: true };
  }

  /** The explicit Save control for facts and evidence selections. */
  async save(): Promise<void> {
    const matterId = this.#matterId;
    if (matterId === null) return;
    this.#publish({ save: 'saving' });
    const result = await this.#deps.vault.commands.saveMatter(matterId);
    this.#publish({
      save: result.ok ? 'saved' : 'error',
      error: result.ok ? null : `save:${result.failure}`,
    });
  }

  // ---- Checks -------------------------------------------------------------------------------------

  async runChecks(): Promise<void> {
    const matterId = this.#matterId;
    const set = this.#set;
    const pack = await this.#ensureRulePack();
    if (matterId === null || pack === null) return;
    const epoch = ++this.#epoch;
    this.#publish({ checks: { ...this.#state.checks, status: 'running' } });
    const review = demoDraftReview(pack.digest);
    const snapshot = await this.#inputDigest(matterId, pack);
    const emptySet: SourceSet = { matterId, sources: new Map(), selected: new Set() };
    const result = await runChecks({
      matterId,
      sources: set ?? emptySet,
      integrityFailure: set === null && this.#selected.size > 0 ? 'EXTRACTION_INVALID' : null,
      facts: this.#state.facts,
      evidence: this.#state.evidence,
      rulePack: pack,
      reviewRecord: review,
    });
    if (epoch !== this.#epoch) return;
    if (!result.ok) {
      this.#publish({
        checks: { ...this.#state.checks, status: 'stale' },
        error: result.code,
      });
      return;
    }
    this.#publish({
      checks: {
        status: 'fresh',
        findings: result.data.findings,
        checklist: result.data.checklist,
        payments: result.data.payments,
        snapshotDigest: snapshot,
        reviewRecord: review,
      },
    });
  }

  /** Digest of the exact current inputs: selected sources, facts, evidence and the pinned rules. */
  #inputDigest(matterId: string, pack: LoadedRulePack): Promise<string> {
    const set = this.#set;
    const sources = [...(set?.sources.values() ?? [])].filter((s) =>
      set?.selected.has(s.documentVersionId),
    );
    return snapshotDigest(
      buildSnapshot({
        matterId,
        sources: sources.map((s) => ({
          documentVersionId: s.documentVersionId,
          sourceSha256: s.sourceSha256,
          extractionSha256: s.extractionSha256,
        })),
        facts: this.#state.facts,
        evidence: this.#state.evidence,
        rulePackDigest: pack.digest,
        reviewRecordState: demoDraftReview(pack.digest).state,
      }),
    );
  }

  // ---- Assistant context --------------------------------------------------------------------------

  /**
   * Builds the context one assistant request may disclose, from the decrypted, hash-verified
   * artifacts of this unlock. It sends nothing: transmission needs the separate consent step.
   * Every excerpt must resolve against the verified set; nothing outside the selection is read.
   */
  async assistantContext(selection: AssistantContextSelection): Promise<AssistantContextResult> {
    const matterId = this.#matterId;
    const set = this.#set;
    if (matterId === null || set === null) return { ok: false, code: 'NO_SOURCES' };
    const pack = await this.#ensureRulePack();
    if (pack === null) return { ok: false, code: 'RULE_PACK_INVALID' };
    const epoch = this.#epoch;
    const revision = this.#revision;
    const wanted = new Set(selection.factIds);
    let contextSet = set;
    let refs = selection.references;
    let automatic:
      | { availableDocuments: number; readableDocuments: number; includedDocuments: number; availablePages: number; excerptedPages: number }
      | undefined;
    if (selection.automaticQuery !== undefined) {
      // Read verified sources only from the active unlocked matter; do not change Review selection.
      const inputs = [...this.#verified.values()].map((v) => v.input);
      const verified = await verifySourceSet(matterId, inputs, inputs.map((v) => v.documentVersionId));
      if (!verified.ok) return { ok: false, code: verified.code };
      contextSet = verified.data;
      const terms = [...new Set((selection.automaticQuery.toLowerCase().match(/[a-z]{4,}/g) ?? []))].slice(0, 12);
      const pages: { id: string; page: number; score: number; text: string }[] = [];
      for (const [id, source] of contextSet.sources) {
        for (const page of source.extraction.pages) {
          if (page.text.trim() === '') continue;
          const lower = page.text.toLowerCase();
          pages.push({ id, page: page.index, score: terms.filter((term) => lower.includes(term)).length, text: page.text });
        }
      }
      pages.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.page - b.page);
      const chosen: typeof pages = [];
      const seen = new Set<string>();
      for (const page of pages) {
        if (chosen.length >= 8) break;
        if (!seen.has(page.id)) { chosen.push(page); seen.add(page.id); }
      }
      for (const page of pages) {
        if (chosen.length >= 12) break;
        if (!chosen.includes(page) && seen.has(page.id)) chosen.push(page);
      }
      const references = [];
      for (const page of chosen) {
        const made = createSourceReference(contextSet, {
          documentVersionId: page.id, page: page.page, start: 0, end: Math.min(page.text.length, 450),
        });
        if (!made.ok) return { ok: false, code: made.code };
        references.push(made.data);
      }
      refs = references;
      automatic = {
        availableDocuments: this.#state.documents.length,
        readableDocuments: contextSet.sources.size,
        includedDocuments: seen.size,
        availablePages: pages.length,
        excerptedPages: chosen.length,
      };
    }
    const built = buildSelectedContext(contextSet, {
      documentVersionId: automatic === undefined ? selection.documentVersionId : null,
      references: refs,
      facts: this.#state.facts.filter((f) => wanted.has(f.factId)),
      evidence: selection.includeEvidence ? this.#state.evidence : [],
      savedContext: selection.savedContext,
    });
    if (!built.ok) return built;
    const digest = await this.#inputDigest(matterId, pack);
    if (epoch !== this.#epoch || revision !== this.#revision) return { ok: false, code: 'STALE' };
    return {
      ok: true,
      context: automatic === undefined ? built.data : { ...built.data, searchedScope: { ...built.data.searchedScope, automatic } },
      snapshot: { digest, revision },
      vaultGeneration: this.#vaultGeneration,
    };
  }

  /** The current input digest, for comparing a finished run with the inputs it was built from. */
  async currentInputDigest(): Promise<string | null> {
    const matterId = this.#matterId;
    const pack = await this.#ensureRulePack();
    return matterId === null || pack === null ? null : this.#inputDigest(matterId, pack);
  }

  // ---- Comparison ---------------------------------------------------------------------------------

  async compare(spec: {
    oldVersionId: string;
    newVersionId: string;
    oldPages?: [number, number];
    newPages?: [number, number];
  }): Promise<void> {
    const matterId = this.#matterId;
    const set = this.#set;
    if (matterId === null || set === null) return;
    const epoch = ++this.#epoch;
    const full = { matterId, ...spec };
    const prepared = prepareComparison(set, full);
    if (!prepared.ok) {
      this.#publish({
        comparison: { status: 'failed', result: null, failure: prepared.code },
      });
      return;
    }
    this.#publish({ comparison: { status: 'running', result: null, failure: null } });
    const job = this.#deps.runDiff(prepared.data.old.text, prepared.data.new.text);
    this.#diffCancel = job.cancel;
    const outcome = await job.promise;
    if (epoch !== this.#epoch) return;
    this.#diffCancel = null;
    const assembled = assembleComparison(set, full, prepared.data, outcome);
    this.#publish({
      comparison: assembled.ok
        ? { status: 'ready', result: assembled.data, failure: null }
        : { status: 'failed', result: null, failure: assembled.code },
    });
  }

  /** Saves a comparison only on explicit request, as an immutable encrypted artifact. */
  async saveComparison(): Promise<boolean> {
    const matterId = this.#matterId;
    const result = this.#state.comparison.result;
    if (matterId === null || result === null) return false;
    const { canonicalBytes } = await import('@lexaegis/agent/review');
    const stored = await this.#deps.vault.commands.addSourceFile(matterId, {
      bytes: canonicalBytes(result),
      mediaType: 'application/json',
      label: COMPARISON_LABEL,
    });
    return stored.ok;
  }

  // ---- Draft artifacts ----------------------------------------------------------------------------

  /** A typed draft with outstanding requirements. It is not a signed capture and enables no signing. */
  async draftArtifacts(agent?: {
    /** Vault versions of a saved assistant analysis and its agent configuration. */
    readonly analysisVersionId: string;
    readonly agentConfigVersionId: string;
  }): Promise<
    | { ok: true; artifacts: DraftArtifact[]; outstanding: DraftRequirement[] }
    | { ok: false; code: string }
  > {
    const matterId = this.#matterId;
    const set = this.#set;
    const pack = await this.#ensureRulePack();
    const checks = this.#state.checks;
    if (matterId === null || set === null || pack === null) return { ok: false, code: 'NOT_READY' };
    if (
      checks.status !== 'fresh' ||
      checks.snapshotDigest === null ||
      checks.checklist === null ||
      checks.reviewRecord === null
    ) {
      return { ok: false, code: 'STALE_RESULT' };
    }
    const sources = [...set.sources.values()].filter((s) => set.selected.has(s.documentVersionId));
    // Saved agent artifacts are read back through the vault (decrypted and hash-checked) and then
    // checked again by the assembler against the current snapshot.
    let agentArtifacts: DraftAgentArtifacts | undefined;
    if (agent !== undefined) {
      const records = this.#deps.vault.getSnapshot().selectedMatter?.sources ?? [];
      const epoch = this.#epoch;
      const load = async (versionId: string) => {
        const record = records.find((source) => source.documentVersionId === versionId);
        if (record === undefined) return null;
        const bytes = await this.#deps.vault.commands.readSource(matterId, versionId);
        return bytes.ok ? { artifactId: record.artifactId, bytes: bytes.data } : null;
      };
      const analysis = await load(agent.analysisVersionId);
      const config = await load(agent.agentConfigVersionId);
      if (epoch !== this.#epoch) return { ok: false, code: 'STALE_RESULT' };
      if (analysis === null || config === null)
        return { ok: false, code: 'AGENT_ARTIFACT_INVALID' };
      agentArtifacts = { analysis, config };
    }
    const assembled = await assembleDraft({
      matterId,
      snapshotDigest: checks.snapshotDigest,
      resultSnapshotDigest: checks.snapshotDigest,
      sources: sources.map((s) => ({
        artifactId: s.sourceArtifactId,
        documentVersionId: s.documentVersionId,
        label: this.#verified.get(s.documentVersionId)?.label ?? 'document.pdf',
        bytes: (this.#verified.get(s.documentVersionId) as Verified).input.sourceBytes,
        extractionArtifactId: s.extractionArtifactId,
        extractionBytes: (this.#verified.get(s.documentVersionId) as Verified).input
          .extractionBytes,
      })),
      evidenceFiles: [],
      facts: this.#state.facts,
      findings: checks.findings,
      payments: checks.payments.filter((p) => p.mode === 'review'),
      checklist: checks.checklist,
      comparisons: this.#state.comparison.result === null ? [] : [this.#state.comparison.result],
      rulePack: pack,
      reviewRecord: checks.reviewRecord,
      newId: this.#deps.newId,
      ...(agentArtifacts !== undefined && { agent: agentArtifacts }),
    });
    return assembled.ok ? { ok: true, ...assembled.data } : { ok: false, code: assembled.code };
  }
}
