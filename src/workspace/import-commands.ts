import type { CatalogSnapshot } from '../domain/types'
import { configureModSetup } from '../domain/mod-setup'
import { referenceLibraryWithMod } from '../domain/reference-library'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { nowTimestamp, sha256 } from '../interchange/util'
import type { ImportPreview, CommitImportOptions, ImportCandidate } from '../interchange/types'
import { prepareModCatalogs, jsonEqual } from '../persistence/local-data'
import { memoryBlob, blobIdentity } from './blobs'
import type { WorkspaceState } from './documents'
import { preserveLocalSelections } from './local-selections'
import { WorkspaceError } from './repository'

function mergeImmutable<T>(before: readonly T[], incoming: readonly T[], key: (value: T) => string): readonly T[] {
  const values = new Map(before.map(value => [key(value), value]))
  for (const value of incoming) {
    const old = values.get(key(value))
    if (old && !jsonEqual(old, value)) throw new Error('An imported immutable identity has conflicting contents')
    if (!old) values.set(key(value), value)
  }
  return [...values.values()]
}
async function mergeCandidate(state: WorkspaceState, candidate: ImportCandidate): Promise<WorkspaceState> {
  const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const sources = new Map(state.planner.sources.map(source => [source.id, source]))
  for (const { bytes, ...source } of candidate.sources) {
    if (await sha256(bytes) !== source.digest) throw new Error('An original source digest conflicts')
    const existing = sources.get(source.id)
    if (existing) {
      const { original: _original, ...metadata } = existing
      // Byte identity retains the first imported filename/time; later names cannot rewrite provenance
      if (metadata.digest !== source.digest || metadata.format !== source.format || metadata.mediaType !== source.mediaType) throw new Error('An original source identity conflicts')
      continue
    }
    const ref = { documentId: `source:${source.id}`, revisionId: source.digest, byteLength: bytes.length, sha256: source.digest, encoding: 'bytes' as const }
    sources.set(source.id, { ...source, original: ref }); blobs.set(blobIdentity(ref), { ref, content: memoryBlob(bytes) })
  }
  const catalogKey = (value: CatalogSnapshot) => JSON.stringify([value.id, value.revisionId])
  const known = new Map(state.planner.catalogs.map(value => [catalogKey(value), value]))
  const catalogs = candidate.catalogs.map(value => known.has(catalogKey(value)) ? { ...value, importedAt: known.get(catalogKey(value))!.importedAt } : value)
  return { ...state, blobs: [...blobs.values()], planner: { ...state.planner, catalogs: mergeImmutable(state.planner.catalogs, catalogs, catalogKey), sources: [...sources.values()], evidence: mergeImmutable(state.planner.evidence, candidate.evidence, value => value.id), history: mergeImmutable(state.planner.history, candidate.history, value => value.id) } }
}
export async function prepareWorkspaceImport(state: WorkspaceState, preview: ImportPreview, options: CommitImportOptions = {}): Promise<{ state: WorkspaceState; mode: 'additive' | 'replace' }> {
  if (preview.errors.length) throw new Error('The import preview contains errors')
  const before = state.planner.localData, timestamp = nowTimestamp()
  if (options.expectedRevision !== undefined && options.expectedRevision !== before.revision || options.targetLocalDataId !== undefined && options.targetLocalDataId !== before.id) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The import target changed. Reload before importing.')
  const merged = await mergeCandidate(state, preview.proposed)
  if (options.mode === 'add-reference') {
    if (preview.detectedFormat !== CRYSTAL_EDIT_CATALOG_SCHEMA || preview.counts.personal || preview.counts.mixed) throw new Error('Only a reference-only Crystal Edit preview can be added')
    if (options.includeModInReference && !preview.proposed.catalogs.some(catalog => catalog.id === options.includeModInReference)) throw new Error('Reference membership does not match the imported mod')
    const receipts = Object.fromEntries(Object.entries(preview.proposed.localData.importReceipts).map(([id, receipt]) => [id, before.importReceipts[id] ?? { ...receipt, importedAt: timestamp, localDataRevision: before.revision + 1 }]))
    const localData = { ...before, importReceipts: { ...before.importReceipts, ...receipts }, ...(options.includeModInReference ? { referenceLibrary: referenceLibraryWithMod(before.referenceLibrary, options.includeModInReference, true) } : {}) }
    return { state: { ...merged, planner: { ...merged.planner, localData } }, mode: 'additive' }
  }
  return { state: { ...merged, planner: { ...merged.planner, localData: preserveLocalSelections({ ...preview.proposed.localData, id: before.id }, before), lineage: { rootLocalDataId: state.planner.lineage.rootLocalDataId, parentLocalDataId: before.id, sourceLocalDataId: preview.proposed.localData.id, sourceRevision: preview.proposed.localData.revision, forkedAt: timestamp } } }, mode: 'replace' }
}
export async function prepareWorkspaceModSetup(state: WorkspaceState, previews: readonly ImportPreview[], expectedRevision: number, skip = false): Promise<WorkspaceState> {
  if (skip && previews.length) throw new Error('Skipping mod setup cannot import sources')
  if (state.planner.localData.revision !== expectedRevision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The planner changed. Reopen mod selection.')
  let merged = state
  const candidates: CatalogSnapshot[] = []
  for (const preview of previews) {
    if (preview.detectedFormat !== CRYSTAL_EDIT_CATALOG_SCHEMA || preview.errors.length || preview.proposed.catalogs.length !== 1) throw new Error('Mod setup requires a verified Crystal Edit source')
    merged = await mergeCandidate(merged, preview.proposed)
    const candidate = preview.proposed.catalogs[0]
    candidates.push(merged.planner.catalogs.find(value => value.id === candidate.id && value.revisionId === candidate.revisionId)!)
  }
  const configured = configureModSetup(state.planner.localData, candidates, merged.planner.catalogs, expectedRevision, skip)
  const catalogs = await prepareModCatalogs(configured, merged.planner.catalogs)
  const timestamp = nowTimestamp()
  const receipts = Object.fromEntries(previews.flatMap(preview => Object.entries(preview.proposed.localData.importReceipts)).map(([id, receipt]) => [id, state.planner.localData.importReceipts[id] ?? { ...receipt, importedAt: timestamp, localDataRevision: configured.revision }]))
  return { ...merged, planner: { ...merged.planner, localData: { ...configured, importReceipts: { ...configured.importReceipts, ...receipts } }, catalogs } }
}
