-- Separate charged metadata preserves accepted journal rows and their existing expiry semantics
CREATE TABLE publication_progress (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  processed_steps INTEGER NOT NULL DEFAULT 0 CHECK(processed_steps >= 0 AND processed_steps <= 9007199254740991),
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,work_id,processed_steps) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,mutation_id)
);
CREATE TRIGGER publication_progress_insert AFTER INSERT ON publication_progress BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_progress_delete AFTER DELETE ON publication_progress BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER publication_progress_update AFTER UPDATE ON publication_progress BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_progress_work_delete AFTER DELETE ON publication_work BEGIN
  DELETE FROM publication_progress WHERE account_id = OLD.account_id AND mutation_id = OLD.mutation_id;
END;
-- Only an actual unfinished-to-finished frontier transition advances work, never replay or retention promotion alone
CREATE TRIGGER publication_progress_step AFTER UPDATE OF done ON publication_pins WHEN OLD.done = 0 AND NEW.done = 1 BEGIN
  UPDATE publication_progress SET processed_steps = processed_steps + 1 WHERE account_id = NEW.account_id AND mutation_id = NEW.mutation_id AND EXISTS (SELECT 1 FROM publication_work w WHERE w.account_id = NEW.account_id AND w.mutation_id = NEW.mutation_id AND w.state = 'validating');
END;
