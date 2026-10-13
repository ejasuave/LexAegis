import {
  LOCAL_INTENTS,
  TERMINAL_EVENT_TYPES,
  TOOL_VERSION,
  assistantEventSchema,
  isTerminalRunState,
  routeUtterance,
  toolResultSchema,
  utf8Bytes,
  ASSISTANT_LIMITS,
  type AgentConfig,
  type AnswerBlock,
  type AssistantAvailability,
  type AssistantEvent,
  type AssistantIntent,
  type AssistantPlan,
  type AssistantRequest,
  type AssistantRunState,
  type ClientObservedStatus,
  type ConversationMessage,
  type ModelExecution,
  type ResponseSummary,
  type RunFailureCode,
  type RunOutcome,
  type SourceCatalogEntry,
  type SourceReferenceV1,
  type ToolResult,
} from '@lexaegis/agent/contracts';
import {
  agentConfigArtifactBytes,
  analysisArtifactBytes,
  localAgentConfig,
  sha256Bytes,
  type ArtifactBytes,
  type ResolvedSource,
} from '@lexaegis/agent/review';
import type {
  AssistantContextResult,
  AssistantContextSelection,
  ReviewSnapshot,
} from '@/features/review/controller';
import type { VaultCommands, VaultSnapshot } from '@/features/vault/public';
import type { AssistantTransport } from './api-client';
import {
  consentToDisclosure,
  prepareDisclosure,
  type CurrentBinding,
  type PendingDisclosure,
} from './disclosure';
import { AGENT_CONFIG_LABEL, ANALYSIS_LABEL, encodeOutcome, summariseRun } from './saved-outcomes';
import { buildRequestBody, observeClient, type ContextPorts } from './selected-context';

/*
 * The browser's assistant controller. It routes a request to a local handler or to the disclosed
 * runtime flow, applies server events to one run view, and owns Stop. Everything it holds is
 * ephemeral and in memory: the conversation, the pending disclosure and the catalog of excerpts
 * are cleared on lock, account or matter change, and nothing is written to browser storage.
 *
 * A finished run changes no other state: it cannot confirm a fact, save, approve, sign or send a
 * transaction. Events for another run, matter, version, snapshot or vault generation are dropped,
 * and a stream with a gap or a malformed event is never merged into a completed result.
 */

export interface AssistantPorts {
  readonly review: {
    getSnapshot(): ReviewSnapshot;
    subscribe(listener: () => void): () => void;
    assistantContext(selection: AssistantContextSelection): Promise<AssistantContextResult>;
    resolve(reference: unknown): ResolvedSource;
    runChecks(): Promise<void>;
    /** Chapter 8's reviewer-only confirmation. Called solely from an explicit Confirm control. */
    confirmFact(input: {
      candidate: unknown;
      basis: 'source' | 'reviewer_statement';
      statementReason: string | null;
      replaces?: string;
    }): Promise<{ ok: true } | { ok: false; code: string }>;
    currentInputDigest(): Promise<string | null>;
  };
  readonly vault: {
    getSnapshot(): VaultSnapshot;
    subscribe(listener: () => void): () => void;
    commands: Pick<
      VaultCommands,
      'addSourceFile' | 'readSource' | 'addEntry' | 'saveMatter' | 'reconcile'
    >;
  };
  readonly account: () => { readonly present: boolean; readonly unlocked: boolean };
  readonly transport: AssistantTransport;
  readonly now: () => Date;
  readonly newId: () => string;
}

export type RunPhase = 'idle' | 'preview' | 'running' | 'stopping';
export type OrbReading = AssistantRunState | 'unavailable' | 'ready';

export interface LocalStatus {
  readonly client: ClientObservedStatus;
  readonly assistant: AssistantAvailability['state'] | 'unknown';
}

/** One run as the interface shows it. Local handlers produce the same shape with no model. */
export interface RunView {
  readonly id: string;
  readonly runId: string | null;
  readonly origin: 'assistant' | 'local';
  readonly intent: AssistantIntent | null;
  readonly modelExecution: ModelExecution | 'pending';
  readonly state: AssistantRunState;
  readonly outcome: RunOutcome | null;
  readonly plan: AssistantPlan | null;
  readonly tools: readonly ToolResult[];
  readonly toolsStarted: readonly string[];
  readonly blocks: readonly AnswerBlock[];
  readonly summary: ResponseSummary | null;
  /** The consented excerpts of this request, kept so a handle opens its exact source. */
  readonly catalog: readonly SourceCatalogEntry[];
  readonly failure: {
    readonly code: RunFailureCode | 'TRANSPORT';
    readonly message: string;
  } | null;
  /** True only after exactly one terminal event over a gap-free stream. */
  readonly complete: boolean;
  readonly incomplete: 'stream_gap' | 'stream_lost' | 'malformed_event' | 'stopped' | null;
  /** The inputs changed after this result was produced. It stays visible, labelled out of date. */
  readonly stale: boolean;
  readonly agentConfig: AgentConfig | null;
  readonly matterId: string;
  readonly documentVersionId: string | null;
  readonly snapshot: { readonly digest: string; readonly revision: number };
  readonly vaultGeneration: number;
  readonly localStatus: LocalStatus | null;
  readonly startedAt: string;
  /** What the reviewer did with each proposal. A proposal confirms nothing until they act. */
  readonly proposals: Readonly<Record<string, 'confirmed' | 'dismissed'>>;
  /** saved only after the encrypted artifact was read back and the catalog commit succeeded. */
  readonly save: {
    readonly state: 'unsaved' | 'saving' | 'saved' | 'failed';
    readonly message: string | null;
  };
}

export interface ConversationItem {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'notice';
  readonly text: string;
  readonly run: RunView | null;
}

export interface AssistantSnapshot {
  readonly availability: AssistantAvailability | null;
  readonly availabilityStatus: 'unknown' | 'loading' | 'ready' | 'signed_out' | 'unreachable';
  readonly phase: RunPhase;
  /** What the orb shows. It follows real run state only. */
  readonly orb: OrbReading;
  readonly pending: PendingDisclosure | null;
  readonly includeHistory: boolean;
  readonly conversation: readonly ConversationItem[];
  readonly activeRunViewId: string | null;
  /** Short factual status for the live region. Never a description of reasoning. */
  readonly notice: string;
  readonly selectionCount: number;
}

export const EMPTY_ASSISTANT_SNAPSHOT: AssistantSnapshot = Object.freeze({
  availability: null,
  availabilityStatus: 'unknown',
  phase: 'idle',
  orb: 'unavailable',
  pending: null,
  includeHistory: true,
  conversation: Object.freeze([]),
  activeRunViewId: null,
  notice: '',
  selectionCount: 0,
});

/** A stable identity for a selection, so a changed one can be told from an unchanged one. */
function selectionKey(
  documentVersionId: string | null,
  references: readonly SourceReferenceV1[],
): string {
  return JSON.stringify([documentVersionId, references]);
}

export interface SubmitInput {
  readonly intent: AssistantIntent | null;
  readonly trigger: AssistantRequest['trigger'];
  readonly utterance: string;
  /** Passages for this request. Defaults to the reviewer's current selection. */
  readonly references?: readonly SourceReferenceV1[];
  readonly savedEntryIds?: readonly string[];
}

interface ActiveRun {
  readonly viewId: string;
  readonly request: AssistantRequest;
  readonly abort: AbortController;
  runId: string | null;
  lastSeq: number;
  terminal: boolean;
  stopRequested: boolean;
}

const NOTICES = {
  signedOut: 'Sign in on the Vault page to use Aegis.',
  notConfigured: 'Aegis analysis is not configured. Local checks and status still work.',
  notVerified: 'The assistant configuration has not been verified, so nothing can be sent yet.',
  needSelection: 'Select the text in the document first, then ask again.',
  whichPassage:
    'Which passage is this about? Select it in the document and ask again, or use a command such as /check-payments.',
  noMatter: 'Open a matter and unlock the vault first.',
  stale: 'The review inputs changed, so the run was stopped. Start a new request.',
  cleared: 'The vault, account or matter changed. The conversation was cleared.',
  disclosureChanged: 'What would be sent has changed. Review it again before sending.',
  stopping: 'Stopping. Text already sent cannot be retracted.',
  unsupported: 'Aegis cannot approve, sign or change facts or rules. Use the dedicated controls.',
} as const;

const describeCode = (code: string): string =>
  ({
    NO_MATTER: NOTICES.noMatter,
    NO_SOURCES: 'Import a document and select it for review first.',
    SOURCE_UNRESOLVED: 'A selected passage no longer matches the stored document. Select it again.',
    CONTEXT_TOO_LARGE: 'The selection is too large to send (32 KiB limit). Select less.',
    CATALOG_TOO_LARGE: 'Too many passages are selected (64 at most). Select fewer.',
    QUOTE_TOO_LONG: 'A selected passage is too long (4 KiB at most). Select a shorter one.',
    UTTERANCE_TOO_LARGE: 'The message is too long (4 KiB at most).',
    HISTORY_TOO_LARGE: 'The earlier messages are too long to include. Send without them.',
    STALE: 'The review inputs changed while preparing. Try again.',
    DISCLOSURE_STALE: NOTICES.disclosureChanged,
    ASSISTANT_NOT_CONFIGURED: NOTICES.notConfigured,
    ASSISTANT_NOT_VERIFIED: NOTICES.notVerified,
    CONTEXT_ENTRY_UNCONFIRMED: 'Only saved context you have confirmed can be included.',
  })[code] ?? 'The request could not be prepared.';

export class AssistantController {
  readonly #ports: AssistantPorts;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: (() => void)[];
  #state: AssistantSnapshot = EMPTY_ASSISTANT_SNAPSHOT;
  #active: ActiveRun | null = null;
  #binding: CurrentBinding = {
    providerScope: null,
    matterId: null,
    inputRevision: -1,
    vaultGeneration: -1,
  };
  #previewSelectionKey: string | null = null;
  #selection: { documentVersionId: string | null; references: readonly SourceReferenceV1[] } = {
    documentVersionId: null,
    references: [],
  };
  #lastInput: SubmitInput | null = null;
  /** Version IDs fixed per result, so a retried save never stores an artifact twice. */
  readonly #assigned = new Map<string, { analysis?: string; config?: string }>();
  #epoch = 0;
  #disposed = false;

  constructor(ports: AssistantPorts) {
    this.#ports = ports;
    this.#binding = this.#currentBinding();
    this.#unsubscribe = [
      ports.review.subscribe(() => this.#onInputs()),
      ports.vault.subscribe(() => this.#onInputs()),
    ];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): AssistantSnapshot => this.#state;

  #publish(patch: Partial<AssistantSnapshot>): void {
    if (this.#disposed) return;
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#abandonActive();
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#listeners.clear();
    this.#state = EMPTY_ASSISTANT_SNAPSHOT;
  }

  // ---- Bindings: matter, inputs, vault generation ---------------------------------------------------

  #currentBinding(): CurrentBinding {
    const review = this.#ports.review.getSnapshot();
    return {
      providerScope: this.#state.availability?.providerScope ?? null,
      matterId: review.matterId,
      inputRevision: review.inputRevision,
      vaultGeneration: this.#ports.vault.getSnapshot().generation,
    };
  }

  #onInputs(): void {
    if (this.#disposed) return;
    const next = this.#currentBinding();
    const previous = this.#binding;
    this.#binding = next;
    if (next.matterId !== previous.matterId || next.vaultGeneration !== previous.vaultGeneration) {
      // Lock, account or matter change: every private view and buffer goes, and callbacks die.
      const had = this.#state.conversation.length > 0 || this.#state.pending !== null;
      this.#epoch += 1;
      this.#abandonActive();
      this.#selection = { documentVersionId: null, references: [] };
      this.#lastInput = null;
      this.#assigned.clear();
      this.#publish({
        phase: 'idle',
        orb: this.#idleOrb(),
        pending: null,
        conversation: [],
        activeRunViewId: null,
        selectionCount: 0,
        notice: had ? NOTICES.cleared : '',
      });
      return;
    }
    if (next.inputRevision !== previous.inputRevision) {
      // A source, fact, rule or evidence revision: stop the run, drop the consent, mark results stale.
      this.#epoch += 1;
      const running = this.#active !== null && !this.#active.terminal;
      if (running) void this.stop('stale');
      this.#publish({
        pending: null,
        phase: running ? 'stopping' : this.#state.phase === 'preview' ? 'idle' : this.#state.phase,
        conversation: this.#state.conversation.map((item) =>
          item.run === null || item.run.stale
            ? item
            : { ...item, run: { ...item.run, stale: true } },
        ),
        notice:
          running || this.#state.pending !== null
            ? running
              ? NOTICES.stale
              : NOTICES.disclosureChanged
            : this.#state.notice,
      });
    }
  }

  #idleOrb(): OrbReading {
    const status = this.#state.availabilityStatus;
    const state = this.#state.availability?.state;
    return status === 'ready' && (state === 'verified' || state === 'test_provider')
      ? 'ready'
      : 'unavailable';
  }

  /** Asks the server which provider a request would reach. Called on mount and after sign-in. */
  async refreshAvailability(): Promise<void> {
    this.#publish({ availabilityStatus: 'loading' });
    const result = await this.#ports.transport.availability();
    if (this.#disposed) return;
    if (!result.ok) {
      this.#publish({
        availability: null,
        availabilityStatus: result.code === 'UNAUTHENTICATED' ? 'signed_out' : 'unreachable',
        orb: this.#active === null ? 'unavailable' : this.#state.orb,
      });
      return;
    }
    const before = this.#state.availability?.providerScope ?? null;
    const after = result.availability.providerScope;
    const scopeChanged =
      before?.provider !== after?.provider ||
      before?.model !== after?.model ||
      before?.region !== after?.region;
    this.#state = Object.freeze({
      ...this.#state,
      availability: result.availability,
      availabilityStatus: 'ready',
    });
    this.#binding = this.#currentBinding();
    this.#publish({
      // A changed provider scope voids any consent that was being reviewed.
      pending: scopeChanged ? null : this.#state.pending,
      phase: scopeChanged && this.#state.phase === 'preview' ? 'idle' : this.#state.phase,
      orb: this.#active === null ? this.#idleOrb() : this.#state.orb,
    });
  }

  // ---- Selection ----------------------------------------------------------------------------------

  /** The passages the reviewer has selected in the source viewer for the next request. */
  setSelection(documentVersionId: string | null, references: readonly SourceReferenceV1[]): void {
    this.#selection = { documentVersionId, references: [...references] };
    // A preview built from the selection says what WOULD be sent. When the reviewer changes the
    // selection, that preview no longer describes their choice, so it is discarded: consent is
    // renewed by a new preview, never carried over to a different excerpt.
    if (
      this.#state.phase === 'preview' &&
      this.#previewSelectionKey !== null &&
      this.#previewSelectionKey !== selectionKey(documentVersionId, references)
    ) {
      this.#epoch += 1;
      this.#previewSelectionKey = null;
      this.#publish({
        phase: 'idle',
        pending: null,
        notice:
          'The selection changed, so the preview was discarded. Nothing was sent. Choose the action again to review what will be sent.',
      });
    }
    if (this.#state.selectionCount !== references.length)
      this.#publish({ selectionCount: references.length });
  }

  // ---- Conversation helpers -------------------------------------------------------------------------

  #add(item: Omit<ConversationItem, 'id'>): string {
    const id = this.#ports.newId();
    this.#publish({ conversation: [...this.#state.conversation, { ...item, id }] });
    return id;
  }

  #note(text: string): void {
    this.#add({ role: 'notice', text, run: null });
    this.#publish({ notice: text });
  }

  #patchRun(viewId: string, patch: Partial<RunView>): void {
    this.#publish({
      conversation: this.#state.conversation.map((item) =>
        item.run?.id === viewId ? { ...item, run: { ...item.run, ...patch } } : item,
      ),
    });
  }

  #run(viewId: string): RunView | null {
    return this.#state.conversation.find((item) => item.run?.id === viewId)?.run ?? null;
  }

  /** Earlier messages as bounded, untrusted text: the last six, within 8 KiB. */
  #history(): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    for (const item of this.#state.conversation) {
      if (item.role === 'user' && item.text.trim() !== '')
        messages.push({ role: 'user', text: item.text });
      if (
        item.role === 'assistant' &&
        item.run?.complete === true &&
        item.run.origin === 'assistant'
      ) {
        const text = item.run.blocks
          .flatMap((block) =>
            'text' in block ? [block.text] : block.comment === '' ? [] : [block.comment],
          )
          .join(' ')
          .slice(0, 1500);
        if (text !== '') messages.push({ role: 'assistant', text });
      }
    }
    const recent = messages.slice(-ASSISTANT_LIMITS.historyMessages);
    while (
      recent.reduce((sum, message) => sum + utf8Bytes(message.text), 0) >
      ASSISTANT_LIMITS.historyBytes
    ) {
      recent.shift();
    }
    return recent;
  }

  // ---- Entry points ---------------------------------------------------------------------------------

  /** Typed input from the command dock. Slash commands and equivalent phrases share one router. */
  async submit(text: string): Promise<void> {
    const routed = routeUtterance(text);
    if (routed.kind === 'stop') return this.stop();
    if (this.#busy()) {
      this.#publish({ notice: 'A run is in progress. Stop it first, or wait for it to finish.' });
      return;
    }
    if (routed.kind === 'unsupported') {
      if (routed.reason === 'empty') return;
      this.#add({ role: 'user', text, run: null });
      this.#note(NOTICES.unsupported);
      return;
    }
    if (routed.kind === 'unknown_command') {
      this.#note(`Unknown command ${routed.command}. Use the Commands menu.`);
      return;
    }
    // Slash commands keep their existing narrow behaviour; ordinary prose, including
    // follow-up questions, goes to matter Q&A without requiring a highlighted passage.
    if (routed.kind === 'intent' && LOCAL_INTENTS.includes(routed.intent)) {
      this.#add({ role: 'user', text, run: null });
      return this.#runLocal(routed.intent);
    }
    if (routed.kind === 'intent' && routed.via === 'command') {
      return this.#prepare({ intent: routed.intent, trigger: 'command', utterance: text });
    }
    // An explicit reference to "this clause" or "this passage" stays confined
    // to the current selection, even when a testing or user prefix precedes
    // "explain". Such prefixed requests were previously routed as ambiguous.
    // General matter questions still use automatic retrieval.
    const asksAboutSelectedText =
      this.#selection.references.length > 0 &&
      /\b(?:explain|summari[sz]e)\b/i.test(text) &&
      /\b(?:this|the selected)\s+(?:clause|passage|paragraph|text)\b/i.test(text);
    if (
      asksAboutSelectedText ||
      (routed.kind === 'intent' &&
        (routed.intent === 'explain' || routed.intent === 'summarise') &&
        this.#selection.references.length > 0)
    ) {
      return this.#prepare({
        intent: routed.kind === 'intent' ? routed.intent : null,
        trigger: 'free_text',
        utterance: text,
      });
    }
    return this.#prepare({ intent: 'ask_matter', trigger: 'free_text', utterance: text });
  }

  /** An interface action: Explain selection, Ask Aegis about a result, briefing, prepare review. */
  async action(
    intent: AssistantIntent,
    options: { references?: readonly SourceReferenceV1[]; utterance?: string } = {},
  ): Promise<void> {
    if (this.#busy()) {
      this.#publish({ notice: 'A run is in progress. Stop it first, or wait for it to finish.' });
      return;
    }
    return this.#prepare({
      intent,
      trigger: 'ui_action',
      utterance: options.utterance ?? '',
      ...(options.references !== undefined && { references: options.references }),
    });
  }

  /** Read through methods so a check after an await is not narrowed away. */
  #gone(): boolean {
    return this.#disposed;
  }
  #ended(active: ActiveRun): boolean {
    return active.terminal;
  }

  #busy(): boolean {
    return this.#state.phase === 'running' || this.#state.phase === 'stopping';
  }

  // ---- Local handlers: no model, no disclosure -------------------------------------------------------

  async #runLocal(intent: AssistantIntent): Promise<void> {
    const review = this.#ports.review.getSnapshot();
    const matterId = review.matterId;
    if (matterId === null && intent !== 'status') {
      this.#note(NOTICES.noMatter);
      return;
    }
    const epoch = this.#epoch;
    const base = (): RunView => ({
      id: this.#ports.newId(),
      runId: null,
      origin: 'local',
      intent,
      modelExecution: 'none',
      state: 'completed',
      outcome: 'completed',
      plan: null,
      tools: [],
      toolsStarted: [],
      blocks: [],
      summary: null,
      catalog: [],
      failure: null,
      complete: true,
      incomplete: null,
      stale: false,
      agentConfig: null,
      matterId: matterId ?? '',
      documentVersionId: null,
      snapshot: { digest: '', revision: review.inputRevision },
      vaultGeneration: this.#ports.vault.getSnapshot().generation,
      localStatus: null,
      startedAt: this.#ports.now().toISOString(),
      proposals: {},
      save: { state: 'unsaved', message: null },
    });

    if (intent === 'status') {
      const contextPorts: ContextPorts = { ...this.#ports, newId: this.#ports.newId };
      this.#add({
        role: 'assistant',
        text: 'Status',
        run: {
          ...base(),
          localStatus: {
            client: observeClient(contextPorts),
            assistant: this.#state.availability?.state ?? 'unknown',
          },
        },
      });
      this.#publish({ notice: 'Status read locally. Nothing was sent.' });
      return;
    }

    // The deterministic Chapter 8 checks, on this device. A SIMULATED what-if is never part of them.
    this.#publish({ notice: 'Running the check on this device. Nothing is sent.' });
    await this.#ports.review.runChecks();
    if (epoch !== this.#epoch || this.#disposed) return;
    const checks = this.#ports.review.getSnapshot().checks;
    if (checks.status !== 'fresh') {
      this.#note('The check did not finish. Try again.');
      return;
    }
    const tools: ToolResult[] = [];
    const blocks: AnswerBlock[] = [];
    const result = (
      toolName: ToolResult['toolName'],
      output: NonNullable<ToolResult['output']>,
    ) => {
      const parsed = toolResultSchema.safeParse({
        schema: 'lexaegis.tool-result.v1',
        handle: `T${tools.length + 1}`,
        toolCallId: this.#ports.newId(),
        toolName,
        toolVersion: TOOL_VERSION,
        outcome: 'succeeded',
        code: 'OK',
        output,
      });
      if (parsed.success) tools.push(parsed.data);
      return parsed.success ? parsed.data.handle : null;
    };
    if (intent === 'check_payments') {
      for (const payment of checks.payments.filter((p) => p.mode === 'review').slice(0, 4)) {
        const handle = result('check_payments', { tool: 'check_payments', result: payment });
        if (handle !== null) blocks.push({ kind: 'calculation', tool: handle, comment: '' });
      }
    } else if (checks.checklist !== null) {
      const selected = review.documents.filter((d) => d.selected).map((d) => d.documentVersionId);
      const handle = result('check_evidence', {
        tool: 'check_evidence',
        searchedScope: 'reviewer_links_for_selected_documents',
        searchedDocumentVersionIds: selected.slice(0, 8),
        assessed: selected.length > 0,
        items: checks.checklist.items.map((item) => ({
          ruleId: item.ruleId,
          requirement: item.requirement,
          state: item.state,
          linkedArtifacts: item.artifactIds.length,
        })),
      });
      const open = checks.checklist.items.filter(
        (item) => item.state !== 'confirmed_for_check' && item.state !== 'not_applicable',
      );
      if (handle !== null) {
        blocks.push({
          kind: 'finding',
          text:
            open.length === 0
              ? 'Every checklist requirement has evidence linked by you or is marked not applicable.'
              : `Not yet linked or confirmed by you: ${open
                  .map((item) => `${item.requirement} (${item.state.replaceAll('_', ' ')})`)
                  .join('; ')}.`.slice(0, 2000),
          basis: 'supported',
          sources: [],
          rules: open.map((item) => item.ruleId).slice(0, 8),
          tools: [handle],
        });
      }
    }
    this.#add({
      role: 'assistant',
      text: intent === 'check_payments' ? 'Payment check' : 'Evidence check',
      run: {
        ...base(),
        tools,
        blocks,
        snapshot: {
          digest: checks.snapshotDigest ?? '',
          revision: this.#ports.review.getSnapshot().inputRevision,
        },
      },
    });
    this.#publish({ notice: 'Checked on this device. Nothing was sent.' });
  }

  // ---- Disclosure -----------------------------------------------------------------------------------

  async #prepare(input: SubmitInput): Promise<void> {
    const availability = this.#state.availability;
    if (this.#state.availabilityStatus === 'signed_out') {
      this.#note(NOTICES.signedOut);
      return;
    }
    if (availability === null || availability.state === 'not_configured') {
      this.#note(NOTICES.notConfigured);
      return;
    }
    if (availability.state === 'configured_unverified') {
      this.#note(NOTICES.notVerified);
      return;
    }
    const references = input.references ?? this.#selection.references;
    const needsSelection = input.intent === 'summarise' || input.intent === 'explain';
    if (needsSelection && references.length === 0) {
      this.#note(NOTICES.needSelection);
      return;
    }
    // A follow-up that code cannot classify refers to the current selection only. Without one it
    // is asked back once: an earlier passage, version or matter is never assumed.
    if (input.intent === null && references.length === 0) {
      this.#note(NOTICES.whichPassage);
      return;
    }

    const epoch = ++this.#epoch;
    this.#lastInput = { ...input, references };
    const documentVersionId =
      input.intent === 'ask_matter'
        ? null
        : (references[0]?.documentVersionId ?? this.#selection.documentVersionId);
    const built = await buildRequestBody(
      { ...this.#ports, newId: this.#ports.newId },
      {
        intent: input.intent,
        trigger: input.trigger,
        utterance: input.utterance,
        documentVersionId,
        references,
        savedEntryIds: input.savedEntryIds ?? [],
        history: this.#state.includeHistory ? this.#history() : [],
      },
    );
    if (epoch !== this.#epoch || this.#disposed) return;
    if (!built.ok) {
      this.#note(describeCode(built.code));
      return;
    }
    const prepared = await prepareDisclosure(built.body, availability);
    if (epoch !== this.#epoch || this.#gone()) return;
    if (!prepared.ok) {
      this.#note(describeCode(prepared.code));
      return;
    }
    this.#binding = this.#currentBinding();
    // The preview is bound to the selection that existed when it was built, whether or not the request
    // named its passages explicitly: any later change to the selection discards it.
    this.#previewSelectionKey = selectionKey(
      this.#selection.documentVersionId,
      this.#selection.references,
    );
    this.#publish({
      phase: 'preview',
      pending: prepared.pending,
      notice: 'Review what will be sent, then choose Send. Nothing has been sent.',
    });
  }

  /** Rebuilds the pending disclosure with or without earlier messages. A new preview, not a send. */
  async setIncludeHistory(include: boolean): Promise<void> {
    if (this.#state.includeHistory === include) return;
    this.#publish({ includeHistory: include });
    if (this.#state.phase === 'preview' && this.#lastInput !== null)
      await this.#prepare(this.#lastInput);
  }

  /** Cancels the preview. Nothing was sent, and nothing is. */
  cancelPreview(): void {
    if (this.#state.phase !== 'preview') return;
    this.#epoch += 1;
    this.#publish({ phase: 'idle', pending: null, notice: 'Cancelled. Nothing was sent.' });
  }

  /** The explicit Send. The only place a consent is created, for exactly what the preview showed. */
  async send(): Promise<void> {
    const pending = this.#state.pending;
    if (pending === null || this.#state.phase !== 'preview') return;
    this.#binding = this.#currentBinding();
    const consented = consentToDisclosure(pending, this.#binding, this.#ports.now());
    if (!consented.ok) {
      this.#publish({ phase: 'idle', pending: null });
      this.#note(describeCode(consented.code));
      return;
    }
    const request = consented.request;
    const view: RunView = {
      id: this.#ports.newId(),
      runId: null,
      origin: 'assistant',
      intent: request.intent,
      modelExecution: 'pending',
      state: 'queued',
      outcome: null,
      plan: null,
      tools: [],
      toolsStarted: [],
      blocks: [],
      summary: null,
      catalog: request.context.sources,
      failure: null,
      complete: false,
      incomplete: null,
      stale: false,
      agentConfig: null,
      matterId: request.matterId,
      documentVersionId: request.documentVersionId,
      snapshot: request.snapshot,
      vaultGeneration: request.vaultGeneration,
      localStatus: null,
      startedAt: this.#ports.now().toISOString(),
      proposals: {},
      save: { state: 'unsaved', message: null },
    };
    const active: ActiveRun = {
      viewId: view.id,
      request,
      abort: new AbortController(),
      runId: null,
      lastSeq: 0,
      terminal: false,
      stopRequested: false,
    };
    this.#active = active;
    const shown =
      request.utterance.trim() === '' ? `(${request.intent ?? 'request'})` : request.utterance;
    this.#publish({
      phase: 'running',
      orb: 'queued',
      pending: null,
      activeRunViewId: view.id,
      conversation: [
        ...this.#state.conversation,
        { id: this.#ports.newId(), role: 'user', text: shown, run: null },
        { id: this.#ports.newId(), role: 'assistant', text: '', run: view },
      ],
      notice: 'Sent. Waiting for the assistant.',
    });

    const started = await this.#ports.transport.start(request, active.abort.signal);
    if (this.#active !== active) return;
    if (started.kind === 'error') {
      this.#end(active, {
        state: 'failed',
        outcome: 'failed',
        failure: { code: 'TRANSPORT', message: started.message },
        notice: started.message,
      });
      return;
    }
    if (started.kind === 'repeated') {
      // The server had already admitted this request ID: nothing ran again and nothing is replayed.
      this.#end(active, {
        state: started.metadata.state,
        outcome: started.metadata.outcome,
        incomplete: 'stream_lost',
        notice: 'This request was already sent. Its result is not replayed. Start a new request.',
      });
      return;
    }
    try {
      for await (const item of started.events) {
        if (this.#active !== active || active.terminal) break;
        if (item.kind === 'overflow') {
          await this.#invalidate(active, 'malformed_event');
          break;
        }
        await this.#onEvent(active, item.data);
      }
    } catch {
      // Network failure mid-stream: handled below as a lost stream.
    }
    if (this.#active === active && !active.terminal) await this.#invalidate(active, 'stream_lost');
  }

  // ---- Events ---------------------------------------------------------------------------------------

  async #onEvent(active: ActiveRun, data: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return this.#invalidate(active, 'malformed_event');
    }
    const parsed = assistantEventSchema.safeParse(json);
    if (!parsed.success) return this.#invalidate(active, 'malformed_event');
    const event = parsed.data;
    const { request } = active;
    // Events for another run, matter, version, snapshot or vault generation are dropped.
    if (
      (active.runId !== null && event.runId !== active.runId) ||
      event.matterId !== request.matterId ||
      event.documentVersionId !== request.documentVersionId ||
      event.snapshotDigest !== request.snapshot.digest ||
      event.vaultGeneration !== request.vaultGeneration
    )
      return;
    if (event.seq <= active.lastSeq) return; // a duplicate
    if (event.seq !== active.lastSeq + 1) return this.#invalidate(active, 'stream_gap');
    active.lastSeq = event.seq;
    if (active.runId === null) {
      active.runId = event.runId;
      this.#patchRun(active.viewId, { runId: event.runId });
      // Stop was pressed before the run ID was known: carry it out now.
      if (active.stopRequested) void this.#ports.transport.cancel(event.runId);
    }
    this.#apply(active, event);
  }

  #apply(active: ActiveRun, event: AssistantEvent): void {
    const view = this.#run(active.viewId);
    if (view === null) return;
    switch (event.type) {
      case 'state_changed': {
        const state = event.payload.state;
        this.#patchRun(active.viewId, { state });
        if (!isTerminalRunState(state)) {
          this.#publish({
            orb: state,
            phase: state === 'stopping' ? 'stopping' : this.#state.phase,
            notice:
              state === 'stopping'
                ? NOTICES.stopping
                : state === 'running'
                  ? 'Working.'
                  : this.#state.notice,
          });
        }
        return;
      }
      case 'plan_updated':
        this.#patchRun(active.viewId, { plan: event.payload.plan });
        return;
      case 'tool_started':
        this.#patchRun(active.viewId, {
          toolsStarted: [...view.toolsStarted, event.payload.toolName],
        });
        this.#publish({ notice: `Running ${event.payload.toolName.replaceAll('_', ' ')}.` });
        return;
      case 'tool_result':
        this.#patchRun(active.viewId, { tools: [...view.tools, event.payload.result] });
        return;
      case 'response_delta':
        // Blocks arrive validated and in order; anything else is a broken stream.
        if (event.payload.index !== view.blocks.length) {
          void this.#invalidate(active, 'stream_gap');
          return;
        }
        this.#patchRun(active.viewId, { blocks: [...view.blocks, event.payload.block] });
        return;
      case 'response_completed':
        this.#patchRun(active.viewId, {
          summary: event.payload.summary,
          modelExecution: event.payload.summary.modelExecution,
          intent: event.payload.summary.intent,
        });
        return;
      case 'output_reference':
        return;
      case 'run_completed': {
        const summary = view.summary;
        // A completed run must have delivered exactly the blocks it announced.
        if (summary === null || summary.blockCount !== view.blocks.length) {
          void this.#invalidate(active, 'stream_gap');
          return;
        }
        this.#end(active, {
          state: event.payload.metadata.state,
          outcome: event.payload.outcome,
          agentConfig: event.payload.agentConfig,
          modelExecution: event.payload.agentConfig.modelExecution,
          complete: true,
          notice:
            event.payload.outcome === 'needs_input'
              ? 'Aegis needs your input. Nothing was confirmed or approved.'
              : 'Run finished. Nothing was confirmed, saved or approved.',
        });
        return;
      }
      case 'run_cancelled':
        this.#end(active, {
          state: 'cancelled',
          outcome: 'cancelled',
          incomplete: 'stopped',
          notice: 'Stopped. Text already sent cannot be retracted.',
        });
        return;
      case 'run_failed':
        this.#end(active, {
          state: 'failed',
          outcome: 'failed',
          failure: { code: event.payload.failure, message: event.payload.error.message },
          notice: event.payload.error.message,
        });
        return;
      case 'run_interrupted':
        this.#end(active, {
          state: 'interrupted',
          outcome: 'interrupted',
          incomplete: 'stream_lost',
          notice: 'The run was interrupted and its outcome is unknown. Start a new request.',
        });
        return;
    }
  }

  #end(
    active: ActiveRun,
    result: Partial<RunView> & { state: AssistantRunState; notice: string },
  ): void {
    if (active.terminal) return;
    active.terminal = true;
    const { notice, ...patch } = result;
    // If the inputs changed while it ran, the result is already out of date.
    const stale =
      this.#ports.review.getSnapshot().inputRevision !== active.request.snapshot.revision;
    this.#patchRun(active.viewId, { ...patch, stale });
    if (this.#active === active) this.#active = null;
    this.#publish({ phase: 'idle', orb: result.state, activeRunViewId: null, notice });
  }

  /**
   * The stream cannot be trusted as complete. Whatever arrived stays visible as incomplete, the
   * run is cancelled, and only its operational status is read back. No result is reconstructed.
   */
  async #invalidate(
    active: ActiveRun,
    reason: 'stream_gap' | 'stream_lost' | 'malformed_event',
  ): Promise<void> {
    if (active.terminal) return;
    active.terminal = true;
    active.abort.abort();
    if (this.#active === active) this.#active = null;
    this.#patchRun(active.viewId, { complete: false, incomplete: reason, state: 'stopping' });
    this.#publish({
      phase: 'stopping',
      orb: 'stopping',
      notice: 'The connection to the run was lost. Checking its status.',
    });
    let state: AssistantRunState = 'interrupted';
    if (active.runId !== null) {
      await this.#ports.transport.cancel(active.runId);
      const status = await this.#ports.transport.status(active.runId);
      // Only a terminal state the server reports is shown; anything else is unknown.
      if (status.ok && isTerminalRunState(status.metadata.state)) state = status.metadata.state;
    }
    if (this.#disposed) return;
    this.#patchRun(active.viewId, {
      state: state === 'completed' || state === 'awaiting_input' ? 'interrupted' : state,
      outcome: state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'failed' : 'interrupted',
    });
    this.#publish({
      phase: 'idle',
      orb: state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'failed' : 'interrupted',
      activeRunViewId: null,
      notice:
        'The run stream was incomplete, so nothing from it is treated as a finished result. Start a new request.',
    });
  }

  // ---- Stop -----------------------------------------------------------------------------------------

  /**
   * Stop, by button or /stop. Handled by code at once, including while the provider is being
   * waited on. Repeating it is harmless. It cannot retract text already sent.
   */
  async stop(reason: 'user' | 'stale' = 'user'): Promise<void> {
    if (this.#state.phase === 'preview') {
      this.cancelPreview();
      return;
    }
    const active = this.#active;
    if (active === null || active.terminal) return;
    const first = !active.stopRequested;
    active.stopRequested = true;
    this.#patchRun(active.viewId, { state: 'stopping' });
    this.#publish({
      phase: 'stopping',
      orb: 'stopping',
      notice: reason === 'stale' ? NOTICES.stale : NOTICES.stopping,
    });
    if (!first || active.runId === null) return;
    const cancelled = await this.#ports.transport.cancel(active.runId);
    if (this.#active !== active || this.#ended(active)) return;
    if (!cancelled.ok) {
      // The stop could not be delivered. The stream decides; if it ends without a terminal event
      // the run is shown as interrupted, never as cancelled.
      this.#publish({ notice: 'Stop could not be confirmed yet. Waiting for the run to report.' });
    }
  }

  /** Lock, matter or account change: drop the run locally and tell the server to stop it. */
  #abandonActive(): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    active.terminal = true;
    active.abort.abort();
    if (active.runId !== null)
      void this.#ports.transport.cancel(active.runId).catch(() => undefined);
  }

  // ---- Sources --------------------------------------------------------------------------------------

  /**
   * Resolves a cited handle to its exact passage, re-checked against the current verified
   * artifacts. Null when the source changed, was unselected or no longer matches.
   */
  openSource(
    viewId: string,
    handle: string,
  ): { documentVersionId: string; page: number; start: number; end: number } | null {
    const entry = this.#run(viewId)?.catalog.find((candidate) => candidate.handle === handle);
    if (entry === undefined) return null;
    const resolved = this.#ports.review.resolve(entry.reference);
    if (resolved.state !== 'resolved' || resolved.page === undefined) {
      this.#publish({
        notice: 'This source no longer matches the stored document, so it was not opened.',
      });
      return null;
    }
    return {
      documentVersionId: entry.reference.documentVersionId,
      page: entry.reference.page,
      start: entry.reference.start,
      end: entry.reference.end,
    };
  }

  /** Whether every cited source of a result still resolves against the current artifacts. */
  sourcesCurrent(viewId: string): boolean {
    const view = this.#run(viewId);
    return (
      view !== null &&
      view.catalog.every(
        (entry) => this.#ports.review.resolve(entry.reference).state === 'resolved',
      )
    );
  }

  // ---- Fact proposals ------------------------------------------------------------------------------

  /**
   * The reviewer's explicit Confirm on a proposal card, optionally with an edited value. This is
   * the only path from a proposal to a confirmed fact: no model output, imported file or typed
   * "yes" reaches it. The cited sources are re-checked first, and the confirmation is recorded by
   * Chapter 8's controller with the reviewer's account and the time. A value for a field that is
   * already confirmed is a correction: a new revision that makes dependent results out of date.
   */
  async confirmProposal(
    viewId: string,
    proposalId: string,
    editedValue?: string,
  ): Promise<boolean> {
    const run = this.#run(viewId);
    const proposal = run?.summary?.factProposals.find((item) => item.proposalId === proposalId);
    if (run == null || proposal === undefined || run.proposals[proposalId] !== undefined)
      return false;
    const references = proposal.sources.map(
      (handle) => run.catalog.find((entry) => entry.handle === handle)?.reference,
    );
    if (
      references.some(
        (reference) =>
          reference === undefined || this.#ports.review.resolve(reference).state !== 'resolved',
      )
    ) {
      this.#publish({
        notice: 'The cited source no longer matches the stored document. Nothing was confirmed.',
      });
      return false;
    }
    const value = editedValue === undefined ? proposal.value : editedValue.trim();
    const existing = this.#ports.review
      .getSnapshot()
      .facts.find(
        (fact) =>
          fact.field === proposal.field &&
          fact.group === proposal.group &&
          fact.slot === proposal.slot,
      );
    const result = await this.#ports.review.confirmFact({
      candidate: {
        schema: 'lexaegis.fact-candidate.v1',
        factId: this.#ports.newId(),
        matterId: run.matterId,
        field: proposal.field,
        group: proposal.group,
        slot: proposal.slot,
        value,
        // An edited value is the reviewer's own; an unedited one keeps its model provenance.
        provenance: editedValue === undefined ? 'model' : 'reviewer_selection',
        references,
      },
      basis: 'source',
      statementReason: null,
      ...(existing !== undefined && { replaces: existing.factId }),
    });
    if (this.#gone() || this.#run(viewId) === null) return false;
    if (!result.ok) {
      this.#publish({
        notice:
          result.code === 'ACCOUNT_LOCKED'
            ? 'Unlock your account to confirm a fact. Nothing was confirmed.'
            : result.code === 'CANDIDATE_INVALID' || result.code === 'FACT_INVALID'
              ? 'That value does not fit this field. Nothing was confirmed.'
              : 'The fact was not confirmed.',
      });
      return false;
    }
    // The confirmation changed the review inputs, so earlier results are now marked out of date.
    const current = this.#run(viewId);
    this.#patchRun(viewId, { proposals: { ...current?.proposals, [proposalId]: 'confirmed' } });
    this.#publish({
      notice: 'Fact confirmed by you. Save facts to keep it. Earlier results are now out of date.',
    });
    return true;
  }

  dismissProposal(viewId: string, proposalId: string): void {
    const run = this.#run(viewId);
    if (run === null || run.proposals[proposalId] !== undefined) return;
    this.#patchRun(viewId, { proposals: { ...run.proposals, [proposalId]: 'dismissed' } });
  }

  // ---- Save outcome ---------------------------------------------------------------------------------

  /**
   * The explicit Save outcome action. The analysis and the agent configuration are stored as
   * immutable encrypted artifacts and read back (decrypted and hash-checked) before an
   * observation entry is committed to the encrypted catalog. Only then is the result shown as
   * saved. A failure leaves the result on screen, clearly unsaved. Nothing here freezes a
   * package, creates an opening nonce, records a decision or sends a transaction.
   */
  async saveOutcome(viewId: string): Promise<boolean> {
    const run = this.#run(viewId);
    if (run === null || run.save.state === 'saving' || run.save.state === 'saved') return false;
    const refuse = (message: string): boolean => {
      this.#patchRun(viewId, { save: { state: 'failed', message } });
      this.#publish({ notice: message });
      return false;
    };
    if (!run.complete || run.localStatus !== null || run.blocks.length === 0)
      return refuse('Only a finished result can be saved.');
    if (run.stale) return refuse('This result is out of date. Run it again before saving.');
    if (!this.sourcesCurrent(viewId))
      return refuse('A cited source no longer matches the stored document. Not saved.');

    const epoch = this.#epoch;
    const live = () => epoch === this.#epoch && !this.#gone() && this.#run(viewId) !== null;
    this.#patchRun(viewId, { save: { state: 'saving', message: null } });
    this.#publish({ notice: 'Saving encrypted files.' });
    if (run.origin === 'assistant') {
      const digest = await this.#ports.review.currentInputDigest();
      if (!live()) return false;
      if (digest !== run.snapshot.digest)
        return refuse('The review inputs changed. Run it again before saving.');
    }

    const { commands } = this.#ports.vault;
    const failed = (reason: string): boolean =>
      live()
        ? refuse(
            `Not saved (${reason.toLowerCase().replaceAll('_', ' ')}). The result is still here, unsaved.`,
          )
        : false;
    const assigned = this.#assigned.get(viewId) ?? {};
    this.#assigned.set(viewId, assigned);
    /**
     * Stores one artifact under a version ID fixed for this result, then reads it back through
     * the vault (fetch, decrypt, hash-check). If an earlier attempt already recorded it, the
     * vault's own unfinished save is completed instead of storing it a second time.
     */
    const store = async (
      kind: 'analysis' | 'config',
      label: string,
      artifact: ArtifactBytes,
    ): Promise<string | null> => {
      const versionId = (assigned[kind] ??= this.#ports.newId());
      const recorded =
        this.#ports.vault
          .getSnapshot()
          .selectedMatter?.sources.some((source) => source.documentVersionId === versionId) ===
        true;
      const written = recorded
        ? await commands.reconcile()
        : await commands.addSourceFile(run.matterId, {
            bytes: artifact.bytes,
            mediaType: 'application/json',
            label,
            documentVersionId: versionId,
          });
      if (!written.ok) {
        failed(written.failure);
        return null;
      }
      const back = await commands.readSource(run.matterId, versionId);
      if (!back.ok) {
        failed(back.failure);
        return null;
      }
      const same = (await sha256Bytes(back.data)) === artifact.sha256;
      back.data.fill(0);
      if (!same) failed('INTEGRITY_FAILURE');
      return same ? versionId : null;
    };

    const modelExecution = run.modelExecution === 'pending' ? 'none' : run.modelExecution;
    const finishedAt = this.#ports.now().toISOString();
    const config =
      run.agentConfig ??
      // A device-local check: no model, no provider, no usage. Nothing is invented for it.
      localAgentConfig({
        viewId: run.id,
        intent: run.intent,
        startedAt: run.startedAt,
        finishedAt: run.startedAt,
        toolExecutions: run.tools.length,
      });
    const runKey = run.runId ?? run.id;
    let analysisVersionId: string;
    {
      const artifact = await analysisArtifactBytes({
        matterId: run.matterId,
        documentVersionId: run.documentVersionId,
        snapshotDigest: run.snapshot.digest,
        run: {
          runId: run.runId,
          intent: run.intent,
          outcome: run.outcome,
          startedAt: run.startedAt,
          modelExecution,
        },
        blocks: run.blocks,
        summary: run.summary,
        catalog: run.catalog,
        tools: run.tools,
      });
      const id = await store('analysis', `${ANALYSIS_LABEL}${runKey}`, artifact);
      if (id === null || !live()) return false;
      analysisVersionId = id;
    }
    const agentConfigVersionId = await store(
      'config',
      `${AGENT_CONFIG_LABEL}${runKey}`,
      await agentConfigArtifactBytes(config),
    );
    if (agentConfigVersionId === null || !live()) return false;

    const text = encodeOutcome({
      v: 1,
      runId: runKey,
      intent: run.intent,
      outcome: run.outcome,
      modelExecution,
      analysisVersionId,
      agentConfigVersionId,
      inputSnapshotDigest: run.snapshot.digest,
      summary: summariseRun(run),
      savedAt: finishedAt,
    });
    // An observation, never a confirmed fact: it is recorded as model-proposed and unconfirmed.
    const added = commands.addEntry(run.matterId, {
      kind: 'outcome',
      text,
      confirmed: false,
      origin: 'model_proposed',
      documentVersionId: run.documentVersionId ?? analysisVersionId,
    });
    if (!added.ok) return failed(added.failure);
    const committed = await commands.saveMatter(run.matterId);
    if (!live()) return false;
    if (!committed.ok) return failed(committed.failure);
    const matter = this.#ports.vault.getSnapshot().selectedMatter;
    if (matter?.context.entries.some((entry) => entry.text === text) !== true)
      return failed('NOT_FOUND');
    this.#patchRun(viewId, { save: { state: 'saved', message: null } });
    this.#publish({
      notice: 'Saved and checked. It is kept as an observation, not a confirmed fact.',
    });
    return true;
  }
}

export const TERMINAL_EVENTS = TERMINAL_EVENT_TYPES;
