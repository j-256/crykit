import { afterEach, describe, expect, it, vi } from 'vitest'
import * as definitionValues from '../domain/definition-values'
import { immutableCatalogSnapshot } from '../interchange/native'
import { DEFAULT_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeDescription, nativeDescriptionSourceMatches, referenceDescription } from './native-description'
import { projectSourceSemantics } from './source-semantics'
import type { CatalogEntity } from '../domain/types'

afterEach(() => vi.restoreAllMocks())

const stew = DEFAULT_CATALOG.entities['base:item:132']!

describe('source-bound native descriptions', () => {
  it('projects reviewed descriptions without changing immutable catalog or source fields', () => {
    const before = JSON.stringify(stew)
    expect(nativeDescription(stew)?.complete).toBe(true)
    expect(referenceDescription(stew)).toContain('100% Missing HP')
    expect(nativeDescription(projectSourceSemantics(stew))).toEqual(nativeDescription(stew))
    expect(JSON.stringify(stew)).toBe(before)
  })

  it('does not reuse cached text after an imported clone changes', () => {
    const imported = JSON.parse(JSON.stringify(stew)) as CatalogEntity
    expect(nativeDescription(imported)).toBeDefined()
    Object.assign(imported, { rawDescription: 'Unreviewed imported description' })
    expect(nativeDescription(imported)).toBeUndefined()
    expect(referenceDescription(imported)).toBe('Unreviewed imported description')
    expect(nativeDescription({ ...stew, id: 'foreign:item:132' as CatalogEntity['id'] })).toBeUndefined()
  })

  it('requires the reviewed executable, vocabulary database, version, and snapshot identity', () => {
    expect(nativeDescriptionSourceMatches(NATIVE_GAME_DATA)).toBe(true)
    for (const source of [
      { ...NATIVE_GAME_DATA.source, gameVersion: 'unreviewed' },
      { ...NATIVE_GAME_DATA.source, platform: 'unreviewed' },
      { ...NATIVE_GAME_DATA.source, executable: { ...NATIVE_GAME_DATA.source.executable, sha256: 'unreviewed' } },
      { ...NATIVE_GAME_DATA.source, files: [] },
    ]) expect(nativeDescriptionSourceMatches({ ...NATIVE_GAME_DATA, source })).toBe(false)
    expect(nativeDescriptionSourceMatches({ ...NATIVE_GAME_DATA, contentDigest: 'unreviewed' })).toBe(false)
  })

  it('projects generated PC scope while retaining original text when native rendering has no supported lines', () => {
    const recipe = DEFAULT_CATALOG.entities['base:recipe:34']!
    const before = JSON.stringify(recipe)
    expect(nativeDescription(recipe)).toMatchObject({ complete: false, lines: [] })
    expect(referenceDescription(recipe)).toBe('PC 1.6.9.0 recipes base database.')
    expect(recipe.rawDescription).toBe('Windows 1.6.9 recipes base database.')
    expect(JSON.stringify(recipe)).toBe(before)
  })
})

// Repeated display derivation must not repeat native provenance comparisons for the same admitted record
it('reuses a corroborated description only for an exact admitted immutable record', () => {
  const catalog = immutableCatalogSnapshot(structuredClone(DEFAULT_CATALOG))
  const entity = catalog.entities[stew.id]!
  const comparison = vi.spyOn(definitionValues, 'sameValue')
  const first = nativeDescription(entity)
  expect(first?.complete).toBe(true)
  expect(comparison).toHaveBeenCalled()
  comparison.mockClear()
  expect(nativeDescription(entity)).toEqual(first)
  expect(comparison).not.toHaveBeenCalled()

  const changed = structuredClone(entity)
  Object.assign(changed, { rawDescription: 'Changed immutable source' })
  const changedCatalog = immutableCatalogSnapshot({ ...catalog, entities: { [changed.id]: changed } })
  expect(nativeDescription(changedCatalog.entities[changed.id]!)).toBeUndefined()
})

it('rechecks a cached record when only its shell is frozen', () => {
  const entity = Object.freeze(structuredClone(stew))
  expect(nativeDescription(entity)).toBeDefined()
  Object.assign(entity.fields, { 'Synthetic provenance': { state: 'unknown' } })
  expect(nativeDescription(entity)).toBeUndefined()
})
