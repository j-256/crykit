import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { describe, expect, it } from 'vitest'
import { asId } from '../domain/core'
import { addGameSetupRevision, createBlankLocalData, createPersonalDefinition } from '../domain/local-data'
import { composeModCatalog, expandModCatalogs } from '../domain/mod-layers'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { CatalogRef, EntityId } from '../domain/types'
import { buildDefinitionOptions } from '../ui/definitions'
import { modState, normalizeModName, updateModSelections } from '../domain/mods'
import { DEFAULT_CATALOG } from './bundled'
import { CONFIRMED_SWITCH_MOD_SETUP, definitionModAvailability, modPlanningReason, MOONLIGHT_PROJECT_MOD, SWITCH_MOD_PACKS } from './mods'
import { STARTER_CATALOG, STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'

function ref(entityId: string): CatalogRef {
  return { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: STARTER_CATALOG_REVISION_ID, entityId: asId<EntityId>(entityId) }
}

describe('confirmed catalog mod associations', () => {
  it('explains selectable mod planning states', () => {
    expect(modPlanningReason({ state: 'unknown' })).toBeUndefined()
    expect(modPlanningReason({ state: 'enabled', requiredMod: MOONLIGHT_PROJECT_MOD })).toBeUndefined()
    for (const state of ['disabled', 'unknown', 'conflicting'] as const) {
      expect(modPlanningReason({ state, requiredMod: MOONLIGHT_PROJECT_MOD })).toContain("Build's Game Setup")
      expect(modPlanningReason({ state, requiredMod: MOONLIGHT_PROJECT_MOD })).toContain('You can still select it')
    }
  })

  it('offers each supplied Switch mod once across the official packs and applies the confirmed choices', () => {
    const names = SWITCH_MOD_PACKS.flatMap(pack => pack.mods)
    const confirmedNames = [...CONFIRMED_SWITCH_MOD_SETUP.enabledMods, ...CONFIRMED_SWITCH_MOD_SETUP.disabledMods]
    expect(new Set(names.map(normalizeModName)).size).toBe(names.length)
    expect([...names].sort()).toEqual(confirmedNames.sort())
    expect(SWITCH_MOD_PACKS.map(pack => pack.name)).toEqual(['Mod Pack 1: Quality Fun', 'Mod Pack 2: New Challenges'])
    expect(SWITCH_MOD_PACKS[0].mods).toContain('Learnable Innate Skill')
    expect(SWITCH_MOD_PACKS[1].mods).toContain('Moonlight Project')
    const configured = updateModSelections({ mods: known(['Synthetic imported mod']) }, [
      ...CONFIRMED_SWITCH_MOD_SETUP.enabledMods.map(name => ({ name, state: 'enabled' as const })),
      ...CONFIRMED_SWITCH_MOD_SETUP.disabledMods.map(name => ({ name, state: 'disabled' as const })),
    ])
    for (const name of CONFIRMED_SWITCH_MOD_SETUP.enabledMods) expect(modState(configured, name)).toBe('enabled')
    for (const name of CONFIRMED_SWITCH_MOD_SETUP.disabledMods) expect(modState(configured, name)).toBe('disabled')
    expect(modState(configured, 'Synthetic imported mod')).toBe('enabled')
  })

  it('uses exact source-backed identities for mod classes, items, and bosses', () => {
    const localData = createTestLocalData()
    const cases = [
      ['mod:bloodmage:class:ref-1083', 'Bloodmage'],
      ['mod:tempest:class:ref-1099', 'Tempest'],
      ['mod:forcemage:class:ref-1085', 'Forcemage'],
      ['mod:barbarian:class:ref-1078', 'Barbarian'],
      ['mod:moonlight-project:class:25', MOONLIGHT_PROJECT_MOD],
      ['mod:moonlight-project:ability:552', MOONLIGHT_PROJECT_MOD],
      ['mod:moonlight-project:passive:97', MOONLIGHT_PROJECT_MOD],
      ['mod:doge-shield:item:ref-1084', 'Doge Shield'],
      ['mod:equipment-expansion:equipment:592', 'Equipment Expansion'],
      ['mod:additional-boss-yasha-tar:monster:ref-1068', 'Additional Boss: Yasha Tar'],
      ['mod:additional-boss-pinga:monster:ref-1066', 'Additional Boss: Pinga'],
      ['mod:additional-boss-quintar-husk:monster:ref-1067', 'Additional Boss: Quintar Husk'],
      ['mod:additional-boss-elder-entities:monster:ref-1065', 'Additional Boss: Elder Entities'],
    ] as const
    for (const [id, mod] of cases) {
      expect(DEFAULT_CATALOG.entities[id]).toBeDefined()
      expect(definitionModAvailability(localData, ref(id))).toEqual({ requiredMod: mod, state: 'unknown' })
      expect(definitionModAvailability(localData, ref(id), { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known([mod]) })).toEqual({ requiredMod: mod, state: 'disabled' })
      expect(definitionModAvailability(localData, ref(id), { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], mods: known([mod]) })).toEqual({ requiredMod: mod, state: 'enabled' })
      expect(definitionModAvailability(localData, { ...ref(id), catalogRevisionId: DEFAULT_CATALOG.revisionId }, { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known([mod]) })).toEqual({ requiredMod: mod, state: 'disabled' })
    }
    expect(definitionModAvailability(localData, ref('base:innate:ref-1062'))).toEqual({ state: 'unknown' })
  })

  it('inherits source associations through overrides without classifying unrelated same-name definitions', () => {
    const base = ref('mod:doge-shield:item:ref-1084')
    const first = savedCatalogVersion(createTestLocalData(), [DEFAULT_CATALOG], { sourceRef: base, name: 'Personal shield' })
    const second = savedCatalogVersion(first.localData, [DEFAULT_CATALOG], { sourceRef: first.ref, name: 'Revised shield' })
    const gameSetup = { ...second.localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known(['Doge Shield']) }
    expect(definitionModAvailability(second.localData, second.ref, gameSetup).state).toBe('disabled')
    const personal = createPersonalDefinition(second.localData, { kind: 'item', name: 'Doge Shield' })
    const independent = Object.values(personal.personalDefinitions).find(definition => !definition.baseRef)!
    expect(definitionModAvailability(personal, { kind: 'personal', definitionId: independent.id }, gameSetup)).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogRevisionId: asId('another-revision') }, gameSetup)).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogId: asId('unrelated-catalog') }, gameSetup)).toEqual({ state: 'unknown' })
  })

  it('inherits Brawler mod associations without classifying unrelated same-name definitions', () => {
    const localData = createTestLocalData()
    for (const id of ['mod:moonlight-project:class:25', 'mod:moonlight-project:ability:552', 'mod:moonlight-project:passive:97']) {
      expect(definitionModAvailability(localData, ref(id))).toEqual({ state: 'unknown', requiredMod: MOONLIGHT_PROJECT_MOD })
      expect(definitionModAvailability(localData, { ...ref(id), catalogRevisionId: DEFAULT_CATALOG.revisionId })).toEqual({ state: 'unknown', requiredMod: MOONLIGHT_PROJECT_MOD })
    }
    const override = savedCatalogVersion(localData, [DEFAULT_CATALOG], { sourceRef: ref('mod:moonlight-project:class:25'), name: 'Revised Brawler' })
    expect(definitionModAvailability(override.localData, override.ref)).toEqual({ state: 'unknown', requiredMod: MOONLIGHT_PROJECT_MOD })
    expect(definitionModAvailability(localData, ref('base:passive:ref-641'))).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(localData, ref('mod:moonlight-project:class:26'))).toEqual({ state: 'unknown', requiredMod: MOONLIGHT_PROJECT_MOD })
    expect(definitionModAvailability(localData, { ...ref('mod:moonlight-project:class:25'), catalogId: asId('synthetic-foreign') })).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(localData, { ...ref('mod:moonlight-project:class:25'), catalogRevisionId: asId('synthetic-foreign') })).toEqual({ state: 'unknown' })
  })

  it('classifies newly bundled Equipment Expansion definitions only by exact current identities', () => {
    const localData = createTestLocalData()
    const currentRef: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: asId<EntityId>('mod:equipment-expansion:equipment:712') }
    expect(DEFAULT_CATALOG.entities['mod:equipment-expansion:equipment:712']).toBeDefined()
    expect(definitionModAvailability(localData, currentRef)).toEqual({ requiredMod: 'Equipment Expansion', state: 'unknown' })
    expect(definitionModAvailability(localData, { ...currentRef, catalogRevisionId: 'unavailable-revision' as typeof currentRef.catalogRevisionId })).toEqual({ state: 'unknown' })
    expect(STARTER_CATALOG.entities[currentRef.entityId]).toBeUndefined()
  })

  it('retains bundled Equipment Expansion availability while imported replacement layers take priority', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const localData = addGameSetupRevision(createBlankLocalData(), {
      label: 'Synthetic layered mod setup',
      disabledMods: known(['Equipment Expansion']),
      modComposition: { ...composition, links: [...composition.links, { modelKey: 'crystal-edit:Equipment:50', targetEntityId: asId<EntityId>('mod:equipment-expansion:equipment:712') }] },
    })
    const gameSetup = localData.gameSetups[localData.planningGameSetupRevisionId!]!
    const effectiveCatalogs = expandModCatalogs([...catalogs, composeModCatalog(gameSetup, catalogs)!])
    const currentRef: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG_ID, catalogRevisionId: gameSetup.catalogLock[STARTER_CATALOG_ID]!, entityId: asId<EntityId>('mod:equipment-expansion:equipment:592') }
    expect(definitionModAvailability(localData, currentRef, gameSetup, effectiveCatalogs)).toEqual({ requiredMod: 'Equipment Expansion', state: 'disabled' })
    const replacementRef = { ...currentRef, entityId: asId<EntityId>('mod:equipment-expansion:equipment:712') }
    expect(definitionModAvailability(localData, replacementRef, gameSetup, effectiveCatalogs)).toEqual({ requiredMod: 'Layer A', state: 'enabled' })
    expect(definitionModAvailability(localData, replacementRef, undefined, effectiveCatalogs)).toEqual({ requiredMod: 'Layer A', state: 'unknown' })
  })

  it('retains all exact definitions while attaching the active gameSetup availability to search choices', () => {
    const original = createTestLocalData()
    const localData = { ...original, gameSetups: { ...original.gameSetups, [TEST_GAME_SETUP_REVISION_ID]: { ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID], mods: known(['Bloodmage']), disabledMods: known(['Doge Shield']) } } }
    const options = buildDefinitionOptions(localData, [DEFAULT_CATALOG])
    expect(options.find(option => option.name === 'Doge Shield')?.modAvailability?.state).toBe('disabled')
    expect(options.find(option => option.name === 'Bloodmage')?.modAvailability?.state).toBe('enabled')
    expect(options.find(option => option.name === 'Heavy Edge')?.modAvailability?.state).toBe('unknown')
    expect(options).toHaveLength(Object.keys(DEFAULT_CATALOG.entities).length)
  })
})
