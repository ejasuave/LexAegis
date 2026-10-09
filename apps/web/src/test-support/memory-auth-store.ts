/**
 * lexaegis-test-only
 * TEST SUPPORT. In-memory AuthStore for unit tests. Deployed authentication state always lives
 * in PostgreSQL; this is never imported by a route, and a missing database never falls back to it.
 */
import type { AuthStore, Challenge, LoginSession } from '@/server/auth/store';

export interface MemoryAuthStore extends AuthStore {
  readonly challenges: Map<string, Challenge>;
  readonly sessions: Map<string, LoginSession & { revokedAt: Date | null }>;
}

export function createMemoryAuthStore(): MemoryAuthStore {
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, LoginSession & { revokedAt: Date | null }>();
  const hits = new Map<string, number>();
  return {
    challenges,
    sessions,
    createChallenge(challenge) {
      challenges.set(challenge.id, { ...challenge, consumedAt: null });
      return Promise.resolve();
    },
    getChallenge(id) {
      return Promise.resolve(challenges.get(id) ?? null);
    },
    consumeChallengeAndCreateSession(input) {
      const challenge = challenges.get(input.challengeId);
      if (
        challenge === undefined ||
        challenge.consumedAt !== null ||
        challenge.expiresAt.getTime() <= input.now.getTime() ||
        challenge.preauthHash !== input.preauthHash
      ) {
        return Promise.resolve(null);
      }
      challenges.set(challenge.id, { ...challenge, consumedAt: input.now });
      if (input.replacesTokenHash !== undefined) {
        const previous = sessions.get(input.replacesTokenHash);
        if (previous !== undefined)
          sessions.set(previous.tokenHash, { ...previous, revokedAt: input.now });
      }
      const session = {
        tokenHash: input.tokenHash,
        address: challenge.address,
        chainId: challenge.chainId,
        createdAt: input.now,
        expiresAt: input.sessionExpiresAt,
      };
      sessions.set(session.tokenHash, { ...session, revokedAt: null });
      return Promise.resolve(session);
    },
    getSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      return Promise.resolve(
        session === undefined ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= now.getTime()
          ? null
          : session,
      );
    },
    revokeSession(tokenHash, now) {
      const session = sessions.get(tokenHash);
      if (session !== undefined && session.revokedAt === null)
        sessions.set(tokenHash, { ...session, revokedAt: now });
      return Promise.resolve();
    },
    allow(bucket, windowStart, limit) {
      const key = `${bucket}@${String(windowStart.getTime())}`;
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      return Promise.resolve(count <= limit);
    },
    cleanup(now) {
      let removed = 0;
      for (const [id, challenge] of challenges) {
        if (challenge.expiresAt.getTime() <= now.getTime()) {
          challenges.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}
