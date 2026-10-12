import { describe, expect, it } from 'vitest';
import { analyse, type Observations } from '../../tooling/src/privacy/analyse';
import { VaultKeys } from '../../packages/vault/src/crypto/browser-crypto';
import { BINDING, fromHex, vaultVectors } from '../../packages/vault/src/test-vectors';
import {
  chainContradictionViolations,
  forgedApprovalViolations,
  ownershipViolations,
  tamperViolations,
} from './harness/oracles';

/*
 * NEGATIVE CONTROLS (local_integration). Each critical assertion is shown to be non-vacuous: the oracle
 * the owning test calls is given a small, deliberately faulted observation and MUST flag it, and given
 * the correct observation it must not. A control that is not detected fails here with its own name; the
 * validation runner records that as NEGATIVE_CONTROL_UNDETECTED. Everything is synthetic and in memory:
 * no product code carries a fault switch, and nothing here is shipped.
 *
 * Owning tests: tampered artifact -> recovery/vault storage specs and packages/vault tamper tests;
 * cross-account request -> auth-and-ownership; forged approval flag -> approval-races; prohibited
 * outbound canary -> the disclosure-boundary analyser; inconsistent chain observation -> chain-recovery.
 */

describe('[negctl-tampered-artifact-is-detected] a changed sealed artifact never opens', () => {
  it('the oracle flags an implementation that opens a tampered artifact, and passes the real vault', async () => {
    const made = await VaultKeys.fromPrf(fromHex(vaultVectors[0]?.prfOutput ?? '0x'));
    if (!made.ok) throw new Error(made.code);
    const keys = made.data;
    const sealed = await keys.encrypt(
      BINDING,
      new TextEncoder().encode('synthetic artifact'),
      'artifact',
    );
    if (!sealed.ok) throw new Error(sealed.code);
    const intact = sealed.data.bytes;
    // A byte inside the ciphertext, so only the authentication tag can reveal the change.
    const position = intact.length - 8;
    const realOpen = async (bytes: Uint8Array): Promise<boolean> =>
      (
        await keys.decrypt(
          bytes,
          { ...BINDING, ref: undefined, objectId: sealed.data.ref.objectId },
          'artifact',
        )
      ).ok;

    // Real vault: the oracle reports nothing.
    expect(await tamperViolations(realOpen, intact, position)).toEqual([]);
    // Fault: an "opener" that skips authentication. The control must be detected.
    const skipsAuthentication = (): Promise<boolean> => Promise.resolve(true);
    expect(await tamperViolations(skipsAuthentication, intact, position)).toContain(
      'TAMPERED_ARTIFACT_OPENED',
    );
    // Fault: an "opener" that refuses everything is also not a working vault.
    expect(await tamperViolations(() => Promise.resolve(false), intact, position)).toContain(
      'INTACT_ARTIFACT_REFUSED',
    );
  });
});

describe('[negctl-cross-account-request-is-detected] another account never reaches a resource', () => {
  it('the oracle flags a served foreign resource, an existence leak and an unrefused anonymous caller', () => {
    const unknown = { status: 404, code: 'NOT_FOUND' };
    const anonymous = { status: 401, code: 'UNAUTHENTICATED' };
    expect(ownershipViolations({ foreign: unknown, unknown, anonymous })).toEqual([]);
    expect(
      ownershipViolations({ foreign: { status: 200, code: null }, unknown, anonymous }),
    ).toContain('FOREIGN_RESOURCE_SERVED');
    expect(
      ownershipViolations({ foreign: { status: 403, code: 'FORBIDDEN' }, unknown, anonymous }),
    ).toEqual(expect.arrayContaining(['FOREIGN_STATUS_DIFFERS', 'FOREIGN_CODE_DIFFERS']));
    expect(
      ownershipViolations({ foreign: unknown, unknown, anonymous: { status: 200, code: null } }),
    ).toContain('ANONYMOUS_NOT_REFUSED');
  });
});

describe('[negctl-forged-approval-flag-is-detected] a client-set approval changes nothing', () => {
  it('the oracle flags an accepted flag, an advanced operation and a broadcast transaction', () => {
    const held = {
      status: 400,
      phaseBefore: 'quoted',
      phaseAfter: 'quoted',
      transactionCountBefore: 3,
      transactionCountAfter: 3,
    };
    expect(forgedApprovalViolations(held)).toEqual([]);
    expect(forgedApprovalViolations({ ...held, status: 200 })).toContain(
      'FORGED_APPROVAL_ACCEPTED',
    );
    expect(forgedApprovalViolations({ ...held, phaseAfter: 'submitted' })).toContain(
      'OPERATION_ADVANCED',
    );
    expect(forgedApprovalViolations({ ...held, transactionCountAfter: 4 })).toContain(
      'TRANSACTION_BROADCAST',
    );
  });
});

const canary = {
  id: 'negctl-selected-text',
  class: 'selected_text',
  kind: 'text',
  value: 'NEGCTL-CANARY-7f3a91-selected-clause',
} as const;

function journey(overrides: Partial<Observations>): Observations {
  return {
    journey: 'negative-control',
    origin: 'http://127.0.0.1:3000',
    consentedDisclosure: false,
    canaries: [canary],
    storageWrites: [],
    snapshots: [],
    requests: [],
    responses: [],
    providerRequests: '',
    serverLog: '',
    database: '',
    objectStore: [],
    consoleMessages: [],
    serverEgress: [],
    serverEgressAllowed: [],
    unobserved: [],
    ...overrides,
  };
}

describe('[negctl-outbound-canary-is-detected] a private value never reaches a prohibited destination', () => {
  it('the analyser flags a canary in a request to another origin, in a log and in a URL, and not on an allowed route', () => {
    const clean = analyse(journey({}));
    expect(clean.violations).toEqual([]);

    const outside = analyse(
      journey({
        requests: [
          { method: 'POST', url: 'https://collector.invalid/in', body: `x ${canary.value}` },
        ],
      }),
    );
    expect(outside.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(['REQUEST_OUTSIDE_ORIGIN', 'CANARY_IN_FORBIDDEN_DESTINATION']),
    );

    const logged = analyse(journey({ serverLog: `line ${canary.value} line` }));
    expect(logged.violations.some((v) => v.destination === 'server.log')).toBe(true);

    const inUrl = analyse(
      journey({
        requests: [
          { method: 'GET', url: `http://127.0.0.1:3000/api/history/x?q=${canary.value}`, body: '' },
        ],
      }),
    );
    expect(inUrl.violations.some((v) => v.destination === 'request.url')).toBe(true);

    // Without consent the assistant route is forbidden too; with it, the same body is an allowed hit.
    const request = {
      method: 'POST',
      url: 'http://127.0.0.1:3000/api/assistant/runs',
      body: canary.value,
    };
    expect(analyse(journey({ requests: [request] })).violations.length).toBeGreaterThan(0);
    expect(analyse(journey({ consentedDisclosure: true, requests: [request] })).violations).toEqual(
      [],
    );
  });
});

describe('[negctl-inconsistent-chain-observation-is-detected] a contradicting chain is never a second confirmation', () => {
  it('the oracle flags a missing contradiction, a re-confirmation and a moved or removed confirmation', () => {
    const held = {
      mismatch: 'CONTRADICTS_CONFIRMED',
      outcome: 'unknown',
      storedPhase: 'confirmed',
      storedBlockHashBefore: `0x${'aa'.repeat(32)}`,
      storedBlockHashAfter: `0x${'aa'.repeat(32)}`,
    };
    expect(chainContradictionViolations(held)).toEqual([]);
    expect(chainContradictionViolations({ ...held, mismatch: null })).toContain(
      'CONTRADICTION_NOT_REPORTED',
    );
    expect(chainContradictionViolations({ ...held, outcome: 'confirmed' })).toContain(
      'RECONFIRMED_ON_CONTRADICTION',
    );
    expect(chainContradictionViolations({ ...held, storedPhase: 'quoted' })).toContain(
      'STORED_CONFIRMATION_REMOVED',
    );
    expect(
      chainContradictionViolations({ ...held, storedBlockHashAfter: `0x${'de'.repeat(32)}` }),
    ).toContain('STORED_BLOCK_HASH_MOVED');
  });
});
