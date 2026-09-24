import { describe, expect, it } from 'vitest'
import type {
  CatalogClaim,
  CatalogEntity,
  CatalogId,
  CatalogRevisionId,
  CatalogSnapshot,
  EntityId,
  Timestamp,
} from '../domain/types'
import {
  aggregateKnowledgeCounts,
  buildFacetOptions,
  buildReferenceSearchItems,
  decodeReferenceEntityKey,
  encodeReferenceEntityKey,
  partitionReferenceItems,
  projectReferenceEntity,
} from './search'

const importedAt = '2026-09-24T00:00:00.000Z' as Timestamp

function entity(id: string, values: Partial<CatalogEntity> & Pick<CatalogEntity, 'kind' | 'name'>): CatalogEntity {
  return {
    id: id as EntityId,
    aliases: [],
    fields: {},
    sources: [],
    ...values,
  }
}

function catalog(entities: readonly CatalogEntity[], claims: readonly CatalogClaim[] = []): CatalogSnapshot {
  return {
    id: 'pack:alpha' as CatalogId,
    revisionId: 'r:1' as CatalogRevisionId,
    schemaVersion: '1.0.0',
    checksum: 'synthetic',
    importedAt,
    applicability: { state: 'unknown' },
    rights: { state: 'known', value: 'Synthetic test fixture' },
    entities: Object.fromEntries(entities.map((value) => [value.id, value])),
    claims,
  }
}

describe('reference search projection', () => {
  const spear = entity('spear', {
    kind: 'item',
    name: 'Alpha Spear',
    aliases: ['Field lance'],
    rawDescription: 'Balanced reach weapon',
    fields: {
      Category: { state: 'known', value: 'Weapon' },
      Effect: { state: 'known', value: 'Poison on every hit' },
    },
    sources: [{ sourceId: 'equipment-sheet', locator: 'Items!A2' }],
  })
  const mantle = entity('mantle', {
    kind: 'passive',
    name: 'Beta Mantle',
    fields: { category: { state: 'known', value: 'Defense' } },
    ppCost: { state: 'known', value: 4 },
  })
  const echo = entity('echo', {
    kind: 'passive',
    name: 'Echo Ward',
    fields: { category: { state: 'unknown', reason: 'Missing label' } },
    ppCost: { state: 'conflicting', claims: [
      { value: 3, sources: [{ sourceId: 'sheet-a' }] },
      { value: 7, sources: [{ sourceId: 'sheet-b' }] },
    ] },
  })
  const snapshot = catalog([echo, mantle, spear], [{
    entityId: spear.id,
    field: 'Location',
    value: { state: 'unknown', reason: 'Not documented' },
    sources: [{ sourceId: 'locations-sheet' }],
  }])
  const items = buildReferenceSearchItems([snapshot])

  it('searches names, aliases, and raw text without treating normalized effects as labels', () => {
    expect(partitionReferenceItems(items, { query: 'field lance', kinds: [], categories: [], sources: [] }).confirmed.map((item) => item.entity.id)).toEqual(['spear'])
    expect(partitionReferenceItems(items, { query: 'balanced reach', kinds: [], categories: [], sources: [] }).confirmed.map((item) => item.entity.id)).toEqual(['spear'])
    const effectSearch = partitionReferenceItems(items, { query: 'poison', kinds: [], categories: [], sources: [] })
    expect(effectSearch.confirmed).toEqual([])
    expect(effectSearch.possible).toEqual([])
  })

  it('combines facets with OR within a facet and AND across facets', () => {
    const partition = partitionReferenceItems(items, {
      query: '',
      kinds: ['item', 'passive'],
      categories: ['Weapon', 'Defense'],
      sources: ['pack:alpha', 'equipment-sheet'],
    })
    expect(partition.confirmed.map((item) => item.entity.id)).toEqual(['spear', 'mantle'])
    expect(partition.possible.map((item) => item.entity.id)).toEqual(['echo'])
  })

  it('keeps unknown and conflicting PP values as possible while excluding inapplicable kinds', () => {
    const partition = partitionReferenceItems(items, {
      query: '',
      kinds: [],
      categories: [],
      sources: [],
      pp: { min: 3, max: 5, unit: 'PP' },
    })
    expect(partition.confirmed.map((item) => item.entity.id)).toEqual(['mantle'])
    expect(partition.possible.map((item) => item.entity.id)).toEqual(['echo'])
    expect(partition.excluded.map((item) => item.entity.id)).toEqual(['spear'])
    const wrongUnit = partitionReferenceItems(items, { query: '', kinds: [], categories: [], sources: [], pp: { min: 3, unit: 'LP' } })
    expect(wrongUnit.confirmed).toEqual([])
    expect(wrongUnit.possible).toEqual([])
  })

  it('sorts deterministically and exposes source, category, and knowledge facets', () => {
    expect(items.map((item) => item.entity.name)).toEqual(['Alpha Spear', 'Beta Mantle', 'Echo Ward'])
    expect(buildFacetOptions(items, 'source')).toContainEqual({ value: 'equipment-sheet', count: 1 })
    expect(buildFacetOptions(items, 'source')).toContainEqual({ value: 'locations-sheet', count: 1 })
    expect(buildFacetOptions(items, 'category')).toEqual([
      { value: 'Defense', count: 1 },
      { value: 'Weapon', count: 1 },
    ])
    expect(aggregateKnowledgeCounts(items)).toMatchObject({ unknown: 2, conflicting: 1 })
    expect(projectReferenceEntity(snapshot, spear).claims).toHaveLength(1)
  })

  it('uses a collision-safe tuple for selected reference identity', () => {
    const left = encodeReferenceEntityKey({ catalogId: 'a:b', catalogRevisionId: 'c', entityId: 'd' })
    const right = encodeReferenceEntityKey({ catalogId: 'a', catalogRevisionId: 'b:c', entityId: 'd' })
    expect(left).not.toBe(right)
    expect(decodeReferenceEntityKey(left)).toEqual({ catalogId: 'a:b', catalogRevisionId: 'c', entityId: 'd' })
    expect(decodeReferenceEntityKey('a:b:c:d')).toBeUndefined()
  })
})
