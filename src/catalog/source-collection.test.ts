import { expect, it } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from './bundled'
import { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'
import { authoredReferenceSources, classifyAuthoredSource } from './reference-supplements'
import { guideCatalog } from './guide-catalog'
import { vanillaCatalog } from './vanilla-catalog'
import { nativeIdentity } from '../domain/native-game'
import { buildDefinitionOptions } from '../ui/definitions'
import { buildModLibraryCards } from '../ui/mod-library-data'
import { createTestLocalData } from '../domain/test-helpers'
import { SOURCE_REVISION_RECEIPTS } from './source-revisions'

it('ships one independently versioned vanilla and guide collection without mod discovery or definitions', () => {
  expect(BUNDLED_CATALOGS.map(source => [source.id, source.revisionId])).toEqual([
    ['crystal-project/vanilla', 'v1'], ['crystal-project/guide/modding', 'v1'],
  ])
  expect(BUNDLED_MOD_LIBRARY).toEqual([])
  const data = createTestLocalData()
  expect(buildModLibraryCards(BUNDLED_CATALOGS, buildDefinitionOptions(data, BUNDLED_CATALOGS), data)).toEqual([])
  for (const source of BUNDLED_CATALOGS) {
    expect(SOURCE_REVISION_RECEIPTS).toContainEqual({ id: source.id, revisionId: source.revisionId, checksum: source.checksum })
    expect(Object.keys(source.entities).some(id => id.startsWith('mod:'))).toBe(false)
  }
  expect(CURRENT_CATALOG).toEqual(vanillaCatalog(CURRENT_CATALOG.checksum))
  expect(Object.keys(CURRENT_CATALOG.entities).some(id => id.startsWith('base:mechanic:'))).toBe(false)
  expect(Object.values(CURRENT_CATALOG.entities).some(entity => nativeIdentity(entity) && nativeIdentity(entity)?.mode !== 'base')).toBe(true)
})

it('classifies every authored entry and retains guide conflicts under stable source-relative IDs', () => {
  const source = authoredReferenceSources()
  const classes = new Set(Object.values(source.entities).map(classifyAuthoredSource))
  expect(classes).toEqual(new Set(['vanilla', 'guide', 'excluded-mod', 'excluded-coverage']))
  const guide = guideCatalog('test')
  expect(Object.keys(guide.entities).every(id => /^ref-[1-9][0-9]*$/.test(id))).toBe(true)
  expect(guide.entities['ref-385']?.fields.Description).toMatchObject({ state: 'conflicting' })
  expect(guide.entities['ref-385']?.sources).toHaveLength(2)
  expect(() => classifyAuthoredSource({ ...Object.values(source.entities)[0]!, id: 'unknown:record' as never })).toThrow('Unclassified')
})
