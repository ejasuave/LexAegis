import { z } from 'zod';
import { registrationFileSchema, DISPLAY_LIMITS } from './registration-file';
import type { AgentIdentityResolutionV1 } from './resolve';

/*
 * Bounded, opt-in retrieval of an agent's registration card. The card is untrusted, mutable and
 * remote: it is fetched only when the caller explicitly asks, only from the URI the registry shows
 * NOW (never one read out of imported bytes), only from an origin the CALLER allows, with every
 * limit enforced while reading. What comes back is an inert projection of self-declarations. It is
 * never rendered as HTML or Markdown, never followed, never given to a model, and never described as
 * frozen by a commitment (a commitment covers the reference, not the bytes served today).
 */

export const CARD_LIMITS = Object.freeze({
  deadlineMs: 5_000,
  maxBytes: 32 * 1024,
  maxDepth: 16,
  maxArrayLength: 64,
  maxStringLength: 10_000,
});

export const CARD_REASONS = [
  'AVAILABLE',
  'NOT_OPTED_IN',
  'IDENTITY_NOT_REGISTERED',
  'UNSUPPORTED_CARD_TRANSPORT',
  'TARGET_NOT_CURRENT',
  'URL_NOT_ALLOWED',
  'ORIGIN_NOT_ALLOWED',
  'DESTINATION_FORBIDDEN',
  'TRANSPORT_UNAVAILABLE',
  'FETCH_FAILED',
  'REDIRECT_REFUSED',
  'HTTP_STATUS',
  'TOO_LARGE',
  'TIMEOUT',
  'ABORTED',
  'MALFORMED_JSON',
  'TOO_DEEP_OR_WIDE',
  'UNSAFE_NUMBER',
  'CARD_INVALID',
  'REGISTRATION_TUPLE_MISMATCH',
] as const;
export type CardReason = (typeof CARD_REASONS)[number];

/** The only response surface the reader needs. The transport must decode content-encoding itself. */
export interface CardResponse {
  readonly status: number;
  readonly redirected: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
}
export interface CardTransport {
  /**
   * Performs one GET with no credentials, cookies, referrer or redirect-following. A Node/server
   * transport must resolve DNS, reject non-public results and bind the validated address to the
   * connection; a browser transport is direct and subject to CORS. Without such a transport,
   * retrieval is unavailable.
   */
  get(url: string, options: { readonly signal: AbortSignal }): Promise<CardResponse>;
}

/**
 * Direct browser retrieval: credentials omitted, no referrer, redirects refused, normal CORS. A
 * blocked response stays unavailable; nothing is retried through a backend.
 *
 * @example
 * ```ts
 * import { createBrowserCardTransport } from '@lexaegis/sdk/agent-identity';
 *
 * const transport = createBrowserCardTransport();
 * ```
 */
export function createBrowserCardTransport(fetchImpl: typeof fetch = fetch): CardTransport {
  return {
    async get(url, { signal }) {
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        mode: 'cors',
        headers: { accept: 'application/json' },
        signal,
      });
      return { status: response.status, redirected: response.redirected, body: response.body };
    },
  };
}

// ---- Destination screening ------------------------------------------------------------------------

function ipv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part)))
    return null;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : null;
}

function forbiddenIpv4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * True for any literal host that is not a public unicast address or a plausible public DNS name:
 * loopback, private, link-local, carrier-grade NAT, documentation, multicast, reserved, the cloud
 * metadata addresses, IPv6 unique-local/link-local/loopback/unspecified and IPv4-mapped forms.
 *
 * @example
 * ```ts
 * import { isForbiddenHost } from '@lexaegis/sdk/agent-identity';
 *
 * console.log(isForbiddenHost('169.254.169.254'), isForbiddenHost('app.example.com')); // true false
 * ```
 */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes(':')) {
    const mapped =
      /^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host) ??
      /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mapped?.[1] !== undefined) {
      const address = ipv4(mapped[1]);
      return address === null || forbiddenIpv4(address);
    }
    // Hex-form IPv4-mapped (::ffff:7f00:1) and everything non-global is refused.
    if (/^(?:0{0,4}:){0,6}(?:ffff:)[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(host)) return true;
    const first = Number.parseInt(
      host.split(':')[0] === '' ? '0' : (host.split(':')[0] ?? '0'),
      16,
    );
    if (host === '::' || host === '::1') return true;
    if (Number.isNaN(first)) return true;
    // Documentation, Teredo and 6to4 ranges embed or mimic other addresses: refused.
    if (/^2001:(?:0{0,3}db8|0{0,4}):/.test(host) || first === 0x2002) return true;
    return !(first >= 0x2000 && first <= 0x3fff); // only global unicast 2000::/3 passes
  }
  const address = ipv4(host);
  if (address !== null) return forbiddenIpv4(address);
  if (/^[0-9.x]+$/i.test(host) || /^0x/i.test(host)) return true; // octal/hex/decimal IPv4 spellings
  return (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.home.arpa')
  );
}

// ---- Bounded reading and parsing ------------------------------------------------------------------

async function readBounded(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array | 'TOO_LARGE' | 'TIMEOUT'> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) return 'TIMEOUT';
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // The limit is enforced while reading, whatever Content-Length claimed.
      if (total > max) {
        await reader.cancel();
        return 'TOO_LARGE';
      }
      chunks.push(value);
    }
  } catch {
    return 'TIMEOUT';
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function withinShape(value: unknown, depth = 1): boolean {
  if (depth > CARD_LIMITS.maxDepth) return false;
  if (typeof value === 'string') return value.length <= CARD_LIMITS.maxStringLength;
  if (Array.isArray(value)) {
    return (
      value.length <= CARD_LIMITS.maxArrayLength &&
      value.every((item) => withinShape(item, depth + 1))
    );
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return (
      entries.length <= CARD_LIMITS.maxArrayLength &&
      entries.every(([key, item]) => key.length <= 200 && withinShape(item, depth + 1))
    );
  }
  return true;
}

/** An integer token with 16+ digits cannot be held exactly by a JSON number: refuse, never round. */
const hasUnsafeNumber = (text: string): boolean =>
  /(?<![\d."\\])-?\d{16,}(?![\d."])/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));

function isSafeLink(endpoint: string): boolean {
  try {
    const link = new URL(endpoint);
    return (
      link.protocol === 'https:' &&
      link.username === '' &&
      link.password === '' &&
      !isForbiddenHost(link.hostname)
    );
  } catch {
    return false;
  }
}

const truncate = (value: string, limit: number): { text: string; truncated: boolean } =>
  value.length > limit
    ? { text: `${value.slice(0, limit)}…`, truncated: true }
    : { text: value, truncated: false };

export const agentCardObservationSchema = z.strictObject({
  schema: z.literal('lexaegis.agent-card-observation.v1'),
  status: z.enum(['available', 'unavailable']),
  reason: z.enum(CARD_REASONS),
  /** What the card says about itself. Self-declared, never verified by the review registry. */
  selfDeclared: z.literal(true),
  uri: z.string().nullable(),
  card: z
    .strictObject({
      name: z.string(),
      description: z.string(),
      active: z.boolean(),
      x402Support: z.boolean(),
      supportedTrust: z.array(z.string()),
      /** Only public https links with no credentials; shown as text, never opened automatically. */
      services: z.array(
        z.strictObject({ name: z.string(), endpoint: z.string(), safeLink: z.boolean() }),
      ),
      /** Display was shortened; the stored evidence is not rewritten. */
      displayTruncated: z.boolean(),
    })
    .nullable(),
});
export type AgentCardObservationV1 = z.infer<typeof agentCardObservationSchema>;

export interface FetchCardInput {
  /** Must be literally true: retrieval is never automatic. */
  readonly optIn: true;
  /** A FRESH resolution made in this session. A cardUri read from imported bytes is never fetched. */
  readonly resolution: AgentIdentityResolutionV1;
  /** Which URI to fetch. `captured` is allowed only while it still equals the current on-chain one. */
  readonly target?: 'current' | 'captured';
  /** Exact origins (for example "https://app.example") the CALLER permits. Never from the card or a package. */
  readonly allowedOrigins: readonly string[];
  readonly transport: CardTransport | null;
  readonly signal?: AbortSignal;
}

/**
 * Fetches and projects a registration card. A failure affects card status only: the observed
 * registry identity and every receipt result stay as they were.
 *
 * @example
 * ```ts
 * import { createBrowserCardTransport, fetchAgentCard } from '@lexaegis/sdk/agent-identity';
 * import type { AgentIdentityResolutionV1 } from '@lexaegis/sdk/agent-identity';
 *
 * declare const resolution: AgentIdentityResolutionV1; // from resolveAgentIdentity, this session
 * const card = await fetchAgentCard({
 *   optIn: true,
 *   resolution,
 *   allowedOrigins: ['https://app.example.invalid'],
 *   transport: createBrowserCardTransport(),
 * });
 * console.log(card.status, card.reason);
 * ```
 */
export async function fetchAgentCard(input: FetchCardInput): Promise<AgentCardObservationV1> {
  const make = (
    status: 'available' | 'unavailable',
    reason: CardReason,
    uri: string | null = null,
    card: AgentCardObservationV1['card'] = null,
  ): AgentCardObservationV1 => ({
    schema: 'lexaegis.agent-card-observation.v1',
    status,
    reason,
    selfDeclared: true,
    uri,
    card,
  });
  if ((input.optIn as unknown) !== true) return make('unavailable', 'NOT_OPTED_IN');
  const { resolution } = input;
  if (
    resolution.status !== 'registered' ||
    resolution.agent === null ||
    resolution.reference === null
  ) {
    return make('unavailable', 'IDENTITY_NOT_REGISTERED');
  }
  const { uri } = resolution.agent;
  const wanted = input.target ?? 'current';
  if (wanted === 'captured' && uri.changed) return make('unavailable', 'TARGET_NOT_CURRENT');
  if (uri.transport !== 'https')
    return make('unavailable', 'UNSUPPORTED_CARD_TRANSPORT', uri.current);
  if (input.transport === null) return make('unavailable', 'TRANSPORT_UNAVAILABLE', uri.current);

  let url: URL;
  try {
    url = new URL(uri.current);
  } catch {
    return make('unavailable', 'URL_NOT_ALLOWED', null);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return make('unavailable', 'URL_NOT_ALLOWED', null);
  }
  if (isForbiddenHost(url.hostname)) return make('unavailable', 'DESTINATION_FORBIDDEN', null);
  if (!input.allowedOrigins.includes(url.origin))
    return make('unavailable', 'ORIGIN_NOT_ALLOWED', null);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CARD_LIMITS.deadlineMs);
  const forward = () => timeout.abort();
  input.signal?.addEventListener('abort', forward, { once: true });
  const shown = url.href;
  try {
    let response: CardResponse;
    try {
      response = await input.transport.get(url.href, { signal: timeout.signal });
    } catch {
      return make(
        'unavailable',
        input.signal?.aborted === true
          ? 'ABORTED'
          : timeout.signal.aborted
            ? 'TIMEOUT'
            : 'FETCH_FAILED',
        shown,
      );
    }
    if (response.redirected || (response.status >= 300 && response.status < 400))
      return make('unavailable', 'REDIRECT_REFUSED', shown);
    if (response.status < 200 || response.status >= 300 || response.body === null)
      return make('unavailable', 'HTTP_STATUS', shown);
    const bytes = await readBounded(response.body, CARD_LIMITS.maxBytes, timeout.signal);
    if (bytes === 'TOO_LARGE') return make('unavailable', 'TOO_LARGE', shown);
    if (bytes === 'TIMEOUT')
      return make('unavailable', input.signal?.aborted === true ? 'ABORTED' : 'TIMEOUT', shown);
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      parsed = JSON.parse(text);
    } catch {
      return make('unavailable', 'MALFORMED_JSON', shown);
    }
    if (hasUnsafeNumber(text)) return make('unavailable', 'UNSAFE_NUMBER', shown);
    if (!withinShape(parsed)) return make('unavailable', 'TOO_DEEP_OR_WIDE', shown);
    const card = registrationFileSchema.safeParse(parsed);
    if (!card.success) return make('unavailable', 'CARD_INVALID', shown);

    const ref = resolution.reference;
    const wantedRegistry = `eip155:${ref.chainId}:${ref.identityRegistry}`;
    const matches = card.data.registrations.some(
      (entry) =>
        entry.agentRegistry.toLowerCase() === wantedRegistry &&
        String(entry.agentId) === ref.agentId,
    );
    if (!matches) return make('unavailable', 'REGISTRATION_TUPLE_MISMATCH', shown);

    const name = truncate(card.data.name, DISPLAY_LIMITS.name);
    const description = truncate(card.data.description, DISPLAY_LIMITS.description);
    const services = card.data.services.slice(0, DISPLAY_LIMITS.services).map((service) => {
      const safeLink = isSafeLink(service.endpoint);
      return {
        name: truncate(service.name, 80).text,
        endpoint: truncate(service.endpoint, 200).text,
        safeLink,
      };
    });
    return make('available', 'AVAILABLE', shown, {
      name: name.text,
      description: description.text,
      active: card.data.active,
      x402Support: card.data.x402Support,
      supportedTrust: (card.data.supportedTrust ?? []).slice(0, 8),
      services,
      displayTruncated:
        name.truncated ||
        description.truncated ||
        card.data.services.length > DISPLAY_LIMITS.services,
    });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forward);
  }
}
