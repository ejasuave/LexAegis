import { toBase64Url } from '@lexaegis/protocol/portable';
import {
  prepareReviewPackage,
  type PreparedReviewPackage,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import { parseReviewExport } from '@lexaegis/sdk/portable';
import { buildIssueAction, buildTypedData } from '@lexaegis/sdk/registry';
import { buildSyntheticPackage, type ExampleContext } from './profile.js';

export interface PrepareOptions extends ExampleContext {
  /** Supplying both prints the typed signing data for the caller's own signer. Neither is guessed. */
  readonly nonce?: string;
  readonly deadline?: string;
}

export interface PrepareResult {
  /** UNAPPROVED: nobody has reviewed or approved this package. It is a captured snapshot only. */
  readonly prepared: PreparedReviewPackage;
  /** The readable review export (private: contains the opening and the documents). */
  readonly exportBytes: Uint8Array;
  readonly reference: ReceiptReferenceV1;
  /** Typed data a caller-owned signer would sign. This example never signs or broadcasts it. */
  readonly typedData: unknown;
}

/**
 * Prepares a synthetic package with a FRESH production-style random blinding nonce, and shapes the
 * readable export from the immutable snapshot. Fixed nonces exist only inside the SDK's tests.
 */
export async function prepareExample(options: PrepareOptions): Promise<PrepareResult> {
  const { nonce, deadline, ...context } = options;
  const synthetic = await buildSyntheticPackage(context);
  const prepared = await prepareReviewPackage(synthetic.manifest, synthetic.artifacts);
  if (!prepared.ok) throw new Error(`could not prepare the package: ${prepared.error.code}`);
  const snapshot = prepared.data;

  const exportBytes = new TextEncoder().encode(
    JSON.stringify({
      schema: 'lexaegis.review-export.v1',
      receiptReference: snapshot.reference,
      opening: snapshot.opening,
      artifacts: snapshot.artifactIds.map((artifactId) => ({
        artifactId,
        bytes: toBase64Url(snapshot.artifactBytes(artifactId)),
      })),
    }),
  );
  // Prove the file decodes with the same strict reader a recipient will use.
  const check = parseReviewExport(exportBytes);
  if (!check.ok) throw new Error(`the export did not decode: ${check.error.code}`);

  let typedData: unknown = null;
  if (nonce !== undefined || deadline !== undefined) {
    // The caller chooses the registry nonce and deadline; nothing here reads a chain or a clock.
    const action = buildIssueAction(snapshot, nonce, deadline);
    if (!action.ok) throw new Error(`could not build the action: ${action.error.code}`);
    const data = buildTypedData(action.data, context.chainId, context.registryAddress);
    if (!data.ok) throw new Error(`could not build the typed data: ${data.error.code}`);
    typedData = data.data;
  }
  return { prepared: snapshot, exportBytes, reference: snapshot.reference, typedData };
}
