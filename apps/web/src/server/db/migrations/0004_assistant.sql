-- Assistant runs (Chapter 9). Operational metadata only: opaque run and request IDs, the
-- authenticated owner, state, lease, deadline, cancellation flag and counters. No matter ID,
-- title, document reference, source hash, snapshot digest, prompt, answer or tool payload.

CREATE TABLE assistant_runs (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  client_request_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','awaiting_input','stopping','completed','cancelled','failed','interrupted')),
  outcome text CHECK (outcome IN ('completed','needs_input','limited_scope','cancelled','failed','interrupted')),
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  provider_attempts integer NOT NULL DEFAULT 0,
  tool_executions integer NOT NULL DEFAULT 0,
  reserved_input_tokens integer NOT NULL DEFAULT 0,
  reserved_output_tokens integer NOT NULL DEFAULT 0,
  reported_input_tokens integer,
  reported_output_tokens integer,
  usage_provenance text NOT NULL DEFAULT 'none' CHECK (usage_provenance IN ('provider_reported','partially_reported','unknown','none')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- A repeated request ID from the same account is a repeated admission, never a second run.
  UNIQUE (owner, client_request_id)
);
CREATE INDEX assistant_runs_active ON assistant_runs (owner)
  WHERE state IN ('queued','running','stopping');
CREATE INDEX assistant_runs_updated ON assistant_runs (updated_at);

-- Admitted runs per account and globally, per UTC day. scope is 'global' or 'owner:<address>'.
CREATE TABLE assistant_quota (
  scope text NOT NULL,
  utc_day date NOT NULL,
  admitted integer NOT NULL,
  PRIMARY KEY (scope, utc_day)
);

-- Synthetic capability checks, keyed by a fingerprint of provider, host, path, model and output
-- mode. A changed configuration has no row and is therefore unverified.
CREATE TABLE assistant_capability_checks (
  fingerprint text PRIMARY KEY,
  record jsonb NOT NULL,
  verified boolean NOT NULL,
  checked_at timestamptz NOT NULL
);
