import { z } from 'zod';
import {
  REQUEST_HEADER,
  challengeViewSchema,
  sessionViewSchema,
  type ChallengeView,
  type SessionView,
} from '@/lib/auth-schema';
import { failWith, succeed, type AccountResult } from './errors';

/** Browser client for the backend sign-in routes. The session token lives only in an HttpOnly cookie. */
export interface AuthClient {
  challenge(address: string, chainId: string): Promise<AccountResult<ChallengeView>>;
  verify(challengeId: string, signature: string): Promise<AccountResult<SessionView>>;
  /** The current backend identity, or null when not signed in. */
  me(): Promise<AccountResult<SessionView | null>>;
  logout(): Promise<AccountResult<null>>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function call<T>(
  fetcher: Fetch,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<AccountResult<T> | 'unauthenticated'> {
  let response: Response;
  try {
    response = await fetcher(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify(body),
      }),
    });
  } catch {
    return failWith('BACKEND_UNAVAILABLE');
  }
  if (response.status === 401) return 'unauthenticated';
  if (response.status >= 500) return failWith('BACKEND_UNAVAILABLE');
  if (!response.ok) return failWith('BACKEND_REJECTED');
  try {
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? succeed(parsed.data) : failWith('BACKEND_REJECTED');
  } catch {
    return failWith('BACKEND_REJECTED');
  }
}

const rejected = <T>(result: AccountResult<T> | 'unauthenticated'): AccountResult<T> =>
  result === 'unauthenticated' ? failWith('BACKEND_REJECTED') : result;

export function createAuthClient(fetcher: Fetch = (input, init) => fetch(input, init)): AuthClient {
  return {
    challenge: async (address, chainId) =>
      rejected(
        await call(fetcher, '/api/auth/challenge', challengeViewSchema, { address, chainId }),
      ),
    verify: async (challengeId, signature) =>
      rejected(
        await call(fetcher, '/api/auth/verify', sessionViewSchema, { challengeId, signature }),
      ),
    me: async () => {
      const result = await call(fetcher, '/api/auth/me', sessionViewSchema);
      return result === 'unauthenticated' ? succeed(null) : result;
    },
    logout: async () => {
      const result = await call(
        fetcher,
        '/api/auth/logout',
        z.strictObject({ signedOut: z.literal(true) }),
        {},
      );
      if (result === 'unauthenticated') return succeed(null);
      return result.ok ? succeed(null) : result;
    },
  };
}
