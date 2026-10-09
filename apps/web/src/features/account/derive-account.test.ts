import { describe, expect, it } from 'vitest';
import vectors from '../../../../../fixtures/account-v1/vectors.json';
import { detectCapabilities } from './capabilities';
import { resolveAccountConfig } from './config';
import { deriveAccount } from './derive-account';
import {
  EVM_PATH,
  PRF_SALT_LABELS,
  PROFILE_ID,
  accountPrfSalt,
  forgetProfileHint,
  loadProfileHint,
  publicAccountProfileSchema,
  saveProfileHint,
  vaultPrfSalt,
  type PublicAccountProfile,
} from './derivation-profile';

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
const hex = (value: Uint8Array) => `0x${Buffer.from(value).toString('hex')}`;
const sha256 = async (text: string) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

describe('derivation profile v1', () => {
  it('is the frozen profile the independent vectors describe', () => {
    expect(PROFILE_ID).toBe('lexaegis.evm.bip32-prf.v1');
    expect(PROFILE_ID).toBe(vectors.profileId);
    expect(EVM_PATH).toBe("m/44'/60'/0'/0/0");
    expect(EVM_PATH).toBe(vectors.path);
  });

  it('has 32-byte salts equal to SHA-256 of their labels, and distinct from each other', async () => {
    expect(accountPrfSalt()).toHaveLength(32);
    expect(hex(accountPrfSalt())).toBe(await sha256(PRF_SALT_LABELS.account));
    expect(hex(vaultPrfSalt())).toBe(await sha256(PRF_SALT_LABELS.vault));
    expect(hex(accountPrfSalt())).toBe(vectors.salts.account.sha256);
    expect(hex(vaultPrfSalt())).toBe(vectors.salts.vault.sha256);
    expect(hex(accountPrfSalt())).not.toBe(hex(vaultPrfSalt()));
  });

  it('hands out a fresh salt copy each time, so a zeroed copy cannot corrupt the next ceremony', () => {
    const first = accountPrfSalt();
    first.fill(0);
    expect(hex(accountPrfSalt())).toBe(vectors.salts.account.sha256);
  });
});

describe('deriveAccount', () => {
  it.each(vectors.cases.map((item) => [item.id, item] as const))(
    'reproduces the literal address for %s',
    (_id, vector) => {
      const derived = deriveAccount(bytes(vector.prfOutput));
      if (!derived.ok) throw new Error(derived.code);
      expect(derived.data.address).toBe(vector.address);
      expect(derived.data.checksumAddress.toLowerCase()).toBe(vector.address);
      expect(derived.data.account.address).toBe(derived.data.checksumAddress);
      // The next index is a different account: a path change can never restore silently.
      expect(derived.data.address).not.toBe(vector.addressAtNextIndex);
      derived.data.session.end();
    },
  );

  it('gives a different account for a different PRF output', () => {
    const input = bytes(vectors.cases[0]?.prfOutput ?? '0x');
    input[31] = (input[31] ?? 0) ^ 1;
    const derived = deriveAccount(input);
    expect(derived.ok && derived.data.address).not.toBe(vectors.cases[0]?.address);
  });

  it('consumes the PRF buffer: it is zeroed on success and on failure', () => {
    const good = bytes(vectors.cases[1]?.prfOutput ?? '0x');
    expect(deriveAccount(good).ok).toBe(true);
    expect(good.every((value) => value === 0)).toBe(true);

    const short = new Uint8Array(31).fill(7);
    expect(deriveAccount(short)).toEqual({ ok: false, code: 'FAILED' });
    expect(short.every((value) => value === 0)).toBe(true);
  });

  it('fails explicitly on bad input and never substitutes a random key', () => {
    for (const length of [0, 16, 33, 64]) {
      expect(deriveAccount(new Uint8Array(length).fill(1))).toEqual({ ok: false, code: 'FAILED' });
    }
  });

  it('produces a session whose signing stops for good once ended', async () => {
    const derived = deriveAccount(bytes(vectors.cases[2]?.prfOutput ?? '0x'));
    if (!derived.ok) throw new Error(derived.code);
    await expect(derived.data.account.signMessage({ message: 'x' })).resolves.toMatch(/^0x/);
    derived.data.session.end();
    await expect(derived.data.account.signMessage({ message: 'x' })).rejects.toMatchObject({
      code: 'SESSION_ENDED',
    });
  });
});

const PUBLIC = {
  appOrigin: 'https://app.lexaegis.test',
  webauthnRpId: 'app.lexaegis.test',
  chainId: '10143',
};

describe('account configuration', () => {
  it('accepts an exact-hostname rpId over HTTPS and localhost over HTTP', () => {
    expect(resolveAccountConfig(PUBLIC)).toMatchObject({
      ok: true,
      data: { rpId: 'app.lexaegis.test', registryAddress: null },
    });
    expect(
      resolveAccountConfig({
        appOrigin: 'http://localhost:3000',
        webauthnRpId: 'localhost',
        chainId: '10143',
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['a parent-domain rpId', { ...PUBLIC, webauthnRpId: 'lexaegis.test' }],
    ['an unrelated rpId', { ...PUBLIC, webauthnRpId: 'evil.test' }],
    ['plain HTTP off localhost', { ...PUBLIC, appOrigin: 'http://app.lexaegis.test' }],
    [
      'a port in the rpId',
      {
        ...PUBLIC,
        appOrigin: 'https://app.lexaegis.test:8443',
        webauthnRpId: 'app.lexaegis.test:8443',
      },
    ],
    ['an origin with a path', { ...PUBLIC, appOrigin: 'https://app.lexaegis.test/app' }],
    ['a missing chain', { ...PUBLIC, chainId: undefined }],
    ['a missing rpId', { ...PUBLIC, webauthnRpId: undefined }],
  ])('rejects %s', (_label, config) => {
    expect(resolveAccountConfig(config)).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  });

  it('compares origins including the port, and rejects a page served from another origin', () => {
    const config = { ...PUBLIC, appOrigin: 'https://app.lexaegis.test:8443' };
    expect(resolveAccountConfig(config, 'https://app.lexaegis.test:8443').ok).toBe(true);
    expect(resolveAccountConfig(config, 'https://app.lexaegis.test').ok).toBe(false);
    expect(resolveAccountConfig(PUBLIC, 'https://preview-123.lexaegis.test').ok).toBe(false);
  });
});

describe('capability detection', () => {
  const full = {
    isSecureContext: true,
    navigator: { credentials: {} },
    PublicKeyCredential: () => undefined,
    crypto: { getRandomValues: () => undefined, subtle: {} },
  };

  it('reports available only as a preliminary answer when every API exists', () => {
    expect(detectCapabilities(full)).toEqual({ state: 'available', missing: [] });
  });

  it('names what is missing', () => {
    expect(detectCapabilities({ ...full, isSecureContext: false }).missing).toEqual([
      'secure-context',
    ]);
    expect(detectCapabilities({ ...full, navigator: {} }).missing).toEqual(['credentials']);
    expect(detectCapabilities({}).state).toBe('unsupported');
  });
});

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

const PROFILE: PublicAccountProfile = {
  schema: 'lexaegis.account-profile.v1',
  profileId: PROFILE_ID,
  rpId: 'app.lexaegis.test',
  credentialId: 'AAECAwQFBgcICQoLDA0ODw',
  transports: ['internal'],
  address: vectors.cases[0]?.address ?? '',
};

describe('public account profile', () => {
  it('is closed: only public metadata fits', () => {
    expect(publicAccountProfileSchema.safeParse(PROFILE).success).toBe(true);
    for (const extra of [
      { prfOutput: '0x00' },
      { privateKey: '0x00' },
      { label: 'me' },
      { chainId: '10143' },
    ]) {
      expect(publicAccountProfileSchema.safeParse({ ...PROFILE, ...extra }).success).toBe(false);
    }
    expect(
      publicAccountProfileSchema.safeParse({ ...PROFILE, profileId: 'lexaegis.evm.bip32-prf.v2' })
        .success,
    ).toBe(false);
    expect(
      publicAccountProfileSchema.safeParse({ ...PROFILE, credentialId: 'has+plus/slash=' }).success,
    ).toBe(false);
    expect(
      publicAccountProfileSchema.safeParse({ ...PROFILE, address: PROFILE.address.toUpperCase() })
        .success,
    ).toBe(false);
    expect(
      publicAccountProfileSchema.safeParse({ ...PROFILE, transports: Array(9).fill('usb') })
        .success,
    ).toBe(false);
  });

  it('round-trips through the cache and ignores tampered, oversized or foreign hints', () => {
    const storage = new MemoryStorage();
    saveProfileHint(storage, PROFILE);
    expect(loadProfileHint(storage, 'app.lexaegis.test')).toEqual(PROFILE);
    expect(loadProfileHint(storage, 'other.test')).toBeNull();

    const key = [...storage.items.keys()][0] ?? '';
    for (const tampered of [
      'not json',
      JSON.stringify({ ...PROFILE, admin: true }),
      JSON.stringify(null),
      'x'.repeat(5000),
    ]) {
      storage.items.set(key, tampered);
      expect(loadProfileHint(storage, 'app.lexaegis.test')).toBeNull();
    }
    forgetProfileHint(storage);
    expect(storage.items.size).toBe(0);
  });
});
