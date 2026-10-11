import {
  createBrowserAccount,
  type AccountHandle,
  type AccountSnapshot,
} from '@/features/account/public';
import type { PublicConfig } from '@/config/public';
import type { ReceiptReferenceV1 } from '@lexaegis/protocol/v1';
import type { FrozenCaptureSource, RecoverableCapture } from '@lexaegis/vault';
import { selectMatterContext } from '@/features/matters/context-selector';
import { KeySink } from './key-sink';
import {
  recoverVaultFromEmptyStorage,
  describeVaultFailure,
  type RecoveryResult,
} from './recovery';
import { createVaultTransport } from './transport';
import {
  VaultController,
  type ExportPreview,
  type ImportPreview,
  type VaultFailure,
  type VaultOutcome,
  type VaultSnapshot,
} from './vault-controller';

/*
 * The only vault surface UI code may import: a frozen snapshot and a few commands. It carries no
 * key, key handle, PRF access, storage credential or persisted "verified" flag. The assistant may
 * read a snapshot and explain it. It cannot unlock, obtain keys, confirm a disclosure, persist a
 * fact or approve a review.
 */

export type {
  VaultSnapshot,
  VaultState,
  VaultFailure,
  VaultOutcome,
  SaveState,
  VaultProgress,
  MatterSummary,
  ExportPreview,
  ImportPreview,
} from './vault-controller';
export { describeVaultFailure } from './recovery';
export type { RecoveryResult } from './recovery';
export type { MatterRecordV1, ContextEntryV1, SelectedContext } from '@lexaegis/vault';

export const EMPTY_VAULT_SNAPSHOT: VaultSnapshot = Object.freeze({
  generation: 0,
  state: 'unavailable',
  discovery: 'unknown',
  save: 'idle',
  progress: null,
  failure: null,
  headRevision: null,
  matters: Object.freeze([]),
  selectedMatterId: null,
  selectedMatter: null,
  conflictDraftMatterId: null,
  checkedCaptures: Object.freeze([]),
  pendingCaptureCommitments: Object.freeze([]),
  exportPreview: null,
  importPreview: null,
  expiresAt: null,
  idleExpiresAt: null,
});

export interface VaultCommands {
  createVault(): Promise<VaultOutcome>;
  unlock(): Promise<VaultOutcome>;
  recover(): Promise<RecoveryResult>;
  lock(): void;
  refreshDiscovery(): Promise<VaultOutcome<unknown>>;
  reload(): Promise<VaultOutcome>;
  reconcile(): Promise<VaultOutcome>;
  reapplyConflictDraft(): Promise<VaultOutcome>;
  selectMatter(matterId: string | null): void;
  createMatter(title: string): Promise<VaultOutcome<string>>;
  saveMatter(matterId: string): Promise<VaultOutcome>;
  discardDraft(matterId: string): void;
  addSourceFile(
    matterId: string,
    file: {
      bytes: Uint8Array;
      mediaType: string;
      label: string;
      documentId?: string;
      documentVersionId?: string;
      artifactId?: string;
    },
  ): Promise<VaultOutcome<string>>;
  /** Reads a stored original back, authenticated and hash-checked. The caller zeroes the copy. */
  readSource(matterId: string, documentVersionId: string): Promise<VaultOutcome<Uint8Array>>;
  addEntry(
    matterId: string,
    input: {
      kind: 'fact' | 'note' | 'outcome';
      text: string;
      confirmed: boolean;
      documentVersionId?: string;
      origin?: 'user' | 'model_proposed';
    },
  ): VaultOutcome;
  correctEntry(matterId: string, entryId: string, text: string): VaultOutcome;
  confirmEntry(matterId: string, entryId: string): VaultOutcome;
  removeEntry(matterId: string, entryId: string): VaultOutcome;
  prepareExport(
    kind: ExportPreview['kind'],
    matterId: string,
    commitment?: string,
  ): Promise<VaultOutcome<ExportPreview>>;
  /** The explicit Download confirmation. */
  confirmExport(
    exportId: string,
  ): VaultOutcome<{ fileName: string; bytes: Uint8Array; mediaType: 'application/json' }>;
  cancelExport(): void;
  previewImport(bytes: Uint8Array): Promise<VaultOutcome<ImportPreview>>;
  confirmReviewImport(
    importId: string,
    matterId: string,
  ): Promise<VaultOutcome<{ commitment: string }>>;
  confirmContextImport(
    importId: string,
    matterId: string,
    entryIds: readonly string[],
  ): VaultOutcome;
  cancelImport(): void;
  /** Seals, stores, reads back and verifies one prepared package. A save is not an approval or a receipt. */
  saveFrozenReview(
    matterId: string,
    source: FrozenCaptureSource,
  ): Promise<VaultOutcome<{ commitment: string }>>;
  retryPendingCapture(commitment: string): Promise<VaultOutcome<{ commitment: string }>>;
  verifyStoredCapture(matterId: string, commitment: string): Promise<VaultOutcome>;
  noteInteraction(): void;
}

export interface VaultHandle {
  readonly available: boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => VaultSnapshot;
  readonly commands: VaultCommands;
  /** Whether this capture was read back and verified in the current unlock. Not an approval or a receipt. */
  hasVerifiedCapture(commitment: string): boolean;
  /** The verified capture and its public reference, only for the approval gate. Null unless verified in this unlock. */
  recoverableSubject(commitment: string): {
    capture: RecoverableCapture;
    reference: ReceiptReferenceV1;
    supersedes: ReceiptReferenceV1 | null;
    artifacts: readonly { id: string; role: string; byteLength: string }[];
    scopeArtifactIds: readonly string[];
    decisionLogBytes: Uint8Array | null;
  } | null;
  /** For the Aegis runtime (Chapter 9), after its own disclosure step. Confirmed entries only; never truncated. */
  selectContext: ReturnType<typeof contextFor>;
  dispose(): void;
}

const contextFor =
  (controller: VaultController) => (matterId: string, entryIds: readonly string[]) =>
    selectMatterContext(controller, matterId, entryIds);

function inertVault(): VaultHandle {
  const unavailable = <T>(): Promise<VaultOutcome<T>> =>
    Promise.resolve({ ok: false, failure: 'STORAGE_UNAVAILABLE' });
  const none: VaultOutcome<never> = { ok: false, failure: 'STORAGE_UNAVAILABLE' };
  return {
    available: false,
    subscribe: () => () => undefined,
    getSnapshot: () => EMPTY_VAULT_SNAPSHOT,
    commands: {
      createVault: unavailable,
      unlock: unavailable,
      recover: () => Promise.resolve({ ok: false, step: 'vault', failure: 'STORAGE_UNAVAILABLE' }),
      lock: () => undefined,
      refreshDiscovery: unavailable,
      reload: unavailable,
      reconcile: unavailable,
      reapplyConflictDraft: unavailable,
      selectMatter: () => undefined,
      createMatter: unavailable,
      saveMatter: unavailable,
      discardDraft: () => undefined,
      addSourceFile: unavailable,
      readSource: unavailable,
      addEntry: () => none,
      correctEntry: () => none,
      confirmEntry: () => none,
      removeEntry: () => none,
      prepareExport: unavailable,
      confirmExport: () => none,
      cancelExport: () => undefined,
      previewImport: unavailable,
      confirmReviewImport: unavailable,
      confirmContextImport: () => none,
      cancelImport: () => undefined,
      saveFrozenReview: unavailable,
      retryPendingCapture: unavailable,
      verifyStoredCapture: unavailable,
      noteInteraction: () => undefined,
    },
    hasVerifiedCapture: () => false,
    recoverableSubject: () => null,
    selectContext: () => ({ ok: false, code: 'KEY_UNAVAILABLE' }),
    dispose: () => undefined,
  };
}

export interface Workspace {
  readonly account: AccountHandle;
  readonly vault: VaultHandle;
}

/** Builds the account and the vault together, wired through the single trusted PRF consumer. */
export function createBrowserWorkspace(publicConfig: PublicConfig): Workspace {
  const sink = new KeySink();
  const config: { rpId: string | null } = { rpId: null };
  const account = createBrowserAccount(publicConfig, {
    vaultConsumer: sink.consume,
    onConfig: (resolved) => {
      config.rpId = resolved.rpId;
    },
  });
  const rpId = config.rpId;
  if (account.availability !== 'available' || rpId === null)
    return { account, vault: inertVault() };

  const controller = new VaultController({
    rpId,
    account: {
      snapshot: () => account.getSnapshot(),
      unlockVault: () => account.commands.unlockVault(),
      onLock: (listener) => account.onLock(listener),
    },
    sink,
    transport: createVaultTransport(),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  });

  // Discovery is preloaded as soon as the backend sign-in exists, so the unlock gesture starts
  // its passkey ceremony directly, with no unrelated network wait first.
  let lastBackend: AccountSnapshot['backend']['state'] = account.getSnapshot().backend.state;
  const unsubscribeAccount = account.subscribe(() => {
    const now = account.getSnapshot().backend.state;
    if (now !== lastBackend) {
      lastBackend = now;
      if (now === 'signed_in') void controller.refreshDiscovery();
      else controller.lock('sign_out');
    }
  });
  if (lastBackend === 'signed_in') void controller.refreshDiscovery();

  const onHide = () => controller.lock('page_hidden');
  const onShow = (event: PageTransitionEvent) => {
    if (event.persisted) controller.lock('page_hidden');
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  const timer = window.setInterval(() => controller.tick(), 1000);

  const handle: VaultHandle = {
    available: true,
    subscribe: (listener) => controller.subscribe(listener),
    getSnapshot: () => controller.getSnapshot(),
    commands: {
      createVault: () => controller.createVault(),
      unlock: () => controller.unlock(),
      recover: () =>
        recoverVaultFromEmptyStorage(
          { recover: () => account.commands.recover(), snapshot: () => account.getSnapshot() },
          controller,
        ),
      lock: () => controller.lock('user'),
      refreshDiscovery: () => controller.refreshDiscovery(),
      reload: () => controller.reload(),
      reconcile: () => controller.reconcile(),
      reapplyConflictDraft: () => controller.reapplyConflictDraft(),
      selectMatter: (id) => controller.selectMatter(id),
      createMatter: (title) => controller.createMatter(title),
      saveMatter: (id) => controller.saveMatter(id),
      discardDraft: (id) => controller.discardDraft(id),
      addSourceFile: (id, file) => controller.addSourceFile(id, file),
      readSource: (id, versionId) => controller.readSource(id, versionId),
      addEntry: (id, input) => controller.addEntry(id, input),
      correctEntry: (id, entryId, text) => controller.correctEntry(id, entryId, text),
      confirmEntry: (id, entryId) => controller.confirmEntry(id, entryId),
      removeEntry: (id, entryId) => controller.removeEntry(id, entryId),
      prepareExport: (kind, id, commitment) => controller.prepareExport(kind, id, commitment),
      confirmExport: (id) => controller.confirmExport(id),
      cancelExport: () => controller.cancelExport(),
      previewImport: (bytes) => controller.previewImport(bytes),
      confirmReviewImport: (importId, matterId) =>
        controller.confirmReviewImport(importId, matterId),
      confirmContextImport: (importId, matterId, ids) =>
        controller.confirmContextImport(importId, matterId, ids),
      cancelImport: () => controller.cancelImport(),
      saveFrozenReview: (matterId, source) => controller.saveFrozenReview(matterId, source),
      retryPendingCapture: (commitment) => controller.retryPendingCapture(commitment),
      verifyStoredCapture: (matterId, commitment) =>
        controller.verifyStoredCapture(matterId, commitment),
      noteInteraction: () => controller.noteInteraction(),
    },
    hasVerifiedCapture: (commitment) => controller.recoverableCapture(commitment) !== null,
    recoverableSubject: (commitment) => controller.recoverableSubject(commitment),
    selectContext: contextFor(controller),
    dispose: () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      unsubscribeAccount();
      controller.dispose();
    },
  };
  return { account, vault: handle };
}

export type { VaultFailure as VaultFailureCode };
export const guidanceFor = describeVaultFailure;
