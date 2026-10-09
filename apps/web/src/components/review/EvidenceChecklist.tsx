'use client';

import { useState } from 'react';
import type { EvidenceSelectionV1 } from '@lexaegis/agent/contracts';
import { useReview } from './review-context';
import { btn, field, h2, muted } from './styles';

const STATE_TEXT: Record<string, string> = {
  supplied_unreviewed: 'File supplied, not yet confirmed by you',
  confirmed_for_check: 'Linked by you for this check',
  missing: 'Not confirmed within the selected documents',
  not_assessed: 'Not assessed',
  not_applicable: 'Marked not applicable by you, with a reason',
};

/** Linking a file does not prove authenticity, independence, insurance validity or qualification. */
export function EvidenceChecklist() {
  const { controller, snapshot } = useReview();
  const [draft, setDraft] = useState<Record<string, { artifactId: string; confirmed: boolean }>>(
    {},
  );
  const checklist = snapshot.checks.checklist;
  const requirements = checklist?.items ?? [];
  const documents = snapshot.documents.filter((d) => d.extraction === 'ready');

  function apply(requirement: string) {
    const entry = draft[requirement];
    if (controller === null || entry === undefined) return;
    const others = snapshot.evidence.filter((e) => e.requirement !== requirement);
    const next: EvidenceSelectionV1[] =
      entry.artifactId === ''
        ? others
        : [
            ...others,
            {
              requirement,
              artifactIds: [entry.artifactId],
              confirmedForCheck: entry.confirmed,
              notApplicableReason: null,
            },
          ];
    controller.setEvidence(next);
  }

  return (
    <section aria-label="Evidence checklist" className="min-w-0">
      <h2 className={h2}>Evidence checklist</h2>
      <p className={muted}>
        This is a scoped review aid, not an exhaustive test of enforceability. Run the checks to
        populate it.
      </p>
      <ul className="m-0 mt-2 list-none p-0">
        {requirements.map((item) => {
          const current = draft[item.requirement] ?? {
            artifactId:
              snapshot.evidence.find((e) => e.requirement === item.requirement)?.artifactIds[0] ??
              '',
            confirmed:
              snapshot.evidence.find((e) => e.requirement === item.requirement)
                ?.confirmedForCheck ?? false,
          };
          return (
            <li key={item.requirement} className="border-b border-lj-divider py-2 text-[0.875rem]">
              <p className="m-0">
                <strong>{item.requirement.replaceAll('-', ' ')}</strong>:{' '}
                {STATE_TEXT[item.state] ?? item.state}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  className={`${field} max-w-64`}
                  aria-label={`Document for ${item.requirement}`}
                  value={current.artifactId}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      [item.requirement]: { ...current, artifactId: e.target.value },
                    })
                  }
                >
                  <option value="">None linked</option>
                  {documents.map((d) => (
                    <option key={d.sourceArtifactId} value={d.sourceArtifactId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={current.confirmed}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        [item.requirement]: { ...current, confirmed: e.target.checked },
                      })
                    }
                  />
                  Linked for this check
                </label>
                <button type="button" className={btn} onClick={() => apply(item.requirement)}>
                  Apply
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {requirements.length === 0 ? <p className={muted}>No checklist yet.</p> : null}
    </section>
  );
}
