import type {
  HistoryAction,
  HistoryHealth,
  HistoryPage,
  ReceiptHistory,
} from '@/domain/history/response';
import type { ApiResult, HistoryApi } from './api-client';

/*
 * Drives the review-history view. It is read-only: it cannot sign, submit, confirm or approve
 * anything, and nothing it learns changes a transaction operation. It holds only public chain
 * data. Private matter labels are never stored here: they are joined at render time from a
 * source that exists only while the vault is unlocked.
 */

export const PAGE_SIZE = 20;
/** Visible history refreshes at most this often, for this long, then waits for a manual refresh. */
export const POLL_INTERVAL_MS = 10_000;
export const POLL_WINDOW_MS = 120_000;

export type ListState =
  'idle' | 'loading' | 'loading_more' | 'ready' | 'unavailable' | 'reset_required' | 'failed';

export interface HistoryViewState {
  /** The reviewer address history is shown for; null when no account is selected. */
  readonly reviewer: string | null;
  readonly list: ListState;
  readonly health: HistoryHealth | null;
  readonly items: readonly HistoryAction[];
  readonly nextCursor: string | null;
  readonly anchorNonce: string | null;
  /** True only after a coherent read found nothing: shown as "No indexed history". */
  readonly empty: boolean;
  readonly selected: string | null;
  readonly detail: ReceiptHistory | null;
  readonly detailState: 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';
  readonly watching: boolean;
  /** Short plain-text status for screen readers. */
  readonly announcement: string;
}

const INITIAL: HistoryViewState = Object.freeze({
  reviewer: null,
  list: 'idle',
  health: null,
  items: [],
  nextCursor: null,
  anchorNonce: null,
  empty: false,
  selected: null,
  detail: null,
  detailState: 'idle',
  watching: false,
  announcement: '',
});

export interface Scheduler {
  readonly now: () => number;
  readonly every: (callback: () => void, ms: number) => () => void;
}

export const browserScheduler: Scheduler = {
  now: () => Date.now(),
  every: (callback, ms) => {
    const id = setInterval(callback, ms);
    return () => clearInterval(id);
  },
};

export class HistoryController {
  readonly #api: HistoryApi;
  readonly #scheduler: Scheduler;
  readonly #listeners = new Set<() => void>();
  #state: HistoryViewState = INITIAL;
  /** Bumped on every scope change; a response from an older scope is dropped. */
  #epoch = 0;
  #abort: AbortController | null = null;
  #stopTimer: (() => void) | null = null;
  #watchStarted = 0;
  #paused = false;

  constructor(api: HistoryApi, scheduler: Scheduler = browserScheduler) {
    this.#api = api;
    this.#scheduler = scheduler;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): HistoryViewState => this.#state;

  #set(patch: Partial<HistoryViewState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Selecting a different account (or none), or locking, discards everything and cancels requests. */
  setReviewer(reviewer: string | null): void {
    if (reviewer === this.#state.reviewer) return;
    this.#reset(reviewer);
    if (reviewer !== null) void this.refresh();
  }

  /** Called on vault lock, account switch or index generation change. Keeps the reviewer. */
  clear(): void {
    this.#reset(this.#state.reviewer);
  }

  #reset(reviewer: string | null): void {
    this.#epoch += 1;
    this.#abort?.abort();
    this.#abort = null;
    this.stopWatching();
    this.#state = { ...INITIAL, reviewer };
    for (const listener of this.#listeners) listener();
  }

  #begin(): { epoch: number; signal: AbortSignal } {
    this.#abort?.abort();
    this.#abort = new AbortController();
    return { epoch: this.#epoch, signal: this.#abort.signal };
  }

  /** Reloads the first page. A newer action never shifts a page already shown. */
  async refresh(): Promise<void> {
    const reviewer = this.#state.reviewer;
    if (reviewer === null) return;
    const { epoch, signal } = this.#begin();
    this.#set({ list: 'loading', announcement: 'Loading review history.' });
    const result = await this.#api.page(reviewer, { cursor: null, limit: PAGE_SIZE }, signal);
    if (epoch !== this.#epoch || signal.aborted) return;
    this.#apply(result, false);
    const selected = this.#state.selected;
    if (selected !== null) void this.select(selected);
  }

  async loadMore(): Promise<void> {
    const { reviewer, nextCursor, list } = this.#state;
    if (reviewer === null || nextCursor === null || list === 'loading_more') return;
    const { epoch, signal } = this.#begin();
    this.#set({ list: 'loading_more', announcement: 'Loading more history.' });
    const result = await this.#api.page(reviewer, { cursor: nextCursor, limit: PAGE_SIZE }, signal);
    if (epoch !== this.#epoch || signal.aborted) return;
    this.#apply(result, true);
  }

  #apply(result: ApiResult<HistoryPage>, append: boolean): void {
    switch (result.kind) {
      case 'ok': {
        const page = result.value;
        const known = new Set(this.#state.items.map((item) => item.id));
        const items = append
          ? [...this.#state.items, ...page.items.filter((item) => !known.has(item.id))]
          : page.items;
        this.#set({
          list: 'ready',
          health: page.health,
          items,
          nextCursor: page.nextCursor,
          anchorNonce: page.anchor?.upperNonce ?? null,
          empty: page.empty,
          announcement: page.empty
            ? 'No indexed history.'
            : `${items.length} history ${items.length === 1 ? 'entry' : 'entries'} shown.`,
        });
        return;
      }
      case 'reset':
        // The index was rebuilt or the page anchors moved: the shown list is no longer coherent.
        this.#set({
          list: 'reset_required',
          items: [],
          nextCursor: null,
          anchorNonce: null,
          empty: false,
          detail: null,
          detailState: 'idle',
          announcement: 'History changed. Refresh to load it again.',
        });
        return;
      case 'unavailable':
        this.#set({
          list: 'unavailable',
          health: result.health ?? this.#state.health,
          announcement: 'History is unavailable. Live verification is separate.',
        });
        return;
      case 'failed':
        this.#set({ list: 'failed', announcement: 'History could not be read.' });
    }
  }

  /** Selects one receipt by commitment and loads its separate indexed and live states. */
  async select(commitment: string | null): Promise<void> {
    const reviewer = this.#state.reviewer;
    if (commitment === null || reviewer === null) {
      this.#set({ selected: null, detail: null, detailState: 'idle' });
      return;
    }
    const epoch = this.#epoch;
    this.#set({ selected: commitment, detailState: 'loading' });
    const result = await this.#api.receipt(reviewer, commitment);
    if (epoch !== this.#epoch || this.#state.selected !== commitment) return;
    if (result.kind === 'ok') {
      this.#set({ detail: result.value, detailState: 'ready' });
    } else {
      this.#set({
        detail: null,
        detailState: result.kind === 'unavailable' ? 'unavailable' : 'failed',
        announcement: 'Receipt history could not be read.',
      });
    }
  }

  // ---- Bounded refresh -----------------------------------------------------------------------

  /** Starts a 10-second refresh for two minutes, e.g. right after a transaction confirms. */
  startWatching(): void {
    if (this.#state.reviewer === null) return;
    this.stopWatching();
    this.#watchStarted = this.#scheduler.now();
    this.#stopTimer = this.#scheduler.every(() => {
      if (this.#paused) return;
      if (this.#scheduler.now() - this.#watchStarted >= POLL_WINDOW_MS) {
        this.stopWatching();
        this.#set({ announcement: 'Automatic refresh stopped. Use Refresh to check again.' });
        return;
      }
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.#set({ watching: true });
  }

  stopWatching(): void {
    this.#stopTimer?.();
    this.#stopTimer = null;
    if (this.#state.watching) this.#set({ watching: false });
  }

  /** Hidden or unmounted views pause refreshing; the window keeps running. */
  setPaused(paused: boolean): void {
    this.#paused = paused;
  }

  dispose(): void {
    this.#reset(null);
    this.#listeners.clear();
  }
}
