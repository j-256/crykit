import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource } from '../catalog/mod-library'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { buildBehavior } from './build-behavior'
import { buildContentForModSetup, buildModRequirements, selectBuildModRevision } from './build-mods'
import { defaultCalculation } from './calculation-plan'
import { resolveGameRules } from './game-rules'
import { composeModCatalog, modCatalogRevision } from './mod-layers'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { BuildRevisionContent, CatalogRef, GameSetupRevision } from './types'
import { calculatePCStats } from './pc-stats'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { resolveCalculationEntity } from '../ui/model'

const freelancer: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: Object.values(DEFAULT_CATALOG.entities).find(entity => entity.kind === 'class' && entity.name === 'Freelancer')!.id }
const content: BuildRevisionContent = { primaryClass: freelancer, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(freelancer) }

it('finds the source project for selections and growth without duplicate requirements', () => {
  const data = createTestLocalData()
  const setup = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const requirements = buildModRequirements({ ...content, secondaryClass: freelancer }, data, [DEFAULT_CATALOG], setup)
  expect(requirements).toEqual([{ name: 'Moonlight Project', projectId: BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'moonlight-project')!.id, state: 'unknown', selections: ['Freelancer'] }])
  expect(buildModRequirements({ ...content, primaryClass: null, calculation: content.calculation }, data, [DEFAULT_CATALOG], setup)).toEqual(requirements)
  expect(data.gameSetups[setup.id]).toEqual(setup)
})

it('enables the exact Moonlight source, reconciles named choices, and calculates Freelancer without changing older setups', async () => {
  const data = createTestLocalData()
  const original = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const source = await bundledModEditableSource(BUNDLED_MOD_LIBRARY.find(mod => mod.key === 'moonlight-project')!)
  const imported = (await previewCrystalEdit(new TextEncoder().encode(source.text), source.filename)).proposed.catalogs[0]!
  const catalogs = [DEFAULT_CATALOG, imported]
  const before = { ...buildBehavior(original), mods: { state: 'known' as const, value: ['Unrelated mod'] }, disabledMods: { state: 'known' as const, value: ['Moonlight Project'] } }
  const chosen = selectBuildModRevision(before, imported, catalogs)
  expect(chosen.mods).toEqual({ state: 'known', value: ['Unrelated mod', 'Moonlight Project'] })
  expect(chosen.disabledMods).toEqual({ state: 'known', value: [] })
  expect(chosen.modComposition!.layers).toEqual([{ catalogId: imported.id, catalogRevisionId: imported.revisionId, enabled: true }])
  const setup: GameSetupRevision = { ...original, ...chosen, platform: { state: 'known', value: 'Windows' }, gameVersion: { state: 'known', value: '1.6.9' }, mode: { state: 'known', value: 'Standard' }, mods: { state: 'known', value: ['Moonlight Project'] }, catalogLock: { ...chosen.catalogLock, [DEFAULT_CATALOG.id]: modCatalogRevision(original.id) } }
  const effective = composeModCatalog(setup, catalogs)
  const result = calculatePCStats(buildContentForModSetup(content, setup, catalogs), SUGGESTED_BUILD_SLOTS, ref => resolveCalculationEntity(data, [...catalogs, effective!], ref, setup), [], false, resolveGameRules(setup, catalogs))
  expect(result.issues).toEqual([])
  expect(result.neutral.HP).toBeGreaterThan(0)
  expect(resolveGameRules(setup, catalogs).issues).toEqual([])
  expect(resolveGameRules({ ...setup, mods: { state: 'known', value: ['Unrelated mod'] } }, catalogs).issues.join(' ')).toContain('Unrelated mod')
  expect(before.disabledMods.value).toEqual(['Moonlight Project'])
  expect(data.gameSetups[original.id]).toEqual(original)
  const rebound = buildContentForModSetup(content, setup, catalogs)
  const allCatalogs = [...catalogs, effective!]
  const reset = buildContentForModSetup(rebound, { ...buildBehavior(original), catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId } }, allCatalogs)
  expect(reset.primaryClass).toEqual(freelancer)
  expect(reset.calculation!.growth).toEqual(content.calculation!.growth)
  const reused = { ...setup, catalogLock: { ...setup.catalogLock, [DEFAULT_CATALOG.id]: 'mod-setup:another-checkpoint' as CatalogRef['catalogRevisionId'] } }
  expect(buildContentForModSetup(rebound, reused, catalogs, setup).primaryClass).toEqual({ ...rebound.primaryClass, catalogRevisionId: reused.catalogLock[DEFAULT_CATALOG.id] })
  const changedRoot = JSON.parse(source.text)
  changedRoot.Jobs.find((record: { ID: number; Name: string }) => record.Name === 'Freelancer').HPRating += 1
  const newer = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(changedRoot)), 'synthetic-revision.json')).proposed.catalogs[0]!
  const newerSetup = { ...setup, ...selectBuildModRevision(buildBehavior(setup), newer, [...catalogs, newer]) }
  const newerCatalog = composeModCatalog(newerSetup, [...catalogs, newer])!
  const newerContent = buildContentForModSetup(rebound, newerSetup, [...allCatalogs, newer])
  const changed = calculatePCStats(newerContent, SUGGESTED_BUILD_SLOTS, ref => resolveCalculationEntity(data, [...catalogs, newer, newerCatalog], ref, newerSetup), [], false, resolveGameRules(newerSetup, [...catalogs, newer]))
  expect(changed.issues).toEqual([])
  expect(changed.neutral.HP).toBeGreaterThan(result.neutral.HP!)
  expect(content.primaryClass).toEqual(freelancer)
})

it('changes revisions in place, keeps layer order and unrelated links, and discards absent model links', async () => {
  const preview = async (id: string, ids: number[]) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, EditorVersion: 4, Equipment: ids.map(ID => ({ ID, Name: `Synthetic ${ID}`, StatMods: [] })) })), 'synthetic.json')).proposed.catalogs[0]!
  const first = await preview('synthetic-first', [9000])
  const second = await preview('synthetic-second', [9001])
  const newer = await preview('synthetic-first', [9002])
  const data = createTestLocalData()
  const initial = buildBehavior(data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!)
  const catalogs = [DEFAULT_CATALOG, first, second, newer]
  const enabled = selectBuildModRevision(selectBuildModRevision(initial, first, catalogs), second, catalogs)
  const linked = { ...enabled, modComposition: { ...enabled.modComposition!, links: [{ modelKey: 'crystal-edit:Equipment:9000', targetEntityId: 'old-target' as CatalogRef['entityId'] }, { modelKey: 'crystal-edit:Equipment:9001', targetEntityId: 'other-target' as CatalogRef['entityId'] }] } }
  const changed = selectBuildModRevision(linked, newer, catalogs)
  expect(changed.modComposition!.layers.map(layer => layer.catalogId)).toEqual([first.id, second.id])
  expect(changed.modComposition!.layers[0]!.catalogRevisionId).toBe(newer.revisionId)
  expect(changed.modComposition!.links).toEqual([linked.modComposition.links[1]])
  expect(linked.modComposition.links).toHaveLength(2)
})
