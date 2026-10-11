import {
  PreparedReviewPackage,
  artifactDigest,
  receiptReferenceV1Schema,
  type ReceiptReferenceV1,
} from '@lexaegis/protocol/v1';
import {
  CONTEXT_EXPORT_SCHEMA,
  ENCRYPTED_EXPORT_SCHEMA,
  REVIEW_EXPORT_SCHEMA,
  type RecoverableCapture,
  VerifiedReview,
  type VaultKeys,
  addFrozenReview,
  addSource,
  buildContextExport,
  buildEncryptedReviewExport,
  buildReadableReviewExport,
  emptyCatalog,
  encodeJcs,
  exportFileName,
  importContextEntries,
  isRegression,
  matterRecordSchema,
  newMatter,
  nextCatalog,
  openCatalog,
  parseContextExport,
  parseEncryptedReviewExport,
  parseJsonBytes,
  parseReadableReviewExport,
  sealCatalog,
  sealFrozenReview,
  verifyFrozenReview,
  vaultDescriptorSchema,
  type FrozenCaptureSource,
  type MatterContextExportV1,
  type MatterRecordV1,
  type ReviewImportPreview,
  type SealedObject,
  type VaultBinding,
  type VaultCatalogV1,
  type VaultDescriptorV1,
  type VaultHeadV1,
  type VaultObjectRefV1,
  type VaultResult,
  VAULT_LIMITS,
  ACCOUNT_PROFILE_ID,
  CRYPTO_PROFILE,
  DESCRIPTOR_SCHEMA,
} from '@lexaegis/vault';
import type { AccountSnapshot, AccountResult, LockReason } from '@/features/account/public';
import {
  editAddEntry,
  editConfirmEntry,
  editCorrectEntry,
  editRemoveEntry,
} from '@/features/matters/edits';
import type { VaultView } from '@/lib/vault-schema';
import type { KeySink } from './key-sink';
import type { TransportFailure, TransportResult, VaultTransport } from './transport';

/*
 * Tab-local, memory-only vault controller. Keys are a non-extractable handle held in a private
 * field; decrypted data lives only in private maps and is cleared on every lock. Public state is
 * a frozen snapshot. The assistant can read a snapshot; it cannot unlock, obtain keys, confirm a
 * disclosure, persist a fact or approve a review.
 *
 * Vault state is kept separate from backend sign-in, the signing session and any receipt: it
 * never creates or extends a signing session or renews a login.
 */

export const VAULT_ABSOLUTE_LIMIT_MS = 10 * 60_000;
export const VAULT_IDLE_LIMIT_MS = 5 * 60_000;

export type VaultState =
  'unavailable' | 'locked' | 'unlocking' | 'unlocked' | 'saving' | 'recovering' | 'error';

export type VaultFailure =
  | 'STORAGE_UNAVAILABLE'
  | 'NOT_SIGNED_IN'
  | 'NO_VAULT'
  | 'VAULT_EXISTS'
  | 'PRF_UNSUPPORTED'
  | 'CANCELLED'
  | 'WRONG_CREDENTIAL'
  | 'ACCOUNT_MISMATCH'
  | 'UNSUPPORTED_FORMAT'
  | 'MISSING_OBJECTS'
  | 'INTEGRITY_FAILED'
  | 'ROLLBACK_DETECTED'
  | 'CONFLICT'
  | 'QUOTA'
  | 'TOO_LARGE'
  | 'UNKNOWN_OUTCOME'
  | 'LOCKED'
  | 'EXPIRED'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'BUSY'
  | 'STALE';

export type VaultOutcome<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly failure: VaultFailure };
const good = <T>(data: T): VaultOutcome<T> => ({ ok: true, data });
const bad = (failure: VaultFailure): VaultOutcome<never> => ({ ok: false, failure });

export type SaveState = 'idle' | 'saving' | 'saved' | 'unsaved' | 'conflict' | 'unknown_outcome';
export type VaultProgress =
  'awaiting_passkey' | 'unlocking' | 'saving_files' | 'checking_package' | 'recovery_failed' | null;

export interface MatterSummary {
  readonly matterId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly sourceCount: number;
  readonly frozenCount: number;
  readonly unsaved: boolean;
}

export interface ExportPreview {
  readonly exportId: string;
  readonly kind: 'encrypted-review' | 'readable-review' | 'context';
  readonly fileName: string;
  /** Plain-language statement of what the file exposes. */
  readonly disclosure: string;
  readonly items: readonly { readonly label: string; readonly bytes: number }[];
  readonly discloses: boolean;
}

export interface ImportPreview {
  readonly importId: string;
  readonly kind: 'readable-review' | 'encrypted-review' | 'context';
  readonly review: ReviewImportPreview | null;
  readonly context: {
    readonly matterId: string;
    readonly entries: readonly {
      entryId: string;
      kind: string;
      text: string;
      unresolvedReferences: number;
    }[];
  } | null;
}

export interface VaultSnapshot {
  readonly generation: number;
  readonly state: VaultState;
  readonly discovery: 'unknown' | 'absent' | 'present' | 'unavailable';
  readonly save: SaveState;
  readonly progress: VaultProgress;
  readonly failure: VaultFailure | null;
  readonly headRevision: string | null;
  readonly matters: readonly MatterSummary[];
  readonly selectedMatterId: string | null;
  /** The decrypted record being edited (draft if any). Present only while unlocked. */
  readonly selectedMatter: MatterRecordV1 | null;
  readonly conflictDraftMatterId: string | null;
  /** Captures that were read back and verified in this unlock. A label, never an approval or a receipt. */
  readonly checkedCaptures: readonly { readonly commitment: string; readonly packageId: string }[];
  readonly pendingCaptureCommitments: readonly string[];
  readonly exportPreview: ExportPreview | null;
  readonly importPreview: ImportPreview | null;
  readonly expiresAt: number | null;
  readonly idleExpiresAt: number | null;
}

export interface VaultDependencies {
  readonly rpId: string;
  readonly account: {
    snapshot(): AccountSnapshot;
    unlockVault(): Promise<AccountResult<null>>;
    onLock(listener: (reason: LockReason) => void): () => void;
  };
  readonly sink: KeySink;
  readonly transport: VaultTransport;
  readonly now: () => number;
  readonly newId: () => string;
}

interface Loaded {
  readonly head: VaultHeadV1;
  readonly catalog: VaultCatalogV1;
  readonly matters: Map<string, { record: MatterRecordV1; ref: VaultObjectRefV1 }>;
}

interface PendingCommit {
  readonly matterId: string;
  readonly record: MatterRecordV1;
  readonly objects: readonly SealedObject[];
  readonly expectedRevision: string;
  readonly catalog: VaultCatalogV1;
  readonly catalogRef: VaultObjectRefV1;
  readonly matterRef: VaultObjectRefV1;
}

interface PendingCapture {
  readonly source: FrozenCaptureSource;
  readonly matterId: string;
  readonly sealed: Awaited<ReturnType<typeof sealFrozenReview>> & { ok: true };
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isoNow = (ms: number) => new Date(ms).toISOString();
const NETWORK_UNCERTAIN: ReadonlySet<TransportFailure> = new Set(['NETWORK', 'UNCERTAIN']);

function failureOfTransport(code: TransportFailure): VaultFailure {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 'NOT_SIGNED_IN';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'QUOTA':
      return 'QUOTA';
    case 'TOO_LARGE':
      return 'TOO_LARGE';
    case 'INVALID':
    case 'MALFORMED':
      return 'INVALID';
    case 'MISSING':
      return 'MISSING_OBJECTS';
    case 'CORRUPT':
      return 'INTEGRITY_FAILED';
    default:
      return 'STORAGE_UNAVAILABLE';
  }
}

function failureOfVault(code: string): VaultFailure {
  switch (code) {
    case 'MISSING_OBJECT':
      return 'MISSING_OBJECTS';
    case 'TOO_LARGE':
      return 'TOO_LARGE';
    case 'QUOTA':
      return 'QUOTA';
    case 'UNSUPPORTED_VERSION':
    case 'ENVELOPE_INVALID':
    case 'BUNDLE_INVALID':
      return 'UNSUPPORTED_FORMAT';
    case 'KEY_UNAVAILABLE':
      return 'LOCKED';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'INVALID_INPUT':
      return 'INVALID';
    default:
      return 'INTEGRITY_FAILED';
  }
}

function failureOfAccount(code: string): VaultFailure {
  switch (code) {
    case 'PRF_UNAVAILABLE':
    case 'UNSUPPORTED':
      return 'PRF_UNSUPPORTED';
    case 'CANCELLED':
    case 'NOT_COMPLETED':
      return 'CANCELLED';
    case 'WRONG_CREDENTIAL':
      return 'WRONG_CREDENTIAL';
    case 'SESSION_LOCKED':
    case 'SESSION_EXPIRED':
      return 'LOCKED';
    case 'BUSY':
      return 'BUSY';
    case 'STALE':
      return 'STALE';
    default:
      return 'INVALID';
  }
}

export class VaultController {
  readonly #deps: VaultDependencies;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeLock: () => void;

  #keys: VaultKeys | null = null;
  #binding: VaultBinding | null = null;
  #generation = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #startedAt = 0;
  #lastInteractionAt = 0;
  #lastNow = 0;

  #view: VaultView | null = null;
  #discovery: VaultSnapshot['discovery'] = 'unknown';
  #loaded: Loaded | null = null;
  #catalogRef: VaultObjectRefV1 | null = null;
  #observedRevision: string | null = null;
  #drafts = new Map<string, MatterRecordV1>();
  #conflictDraft: string | null = null;
  #pending: PendingCommit | null = null;
  #pendingCaptures = new Map<string, PendingCapture>();
  #captures = new Map<string, RecoverableCapture>();
  #selected: string | null = null;
  #export: { id: string; bytes: Uint8Array; fileName: string; preview: ExportPreview } | null =
    null;
  #import: {
    id: string;
    review: VerifiedReview | null;
    context: MatterContextExportV1 | null;
    preview: ImportPreview;
  } | null = null;
  #snapshot: VaultSnapshot;
  #state: VaultState = 'locked';
  #save: SaveState = 'idle';
  #progress: VaultProgress = null;
  #failure: VaultFailure | null = null;

  constructor(deps: VaultDependencies) {
    this.#deps = deps;
    this.#lastNow = deps.now();
    this.#snapshot = this.#build();
    // Any loss of local signing authority also clears the vault, in the same step.
    this.#unsubscribeLock = deps.account.onLock((reason) => this.lock(reason));
  }

  // ---- Store --------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getSnapshot = (): VaultSnapshot => this.#snapshot;

  #build(): VaultSnapshot {
    const unlocked = this.#keys !== null;
    const matters: MatterSummary[] = [];
    if (unlocked && this.#loaded !== null) {
      for (const [matterId, entry] of this.#loaded.matters) {
        const record = this.#drafts.get(matterId) ?? entry.record;
        matters.push({
          matterId,
          title: record.title,
          updatedAt: record.updatedAt,
          sourceCount: record.sources.length,
          frozenCount: record.frozenReviews.length,
          unsaved: this.#drafts.has(matterId),
        });
      }
      for (const [matterId, draft] of this.#drafts) {
        if (!this.#loaded.matters.has(matterId)) {
          matters.push({
            matterId,
            title: draft.title,
            updatedAt: draft.updatedAt,
            sourceCount: draft.sources.length,
            frozenCount: draft.frozenReviews.length,
            unsaved: true,
          });
        }
      }
    }
    const selected =
      unlocked && this.#selected !== null
        ? (this.#drafts.get(this.#selected) ??
          this.#loaded?.matters.get(this.#selected)?.record ??
          null)
        : null;
    const frozen = (value: unknown) => Object.freeze(value);
    return Object.freeze({
      generation: this.#generation,
      state: this.#state,
      discovery: this.#discovery,
      save: this.#save,
      progress: this.#progress,
      failure: this.#failure,
      headRevision: unlocked ? (this.#loaded?.head.revision ?? null) : null,
      matters: frozen(matters) as readonly MatterSummary[],
      selectedMatterId: unlocked ? this.#selected : null,
      selectedMatter: selected,
      conflictDraftMatterId: unlocked ? this.#conflictDraft : null,
      checkedCaptures: frozen(
        unlocked
          ? [...this.#captures.values()]
              .filter((c) => c.generation === this.#generation)
              .map((c) => ({
                commitment: c.commitment,
                packageId: this.#packageIds.get(c.commitment) ?? '',
              }))
          : [],
      ) as VaultSnapshot['checkedCaptures'],
      pendingCaptureCommitments: frozen(
        unlocked ? [...this.#pendingCaptures.keys()] : [],
      ) as readonly string[],
      exportPreview: unlocked ? (this.#export?.preview ?? null) : null,
      importPreview: unlocked ? (this.#import?.preview ?? null) : null,
      expiresAt: unlocked ? this.#startedAt + VAULT_ABSOLUTE_LIMIT_MS : null,
      idleExpiresAt: unlocked ? this.#lastInteractionAt + VAULT_IDLE_LIMIT_MS : null,
    });
  }
  readonly #packageIds = new Map<string, string>();
  /** Public reference of each capture verified in this unlock, from the verified manifest context. */
  readonly #references = new Map<
    string,
    {
      reference: ReceiptReferenceV1;
      supersedes: ReceiptReferenceV1 | null;
      /** Roles and sizes of the verified manifest, and the exact decision-log bytes it commits to. */
      artifacts: readonly { id: string; role: string; byteLength: string }[];
      scopeArtifactIds: readonly string[];
      decisionLogBytes: Uint8Array | null;
    }
  >();

  #publish(): void {
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }

  #set(patch: {
    state?: VaultState;
    save?: SaveState;
    progress?: VaultProgress;
    failure?: VaultFailure | null;
  }): void {
    if (patch.state !== undefined) this.#state = patch.state;
    if (patch.save !== undefined) this.#save = patch.save;
    if (patch.progress !== undefined) this.#progress = patch.progress;
    if (patch.failure !== undefined) this.#failure = patch.failure;
    this.#publish();
  }

  // ---- Lifetime -----------------------------------------------------------------------------------

  #liveness(): VaultFailure | null {
    if (this.#keys === null) return 'LOCKED';
    const now = this.#deps.now();
    const rolledBack = now + 2_000 < this.#lastNow;
    this.#lastNow = Math.max(this.#lastNow, now);
    if (
      rolledBack ||
      now - this.#startedAt >= VAULT_ABSOLUTE_LIMIT_MS ||
      now - this.#lastInteractionAt >= VAULT_IDLE_LIMIT_MS
    ) {
      this.lock('expired');
      return 'EXPIRED';
    }
    return null;
  }

  /** Re-evaluates the limits. Never extends them. */
  tick(): void {
    if (this.#keys !== null) this.#liveness();
  }

  /** A deliberate user interaction. Polling and background work must never call this. */
  noteInteraction(): void {
    if (this.#keys === null || this.#liveness() !== null) return;
    this.#lastInteractionAt = this.#deps.now();
    this.#publish();
  }

  /**
   * Releases the key, plaintext, decrypted caches, previews, pending exports and imports, and
   * every verified-capture gate. It cannot undo a remote write that already committed, and it
   * cannot recall plaintext already sent anywhere.
   */
  lock(_reason: LockReason | 'expired' = 'user'): void {
    this.#keys?.dispose();
    this.#keys = null;
    this.#binding = null;
    this.#deps.sink.clear();
    this.#generation += 1;
    this.#loaded = null;
    this.#catalogRef = null;
    this.#drafts = new Map();
    this.#conflictDraft = null;
    this.#pending = null;
    this.#pendingCaptures = new Map();
    this.#captures = new Map();
    this.#packageIds.clear();
    this.#references.clear();
    this.#selected = null;
    if (this.#export !== null) this.#export.bytes.fill(0);
    this.#export = null;
    this.#import = null;
    this.#state = 'locked';
    this.#save = 'idle';
    this.#progress = null;
    this.#publish();
  }

  dispose(): void {
    this.lock('page_hidden');
    this.#unsubscribeLock();
    this.#listeners.clear();
  }

  #serialized<T>(
    generation: number,
    operation: (keys: VaultKeys, binding: VaultBinding) => Promise<T>,
  ): Promise<VaultOutcome<T>> {
    const run = async (): Promise<VaultOutcome<T>> => {
      const before = this.#liveness();
      if (before !== null) return bad(before);
      const keys = this.#keys;
      const binding = this.#binding;
      if (keys === null || binding === null || generation !== this.#generation)
        return bad('LOCKED');
      let result: T;
      try {
        result = await operation(keys, binding);
      } catch {
        return bad(this.#keys === keys ? 'STORAGE_UNAVAILABLE' : 'LOCKED');
      }
      // A lock or expiry during the wait means nothing decrypted is released.
      if (generation !== this.#generation || this.#keys !== keys) return bad('LOCKED');
      const after = this.#liveness();
      if (after !== null) return bad(after);
      return good(result);
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  // ---- Discovery ----------------------------------------------------------------------------------

  /** Reads the account's descriptor and head. Safe before any gesture. An outage is never "no vault". */
  async refreshDiscovery(): Promise<VaultOutcome<VaultSnapshot['discovery']>> {
    const account = this.#deps.account.snapshot();
    if (account.backend.state !== 'signed_in') {
      this.#discovery = 'unknown';
      this.#publish();
      return bad('NOT_SIGNED_IN');
    }
    const result = await this.#deps.transport.discover();
    if (!result.ok) {
      this.#discovery = 'unavailable';
      this.#publish();
      return bad(failureOfTransport(result.code));
    }
    this.#view = result.data;
    this.#discovery = result.data === null ? 'absent' : 'present';
    this.#publish();
    return good(this.#discovery);
  }

  // ---- Unlock, create, recover --------------------------------------------------------------------

  /** Evaluates the vault salt on the verified credential and opens the catalog and matter records. */
  async unlock(): Promise<VaultOutcome> {
    return this.#open(false);
  }

  /** Same as unlock, but shown as recovery and with separate failure reporting. */
  async recover(): Promise<VaultOutcome> {
    return this.#open(true);
  }

  async #ceremony(): Promise<VaultOutcome<VaultKeys>> {
    const account = this.#deps.account.snapshot();
    if (account.account === null || !account.account.verifiedThisSession) return bad('LOCKED');
    if (account.backend.state !== 'signed_in') return bad('NOT_SIGNED_IN');
    this.#deps.sink.clear();
    const generation = this.#generation;
    const result = await this.#deps.account.unlockVault();
    if (generation !== this.#generation) {
      this.#deps.sink.clear();
      return bad('STALE');
    }
    if (!result.ok) return bad(failureOfAccount(result.code));
    const keys = this.#deps.sink.take();
    return keys === null ? bad('INVALID') : good(keys);
  }

  async #open(recovering: boolean): Promise<VaultOutcome> {
    if (this.#state === 'unlocking' || this.#state === 'recovering' || this.#state === 'saving')
      return bad('BUSY');
    if (this.#keys !== null) return good(null);
    if (this.#discovery === 'unknown' || this.#discovery === 'unavailable') {
      const found = await this.refreshDiscovery();
      if (!found.ok) {
        this.#set({
          state: 'error',
          progress: recovering ? 'recovery_failed' : null,
          failure: found.failure,
        });
        return found;
      }
    }
    const view = this.#view;
    if (view === null) {
      this.#set({
        state: 'error',
        failure: 'NO_VAULT',
        progress: recovering ? 'recovery_failed' : null,
      });
      return bad('NO_VAULT');
    }
    const account = this.#deps.account.snapshot().account;
    // A descriptor or a cached address never establishes ownership: it must match the live account.
    if (
      account === null ||
      view.descriptor.ownerAddress !== account.address ||
      view.descriptor.rpId !== this.#deps.rpId
    ) {
      this.#set({ state: 'error', failure: 'ACCOUNT_MISMATCH' });
      return bad('ACCOUNT_MISMATCH');
    }

    const generation = this.#generation;
    this.#set({
      state: recovering ? 'recovering' : 'unlocking',
      progress: 'awaiting_passkey',
      failure: null,
    });
    const keyed = await this.#ceremony();
    if (!keyed.ok) {
      this.#set({
        state: 'error',
        progress: recovering ? 'recovery_failed' : null,
        failure: keyed.failure,
      });
      return keyed;
    }
    if (generation !== this.#generation) {
      keyed.data.dispose();
      return bad('STALE');
    }
    this.#set({ progress: 'unlocking' });
    const binding: VaultBinding = {
      vaultId: view.descriptor.vaultId,
      ownerAddress: view.descriptor.ownerAddress,
      rpId: view.descriptor.rpId,
    };
    const loaded = await this.#loadRemote(keyed.data, binding);
    if (!loaded.ok || generation !== this.#generation) {
      keyed.data.dispose();
      const failure = loaded.ok ? 'STALE' : loaded.failure;
      this.#set({ state: 'error', progress: recovering ? 'recovery_failed' : null, failure });
      return bad(failure);
    }
    const now = this.#deps.now();
    this.#keys = keyed.data;
    this.#binding = binding;
    this.#startedAt = now;
    this.#lastInteractionAt = now;
    this.#applyLoaded(loaded.data.loaded, loaded.data.catalogRef);
    this.#set({ state: 'unlocked', progress: null, failure: null, save: 'idle' });
    return good(null);
  }

  /** Explicit "Create vault": requires a fresh absence check, then creates and never replaces. */
  async createVault(): Promise<VaultOutcome> {
    if (this.#state === 'unlocking' || this.#state === 'recovering' || this.#state === 'saving')
      return bad('BUSY');
    if (this.#keys !== null) return bad('VAULT_EXISTS');
    const fresh = await this.#deps.transport.discover();
    if (!fresh.ok) {
      this.#discovery = 'unavailable';
      this.#set({ state: 'error', failure: failureOfTransport(fresh.code) });
      return bad(failureOfTransport(fresh.code));
    }
    if (fresh.data !== null) {
      // Someone (maybe another device) already has one: recover, never replace.
      this.#view = fresh.data;
      this.#discovery = 'present';
      this.#set({ state: 'error', failure: 'VAULT_EXISTS' });
      return bad('VAULT_EXISTS');
    }
    const account = this.#deps.account.snapshot().account;
    if (account === null) return bad('LOCKED');

    const generation = this.#generation;
    this.#set({ state: 'unlocking', progress: 'awaiting_passkey', failure: null });
    const keyed = await this.#ceremony();
    if (!keyed.ok) {
      this.#set({ state: 'error', progress: null, failure: keyed.failure });
      return keyed;
    }
    if (generation !== this.#generation) {
      keyed.data.dispose();
      return bad('STALE');
    }
    const vaultId = this.#deps.newId();
    const binding: VaultBinding = { vaultId, ownerAddress: account.address, rpId: this.#deps.rpId };
    const descriptor: VaultDescriptorV1 = vaultDescriptorSchema.parse({
      schema: DESCRIPTOR_SCHEMA,
      vaultId,
      ownerAddress: account.address,
      rpId: this.#deps.rpId,
      accountProfileId: ACCOUNT_PROFILE_ID,
      cryptoProfileId: CRYPTO_PROFILE,
    });
    const sealed = await sealCatalog(keyed.data, binding, emptyCatalog(vaultId));
    if (!sealed.ok) {
      keyed.data.dispose();
      this.#set({ state: 'error', failure: failureOfVault(sealed.code) });
      return bad(failureOfVault(sealed.code));
    }
    this.#set({ progress: 'saving_files' });
    let created = await this.#deps.transport.create(descriptor, sealed.data.bytes);
    if (!created.ok && NETWORK_UNCERTAIN.has(created.code)) {
      // The create may have committed. Look, instead of guessing or creating again.
      const look = await this.#deps.transport.discover();
      if (
        look.ok &&
        look.data?.descriptor.vaultId === vaultId &&
        look.data.head.catalog.objectId === sealed.data.ref.objectId
      ) {
        created = { ok: true, data: look.data };
      } else if (look.ok && look.data !== null) {
        keyed.data.dispose();
        this.#view = look.data;
        this.#discovery = 'present';
        this.#set({ state: 'error', progress: null, failure: 'VAULT_EXISTS' });
        return bad('VAULT_EXISTS');
      } else {
        keyed.data.dispose();
        this.#set({ state: 'error', progress: null, failure: 'UNKNOWN_OUTCOME' });
        return bad('UNKNOWN_OUTCOME');
      }
    }
    if (!created.ok) {
      keyed.data.dispose();
      const failure =
        created.code === 'CONFLICT' ? 'VAULT_EXISTS' : failureOfTransport(created.code);
      if (failure === 'VAULT_EXISTS') this.#discovery = 'unknown';
      this.#set({ state: 'error', progress: null, failure });
      return bad(failure);
    }
    if (generation !== this.#generation) {
      keyed.data.dispose();
      return bad('STALE');
    }
    const now = this.#deps.now();
    this.#keys = keyed.data;
    this.#binding = binding;
    this.#startedAt = now;
    this.#lastInteractionAt = now;
    this.#view = created.data;
    this.#discovery = 'present';
    this.#applyLoaded(
      { head: created.data.head, catalog: emptyCatalog(vaultId), matters: new Map() },
      sealed.data.ref,
    );
    this.#set({ state: 'unlocked', progress: null, failure: null, save: 'saved' });
    return good(null);
  }

  /** Fetches the head and decrypts the catalog and every matter record (small, structured objects only). */
  async #loadRemote(
    keys: VaultKeys,
    binding: VaultBinding,
  ): Promise<VaultOutcome<{ loaded: Loaded; catalogRef: VaultObjectRefV1 }>> {
    const { transport } = this.#deps;
    const head = await transport.getHead(binding.vaultId);
    if (!head.ok)
      return bad(head.code === 'NOT_FOUND' ? 'NO_VAULT' : failureOfTransport(head.code));
    if (isRegression(this.#observedRevision, head.data.revision)) return bad('ROLLBACK_DETECTED');
    const wire = await transport.getObject(binding.vaultId, head.data.catalog.objectId);
    if (!wire.ok) return bad(failureOfTransport(wire.code));
    const catalog = await openCatalog(keys, binding, wire.data, {
      ref: head.data.catalog,
      revision: head.data.revision,
    });
    if (!catalog.ok) return bad(failureOfVault(catalog.code));

    const matters = new Map<string, { record: MatterRecordV1; ref: VaultObjectRefV1 }>();
    for (const entry of catalog.data.matters) {
      const object = await transport.getObject(binding.vaultId, entry.matter.objectId);
      if (!object.ok) return bad(failureOfTransport(object.code));
      const plain = await keys.decrypt(
        object.data,
        { ...binding, ref: entry.matter },
        'structured',
      );
      if (!plain.ok) return bad(failureOfVault(plain.code));
      const json = parseJsonBytes(plain.data, VAULT_LIMITS.maxStructuredBytes);
      plain.data.fill(0);
      const record = json.ok ? matterRecordSchema.safeParse(json.data) : null;
      if (record === null || !record.success || record.data.matterId !== entry.matterId)
        return bad('INTEGRITY_FAILED');
      matters.set(entry.matterId, { record: record.data, ref: entry.matter });
    }
    return good({
      loaded: { head: head.data, catalog: catalog.data, matters },
      catalogRef: head.data.catalog,
    });
  }

  #applyLoaded(loaded: Loaded, catalogRef: VaultObjectRefV1): void {
    this.#loaded = loaded;
    this.#catalogRef = catalogRef;
    this.#observedRevision =
      this.#observedRevision === null ||
      BigInt(loaded.head.revision) > BigInt(this.#observedRevision)
        ? loaded.head.revision
        : this.#observedRevision;
    if (
      this.#selected !== null &&
      !loaded.matters.has(this.#selected) &&
      !this.#drafts.has(this.#selected)
    )
      this.#selected = null;
  }

  /** Re-reads the authoritative head and state, keeping local drafts. */
  async reload(): Promise<VaultOutcome> {
    const loaded = await this.#serialized(this.#generation, (keys, binding) =>
      this.#loadRemote(keys, binding),
    );
    if (!loaded.ok) return loaded;
    if (!loaded.data.ok) return bad(loaded.data.failure);
    this.#applyLoaded(loaded.data.data.loaded, loaded.data.data.catalogRef);
    this.#pending = null;
    this.#set({ save: this.#drafts.size > 0 ? 'unsaved' : 'saved' });
    return good(null);
  }

  // ---- Selection and editing (all local until saved) ----------------------------------------------

  selectMatter(matterId: string | null): void {
    if (this.#keys === null) return;
    this.#selected = matterId;
    this.#publish();
  }

  #working(matterId: string): MatterRecordV1 | null {
    return this.#drafts.get(matterId) ?? this.#loaded?.matters.get(matterId)?.record ?? null;
  }

  /** Applies a pure edit (add, correct, confirm, remove an entry, ...) to a local draft. Nothing is stored until saveMatter. */
  editMatter(
    matterId: string,
    edit: (record: MatterRecordV1) => VaultResult<MatterRecordV1>,
  ): VaultOutcome {
    const failure = this.#liveness();
    if (failure !== null) return bad(failure);
    const base = this.#working(matterId);
    if (base === null) return bad('NOT_FOUND');
    const next = edit(base);
    if (!next.ok) return bad(failureOfVault(next.code));
    this.#drafts.set(matterId, next.data);
    this.#set({ save: 'unsaved', failure: null });
    return good(null);
  }

  #env() {
    return { now: () => isoNow(this.#deps.now()), newId: this.#deps.newId };
  }

  /** Adds a fact, note or outcome to a local draft. Only the user's own entry can start confirmed. */
  addEntry(
    matterId: string,
    input: {
      kind: 'fact' | 'note' | 'outcome';
      text: string;
      confirmed: boolean;
      documentVersionId?: string;
      origin?: 'user' | 'model_proposed';
    },
  ): VaultOutcome {
    return this.editMatter(
      matterId,
      editAddEntry(this.#env(), {
        kind: input.kind,
        text: input.text,
        confirmed: input.confirmed,
        ...(input.origin !== undefined && { origin: input.origin }),
        ...(input.documentVersionId !== undefined && {
          sourceRefs: [{ documentVersionId: input.documentVersionId, anchor: null }],
        }),
      }),
    );
  }

  /** A correction is a new unconfirmed revision. */
  correctEntry(matterId: string, entryId: string, text: string): VaultOutcome {
    return this.editMatter(matterId, editCorrectEntry(this.#env(), entryId, text));
  }

  confirmEntry(matterId: string, entryId: string): VaultOutcome {
    return this.editMatter(matterId, editConfirmEntry(this.#env(), entryId));
  }

  /** Removes working context only. Frozen reviews, exports and retained storage copies are unaffected. */
  removeEntry(matterId: string, entryId: string): VaultOutcome {
    return this.editMatter(matterId, editRemoveEntry(this.#env(), entryId));
  }

  discardDraft(matterId: string): void {
    this.#drafts.delete(matterId);
    if (this.#conflictDraft === matterId) this.#conflictDraft = null;
    this.#set({ save: this.#drafts.size > 0 ? 'unsaved' : 'idle' });
  }

  /** The current working copy of a matter, for building a deliberate context selection. */
  workingMatter(matterId: string): MatterRecordV1 | null {
    return this.#keys === null ? null : this.#working(matterId);
  }

  createMatter(title: string): Promise<VaultOutcome<string>> {
    const generation = this.#generation;
    const record = newMatter(this.#deps.newId(), title.trim(), isoNow(this.#deps.now()));
    if (!record.ok) return Promise.resolve(bad('INVALID'));
    const matterId = record.data.matterId;
    this.#drafts.set(matterId, record.data);
    this.#publish();
    return this.#commit(generation, matterId, []).then((result) => {
      if (result.ok) {
        this.#selected = matterId;
        this.#publish();
        return good(matterId);
      }
      // A matter that could not be stored is not kept as a phantom draft.
      if (result.failure === 'QUOTA' || result.failure === 'INVALID') this.#drafts.delete(matterId);
      this.#publish();
      return result;
    });
  }

  /** Saves the working copy of one matter with copy-on-write and an atomic head update. */
  saveMatter(matterId: string): Promise<VaultOutcome> {
    return this.#commit(this.#generation, matterId, []);
  }

  /** Stores an original file as an immutable encrypted object and records it as a new source version. */
  async addSourceFile(
    matterId: string,
    file: {
      bytes: Uint8Array;
      mediaType: string;
      label: string;
      documentId?: string;
      /** Pre-assigned identities, so a derived artifact can be bound to its source before saving. */
      documentVersionId?: string;
      artifactId?: string;
    },
  ): Promise<VaultOutcome<string>> {
    const generation = this.#generation;
    if (file.bytes.byteLength > VAULT_LIMITS.maxArtifactBytes) return bad('TOO_LARGE');
    const prepared = await this.#serialized(generation, async (keys, binding) => {
      const sealed = await keys.encrypt(binding, file.bytes, 'artifact');
      return { sealed, sha256: await artifactDigest(file.bytes) };
    });
    if (!prepared.ok) return prepared;
    if (!prepared.data.sealed.ok) return bad(failureOfVault(prepared.data.sealed.code));
    const object = prepared.data.sealed.data;
    const documentVersionId = file.documentVersionId ?? this.#deps.newId();
    const edited = this.editMatter(matterId, (record) =>
      addSource(
        record,
        {
          documentId: file.documentId ?? this.#deps.newId(),
          documentVersionId,
          artifactId: file.artifactId ?? this.#deps.newId(),
          byteLength: String(file.bytes.byteLength),
          sha256: prepared.data.sha256,
          mediaType: file.mediaType,
          label: file.label.slice(0, 256),
          object: object.ref,
          addedAt: isoNow(this.#deps.now()),
        },
        isoNow(this.#deps.now()),
      ),
    );
    if (!edited.ok) return edited;
    const saved = await this.#commit(generation, matterId, [object]);
    return saved.ok ? good(documentVersionId) : saved;
  }

  /**
   * Reads one stored original back: fetch, authenticate, decrypt, and compare with the recorded
   * SHA-256 before releasing a copy. The caller owns (and should zero) the returned bytes.
   */
  async readSource(matterId: string, documentVersionId: string): Promise<VaultOutcome<Uint8Array>> {
    const generation = this.#generation;
    const source = this.#loaded?.matters
      .get(matterId)
      ?.record.sources.find((item) => item.documentVersionId === documentVersionId);
    if (source === undefined) return bad('NOT_FOUND');
    const outcome = await this.#serialized(generation, async (keys, binding) => {
      const object = await this.#deps.transport.getObject(binding.vaultId, source.object.objectId);
      if (!object.ok) return { kind: 'transport' as const, code: object.code };
      const plain = await keys.decrypt(object.data, { ...binding, ref: source.object }, 'artifact');
      if (!plain.ok) return { kind: 'vault' as const, code: plain.code };
      if ((await artifactDigest(plain.data)) !== source.sha256) {
        plain.data.fill(0);
        return { kind: 'integrity' as const };
      }
      return { kind: 'bytes' as const, bytes: plain.data };
    });
    if (!outcome.ok) return outcome;
    const result = outcome.data;
    if (result.kind === 'transport') return bad(failureOfTransport(result.code));
    if (result.kind === 'vault') return bad(failureOfVault(result.code));
    if (result.kind === 'integrity') return bad('INTEGRITY_FAILED');
    return good(result.bytes);
  }

  // ---- Copy-on-write commit -----------------------------------------------------------------------

  async #commit(
    generation: number,
    matterId: string,
    extra: readonly SealedObject[],
    nested = false,
  ): Promise<VaultOutcome> {
    const live = this.#liveness();
    if (live !== null) return bad(live);
    const record = this.#drafts.get(matterId);
    if (record === undefined) return good(null);
    if (!nested && this.#state === 'saving') return bad('BUSY');
    const sealed = await this.#serialized(generation, async (keys, binding) => {
      const loaded = this.#loaded;
      const catalogRef = this.#catalogRef;
      if (loaded === null || catalogRef === null) throw new Error('not loaded');
      const encoded = encodeJcs(record, VAULT_LIMITS.maxStructuredBytes);
      if (!encoded.ok) return bad('TOO_LARGE');
      const matter = await keys.encrypt(binding, encoded.data, 'structured');
      if (!matter.ok) return bad(failureOfVault(matter.code));
      const entries = loaded.catalog.matters.some((m) => m.matterId === matterId)
        ? loaded.catalog.matters.map((m) =>
            m.matterId === matterId ? { matterId, matter: matter.data.ref } : m,
          )
        : [...loaded.catalog.matters, { matterId, matter: matter.data.ref }];
      const catalog = nextCatalog({ catalog: loaded.catalog, ref: catalogRef }, entries);
      if (!catalog.ok) return bad(failureOfVault(catalog.code));
      const sealedCatalog = await sealCatalog(keys, binding, catalog.data);
      if (!sealedCatalog.ok) return bad(failureOfVault(sealedCatalog.code));
      const pending: PendingCommit = {
        matterId,
        record,
        objects: [...extra, matter.data, sealedCatalog.data],
        expectedRevision: loaded.head.revision,
        catalog: catalog.data,
        catalogRef: sealedCatalog.data.ref,
        matterRef: matter.data.ref,
      };
      return good(pending);
    });
    if (!sealed.ok) return sealed;
    if (!sealed.data.ok) return sealed.data;
    this.#pending = sealed.data.data;
    return this.#runPending(generation);
  }

  /** Uploads (idempotently) then moves the head. Resends the same bytes on every retry. */
  async #runPending(generation: number): Promise<VaultOutcome> {
    const pending = this.#pending;
    if (pending === null) return good(null);
    const binding = this.#binding;
    if (binding === null) return bad('LOCKED');
    this.#set({ state: 'saving', save: 'saving', progress: 'saving_files', failure: null });
    const finish = (outcome: VaultOutcome, save: SaveState): VaultOutcome => {
      if (generation === this.#generation && this.#keys !== null) {
        this.#set({
          state: 'unlocked',
          save,
          progress: null,
          failure: outcome.ok ? null : outcome.failure,
        });
      }
      return outcome;
    };
    const fail = (code: TransportFailure): VaultOutcome => {
      if (NETWORK_UNCERTAIN.has(code)) return finish(bad('UNKNOWN_OUTCOME'), 'unknown_outcome');
      if (code === 'CONFLICT') {
        this.#conflictDraft = pending.matterId;
        this.#pending = null;
        return finish(bad('CONFLICT'), 'conflict');
      }
      this.#pending = null;
      return finish(bad(failureOfTransport(code)), 'unsaved');
    };

    for (const object of pending.objects) {
      const stored = await this.#deps.transport.putObject(
        binding.vaultId,
        object.ref.objectId,
        object.bytes,
      );
      if (generation !== this.#generation) return bad('LOCKED');
      if (!stored.ok) return fail(stored.code);
      if (stored.data.envelopeSha256 !== object.ref.envelopeSha256) return fail('MALFORMED');
    }
    const moved = await this.#deps.transport.putHead(
      binding.vaultId,
      pending.expectedRevision,
      pending.catalogRef,
    );
    if (generation !== this.#generation) return bad('LOCKED');
    if (!moved.ok) return fail(moved.code);
    return this.#applyCommit(pending, generation);
  }

  #applyCommit(pending: PendingCommit, generation: number): VaultOutcome {
    const loaded = this.#loaded;
    if (loaded === null) return bad('LOCKED');
    const matters = new Map(loaded.matters);
    matters.set(pending.matterId, { record: pending.record, ref: pending.matterRef });
    const head: VaultHeadV1 = {
      revision: (BigInt(pending.expectedRevision) + 1n).toString(),
      catalog: pending.catalogRef,
    };
    this.#loaded = { head, catalog: pending.catalog, matters };
    this.#catalogRef = pending.catalogRef;
    this.#observedRevision = head.revision;
    this.#drafts.delete(pending.matterId);
    if (this.#conflictDraft === pending.matterId) this.#conflictDraft = null;
    this.#pending = null;
    if (generation === this.#generation)
      this.#set({
        state: 'unlocked',
        save: this.#drafts.size > 0 ? 'unsaved' : 'saved',
        progress: null,
        failure: null,
      });
    return good(null);
  }

  /**
   * After an uncertain acknowledgement, ask the authoritative head what happened. If our catalog
   * is the head, the save committed. If the head is still where we left it, resend the same
   * bytes. Otherwise another device won: keep the draft and let the user reload and reapply.
   */
  async reconcile(): Promise<VaultOutcome> {
    const generation = this.#generation;
    const pending = this.#pending;
    const binding = this.#binding;
    if (pending === null || binding === null) return good(null);
    const head = await this.#deps.transport.getHead(binding.vaultId);
    if (!head.ok) return bad(failureOfTransport(head.code));
    if (generation !== this.#generation) return bad('LOCKED');
    if (head.data.catalog.objectId === pending.catalogRef.objectId)
      return this.#applyCommit(pending, generation);
    if (head.data.revision === pending.expectedRevision) return this.#runPending(generation);
    this.#conflictDraft = pending.matterId;
    this.#pending = null;
    this.#set({ state: 'unlocked', save: 'conflict', failure: 'CONFLICT', progress: null });
    return bad('CONFLICT');
  }

  /**
   * After a conflict: reload the winning state and re-apply the kept draft only if the matter it
   * was based on is unchanged remotely. Otherwise the draft stays for the user to resolve; it is
   * never silently written over another device's change.
   */
  async reapplyConflictDraft(): Promise<VaultOutcome> {
    const matterId = this.#conflictDraft;
    const draft = matterId === null ? undefined : this.#drafts.get(matterId);
    if (matterId === null || draft === undefined) return good(null);
    const baseRef = this.#loaded?.matters.get(matterId)?.ref ?? null;
    const reloaded = await this.reload();
    if (!reloaded.ok) return reloaded;
    const remoteRef = this.#loaded?.matters.get(matterId)?.ref ?? null;
    if (baseRef?.objectId !== remoteRef?.objectId) {
      this.#conflictDraft = matterId;
      this.#set({ save: 'conflict', failure: 'CONFLICT' });
      return bad('CONFLICT');
    }
    this.#conflictDraft = null;
    return this.#commit(this.#generation, matterId, []);
  }

  // ---- Frozen captures ----------------------------------------------------------------------------

  /**
   * Saves a validated capture, reads every object back, verifies it with the Chapter 2 package
   * checks, commits the catalog, then re-reads the head and verifies again. Success is a
   * successful persistence check only: it is not human approval, legal correctness, an active
   * receipt or perpetual availability.
   */
  async saveFrozenReview(
    matterId: string,
    source: FrozenCaptureSource,
  ): Promise<VaultOutcome<{ commitment: string }>> {
    const generation = this.#generation;
    const reference =
      PreparedReviewPackage.isPrepared(source) || VerifiedReview.isVerified(source)
        ? source.reference
        : null;
    const parsedReference = receiptReferenceV1Schema.safeParse(reference);
    if (!parsedReference.success) return bad('INVALID');
    const commitment = parsedReference.data.commitment;
    if (this.#working(matterId) === null) return bad('NOT_FOUND');

    // If this exact capture already committed (perhaps an earlier acknowledgement was lost), verify it; never re-mint.
    const known = this.#working(matterId)?.frozenReviews.find(
      (item) => item.commitment === commitment,
    );
    if (known !== undefined) {
      const verified = await this.verifyStoredCapture(matterId, commitment);
      return verified.ok ? good({ commitment }) : verified;
    }

    let pendingCapture = this.#pendingCaptures.get(commitment);
    if (pendingCapture === undefined) {
      const sealedResult = await this.#serialized(generation, (keys, binding) =>
        sealFrozenReview(keys, binding, source),
      );
      if (!sealedResult.ok) return sealedResult;
      if (!sealedResult.data.ok) return bad(failureOfVault(sealedResult.data.code));
      pendingCapture = { source, matterId, sealed: sealedResult.data };
      this.#pendingCaptures.set(commitment, pendingCapture);
      this.#publish();
    }
    const sealed = pendingCapture.sealed.data;

    this.#set({ state: 'saving', save: 'saving', progress: 'saving_files', failure: null });
    const binding = this.#binding;
    if (binding === null) return bad('LOCKED');
    const uncertain = (): VaultOutcome<never> => {
      if (generation === this.#generation)
        this.#set({
          state: 'unlocked',
          save: 'unknown_outcome',
          progress: null,
          failure: 'UNKNOWN_OUTCOME',
        });
      return bad('UNKNOWN_OUTCOME');
    };
    for (const object of sealed.objects) {
      const stored = await this.#deps.transport.putObject(
        binding.vaultId,
        object.ref.objectId,
        object.bytes,
      );
      if (generation !== this.#generation) return bad('LOCKED');
      if (!stored.ok) {
        if (NETWORK_UNCERTAIN.has(stored.code)) return uncertain();
        this.#set({
          state: 'unlocked',
          save: 'unsaved',
          progress: null,
          failure: failureOfTransport(stored.code),
        });
        return bad(failureOfTransport(stored.code));
      }
      // The acknowledgement must describe exactly the bytes that were sent.
      if (stored.data.envelopeSha256 !== object.ref.envelopeSha256) {
        this.#set({
          state: 'unlocked',
          save: 'unsaved',
          progress: null,
          failure: 'INTEGRITY_FAILED',
        });
        return bad('INTEGRITY_FAILED');
      }
    }

    // Read back before the catalog is committed.
    this.#set({ progress: 'checking_package' });
    const before = await this.#verifyFromStorage(sealed.frozen.ref, generation);
    if (!before.ok) {
      this.#set({ state: 'unlocked', save: 'unsaved', progress: null, failure: before.failure });
      return before;
    }

    const edited = this.editMatter(matterId, (record) =>
      addFrozenReview(
        record,
        {
          frozenReview: sealed.frozen.ref,
          packageId: sealed.record.packageId,
          commitment,
          savedAt: isoNow(this.#deps.now()),
        },
        isoNow(this.#deps.now()),
      ),
    );
    if (!edited.ok && edited.failure !== 'INVALID') return edited;
    const committed = await this.#commit(generation, matterId, [], true);
    if (!committed.ok) {
      if (committed.failure === 'UNKNOWN_OUTCOME') {
        // The capture's identity is kept: a later reconcile or retry reuses these exact objects.
        return committed;
      }
      return committed;
    }

    // Re-read the head: the capture must still be reachable, whatever other devices did meanwhile.
    this.#set({ state: 'saving', progress: 'checking_package' });
    const verified = await this.verifyStoredCapture(matterId, commitment, true);
    if (!verified.ok) {
      this.#set({
        state: 'unlocked',
        save: 'unknown_outcome',
        progress: null,
        failure: verified.failure,
      });
      return verified;
    }
    this.#pendingCaptures.delete(commitment);
    this.#set({ state: 'unlocked', save: 'saved', progress: null, failure: null });
    return good({ commitment });
  }

  /** Resumes an interrupted capture with its original sealed objects. Never mints a new commitment. */
  async retryPendingCapture(commitment: string): Promise<VaultOutcome<{ commitment: string }>> {
    const pending = this.#pendingCaptures.get(commitment);
    if (pending === undefined) return bad('NOT_FOUND');
    if (this.#pending !== null) {
      const reconciled = await this.reconcile();
      if (!reconciled.ok && reconciled.failure !== 'CONFLICT') return reconciled;
    }
    // First discover whether the exact capture already committed.
    const reloaded = await this.reload();
    if (!reloaded.ok) return reloaded;
    return this.saveFrozenReview(pending.matterId, pending.source);
  }

  async #verifyFromStorage(frozenRef: VaultObjectRefV1, generation: number) {
    return this.#serialized(generation, (keys, binding) =>
      verifyFrozenReview(
        keys,
        binding,
        frozenRef,
        async (ref) => {
          const object = await this.#deps.transport.getObject(binding.vaultId, ref.objectId);
          return object.ok ? object.data : null;
        },
        generation,
      ),
    ).then(
      (outcome): VaultOutcome<Awaited<ReturnType<typeof verifyFrozenReview>> & { ok: true }> => {
        if (!outcome.ok) return outcome;
        if (!outcome.data.ok) return bad(failureOfVault(outcome.data.code));
        return good(outcome.data);
      },
    );
  }

  /**
   * Reconstructs readiness the only way it can be trusted: retrieve, authenticate, decrypt and
   * run the Chapter 2 verification. Needed after every unlock; nothing persisted can claim it.
   */
  async verifyStoredCapture(
    matterId: string,
    commitment: string,
    reloadFirst = false,
  ): Promise<VaultOutcome> {
    const generation = this.#generation;
    if (reloadFirst) {
      const reloaded = await this.reload();
      if (!reloaded.ok) return reloaded;
    }
    const entry = this.#loaded?.matters
      .get(matterId)
      ?.record.frozenReviews.find((item) => item.commitment === commitment);
    if (entry === undefined) return bad('NOT_FOUND');
    const verified = await this.#verifyFromStorage(entry.frozenReview, generation);
    if (!verified.ok) return verified;
    const { capture } = verified.data.data;
    if (capture.commitment !== commitment) return bad('INTEGRITY_FAILED');
    this.#captures.set(commitment, capture);
    this.#references.set(commitment, {
      reference: verified.data.data.review.reference,
      supersedes: verified.data.data.review.opening.manifest.supersedes,
      artifacts: verified.data.data.review.opening.manifest.artifacts.map((a) => ({
        id: a.id,
        role: a.role,
        byteLength: a.byteLength,
      })),
      scopeArtifactIds: verified.data.data.review.opening.manifest.approval.scopeArtifactIds,
      decisionLogBytes: verified.data.data.review.artifactBytes(
        verified.data.data.review.opening.manifest.approval.decisionLogArtifactId,
      ),
    });
    this.#packageIds.set(commitment, entry.packageId);
    this.#publish();
    return good(null);
  }

  /**
   * The controller-owned gate later chapters combine with live-chain and human-review gates. Only
   * a capture verified in THIS unlock, for THIS account and vault, is returned. Nothing a caller
   * supplies (persisted=true, verified=true, imported JSON, model text) can produce one.
   */
  recoverableCapture(commitment: string): RecoverableCapture | null {
    const capture = this.#captures.get(commitment);
    const binding = this.#binding;
    if (capture === undefined || binding === null || this.#keys === null) return null;
    return capture.matches(binding.ownerAddress, binding.vaultId, this.#generation)
      ? capture
      : null;
  }

  /**
   * A capture verified in this unlock with its public reference, for the review-approval gate.
   * Null for anything else: a persisted flag, an import or a capture from an earlier unlock.
   */
  recoverableSubject(commitment: string): {
    capture: RecoverableCapture;
    reference: ReceiptReferenceV1;
    supersedes: ReceiptReferenceV1 | null;
    artifacts: readonly { id: string; role: string; byteLength: string }[];
    scopeArtifactIds: readonly string[];
    decisionLogBytes: Uint8Array | null;
  } | null {
    const capture = this.recoverableCapture(commitment);
    const known = this.#references.get(commitment);
    return capture === null || known === undefined
      ? null
      : {
          capture,
          ...known,
          decisionLogBytes: known.decisionLogBytes?.slice() ?? null,
        };
  }

  // ---- Export -------------------------------------------------------------------------------------

  /** Builds a preview and holds the bytes privately. Nothing is downloaded until confirmExport. */
  async prepareExport(
    kind: ExportPreview['kind'],
    matterId: string,
    commitment?: string,
  ): Promise<VaultOutcome<ExportPreview>> {
    const generation = this.#generation;
    const record = this.#loaded?.matters.get(matterId)?.record;
    const view = this.#view;
    if (this.#keys === null || record === undefined || view === null) return bad('LOCKED');
    this.cancelExport();

    if (kind === 'context') {
      const bytes = buildContextExport(this.#working(matterId) ?? record);
      if (!bytes.ok) return bad(failureOfVault(bytes.code));
      return this.#holdExport(
        kind,
        matterId,
        bytes.data,
        [
          {
            label: 'Saved context entries and their source references',
            bytes: bytes.data.byteLength,
          },
        ],
        'This file contains the saved facts and notes of this matter in readable form, with their source references. It does not contain documents or conversation. Anyone with the file can read and copy it.',
        true,
      );
    }

    const entry = record.frozenReviews.find((item) => item.commitment === commitment);
    if (entry === undefined) return bad('NOT_FOUND');
    const verified = await this.#verifyFromStorage(entry.frozenReview, generation);
    if (!verified.ok) return verified;
    const { review, envelopes } = verified.data.data;
    if (kind === 'encrypted-review') {
      const bytes = buildEncryptedReviewExport(
        view.descriptor,
        entry.frozenReview,
        verified.data.data,
      );
      if (!bytes.ok) return bad(failureOfVault(bytes.code));
      return this.#holdExport(
        kind,
        entry.packageId,
        bytes.data,
        [{ label: `${String(envelopes.size)} encrypted objects`, bytes: bytes.data.byteLength }],
        'This is an encrypted backup of this one review. It needs the same passkey and site to open and does not expose the documents. It is not a backup of your whole workspace.',
        false,
      );
    }
    const bytes = buildReadableReviewExport(review);
    if (!bytes.ok) return bad(failureOfVault(bytes.code));
    const items = review.opening.manifest.artifacts.map((artifact) => ({
      label: `${artifact.role} (${artifact.mediaType})${artifact.label === null ? '' : `: ${artifact.label}`}`,
      bytes: Number(artifact.byteLength),
    }));
    return this.#holdExport(
      kind,
      entry.packageId,
      bytes.data,
      items,
      'This file exposes the private documents and notes of this review, the blinding nonce and the unsalted hash of every file. Anyone who has it can read it, copy it and prove the review to others. It is a complete package, not a selective disclosure.',
      true,
    );
  }

  #holdExport(
    kind: ExportPreview['kind'],
    id: string,
    bytes: Uint8Array,
    items: ExportPreview['items'],
    disclosure: string,
    discloses: boolean,
  ): VaultOutcome<ExportPreview> {
    const exportId = this.#deps.newId();
    const fileKind =
      kind === 'encrypted-review'
        ? 'encrypted-review'
        : kind === 'readable-review'
          ? 'review'
          : 'context';
    const preview: ExportPreview = Object.freeze({
      exportId,
      kind,
      fileName: exportFileName(fileKind, uuidV4.test(id) ? id : exportId),
      disclosure,
      items,
      discloses,
    });
    this.#export = { id: exportId, bytes, fileName: preview.fileName, preview };
    this.#publish();
    return good(preview);
  }

  /** The explicit Download confirmation. Releases the bytes once and forgets them. */
  confirmExport(
    exportId: string,
  ): VaultOutcome<{ fileName: string; bytes: Uint8Array; mediaType: 'application/json' }> {
    const held = this.#export;
    if (this.#keys === null || held === null || held.id !== exportId) return bad('NOT_FOUND');
    this.#export = null;
    this.#publish();
    return good({ fileName: held.fileName, bytes: held.bytes, mediaType: 'application/json' });
  }

  cancelExport(): void {
    if (this.#export !== null) {
      this.#export.bytes.fill(0);
      this.#export = null;
      this.#publish();
    }
  }

  // ---- Import -------------------------------------------------------------------------------------

  /** Parses an untrusted bundle and shows what it contains. Nothing persistent changes. */
  async previewImport(
    bytes: Uint8Array,
    expectedReference?: ReceiptReferenceV1,
  ): Promise<VaultOutcome<ImportPreview>> {
    const generation = this.#generation;
    const keys = this.#keys;
    const binding = this.#binding;
    if (keys === null || binding === null) return bad('LOCKED');
    this.#import = null;
    const head = parseJsonBytes(bytes, VAULT_LIMITS.maxEncryptedExportBytes);
    const schema =
      head.ok && typeof head.data === 'object' && head.data !== null
        ? (head.data as { schema?: unknown }).schema
        : undefined;
    const importId = this.#deps.newId();
    const context = {
      ownerAddress: binding.ownerAddress,
      rpId: binding.rpId,
      ...(expectedReference !== undefined && { expectedReference }),
    };

    if (schema === CONTEXT_EXPORT_SCHEMA) {
      const parsed = parseContextExport(bytes);
      if (!parsed.ok) return bad(failureOfVault(parsed.code));
      // Unresolved relative to the matter the entries would be added to (the selected one).
      const target = this.#selected === null ? null : this.#working(this.#selected);
      const known = new Set(
        target === null ? [] : target.sources.map((source) => source.documentVersionId),
      );
      const preview: ImportPreview = Object.freeze({
        importId,
        kind: 'context',
        review: null,
        context: {
          matterId: parsed.data.matterId,
          entries: parsed.data.context.entries.map((e) => ({
            entryId: e.entryId,
            kind: e.kind,
            text: e.text,
            unresolvedReferences: e.sourceRefs.filter((r) => !known.has(r.documentVersionId))
              .length,
          })),
        },
      });
      this.#import = { id: importId, review: null, context: parsed.data, preview };
      this.#publish();
      return good(preview);
    }
    const parsed =
      schema === REVIEW_EXPORT_SCHEMA
        ? await parseReadableReviewExport(bytes, context)
        : schema === ENCRYPTED_EXPORT_SCHEMA
          ? await parseEncryptedReviewExport(bytes, keys, context, generation)
          : null;
    if (parsed === null) return bad('UNSUPPORTED_FORMAT');
    if (!parsed.ok) return bad(failureOfVault(parsed.code));
    if (generation !== this.#generation) return bad('LOCKED');
    const preview: ImportPreview = Object.freeze({
      importId,
      kind: schema === REVIEW_EXPORT_SCHEMA ? 'readable-review' : 'encrypted-review',
      review: parsed.data.preview,
      context: null,
    });
    this.#import = { id: importId, review: parsed.data.review, context: null, preview };
    this.#publish();
    return good(preview);
  }

  cancelImport(): void {
    this.#import = null;
    this.#publish();
  }

  /** After confirmation: re-encrypts under fresh IDs, salts and IVs for THIS vault and uses the normal verified save. */
  async confirmReviewImport(
    importId: string,
    matterId: string,
  ): Promise<VaultOutcome<{ commitment: string }>> {
    const held = this.#import;
    if (held === null || held.id !== importId || held.review === null) return bad('NOT_FOUND');
    const outcome = await this.saveFrozenReview(matterId, held.review);
    if (outcome.ok) this.cancelImport();
    return outcome;
  }

  /** After confirmation: adds only the selected entries, as unconfirmed imported entries. */
  confirmContextImport(
    importId: string,
    matterId: string,
    entryIds: readonly string[],
  ): VaultOutcome {
    const held = this.#import;
    if (held === null || held.id !== importId || held.context === null) return bad('NOT_FOUND');
    const ctx = held.context;
    const edited = this.editMatter(matterId, (record) =>
      importContextEntries(record, ctx, entryIds, isoNow(this.#deps.now()), this.#deps.newId),
    );
    if (edited.ok) this.cancelImport();
    return edited;
  }
}

export type { TransportResult };
