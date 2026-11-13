import { CURRENT_CATALOG } from './bundled'
import type { CatalogEntityKind, CatalogSnapshot, EntityId } from '../domain/types'

export const HISTORICAL_VANILLA: CatalogSnapshot = { ...CURRENT_CATALOG, revisionId: 'v2' as never, checksum: 'synthetic-historical-vanilla' }

const observations: readonly [string, CatalogEntityKind, string][] = [
  ['synthetic:class', 'class', 'Synthetic class mod'],
  ['synthetic:item', 'item', 'Synthetic item mod'],
  ['synthetic:monster', 'monster', 'Synthetic boss mod'],
]
export const SYNTHETIC_MOD_OBSERVATIONS: CatalogSnapshot = {
  id: `crystal-project/imported/research1-${'a'.repeat(64)}` as never,
  revisionId: `j1-${'b'.repeat(64)}-p1` as never,
  schemaVersion: 'synthetic-research', checksum: 'synthetic-observations',
  applicability: { state: 'unknown' }, rights: { state: 'unknown' }, claims: [],
  entities: Object.fromEntries(observations.map(([id, kind, name]) => [id, { id: id as EntityId, kind, name, aliases: [], fields: { 'Source mod': { state: 'known' as const, value: name } }, sources: [{ sourceId: 'synthetic:research-observations' }] }])),
}
