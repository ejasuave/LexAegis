import type { ArtifactRole, ReviewPackageV1 } from '@lexaegis/protocol/v1';

/** The legal reference profile. Legal rules live in the application, never in the generic protocol. */
export const LEGAL_PROFILE_ID = 'lexaegis.employment-settlement.ew';
export const LEGAL_PROFILE_VERSION = '1';

/**
 * Roles a package must contain to be structurally complete for the legal profile. `evidence`
 * is deliberately absent: attachments may be missing when the checklist records that fact.
 */
export const LEGAL_PROFILE_REQUIRED_ROLES: readonly ArtifactRole[] = [
  'source',
  'extracted-text',
  'analysis',
  'calculation',
  'rule-pack',
  'checklist',
  'agent-config',
  'decision-log',
];

export type LegalProfilePresence =
  | { readonly applicable: false }
  | {
      readonly applicable: true;
      readonly complete: boolean;
      readonly missingRoles: ArtifactRole[];
    };

/**
 * Structural completeness only: are the required artifact roles present? It does not open,
 * interpret or validate any artifact's contents. Hashing an artifact says nothing about whether
 * its business content is right; payload schemas and human review belong to Chapters 8–10.
 */
export function checkLegalProfilePresence(manifest: ReviewPackageV1): LegalProfilePresence {
  if (
    manifest.profile.id !== LEGAL_PROFILE_ID ||
    manifest.profile.version !== LEGAL_PROFILE_VERSION
  ) {
    return { applicable: false };
  }
  const present = new Set(manifest.artifacts.map((artifact) => artifact.role));
  const missingRoles = LEGAL_PROFILE_REQUIRED_ROLES.filter((role) => !present.has(role));
  return { applicable: true, complete: missingRoles.length === 0, missingRoles };
}
