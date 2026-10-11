import { identityPayloadSchema, toView, type IdentityView } from './describe';

/*
 * One explicit identity inspection at a time, never a loop. A result belongs to the generation that
 * asked for it: lock, matter change, flag change or unmount invalidates, aborts the request and
 * discards a late answer, so no earlier "registered" can pass as current evidence.
 */

export type IdentityPhase = 'off' | 'idle' | 'checking' | 'done';

export interface IdentitySnapshot {
  readonly phase: IdentityPhase;
  readonly view: IdentityView | null;
  readonly generation: number;
}

export type IdentityFetch = (signal: AbortSignal) => Promise<unknown>;

export class AgentIdentityController {
  #generation = 0;
  #abort: AbortController | null = null;
  #listeners = new Set<() => void>();
  #snapshot: IdentitySnapshot;
  readonly #fetch: IdentityFetch;

  constructor(options: { readonly enabled: boolean; readonly fetch: IdentityFetch }) {
    this.#fetch = options.fetch;
    this.#snapshot = { phase: options.enabled ? 'idle' : 'off', view: null, generation: 0 };
  }

  getSnapshot = (): IdentitySnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(next: IdentitySnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  /** The only way a read starts: an explicit inspection or refresh. Does nothing when the feature is off. */
  async inspect(): Promise<void> {
    if (this.#snapshot.phase === 'off') return;
    this.#abort?.abort();
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ phase: 'checking', view: null, generation });
    let view: IdentityView;
    try {
      const parsed = identityPayloadSchema.safeParse(await this.#fetch(abort.signal));
      view = parsed.success ? toView(parsed.data) : { kind: 'unknown', reason: 'RESPONSE_INVALID' };
    } catch {
      view = { kind: 'unknown', reason: 'RPC_UNAVAILABLE' };
    }
    if (generation !== this.#generation) return; // stale: discarded
    this.#set({ phase: 'done', view, generation });
  }

  /** Lock, matter change, configuration change or unmount: cancel and forget. */
  invalidate(): void {
    if (this.#snapshot.phase === 'off') return;
    this.#abort?.abort();
    this.#abort = null;
    this.#generation += 1;
    this.#set({ phase: 'idle', view: null, generation: this.#generation });
  }
}

export const fetchIdentity: IdentityFetch = async (signal) => {
  const response = await fetch('/api/agent-identity', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('unavailable');
  return response.json();
};
