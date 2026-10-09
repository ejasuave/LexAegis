import { PDF_ASSETS, PdfIntake, browserWorkerFactory } from '@/features/documents/pdf-intake';
import { createDiffRunner } from '@/features/documents/diff-runner';
import type { VaultHandle } from '@/features/vault/public';
import { ReviewController } from './controller';

export { ReviewController, EMPTY_REVIEW_SNAPSHOT } from './controller';
export type {
  ReviewSnapshot,
  DocumentView,
  ChecksView,
  ComparisonView,
  IntakeStatus,
} from './controller';

/** Builds the tab's review controller on the vault and account handles, with browser workers. */
export function createBrowserReview(
  vault: VaultHandle,
  account: () => string | null,
): ReviewController {
  const intake = new PdfIntake({
    createWorker: browserWorkerFactory,
    generation: () => vault.getSnapshot().generation,
    assets: PDF_ASSETS,
  });
  return new ReviewController({
    vault,
    account,
    intake,
    runDiff: createDiffRunner(),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  });
}
