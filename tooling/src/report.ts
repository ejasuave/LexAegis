import { GATE_IDS, type GateEvaluation, type GateId, gatesRequiredFor } from './gates';
import { isAfter } from './time';

export const REPORT_VERSION = 1;

export function renderGateTable(evaluations: readonly GateEvaluation[]): string {
  const rows = evaluations.map((gate) => {
    const missing = gate.requirements
      .filter((requirement) => requirement.state !== 'satisfied')
      .map((requirement) =>
        requirement.state === 'missing'
          ? `NOT YET: ${requirement.label}`
          : `${requirement.state}: ${requirement.label}`,
      );
    return `${gate.gate}  ${gate.target}  ${gate.outcome.padEnd(7)}  ${gate.observedAt ?? '-'}  ${missing.join('; ') || '-'}`;
  });
  return [
    'gate  target                     outcome  observed                   missing evidence / reason',
    ...rows,
  ].join('\n');
}

export function renderReport(input: {
  readonly runId: string;
  readonly generatedAt: string;
  readonly fingerprint: string;
  readonly evaluations: readonly GateEvaluation[];
  readonly checks: readonly { id: string; outcome: string; reason: string; durationMs: number }[];
  readonly totalMs: number;
  readonly versions: Readonly<Record<string, string>>;
}): string {
  const lines = [
    '# Readiness report',
    '',
    `<!-- readiness-run:${input.runId} version:${String(REPORT_VERSION)} -->`,
    '',
    `Run \`${input.runId}\` at ${input.generatedAt}. Source fingerprint \`${input.fingerprint.slice(0, 16)}\`.`,
    'Exit 0 before a deadline is not a claim of submission readiness. Recorded chain results are historical, not live reads.',
    '',
    '## Gates',
    '',
    '```text',
    renderGateTable(input.evaluations),
    '```',
    '',
    '## Checks',
    '',
    '| Check | Outcome | Reason | Seconds |',
    '| --- | --- | --- | --- |',
    ...input.checks.map(
      (c) => `| ${c.id} | ${c.outcome} | ${c.reason} | ${(c.durationMs / 1000).toFixed(1)} |`,
    ),
    '',
    `Total ${(input.totalMs / 1000).toFixed(1)} s. Tools: ${Object.entries(input.versions)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    '',
  ];
  return lines.join('\n');
}

/** Extracts the run ID from a rendered report, or null. Used to detect an interrupted two-file write. */
export function reportRunId(markdown: string): string | null {
  return /<!-- readiness-run:([a-z0-9-]+) /.exec(markdown)?.[1] ?? null;
}

export interface ExitInput {
  readonly stateValid: boolean;
  readonly checks: readonly { outcome: string }[];
  readonly evaluations: readonly GateEvaluation[];
  readonly now: string;
  readonly require?: GateId;
}

/** Nonzero for invalid state, any failed check, and any required or due gate that is not pass. */
export function exitCode(input: ExitInput): number {
  if (!input.stateValid) return 1;
  if (input.checks.some((check) => check.outcome === 'fail')) return 1;
  const required = new Set<GateId>(
    input.require === undefined ? [] : gatesRequiredFor(input.require),
  );
  for (const gate of input.evaluations) {
    const due = isAfter(input.now, gate.target);
    if ((due || required.has(gate.gate)) && gate.outcome !== 'pass') return 1;
  }
  return 0;
}

export { GATE_IDS };
