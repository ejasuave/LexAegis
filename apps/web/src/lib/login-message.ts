import { getAddress } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';

/*
 * The one EIP-4361 (Sign-In with Ethereum) login message LexAegis uses. The server builds it
 * and the browser checks it before signing, with this same code, so neither side can be handed
 * a message with a different scope. Pure and browser-safe.
 */

export const LOGIN_STATEMENT =
  'Sign in to LexAegis. This signature only signs you in. It does not approve a review or authorise a transaction.';
export const LOGIN_TTL_SECONDS = 300;
const CLOCK_SKEW_MS = 60_000;

export interface LoginFields {
  /** Configured application origin, e.g. https://app.example. Never taken from a request header. */
  readonly origin: string;
  /** Lowercase 0x address of the derived account. */
  readonly address: string;
  /** Decimal chain ID string. */
  readonly chainId: string;
  readonly nonce: string;
  readonly issuedAt: Date;
}

function chainNumber(chainId: string): number | null {
  const value = Number(chainId);
  return /^[1-9][0-9]*$/.test(chainId) && Number.isSafeInteger(value) ? value : null;
}

/** Builds the canonical message. Returns null when a field cannot be expressed. */
export function buildLoginMessage(fields: LoginFields): string | null {
  const chainId = chainNumber(fields.chainId);
  if (chainId === null) return null;
  try {
    const url = new URL(fields.origin);
    return createSiweMessage({
      address: getAddress(fields.address),
      chainId,
      domain: url.host,
      uri: fields.origin,
      version: '1',
      nonce: fields.nonce,
      statement: LOGIN_STATEMENT,
      issuedAt: fields.issuedAt,
      expirationTime: new Date(fields.issuedAt.getTime() + LOGIN_TTL_SECONDS * 1000),
    });
  } catch {
    return null;
  }
}

export interface LoginExpectation {
  readonly origin: string;
  readonly address: string;
  readonly chainId: string;
  /** When known (server side), the stored nonce. */
  readonly nonce?: string;
  readonly now: Date;
}

export type LoginCheck =
  { readonly ok: true; readonly nonce: string; readonly expiresAt: Date } | { readonly ok: false };

/**
 * Accepts a message only if it is exactly the canonical login message for this origin, account
 * and chain, is within its five-minute life, and carries nothing extra (no resources, request
 * ID, not-before or altered statement). Anything else, including arbitrary text, is refused.
 */
export function checkLoginMessage(message: string, expected: LoginExpectation): LoginCheck {
  const parsed = parseSiweMessage(message);
  const { nonce, issuedAt, expirationTime } = parsed;
  if (nonce === undefined || issuedAt === undefined || expirationTime === undefined)
    return { ok: false };
  if (expected.nonce !== undefined && expected.nonce !== nonce) return { ok: false };

  // Rebuilding from the expected values and comparing bytes covers domain, URI, version, chain,
  // address, statement and the absence of any optional field in one step.
  const canonical = buildLoginMessage({
    origin: expected.origin,
    address: expected.address,
    chainId: expected.chainId,
    nonce,
    issuedAt,
  });
  if (canonical === null || canonical !== message) return { ok: false };

  const now = expected.now.getTime();
  if (issuedAt.getTime() > now + CLOCK_SKEW_MS) return { ok: false };
  if (expirationTime.getTime() <= now) return { ok: false };
  return { ok: true, nonce, expiresAt: expirationTime };
}
