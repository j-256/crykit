import { modSearchCatalog } from '../domain/mod-search'
import { expect, it } from 'vitest'
import { CURRENT_CATALOG, DEFAULT_CATALOG } from '../catalog/bundled'
import { updateGameSetupRevision } from '../domain/local-data'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { MOD_CATALOG_SCHEMA } from '../domain/mod-layers'
import { asTimestamp } from '../domain/core'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { buildDefinitionOptions } from './definitions'
import { standingReferenceOptions } from './reference-library'
import { buildModLibraryCards } from './mod-library-data'
import { setModInReference } from '../domain/reference-library'

it('shows only the pinned original base revision while keeping both immutable catalogs available', () => {
  const catalogs = [DEFAULT_CATALOG, CURRENT_CATALOG]
  const original = createTestLocalData()
  const options = buildDefinitionOptions(original, catalogs)
  for (const catalog of catalogs) {
    const data = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [catalog.id]: catalog.revisionId } })
    const selected = standingReferenceOptions(options, catalogs, data)
    const warrior = selected.filter(option => option.name === 'Warrior')
    expect(warrior).toHaveLength(1)
    expect(warrior[0]!.ref).toMatchObject({ catalogRevisionId: catalog.revisionId })
    expect(selected.filter(option => option.name === 'Doge Shield')).toHaveLength(1)
    expect(data.gameSetups[TEST_GAME_SETUP_REVISION_ID]).toBe(original.gameSetups[TEST_GAME_SETUP_REVISION_ID])
  }
})

it('uses the original baseline in Reference when planning pins an effective composition', () => {
  const effective = { ...CURRENT_CATALOG, revisionId: 'synthetic-effective' as typeof CURRENT_CATALOG.revisionId, schemaVersion: MOD_CATALOG_SCHEMA }
  const catalogs = [DEFAULT_CATALOG, CURRENT_CATALOG, effective]
  const original = createTestLocalData()
  const data = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [effective.id]: effective.revisionId }, modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [], links: [] } })
  const selected = standingReferenceOptions(buildDefinitionOptions(data, catalogs), catalogs, data)
  const warrior = selected.filter(option => option.name === 'Warrior')
  expect(warrior).toHaveLength(1)
  expect(warrior[0]!.ref).toMatchObject({ catalogRevisionId: CURRENT_CATALOG.revisionId })
  expect(selected.some(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === effective.revisionId)).toBe(false)
})

it('keeps vanilla and Switch pack records visible independently of planning mod choices', () => {
  const data = updateGameSetupRevision(createTestLocalData(), { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, disabledMods: known(['Doge Shield', 'Equipment Expansion']), catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId } })
  const options = buildDefinitionOptions(data, [DEFAULT_CATALOG])
  const selected = standingReferenceOptions(options, [DEFAULT_CATALOG], data)
  expect(selected.some(option => option.name === 'Warrior')).toBe(true)
  expect(selected.some(option => option.name === 'Doge Shield' && option.modAvailability?.requiredMod === 'Doge Shield')).toBe(true)
  expect(selected.some(option => option.modAvailability?.requiredMod === 'Equipment Expansion')).toBe(true)
})

it('removes built-in and source-less mod contents from standing Reference and restores them independently of game state', () => {
  const original = createTestLocalData()
  const options = buildDefinitionOptions(original, [DEFAULT_CATALOG])
  const cards = buildModLibraryCards([DEFAULT_CATALOG], options, original)
  let data = original
  for (const name of ['Equipment Expansion', 'Doge Shield']) {
    const card = cards.find(card => card.title === name)!
    data = setModInReference(data, card.id, false)
    expect(standingReferenceOptions(options, [DEFAULT_CATALOG], data).some(option => option.modAvailability?.requiredMod === name)).toBe(false)
    const restored = setModInReference(data, card.id, true)
    expect(standingReferenceOptions(options, [DEFAULT_CATALOG], restored).some(option => option.modAvailability?.requiredMod === name)).toBe(true)
  }
  expect(standingReferenceOptions(options, [DEFAULT_CATALOG], data).some(option => option.name === 'Warrior')).toBe(true)
  expect(data.gameSetups).toBe(original.gameSetups)
})

it('uses explicitly saved latest mod catalogs without mixing planning compositions or earlier versions', async () => {
  const parse = async (name: string) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-reference', Title: 'Synthetic reference mod', EditorVersion: 34, Items: [{ ID: 9000, Name: name }] })), 'synthetic.json')).proposed.catalogs[0]!
  const earlier = { ...await parse('Synthetic earlier item'), importedAt: asTimestamp('2026-01-01T00:00:00Z') }
  const latest = { ...await parse('Synthetic latest item'), importedAt: asTimestamp('2026-01-02T00:00:00Z') }
  const effective = { ...latest, id: DEFAULT_CATALOG.id, schemaVersion: MOD_CATALOG_SCHEMA }
  const catalogs = [earlier, latest, effective]
  const options = buildDefinitionOptions(createTestLocalData(), catalogs)
  const selected = standingReferenceOptions(options, catalogs, createTestLocalData())
  expect(selected.map(option => option.ref)).toEqual([{ kind: 'catalog', catalogId: latest.id, catalogRevisionId: latest.revisionId, entityId: Object.values(latest.entities)[0]!.id }])
})

it('keeps unloaded preview records out of Reference even when search options include them', async () => {
  const catalog = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-unloaded-reference', Title: 'Synthetic unloaded mod', Items: [{ ID: 9000, Name: 'Synthetic unloaded item' }] })), 'synthetic.json')).proposed.catalogs[0]!
  const preview = modSearchCatalog(catalog)
  const data = createTestLocalData()
  const options = buildDefinitionOptions(data, [CURRENT_CATALOG, preview])
  expect(options.some(option => option.name === 'Synthetic unloaded item')).toBe(true)
  expect(standingReferenceOptions(options, [CURRENT_CATALOG], data).some(option => option.name === 'Synthetic unloaded item')).toBe(false)
  expect(standingReferenceOptions(options, [CURRENT_CATALOG, preview], data).some(option => option.name === 'Synthetic unloaded item')).toBe(false)
})
