import type { Pool } from 'pg';

/*
 * Persistent authentication state. Stores pending sign-in challenges and backend login
 * sessions only. Bearer tokens and pre-auth cookie values are stored as SHA-256 hashes.
 */

export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Backend login lifetime. Never renewed silently. Unrelated to the signing session. */
export const SESSION_TTL_MS = 15 * 60_000;

export interface Challenge {
  readonly id: string;
  readonly address: string;
  readonly chainId: string;
  readonly message: string;
  readonly preauthHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface LoginSession {
  readonly tokenHash: string;
  readonly address: string;
  readonly chainId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface ConsumeInput {
  readonly challengeId: string;
  readonly preauthHash: string;
  readonly now: Date;
  /** Hash of the new session's bearer token. */
  readonly tokenHash: string;
  readonly sessionExpiresAt: Date;
  /** Hash of the session being replaced, revoked in the same transaction. */
  readonly replacesTokenHash?: string;
}

export interface AuthStore {
  createChallenge(challenge: Omit<Challenge, 'consumedAt'>): Promise<void>;
  getChallenge(id: string): Promise<Challenge | null>;
  /**
   * Atomically consumes an unexpired, unconsumed challenge bound to `preauthHash` and creates
   * its session. Concurrent calls for one challenge create at most one session.
   */
  consumeChallengeAndCreateSession(input: ConsumeInput): Promise<LoginSession | null>;
  /** A session that is neither expired nor revoked at `now`. */
  getSession(tokenHash: string, now: Date): Promise<LoginSession | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  /** Counts one attempt in a shared fixed window; false once the limit is exceeded. */
  allow(bucket: string, windowStart: Date, limit: number): Promise<boolean>;
  /** Deletes at most `limit` expired rows of each kind. */
  cleanup(now: Date, limit: number): Promise<number>;
}

interface ChallengeRow {
  id: string;
  address: string;
  chain_id: string;
  message: string;
  preauth_hash: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}
interface SessionRow {
  token_hash: string;
  address: string;
  chain_id: string;
  created_at: Date;
  expires_at: Date;
}

const toSession = (row: SessionRow): LoginSession => ({
  tokenHash: row.token_hash,
  address: row.address,
  chainId: row.chain_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

export function createPostgresAuthStore(pool: Pool): AuthStore {
  return {
    async createChallenge(c) {
      await pool.query(
        'INSERT INTO auth_challenges (id, address, chain_id, message, preauth_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [c.id, c.address, c.chainId, c.message, c.preauthHash, c.createdAt, c.expiresAt],
      );
    },

    async getChallenge(id) {
      const { rows } = await pool.query<ChallengeRow>(
        'SELECT * FROM auth_challenges WHERE id = $1',
        [id],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            address: row.address,
            chainId: row.chain_id,
            message: row.message,
            preauthHash: row.preauth_hash,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            consumedAt: row.consumed_at,
          };
    },

    async consumeChallengeAndCreateSession(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The row lock taken by this UPDATE serialises concurrent verifications: the second
        // one re-evaluates the WHERE clause after the first commits and matches nothing.
        const consumed = await client.query<{ address: string; chain_id: string }>(
          `UPDATE auth_challenges SET consumed_at = $2
             WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2 AND preauth_hash = $3
           RETURNING address, chain_id`,
          [input.challengeId, input.now, input.preauthHash],
        );
        const row = consumed.rows[0];
        if (row === undefined) {
          await client.query('ROLLBACK');
          return null;
        }
        if (input.replacesTokenHash !== undefined) {
          await client.query(
            'UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
            [input.replacesTokenHash, input.now],
          );
        }
        const created = await client.query<SessionRow>(
          `INSERT INTO auth_sessions (token_hash, address, chain_id, created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5) RETURNING token_hash, address, chain_id, created_at, expires_at`,
          [input.tokenHash, row.address, row.chain_id, input.now, input.sessionExpiresAt],
        );
        await client.query('COMMIT');
        const session = created.rows[0];
        return session === undefined ? null : toSession(session);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async getSession(tokenHash, now) {
      const { rows } = await pool.query<SessionRow>(
        'SELECT token_hash, address, chain_id, created_at, expires_at FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2',
        [tokenHash, now],
      );
      return rows[0] === undefined ? null : toSession(rows[0]);
    },

    async revokeSession(tokenHash, now) {
      await pool.query(
        'UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
        [tokenHash, now],
      );
    },

    async allow(bucket, windowStart, limit) {
      const { rows } = await pool.query<{ hits: number }>(
        `INSERT INTO auth_rate_limits (bucket, window_start, hits) VALUES ($1,$2,1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = auth_rate_limits.hits + 1
         RETURNING hits`,
        [bucket, windowStart],
      );
      return (rows[0]?.hits ?? limit + 1) <= limit;
    },

    async cleanup(now, limit) {
      const statements = [
        'DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at <= $1 LIMIT $2)',
        'DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= $1 LIMIT $2)',
        "DELETE FROM auth_rate_limits WHERE (bucket, window_start) IN (SELECT bucket, window_start FROM auth_rate_limits WHERE window_start <= $1::timestamptz - interval '1 hour' LIMIT $2)",
      ];
      let removed = 0;
      for (const statement of statements)
        removed += (await pool.query(statement, [now, limit])).rowCount ?? 0;
      return removed;
    },
  };
}
