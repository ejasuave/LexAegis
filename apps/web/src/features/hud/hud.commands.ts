import { routeUtterance } from '@lexaegis/agent/contracts';
import type { COMMAND_INTENTS, STOP_COMMAND } from '@lexaegis/agent/contracts';

/*
 * One command registry for the palette and the dock. It lists only the allowlisted commands that
 * the assistant router already knows, so a command here can never name approve, sign, freeze,
 * broadcast or arbitrary execution, and an unknown command never falls through to anything.
 */

export type CommandId = keyof typeof COMMAND_INTENTS | typeof STOP_COMMAND;

export interface CommandEntry {
  readonly command: CommandId;
  readonly title: string;
  readonly description: string;
  /** What the command may never do, shown so it is not mistaken for something larger. */
  readonly boundary: string;
  /** Needs the optional matter-briefing feature. */
  readonly feature: 'matterBriefing' | null;
}

const ALL: readonly CommandEntry[] = [
  {
    command: '/explain',
    title: 'Explain the selected clause',
    description: 'Source-linked explanation of the passage you selected.',
    boundary: 'Needs a selected passage and your Send of the preview. Approves nothing.',
    feature: null,
  },
  {
    command: '/check-payments',
    title: 'Check payments',
    description: 'Runs the payment calculation in code and shows the formula.',
    boundary: 'Code does the arithmetic. A model never supplies a verified figure.',
    feature: null,
  },
  {
    command: '/status',
    title: 'Show status',
    description: 'Reads the actual workspace, runtime and receipt state.',
    boundary: 'No model call.',
    feature: null,
  },
  {
    command: '/missing-evidence',
    title: 'Check missing evidence',
    description: 'Shows or refreshes the scoped evidence checks.',
    boundary: 'Unknown stays unknown: missing is not proof an event did not happen.',
    feature: null,
  },
  {
    command: '/summarise',
    title: 'Summarise the selection',
    description: 'Summarises the context you authorised.',
    boundary: 'Shows exactly what would be sent first; nothing leaves until you choose Send.',
    feature: null,
  },
  {
    command: '/prepare-review',
    title: 'Prepare the review package',
    description: 'Lists what is outstanding before a review package can be frozen.',
    boundary: 'Preparing is not approving or signing.',
    feature: null,
  },
  {
    command: '/brief',
    title: 'Brief the matter',
    description: 'A briefing of the selected matter.',
    boundary: 'Optional feature. Shows the disclosure preview first.',
    feature: 'matterBriefing',
  },
  {
    command: '/stop',
    title: 'Stop',
    description: 'Requests cancellation of anything still running.',
    boundary: 'No model and no approval. It never reverses a broadcast transaction.',
    feature: null,
  },
];

export function availableCommands(features: {
  readonly matterBriefing: boolean;
}): readonly CommandEntry[] {
  return ALL.filter((entry) => entry.feature === null || features[entry.feature]);
}

/** Prefix matches first, then word and substring matches. Empty query lists everything. */
export function filterCommands(
  entries: readonly CommandEntry[],
  query: string,
): readonly CommandEntry[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (q === '') return entries;
  const rank = (entry: CommandEntry): number => {
    const name = entry.command.slice(1);
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (entry.title.toLowerCase().includes(q)) return 2;
    return 3;
  };
  return entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter(({ rank: r }) => r < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(({ entry }) => entry);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = above;
    }
  }
  return row[b.length] ?? 0;
}

/** The closest known command to a mistyped one, or null when nothing is near. */
export function suggestCommand(
  entries: readonly CommandEntry[],
  typed: string,
): CommandEntry | null {
  const name = typed.trim().toLowerCase().replace(/^\//, '');
  let best: { entry: CommandEntry; d: number } | null = null;
  for (const entry of entries) {
    const d = distance(name, entry.command.slice(1));
    if (best === null || d < best.d) best = { entry, d };
  }
  return best !== null && best.d <= 3 ? best.entry : null;
}

export type Resolution =
  /** An explicit allowlisted command: it goes through the normal consent and validation path. */
  | { readonly kind: 'command'; readonly entry: CommandEntry; readonly text: string }
  /** Direct cancellation: no model round-trip and no approval dialog. */
  | { readonly kind: 'stop' }
  /** Free text. It is handed to the editable dock, never executed from the palette. */
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unknown'; readonly typed: string; readonly suggestion: CommandEntry | null }
  /** Asks for approval or signing. Nothing in the assistant path does that. */
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'empty' };

/** Deterministic: the same router the assistant uses decides, so the two cannot disagree. */
export function resolveInput(entries: readonly CommandEntry[], input: string): Resolution {
  const text = input.trim();
  const routed = routeUtterance(text);
  switch (routed.kind) {
    case 'stop':
      return { kind: 'stop' };
    case 'unsupported':
      return routed.reason === 'empty' ? { kind: 'empty' } : { kind: 'refused', text };
    case 'unknown_command':
      return {
        kind: 'unknown',
        typed: routed.command,
        suggestion: suggestCommand(entries, routed.command),
      };
    case 'ambiguous':
      return { kind: 'text', text };
    case 'intent': {
      if (routed.via === 'phrase') return { kind: 'text', text };
      const name = (text.split(/\s+/)[0] ?? '').toLowerCase();
      const entry = entries.find((candidate) => candidate.command === name);
      return entry === undefined
        ? { kind: 'unknown', typed: name, suggestion: suggestCommand(entries, name) }
        : { kind: 'command', entry, text };
    }
  }
}
