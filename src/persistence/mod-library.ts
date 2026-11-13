import { artifactSuppliesCatalog } from '../domain/source-artifacts'
import type { ModCatalogPin } from '../domain/types'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { sha256 } from '../interchange/util'
import { getDatabase } from './database'
import { catalogSnapshotKey } from '../interchange/identity'

export async function readModSource(pin: ModCatalogPin, database = getDatabase()): Promise<{ readonly filename: string; readonly text: string }> {
  const catalog = await database.catalogs.get(catalogSnapshotKey(pin.catalogId, pin.catalogRevisionId))
  if (!catalog || catalog.snapshot.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new Error('The saved mod revision is unavailable.')
  const source = (await database.sources.toArray()).find(value => artifactSuppliesCatalog(value, catalog.snapshot))
  if (!source || await sha256(source.bytes) !== source.digest) throw new Error('The original mod source is missing or damaged. Import a verified copy before editing.')
  return { filename: source.filename, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes) }
}
