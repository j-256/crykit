-- Retained recipients and service capabilities are encrypted with a service-only key
-- Job identity and keyed request digest coalesce retries without exposing message material
CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'failed', 'complete')),
  delivery TEXT NOT NULL CHECK (delivery IN ('pending', 'unsent', 'accepted', 'uncertain', 'suppressed', 'expired', 'paused', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  code TEXT,
  message_id TEXT,
  resend_of TEXT UNIQUE REFERENCES email_jobs(id)
);
CREATE INDEX email_jobs_due ON email_jobs (state, next_attempt_at);
CREATE INDEX email_jobs_expiry ON email_jobs (expires_at);
CREATE TABLE email_attempts (
  job_id TEXT NOT NULL REFERENCES email_jobs(id),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  lease_token TEXT NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('leased', 'sending', 'unsent', 'accepted', 'uncertain', 'suppressed', 'expired', 'cancelled')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  code TEXT,
  PRIMARY KEY (job_id, attempt)
);
-- Audit contains only stable random IDs and authored states/codes, never transport bodies
CREATE TABLE email_audit (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES email_jobs(id),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_audit_retention ON email_audit (created_at);
