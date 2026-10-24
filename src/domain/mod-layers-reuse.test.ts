import { expect, it } from 'vitest'
import { expandModCatalogs, MOD_CATALOG_SCHEMA } from './mod-layers'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot } from './types'

function fixture() {
  const base: CatalogSnapshot = { id: 'synthetic-base' as CatalogSnapshot['id'], revisionId: 'synthetic-r1' as CatalogSnapshot['revisionId'], schemaVersion: '1', checksum: 'synthetic', importedAt: '2026-01-01T00:00:00.000Z' as CatalogSnapshot['importedAt'], applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: { base: { id: 'base' as CatalogSnapshot['entities'][string]['id'], name: 'Synthetic base', kind: 'item', aliases: [], sources: [], fields: {} } }, claims: [] }
  const mod: CatalogSnapshot = { ...base, revisionId: 'synthetic-effective' as CatalogSnapshot['revisionId'], schemaVersion: MOD_CATALOG_SCHEMA, entities: { mod: { id: 'mod' as CatalogSnapshot['entities'][string]['id'], name: 'Synthetic passive', kind: 'passive', aliases: [], sources: [], fields: {} } }, legacy: { modBaseline: { catalogId: base.id, catalogRevisionId: base.revisionId }, crystalEditIdentities: { 'crystal-edit:Passives:1': 'mod' } } }
  return { base, mod }
}

it('retains exact immutable effective views across fresh arrays and repeated preparation', () => {
  const values = fixture(), base = immutableCatalogSnapshot(values.base), mod = immutableCatalogSnapshot(values.mod)
  const first = expandModCatalogs([base, mod])[1]!
  expect(Object.keys(first.entities)).toEqual(['base', 'mod'])
  expect(first.entities.base).toBe(base.entities.base)
  expect(first.entities.mod).toBe(mod.entities.mod)
  expect(expandModCatalogs([base, mod])[1]).toBe(first)
  expect(expandModCatalogs([base, immutableCatalogSnapshot(first)])[1]).toBe(first)
  expect(Object.isFrozen(first.entities)).toBe(true)
  expect(Object.isFrozen(first.claims)).toBe(true)
})

it.each([false, true])('does not reuse a mutable nested baseline or mod behind frozen shells: %s', shallow => {
  const { base, mod } = fixture()
  if (shallow) { Object.freeze(base); Object.freeze(mod) }
  const first = expandModCatalogs([base, mod])[1]!
  Object.assign(base.entities.base!, { name: 'Changed synthetic base' })
  Object.assign(mod.entities.mod!, { name: 'Changed synthetic passive' })
  const next = expandModCatalogs([base, mod])[1]!
  expect(next).not.toBe(first)
  expect(next.entities.base!.name).toBe('Changed synthetic base')
  expect(next.entities.mod!.name).toBe('Changed synthetic passive')
})

it('uses exact baseline and mod values rather than their equal IDs or digests', () => {
  const a = fixture(), b = fixture()
  Object.assign(b.base.entities.base!, { name: 'Different base under equal labels' })
  Object.assign(b.mod.entities.mod!, { name: 'Different mod under equal labels' })
  const baseA = immutableCatalogSnapshot(a.base), baseB = immutableCatalogSnapshot(b.base), modA = immutableCatalogSnapshot(a.mod), modB = immutableCatalogSnapshot(b.mod)
  const first = expandModCatalogs([baseA, modA])[1]!
  const otherBase = expandModCatalogs([baseB, modA])[1]!
  const otherMod = expandModCatalogs([baseA, modB])[1]!
  expect(otherBase).not.toBe(first)
  expect(otherBase.entities.base!.name).toBe('Different base under equal labels')
  expect(otherMod).not.toBe(first)
  expect(otherMod.entities.mod!.name).toBe('Different mod under equal labels')
  expect(() => expandModCatalogs([modA])).toThrow('unavailable or cyclic')
})
