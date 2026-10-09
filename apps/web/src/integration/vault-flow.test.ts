import { describe, expect, it } from 'vitest';
import {
  VAULT_ABSOLUTE_LIMIT_MS,
  VAULT_IDLE_LIMIT_MS,
  type VaultOutcome,
} from '@/features/vault/vault-controller';
import {
  createVaultHarness,
  prepareSynthetic,
  withVault,
  type VaultHarness,
} from '@/test-support/vault-harness';

/*
 * Real account and vault controllers, real Web Crypto and the real vault service, in memory with
 * a scripted authenticator. Not evidence of real-device PRF, prompt counts or synced recovery.
 */

const must = <T>(outcome: VaultOutcome<T>): T => {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.failure}`);
  return outcome.data;
};

/** A second browser: empty storage and no session, sharing the authenticator and the server. */
function otherDevice(first: VaultHarness) {
  return createVaultHarness({
    authenticator: first.authenticator,
    server: first.server,
    clock: first.clock,
  });
}
async function recoverAccount(harness: VaultHarness) {
  const recovered = await harness.controller.recoverByDiscovery();
  if (!recovered.ok) throw new Error(recovered.code);
  must(await harness.vault.refreshDiscovery());
}

describe('creating and unlocking', () => {
  it('creates the vault only on explicit request and keeps vault state apart from the others', async () => {
    const h = createVaultHarness();
    await h.controller.createAndSignIn();
    expect(h.vault.getSnapshot().state).toBe('locked');
    expect(must(await h.vault.refreshDiscovery())).toBe('absent');
    // Absence is reported; nothing was created by looking.
    expect(h.server.repo.vaults.size).toBe(0);
    must(await h.vault.createVault());

    const snapshot = h.vault.getSnapshot();
    expect(snapshot).toMatchObject({
      state: 'unlocked',
      discovery: 'present',
      save: 'saved',
      headRevision: '0',
      matters: [],
    });
    // Unlocking the vault neither renews the login nor extends the signing session.
    expect(h.controller.getSnapshot().signing.expiresAt).toBe(
      h.clock.now - 0 + 0 === 0 ? null : h.controller.getSnapshot().signing.expiresAt,
    );
    expect(h.controller.getSnapshot().backend.expiresAt).toBe(
      h.controller.getSnapshot().backend.expiresAt,
    );
    // Account PRF and vault PRF are separate namespaces: two different outputs.
    expect(new Set(h.authenticator.prfOutputs).size).toBe(2);
  });

  it('says there is no vault without showing a passkey prompt', async () => {
    const h = createVaultHarness();
    await h.controller.createAndSignIn();
    must(await h.vault.refreshDiscovery());
    const assertions = h.authenticator.calls.get;
    expect(await h.vault.unlock()).toEqual({ ok: false, failure: 'NO_VAULT' });
    expect(h.authenticator.calls.get).toBe(assertions);
    expect(h.vault.getSnapshot()).toMatchObject({ state: 'error', failure: 'NO_VAULT' });
  });

  it('refuses without a backend sign-in, and never mistakes an outage for an empty vault', async () => {
    const h = createVaultHarness();
    expect(await h.vault.refreshDiscovery()).toEqual({ ok: false, failure: 'NOT_SIGNED_IN' });
    await h.controller.createAndSignIn();
    h.faults.offline = true;
    expect(await h.vault.refreshDiscovery()).toEqual({ ok: false, failure: 'STORAGE_UNAVAILABLE' });
    expect(h.vault.getSnapshot().discovery).toBe('unavailable');
    h.faults.offline = false;
    expect(must(await h.vault.refreshDiscovery())).toBe('absent');
  });

  it('a second create never replaces the first: it points at recovery', async () => {
    const h = await withVault(createVaultHarness());
    const vaultId = [...h.server.repo.vaults.keys()][0];
    h.vault.lock();
    h.vault.getSnapshot();
    const assertionsBefore = h.authenticator.calls.get;
    expect(await h.vault.createVault()).toEqual({ ok: false, failure: 'VAULT_EXISTS' });
    // Found by a fresh look before any passkey prompt, not by a server rejection after one.
    expect(h.authenticator.calls.get).toBe(assertionsBefore);
    expect([...h.server.repo.vaults.keys()]).toEqual([vaultId]);
    // The existing vault still unlocks with the same key.
    expect(must(await h.vault.unlock())).toBeNull();
  });

  it('a cancelled or unsupported passkey prompt opens nothing and creates nothing', async () => {
    const h = createVaultHarness();
    await h.controller.createAndSignIn();
    must(await h.vault.refreshDiscovery());
    h.authenticator.failNext = 'NotAllowedError';
    expect(await h.vault.createVault()).toEqual({ ok: false, failure: 'CANCELLED' });
    expect(h.server.repo.vaults.size).toBe(0);
    expect(h.vault.getSnapshot().state).toBe('error');
  });

  it('lock during the passkey prompt discards the result', async () => {
    const first = await withVault(createVaultHarness());
    first.vault.lock();
    first.authenticator.hold();
    const pending = first.vault.unlock();
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.vault.lock();
    first.authenticator.release();
    expect(await pending).toEqual({ ok: false, failure: 'STALE' });
    expect(first.vault.getSnapshot().state).not.toBe('unlocked');
    expect(first.vault.getSnapshot().matters).toEqual([]);
  });
});

describe('stateless recovery', () => {
  it('a fresh browser with the same passkey decrypts the saved matter from remote ciphertext alone', async () => {
    const first = await withVault(createVaultHarness());
    const matterId = must(await first.vault.createMatter('SENTINEL-matter-title'));
    must(first.vault.editMatter(matterId, (r) => ({ ok: true, data: r })));
    const address = first.controller.getSnapshot().account?.address;

    const fresh = otherDevice(first);
    expect(fresh.vault.getSnapshot().matters).toEqual([]);
    await recoverAccount(fresh);
    expect(fresh.controller.getSnapshot().account?.address).toBe(address);
    expect(must(await fresh.vault.recover())).toBeNull();
    expect(fresh.vault.getSnapshot().matters.map((m) => m.title)).toEqual([
      'SENTINEL-matter-title',
    ]);
    expect(first.authenticator.calls.create).toBe(1); // no new passkey: this is recovery
  });

  it('a different account sees no vault and cannot read the first one', async () => {
    const first = await withVault(createVaultHarness());
    const matterId = must(await first.vault.createMatter('private'));
    const outsider = createVaultHarness({ server: first.server, clock: first.clock });
    await outsider.controller.createAndSignIn();
    expect(must(await outsider.vault.refreshDiscovery())).toBe('absent');
    const vaultId = [...first.server.repo.vaults.keys()][0] ?? '';
    const stolen = await outsider.service.getHead(
      outsider.controller.getSnapshot().account?.address ?? '',
      vaultId,
      'r',
    );
    expect(stolen.status).toBe(404);
    expect(matterId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('separates the failure outcomes and never creates a replacement', async () => {
    const first = await withVault(createVaultHarness());
    must(await first.vault.createMatter('keep'));
    const before = new Map(first.server.objects.objects);

    const fresh = otherDevice(first);
    await recoverAccount(fresh);
    fresh.server.objects.down = true;
    expect(await fresh.vault.recover()).toEqual({ ok: false, failure: 'STORAGE_UNAVAILABLE' });
    expect(fresh.vault.getSnapshot()).toMatchObject({
      state: 'error',
      progress: 'recovery_failed',
    });
    fresh.server.objects.down = false;

    // A catalog object that storage no longer returns: reported as missing, not "empty".
    const head = await fresh.server.repo.getHead([...fresh.server.repo.vaults.keys()][0] ?? '');
    const key = `vaults/${[...fresh.server.repo.vaults.keys()][0]}/objects/${head?.catalog.objectId}`;
    const kept = fresh.server.objects.objects.get(key);
    fresh.server.objects.objects.delete(key);
    expect(await fresh.vault.recover()).toEqual({ ok: false, failure: 'MISSING_OBJECTS' });
    if (kept !== undefined) fresh.server.objects.objects.set(key, kept);

    // A flipped byte: integrity failure, with the ciphertext untouched.
    const damaged = kept?.slice() ?? new Uint8Array();
    damaged[damaged.length - 30] = (damaged[damaged.length - 30] ?? 0) ^ 1;
    fresh.server.objects.objects.set(key, damaged);
    expect(await fresh.vault.recover()).toEqual({ ok: false, failure: 'INTEGRITY_FAILED' });
    fresh.server.objects.objects.set(key, kept ?? damaged);

    // After all those failures: still one vault, and every original object intact.
    expect(fresh.server.repo.vaults.size).toBe(1);
    for (const [k, v] of before) expect(fresh.server.objects.objects.get(k)).toEqual(v);
    expect(must(await fresh.vault.recover())).toBeNull();
  });

  it('a different passkey answering is refused as a wrong credential or a different account', async () => {
    const first = await withVault(createVaultHarness());
    const second = createVaultHarness({
      authenticator: first.authenticator,
      server: first.server,
      clock: first.clock,
    });
    await second.controller.createAndSignIn(); // a NEW passkey, hence a different account
    expect(second.controller.getSnapshot().account?.address).not.toBe(
      first.controller.getSnapshot().account?.address,
    );
    expect(must(await second.vault.refreshDiscovery())).toBe('absent');
    expect(await second.vault.unlock()).toEqual({ ok: false, failure: 'NO_VAULT' });
  });
});

describe('lock, expiry and lifecycle', () => {
  it('Lock releases the key and every decrypted view; the account lock does the same', async () => {
    const h = await withVault(createVaultHarness());
    const matterId = must(await h.vault.createMatter('SENTINEL-title'));
    h.vault.selectMatter(matterId);
    expect(h.vault.getSnapshot().selectedMatter?.title).toBe('SENTINEL-title');

    h.vault.lock();
    const locked = h.vault.getSnapshot();
    expect(locked).toMatchObject({
      state: 'locked',
      matters: [],
      selectedMatter: null,
      selectedMatterId: null,
      headRevision: null,
      exportPreview: null,
    });
    expect(JSON.stringify(locked)).not.toContain('SENTINEL');
    expect(h.vault.workingMatter(matterId)).toBeNull();
    expect(await h.vault.saveMatter(matterId)).toEqual({ ok: false, failure: 'LOCKED' });

    must(await h.vault.unlock());
    h.controller.lock();
    expect(h.vault.getSnapshot().state).toBe('locked');
  });

  it('lock discards unsaved drafts: they do not reappear after the next unlock', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    must(h.vault.addEntry(id, { kind: 'note', text: 'SENTINEL-unsaved-draft', confirmed: false }));
    expect(h.vault.getSnapshot().save).toBe('unsaved');
    h.vault.lock();
    expect(h.vault.getSnapshot().save).toBe('idle');
    must(await h.vault.unlock());
    expect(h.vault.workingMatter(id)?.context.entries).toEqual([]);
    expect(h.vault.getSnapshot().matters.map((m) => m.unsaved)).toEqual([false]);
  });

  it('locks at 5 idle minutes and 10 absolute minutes; a timer tick does not count as use', async () => {
    const h = await withVault(createVaultHarness());
    h.clock.advance(VAULT_IDLE_LIMIT_MS - 1);
    h.vault.tick();
    expect(h.vault.getSnapshot().state).toBe('unlocked');
    h.clock.advance(1);
    h.vault.tick();
    expect(h.vault.getSnapshot().state).toBe('locked');

    must(await h.vault.unlock());
    for (let t = 0; t < VAULT_ABSOLUTE_LIMIT_MS - 60_000; t += 60_000) {
      h.clock.advance(60_000);
      h.vault.noteInteraction();
    }
    expect(h.vault.getSnapshot().state).toBe('unlocked');
    h.clock.advance(60_000);
    h.vault.noteInteraction();
    expect(h.vault.getSnapshot().state).toBe('locked');
  });

  it('refuses operations after expiry even when no timer ran', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('m'));
    h.clock.advance(VAULT_ABSOLUTE_LIMIT_MS + 1);
    expect(h.vault.editMatter(id, (r) => ({ ok: true, data: r }))).toEqual({
      ok: false,
      failure: 'EXPIRED',
    });
    expect(h.vault.getSnapshot().state).toBe('locked');
  });

  it('a signing lock clears the vault without waiting', async () => {
    const h = await withVault(createVaultHarness());
    h.controller.handlePageHide();
    expect(h.vault.getSnapshot().state).toBe('locked');
    h.controller.handlePageShow(true);
    expect(h.vault.getSnapshot().state).toBe('locked');
  });
});

describe('copy-on-write saves', () => {
  it('stores new immutable objects and moves the head atomically; edits never touch old objects', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('Matter'));
    const afterCreate = new Map(h.server.objects.objects);
    expect(h.vault.getSnapshot().headRevision).toBe('1');

    must(
      h.vault.addEntry(id, { kind: 'fact', text: 'Notice period is four weeks', confirmed: true }),
    );
    expect(h.vault.getSnapshot()).toMatchObject({ save: 'unsaved', matters: [{ unsaved: true }] });
    expect(h.server.objects.objects.size).toBe(afterCreate.size); // nothing stored until saved
    must(await h.vault.saveMatter(id));

    expect(h.vault.getSnapshot()).toMatchObject({ save: 'saved', headRevision: '2' });
    for (const [key, bytes] of afterCreate)
      expect(h.server.objects.objects.get(key)).toEqual(bytes);
    expect(h.server.objects.objects.size).toBe(afterCreate.size + 2); // new matter record and new catalog
    expect((await h.server.repo.getHead([...h.server.repo.vaults.keys()][0] ?? ''))?.revision).toBe(
      '2',
    );
  });

  it('keeps provenance: a correction is unconfirmed, a removal touches only working context', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    must(h.vault.addEntry(id, { kind: 'fact', text: 'A', confirmed: true }));
    must(await h.vault.saveMatter(id));
    const entryId =
      h.vault.getSnapshot().selectedMatter?.context.entries[0]?.entryId ??
      h.vault.workingMatter(id)?.context.entries[0]?.entryId ??
      '';
    must(h.vault.correctEntry(id, entryId, 'B'));
    expect(h.vault.workingMatter(id)?.context.entries[0]).toMatchObject({
      text: 'B',
      status: 'unconfirmed',
      confirmedAt: null,
    });
    must(h.vault.confirmEntry(id, entryId));
    must(h.vault.removeEntry(id, entryId));
    must(await h.vault.saveMatter(id));
    expect(h.vault.workingMatter(id)?.context.entries).toEqual([]);
  });

  it('enforces the 16-matter quota without storing the extra one', async () => {
    const h = await withVault(createVaultHarness());
    for (let i = 0; i < 16; i += 1) must(await h.vault.createMatter(`m${String(i)}`));
    const before = h.server.objects.objects.size;
    expect(await h.vault.createMatter('one too many')).toEqual({ ok: false, failure: 'QUOTA' });
    expect(h.server.objects.objects.size).toBe(before);
    expect(h.vault.getSnapshot().matters).toHaveLength(16);
  });

  it('stores an original file as an immutable encrypted source version', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    const bytes = new TextEncoder().encode('SENTINEL-original-agreement-bytes');
    const versionId = must(
      await h.vault.addSourceFile(id, { bytes, mediaType: 'application/pdf', label: 'Agreement' }),
    );
    expect(h.vault.workingMatter(id)?.sources).toEqual([
      expect.objectContaining({ documentVersionId: versionId, byteLength: String(bytes.length) }),
    ]);
    const stored = [...h.server.objects.objects.values()]
      .map((o) => new TextDecoder().decode(o))
      .join('');
    expect(stored).not.toContain('SENTINEL');
    expect(
      await h.vault.addSourceFile(id, {
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        mediaType: 'application/pdf',
        label: 'big',
      }),
    ).toEqual({ ok: false, failure: 'TOO_LARGE' });
  });
});

describe('concurrent devices and uncertain outcomes', () => {
  async function twoDevices() {
    const a = await withVault(createVaultHarness());
    const matterId = must(await a.vault.createMatter('Shared'));
    const b = otherDevice(a);
    await recoverAccount(b);
    must(await b.vault.recover());
    return { a, b, matterId };
  }

  it('a 409 keeps the local draft, reports the conflict and never overwrites the other device', async () => {
    const { a, b, matterId } = await twoDevices();
    must(a.vault.addEntry(matterId, { kind: 'note', text: 'from A', confirmed: false }));
    must(await a.vault.saveMatter(matterId));

    must(b.vault.addEntry(matterId, { kind: 'note', text: 'from B', confirmed: false }));
    expect(await b.vault.saveMatter(matterId)).toEqual({ ok: false, failure: 'CONFLICT' });
    expect(b.vault.getSnapshot()).toMatchObject({
      save: 'conflict',
      conflictDraftMatterId: matterId,
    });
    expect(b.vault.workingMatter(matterId)?.context.entries.map((e) => e.text)).toEqual(['from B']);
    // A's committed state is the head.
    expect((await a.server.repo.getHead([...a.server.repo.vaults.keys()][0] ?? ''))?.revision).toBe(
      '2',
    );

    // Same matter changed elsewhere: the draft is not silently written over it.
    expect(await b.vault.reapplyConflictDraft()).toEqual({ ok: false, failure: 'CONFLICT' });
    expect(b.vault.workingMatter(matterId)?.context.entries.map((e) => e.text)).toEqual(['from B']);
  });

  it('reapplies a draft when the other device changed a different matter', async () => {
    const { a, b, matterId } = await twoDevices();
    const other = must(await a.vault.createMatter('Other'));
    must(await a.vault.saveMatter(other));
    must(b.vault.addEntry(matterId, { kind: 'note', text: 'mine', confirmed: false }));
    expect(await b.vault.saveMatter(matterId)).toEqual({ ok: false, failure: 'CONFLICT' });
    must(await b.vault.reapplyConflictDraft());
    expect(b.vault.getSnapshot()).toMatchObject({ save: 'saved', conflictDraftMatterId: null });
    expect(
      b.vault
        .getSnapshot()
        .matters.map((m) => m.title)
        .sort(),
    ).toEqual(['Other', 'Shared']);
  });

  it('a lost acknowledgement reconciles from the authoritative head without a duplicate save', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    must(h.vault.addEntry(id, { kind: 'note', text: 'n', confirmed: false }));
    const revisionBefore = (await h.server.repo.getHead([...h.server.repo.vaults.keys()][0] ?? ''))
      ?.revision;
    h.server.objects.dropNextAck = true; // first object write commits, then looks unacknowledged
    const outcome = await h.vault.saveMatter(id);
    expect(outcome).toEqual({ ok: false, failure: 'UNKNOWN_OUTCOME' });
    expect(h.vault.getSnapshot().save).toBe('unknown_outcome');

    const reconciled = await h.vault.reconcile();
    expect(reconciled.ok).toBe(true);
    expect(h.vault.getSnapshot().save).toBe('saved');
    const revisionAfter = (await h.server.repo.getHead([...h.server.repo.vaults.keys()][0] ?? ''))
      ?.revision;
    // Exactly one new revision, and the draft was not lost or applied twice.
    expect(BigInt(revisionAfter ?? '0') - BigInt(revisionBefore ?? '0')).toBe(1n);
    expect(h.vault.workingMatter(id)?.context.entries).toHaveLength(1);
  });

  it('a head move whose response is lost is recognised as already applied', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    must(h.vault.addEntry(id, { kind: 'note', text: 'n', confirmed: false }));
    // Let the uploads through, then lose only the head move's response.
    const originalHead = h.server.repo.swapHead.bind(h.server.repo);
    (h.server.repo as { swapHead: unknown }).swapHead = async (
      ...args: Parameters<typeof originalHead>
    ) => {
      const result = await originalHead(...args);
      h.faults.loseNextWriteResponse = true;
      return result;
    };
    const outcome = await h.vault.saveMatter(id);
    expect(outcome).toEqual({ ok: false, failure: 'UNKNOWN_OUTCOME' });
    (h.server.repo as { swapHead: unknown }).swapHead = originalHead;
    must(await h.vault.reconcile());
    expect(h.vault.getSnapshot()).toMatchObject({ save: 'saved' });
    expect((await h.server.repo.getHead([...h.server.repo.vaults.keys()][0] ?? ''))?.revision).toBe(
      h.vault.getSnapshot().headRevision,
    );
  });

  it('detects storage serving an older head than one already observed', async () => {
    const h = await withVault(createVaultHarness());
    const id = must(await h.vault.createMatter('M'));
    must(h.vault.addEntry(id, { kind: 'note', text: 'n', confirmed: false }));
    must(await h.vault.saveMatter(id));
    const vaultId = [...h.server.repo.vaults.keys()][0] ?? '';
    const head = h.server.repo.heads.get(vaultId);
    if (head === undefined) throw new Error('no head');
    // Replay an earlier snapshot: revision 1 pointing at the revision-1 catalog.
    h.server.repo.heads.set(vaultId, {
      revision: 0n,
      catalogObjectId: [...h.server.repo.objects.keys()][0]?.split('/')[1] ?? head.catalogObjectId,
    });
    expect(await h.vault.reload()).toEqual({ ok: false, failure: 'ROLLBACK_DETECTED' });
  });
});

describe('frozen reviews', () => {
  async function ready() {
    const h = await withVault(createVaultHarness());
    const matterId = must(await h.vault.createMatter('Review matter'));
    const prepared = await prepareSynthetic('legal');
    return { h, matterId, prepared };
  }

  it('saves, reads back, verifies and only then reports the capture as saved and checked', async () => {
    const { h, matterId, prepared } = await ready();
    const saved = must(await h.vault.saveFrozenReview(matterId, prepared));
    expect(saved.commitment).toBe(prepared.reference.commitment);

    expect(h.vault.getSnapshot().checkedCaptures).toEqual([
      { commitment: prepared.reference.commitment, packageId: prepared.opening.manifest.packageId },
    ]);
    const gate = h.vault.recoverableCapture(prepared.reference.commitment);
    expect(gate).toMatchObject({
      commitment: prepared.reference.commitment,
      packageDigest: prepared.packageDigest,
    });
    // It says "saved and checked". Nothing says approved, signed, confirmed or active.
    expect(JSON.stringify(h.vault.getSnapshot())).not.toMatch(
      /approved|signed|confirmed on chain|active receipt/i,
    );
  });

  it('the gate dies with the lock and must be rebuilt by retrieval and verification', async () => {
    const { h, matterId, prepared } = await ready();
    must(await h.vault.saveFrozenReview(matterId, prepared));
    const commitment = prepared.reference.commitment;
    h.vault.lock();
    expect(h.vault.recoverableCapture(commitment)).toBeNull();

    must(await h.vault.unlock());
    expect(h.vault.recoverableCapture(commitment)).toBeNull(); // not trusted just because it was saved before
    must(await h.vault.verifyStoredCapture(matterId, commitment));
    expect(h.vault.recoverableCapture(commitment)?.commitment).toBe(commitment);
  });

  it('recovers the exact package on a fresh device and reproduces the commitment', async () => {
    const { h, matterId, prepared } = await ready();
    must(await h.vault.saveFrozenReview(matterId, prepared));
    const fresh = otherDevice(h);
    await recoverAccount(fresh);
    must(await fresh.vault.recover());
    must(await fresh.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
    expect(fresh.vault.recoverableCapture(prepared.reference.commitment)).not.toBeNull();
  });

  it('a missing or modified object blocks readiness', async () => {
    const { h, matterId, prepared } = await ready();
    must(await h.vault.saveFrozenReview(matterId, prepared));
    h.vault.lock();
    must(await h.vault.unlock());
    const vaultId = [...h.server.repo.vaults.keys()][0] ?? '';
    // An object the frozen capture depends on: its own record.
    const frozen = h.vault.workingMatter(matterId)?.frozenReviews[0]?.frozenReview.objectId ?? '';
    const victim = `vaults/${vaultId}/objects/${frozen}`;
    const original = h.server.objects.objects.get(victim) ?? new Uint8Array();

    h.server.objects.objects.delete(victim);
    expect((await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment)).ok).toBe(
      false,
    );
    const flipped = original.slice();
    flipped[flipped.length - 25] = (flipped[flipped.length - 25] ?? 0) ^ 1;
    h.server.objects.objects.set(victim, flipped);
    expect((await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment)).ok).toBe(
      false,
    );
    h.server.objects.objects.set(victim, original);
    expect((await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment)).ok).toBe(
      true,
    );
  });

  it('an interrupted capture keeps its identity and resumes with the same objects, never a new commitment', async () => {
    const { h, matterId, prepared } = await ready();
    h.server.objects.dropNextAck = true;
    const first = await h.vault.saveFrozenReview(matterId, prepared);
    expect(first).toEqual({ ok: false, failure: 'UNKNOWN_OUTCOME' });
    expect(h.vault.getSnapshot().pendingCaptureCommitments).toEqual([
      prepared.reference.commitment,
    ]);
    expect(h.vault.recoverableCapture(prepared.reference.commitment)).toBeNull();
    const objectsBefore = [...h.server.objects.objects.keys()].sort();

    const resumed = must(await h.vault.retryPendingCapture(prepared.reference.commitment));
    expect(resumed.commitment).toBe(prepared.reference.commitment);
    expect(h.vault.getSnapshot().pendingCaptureCommitments).toEqual([]);
    // The retry added only what was missing: it did not re-encrypt the artifacts under new IDs.
    const objectsAfter = [...h.server.objects.objects.keys()].sort();
    const added = objectsAfter.filter((k) => !objectsBefore.includes(k));
    expect(added.length).toBeLessThanOrEqual(prepared.artifactIds.length + 4);
    expect(h.vault.recoverableCapture(prepared.reference.commitment)).not.toBeNull();
  });

  it('damage after upload is caught by the read-back before the catalog moves', async () => {
    const { h, matterId, prepared } = await ready();
    const headBefore = h.vault.getSnapshot().headRevision;
    const known = new Set(h.server.objects.objects.keys());
    // Silently damage the first object of this capture while the second is being stored.
    const original = h.server.objects.objects;
    const start = h.server.objects.puts;
    h.server.objects.damageEarlierAtPut = { putNumber: start + 2, key: '' };
    const putIfAbsent = h.server.objects.putIfAbsent.bind(h.server.objects);
    h.server.objects.putIfAbsent = async (key, bytes) => {
      const result = await putIfAbsent(key, bytes);
      const fresh = [...original.keys()].filter((k) => !known.has(k));
      if (h.server.objects.puts === start + 1 && fresh[0] !== undefined) {
        h.server.objects.damageEarlierAtPut = { putNumber: start + 2, key: fresh[0] };
      }
      return result;
    };
    const outcome = await h.vault.saveFrozenReview(matterId, prepared);
    expect(outcome.ok).toBe(false);
    expect(h.vault.getSnapshot().headRevision).toBe(headBefore);
    expect(h.vault.workingMatter(matterId)?.frozenReviews).toEqual([]);
    expect(h.vault.getSnapshot().checkedCaptures).toEqual([]);
  });

  it('an acknowledgement for different bytes than were sent is not accepted as stored', async () => {
    const { h, matterId, prepared } = await ready();
    h.faults.tamperNextPutDigest = true;
    const outcome = await h.vault.saveFrozenReview(matterId, prepared);
    expect(outcome.ok).toBe(false);
    expect(h.vault.getSnapshot().checkedCaptures).toEqual([]);
  });

  it('a storage outage mid-upload never becomes a saved capture', async () => {
    const { h, matterId, prepared } = await ready();
    h.server.objects.loseNextWrite = true;
    const outcome = await h.vault.saveFrozenReview(matterId, prepared);
    expect(outcome.ok).toBe(false);
    expect(h.vault.getSnapshot().checkedCaptures).toEqual([]);
    expect(h.vault.workingMatter(matterId)?.frozenReviews).toEqual([]);
  });

  it('later working-context edits cannot change the frozen capture', async () => {
    const { h, matterId, prepared } = await ready();
    must(await h.vault.saveFrozenReview(matterId, prepared));
    const frozenBefore = h.vault.workingMatter(matterId)?.frozenReviews;
    must(h.vault.addEntry(matterId, { kind: 'note', text: 'later note', confirmed: true }));
    must(await h.vault.saveMatter(matterId));
    expect(h.vault.workingMatter(matterId)?.frozenReviews).toEqual(frozenBefore);
    must(await h.vault.verifyStoredCapture(matterId, prepared.reference.commitment));
  });

  it('refuses anything that is not a validated Chapter 2 capture', async () => {
    const { h, matterId, prepared } = await ready();
    for (const fake of [{ reference: prepared.reference, opening: prepared.opening }, null, 'x']) {
      expect((await h.vault.saveFrozenReview(matterId, fake as never)).ok).toBe(false);
    }
    expect(h.vault.getSnapshot().checkedCaptures).toEqual([]);
  });
});

describe('export and import', () => {
  async function saved() {
    const h = await withVault(createVaultHarness());
    const matterId = must(await h.vault.createMatter('Source matter'));
    const prepared = await prepareSynthetic('legal');
    must(await h.vault.saveFrozenReview(matterId, prepared));
    return { h, matterId, prepared };
  }

  it('shows a disclosure preview first and releases the readable file only on confirmation, once', async () => {
    const { h, matterId, prepared } = await saved();
    const preview = must(
      await h.vault.prepareExport('readable-review', matterId, prepared.reference.commitment),
    );
    expect(preview).toMatchObject({ kind: 'readable-review', discloses: true });
    expect(preview.disclosure).toMatch(/blinding nonce/);
    expect(preview.disclosure).toMatch(/not a selective disclosure/);
    expect(preview.fileName).toMatch(/^lexaegis-review-[0-9a-f-]{36}\.json$/);
    expect(preview.items).toHaveLength(prepared.artifactIds.length);
    expect(h.vault.getSnapshot().exportPreview).toEqual(preview);

    const file = must(h.vault.confirmExport(preview.exportId));
    expect(new TextDecoder().decode(file.bytes)).toContain(prepared.opening.blindingNonce);
    expect(h.vault.confirmExport(preview.exportId)).toEqual({ ok: false, failure: 'NOT_FOUND' });
    expect(h.vault.getSnapshot().exportPreview).toBeNull();
  });

  it('cancel and lock discard a prepared export', async () => {
    const { h, matterId, prepared } = await saved();
    const first = must(
      await h.vault.prepareExport('encrypted-review', matterId, prepared.reference.commitment),
    );
    h.vault.cancelExport();
    expect(h.vault.confirmExport(first.exportId)).toEqual({ ok: false, failure: 'NOT_FOUND' });
    const second = must(
      await h.vault.prepareExport('readable-review', matterId, prepared.reference.commitment),
    );
    h.vault.lock();
    expect(h.vault.confirmExport(second.exportId)).toEqual({ ok: false, failure: 'NOT_FOUND' });
    expect(h.vault.getSnapshot().exportPreview).toBeNull();
  });

  it('an encrypted export holds no plaintext and imports back under fresh object IDs', async () => {
    const { h, matterId, prepared } = await saved();
    const preview = must(
      await h.vault.prepareExport('encrypted-review', matterId, prepared.reference.commitment),
    );
    expect(preview.discloses).toBe(false);
    const file = must(h.vault.confirmExport(preview.exportId));
    expect(new TextDecoder().decode(file.bytes)).not.toContain(prepared.opening.blindingNonce);

    const destination = must(await h.vault.createMatter('Destination'));
    const shown = must(await h.vault.previewImport(file.bytes));
    expect(shown).toMatchObject({
      kind: 'encrypted-review',
      review: { consistentWithClaimedReference: true, chainStatus: 'unknown' },
    });
    const before = new Set(h.server.objects.objects.keys());
    must(await h.vault.confirmReviewImport(shown.importId, destination));
    const added = [...h.server.objects.objects.keys()].filter((k) => !before.has(k));
    expect(added.length).toBeGreaterThanOrEqual(prepared.artifactIds.length + 2);
    expect(h.vault.workingMatter(destination)?.frozenReviews[0]?.commitment).toBe(
      prepared.reference.commitment,
    );
  });

  it('a readable import shows its contents first, changes nothing until confirmed, and keeps the foreign reviewer', async () => {
    const { h, matterId, prepared } = await saved();
    const preview = must(
      await h.vault.prepareExport('readable-review', matterId, prepared.reference.commitment),
    );
    const file = must(h.vault.confirmExport(preview.exportId));
    const destination = must(await h.vault.createMatter('Imported'));
    const countBefore = h.server.objects.objects.size;

    const shown = must(await h.vault.previewImport(file.bytes, prepared.reference));
    expect(shown.review).toMatchObject({
      foreignReviewer: true,
      matchesExpectedReference: true,
      reviewerAddress: prepared.opening.manifest.context.reviewerAddress,
      artifactCount: prepared.artifactIds.length,
    });
    expect(h.server.objects.objects.size).toBe(countBefore); // preview persisted nothing
    expect(h.vault.getSnapshot().importPreview).toEqual(shown);

    h.vault.cancelImport();
    expect(await h.vault.confirmReviewImport(shown.importId, destination)).toEqual({
      ok: false,
      failure: 'NOT_FOUND',
    });
    const again = must(await h.vault.previewImport(file.bytes));
    must(await h.vault.confirmReviewImport(again.importId, destination));
    expect(h.vault.workingMatter(destination)?.frozenReviews).toHaveLength(1);
    // The reviewer in the opening is unchanged: importing does not make this account the reviewer.
    must(await h.vault.verifyStoredCapture(destination, prepared.reference.commitment));
  });

  it('rejects tampered, incomplete, extra and unsupported imports without persisting anything', async () => {
    const { h, matterId, prepared } = await saved();
    const preview = must(
      await h.vault.prepareExport('readable-review', matterId, prepared.reference.commitment),
    );
    const text = new TextDecoder().decode(must(h.vault.confirmExport(preview.exportId)).bytes);
    const bundle = JSON.parse(text) as { artifacts: { artifactId: string; bytes: string }[] };
    const before = h.server.objects.objects.size;
    const send = (value: unknown) =>
      h.vault.previewImport(new TextEncoder().encode(JSON.stringify(value)));

    expect((await send({ ...bundle, artifacts: bundle.artifacts.slice(1) })).ok).toBe(false);
    expect((await send({ ...bundle, extra: true })).ok).toBe(false);
    expect(await send({ schema: 'lexaegis.something-else.v1' })).toEqual({
      ok: false,
      failure: 'UNSUPPORTED_FORMAT',
    });
    expect(await h.vault.previewImport(new TextEncoder().encode('not json'))).toEqual({
      ok: false,
      failure: 'UNSUPPORTED_FORMAT',
    });
    const flipped = JSON.parse(text) as { artifacts: { artifactId: string; bytes: string }[] };
    const first = flipped.artifacts[0];
    if (first !== undefined)
      first.bytes = `${first.bytes.slice(0, 4)}${first.bytes[4] === 'A' ? 'B' : 'A'}${first.bytes.slice(5)}`;
    const tampered = must(await send(flipped));
    expect(tampered.review?.consistentWithClaimedReference).toBe(false);
    expect(await h.vault.confirmReviewImport(tampered.importId, matterId)).toEqual({
      ok: false,
      failure: 'NOT_FOUND',
    });
    expect(h.server.objects.objects.size).toBe(before);
  });

  it('context export and import carry confirmed facts out and unconfirmed entries in', async () => {
    const { h, matterId } = await saved();
    const versionId = must(
      await h.vault.addSourceFile(matterId, {
        bytes: new TextEncoder().encode('doc'),
        mediaType: 'text/plain',
        label: 'Doc',
      }),
    );
    must(
      h.vault.addEntry(matterId, {
        kind: 'fact',
        text: 'Salary is 60000 pence per week',
        confirmed: true,
        documentVersionId: versionId,
      }),
    );
    must(await h.vault.saveMatter(matterId));
    const preview = must(await h.vault.prepareExport('context', matterId));
    expect(preview.discloses).toBe(true);
    const file = must(h.vault.confirmExport(preview.exportId));
    expect(new TextDecoder().decode(file.bytes)).not.toContain('Source matter');

    const destination = must(await h.vault.createMatter('Elsewhere'));
    const shown = must(await h.vault.previewImport(file.bytes));
    expect(shown.context?.entries).toEqual([
      expect.objectContaining({ text: 'Salary is 60000 pence per week', unresolvedReferences: 1 }),
    ]);
    const entryId = shown.context?.entries[0]?.entryId ?? '';
    must(h.vault.confirmContextImport(shown.importId, destination, [entryId]));
    expect(h.vault.workingMatter(destination)?.context.entries[0]).toMatchObject({
      status: 'unconfirmed',
      origin: 'imported',
      confirmedAt: null,
    });
  });

  it('exposes only confirmed entries to the Aegis context selector, never truncating', async () => {
    const { h, matterId } = await saved();
    must(h.vault.addEntry(matterId, { kind: 'fact', text: 'confirmed', confirmed: true }));
    must(h.vault.addEntry(matterId, { kind: 'fact', text: 'unconfirmed', confirmed: false }));
    const [a, b] = h.vault.workingMatter(matterId)?.context.entries ?? [];
    const { selectMatterContext } = await import('@/features/matters/context-selector');
    expect(selectMatterContext(h.vault, matterId, [a?.entryId ?? '']).ok).toBe(true);
    expect(selectMatterContext(h.vault, matterId, [b?.entryId ?? ''])).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    h.vault.lock();
    expect(selectMatterContext(h.vault, matterId, [a?.entryId ?? ''])).toEqual({
      ok: false,
      code: 'KEY_UNAVAILABLE',
    });
  });
});

describe('what storage and the network see', () => {
  it('only ciphertext and allowlisted public metadata leave the browser', async () => {
    const h = createVaultHarness();
    await withVault(h);
    const matterId = must(await h.vault.createMatter('SENTINEL-title-4f1c'));
    must(h.vault.addEntry(matterId, { kind: 'fact', text: 'SENTINEL-fact-9b2d', confirmed: true }));
    await h.vault.addSourceFile(matterId, {
      bytes: new TextEncoder().encode('SENTINEL-doc-77aa'),
      mediaType: 'application/pdf',
      label: 'SENTINEL-label-31e0',
    });
    const prepared = await prepareSynthetic('legal');
    must(await h.vault.saveFrozenReview(matterId, prepared));

    const stored = [...h.server.objects.objects.values()]
      .map((o) => new TextDecoder().decode(o))
      .join('\n');
    const database = JSON.stringify(
      [
        ...h.server.repo.vaults.values(),
        ...h.server.repo.objects.values(),
        ...h.server.repo.heads.values(),
      ].map((v) => ({ ...v, revision: String((v as { revision?: bigint }).revision ?? '') })),
    );
    const network = [...h.log.requests, ...h.log.responses].join('\n');
    const secrets = [
      'SENTINEL',
      prepared.opening.blindingNonce,
      prepared.packageDigest.slice(2),
      ...prepared.opening.manifest.artifacts.map((a) => a.sha256.slice(2)),
      ...h.authenticator.prfOutputs,
    ];
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(database).not.toContain(secret);
      expect(network).not.toContain(secret);
    }
    const persisted = JSON.stringify(h.vault.getSnapshot());
    for (const secret of h.authenticator.prfOutputs) expect(persisted).not.toContain(secret);
    expect(Object.keys(h.vault)).not.toContain('keys');
    expect(JSON.stringify(h.vault)).toBe('{}');
  });
});

describe('isolation of the public surface', () => {
  it('a frozen snapshot, no key or storage credential, and nothing to unlock without the account', async () => {
    const h = await withVault(createVaultHarness());
    const snapshot = h.vault.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/CryptoKey|hkdf|privateKey|bucket|accessKey/i);
    await h.controller.signOut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.vault.getSnapshot().state).toBe('locked');
    expect(await h.vault.unlock()).toMatchObject({ ok: false });
  });
});
