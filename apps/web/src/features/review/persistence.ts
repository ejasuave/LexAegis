import {
  confirmedFactSchema,
  evidenceSelectionSchema,
  type ConfirmedFactV1,
  type EvidenceSelectionV1,
} from '@lexaegis/agent/contracts';
import { createSourceReference, factContentDigest, type SourceSet } from '@lexaegis/agent/review';

/*
 * How review data rides on Chapter 5's encrypted matter record without changing it: confirmed
 * facts and evidence selections are context entries with a typed text prefix; extraction output
 * and saved comparisons are immutable source artifacts with a typed label. Source citations are
 * stored as page ranges only and rebuilt (with their quote) from the verified extraction on
 * load, so a changed or missing source can never keep an old citation alive.
 */

export const FACT_PREFIX = 'lexaegis.fact.v1:';
export const EVIDENCE_PREFIX = 'lexaegis.evidence.v1:';
export const EXTRACTION_LABEL = 'lexaegis:extraction:v1:';
export const COMPARISON_LABEL = 'lexaegis:comparison:v1';

type StoredFact = Omit<ConfirmedFactV1, 'references'> & {
  references: { documentVersionId: string; page: number; start: number; end: number }[];
};

export function encodeFact(fact: ConfirmedFactV1): string {
  const stored: StoredFact = {
    ...fact,
    references: fact.references.map((r) => ({
      documentVersionId: r.documentVersionId,
      page: r.page,
      start: r.start,
      end: r.end,
    })),
  };
  return `${FACT_PREFIX}${JSON.stringify(stored)}`;
}

export function factIdOfEntry(text: string): string | null {
  if (!text.startsWith(FACT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(FACT_PREFIX.length)) as { factId?: unknown };
    return typeof parsed.factId === 'string' ? parsed.factId : null;
  } catch {
    return null;
  }
}

/** Rebuilds a fact against the verified set. Null when it cannot be proven to be the same fact. */
export async function decodeFact(text: string, set: SourceSet): Promise<ConfirmedFactV1 | null> {
  if (!text.startsWith(FACT_PREFIX)) return null;
  try {
    const stored = JSON.parse(text.slice(FACT_PREFIX.length)) as StoredFact;
    const references = [];
    for (const r of Array.isArray(stored.references) ? stored.references : []) {
      const made = createSourceReference(set, r);
      if (!made.ok) return null;
      references.push(made.data);
    }
    const parsed = confirmedFactSchema.safeParse({ ...stored, references });
    if (!parsed.success) return null;
    const { contentSha256, ...rest } = parsed.data;
    // The recorded content hash must still match: a changed source or an edited entry fails here.
    return (await factContentDigest(rest)) === contentSha256 ? parsed.data : null;
  } catch {
    return null;
  }
}

export const encodeEvidence = (selections: readonly EvidenceSelectionV1[]): string =>
  `${EVIDENCE_PREFIX}${JSON.stringify(selections)}`;

export function decodeEvidence(text: string): EvidenceSelectionV1[] | null {
  if (!text.startsWith(EVIDENCE_PREFIX)) return null;
  try {
    const raw = JSON.parse(text.slice(EVIDENCE_PREFIX.length)) as unknown;
    if (!Array.isArray(raw)) return null;
    const out: EvidenceSelectionV1[] = [];
    for (const item of raw) {
      const parsed = evidenceSelectionSchema.safeParse(item);
      if (!parsed.success) return null;
      out.push(parsed.data);
    }
    return out;
  } catch {
    return null;
  }
}
