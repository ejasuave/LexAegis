import type { AssistantIntent } from './assistant';

/*
 * Deterministic routing shared by the browser and the server. A slash command, an interface
 * action and an unambiguous phrase reach the same handler. /stop is not an intent: it goes to
 * the cancellation controller and never to a model.
 */

export const COMMAND_INTENTS = Object.freeze({
  '/summarise': 'summarise',
  '/explain': 'explain',
  '/check-payments': 'check_payments',
  '/missing-evidence': 'missing_evidence',
  '/prepare-review': 'prepare_review',
  '/status': 'status',
  '/brief': 'brief_matter',
} as const satisfies Record<string, AssistantIntent>);

export const STOP_COMMAND = '/stop';

export type RoutedUtterance =
  | { readonly kind: 'stop' }
  | {
      readonly kind: 'intent';
      readonly intent: AssistantIntent;
      readonly via: 'command' | 'phrase';
      /** The text after a command, or the whole phrase. */
      readonly rest: string;
    }
  /** Free text that code cannot classify: one bounded model selection may be used. */
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'unknown_command'; readonly command: string }
  /** Something Aegis never does, whatever the wording. */
  | { readonly kind: 'unsupported'; readonly reason: 'approval_or_signing' | 'empty' };

const PHRASES: readonly (readonly [AssistantIntent, RegExp])[] = [
  ['summarise', /^(?:please\s+)?(?:summari[sz]e|give me a summary of)\b/],
  ['explain', /^(?:please\s+)?explain\b|\bwhat does (?:this|the selected) clause mean\b/],
  [
    'check_payments',
    /\b(?:check|reconcile|verify) (?:the )?(?:payments?|instalments?|payment schedule)\b|\bdo (?:the )?(?:payments?|instalments?) add up\b/,
  ],
  [
    'missing_evidence',
    /\b(?:what|which) evidence is (?:missing|outstanding)\b|\bmissing evidence\b|\bevidence gaps?\b/,
  ],
  ['brief_matter', /^(?:please\s+)?brief me\b|\bmatter briefing\b/],
  [
    'prepare_review',
    /\bprepare (?:the |a )?review\b|\bwhat is needed (?:for|before) (?:the )?review\b/,
  ],
  ['status', /^(?:what is|what's|show)(?: the)? status\b|^status\b/],
];

/** Requests no assistant path may serve. The reviewer's own controls do these, never a message. */
const FORBIDDEN =
  /^(?:please\s+)?(?:approve|sign|revoke|supersede|freeze|broadcast|submit)\b|^(?:yes|ok(?:ay)?)[,.! ]*(?:approve|sign)\b/;

export function routeUtterance(utterance: string): RoutedUtterance {
  const text = utterance.trim();
  if (text === '') return { kind: 'unsupported', reason: 'empty' };
  if (text.startsWith('/')) {
    const [command = '', ...rest] = text.split(/\s+/);
    const lowered = command.toLowerCase();
    if (lowered === STOP_COMMAND) return { kind: 'stop' };
    const intent = (COMMAND_INTENTS as Readonly<Record<string, AssistantIntent>>)[lowered];
    return intent === undefined
      ? { kind: 'unknown_command', command: lowered.slice(0, 40) }
      : { kind: 'intent', intent, via: 'command', rest: rest.join(' ') };
  }
  const lowered = text.toLowerCase();
  if (FORBIDDEN.test(lowered)) return { kind: 'unsupported', reason: 'approval_or_signing' };
  const matches = PHRASES.filter(([, pattern]) => pattern.test(lowered)).map(([intent]) => intent);
  const [only] = matches;
  return matches.length === 1 && only !== undefined
    ? { kind: 'intent', intent: only, via: 'phrase', rest: text }
    : { kind: 'ambiguous' };
}

/**
 * Intents a deterministic local handler serves without a model or any disclosure when they are
 * asked for directly. Asking Aegis to explain such a result is a separate, disclosed request.
 */
export const LOCAL_INTENTS: readonly AssistantIntent[] = [
  'status',
  'check_payments',
  'missing_evidence',
];
