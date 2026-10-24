-- Epoch is ledger evidence for future global revocation owners, not a replacement for live session checks
ALTER TABLE accounts ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(session_epoch >= 0 AND session_epoch <= 9007199254740991);
-- Withholding survives an identical rename and affects only public attribution
ALTER TABLE accounts ADD COLUMN username_withheld INTEGER NOT NULL DEFAULT 0 CHECK(username_withheld IN (0,1));
CREATE TABLE shares (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('active','stopping','stopped')),
  include_attribution INTEGER NOT NULL CHECK(include_attribution IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) AS BLOB))) VIRTUAL
);
CREATE INDEX shares_owner ON shares(account_id,id);
CREATE TABLE share_snapshots (
  share_id TEXT NOT NULL REFERENCES shares(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  snapshot TEXT NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(share_id,account_id,revision,snapshot) AS BLOB))) VIRTUAL,
  PRIMARY KEY(share_id,revision)
);
CREATE INDEX share_snapshots_owner ON share_snapshots(account_id,share_id);
CREATE TRIGGER share_snapshots_immutable BEFORE UPDATE ON share_snapshots BEGIN SELECT RAISE(ABORT,'share_snapshot_immutable'); END;
-- An authorized Stop freezes the exact independent-ledger event before any append
-- Pending receipt NULL is not a completed Stop, even though public reads are denied
CREATE TABLE share_mutations (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  mutation_id TEXT NOT NULL,
  share_id TEXT NOT NULL REFERENCES shares(id),
  digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('publish','update','stop')),
  event TEXT,
  receipt TEXT,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,share_id,digest,kind,event,receipt) AS BLOB))) VIRTUAL,
  PRIMARY KEY(account_id,mutation_id)
);
CREATE INDEX share_mutations_share ON share_mutations(share_id,kind);
CREATE TRIGGER shares_insert AFTER INSERT ON shares BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER shares_delete AFTER DELETE ON shares BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER shares_accounting_update AFTER UPDATE ON shares BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER share_snapshots_insert AFTER INSERT ON share_snapshots BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER share_snapshots_delete AFTER DELETE ON share_snapshots BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER share_snapshots_accounting_update AFTER UPDATE ON share_snapshots BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER share_mutations_insert AFTER INSERT ON share_mutations BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER share_mutations_delete AFTER DELETE ON share_mutations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER share_mutations_accounting_update AFTER UPDATE ON share_mutations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global' OR scope = OLD.account_id;
END;
