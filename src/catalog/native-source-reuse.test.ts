import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from './bundled'
import * as definitionValues from '../domain/definition-values'
import { immutableCatalogSnapshot } from '../interchange/native'
import { nativeFieldFacts } from './native-field-facts'
import { nativeEquipmentFacts } from './native-equipment-facts'
import type { CatalogSnapshot } from '../domain/types'

afterEach(() => vi.restoreAllMocks())

it('compares complete immutable source metadata once while preserving both native projections', () => {
  const catalog = immutableCatalogSnapshot(structuredClone(DEFAULT_CATALOG))
  const entity = catalog.entities['base:equipment:134']!
  const expectedFields = nativeFieldFacts(DEFAULT_CATALOG, DEFAULT_CATALOG.entities[entity.id]!)
  const expectedEquipment = nativeEquipmentFacts(DEFAULT_CATALOG, DEFAULT_CATALOG.entities[entity.id]!)
  const comparison = vi.spyOn(definitionValues, 'sameValue')
  for (let repeat = 0; repeat < 3; repeat++) {
    expect(nativeFieldFacts(catalog, entity)).toEqual(expectedFields)
    expect(nativeEquipmentFacts(catalog, entity)).toEqual(expectedEquipment)
  }
  expect(comparison.mock.calls.filter(([left, right]) => left === catalog.legacy && right === DEFAULT_CATALOG.legacy)).toHaveLength(1)
})

it.each([false, true])('rechecks changed nested source metadata when only the catalog shell is frozen: %s', shallowFreeze => {
  const legacy = structuredClone(DEFAULT_CATALOG.legacy) as Record<string, unknown>
  const catalog: CatalogSnapshot = { ...DEFAULT_CATALOG, legacy: legacy as CatalogSnapshot['legacy'] }
  if (shallowFreeze) Object.freeze(catalog)
  const entity = catalog.entities['base:equipment:134']!
  expect(nativeFieldFacts(catalog, entity).length).toBeGreaterThan(0)
  expect(nativeEquipmentFacts(catalog, entity)).toBeDefined()
  legacy['synthetic-source-annotation'] = { changed: true }
  expect(nativeFieldFacts(catalog, entity)).toEqual([])
  expect(nativeEquipmentFacts(catalog, entity)).toBeUndefined()
})

it('retains unknown metadata differences on a separately admitted immutable catalog', () => {
  const original = structuredClone(DEFAULT_CATALOG)
  const catalog = immutableCatalogSnapshot({ ...original, legacy: { ...(original.legacy as Record<string, never>), 'synthetic-source-annotation': { changed: true } } })
  const entity = catalog.entities['base:equipment:134']!
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(nativeFieldFacts(catalog, entity)).toEqual([])
    expect(nativeEquipmentFacts(catalog, entity)).toBeUndefined()
  }
})
