import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from './bundled'
import { nativeItemAcquisition } from './acquisition-guidance'
import conditions from './acquisition-condition-facts.json' with { type: 'json' }
import world from './world-acquisition-v1.json' with { type: 'json' }
import type { CatalogEntity } from '../domain/types'

const entity = (id: string): CatalogEntity => CURRENT_CATALOG.entities[id]!

describe('native acquisition presentation', () => {
  it('keeps drops and steals separate without historical guide claims', () => {
    const before = JSON.stringify(CURRENT_CATALOG)
    expect(nativeItemAcquisition(CURRENT_CATALOG, entity('base:equipment:227')).routes.map(route => route.kind)).toEqual(['drop', 'steal'])
    expect(nativeItemAcquisition(CURRENT_CATALOG, entity('base:equipment:589')).routes.map(route => route.kind)).toEqual(['steal'])
    expect(nativeItemAcquisition(CURRENT_CATALOG, entity('base:equipment:227')).guides).toEqual([])
    expect(JSON.stringify(CURRENT_CATALOG)).toBe(before)
  })

  it('retains native crafting ingredients, requirements, and reviewed shop prices', () => {
    const fursuit = nativeItemAcquisition(CURRENT_CATALOG, entity('base:equipment:490'))
    expect(fursuit.routes[0]).toMatchObject({ price: 2000, ingredients: [{ name: 'Woke Quintar Eye', count: 2 }, { name: 'Quintar Shedding', count: 10 }, { name: 'Quintar Pelt', count: 1 }], requirements: [{ name: 'Babel Quintar' }] })
    const ocarina = nativeItemAcquisition(CURRENT_CATALOG, entity('base:item:115'))
    expect(ocarina.routes.some(route => route.kind === 'shop' && route.price === 120000)).toBe(true)
  })

  it('binds condition descriptions to conditions retained in their pinned native world entities', () => {
    expect(conditions.worldContentDigest).toBe(world.contentDigest)
    expect(conditions.gameExecutableSha256).toBe(world.source.gameExecutableSha256)
    expect(conditions.nativeContentDigest).toBe(world.source.nativeContentDigest)
    const contains = (value: unknown, target: unknown): boolean => JSON.stringify(value) === JSON.stringify(target) || Boolean(value && typeof value === 'object' && Object.values(value).some(entry => contains(entry, target)))
    for (const fact of conditions.conditions) {
      expect(fact.evidence.length).toBeGreaterThan(0)
      expect(world.entries.some(entry => entry.entityID === fact.entityID && contains(entry.conditions, fact.condition)), fact.description).toBe(true)
    }
  })
})
