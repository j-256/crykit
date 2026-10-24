-- Journals survive account removal and contain only opaque authority and bounded progress
CREATE TABLE service_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('deletion','cleanup')),
  phase TEXT NOT NULL,
  account_id TEXT,
  actor_id TEXT,
  expected_revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  next_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','complete')),
  code TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  UNIQUE(type,account_id)
);
CREATE INDEX service_jobs_due ON service_jobs(outcome,next_at,lease_until);
-- This independent status grant is deliberately excluded from account/auth backup projections
CREATE TABLE deletion_status (
  token_digest TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES service_jobs(id)
);
CREATE TABLE revocation_intents (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES service_jobs(id),
  event TEXT NOT NULL,
  liabilities TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
  cursor TEXT NOT NULL DEFAULT ''
);
CREATE INDEX revocation_intents_job ON revocation_intents(job_id,acknowledged,id);
CREATE TABLE service_audit (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX service_audit_retention ON service_audit(created_at);
-- Deleting accounts cannot acquire new pending device capabilities after the block batch
CREATE TRIGGER deleting_device_approval BEFORE INSERT ON device_approvals
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND access IN ('active','read-only'))
BEGIN SELECT RAISE(ABORT,'account_deleting'); END;

-- Durable revocation/status control liabilities remain globally charged after account removal
ALTER TABLE service_jobs ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,type,phase,account_id,actor_id,expected_revision,attempts,lease_token,lease_until,next_at,outcome,code,request_id,created_at,cursor) AS BLOB))) VIRTUAL;
CREATE TRIGGER service_jobs_insert AFTER INSERT ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER service_jobs_delete AFTER DELETE ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER service_jobs_update AFTER UPDATE ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
ALTER TABLE deletion_status ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(token_digest,job_id) AS BLOB))) VIRTUAL;
CREATE TRIGGER deletion_status_insert AFTER INSERT ON deletion_status BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER deletion_status_delete AFTER DELETE ON deletion_status BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER deletion_status_update AFTER UPDATE ON deletion_status BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
ALTER TABLE revocation_intents ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,job_id,event,liabilities,acknowledged,cursor) AS BLOB))) VIRTUAL;
CREATE TRIGGER revocation_intents_insert AFTER INSERT ON revocation_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER revocation_intents_delete AFTER DELETE ON revocation_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER revocation_intents_update AFTER UPDATE ON revocation_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
ALTER TABLE service_audit ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,job_id,stage,code,created_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER service_audit_insert AFTER INSERT ON service_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER service_audit_delete AFTER DELETE ON service_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER service_audit_update AFTER UPDATE ON service_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER revocation_intent_immutable BEFORE UPDATE ON revocation_intents WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.event IS NOT OLD.event OR NEW.liabilities IS NOT OLD.liabilities OR NEW.cursor IS NOT OLD.cursor OR NEW.acknowledged < OLD.acknowledged BEGIN SELECT RAISE(ABORT,'revocation_intent_immutable'); END;
