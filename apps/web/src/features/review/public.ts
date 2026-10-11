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

export {
  DecisionController,
  EMPTY_DECISION_SNAPSHOT,
  ALLOWED_KINDS,
  DISPOSITION_KINDS,
  MAX_REASON_BYTES,
  REASON_REQUIRED,
  reviewDispositionSchema,
  decisionLogSchema,
  validateReason,
} from './decisions';
export type {
  DecisionFailure,
  DecisionResult,
  DecisionSnapshot,
  DispositionKind,
  FindingView,
  RecordedLog,
  ReviewDecisionLogV1,
  ReviewDispositionV1,
} from './decisions';

export { PackageController, EMPTY_PACKAGE_SNAPSHOT } from './package';
export type {
  FrozenView,
  PackageFailure,
  PackagePreview,
  PackageSnapshot,
  PackageStatus,
  PreviewArtifact,
} from './package';

export { ApprovalController, EMPTY_APPROVAL_SNAPSHOT, PREFLIGHT_FRESHNESS_MS } from './approval';
export type {
  ApprovalDisplay,
  ApprovalFailure,
  ApprovalSnapshot,
  ApprovalStage,
  ApprovalTarget,
  Authorisation,
} from './approval';

export { readVerifiedDecisionLog } from './approval';
