import {
  getHostConfig,
  setHostConfig,
  subscribeHostConfig,
  type ConfigReason,
  type ConfigResult,
  type ResolvedConfig,
} from './config';
import {
  OBSERVED_ATTRIBUTES,
  snapshotInputs,
  type InputReason,
  type InputSnapshot,
} from './inputs';
import { checkPackage, type IntegrityOutcome } from './package-check';
import { readStatus, type StatusObservation } from './status';
import { STYLES } from './styles';
import {
  INTEGRITY_MEANING,
  INTEGRITY_WORDS,
  LIFECYCLE_MEANING,
  LIFECYCLE_WORDS,
  configText,
  reasonText,
  unknownReason,
  type IconKind,
} from './view';

export const TAG_NAME = 'proof-of-review-status';

/*
 * The autonomous custom element. It is created lazily so that importing this module in Node or an
 * SSR process touches no browser global. Rendering uses textContent and createElementNS only; no
 * value, from an attribute, an RPC response or a package, is ever parsed as HTML.
 */

type StatusPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'config'; readonly reason: ConfigReason | InputReason }
  | { readonly kind: 'done'; readonly observation: StatusObservation };

type FilesPhase =
  | { readonly kind: 'no-package' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'not-checked' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly outcome: IntegrityOutcome };

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS: Readonly<Record<IconKind, string>> = {
  active: 'M4 12l5 5L20 6',
  revoked: 'M6 6l12 12M18 6L6 18',
  superseded: 'M4 8h13m-4-4l4 4-4 4M20 16H7m4-4l-4 4 4 4',
  not_found: 'M10 4a6 6 0 100 12 6 6 0 000-12zm4.5 10.5L20 20',
  unknown: 'M9 9a3 3 0 116 0c0 2-3 2-3 5m0 3v.01',
  checking: 'M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8',
  config: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.01',
  match: 'M4 12l5 5L20 6',
  mismatch: 'M6 6l12 12M18 6L6 18',
  incomplete: 'M5 12h14M12 5v14',
  unsupported: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.01',
  unavailable: 'M9 9a3 3 0 116 0c0 2-3 2-3 5m0 3v.01',
  'not-checked': 'M5 12h14',
};

function icon(kind: IconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[kind]);
  svg.append(path);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createProofOfReviewStatusClass(): CustomElementConstructor {
  class ProofOfReviewStatus extends HTMLElement {
    static get observedAttributes(): string[] {
      return [...OBSERVED_ATTRIBUTES];
    }

    #root: ShadowRoot | null = null;
    #generation = 0;
    #scheduled = false;
    #controller: AbortController | null = null;
    #filesController: AbortController | null = null;
    #unsubscribe: (() => void) | null = null;
    #status: StatusPhase = { kind: 'idle' };
    #files: FilesPhase = { kind: 'no-package' };
    /** The last observation of THIS input snapshot, shown only as clearly historical. */
    #previous: StatusObservation | null = null;
    #failedAfterPrevious = false;
    #input: InputSnapshot | null = null;
    #config: ResolvedConfig | null = null;
    #announcement = '';

    connectedCallback(): void {
      this.#root ??= this.attachShadow({ mode: 'open' });
      this.#unsubscribe ??= subscribeHostConfig(() => this.#invalidate());
      this.#invalidate();
    }

    disconnectedCallback(): void {
      this.#generation += 1;
      this.#controller?.abort();
      this.#filesController?.abort();
      this.#controller = null;
      this.#filesController = null;
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#previous = null;
      this.#input = null;
      this.#config = null;
    }

    attributeChangedCallback(): void {
      if (this.isConnected) this.#invalidate();
    }

    /** Re-reads the registry status for the current inputs. No-op without complete configuration. */
    refresh(): void {
      if (!this.isConnected) return;
      this.#startStatusRead();
    }

    // Inputs or policy changed: drop the current presentation immediately, then coalesce.
    #invalidate(): void {
      this.#generation += 1;
      this.#controller?.abort();
      this.#filesController?.abort();
      this.#previous = null;
      this.#failedAfterPrevious = false;
      this.#status = { kind: 'checking' };
      this.#files = { kind: 'no-package' };
      this.#input = null;
      this.#config = null;
      this.#announcement = '';
      this.#render();
      if (this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        if (this.isConnected) this.#startStatusRead();
      });
    }

    #attribute(name: string): string | null {
      return this.getAttribute(name);
    }

    #resolve(): { config: ResolvedConfig; input: InputSnapshot } | null {
      const { result }: { result: ConfigResult } = getHostConfig();
      if (!result.ok) {
        this.#status = { kind: 'config', reason: result.reason };
        this.#files = { kind: 'no-package' };
        return null;
      }
      const snapshot = snapshotInputs(
        {
          chainId: this.#attribute('chain-id'),
          registry: this.#attribute('registry'),
          reviewer: this.#attribute('reviewer'),
          commitment: this.#attribute('commitment'),
          rpcUrl: this.#attribute('rpc-url'),
          packageUrl: this.#attribute('package-url'),
        },
        result.config,
      );
      if (!snapshot.ok) {
        this.#status = { kind: 'config', reason: snapshot.reason };
        this.#files = { kind: 'no-package' };
        return null;
      }
      this.#config = result.config;
      this.#input = snapshot.input;
      if (this.#files.kind !== 'done' && this.#files.kind !== 'checking') {
        this.#files = snapshot.input.packageRejected
          ? { kind: 'rejected' }
          : snapshot.input.packageUrl === null
            ? { kind: 'no-package' }
            : { kind: 'not-checked' };
      }
      return { config: result.config, input: snapshot.input };
    }

    #startStatusRead(): void {
      const resolved = this.#resolve();
      if (resolved === null) {
        this.#render();
        return;
      }
      this.#controller?.abort();
      const controller = new AbortController();
      this.#controller = controller;
      const generation = ++this.#generation;
      this.#status = { kind: 'checking' };
      this.#render();
      void readStatus(resolved.input, resolved.config, { signal: controller.signal }).then(
        (observation) => {
          // A stale or cancelled generation can never restore a result.
          if (generation !== this.#generation || !this.isConnected) return;
          if (observation.state === 'unknown' && this.#previous !== null) {
            this.#failedAfterPrevious = true;
          } else {
            this.#failedAfterPrevious = false;
            if (observation.state !== 'unknown') this.#previous = observation;
          }
          this.#status = { kind: 'done', observation };
          this.#announcement = `Receipt status: ${LIFECYCLE_WORDS[observation.state]}.`;
          this.#render();
        },
      );
    }

    #checkFiles(): void {
      if (this.#input === null || this.#config === null || this.#input.packageUrl === null) return;
      const input = this.#input;
      const config = this.#config;
      this.#filesController?.abort();
      const controller = new AbortController();
      this.#filesController = controller;
      const generation = this.#generation;
      this.#files = { kind: 'checking' };
      this.#render();
      void checkPackage(input, config, { signal: controller.signal }).then((outcome) => {
        if (generation !== this.#generation || controller.signal.aborted || !this.isConnected)
          return;
        this.#files = { kind: 'done', outcome };
        this.#announcement = `File integrity: ${INTEGRITY_WORDS[outcome.kind]}.`;
        this.#render();
      });
    }

    #render(): void {
      const root = this.#root;
      if (root === null) return;
      const busy = this.#status.kind === 'checking' || this.#files.kind === 'checking';
      const box = el('div', 'root');
      box.setAttribute('part', 'root');
      box.setAttribute('aria-busy', busy ? 'true' : 'false');
      box.append(el('p', 'title', 'Proof of Review'));
      box.append(this.#statusLine(), this.#filesLine(), this.#reference());

      const actions = el('div', 'actions');
      const refresh = el('button', null, 'Refresh');
      refresh.type = 'button';
      refresh.setAttribute('aria-label', 'Refresh receipt status');
      refresh.addEventListener('click', () => this.refresh());
      actions.append(refresh);
      if (this.#input?.packageUrl != null) {
        const check = el('button', null, 'Check files');
        check.type = 'button';
        check.setAttribute('aria-label', 'Check files against this receipt reference');
        check.disabled = this.#files.kind === 'checking';
        check.addEventListener('click', () => this.#checkFiles());
        actions.append(check);
      }
      box.append(actions);
      box.append(
        el(
          'p',
          'note',
          'The status is an observation of the configured registry, not a legal or professional verdict. The host page chooses what is displayed here.',
        ),
      );
      const live = el('div', 'sr', this.#announcement);
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      box.append(live);
      const style = document.createElement('style');
      style.textContent = STYLES;
      root.replaceChildren(style, box);
    }

    #line(label: string, kind: IconKind, word: string, detail: string[]): HTMLElement {
      const line = el('div', `line s-${kind}`);
      line.append(icon(kind));
      const text = el('div', 'text');
      const head = el('div', null);
      head.append(el('span', 'label', `${label}: `), el('span', 'value', word));
      text.append(head);
      for (const part of detail) if (part !== '') text.append(el('span', 'detail', part));
      line.append(text);
      return line;
    }

    #statusLine(): HTMLElement {
      const status = this.#status;
      const label = 'Receipt status';
      if (status.kind === 'checking' || status.kind === 'idle')
        return this.#line(label, 'checking', 'checking…', ['Reading the configured registry.']);
      if (status.kind === 'config')
        return this.#line(label, 'config', 'unknown', [
          'Not checked: configuration problem.',
          configText(status.reason),
        ]);
      const observation = status.observation;
      const state = observation.state;
      const context =
        observation.checkpoint === null
          ? `Observed ${observation.observedAt}.`
          : `Observed ${observation.observedAt} at block ${observation.checkpoint.blockNumber}.`;
      const detail =
        state === 'unknown'
          ? [unknownReason(observation), context]
          : [LIFECYCLE_MEANING[state], context];
      if (state === 'unknown' && this.#failedAfterPrevious && this.#previous !== null) {
        const previous = this.#previous;
        detail.push(
          `Historical only, not current: earlier read showed ${LIFECYCLE_WORDS[previous.state]} (${previous.observedAt}).`,
        );
      }
      return this.#line(label, state, LIFECYCLE_WORDS[state], detail);
    }

    #filesLine(): HTMLElement {
      const label = 'File integrity';
      const files = this.#files;
      switch (files.kind) {
        case 'no-package':
          return this.#line(label, 'not-checked', 'not checked — no package supplied', []);
        case 'rejected':
          return this.#line(label, 'not-checked', 'not checked', [
            'The package-url is not on an origin the host approved.',
          ]);
        case 'not-checked':
          return this.#line(label, 'not-checked', 'not checked', [
            'Use Check files to download the published package and compare it with this reference.',
          ]);
        case 'checking':
          return this.#line(label, 'checking', 'checking…', [
            'Downloading and comparing the package.',
          ]);
        case 'done': {
          const outcome = files.outcome;
          return this.#line(label, outcome.kind, INTEGRITY_WORDS[outcome.kind], [
            INTEGRITY_MEANING[outcome.kind],
            reasonText(outcome.reason),
          ]);
        }
      }
    }

    #reference(): HTMLElement {
      const list = el('dl', 'ref');
      const rows: [string, string][] = [
        ['Chain', this.#attribute('chain-id') ?? ''],
        ['Registry', this.#attribute('registry') ?? ''],
        ['Reviewer', this.#attribute('reviewer') ?? ''],
        ['Commitment', this.#attribute('commitment') ?? ''],
      ];
      for (const [term, value] of rows) list.append(el('dt', null, term), el('dd', null, value));
      return list;
    }
  }
  return ProofOfReviewStatus;
}

let definedClass: CustomElementConstructor | null = null;

export type RegistrationResult =
  | { readonly ok: true; readonly alreadyRegistered: boolean; readonly config: ConfigResult }
  | { readonly ok: false; readonly reason: 'NOT_A_BROWSER' | 'TAG_TAKEN_BY_OTHER_DEFINITION' };

/**
 * Sets the host configuration and defines `proof-of-review-status`. No network request is made.
 * Calling it again replaces the configuration (connected elements re-read) and never redefines the
 * element. A different, pre-existing definition of the tag is reported, never replaced.
 */
export function registerProofOfReviewStatus(hostConfig: unknown): RegistrationResult {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined')
    return { ok: false, reason: 'NOT_A_BROWSER' };
  const existing = customElements.get(TAG_NAME);
  if (existing !== undefined && existing !== definedClass)
    return { ok: false, reason: 'TAG_TAKEN_BY_OTHER_DEFINITION' };
  const config = setHostConfig(hostConfig);
  if (existing !== undefined) return { ok: true, alreadyRegistered: true, config };
  definedClass = createProofOfReviewStatusClass();
  customElements.define(TAG_NAME, definedClass);
  return { ok: true, alreadyRegistered: false, config };
}
