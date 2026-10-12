import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/*
 * A small HTTP client for the application's real routes: a cookie jar, the configured Origin, the JSON
 * content type and the application header. Accounts are plain EOAs signing the server-built EIP-4361
 * message, so the real challenge/verify/session code runs. It proves control of an address only: it
 * does not stand for a passkey, a biometric or a professional identity.
 */

export interface Target {
  /** Where the process listens. */
  readonly baseUrl: string;
  /** The configured application origin (what a request's Origin header must equal). */
  readonly origin: string;
}

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly setCookies: readonly string[];
  readonly text: string;
  json(): unknown;
}

export interface SendOptions {
  readonly method?: string;
  readonly body?: BodyInit | null;
  readonly headers?: Record<string, string>;
  /** `undefined` uses the configured origin; `null` sends none. */
  readonly origin?: string | null;
  /** Add the JSON content type and the application header (default true for a body). */
  readonly guarded?: boolean;
  readonly cookies?: boolean;
  readonly duplex?: boolean;
}

export class Client {
  readonly jar = new Map<string, string>();
  readonly account: PrivateKeyAccount;
  constructor(
    readonly target: Target,
    key: `0x${string}` = generatePrivateKey(),
  ) {
    this.account = privateKeyToAccount(key);
  }

  get address(): string {
    return this.account.address.toLowerCase();
  }

  cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async send(path: string, options: SendOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    const origin = options.origin === undefined ? this.target.origin : options.origin;
    if (origin !== null) headers.origin = origin;
    const hasBody = options.body !== undefined && options.body !== null;
    if (options.guarded ?? hasBody) {
      headers['content-type'] ??= 'application/json';
      headers['x-lexaegis-request'] ??= '1';
    }
    if (options.cookies !== false && this.jar.size > 0) headers.cookie = this.cookieHeader();
    const response = await fetch(`${this.target.baseUrl}${path}`, {
      method: options.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      body: options.body ?? null,
      redirect: 'manual',
      ...(options.duplex === true && { duplex: 'half' }),
    });
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      setCookies,
      text,
      json: () => JSON.parse(text) as unknown,
    };
  }

  postJson(path: string, body: unknown, options: SendOptions = {}): Promise<Reply> {
    return this.send(path, { ...options, method: 'POST', body: JSON.stringify(body) });
  }

  /** The whole sign-in: challenge, a signature over the EXACT message, then verify. */
  async signIn(chainId = '10143'): Promise<Reply> {
    const challenge = await this.postJson('/api/auth/challenge', {
      address: this.address,
      chainId,
    });
    if (challenge.status !== 200) return challenge;
    const view = challenge.json() as { challengeId: string; message: string };
    const signature = await this.account.signMessage({ message: view.message });
    return this.postJson('/api/auth/verify', { challengeId: view.challengeId, signature });
  }
}

export const sessionCookie = (client: Client): string | undefined =>
  [...client.jar.keys()].find((name) => /lexaegis_session$/.test(name));
