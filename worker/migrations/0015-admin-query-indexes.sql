-- Facet prefixes keep bounded admin pages on indexed created-at ranges
CREATE INDEX accounts_admin_access_cursor ON accounts(access,created_at,id);
CREATE INDEX shares_admin_state_cursor ON shares(state,created_at,id);
CREATE INDEX service_jobs_admin_type_cursor ON service_jobs(type,created_at,id);
CREATE INDEX service_jobs_admin_type_outcome_cursor ON service_jobs(type,outcome,created_at,id);
CREATE INDEX email_jobs_admin_state_cursor ON email_jobs(state,created_at,id);
CREATE INDEX admin_audit_action_cursor ON admin_audit(action,created_at,id);
CREATE INDEX admin_audit_action_outcome_cursor ON admin_audit(action,outcome,created_at,id);
