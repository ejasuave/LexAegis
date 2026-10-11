import { PORTABLE_LIMITS } from '@lexaegis/protocol/portable';
import { parseReceiptReference, type ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import {
  expectedReviewersPolicy,
  verifyOffline,
  type RegistryPolicy,
  type SignerAcceptancePolicy,
  type VerificationReportV1,
} from '@lexaegis/sdk';
import {
  parseRpcEndpoint,
  verifyReceipt,
  type FetchLike,
  type RpcConfigError,
} from '@lexaegis/sdk/verify';
import { startLocalJob, type LocalJobHandle, type WorkerFactory } from './local-job';
import type { JobFailureCode, JobProgress, LocalResult } from './verification-job';

/*
 * The verifier's one state machine. Imported bytes live only inside the worker job and are gone
 * once it finishes; this object keeps the File handle (not its contents) so a check can be
 * repeated, plus the small in-memory results. Nothing is written to any storage.
 */

export type Phase = 'idle' | 'reading' | 'checking' | 'ready' | 'failed';
export type InputKind = 'none' | 'reference' | 'file' | 'opening';
export type LivePhase = 'idle' | 'running' | 'done' | 'failed';

export interface VerifierSnapshot {
  readonly phase: Phase;
  readonly inputKind: InputKind;
  readonly fileName: string | null;
  readonly fileSize: number | null;
  readonly progress: JobProgress | null;
  readonly failure: JobFailureCode | 'FILE_TOO_LARGE' | 'FILE_UNREADABLE' | null;
  /** The independent expected reference text the user typed or pasted. */
  readonly referenceText: string;
  readonly referenceInvalid: boolean;
  readonly signerText: string;
  readonly signerInvalid: boolean;
  readonly rpcUrl: string;
  readonly rpcError: RpcConfigError | 'ORIGIN_NOT_ALLOWED' | null;
  readonly rpcOrigin: string | null;
  readonly policy: RegistryPolicy | null;
  readonly local: LocalResult | null;
  readonly livePhase: LivePhase;
  /** The report currently shown: local-only until a registry check completes. */
  readonly report: VerificationReportV1 | null;
  /** The last registry observation that produced a status, kept "as of" when a refresh fails. */
  readonly lastObserved: VerificationReportV1 | null;
  /** True after a refresh failed and `report` no longer carries the last good status. */
  readonly refreshFailed: boolean;
}

export interface ControllerDeps {
  readonly createWorker: WorkerFactory;
  readonly policy: RegistryPolicy | null;
  readonly rpcUrl: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly allowLoopbackHttp?: boolean;
  readonly deadlineMs?: number;
  /** Origins this build allows for registry reads (it also fixes the page's CSP). Null: unrestricted (tests). */
  readonly allowedRpcOrigins?: readonly string[] | null;
}

const INITIAL = (deps: ControllerDeps): VerifierSnapshot => {
  const endpoint = parseRpcEndpoint(deps.rpcUrl, {
    allowLoopbackHttp: deps.allowLoopbackHttp === true,
  });
  const allowed = deps.allowedRpcOrigins ?? null;
  const notAllowed = endpoint.ok && allowed !== null && !allowed.includes(endpoint.origin);
  return {
    phase: 'idle',
    inputKind: 'none',
    fileName: null,
    fileSize: null,
    progress: null,
    failure: null,
    referenceText: '',
    referenceInvalid: false,
    signerText: '',
    signerInvalid: false,
    rpcUrl: deps.rpcUrl,
    rpcError: endpoint.ok ? (notAllowed ? 'ORIGIN_NOT_ALLOWED' : null) : endpoint.error,
    rpcOrigin: endpoint.ok ? endpoint.origin : null,
    policy: deps.policy,
    local: null,
    livePhase: 'idle',
    report: null,
    lastObserved: null,
    refreshFailed: false,
  };
};

function parseReferenceText(text: string): ReceiptReferenceV1 | null | 'invalid' {
  if (text.trim() === '') return null;
  if (text.length > 4096) return 'invalid';
  try {
    const parsed = parseReceiptReference(JSON.parse(text) as unknown);
    return parsed.ok ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

function parseSigners(text: string): SignerAcceptancePolicy | null | 'invalid' {
  const items = text
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  if (items.length === 0) return null;
  if (items.length > 256) return 'invalid';
  try {
    return expectedReviewersPolicy('recipient.expected-reviewers', items);
  } catch {
    return 'invalid';
  }
}

export class VerifierController {
  readonly #deps: ControllerDeps;
  readonly #listeners = new Set<() => void>();
  #snapshot: VerifierSnapshot;
  #generation = 0;
  #file: { file: File; kind: 'file' | 'opening' } | null = null;
  #job: LocalJobHandle | null = null;
  #abort: AbortController | null = null;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#snapshot = INITIAL(deps);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): VerifierSnapshot => this.#snapshot;

  #set(patch: Partial<VerifierSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Terminates the local job and any registry check, and invalidates their late results. */
  #stopWork(): void {
    this.#generation += 1;
    this.#job?.cancel();
    this.#job = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  /** Recomputes the local report with the current signer rule. Never touches the network. */
  async #localReport(generation: number): Promise<void> {
    const local = this.#snapshot.local;
    const snapshot = this.#snapshot;
    let offline: unknown = local?.offline;
    if (local === null) {
      const reference = parseReferenceText(snapshot.referenceText);
      if (reference === null || reference === 'invalid') {
        this.#set({ report: null });
        return;
      }
      const computed = await verifyOffline({
        mode: 'reference-only',
        expectedReference: reference,
        referenceOrigin: 'independent',
      });
      if (!computed.ok) {
        this.#set({ report: null });
        return;
      }
      offline = computed.data;
    }
    const signer = parseSigners(snapshot.signerText);
    const result = await verifyReceipt({
      mode: 'reference-only',
      expectedReference: null,
      referenceOrigin: 'independent',
      offline,
      ...(signer !== null && signer !== 'invalid' && { signerPolicy: signer }),
      now: this.#deps.now ?? (() => new Date()),
      generation,
    });
    if (generation !== this.#generation) return;
    this.#set({ report: result.ok ? result.data.report : null });
  }

  /** Public reference-only inspection: no files, no network. */
  async inspectReference(text: string): Promise<void> {
    this.#stopWork();
    const generation = this.#generation;
    this.#file = null;
    const parsed = parseReferenceText(text);
    this.#set({
      referenceText: text,
      referenceInvalid: parsed === 'invalid',
      inputKind: parsed === null || parsed === 'invalid' ? 'none' : 'reference',
      fileName: null,
      fileSize: null,
      local: null,
      livePhase: 'idle',
      lastObserved: null,
      refreshFailed: false,
      progress: null,
      failure: null,
      phase: parsed === null || parsed === 'invalid' ? 'idle' : 'ready',
      report: null,
    });
    await this.#localReport(generation);
  }

  /** Updates the independent expectation without discarding anything already shown. */
  setReferenceText(text: string): void {
    const parsed = parseReferenceText(text);
    this.#set({ referenceText: text, referenceInvalid: parsed === 'invalid' });
  }

  /** Chooses a file. Its bytes are read only after the size check, and only for the local job. */
  async chooseFile(file: File, kind: 'file' | 'opening' = 'file'): Promise<void> {
    this.#file = { file, kind };
    this.#set({ inputKind: kind, fileName: file.name, fileSize: file.size });
    await this.checkFiles();
  }

  /** Runs (or repeats) the local check on the chosen file with the current expected reference. */
  async checkFiles(): Promise<void> {
    const chosen = this.#file;
    if (chosen === null) return;
    this.#stopWork();
    const generation = this.#generation;
    const limit =
      chosen.kind === 'opening'
        ? PORTABLE_LIMITS.maxStructuredBytes
        : PORTABLE_LIMITS.maxEncodedBytes;
    this.#set({
      phase: 'reading',
      progress: null,
      failure: null,
      local: null,
      report: null,
      livePhase: 'idle',
      lastObserved: null,
      refreshFailed: false,
    });
    // Bound the size before reading anything into memory.
    if (chosen.file.size > limit) {
      this.#set({ phase: 'failed', failure: 'FILE_TOO_LARGE' });
      return;
    }
    const reference = parseReferenceText(this.#snapshot.referenceText);
    if (reference === 'invalid') {
      this.#set({ phase: 'failed', failure: 'REFERENCE_INVALID', referenceInvalid: true });
      return;
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await chosen.file.arrayBuffer();
    } catch {
      if (generation === this.#generation)
        this.#set({ phase: 'failed', failure: 'FILE_UNREADABLE' });
      return;
    }
    // New input, Clear or Cancel during the read: drop the bytes without starting work.
    if (generation !== this.#generation) return;
    this.#set({ phase: 'checking' });
    const job = startLocalJob(
      this.#deps.createWorker,
      generation,
      {
        kind: chosen.kind,
        bytes: buffer,
        expectedReference: reference ?? null,
        hasExpectedReference: reference !== null,
      },
      (progress) => {
        if (generation === this.#generation) this.#set({ progress });
      },
      this.#deps.deadlineMs,
    );
    this.#job = job;
    const outcome = await job.result;
    if (generation !== this.#generation) return;
    this.#job = null;
    if (!outcome.ok) {
      this.#set({ phase: 'failed', failure: outcome.code, progress: null });
      return;
    }
    this.#set({ phase: 'ready', local: outcome.result, progress: null });
    await this.#localReport(generation);
  }

  setSignerText(text: string): void {
    const parsed = parseSigners(text);
    // A policy change invalidates every result that depended on the old one.
    this.#abort?.abort();
    this.#abort = null;
    this.#generation += 1;
    this.#set({
      signerText: text,
      signerInvalid: parsed === 'invalid',
      livePhase: 'idle',
      lastObserved: null,
      refreshFailed: false,
    });
    void this.#localReport(this.#generation);
  }

  setRpcUrl(url: string): void {
    const parsed = parseRpcEndpoint(url, {
      allowLoopbackHttp: this.#deps.allowLoopbackHttp === true,
    });
    // The provider changed: any running check is cancelled and earlier observations are dropped.
    this.#abort?.abort();
    this.#abort = null;
    this.#generation += 1;
    const allowed = this.#deps.allowedRpcOrigins ?? null;
    const notAllowed = parsed.ok && allowed !== null && !allowed.includes(parsed.origin);
    this.#set({
      rpcUrl: url,
      rpcError: parsed.ok ? (notAllowed ? 'ORIGIN_NOT_ALLOWED' : null) : parsed.error,
      rpcOrigin: parsed.ok ? parsed.origin : null,
      livePhase: 'idle',
      lastObserved: null,
      refreshFailed: false,
    });
    void this.#localReport(this.#generation);
  }

  get canCheckRegistry(): boolean {
    const s = this.#snapshot;
    return (
      s.policy !== null &&
      s.rpcError === null &&
      s.rpcOrigin !== null &&
      !s.signerInvalid &&
      (s.local !== null || s.inputKind === 'reference') &&
      s.livePhase !== 'running'
    );
  }

  /** Explicit action: the only way a network request is ever made. */
  async checkRegistry(): Promise<void> {
    const before = this.#snapshot;
    if (!this.canCheckRegistry || before.policy === null) return;
    this.#abort?.abort();
    this.#generation += 1;
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ livePhase: 'running', refreshFailed: false });

    let offline: unknown = before.local?.offline;
    if (before.local === null) {
      const reference = parseReferenceText(before.referenceText);
      if (reference === null || reference === 'invalid') {
        this.#set({ livePhase: 'idle' });
        return;
      }
      const computed = await verifyOffline({
        mode: 'reference-only',
        expectedReference: reference,
        referenceOrigin: 'independent',
      });
      if (!computed.ok) {
        this.#set({ livePhase: 'idle' });
        return;
      }
      offline = computed.data;
    }
    const signer = parseSigners(before.signerText);
    const result = await verifyReceipt({
      mode: 'reference-only',
      expectedReference: null,
      referenceOrigin: 'independent',
      offline,
      live: {
        policy: before.policy,
        transport: {
          kind: 'rpc',
          url: before.rpcUrl,
          ...(this.#deps.fetch !== undefined && { fetch: this.#deps.fetch }),
          ...(this.#deps.allowLoopbackHttp === true && { allowLoopbackHttp: true }),
        },
        inspectSuccessors: true,
      },
      ...(signer !== null && signer !== 'invalid' && { signerPolicy: signer }),
      signal: abort.signal,
      generation,
      now: this.#deps.now ?? (() => new Date()),
    });
    // Stale: the input, a policy or the provider changed (or Clear/Cancel ran) in the meantime.
    if (generation !== this.#generation) return;
    this.#abort = null;
    if (!result.ok) {
      this.#set({ livePhase: 'failed' });
      return;
    }
    const report = result.data.report;
    const observed = report.checkpoint !== null && report.chainStatus !== 'unknown';
    const previous = this.#snapshot.lastObserved;
    if (observed) {
      this.#set({ livePhase: 'done', report, lastObserved: report, refreshFailed: false });
    } else {
      // Keep the last good status "as of" its own time; show this failure beside it.
      this.#set({ livePhase: 'failed', report, refreshFailed: previous !== null });
    }
  }

  /** Cancels a running local job or registry check. Local results already shown are kept. */
  cancel(): void {
    const running = this.#snapshot.phase === 'checking' || this.#snapshot.phase === 'reading';
    this.#stopWork();
    this.#set({
      phase: running ? 'failed' : this.#snapshot.phase,
      failure: running ? 'CANCELLED' : this.#snapshot.failure,
      progress: null,
      livePhase: this.#snapshot.livePhase === 'running' ? 'idle' : this.#snapshot.livePhase,
    });
  }

  /** Removes the input, the results and every private view. Best effort; no storage was used. */
  clear(): void {
    this.#stopWork();
    this.#file = null;
    this.#snapshot = INITIAL(this.#deps);
    for (const listener of this.#listeners) listener();
  }
}
