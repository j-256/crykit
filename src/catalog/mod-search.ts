import packed from './bundled-mod-index.json' with { type: 'json' }
import { unpackJson } from './packed-json'
import type { CatalogSnapshot } from '../domain/types'

export const BUNDLED_MOD_SEARCH_CATALOGS = unpackJson<{ readonly schemaVersion: 1; readonly catalogs: readonly CatalogSnapshot[] }>(packed).catalogs
