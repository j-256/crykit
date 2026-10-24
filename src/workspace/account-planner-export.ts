import type { LocalData } from '../domain/types'
import type { SourceArchiveRecord } from '../interchange/types'
import type { WorkspacePlannerState } from './documents'
import { WorkspaceError } from './repository'
import { connectedHistory } from './planner-journal'
import { changedLocalData, historyEntry, validateLocalDataForStorage, zipReadableByImporter } from '../persistence/local-data'
import { previewImport } from '../interchange/import'
import { nowTimestamp } from '../interchange/util'
import { NATIVE_BACKUP_FORMAT_VERSION } from '../interchange/native-schema'
import { inspectZip, NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import { encodeCatalogPayload, PackagedCatalogPinSchema } from './catalog-codec'

const MAX_PLANNER_BACKUP_HISTORY = 500

// Both account layouts preserve every captured planner original, including sources no longer referenced by current records
// This bounded native ZIP retains the established connected-history policy; complete backups own all other workspace evidence
export async function exportAccountPlannerSnapshot(planner: WorkspacePlannerState, originals: readonly SourceArchiveRecord[], override?: LocalData): Promise<Uint8Array> {
  if (override && override.id !== planner.localData.id) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The recovery draft belongs to another workspace.')
  const savedHistory = [...connectedHistory(planner)]
  const completeHistoryCount = new Set([...planner.history, ...(planner.journal?.checkpoints ?? [])].map(entry => entry.id)).size
  let localData = planner.localData
  if (override && JSON.stringify(override) !== JSON.stringify(localData)) {
    const timestamp = nowTimestamp(), before = localData
    localData = changedLocalData(before, override, 'recovery-draft-export', timestamp)
    savedHistory.push(historyEntry(before, localData, 'recovery-draft-export', timestamp))
  }
  validateLocalDataForStorage(localData, planner.catalogs)
  // This legacy planner ZIP declares its history truncation; the complete workspace boundary retains every entry
  const retained = savedHistory.slice(-MAX_PLANNER_BACKUP_HISTORY)
  const entries: Record<string, Uint8Array> = {}
  const manifestSources = originals.map(({ bytes, ...metadata }, index) => { const path = `sources/${String(index).padStart(4, '0')}.bin`; entries[path] = bytes; return { ...metadata, path, size: bytes.byteLength } })
  const bundled = planner.catalogs.flatMap(catalog => {
    const payload = encodeCatalogPayload(catalog)
    return PackagedCatalogPinSchema.safeParse(payload).success ? [catalog] : []
  })
  const bundledKeys = new Set(bundled.map(value => JSON.stringify([value.id, value.revisionId])))
  entries['bundle.json'] = new TextEncoder().encode(JSON.stringify({ localData, lineage: planner.lineage, catalogs: planner.catalogs.filter(value => !bundledKeys.has(JSON.stringify([value.id, value.revisionId]))), bundledCatalogs: bundled.map(({ id, revisionId, checksum }) => ({ id, revisionId, checksum })), evidence: planner.evidence, history: retained }))
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify({ format: 'crykit-backup', formatVersion: NATIVE_BACKUP_FORMAT_VERSION, exportedAt: nowTimestamp(), payload: 'bundle.json', sources: manifestSources, history: { stored: Math.max(completeHistoryCount, savedHistory.length), exported: retained.length, truncated: Math.max(completeHistoryCount, savedHistory.length) !== retained.length } }))
  try { const bytes = zipReadableByImporter(entries); inspectZip(bytes, NATIVE_BACKUP_ARCHIVE_LIMITS); await previewImport(bytes, 'account-planner-backup.zip'); return bytes }
  finally { for (const bytes of Object.values(entries)) bytes.fill(0) }
}
