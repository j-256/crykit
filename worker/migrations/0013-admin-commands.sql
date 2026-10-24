-- Receipts and audits retain opaque targets after profile deletion; no customer FK cascades
CREATE TABLE admin_actions (id TEXT PRIMARY KEY NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, digest TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE admin_actions ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,actor_id,action,digest,target_kind,target_id,receipt,created_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_actions_charge_insert AFTER INSERT ON admin_actions BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes,metadata_rows=metadata_rows+1 WHERE scope='global'; END;
CREATE TRIGGER admin_actions_closed_insert BEFORE INSERT ON admin_actions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_actions_charge_delete AFTER DELETE ON admin_actions BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+-OLD.metadata_bytes,metadata_rows=metadata_rows-1 WHERE scope='global'; END;
CREATE TRIGGER admin_actions_closed_delete BEFORE DELETE ON admin_actions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_actions_charge_update AFTER UPDATE ON admin_actions BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes-OLD.metadata_bytes WHERE scope='global'; END;
CREATE TRIGGER admin_actions_closed_update BEFORE UPDATE ON admin_actions WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TABLE admin_previews (id TEXT PRIMARY KEY NOT NULL, actor_id TEXT NOT NULL, session_id TEXT NOT NULL, digest TEXT NOT NULL, settings_revision INTEGER NOT NULL, expires_at INTEGER NOT NULL);
ALTER TABLE admin_previews ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,actor_id,session_id,digest,settings_revision,expires_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_previews_charge_insert AFTER INSERT ON admin_previews BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes,metadata_rows=metadata_rows+1 WHERE scope='global'; END;
CREATE TRIGGER admin_previews_closed_insert BEFORE INSERT ON admin_previews WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_previews_charge_delete AFTER DELETE ON admin_previews BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+-OLD.metadata_bytes,metadata_rows=metadata_rows-1 WHERE scope='global'; END;
CREATE TRIGGER admin_previews_closed_delete BEFORE DELETE ON admin_previews WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_previews_charge_update AFTER UPDATE ON admin_previews BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes-OLD.metadata_bytes WHERE scope='global'; END;
CREATE TRIGGER admin_previews_closed_update BEFORE UPDATE ON admin_previews WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TABLE admin_audit (id TEXT PRIMARY KEY NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, action_id TEXT, reason TEXT CHECK(reason IN ('support','security','abuse','maintenance','user-request','operations')), case_id TEXT CHECK(case_id IS NULL OR (length(case_id) BETWEEN 1 AND 64 AND case_id NOT GLOB '*[^A-Za-z0-9_.:-]*')), outcome TEXT NOT NULL CHECK(outcome IN ('complete','queued','denied','read')), policy_before TEXT, policy_after TEXT, request_id TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE admin_audit ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,actor_id,action,target_kind,target_id,action_id,reason,case_id,outcome,policy_before,policy_after,request_id,created_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_audit_charge_insert AFTER INSERT ON admin_audit BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes,metadata_rows=metadata_rows+1 WHERE scope='global'; END;
CREATE TRIGGER admin_audit_closed_insert BEFORE INSERT ON admin_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_audit_charge_delete AFTER DELETE ON admin_audit BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+-OLD.metadata_bytes,metadata_rows=metadata_rows-1 WHERE scope='global'; END;
CREATE TRIGGER admin_audit_closed_delete BEFORE DELETE ON admin_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_audit_charge_update AFTER UPDATE ON admin_audit BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes-OLD.metadata_bytes WHERE scope='global'; END;
CREATE TRIGGER admin_audit_closed_update BEFORE UPDATE ON admin_audit WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TABLE admin_invitations (id TEXT PRIMARY KEY NOT NULL, normalized_email TEXT NOT NULL, delivery_email TEXT NOT NULL, role TEXT NOT NULL CHECK(role='administrator'), state TEXT NOT NULL CHECK(state IN ('pending','accepted','cancelled')), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), token_hash TEXT NOT NULL UNIQUE, root_job_id TEXT NOT NULL, created_by TEXT NOT NULL, accepted_by TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
ALTER TABLE admin_invitations ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,normalized_email,delivery_email,role,state,revision,token_hash,root_job_id,created_by,accepted_by,created_at,expires_at) AS BLOB))) VIRTUAL;
CREATE TRIGGER admin_invitations_charge_insert AFTER INSERT ON admin_invitations BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes,metadata_rows=metadata_rows+1 WHERE scope='global'; END;
CREATE TRIGGER admin_invitations_closed_insert BEFORE INSERT ON admin_invitations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_invitations_charge_delete AFTER DELETE ON admin_invitations BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+-OLD.metadata_bytes,metadata_rows=metadata_rows-1 WHERE scope='global'; END;
CREATE TRIGGER admin_invitations_closed_delete BEFORE DELETE ON admin_invitations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER admin_invitations_charge_update AFTER UPDATE ON admin_invitations BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes-OLD.metadata_bytes WHERE scope='global'; END;
CREATE TRIGGER admin_invitations_closed_update BEFORE UPDATE ON admin_invitations WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TABLE service_settings (id TEXT PRIMARY KEY NOT NULL CHECK(id='service'), revision INTEGER NOT NULL CHECK(revision>0), registration_paused INTEGER NOT NULL DEFAULT 0 CHECK(registration_paused IN (0,1)), uploads_paused INTEGER NOT NULL DEFAULT 0 CHECK(uploads_paused IN (0,1)), sharing_paused INTEGER NOT NULL DEFAULT 0 CHECK(sharing_paused IN (0,1)), email_paused INTEGER NOT NULL DEFAULT 0 CHECK(email_paused IN (0,1)), max_account_bytes INTEGER CHECK(max_account_bytes>=0), project_capacity_bytes INTEGER CHECK(project_capacity_bytes>0));
ALTER TABLE service_settings ADD COLUMN metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,revision,registration_paused,uploads_paused,sharing_paused,email_paused,max_account_bytes,project_capacity_bytes) AS BLOB))) VIRTUAL;
CREATE TRIGGER service_settings_charge_insert AFTER INSERT ON service_settings BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes,metadata_rows=metadata_rows+1 WHERE scope='global'; END;
CREATE TRIGGER service_settings_closed_insert BEFORE INSERT ON service_settings WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER service_settings_charge_delete AFTER DELETE ON service_settings BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+-OLD.metadata_bytes,metadata_rows=metadata_rows-1 WHERE scope='global'; END;
CREATE TRIGGER service_settings_closed_delete BEFORE DELETE ON service_settings WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE TRIGGER service_settings_charge_update AFTER UPDATE ON service_settings BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+NEW.metadata_bytes-OLD.metadata_bytes WHERE scope='global'; END;
CREATE TRIGGER service_settings_closed_update BEFORE UPDATE ON service_settings WHEN COALESCE((SELECT state FROM recovery_control WHERE id=1),'closed') != 'open' BEGIN SELECT RAISE(ABORT,'service_closed'); END;
CREATE INDEX admin_actions_actor ON admin_actions(actor_id,created_at,id);
CREATE INDEX admin_actions_target ON admin_actions(target_kind,target_id,created_at,id);
CREATE INDEX admin_previews_expiry ON admin_previews(expires_at,id);
CREATE INDEX admin_audit_cursor ON admin_audit(created_at,id);
CREATE INDEX admin_audit_actor ON admin_audit(actor_id,created_at,id);
CREATE INDEX admin_audit_target ON admin_audit(target_kind,target_id,created_at,id);
CREATE INDEX admin_invitations_status ON admin_invitations(state,created_at,id);
CREATE UNIQUE INDEX admin_invitations_pending ON admin_invitations(normalized_email) WHERE state='pending';
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'audit_immutable'); END;
CREATE TRIGGER admin_actions_immutable BEFORE UPDATE ON admin_actions BEGIN SELECT RAISE(ABORT,'receipt_immutable'); END;
INSERT INTO service_settings(id,revision) VALUES ('service',1);
CREATE INDEX accounts_admin_cursor ON accounts(created_at,id);
CREATE INDEX shares_admin_cursor ON shares(created_at,id);
CREATE INDEX service_jobs_admin_cursor ON service_jobs(created_at,id);
CREATE INDEX email_jobs_admin_cursor ON email_jobs(created_at,id);
CREATE INDEX operators_admin_cursor ON operators(created_at,id);
-- Keep operational target revisions separate from account expectations and delivery attempts
ALTER TABLE service_jobs ADD COLUMN admin_revision INTEGER NOT NULL DEFAULT 1 CHECK(admin_revision BETWEEN 1 AND 9007199254740991);
CREATE TRIGGER service_jobs_admin_revision AFTER UPDATE OF type,phase,account_id,actor_id,expected_revision,attempts,lease_token,lease_until,next_at,outcome,code,request_id,created_at,cursor ON service_jobs
BEGIN UPDATE service_jobs SET admin_revision=admin_revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER service_jobs_admin_revision_monotonic BEFORE UPDATE OF admin_revision ON service_jobs WHEN NEW.admin_revision<=OLD.admin_revision BEGIN SELECT RAISE(ABORT,'revision_regressed'); END;
UPDATE quota_counters SET metadata_bytes=metadata_bytes+(SELECT COALESCE(SUM(length(CAST(json_array(admin_revision) AS BLOB))),0) FROM service_jobs) WHERE scope='global';
CREATE TRIGGER service_jobs_admin_charge_insert AFTER INSERT ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+length(CAST(json_array(NEW.admin_revision) AS BLOB)) WHERE scope='global'; END;
CREATE TRIGGER service_jobs_admin_charge_delete AFTER DELETE ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes-length(CAST(json_array(OLD.admin_revision) AS BLOB)) WHERE scope='global'; END;
CREATE TRIGGER service_jobs_admin_charge_update AFTER UPDATE OF admin_revision ON service_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+length(CAST(json_array(NEW.admin_revision) AS BLOB))-length(CAST(json_array(OLD.admin_revision) AS BLOB)) WHERE scope='global'; END;
-- Keep operational target revisions separate from account expectations and delivery attempts
ALTER TABLE email_jobs ADD COLUMN admin_revision INTEGER NOT NULL DEFAULT 1 CHECK(admin_revision BETWEEN 1 AND 9007199254740991);
CREATE TRIGGER email_jobs_admin_revision AFTER UPDATE OF request_digest,request_id,payload,state,delivery,attempts,eligible,next_attempt_at,expires_at,created_at,updated_at,lease_token,lease_until,code,message_id,resend_of ON email_jobs
BEGIN UPDATE email_jobs SET admin_revision=admin_revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER email_jobs_admin_revision_monotonic BEFORE UPDATE OF admin_revision ON email_jobs WHEN NEW.admin_revision<=OLD.admin_revision BEGIN SELECT RAISE(ABORT,'revision_regressed'); END;
UPDATE quota_counters SET metadata_bytes=metadata_bytes+(SELECT COALESCE(SUM(length(CAST(json_array(admin_revision) AS BLOB))),0) FROM email_jobs) WHERE scope='global';
CREATE TRIGGER email_jobs_admin_charge_insert AFTER INSERT ON email_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+length(CAST(json_array(NEW.admin_revision) AS BLOB)) WHERE scope='global'; END;
CREATE TRIGGER email_jobs_admin_charge_delete AFTER DELETE ON email_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes-length(CAST(json_array(OLD.admin_revision) AS BLOB)) WHERE scope='global'; END;
CREATE TRIGGER email_jobs_admin_charge_update AFTER UPDATE OF admin_revision ON email_jobs BEGIN UPDATE quota_counters SET metadata_bytes=metadata_bytes+length(CAST(json_array(NEW.admin_revision) AS BLOB))-length(CAST(json_array(OLD.admin_revision) AS BLOB)) WHERE scope='global'; END;
-- Pause checks guard actual admission, including requests prepared before a settings change
CREATE TRIGGER admin_pause_signup BEFORE INSERT ON pending_registrations WHEN COALESCE((SELECT registration_paused FROM service_settings WHERE id='service'),1)=1 BEGIN SELECT RAISE(ABORT,'registration_paused'); END;
CREATE TRIGGER admin_pause_activation BEFORE INSERT ON accounts WHEN COALESCE((SELECT registration_paused FROM service_settings WHERE id='service'),1)=1 BEGIN SELECT RAISE(ABORT,'registration_paused'); END;
CREATE INDEX shares_admin_account_cursor ON shares(account_id,created_at,id);
CREATE INDEX service_jobs_admin_account_cursor ON service_jobs(account_id,created_at,id);
CREATE INDEX pending_admin_cursor ON pending_registrations(created_at,account_id);
-- These projections deliberately omit transport payloads, capabilities and private storage descriptors
CREATE VIEW admin_account_metadata AS
SELECT id,delivery_email,normalized_email,username,username_withheld,access,revision,capacity_bytes,verified_at,created_at FROM accounts
UNION ALL SELECT account_id AS id,delivery_email,normalized_email,username,0 AS username_withheld,'pending' AS access,verification_revision AS revision,0 AS capacity_bytes,NULL AS verified_at,created_at FROM pending_registrations p WHERE registration_record IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=p.account_id);
CREATE VIEW admin_job_metadata AS
SELECT id,type,phase,account_id,admin_revision AS revision,attempts,next_at,outcome,code,request_id,created_at FROM service_jobs
UNION ALL SELECT id,'email' AS type,delivery AS phase,NULL AS account_id,admin_revision AS revision,attempts,next_attempt_at AS next_at,state AS outcome,code,request_id,created_at FROM email_jobs;
-- Only newly created staff email authority follows staff membership lifetime
-- Existing customer-origin retries and irreversible deletion/Stop journals keep their original authority
CREATE TRIGGER operators_admin_email_invalidate AFTER UPDATE OF state,revision ON operators
WHEN NEW.state IS NOT OLD.state OR NEW.revision IS NOT OLD.revision
BEGIN
  UPDATE email_jobs SET eligible=0 WHERE COALESCE(resend_of,id) IN (
    SELECT json_extract(receipt,'$.jobId') FROM admin_actions
    WHERE actor_id=NEW.id AND action IN ('accounts.verification.resend','operators.invite')
  );
END;
CREATE INDEX service_jobs_admin_outcome_cursor ON service_jobs(outcome,created_at,id);
CREATE INDEX admin_audit_outcome ON admin_audit(outcome,created_at,id);
CREATE INDEX share_mutations_admin_job ON share_mutations(mutation_id) WHERE kind='stop';
