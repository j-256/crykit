import packed from './bundled-mod-index.json' with { type: 'json' }
import { unpackJson } from './packed-json'
import type { CatalogSnapshot } from '../domain/types'

let catalogs: readonly CatalogSnapshot[] | undefined

export function bundledModSearchCatalogs(): readonly CatalogSnapshot[] {
  catalogs ??= unpackJson<{ readonly schemaVersion: 1; readonly catalogs: readonly CatalogSnapshot[] }>(packed).catalogs
  return catalogs
}
