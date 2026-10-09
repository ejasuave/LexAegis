-- Authentication storage (Chapter 4). Holds no signing key, PRF output, plaintext bearer token
-- or legal content. A row in auth_sessions is a backend login, not a signing session.

CREATE TABLE auth_challenges (
  id text PRIMARY KEY,
  address text NOT NULL,
  chain_id text NOT NULL,
  message text NOT NULL,
  preauth_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX auth_challenges_expires_at ON auth_challenges (expires_at);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  address text NOT NULL,
  chain_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_expires_at ON auth_sessions (expires_at);

CREATE TABLE auth_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
