-- Identity and role authority is server-owned and independent of customer accounts
CREATE TABLE operators (
  id TEXT PRIMARY KEY NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','administrator')),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(issuer,subject)
);
CREATE UNIQUE INDEX operators_single_owner ON operators(role) WHERE role = 'owner';
CREATE TABLE admin_access_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX admin_access_sessions_expiry ON admin_access_sessions(expires_at,id);
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  membership_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at,id);
CREATE TABLE admin_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  session_id TEXT NOT NULL REFERENCES admin_sessions(id),
  membership_revision INTEGER NOT NULL,
  command_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_until INTEGER
);
CREATE INDEX admin_confirmations_command ON admin_confirmations(session_id,command_digest,confirmed_until);
CREATE INDEX admin_confirmations_expiry ON admin_confirmations(expires_at,id);
-- Intent remains after audit retention so retry cannot bootstrap a replacement owner
CREATE TABLE admin_bootstrap_intents (
  id TEXT PRIMARY KEY NOT NULL,
  operator_id TEXT NOT NULL UNIQUE REFERENCES operators(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL
);
CREATE TABLE admin_security_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('owner-bootstrap','action-confirmation')),
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_security_audit_cursor ON admin_security_audit(created_at,id);
-- Revocation or revision changes invalidate both sessions and their captured confirmations
-- Zero marks invalidation without inventing a timestamp; command audit owns the event time
CREATE TRIGGER operators_invalidate AFTER UPDATE OF state,revision ON operators
WHEN NEW.state IS NOT OLD.state OR NEW.revision IS NOT OLD.revision
BEGIN
  UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, 0) WHERE operator_id = NEW.id;
  DELETE FROM admin_confirmations WHERE operator_id = NEW.id;
END;
CREATE TRIGGER operators_identity_immutable BEFORE UPDATE ON operators
WHEN NEW.id IS NOT OLD.id OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.revision < OLD.revision OR (NEW.role IS NOT OLD.role AND NEW.revision <= OLD.revision)
BEGIN SELECT RAISE(ABORT,'operator_identity_immutable'); END;
CREATE TRIGGER admin_security_audit_immutable BEFORE UPDATE ON admin_security_audit BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE operators ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,issuer,subject,email,role,state,revision,created_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER operators_charge_insert AFTER INSERT ON operators BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER operators_closed_insert BEFORE INSERT ON operators WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER operators_charge_delete AFTER DELETE ON operators BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER operators_closed_delete BEFORE DELETE ON operators WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER operators_charge_update AFTER UPDATE ON operators BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER operators_closed_update BEFORE UPDATE ON operators WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE admin_access_sessions ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,token_hash,issuer,subject,created_at,expires_at,revoked_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_access_sessions_charge_insert AFTER INSERT ON admin_access_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_access_sessions_closed_insert BEFORE INSERT ON admin_access_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_access_sessions_charge_delete AFTER DELETE ON admin_access_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_access_sessions_closed_delete BEFORE DELETE ON admin_access_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_access_sessions_charge_update AFTER UPDATE ON admin_access_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER admin_access_sessions_closed_update BEFORE UPDATE ON admin_access_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE admin_sessions ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,token_hash,operator_id,membership_revision,created_at,expires_at,revoked_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_sessions_charge_insert AFTER INSERT ON admin_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_sessions_closed_insert BEFORE INSERT ON admin_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_sessions_charge_delete AFTER DELETE ON admin_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_sessions_closed_delete BEFORE DELETE ON admin_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_sessions_charge_update AFTER UPDATE ON admin_sessions BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER admin_sessions_closed_update BEFORE UPDATE ON admin_sessions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE admin_confirmations ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,operator_id,session_id,membership_revision,command_digest,created_at,expires_at,confirmed_until) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_confirmations_charge_insert AFTER INSERT ON admin_confirmations BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_confirmations_closed_insert BEFORE INSERT ON admin_confirmations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_confirmations_charge_delete AFTER DELETE ON admin_confirmations BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_confirmations_closed_delete BEFORE DELETE ON admin_confirmations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_confirmations_charge_update AFTER UPDATE ON admin_confirmations BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER admin_confirmations_closed_update BEFORE UPDATE ON admin_confirmations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE admin_bootstrap_intents ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,operator_id,issuer,subject) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_bootstrap_intents_charge_insert AFTER INSERT ON admin_bootstrap_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_bootstrap_intents_closed_insert BEFORE INSERT ON admin_bootstrap_intents WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_bootstrap_intents_charge_delete AFTER DELETE ON admin_bootstrap_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_bootstrap_intents_closed_delete BEFORE DELETE ON admin_bootstrap_intents WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_bootstrap_intents_charge_update AFTER UPDATE ON admin_bootstrap_intents BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER admin_bootstrap_intents_closed_update BEFORE UPDATE ON admin_bootstrap_intents WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;

-- Charge actual admin metadata; the recovery layer owns projection and restore invalidation
ALTER TABLE admin_security_audit ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,actor_id,action,target_id,request_id,created_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_security_audit_charge_insert AFTER INSERT ON admin_security_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes,metadata_rows = metadata_rows + 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_security_audit_closed_insert BEFORE INSERT ON admin_security_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_security_audit_charge_delete AFTER DELETE ON admin_security_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes,metadata_rows = metadata_rows - 1 WHERE scope = 'global'; END;
CREATE TRIGGER admin_security_audit_closed_delete BEFORE DELETE ON admin_security_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_security_audit_charge_update AFTER UPDATE ON admin_security_audit BEGIN UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global'; END;
CREATE TRIGGER admin_security_audit_closed_update BEFORE UPDATE ON admin_security_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
