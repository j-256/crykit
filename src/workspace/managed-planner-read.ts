import type { ModCatalogPin } from '../domain/types'
import type { SourceArchiveRecord } from '../interchange/types'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { blobIdentity, readBlob } from './blobs'
import type { WorkspaceState } from './documents'
import { WorkspaceError } from './repository'

export async function readManagedSources(state: WorkspaceState, check: () => Promise<void>): Promise<readonly SourceArchiveRecord[]> {
  const total = state.planner.sources.reduce((bytes, source) => bytes + source.original.byteLength, 0)
  if (total > NATIVE_BACKUP_ARCHIVE_LIMITS.maxTotalUncompressedBytes) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'These sources require a streamed full-workspace backup.')
  const result: SourceArchiveRecord[] = []
  try {
    await check()
    for (const { original, ...source } of state.planner.sources) {
      const body = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(original))
      if (!body) throw new Error('The exact original source is unavailable')
      const bytes = await readBlob(body.content, original.byteLength)
      result.push({ ...source, bytes }); await check()
    }
    return result
  } catch (error) { for (const source of result) source.bytes.fill(0); throw error }
}
export async function readManagedModSource(state: WorkspaceState, pin: ModCatalogPin, check: () => Promise<void>): Promise<{ filename: string; text: string }> {
  await check()
  const catalog = state.planner.catalogs.find(value => value.id === pin.catalogId && value.revisionId === pin.catalogRevisionId)
  if (!catalog || catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The exact saved mod revision is unavailable.')
  const source = state.planner.sources.find(value => value.digest === catalog.checksum.replace(/^sha256:/, ''))
  const body = source && state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(source.original))
  if (!source || !body) throw new Error('The exact original mod source is unavailable')
  const bytes = await readBlob(body.content, source.original.byteLength)
  try { await check(); return { filename: source.filename, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } }
  finally { bytes.fill(0) }
}
