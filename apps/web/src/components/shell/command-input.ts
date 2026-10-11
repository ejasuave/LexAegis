/*
 * Keyboard semantics of the shared composer. Enter sends only when there is something to send, no
 * input method is composing, no run is already active and the assistant exists; Shift+Enter always
 * inserts a newline. Anything else leaves the draft exactly as typed.
 */

export interface EnterContext {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly draft: string;
  readonly busy: boolean;
  readonly available: boolean;
}

export type EnterDecision = 'send' | 'newline' | 'ignore';

export function decideEnter(context: EnterContext): EnterDecision {
  // Browsers report an input method's key handling as key "Process" or isComposing.
  if (context.isComposing || context.key === 'Process') return 'newline';
  if (context.key !== 'Enter') return 'newline';
  if (context.shiftKey) return 'newline';
  if (context.draft.trim() === '' || context.busy || !context.available) return 'ignore';
  return 'send';
}
