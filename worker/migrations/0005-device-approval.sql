CREATE TABLE device_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  pairing_context TEXT NOT NULL,
  request_public_key TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'consumed')),
  approver_session_id TEXT REFERENCES customer_sessions(id),
  approver_device_id TEXT REFERENCES devices(id),
  completion_hash TEXT,
  sealed_payload TEXT
);
CREATE INDEX device_approvals_expiry ON device_approvals(expires_at);
CREATE INDEX device_approvals_approver ON device_approvals(approver_device_id, state);
CREATE INDEX devices_newest ON devices(account_id, created_at DESC, id DESC);
CREATE INDEX device_approvals_pending ON device_approvals(account_id, state, expires_at DESC, id DESC);
