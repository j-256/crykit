import { HISTORICAL_VANILLA, SYNTHETIC_MOD_OBSERVATIONS } from '../catalog/source-collection.test-helpers'
import { modSearchCatalog } from '../domain/mod-search'
import { expect, it } from 'vitest'
import { CURRENT_CATALOG, DEFAULT_CATALOG } from '../catalog/bundled'
import { updateGameSetupRevision } from '../domain/local-data'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import { MOD_CATALOG_SCHEMA } from '../domain/mod-layers'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { buildDefinitionOptions } from './definitions'
import { standingReferenceOptions } from './reference-library'
import { buildModLibraryCards } from './mod-library-data'
import { setModInReference } from '../domain/reference-library'

it('shows only the pinned original base revision while keeping historical catalogs available', () => {
  const catalogs = [HISTORICAL_VANILLA, CURRENT_CATALOG]
  const original = createTestLocalData()
  const options = buildDefinitionOptions(original, catalogs)
  for (const catalog of catalogs) {
    const data = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [catalog.id]: catalog.revisionId } })
    const selected = standingReferenceOptions(options, catalogs, data)
    const warrior = selected.filter(option => option.name === 'Warrior')
    expect(warrior).toHaveLength(1)
    expect(warrior[0]!.ref).toMatchObject({ catalogRevisionId: catalog.revisionId })
    expect(data.gameSetups[TEST_GAME_SETUP_REVISION_ID]).toBe(original.gameSetups[TEST_GAME_SETUP_REVISION_ID])
  }
})

it('uses the original baseline in Reference when planning pins an effective composition', () => {
  const effective = { ...CURRENT_CATALOG, revisionId: 'synthetic-effective' as typeof CURRENT_CATALOG.revisionId, schemaVersion: MOD_CATALOG_SCHEMA }
  const catalogs = [HISTORICAL_VANILLA, CURRENT_CATALOG, effective]
  const original = createTestLocalData()
  const data = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [effective.id]: effective.revisionId }, modComposition: { baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [], links: [] } })
  const selected = standingReferenceOptions(buildDefinitionOptions(data, catalogs), catalogs, data)
  const warrior = selected.filter(option => option.name === 'Warrior')
  expect(warrior).toHaveLength(1)
  expect(warrior[0]!.ref).toMatchObject({ catalogRevisionId: CURRENT_CATALOG.revisionId })
  expect(selected.some(option => option.ref.kind === 'catalog' && option.ref.catalogRevisionId === effective.revisionId)).toBe(false)
})

it('keeps pinned native and independently sourced mod observations visible independently of planning mod choices', () => {
  const data = updateGameSetupRevision(createTestLocalData(), { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, disabledMods: known(['Synthetic item mod', 'Synthetic class mod']), catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId } })
  const options = buildDefinitionOptions(data, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS])
  const selected = standingReferenceOptions(options, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS], data)
  expect(selected.some(option => option.name === 'Warrior')).toBe(true)
  expect(selected.some(option => option.name === 'Synthetic item mod' && option.modAvailability?.requiredMod === 'Synthetic item mod')).toBe(true)
  expect(selected.some(option => option.modAvailability?.requiredMod === 'Synthetic class mod')).toBe(true)
})

it('removes source-less mod contents from standing Reference and restores them independently of game state', () => {
  const original = updateGameSetupRevision(createTestLocalData(), { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId } })
  const options = buildDefinitionOptions(original, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS])
  const cards = buildModLibraryCards([CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS], options, original)
  let data = original
  for (const name of ['Synthetic class mod', 'Synthetic item mod']) {
    const card = cards.find(card => card.title === name)!
    data = setModInReference(data, card.id, false)
    expect(standingReferenceOptions(options, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS], data).some(option => option.modAvailability?.requiredMod === name)).toBe(false)
    const restored = setModInReference(data, card.id, true)
    expect(standingReferenceOptions(options, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS], restored).some(option => option.modAvailability?.requiredMod === name)).toBe(true)
  }
  expect(standingReferenceOptions(options, [CURRENT_CATALOG, SYNTHETIC_MOD_OBSERVATIONS], data).some(option => option.name === 'Warrior')).toBe(true)
  expect(data.gameSetups).toBe(original.gameSetups)
})

it('keeps all saved source revisions without inferring a latest release or mixing effective compositions', async () => {
  const parse = async (name: string) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-reference', Title: 'Synthetic reference mod', EditorVersion: 34, Items: [{ ID: 9000, Name: name }] })), 'synthetic.json')).proposed.catalogs[0]!
  const earlier = await parse('Synthetic earlier item')
  const latest = await parse('Synthetic latest item')
  const effective = { ...latest, id: DEFAULT_CATALOG.id, schemaVersion: MOD_CATALOG_SCHEMA }
  const catalogs = [earlier, latest, effective]
  const options = buildDefinitionOptions(createTestLocalData(), catalogs)
  const selected = standingReferenceOptions(options, catalogs, createTestLocalData())
  expect(selected.map(option => option.ref)).toEqual(expect.arrayContaining([earlier, latest].map(catalog => ({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: Object.values(catalog.entities)[0]!.id }))))
  expect(selected).toHaveLength(2)
  const hidden = setModInReference(createTestLocalData(), earlier.id, false)
  expect(standingReferenceOptions(options, catalogs, hidden)).toEqual([])
  expect(hidden.gameSetups).toEqual(createTestLocalData().gameSetups)
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
