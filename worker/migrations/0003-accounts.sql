CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  delivery_email TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  access TEXT NOT NULL DEFAULT 'active' CHECK (access IN ('active', 'read-only', 'blocked', 'deleting')),
  revision INTEGER NOT NULL DEFAULT 1,
  capacity_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE credentials (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('password', 'recovery')),
  credential_id TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL,
  account_envelope TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, role)
);
-- Reservations and encrypted roots remain separate from activated accounts
CREATE TABLE pending_registrations (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL UNIQUE,
  normalized_email TEXT NOT NULL UNIQUE,
  delivery_email TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  registration_record TEXT,
  account_envelope TEXT,
  transaction_id TEXT UNIQUE,
  verification_revision INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pending_registrations_expiry ON pending_registrations(expires_at);
CREATE TABLE auth_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  receipt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_transactions_account ON auth_transactions(account_id, id);
CREATE TABLE verification_capabilities (
  token_hash TEXT PRIMARY KEY NOT NULL,
  pending_id TEXT NOT NULL REFERENCES pending_registrations(id) ON DELETE CASCADE,
  root_job_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX verification_capabilities_pending ON verification_capabilities(pending_id);
CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT,
  role TEXT NOT NULL,
  credential_revision INTEGER,
  server_state TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_attempts_account ON auth_attempts(account_id, id);
CREATE INDEX auth_attempts_expiry ON auth_attempts(expires_at);
CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX devices_account ON devices(account_id, id);
CREATE TABLE customer_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  authenticated_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  remembered INTEGER NOT NULL CHECK (remembered IN (0, 1)),
  revoked_at INTEGER
);
CREATE INDEX customer_sessions_account ON customer_sessions(account_id, id);
CREATE INDEX customer_sessions_expiry ON customer_sessions(absolute_expires_at);
CREATE TABLE rate_counters (
  id TEXT PRIMARY KEY NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_counters_expiry ON rate_counters(expires_at);
