/*
 * Event identity for what the HUD accepts. The assistant controller already discards stale and
 * gapped streams; this gate gives the visual layer the same rules so a replayed, reordered or
 * obsolete event can never move the scene. It holds only identifiers, never content.
 */

export type EventVerdict = 'accepted' | 'duplicate' | 'out_of_order' | 'gap' | 'obsolete';

export interface RunEventIdentity {
  readonly runId: string;
  readonly matterId: string;
  readonly documentVersionId: string | null;
  /** Per-run sequence number, starting at 1. */
  readonly seq: number;
}

export interface RunContext {
  readonly runId: string;
  readonly matterId: string;
  readonly documentVersionId: string | null;
}

export class RunEventGate {
  #context: RunContext | null = null;
  #last = 0;

  /** Switching matter, version or run drops everything about the previous one. */
  setContext(context: RunContext | null): void {
    const same =
      this.#context !== null &&
      context !== null &&
      this.#context.runId === context.runId &&
      this.#context.matterId === context.matterId &&
      this.#context.documentVersionId === context.documentVersionId;
    if (same) return;
    this.#context = context;
    this.#last = 0;
  }

  accept(event: RunEventIdentity): EventVerdict {
    const c = this.#context;
    if (
      c === null ||
      c.runId !== event.runId ||
      c.matterId !== event.matterId ||
      c.documentVersionId !== event.documentVersionId
    ) {
      return 'obsolete';
    }
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) return 'out_of_order';
    if (event.seq === this.#last) return 'duplicate';
    if (event.seq < this.#last) return 'out_of_order';
    if (event.seq > this.#last + 1) return 'gap';
    this.#last = event.seq;
    return 'accepted';
  }
}

/** A bounded set of identities, so remembered events cannot grow without limit. */
export class BoundedIdentitySet {
  readonly #max: number;
  readonly #ids = new Set<string>();

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('max must be a positive integer');
    this.#max = max;
  }

  /** Returns false when the identity was already present. */
  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  get size(): number {
    return this.#ids.size;
  }
}
