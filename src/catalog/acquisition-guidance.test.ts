import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG, PREVIOUS_CATALOG } from './bundled'
import { nativeItemAcquisition, projectAcquisitionGuidance } from './acquisition-guidance'
import receipts from './acquisition-guidance-receipts.json' with { type: 'json' }
import conditions from './acquisition-condition-facts.json' with { type: 'json' }
import world from './world-acquisition-v1.json' with { type: 'json' }
import routeFacts from './acquisition-route-facts.json' with { type: 'json' }
import { nativeGardening } from './native-gardening'
import { nativeRecord } from '../domain/native-game'
import type { CatalogEntity, JsonValue } from '../domain/types'

const entity = (id: string): CatalogEntity => DEFAULT_CATALOG.entities[id]!

describe('reviewed native acquisition presentation', () => {
  it('keeps another revision\'s prose visible while native acquisition routes remain available', () => {
    const before = JSON.stringify(PREVIOUS_CATALOG)
    const result = projectAcquisitionGuidance(PREVIOUS_CATALOG, PREVIOUS_CATALOG.entities['base:equipment:227']!)
    expect(result.acquisition.routes.map(route => route.kind)).toEqual(['drop', 'steal'])
    expect(result.replacedFields).toEqual([])
    expect(result.originalGuides).toEqual([])
    expect(result.retainedGuides).toEqual(result.acquisition.guides)
    expect(JSON.stringify(PREVIOUS_CATALOG)).toBe(before)
  })

  it('binds every reviewed condition meaning to a condition retained in its pinned world entity', () => {
    expect(conditions.worldContentDigest).toBe(world.contentDigest)
    expect(conditions.gameExecutableSha256).toBe(world.source.gameExecutableSha256)
    expect(conditions.nativeContentDigest).toBe(world.source.nativeContentDigest)
    const contains = (value: unknown, target: unknown): boolean => JSON.stringify(value) === JSON.stringify(target) || Boolean(value && typeof value === 'object' && Object.values(value).some(entry => contains(entry, target)))
    for (const fact of conditions.conditions) {
      expect(fact.evidence.length).toBeGreaterThan(0)
      expect(world.entries.some(entry => entry.entityID === fact.entityID && contains(entry.conditions, fact.condition)), fact.description).toBe(true)
    }
  })

  it('replaces complete drop and crafting claims while retaining the original evidence without changing the catalog', () => {
    const before = JSON.stringify(DEFAULT_CATALOG)
    const sword = projectAcquisitionGuidance(DEFAULT_CATALOG, entity('base:equipment:227'))
    expect(sword.replacedFields).toEqual(['Location'])
    expect(sword.retainedGuides).toEqual([])
    expect(sword.originalGuides[0]?.knowledge).toBe(entity('base:equipment:227').fields.Location)
    expect(sword.acquisition.routes.map(route => route.kind)).toEqual(['drop', 'steal'])
    const fursuit = projectAcquisitionGuidance(DEFAULT_CATALOG, entity('base:equipment:490'))
    expect(fursuit.replacedFields).toEqual(['Location', 'Description'])
    expect(fursuit.acquisition.routes[0]).toMatchObject({ price: 2000, ingredients: [{ name: 'Woke Quintar Eye', count: 2 }, { name: 'Quintar Shedding', count: 10 }, { name: 'Quintar Pelt', count: 1 }], requirements: [{ name: 'Babel Quintar' }] })
    expect(JSON.stringify(DEFAULT_CATALOG)).toBe(before)
  })

  it('keeps every receipt bound to complete original values and its reviewed native replacement', () => {
    for (const receipt of receipts.receipts) {
      const result = projectAcquisitionGuidance(DEFAULT_CATALOG, entity(receipt.entityId))
      expect(result.replacedFields, receipt.entityId).toContain(receipt.field)
      expect(result.originalGuides.find(guide => guide.field === receipt.field)?.evidence.length).toBeGreaterThan(0)
    }
  })

  it('replaces exact repeated acquisition descriptions while preserving changed guidance and the original source fields', () => {
    for (const id of ['base:item:20', 'base:item:132', 'base:item:34', 'base:item:35', 'base:equipment:490', 'base:equipment:244', 'base:item:102', 'base:item:142', 'base:item:145', 'base:item:171', 'base:equipment:373', 'base:item:11']) {
      const original = entity(id)
      const result = projectAcquisitionGuidance(DEFAULT_CATALOG, original)
      expect(result.replacedFields).toEqual(['Location', 'Description'])
      expect(result.originalGuides.map(guide => guide.knowledge)).toEqual([original.fields.Location, original.fields.Description])
      expect(original.fields.Description).toMatchObject({ state: 'known', value: original.fields.Location?.state === 'known' ? original.fields.Location.value : undefined })
      const changed = { ...original, fields: { ...original.fields, Description: { state: 'known' as const, value: 'A new direction or strategy has been added.' } } }
      expect(projectAcquisitionGuidance(DEFAULT_CATALOG, changed).replacedFields).toEqual(['Location'])
      expect(projectAcquisitionGuidance(DEFAULT_CATALOG, original, 'Chaos').replacedFields).toEqual([])
    }
  })

  it('retains mixed navigation and mechanic paragraphs and the Ember Scythe drop-versus-steal discrepancy', () => {
    for (const id of ['base:item:4', 'base:item:167', 'base:equipment:346', 'base:equipment:494', 'base:equipment:589']) {
      const result = projectAcquisitionGuidance(DEFAULT_CATALOG, entity(id))
      expect(result.replacedFields).toEqual([])
      expect(result.retainedGuides.length).toBeGreaterThan(0)
    }
    const scythe = nativeItemAcquisition(DEFAULT_CATALOG, entity('base:equipment:589'))
    expect(scythe.routes.map(route => route.kind)).toEqual(['steal'])
    expect(projectAcquisitionGuidance(DEFAULT_CATALOG, entity('base:equipment:589')).disagreements).toEqual([expect.objectContaining({ field: 'Location', summary: expect.stringContaining('100% availability and 10% success per attempt') })])
  })

  it('fails closed for edited prose, altered native facts, foreign catalogs and unreviewed modes', () => {
    const sword = entity('base:equipment:227')
    const edited = { ...sword, fields: { ...sword.fields, Location: { state: 'known' as const, value: 'Drop or steal: Rock Lizard in Beaurior Rock. A new route is also possible.' } } }
    expect(projectAcquisitionGuidance(DEFAULT_CATALOG, edited).replacedFields).toEqual([])
    expect(projectAcquisitionGuidance({ ...DEFAULT_CATALOG, checksum: 'different' }, sword).replacedFields).toEqual([])
    expect(projectAcquisitionGuidance(DEFAULT_CATALOG, sword, 'Chaos').replacedFields).toEqual([])
    for (const [field, value] of [['Game version', '1.6.6'], ['Game platform', 'Nintendo Switch'], ['Mode data', 'Chaos']]) expect(projectAcquisitionGuidance(DEFAULT_CATALOG, { ...sword, fields: { ...sword.fields, [field!]: { state: 'known', value: value! } } }).replacedFields).toEqual([])
    const monster = entity('base:monster:61')
    const changed = { ...monster, fields: { ...monster.fields, 'Native source record': { state: 'known' as const, value: { ID: 61, ItemDrops: [], ItemSteals: [] } } } }
    const altered = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [monster.id]: changed } }
    expect(projectAcquisitionGuidance(altered, sword).replacedFields).toEqual([])
    const guardian = entity('base:monster:224')
    const knowledge = guardian.fields['Native source record']
    if (knowledge?.state !== 'known' || !nativeRecord(knowledge.value)) throw new Error('Expected native monster record')
    const missingDrops: Record<string, JsonValue> = { ...knowledge.value }
    delete missingDrops.ItemDrops
    const incomplete = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [guardian.id]: { ...guardian, fields: { ...guardian.fields, 'Native source record': { state: 'known' as const, value: missingDrops } } } } }
    expect(projectAcquisitionGuidance(incomplete, entity('base:equipment:589')).disagreements).toEqual([])
  })

  it('explains the exact native race, penguin and arena requirements', () => {
    const conditions = (id: string) => nativeItemAcquisition(DEFAULT_CATALOG, entity(id)).routes.flatMap(route => route.conditions)
    expect(conditions('base:item:114')).toContain('Finish first in the Salmon Run')
    expect(conditions('base:item:4')).toContain('Finish in the top 10 in the Salmon Run')
    expect(conditions('base:equipment:183')).toContain('Return at least 6 lost penguins')
    expect(conditions('base:equipment:176')).toContain('Return at least 12 lost penguins')
    expect(conditions('base:equipment:440')).toContain('Win at least 4 Sky Arena battles')
    expect(conditions('base:equipment:244')).toContain('Win at least 9 Sky Arena battles')
    expect(conditions('base:equipment:244')).not.toContain('Win at least 1 Sky Arena battle')
  })

  it('adds the reviewed Rotten Salmon choice fee without changing the world snapshot or promoting it to other sources', () => {
    const originalWorld = JSON.stringify(world)
    expect(routeFacts.source).toMatchObject({ worldContentDigest: world.contentDigest, worldSha256: world.source.world.sha256, gameExecutableSha256: world.source.gameExecutableSha256, nativeContentDigest: world.source.nativeContentDigest, platform: world.source.platform, gameVersion: world.source.gameVersion })
    const salmon = entity('base:item:11')
    const result = projectAcquisitionGuidance(DEFAULT_CATALOG, salmon)
    expect(result.acquisition.routes).toEqual([expect.objectContaining({ kind: 'reward', label: 'Shady Merchant', location: 'Delende', price: 13, quantity: 1, conditions: ['Have fewer than 1 Rotten Salmon', 'Choose Buy'] })])
    expect(result.acquisition.routes[0]?.evidence).toContain('/NpcData/Pages/0/Actions/2/Data/Choices/0; Cost=13, IsCostOfItem=false')
    expect(result.replacedFields).toEqual(['Location', 'Description'])
    expect(result.originalGuides[0]?.knowledge).toBe(salmon.fields.Location)
    expect(nativeItemAcquisition(DEFAULT_CATALOG, salmon, 'Chaos').routes.some(route => route.price !== undefined)).toBe(false)
    expect(nativeItemAcquisition({ ...DEFAULT_CATALOG, checksum: 'different' }, salmon).routes.some(route => route.price !== undefined)).toBe(false)
    const changed = { ...salmon, fields: { ...salmon.fields, 'Game version': { state: 'known' as const, value: '1.6.6' } } }
    expect(nativeItemAcquisition(DEFAULT_CATALOG, changed).routes.some(route => route.price !== undefined)).toBe(false)
    expect(JSON.stringify(world)).toBe(originalWorld)
  })

  it('derives gardening encounters and preserves whole-minute watering rounding', () => {
    const sketchy = nativeGardening(DEFAULT_CATALOG, entity('base:item:178'))
    expect(sketchy).toMatchObject({ minutes: 5, wateringReductionMinutes: 2, encounters: [{ name: 'Weed', ref: { entityId: 'base:monster:270' } }] })
    expect(nativeGardening(DEFAULT_CATALOG, entity('base:item:183'))).toMatchObject({ minutes: 1, wateringReductionMinutes: 0, encounters: [{ name: 'Particular Ore' }] })
    expect(nativeGardening(DEFAULT_CATALOG, entity('base:item:190'))).toMatchObject({ minutes: 30, wateringReductionMinutes: 15, encounters: [{ name: 'Blood Carrot' }] })
    expect(nativeGardening({ ...DEFAULT_CATALOG, checksum: 'different' }, entity('base:item:178'))).toBeUndefined()
    expect(nativeGardening(DEFAULT_CATALOG, entity('base:item:0'))).toBeUndefined()
    const seed = entity('base:item:178')
    for (const [field, value] of [['Game version', '1.6.6'], ['Game platform', 'Nintendo Switch'], ['Mode data', 'Chaos']]) expect(nativeGardening(DEFAULT_CATALOG, { ...seed, fields: { ...seed.fields, [field!]: { state: 'known', value: value! } } })).toBeUndefined()
    const weed = entity('base:monster:270')
    expect(nativeGardening({ ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [weed.id]: { ...weed, name: 'A different encounter' } } }, seed)).toBeUndefined()
  })
})
