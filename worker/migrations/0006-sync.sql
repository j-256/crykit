-- Logical encoded metadata is counted independently of physical D1 pages
CREATE TABLE quota_counters (scope TEXT PRIMARY KEY, payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0), reserved_metadata INTEGER NOT NULL DEFAULT 0 CHECK(reserved_metadata >= 0), metadata_bytes INTEGER NOT NULL DEFAULT 0 CHECK(metadata_bytes >= 0), metadata_rows INTEGER NOT NULL DEFAULT 0 CHECK(metadata_rows >= 0), edges INTEGER NOT NULL DEFAULT 0 CHECK(edges >= 0));
INSERT INTO quota_counters(scope) VALUES ('global');
CREATE TABLE account_sequences (
  account_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL DEFAULT 0,
  publication_epoch INTEGER NOT NULL DEFAULT 0,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,sequence,publication_epoch) AS BLOB))) VIRTUAL
);
CREATE TRIGGER account_sequences_insert AFTER INSERT ON account_sequences BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER account_sequences_delete AFTER DELETE ON account_sequences BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER account_sequences_update AFTER UPDATE ON account_sequences BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE upload_reservations (
  account_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL,
  generation TEXT NOT NULL,
  descriptor_reserve INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,upload_id,document_id,revision_id,request_digest,request_json,generation,descriptor_reserve) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,upload_id),
  UNIQUE (account_id,revision_id)
);
CREATE TRIGGER upload_reservations_insert AFTER INSERT ON upload_reservations BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER upload_reservations_delete AFTER DELETE ON upload_reservations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER upload_reservations_update AFTER UPDATE ON upload_reservations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE storage_generations (
  account_id TEXT NOT NULL,
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','ready','closing','closed','unsafe')),
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,id,upload_id,expires_at,state) AS BLOB))) VIRTUAL
);
CREATE TRIGGER storage_generations_insert AFTER INSERT ON storage_generations BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER storage_generations_delete AFTER DELETE ON storage_generations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER storage_generations_update AFTER UPDATE ON storage_generations BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE upload_chunks (
  account_id TEXT,
  generation TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  cipher_bytes INTEGER NOT NULL,
  cipher_digest TEXT NOT NULL,
  seed TEXT NOT NULL,
  marker TEXT NOT NULL,
  seed_etag TEXT,
  state TEXT NOT NULL CHECK(state IN ('allocated','initializing','seeded','writing','ready','closing','closed','unsafe')),
  released INTEGER NOT NULL DEFAULT 0,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,generation,chunk_index,object_key,cipher_bytes,cipher_digest,seed,marker,seed_etag,state,released) AS BLOB))) VIRTUAL,
  PRIMARY KEY (generation,chunk_index)
);
CREATE TRIGGER upload_chunks_insert AFTER INSERT ON upload_chunks BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER upload_chunks_delete AFTER DELETE ON upload_chunks BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER upload_chunks_update AFTER UPDATE ON upload_chunks BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE sync_documents (
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  head TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,document_id,head,first_sequence) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,document_id)
);
CREATE TRIGGER sync_documents_insert AFTER INSERT ON sync_documents BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER sync_documents_delete AFTER DELETE ON sync_documents BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER sync_documents_update AFTER UPDATE ON sync_documents BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE sync_revisions (
  account_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  protected INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,revision_id,document_id,upload_id,descriptor,protected) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,revision_id)
);
CREATE TRIGGER sync_revisions_insert AFTER INSERT ON sync_revisions BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER sync_revisions_delete AFTER DELETE ON sync_revisions BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER sync_revisions_update AFTER UPDATE ON sync_revisions BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE sync_dependencies (
  account_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,revision_id,dependency_id,document_id) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,revision_id,dependency_id)
);
CREATE TRIGGER sync_dependencies_insert AFTER INSERT ON sync_dependencies BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER sync_dependencies_delete AFTER DELETE ON sync_dependencies BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER sync_dependencies_update AFTER UPDATE ON sync_dependencies BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 1 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE mutation_receipts (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  receipt TEXT NOT NULL,
  group_json TEXT NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,digest,sequence,receipt,group_json) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,mutation_id),
  UNIQUE (account_id,sequence)
);
CREATE TRIGGER mutation_receipts_insert AFTER INSERT ON mutation_receipts BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER mutation_receipts_delete AFTER DELETE ON mutation_receipts BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER mutation_receipts_update AFTER UPDATE ON mutation_receipts BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE head_history (
  account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,document_id,sequence,revision_id) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,document_id,sequence)
);
CREATE TRIGGER head_history_insert AFTER INSERT ON head_history BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER head_history_delete AFTER DELETE ON head_history BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER head_history_update AFTER UPDATE ON head_history BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE scan_leases (
  account_id TEXT NOT NULL,
  id TEXT PRIMARY KEY,
  watermark INTEGER NOT NULL,
  publication_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,id,watermark,publication_epoch,expires_at) AS BLOB))) VIRTUAL
);
CREATE TRIGGER scan_leases_insert AFTER INSERT ON scan_leases BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER scan_leases_delete AFTER DELETE ON scan_leases BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER scan_leases_update AFTER UPDATE ON scan_leases BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE publication_work (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('validating','complete','accepted','abandoned')),
  expires_at INTEGER NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,digest,state,expires_at) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,mutation_id)
);
CREATE TRIGGER publication_work_insert AFTER INSERT ON publication_work BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_work_delete AFTER DELETE ON publication_work BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER publication_work_update AFTER UPDATE ON publication_work BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TABLE publication_pins (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  generation TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  retained INTEGER NOT NULL DEFAULT 0,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,revision_id,document_id,generation,done,retained) AS BLOB))) VIRTUAL,
  PRIMARY KEY (account_id,mutation_id,revision_id)
);
CREATE TRIGGER publication_pins_insert AFTER INSERT ON publication_pins BEGIN
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_pins_delete AFTER DELETE ON publication_pins BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER publication_pins_update AFTER UPDATE ON publication_pins BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
  INSERT INTO quota_counters(scope) SELECT NEW.account_id WHERE NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = NEW.account_id);
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE INDEX generations_account ON storage_generations(account_id,expires_at,id);
CREATE INDEX chunks_account ON upload_chunks(account_id,generation,chunk_index);
CREATE INDEX documents_initial ON sync_documents(account_id,first_sequence,document_id);
CREATE INDEX revisions_document ON sync_revisions(account_id,document_id,revision_id);
CREATE INDEX leases_account ON scan_leases(account_id,expires_at);
CREATE INDEX work_account ON publication_work(account_id,state,expires_at);
CREATE INDEX pins_generation ON publication_pins(generation,account_id,mutation_id);
CREATE INDEX publication_frontier ON publication_pins(account_id,mutation_id,done,revision_id);
CREATE INDEX generations_cleanup ON storage_generations(state,expires_at,id);
CREATE INDEX leases_expiry ON scan_leases(expires_at,id);
CREATE INDEX work_expiry ON publication_work(state,expires_at,account_id,mutation_id);
