-- Pending registration captures the session and revision without replacing working credentials
CREATE TABLE credential_registrations (
  transaction_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  session_id TEXT NOT NULL REFERENCES customer_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('password', 'recovery')),
  credential_revision INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  response TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX credential_registrations_account ON credential_registrations(account_id, transaction_id);
CREATE INDEX credential_registrations_expiry ON credential_registrations(expires_at);
-- Reauthentication attempts cannot be redeemed as new sessions or on another session
ALTER TABLE auth_attempts ADD COLUMN session_id TEXT;
CREATE TABLE pending_email_changes (
  transaction_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  account_revision INTEGER NOT NULL,
  normalized_email TEXT NOT NULL,
  delivery_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  root_job_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX pending_email_changes_account ON pending_email_changes(account_id, consumed_at);
CREATE TABLE account_security_notices (
  transaction_id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  root_job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
