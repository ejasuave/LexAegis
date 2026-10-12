import { toBase64Url } from '@lexaegis/protocol/portable';
import type { SavedEvidence } from './storage.js';

export const FULL_DISCLOSURE_NOTICE =
  'FULL DISCLOSURE: this file contains the opening and every file in the package, unencrypted. Anyone who reads it learns the contents. Do not commit it unless it is deliberately synthetic and public.';

/** The readable ReviewExportV1, written exactly as the application writes it, from the preserved copy. */
export function buildReadableExport(reference: unknown, evidence: SavedEvidence): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: 'lexaegis.review-export.v1',
      receiptReference: reference,
      opening: evidence.opening,
      artifacts: evidence.opening.manifest.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        bytes: toBase64Url(evidence.artifacts.get(artifact.id) ?? new Uint8Array()),
      })),
    }),
  );
}
