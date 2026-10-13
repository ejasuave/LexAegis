import {
  routeUtterance,
  type AssistantIntent,
  type AssistantRequest,
  type IntentSelectionV1,
} from '../contracts';
import { intentSelectionOutputSchema } from './model-schemas';

/*
 * One router for commands, interface actions and free text. Code decides whenever it can. Only a
 * free-text request that code cannot classify may use a single bounded completion that sees the
 * utterance alone, and that completion is charged to the same run budget. There is no planner,
 * critic or narration model.
 */

export interface RouterFlags {
  /** The optional matter-briefing feature. Disabled means the intent does not exist. */
  readonly briefingEnabled: boolean;
}

export type RouteDecision =
  | { readonly kind: 'decided'; readonly selection: IntentSelectionV1 }
  /** Code could not classify this free text: one model selection is permitted. */
  | { readonly kind: 'needs_model' };

const select = (intent: AssistantIntent, via: IntentSelectionV1['via']): IntentSelectionV1 => ({
  schema: 'lexaegis.intent-selection.v1',
  intent,
  via,
  disposition: 'selected',
});
const none = (disposition: 'clarify' | 'unsupported', via: IntentSelectionV1['via'] = 'none') =>
  ({
    schema: 'lexaegis.intent-selection.v1',
    intent: null,
    via,
    disposition,
  }) satisfies IntentSelectionV1;

function gated(selection: IntentSelectionV1, flags: RouterFlags): IntentSelectionV1 {
  return selection.intent === 'brief_matter' && !flags.briefingEnabled
    ? none('unsupported', selection.via)
    : selection;
}

/**
 * Deterministic routing. The server never takes the client's word for a command: the utterance
 * is routed again here, and a claimed intent that contradicts it is unsupported.
 */
export function routeRequest(request: AssistantRequest, flags: RouterFlags): RouteDecision {
  const decided = (selection: IntentSelectionV1): RouteDecision => ({
    kind: 'decided',
    selection: gated(selection, flags),
  });
  if (request.trigger === 'ui_action') {
    // An interface action names its intent; any accompanying text is only the question.
    return decided(
      request.intent === null ? none('unsupported') : select(request.intent, 'ui_action'),
    );
  }
  const routed = routeUtterance(request.utterance);
  // A typed, ordinary question enters the read-only matter Q&A path. The browser
  // and server agree on this intent; forbidden/empty input cannot use it.
  if (request.trigger === 'free_text' && request.intent === 'ask_matter') {
    return routed.kind === 'unsupported' ||
      routed.kind === 'unknown_command' ||
      routed.kind === 'stop'
      ? decided(none('unsupported'))
      : decided(select('ask_matter', 'phrase'));
  }
  if (request.trigger === 'command') {
    if (routed.kind !== 'intent' || routed.via !== 'command' || routed.intent !== request.intent)
      return decided(none('unsupported'));
    return decided(select(routed.intent, 'command'));
  }
  switch (routed.kind) {
    case 'intent':
      return request.intent !== null && request.intent !== routed.intent
        ? decided(none('unsupported'))
        : decided(select(routed.intent, routed.via));
    case 'ambiguous':
      return request.intent === null ? { kind: 'needs_model' } : decided(none('unsupported'));
    default:
      // /stop, unknown commands, approval wording and empty text never reach a model.
      return decided(none('unsupported'));
  }
}

/** Validates the classification a model returned. Anything else is a request for clarification. */
export function parseIntentSelection(
  content: string | null,
  flags: RouterFlags,
): { selection: IntentSelectionV1; valid: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(content ?? '');
  } catch {
    return { selection: none('clarify', 'model'), valid: false };
  }
  const parsed = intentSelectionOutputSchema.safeParse(raw);
  if (!parsed.success) return { selection: none('clarify', 'model'), valid: false };
  const { intent } = parsed.data;
  if (intent === 'clarify' || intent === 'unsupported')
    return { selection: none(intent, 'model'), valid: true };
  return { selection: gated(select(intent, 'model'), flags), valid: true };
}
