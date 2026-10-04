import { describe, expect, it } from 'vitest'
import { itemAcquisition, validateWorldAcquisition, type AcquisitionConditionFacts, type WorldAcquisitionSnapshot } from './item-acquisition'
import { nativeEntityId } from './native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue } from './types'

const HASH = '1'.repeat(64)
const definition = (database: string, id: number, name: string, record: Readonly<Record<string, JsonValue>>, mode = 'base'): CatalogEntity => ({ id: nativeEntityId(database, id, mode), kind: database === 'monster' ? 'monster' : database === 'recipe' ? 'recipe' : database === 'biome' ? 'location' : 'item', name, aliases: [], fields: { 'Native source record': { state: 'known', value: { ID: id, Name: name, ...record } } }, sources: [], legacy: { native: { database, databaseId: id, mode } } })
function fixture() {
  const entities = [definition('item', 0, 'Synthetic berry', { Cost: 20999 }), definition('equipment', 0, 'Synthetic gear', {}), definition('biome', 2, 'Synthetic shrine', {}), definition('monster', 4, 'Synthetic slime', { Level: 3, LocationBiomeID: 2, ItemDrops: [{ LootType: 1, ItemID: 0, LootChance: 50 }], ItemSteals: [{ LootType: 1, ItemID: 0, LootChance: 75, StealChance: 60 }] }), definition('item', 1, 'Synthetic herb', {}), definition('recipe', 5, 'Synthetic recipe', { LootType: 1, LootID: 0, Cost: 100, Ingredients: [{ LootType: 1, LootID: 1, LootQuantity: 2 }] })]
  const catalog = { id: 'synthetic-catalog', revisionId: 'synthetic-revision', schemaVersion: 'synthetic', checksum: 'synthetic', importedAt: '2026-01-01T00:00:00Z', applicability: { state: 'unknown' }, rights: { state: 'unknown' }, claims: [], entities: Object.fromEntries(entities.map(entity => [entity.id, entity])), legacy: { sourceContentDigest: HASH, nativeSource: { platform: 'Windows', gameVersion: 'synthetic', executable: { sha256: HASH } } } } as unknown as CatalogSnapshot
  const source: WorldAcquisitionSnapshot['source'] = { platform: 'Windows', gameVersion: 'synthetic', gameExecutableSha256: HASH, editorExecutableSha256: HASH, world: { path: 'Content/Worlds/field.dat', sha256: HASH, size: 1 }, biomes: { path: 'Content/Database/biome.dat', sha256: HASH, size: 1 }, scope: 'synthetic', rights: 'synthetic', evidence: [], nativeContentDigest: HASH, systemSha256: HASH }
  const world: WorldAcquisitionSnapshot = { schemaVersion: 1, contentDigest: HASH, source, entries: [{ family: 'item', targetID: 0, kind: 'shop', entityID: 4, biomeID: 2, label: 'Synthetic merchant', path: '/shop', conditions: [{ type: 'CanUnderstandQuintar', negated: false, data: {} }], costRate: 50 }, { family: 'recipe', targetID: 5, kind: 'craft', entityID: 5, biomeID: 2, label: 'Synthetic crafter', path: '/craft', conditions: [] }] }
  return { catalog, world, item: entities[0]! }
}

describe('item acquisition', () => {
  it('uses reviewed condition meanings only for the exact world, entity and condition', () => {
    const { catalog, world, item } = fixture()
    const condition = { type: 'CheckNumber', negated: false, data: { Scope: 'Global', VariableKey: 'SyntheticCounter', Eval: 'GreaterEqual', Number: 3 } }
    const exact = { ...world, entries: [{ ...world.entries[0]!, conditions: [condition] }] }
    const facts: AcquisitionConditionFacts = { worldContentDigest: world.contentDigest, gameExecutableSha256: world.source.gameExecutableSha256, nativeContentDigest: world.source.nativeContentDigest, conditions: [{ entityID: 4, condition, description: 'Complete three synthetic trials', evidence: ['Synthetic counter assignment and reward condition'] }] }
    const shop = (snapshot: WorldAcquisitionSnapshot, evidence = facts) => itemAcquisition(catalog, item, snapshot, 'base', evidence).routes.find(route => route.kind === 'shop')?.conditions
    expect(shop(exact)).toEqual(['Complete three synthetic trials'])
    expect(shop(exact, { ...facts, worldContentDigest: 'different' })).toEqual(['Additional story or interaction conditions apply'])
    expect(shop({ ...exact, entries: [{ ...exact.entries[0]!, entityID: 99 }] })).toEqual(['Additional story or interaction conditions apply'])
    expect(shop({ ...exact, entries: [{ ...exact.entries[0]!, conditions: [{ ...condition, negated: true }] }] })).toEqual(['Additional story or interaction conditions apply'])
  })

  it('links exact item identities, keeps drop and steal rates distinct, and resolves ingredients and crafting locations', () => {
    const { catalog, world, item } = fixture()
    const before = JSON.stringify(catalog)
    const result = itemAcquisition(catalog, item, world)
    expect(result.worldMatched).toBe(true)
    expect(result.routes.find(route => route.kind === 'drop')).toMatchObject({ chance: 50, location: 'Synthetic shrine', ref: { entityId: nativeEntityId('monster', 4) } })
    expect(result.routes.find(route => route.kind === 'steal')).toMatchObject({ chance: 75, success: 60 })
    expect(result.routes.find(route => route.kind === 'shop')).toMatchObject({ price: 10400, conditions: ['Understand Quintars'] })
    expect(result.routes.filter(route => route.kind === 'craft')).toEqual([expect.objectContaining({ location: 'Synthetic shrine', price: 100, ingredients: [expect.objectContaining({ name: 'Synthetic herb', count: 2, ref: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: nativeEntityId('item', 1) } })] })])
    expect(itemAcquisition(catalog, catalog.entities[nativeEntityId('equipment', 0)]!, world).routes).toEqual([])
    expect(JSON.stringify(catalog)).toBe(before)
  })

  it('applies selected mode overrides before reverse lookup and inherits unchanged records', () => {
    const { catalog, world, item } = fixture()
    const override = definition('monster', 4, 'Synthetic chaos slime', { ItemDrops: [], ItemSteals: [] }, 'Chaos')
    const next = { ...catalog, entities: { ...catalog.entities, [override.id]: override } }
    expect(itemAcquisition(next, item, world, 'Chaos').routes.some(route => route.kind === 'drop')).toBe(false)
    expect(itemAcquisition(next, item, world, 'Vanilla').routes.some(route => route.kind === 'drop')).toBe(true)
    expect(itemAcquisition(next, item, world, 'Chaos').routes.some(route => route.kind === 'craft')).toBe(true)
    expect(itemAcquisition(next, item, world, 'unsupported')).toMatchObject({ routes: [], unresolved: ['Acquisition routes are unresolved for this game mode'] })
  })

  it('withholds world routes from mismatched revisions and preserves unresolved acquisition instead of inferring absence', () => {
    const { catalog, world, item } = fixture()
    const result = itemAcquisition(catalog, item, { ...world, source: { ...world.source, nativeContentDigest: '2'.repeat(64) } })
    expect(result.worldMatched).toBe(false)
    expect(result.routes.some(route => route.kind === 'shop')).toBe(false)
    expect(result.unresolved).toContain('World acquisition routes are not verified for this source revision')
    const unknown = { ...item, legacy: undefined, fields: { Acquisition: { state: 'known' as const, value: 'Synthetic guide instructions' } } }
    expect(itemAcquisition(catalog, unknown, world)).toMatchObject({ routes: [], guides: [{ field: 'Acquisition', value: 'Synthetic guide instructions' }], unresolved: ['Acquisition routes have not been mapped to this exact definition'] })
  })

  it('rejects raw scripts and corrupt acquisition shapes', () => {
    const { world } = fixture()
    expect(() => validateWorldAcquisition(world)).not.toThrow()
    expect(() => validateWorldAcquisition({ ...world, entries: [{ ...world.entries[0], dialogue: 'Raw dialogue' }] })).toThrow()
    expect(() => validateWorldAcquisition({ ...world, schemaVersion: 2 })).toThrow()
    expect(() => validateWorldAcquisition({ ...world, entries: [{ ...world.entries[0], targetID: -1 }] })).toThrow()
    expect(() => validateWorldAcquisition({ ...world, entries: [{ ...world.entries[0], conditions: [{ type: 'Always', negated: false, data: { Message: 'Raw dialogue' } }] }] })).toThrow()
    expect(() => validateWorldAcquisition({ ...world, entries: [{ ...world.entries[0], conditions: [{ type: 'Operation', negated: false, data: { LHS: { type: 'Always', negated: false, data: {}, script: 'Raw script' } } }] }] })).toThrow()
  })

  it('links item requirements without treating alternative or negated requirements as mandatory, and labels conditional recovery', () => {
    const { catalog, world, item } = fixture()
    const requirement = { type: 'CheckInventory', negated: false, data: { LootType: 'Item', LootValue: 1, Count: 2 } }
    const conditional: WorldAcquisitionSnapshot = { ...world, entries: [{ ...world.entries[0]!, conditions: [requirement, requirement, { type: 'Operation', negated: false, data: { LHS: requirement, Op: 'Or', RHS: { ...requirement, data: { ...requirement.data, LootValue: 0 } } } }] }, { ...world.entries[0]!, kind: 'recovery', conditions: [{ type: 'Randomizer', negated: false, data: { InvalidItemID: 0 } }, { ...requirement, negated: true }] }] }
    const result = itemAcquisition(catalog, item, conditional)
    expect(result.routes.find(route => route.kind === 'shop')?.requirements).toEqual([expect.objectContaining({ name: 'Synthetic herb', count: 2 })])
    expect(result.routes.find(route => route.kind === 'recovery')).toMatchObject({ requirements: [], conditions: ['Randomizer recovery; depends on the current item mapping', 'Have fewer than 2 Synthetic herb'] })
    const unsupported = { ...world, entries: [{ ...world.entries[0]!, conditions: [{ ...requirement, data: { ...requirement.data, LootType: 'Nothing', LootValue: 0 } }] }] }
    expect(itemAcquisition(catalog, item, unsupported).routes.find(route => route.kind === 'shop')).toMatchObject({ requirements: [], conditions: ['Additional story or interaction conditions apply'] })
  })
})
