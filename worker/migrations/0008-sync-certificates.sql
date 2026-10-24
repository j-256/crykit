-- Operational proof is distinct from portable content and never survives generation replacement by inference
CREATE TABLE publication_certificates (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  work_id TEXT NOT NULL,
  head_document TEXT NOT NULL,
  head_revision TEXT NOT NULL,
  head_generation TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version = 1),
  state TEXT NOT NULL CHECK(state IN ('intact','invalidated')),
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,digest,work_id,head_document,head_revision,head_generation,version,state) AS BLOB))) VIRTUAL,
  PRIMARY KEY(account_id,mutation_id)
);
CREATE TABLE publication_borrows (
  account_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  source_mutation TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  source_work TEXT NOT NULL,
  source_head_document TEXT NOT NULL,
  source_head_revision TEXT NOT NULL,
  source_head_generation TEXT NOT NULL,
  metadata_bytes INTEGER GENERATED ALWAYS AS (length(CAST(json_array(account_id,mutation_id,work_id,digest,revision_id,document_id,generation,source_mutation,source_digest,source_work,source_head_document,source_head_revision,source_head_generation) AS BLOB))) VIRTUAL,
  PRIMARY KEY(account_id,mutation_id,work_id,revision_id)
);
CREATE INDEX certificate_member ON publication_pins(account_id,revision_id,document_id,generation,retained,done,mutation_id);
CREATE INDEX borrow_source ON publication_borrows(account_id,source_mutation,source_work);
CREATE TRIGGER publication_certificates_insert AFTER INSERT ON publication_certificates BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 0 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_certificates_delete AFTER DELETE ON publication_certificates BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 0 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER publication_borrows_insert AFTER INSERT ON publication_borrows BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes, metadata_rows = metadata_rows + 1, edges = edges + 1 WHERE scope = 'global' OR scope = NEW.account_id;
END;
CREATE TRIGGER publication_borrows_delete AFTER DELETE ON publication_borrows BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes - OLD.metadata_bytes, metadata_rows = metadata_rows - 1, edges = edges - 1 WHERE scope = 'global' OR scope = OLD.account_id;
END;
CREATE TRIGGER certificate_accounting_update AFTER UPDATE ON publication_certificates BEGIN
  UPDATE quota_counters SET metadata_bytes = metadata_bytes + NEW.metadata_bytes - OLD.metadata_bytes WHERE scope = 'global' OR scope = OLD.account_id;
END;
-- Invalidation is irreversible and precedes any partial retirement, even when no borrower is visible
CREATE TRIGGER certificate_retire BEFORE UPDATE ON publication_certificates WHEN
  NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.digest IS NOT OLD.digest
  OR NEW.work_id IS NOT OLD.work_id OR NEW.head_document IS NOT OLD.head_document
  OR NEW.head_revision IS NOT OLD.head_revision OR NEW.head_generation IS NOT OLD.head_generation
  OR NEW.version IS NOT OLD.version OR NEW.state <> 'invalidated'
  OR EXISTS (SELECT 1 FROM publication_work w WHERE w.account_id = OLD.account_id AND w.state IN ('validating','complete'))
BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_remove BEFORE DELETE ON publication_certificates WHEN OLD.state <> 'invalidated'
  OR EXISTS (SELECT 1 FROM publication_work w WHERE w.account_id = OLD.account_id AND w.state IN ('validating','complete'))
BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_immutable BEFORE UPDATE ON publication_borrows BEGIN SELECT RAISE(ABORT,'certificate_binding_immutable'); END;
CREATE TRIGGER borrow_remove BEFORE DELETE ON publication_borrows WHEN EXISTS (
  SELECT 1 FROM publication_work w JOIN publication_progress p USING(account_id,mutation_id)
  WHERE w.account_id = OLD.account_id AND w.mutation_id = OLD.mutation_id AND p.work_id = OLD.work_id AND w.state IN ('validating','complete')
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_pin_remove AFTER DELETE ON publication_pins BEGIN
  DELETE FROM publication_borrows WHERE account_id = OLD.account_id AND mutation_id = OLD.mutation_id AND revision_id = OLD.revision_id;
END;
CREATE TRIGGER certificate_publication_work_update BEFORE UPDATE ON publication_work WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.digest IS NOT OLD.digest OR NEW.state IS NOT OLD.state OR NEW.expires_at IS NOT OLD.expires_at) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_work_delete BEFORE DELETE ON publication_work WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_progress_update BEFORE UPDATE ON publication_progress WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.work_id IS NOT OLD.work_id OR NEW.processed_steps IS NOT OLD.processed_steps) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_progress_delete BEFORE DELETE ON publication_progress WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_pins_update BEFORE UPDATE ON publication_pins WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.document_id IS NOT OLD.document_id OR NEW.generation IS NOT OLD.generation OR NEW.done IS NOT OLD.done OR NEW.retained IS NOT OLD.retained) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_pins_delete BEFORE DELETE ON publication_pins WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_mutation_receipts_update BEFORE UPDATE ON mutation_receipts WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.digest IS NOT OLD.digest OR NEW.receipt IS NOT OLD.receipt OR NEW.group_json IS NOT OLD.group_json) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_mutation_receipts_delete BEFORE DELETE ON mutation_receipts WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND c.mutation_id = OLD.mutation_id
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_sync_revisions_update BEFORE UPDATE ON sync_revisions WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.revision_id = OLD.revision_id AND p.retained = 1)
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.document_id IS NOT OLD.document_id OR NEW.upload_id IS NOT OLD.upload_id OR NEW.descriptor IS NOT OLD.descriptor) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_sync_revisions_delete BEFORE DELETE ON sync_revisions WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.revision_id = OLD.revision_id AND p.retained = 1)
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_sync_dependencies_update BEFORE UPDATE ON sync_dependencies WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.revision_id = OLD.revision_id AND p.retained = 1)
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.dependency_id IS NOT OLD.dependency_id OR NEW.document_id IS NOT OLD.document_id) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_sync_dependencies_delete BEFORE DELETE ON sync_dependencies WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.revision_id = OLD.revision_id AND p.retained = 1)
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_upload_reservations_update BEFORE UPDATE ON upload_reservations WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.generation AND p.retained = 1)
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.upload_id IS NOT OLD.upload_id OR NEW.document_id IS NOT OLD.document_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.request_digest IS NOT OLD.request_digest OR NEW.request_json IS NOT OLD.request_json OR NEW.generation IS NOT OLD.generation) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_upload_reservations_delete BEFORE DELETE ON upload_reservations WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.generation AND p.retained = 1)
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_storage_generations_update BEFORE UPDATE ON storage_generations WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.id AND p.retained = 1)
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.id IS NOT OLD.id OR NEW.upload_id IS NOT OLD.upload_id OR NEW.state IS NOT OLD.state) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_storage_generations_delete BEFORE DELETE ON storage_generations WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.id AND p.retained = 1)
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_upload_chunks_update BEFORE UPDATE ON upload_chunks WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.generation AND p.retained = 1)
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.generation IS NOT OLD.generation OR NEW.chunk_index IS NOT OLD.chunk_index OR NEW.object_key IS NOT OLD.object_key OR NEW.cipher_bytes IS NOT OLD.cipher_bytes OR NEW.cipher_digest IS NOT OLD.cipher_digest OR NEW.state IS NOT OLD.state) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_upload_chunks_delete BEFORE DELETE ON upload_chunks WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = OLD.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.generation = OLD.generation AND p.retained = 1)
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_publication_pins_add BEFORE INSERT ON publication_pins WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = NEW.account_id AND c.mutation_id = NEW.mutation_id
) AND NOT EXISTS (SELECT 1 FROM publication_pins existing WHERE existing.account_id = NEW.account_id AND existing.mutation_id = NEW.mutation_id AND existing.revision_id = NEW.revision_id) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER certificate_sync_dependencies_add BEFORE INSERT ON sync_dependencies WHEN EXISTS (
  SELECT 1 FROM publication_certificates c WHERE c.state = 'intact' AND c.account_id = NEW.account_id AND EXISTS (SELECT 1 FROM publication_pins p WHERE p.account_id = c.account_id AND p.mutation_id = c.mutation_id AND p.revision_id = NEW.revision_id AND p.retained = 1)
) AND NOT EXISTS (SELECT 1 FROM sync_dependencies existing WHERE existing.account_id = NEW.account_id AND existing.revision_id = NEW.revision_id AND existing.dependency_id = NEW.dependency_id) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
-- Duplicate dependency discovery can preserve an already bound pin without creating work or changing authority
CREATE TRIGGER borrow_publication_pins_update BEFORE UPDATE ON publication_pins WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND b.revision_id = OLD.revision_id AND w.state IN ('validating','complete')
) AND NOT EXISTS (
  SELECT 1 FROM publication_borrows b
  JOIN publication_work w USING(account_id,mutation_id)
  JOIN publication_progress p USING(account_id,mutation_id)
  JOIN publication_certificates c ON c.account_id = b.account_id AND c.mutation_id = b.source_mutation
  WHERE (b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND b.revision_id = OLD.revision_id
    AND p.work_id = b.work_id AND w.digest = b.digest AND c.state = 'intact')
  AND (c.work_id = b.source_work AND c.digest = b.source_digest AND c.head_document = b.source_head_document
    AND c.head_revision = b.source_head_revision AND c.head_generation = b.source_head_generation)
  AND (NEW.account_id = OLD.account_id AND NEW.mutation_id = OLD.mutation_id AND NEW.revision_id = OLD.revision_id
    AND NEW.document_id = OLD.document_id AND NEW.document_id = b.document_id AND NEW.retained = OLD.retained)
  AND NEW.generation = b.generation AND NEW.done = 1
  AND (OLD.done = 0 OR (OLD.done = 1 AND OLD.generation = NEW.generation))
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_publication_pins_delete BEFORE DELETE ON publication_pins WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND b.revision_id = OLD.revision_id AND w.state IN ('validating','complete')
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_publication_progress_update BEFORE UPDATE ON publication_progress WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND w.state IN ('validating','complete')
) AND (NEW.work_id IS NOT OLD.work_id OR NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_publication_progress_delete BEFORE DELETE ON publication_progress WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND w.state IN ('validating','complete')
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_publication_work_update BEFORE UPDATE ON publication_work WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND w.state IN ('validating','complete')
) AND (NEW.account_id IS NOT OLD.account_id OR NEW.mutation_id IS NOT OLD.mutation_id OR NEW.digest IS NOT OLD.digest OR NEW.expires_at IS NOT OLD.expires_at) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
CREATE TRIGGER borrow_publication_work_delete BEFORE DELETE ON publication_work WHEN EXISTS (
  SELECT 1 FROM publication_borrows b JOIN publication_work w USING(account_id,mutation_id)
  WHERE b.account_id = OLD.account_id AND b.mutation_id = OLD.mutation_id AND w.state IN ('validating','complete')
) BEGIN SELECT RAISE(ABORT,'certificate_lifetime'); END;
