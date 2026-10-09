import {
  evidenceChecklistSchema,
  type EvidenceChecklistV1,
  type EvidenceSelectionV1,
  type EvidenceState,
  type RulePackV1,
} from '../contracts/review';
import type { LoadedRulePack } from './rule-pack';

/*
 * Evidence checklist. supplied_unreviewed means a file was supplied; confirmed_for_check means the
 * reviewer linked it to the requirement. Neither proves authenticity, independence, insurance
 * validity or professional qualification. Missing means not confirmed within the selected review
 * scope, not that the evidence cannot exist elsewhere.
 */

export function evidenceStateOf(
  rule: RulePackV1['rules'][number],
  selection: EvidenceSelectionV1 | undefined,
  assessed: boolean,
): { state: EvidenceState; permitted: boolean } {
  if (
    selection === undefined ||
    (selection.artifactIds.length === 0 && selection.notApplicableReason === null)
  ) {
    return { state: assessed ? 'missing' : 'not_assessed', permitted: true };
  }
  if (selection.notApplicableReason !== null) {
    return rule.allowedNotApplicable
      ? { state: 'not_applicable', permitted: true }
      : { state: 'missing', permitted: false };
  }
  return {
    state: selection.confirmedForCheck ? 'confirmed_for_check' : 'supplied_unreviewed',
    permitted: true,
  };
}

/** Populates the checklist from actual selections. Neither state proves authenticity or validity. */
export function buildChecklist(
  rulePack: LoadedRulePack,
  evidence: readonly EvidenceSelectionV1[],
  assessed: boolean,
): EvidenceChecklistV1 {
  const items = rulePack.pack.rules
    .filter((rule) => rule.evidenceRequirement !== null)
    .map((rule) => {
      const selection = evidence.find((s) => s.requirement === rule.evidenceRequirement);
      const { state } = evidenceStateOf(rule, selection, assessed);
      return {
        requirement: rule.evidenceRequirement as string,
        ruleId: rule.ruleId,
        state,
        artifactIds:
          state === 'supplied_unreviewed' || state === 'confirmed_for_check'
            ? [...(selection?.artifactIds ?? [])]
            : [],
        notApplicableReason:
          state === 'not_applicable' ? (selection?.notApplicableReason ?? null) : null,
      };
    });
  return evidenceChecklistSchema.parse({
    schema: 'lexaegis.evidence-checklist.v1',
    rulePackDigest: rulePack.digest,
    items,
  });
}
