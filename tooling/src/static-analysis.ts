import { z } from 'zod';

/*
 * Static-analysis bookkeeping. Every finding the analyser reports is kept in a sanitised inventory
 * and must be matched by exactly one triage entry that names it by ID. There is no detector-wide
 * ignore: a new, changed or vanished finding fails the check until a person triages it.
 */

export const PINNED = { slither: '0.11.6', cryticCompile: '0.4.2' } as const;

export const DISPOSITIONS = [
  'fixed',
  'accepted',
  'false_positive',
  'open',
  'requires_redeploy_decision',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
/** Dispositions that leave the gate open: they can never be reported as resolved. */
export const UNRESOLVED: ReadonlySet<Disposition> = new Set(['open', 'requires_redeploy_decision']);

const elementSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  source_mapping: z
    .looseObject({ filename_relative: z.string(), lines: z.array(z.number()) })
    .optional(),
  type_specific_fields: z
    .looseObject({
      parent: z.looseObject({ type: z.string(), name: z.string().optional() }).optional(),
      signature: z.string().optional(),
    })
    .optional(),
});
const slitherOutputSchema = z.looseObject({
  success: z.boolean(),
  error: z.string().nullable(),
  results: z.looseObject({
    detectors: z
      .array(
        z.looseObject({
          id: z.string().regex(/^[0-9a-f]{64}$/),
          check: z.string(),
          impact: z.string(),
          confidence: z.string(),
          description: z.string(),
          elements: z.array(elementSchema),
        }),
      )
      .optional(),
  }),
});

export const findingSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  check: z.string(),
  impact: z.string(),
  confidence: z.string(),
  scope: z.enum(['source', 'dependency']),
  location: z.string(),
  function: z.string().nullable(),
  /** Whether the function is reachable from the registry's entry points; null when not a function. */
  reachable: z.boolean().nullable(),
  summary: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const inventorySchema = z.strictObject({
  schema: z.literal('lexaegis.security.slither-findings.v1'),
  note: z.string(),
  tool: z.strictObject({ slither: z.string(), cryticCompile: z.string(), forge: z.string() }),
  target: z.string(),
  contractsAnalysed: z.number(),
  detectorsRun: z.number(),
  reachableFunctions: z.array(z.string()),
  findings: z.array(findingSchema),
});
export type Inventory = z.infer<typeof inventorySchema>;

export const triageSchema = z.strictObject({
  schema: z.literal('lexaegis.security.static-analysis-triage.v1'),
  slither: z.array(
    z.strictObject({
      key: z.string().regex(/^S-\d{2}$/),
      check: z.string(),
      scope: z.enum(['source', 'dependency']),
      disposition: z.enum(DISPOSITIONS),
      reasoning: z.string().min(40),
      evidence: z.string().min(10),
      ids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
    }),
  ),
  lint: z.array(
    z.strictObject({
      key: z.string().regex(/^L-\d{2}$/),
      lint: z.string(),
      /** How many diagnostics the inline suppression in the source hides. */
      count: z.number().int().positive(),
      disposition: z.enum(DISPOSITIONS),
      reasoning: z.string().min(40),
      evidence: z.string().min(10),
    }),
  ),
});
export type Triage = z.infer<typeof triageSchema>;

/** Absolute paths never reach a committed file: only paths relative to the contracts project. */
const sanitise = (text: string): string =>
  text
    .replace(/\(?(?:\/[\w.@-]+)+\/(node_modules|src)\//g, (match, root: string) =>
      match.startsWith('(') ? `(${root}/` : `${root}/`,
    )
    .replace(/\s+/g, ' ')
    .trim();

export function parseSlither(
  rawJson: string,
  reachable: ReadonlySet<string>,
): { ok: true; findings: Finding[] } | { ok: false; reason: string } {
  let parsed: z.infer<typeof slitherOutputSchema>;
  try {
    parsed = slitherOutputSchema.parse(JSON.parse(rawJson));
  } catch {
    return { ok: false, reason: 'OUTPUT_UNREADABLE' };
  }
  // A failed compilation or analysis is a tool failure, never "no findings".
  if (!parsed.success || parsed.error !== null) return { ok: false, reason: 'ANALYSIS_FAILED' };
  if (parsed.results.detectors === undefined) return { ok: false, reason: 'NO_DETECTOR_RESULTS' };
  const findings = parsed.results.detectors.map((detector): Finding => {
    const first = detector.elements[0];
    const file = first?.source_mapping?.filename_relative ?? '';
    const lines = first?.source_mapping?.lines ?? [];
    const inSource = detector.elements.some((element) =>
      (element.source_mapping?.filename_relative ?? '').startsWith('src/'),
    );
    const owner =
      first?.type === 'function'
        ? `${first.type_specific_fields?.parent?.name ?? '?'}.${first.type_specific_fields?.signature ?? first.name ?? '?'}`
        : null;
    return {
      id: detector.id,
      check: detector.check,
      impact: detector.impact,
      confidence: detector.confidence,
      scope: inSource ? 'source' : 'dependency',
      location:
        file === ''
          ? 'project'
          : `${file}${lines.length === 0 ? '' : `#${String(lines[0])}${lines.length > 1 ? `-${String(lines[lines.length - 1])}` : ''}`}`,
      function: owner,
      reachable: owner === null ? null : reachable.has(owner),
      summary: sanitise(detector.description.split('\n')[0] ?? '').slice(0, 300),
    };
  });
  return {
    ok: true,
    findings: findings.sort((a, b) =>
      a.check === b.check ? (a.id < b.id ? -1 : 1) : a.check < b.check ? -1 : 1,
    ),
  };
}

/** Lint diagnostics by rule, from `forge lint` text output (`warning[rule]: ...`). */
export function countLintDiagnostics(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of output.matchAll(/^(?:warning|error|note)\[([a-z0-9-]+)\]/gm)) {
    const rule = match[1] ?? '';
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

export interface ReconcileIssue {
  readonly code:
    | 'UNTRIAGED_FINDING'
    | 'TRIAGED_TWICE'
    | 'STALE_TRIAGE_ID'
    | 'CHECK_MISMATCH'
    | 'SCOPE_MISMATCH'
    | 'LINT_UNTRIAGED'
    | 'LINT_COUNT_MISMATCH'
    | 'LINT_STALE';
  readonly detail: string;
}

/** Every finding is named by exactly one triage entry of the same detector and scope. */
export function reconcile(
  findings: readonly Finding[],
  suppressedLint: Readonly<Record<string, number>>,
  triage: Triage,
): ReconcileIssue[] {
  const issues: ReconcileIssue[] = [];
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const seen = new Map<string, string>();
  for (const entry of triage.slither) {
    for (const id of entry.ids) {
      const finding = byId.get(id);
      if (finding === undefined) {
        issues.push({ code: 'STALE_TRIAGE_ID', detail: `${entry.key} ${id.slice(0, 12)}` });
        continue;
      }
      if (seen.has(id)) {
        issues.push({
          code: 'TRIAGED_TWICE',
          detail: `${id.slice(0, 12)} in ${seen.get(id) ?? ''} and ${entry.key}`,
        });
      }
      seen.set(id, entry.key);
      if (finding.check !== entry.check) {
        issues.push({
          code: 'CHECK_MISMATCH',
          detail: `${entry.key} ${id.slice(0, 12)} is ${finding.check}`,
        });
      }
      if (finding.scope !== entry.scope) {
        issues.push({
          code: 'SCOPE_MISMATCH',
          detail: `${entry.key} ${id.slice(0, 12)} is ${finding.scope}`,
        });
      }
    }
  }
  for (const finding of findings) {
    if (!seen.has(finding.id)) {
      issues.push({
        code: 'UNTRIAGED_FINDING',
        detail: `${finding.check} ${finding.id.slice(0, 12)} ${finding.location}`,
      });
    }
  }
  const lintByRule = new Map(triage.lint.map((entry) => [entry.lint, entry]));
  for (const [rule, count] of Object.entries(suppressedLint)) {
    const entry = lintByRule.get(rule);
    if (entry === undefined)
      issues.push({ code: 'LINT_UNTRIAGED', detail: `${rule} x${String(count)}` });
    else if (entry.count !== count) {
      issues.push({
        code: 'LINT_COUNT_MISMATCH',
        detail: `${rule}: ${String(count)} found, ${String(entry.count)} triaged`,
      });
    }
  }
  for (const entry of triage.lint) {
    if (suppressedLint[entry.lint] === undefined)
      issues.push({ code: 'LINT_STALE', detail: entry.lint });
  }
  return issues;
}

export function unresolved(triage: Triage): string[] {
  return [...triage.slither, ...triage.lint]
    .filter((entry) => UNRESOLVED.has(entry.disposition))
    .map((entry) => entry.key);
}
