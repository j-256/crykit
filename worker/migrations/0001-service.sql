-- Ephemeral rows exist only inside a guarded D1 batch and are removed before success
-- The primary key isolates simultaneous callers; no secondary index or account data is needed
-- A false, NULL or zero-row scalar predicate must insert 0 and raise CHECK, never skip a row
CREATE TABLE transaction_guards (
  id TEXT PRIMARY KEY NOT NULL,
  passed INTEGER NOT NULL CONSTRAINT transaction_guard_passed CHECK (passed = 1)
);
