-- Encrypted evidence vault (Chapter 5). Stores only public descriptors, opaque object IDs,
-- ciphertext lengths and digests, revisions and operational timestamps. Titles, document
-- hashes, extracted text, context, opening nonces and review contents live inside
-- browser-encrypted objects and never reach these tables.

CREATE TABLE vaults (
  vault_id uuid PRIMARY KEY,
  owner_address text NOT NULL,
  rp_id text NOT NULL,
  account_profile_id text NOT NULL,
  -- "creating" vaults are invisible to discovery until their catalog and head exist.
  state text NOT NULL CHECK (state IN ('creating', 'ready')),
  created_at timestamptz NOT NULL,
  -- Quotas count every reserved or stored object, including unreachable ones. No GC.
  object_count integer NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  -- One vault per account, rpId and profile. The chain ID is deliberately not part of this.
  UNIQUE (owner_address, rp_id, account_profile_id)
);

CREATE TABLE vault_objects (
  vault_id uuid NOT NULL REFERENCES vaults (vault_id),
  object_id uuid NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'ready')),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  -- Per vault, so one account can never probe another account's object IDs.
  PRIMARY KEY (vault_id, object_id)
);

CREATE TABLE vault_heads (
  vault_id uuid PRIMARY KEY REFERENCES vaults (vault_id),
  revision numeric(20, 0) NOT NULL CHECK (revision >= 0),
  catalog_object_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (vault_id, catalog_object_id) REFERENCES vault_objects (vault_id, object_id)
);
