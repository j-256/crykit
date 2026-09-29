import type { CatalogCorrection } from './corrections'
import type { CatalogSnapshot, CatalogRef, CatalogEntity, CatalogId, CatalogRevisionId, EntityId, Timestamp } from './types'

export const CORRECTION_TEST_TIME = '2026-01-02T03:04:05.000Z'
export const CORRECTION_TEST_REF: CatalogRef = { kind: 'catalog', catalogId: 'synthetic-catalog' as CatalogId, catalogRevisionId: 'v1' as CatalogRevisionId, entityId: 'synthetic-item' as EntityId }
export const CORRECTION_TEST_ENTITY: CatalogEntity = {
  id: CORRECTION_TEST_REF.entityId,
  kind: 'item', name: 'Synthetic Rapier', aliases: [], rawDescription: 'Synthetic source description',
  fields: {
    Location: { state: 'conflicting', claims: [
      { value: 'Synthetic shops', sources: [{ sourceId: 'https://example.com/item?oldid=1', snapshot: 'revision 1' }] },
      { value: 'Synthetic weapon shop', sources: [{ sourceId: 'https://example.com/table?oldid=2', snapshot: 'revision 2' }] },
    ] },
    Attack: { state: 'known', value: 100 },
    Hands: { state: 'known', value: 1 },
    'PP cost': { state: 'known', value: 3 },
  },
  sources: [{ sourceId: 'https://example.com/item?oldid=1', snapshot: 'revision 1', applicability: 'Platform unverified' }],
  ppCost: { state: 'known', value: 3 },
  listedContributions: { Attack: { state: 'known', value: { value: 100, unit: 'listed flat value' } } },
}
export const CORRECTION_TEST_CATALOG: CatalogSnapshot = {
  id: CORRECTION_TEST_REF.catalogId, revisionId: CORRECTION_TEST_REF.catalogRevisionId, schemaVersion: '1.0.0', checksum: 'synthetic-checksum', importedAt: CORRECTION_TEST_TIME as Timestamp,
  applicability: { state: 'unknown' }, rights: { state: 'known', value: 'Synthetic test data' },
  entities: { [CORRECTION_TEST_ENTITY.id]: CORRECTION_TEST_ENTITY }, claims: [],
}
export function testCorrection(overrides: Partial<CatalogCorrection> = {}): CatalogCorrection {
  return {
    id: 'synthetic-decision-1', target: CORRECTION_TEST_REF, baselineChecksum: CORRECTION_TEST_CATALOG.checksum, baselineSources: CORRECTION_TEST_ENTITY.sources, baselineClaims: [], baselineName: CORRECTION_TEST_ENTITY.name,
    confidence: 'tentative', reason: '', evidence: '', context: { platform: '', gameVersion: '', mods: '' },
    decision: 'refinement', supersedes: [], updatedAt: CORRECTION_TEST_TIME,
    changes: [{ path: 'field', field: 'Location', before: CORRECTION_TEST_ENTITY.fields.Location!, after: { state: 'known', value: 'Synthetic weapon shop, test city' } }],
    ...overrides,
  }
}
