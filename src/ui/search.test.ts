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
  partitionPersonalDefinitionOptions,
  partitionReferenceItems,
  personalDefinitionCategoryValues,
  personalDefinitionFacetValues,
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

  it('counts equivalent source wording as known without changing the immutable catalog', () => {
    const location = { state: 'conflicting' as const, claims: [
      { value: 'Chest: Shoudu Province', sources: [{ sourceId: 'table' }] },
      { value: 'It can be found in a chest, in Shoudu Province', sources: [{ sourceId: 'detail' }] },
    ] }
    const shoes = entity('shoes', { kind: 'item', name: 'Acrobat Shoes', fields: { Location: location } })
    const item = projectReferenceEntity(catalog([shoes]), shoes)
    expect(item.entity.fields.Location).toEqual({ state: 'known', value: 'Chest: Shoudu Province', sources: [{ sourceId: 'table' }, { sourceId: 'detail' }] })
    expect(item.knowledgeCounts).toMatchObject({ known: 1, conflicting: 0 })
    expect(shoes.fields.Location).toBe(location)
  })

  it('uses a collision-safe tuple for selected reference identity', () => {
    const left = encodeReferenceEntityKey({ catalogId: 'a:b', catalogRevisionId: 'c', entityId: 'd' })
    const right = encodeReferenceEntityKey({ catalogId: 'a', catalogRevisionId: 'b:c', entityId: 'd' })
    expect(left).not.toBe(right)
    expect(decodeReferenceEntityKey(left)).toEqual({ catalogId: 'a:b', catalogRevisionId: 'c', entityId: 'd' })
    expect(decodeReferenceEntityKey('a:b:c:d')).toBeUndefined()
  })

  it('combines class alternatives with element and mod filters without inventing missing facts', () => {
    const fixtures = [
      entity('ember', { kind: 'ability', name: 'Ember', fields: { Class: { state: 'known', value: 'Scribe' }, Element: { state: 'known', value: 'Fire' }, 'Source mod': { state: 'known', value: 'Test pack' } } }),
      entity('spark', { kind: 'ability', name: 'Spark', fields: { 'reference.associated_class': { state: 'known', value: 'Mage' }, elements: { state: 'known', value: ['Fire', 'Wind'] }, required_mod: { state: 'known', value: 'Test pack' } } }),
      entity('ice', { kind: 'ability', name: 'Ice', fields: { Class: { state: 'known', value: 'Scribe' }, Element: { state: 'known', value: 'Ice' } } }),
      entity('unknown', { kind: 'ability', name: 'Unknown' }),
      entity('conflict', { kind: 'ability', name: 'Conflict', fields: { Class: { state: 'conflicting', claims: [{ value: 'Scribe', sources: [] }, { value: 'Scout', sources: [] }] } } }),
      entity('town', { kind: 'location', name: 'Town' }),
    ]
    const items = buildReferenceSearchItems([catalog(fixtures)])
    const partition = partitionReferenceItems(items, { query: '', kinds: [], categories: [], sources: [], classes: ['Scribe', 'Mage'], elements: ['Fire'], mods: ['Test pack'] })
    expect(partition.confirmed.map(item => item.entity.id)).toEqual(['ember', 'spark'])
    expect(partition.possible.map(item => item.entity.id)).toEqual(['conflict', 'unknown'])
    expect(partition.excluded.map(item => item.entity.id)).toEqual(['ice', 'town'])
    expect(buildFacetOptions(items, 'classes')).toEqual([{ value: 'Mage', count: 1 }, { value: 'Scout', count: 1 }, { value: 'Scribe', count: 3 }])
  })

  it('uses explicit slot metadata and claim fields without guessing slots or element from names', () => {
    const blade = entity('blade', { kind: 'item', name: 'Fire Head Blade', fields: { equipment_type: { state: 'known', value: 'Blade' } }, slotKinds: { state: 'known', value: ['mainHand', 'offHand'] } })
    const body = entity('body', { kind: 'item', name: 'Coat', fields: { 'equipment slot': { state: 'known', value: 'body' } } })
    const unclear = entity('unclear', { kind: 'item', name: 'Unknown coat' })
    const recipe = entity('recipe', { kind: 'recipe', name: 'Recipe' })
    const items = buildReferenceSearchItems([catalog([blade, body, unclear, recipe], [{ entityId: blade.id, field: 'Element', value: { state: 'known', value: ['Wind', 'Wind'] }, sources: [] }])])
    const partition = partitionReferenceItems(items, { query: '', kinds: [], categories: [], sources: [], slots: ['mainHand', 'offHand'], elements: ['Wind'] })
    expect(partition.confirmed.map(item => item.entity.id)).toEqual(['blade'])
    expect(partition.possible.map(item => item.entity.id)).toEqual(['unclear'])
    expect(partition.excluded.map(item => item.entity.id)).toEqual(['body', 'recipe'])
    expect(buildFacetOptions(items, 'elements')).toEqual([{ value: 'Wind', count: 1 }])
    expect(buildFacetOptions(items, 'category')).toEqual([{ value: 'Blade', count: 1 }])
  })

  it('keeps class definitions with their documented skills when filtering by class', () => {
    const items = buildReferenceSearchItems([catalog([
      entity('scribe', { kind: 'class', name: 'Scribe' }),
      entity('scout', { kind: 'class', name: 'Scout' }),
      entity('skill', { kind: 'passive', name: 'Script', fields: { Class: { state: 'known', value: 'Scribe' } } }),
    ])])
    expect(partitionReferenceItems(items, { query: '', kinds: [], categories: [], sources: [], classes: ['Scribe'] }).confirmed.map(item => item.entity.id)).toEqual(['scribe', 'skill'])
  })

  it('includes all structured personal categories and field facets in filters and counts', () => {
    const personal = [
      { name: 'Personal blade', kind: 'item' as const, aliases: [], sourceLabel: 'Personal definitions', record: entity('personal', { name: 'Personal blade', kind: 'item', fields: { category: { state: 'known', value: 'Equipment' }, item_type: { state: 'known', value: 'Swords' }, Element: { state: 'known', value: 'Wind' } }, slotKinds: { state: 'known', value: ['mainHand'] } }) },
      { name: 'Personal area', kind: 'location' as const, aliases: [], sourceLabel: 'Personal definitions' },
    ]
    expect(personalDefinitionCategoryValues(personal[0]!)).toEqual(['Equipment', 'Swords'])
    expect(personalDefinitionFacetValues(personal[0]!, 'slots')).toEqual(['mainHand'])
    const partition = partitionPersonalDefinitionOptions(personal, { query: '', kinds: [], categories: ['Swords'], sources: [], elements: ['Wind'], slots: ['mainHand'] })
    expect(partition.confirmed.map(option => option.name)).toEqual(['Personal blade'])
    expect(partition.possible).toEqual([])
    expect(partition.excluded.map(option => option.name)).toEqual(['Personal area'])
  })

  it('keeps uncertain personal facets possible and excludes known mismatches', () => {
    const personal = [
      { name: 'Unknown Ward', kind: 'passive' as const, aliases: [], sourceLabel: 'Personal definitions', category: { state: 'unknown' as const }, ppCost: { state: 'unknown' as const } },
      { name: 'Conflicted Ward', kind: 'passive' as const, aliases: [], sourceLabel: 'Personal definitions', category: { state: 'conflicting' as const, claims: [
        { value: 'Defense', sources: [] },
        { value: 'Support', sources: [] },
      ] }, ppCost: { state: 'conflicting' as const, claims: [
        { value: 2, sources: [] },
        { value: 6, sources: [] },
      ] } },
      { name: 'Known Ward', kind: 'passive' as const, aliases: [], sourceLabel: 'Personal definitions', category: { state: 'known' as const, value: 'Defense' }, ppCost: { state: 'known' as const, value: 4 } },
      { name: 'Known Mismatch', kind: 'passive' as const, aliases: [], sourceLabel: 'Personal definitions', category: { state: 'known' as const, value: 'Offense' }, ppCost: { state: 'known' as const, value: 9 } },
    ]
    const partition = partitionPersonalDefinitionOptions(personal, {
      query: '',
      kinds: ['passive'],
      categories: ['Defense'],
      sources: ['Personal definitions'],
      pp: { min: 3, max: 5, unit: 'PP' },
    })
    expect(partition.confirmed.map((option) => option.name)).toEqual(['Known Ward'])
    expect(partition.possible.map((option) => option.name)).toEqual(['Unknown Ward', 'Conflicted Ward'])
    expect(partition.excluded.map((option) => option.name)).toEqual(['Known Mismatch'])
    expect(personalDefinitionCategoryValues(personal[1]!)).toEqual(['Defense', 'Support'])
  })

  it('uses an override lineage mod association without hiding conflicting recorded fields', () => {
    const personal = [
      { name: 'Mod override', kind: 'item' as const, aliases: [], sourceLabel: 'Personal definitions', modAvailability: { requiredMod: 'Synthetic expansion' } },
      { name: 'Conflicting override', kind: 'item' as const, aliases: [], sourceLabel: 'Personal definitions', modAvailability: { requiredMod: 'Synthetic expansion' }, record: entity('conflicting-mod', { kind: 'item', name: 'Conflicting override', fields: { 'Source mod': { state: 'conflicting', claims: [{ value: 'Synthetic expansion', sources: [] }, { value: 'Another pack', sources: [] }] } } }) },
    ]
    const partition = partitionPersonalDefinitionOptions(personal, { query: '', kinds: [], categories: [], sources: [], mods: ['Synthetic expansion'] })
    expect(partition.confirmed.map(option => option.name)).toEqual(['Mod override'])
    expect(partition.possible.map(option => option.name)).toEqual(['Conflicting override'])
    expect(personalDefinitionFacetValues(personal[0]!, 'mods')).toEqual(['Synthetic expansion'])
  })
})
