import type { ModCatalogPin } from '../domain/types'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { sha256, stableSourceId } from '../interchange/util'
import { getDatabase } from './database'
import { catalogSnapshotKey } from '../interchange/identity'

export async function readModSource(pin: ModCatalogPin): Promise<{ readonly filename: string; readonly text: string }> {
  const database = getDatabase()
  const catalog = await database.catalogs.get(catalogSnapshotKey(pin.catalogId, pin.catalogRevisionId))
  if (!catalog || catalog.snapshot.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new Error('The saved mod revision is unavailable.')
  const digest = catalog.snapshot.checksum.replace(/^sha256:/, '')
  const source = await database.sources.get(stableSourceId(digest))
  if (!source || await sha256(source.bytes) !== digest) throw new Error('The original mod source is missing or damaged. Import a verified copy before editing.')
  return { filename: source.filename, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes) }
}
