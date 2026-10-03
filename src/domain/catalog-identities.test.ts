import { describe, expect, it } from 'vitest'
import { compileCatalogIdentities, compiledEntityId } from './catalog-identities'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { nativeIdentity, nativeRelationships } from './native-game'
import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { baseGameEntityId } from './entity-identities'
import type { CatalogEntity, CatalogSnapshot, EntityId } from './types'

function entity(id: string, legacy?: CatalogEntity['legacy']): CatalogEntity {
  return { id: id as EntityId, kind: 'item', name: 'A source name', aliases: [], fields: {}, sources: [], ...(legacy ? { legacy } : {}) }
}

describe('compiled catalog identities', () => {
  it('uses exact native and mod model identities throughout the bundled catalog', () => {
    for (const definition of Object.values(DEFAULT_CATALOG.entities)) {
      const native = nativeIdentity(definition)
      const mod = bundledModIdentity(definition)
      expect(definition.id).toBe(native ? baseGameEntityId(native.database, native.databaseId, native.mode) : mod ? bundledModEntityId(mod.key, mod.family, mod.modelId) : definition.id)
      if (!native && !mod) expect(definition.id).toMatch(/:ref-[1-9][0-9]*$/)
      if (native) for (const relationship of nativeRelationships(DEFAULT_CATALOG, definition)) if (relationship.targetId) expect(DEFAULT_CATALOG.entities[relationship.targetId]).toBeDefined()
    }
    expect(DEFAULT_CATALOG.entities['base:item:203']?.name).toBe('Quintar Berries')
    expect(DEFAULT_CATALOG.entities['mod:equipment-expansion:equipment:592']?.name).toBe('Heavy Edge')
    expect(DEFAULT_CATALOG.entities['base:item:quintar-berries']).toBeUndefined()
  })

  it('keeps supplemental allocations stable across renames and additions', () => {
    const original = entity('base:item:source-key')
    const allocations = { 'base:item:source-key': 42, 'base:item:another-source': 43 }
    expect(compiledEntityId(original, allocations)).toBe('base:item:ref-42')
    expect(compiledEntityId({ ...original, name: 'A completely different name' }, { ...allocations, 'base:item:new-source': 44 })).toBe('base:item:ref-42')
    expect(() => compiledEntityId(entity('base:item:unallocated'), allocations)).toThrow('Missing supplemental identity allocation')
  })

  it('updates typed references and evidence targets while preserving original source content', () => {
    const item = entity('base:item:source-key', { native: { database: 'item', databaseId: 203, mode: 'base' } })
    const other = { ...entity('base:other:source-key', { passiveEntityIds: { '7': item.id } }), kind: 'other' as const }
    const catalog: CatalogSnapshot = { ...DEFAULT_CATALOG, entities: { [item.id]: item, [other.id]: { ...other, fields: { Description: { state: 'known', value: item.id } }, requirements: { state: 'known', value: [{ kind: 'selected', ref: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: item.id } }, { kind: 'permission', permission: item.id }] } } }, claims: [{ entityId: item.id, field: 'Description', value: { state: 'known', value: item.id }, sources: [] }], legacy: { nativeIdentityBindings: { 'item:203': item.id }, nativeModeIdentityBindings: { 'base:item:203': item.id } } }
    const before = JSON.stringify(catalog)
    const compiled = compileCatalogIdentities(catalog, { [other.id]: 42 })
    expect(Object.keys(compiled.entities)).toEqual(['base:item:203', 'base:other:ref-42'])
    expect(compiled.claims[0]).toMatchObject({ entityId: 'base:item:203', value: { value: item.id } })
    expect(compiled.entities['base:other:ref-42']).toMatchObject({ fields: { Description: { value: item.id } }, requirements: { value: [{ ref: { entityId: 'base:item:203' } }, { permission: item.id }] }, legacy: { passiveEntityIds: { '7': 'base:item:203' } } })
    expect(compiled.legacy).toMatchObject({ nativeIdentityBindings: { 'item:203': 'base:item:203' }, nativeModeIdentityBindings: { 'base:item:203': 'base:item:203' } })
    expect(JSON.stringify(catalog)).toBe(before)
  })

  it('refuses duplicate source identities and reused supplemental allocations', () => {
    const first = entity('base:item:first', { native: { database: 'item', databaseId: 203, mode: 'base' } })
    const second = { ...first, id: 'base:item:second' as EntityId }
    const catalog = { ...DEFAULT_CATALOG, entities: { [first.id]: first, [second.id]: second }, claims: [], legacy: undefined }
    expect(() => compileCatalogIdentities(catalog, {})).toThrow('conflicting catalog identities')
    expect(() => compileCatalogIdentities(catalog, { one: 1, two: 1 })).toThrow('unique positive integers')
  })
})
