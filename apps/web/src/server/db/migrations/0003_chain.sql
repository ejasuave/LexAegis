-- Chain operations and testnet funding (Chapter 6). Public action identity only: no matter name,
-- package hash, opening, artifact, user action signature or raw signed user transaction. The
-- funding outbox holds a service-signed transaction (never a key); user signed bytes never land here.

CREATE TABLE chain_operations (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('execute', 'invalidate_nonce')),
  idempotency_key text NOT NULL,
  intent_hash text NOT NULL,
  chain_id text NOT NULL,
  registry_address text NOT NULL,
  commitment text,
  action_digest text,
  registry_nonce numeric(78,0) NOT NULL,
  transaction_nonce numeric(78,0),
  transaction_hash text,
  calldata_hash text,
  quote_hash text,
  phase text NOT NULL CHECK (phase IN ('reserved','quoted','submitting','submitted','pending','included','confirmed','reverted','replaced','unknown','cancelled')),
  lease_expires_at timestamptz,
  block_number numeric(78,0),
  block_hash text,
  charged_fee_wei numeric(78,0),
  executed_via_other boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner, kind, idempotency_key)
);
CREATE INDEX chain_operations_owner ON chain_operations (owner, created_at DESC);
CREATE UNIQUE INDEX chain_operations_hash ON chain_operations (transaction_hash) WHERE transaction_hash IS NOT NULL;
-- At most one unresolved operation per chain and account, across tabs, devices and processes.
CREATE UNIQUE INDEX chain_operations_one_active ON chain_operations (chain_id, owner)
  WHERE phase IN ('reserved','quoted','submitting','submitted','pending','included','unknown');

CREATE TABLE funding_grants (
  id uuid PRIMARY KEY,
  recipient text NOT NULL,
  chain_id text NOT NULL,
  utc_day date NOT NULL,
  amount_wei numeric(78,0) NOT NULL,
  reserved_fee_wei numeric(78,0) NOT NULL,
  phase text NOT NULL CHECK (phase IN ('reserved','signed','broadcast','confirmed','reverted','unknown')),
  funder_nonce numeric(78,0),
  transaction_hash text,
  outbox_raw text,
  charged_fee_wei numeric(78,0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX funding_grants_recipient ON funding_grants (recipient, created_at DESC);
CREATE INDEX funding_grants_day ON funding_grants (chain_id, utc_day);
-- At most one unresolved outgoing funding transaction per chain (the funder nonce lease).
CREATE UNIQUE INDEX funding_grants_one_unresolved ON funding_grants (chain_id)
  WHERE phase IN ('reserved','signed','broadcast','unknown');
