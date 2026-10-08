import { previewCrystalEdit } from '../interchange/crystal-edit'
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
import { DEFAULT_CATALOG, PREVIOUS_CATALOG } from './bundled'
import { CONFIRMED_SWITCH_MOD_SETUP, definitionModAvailability, modPlanningReason, MOONLIGHT_PROJECT_MOD, SWITCH_MOD_PACKS } from './mods'

function ref(entityId: string): CatalogRef {
  return { kind: 'catalog', catalogId: PREVIOUS_CATALOG.id, catalogRevisionId: PREVIOUS_CATALOG.revisionId, entityId: asId<EntityId>(entityId) }
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
      ['mod:doge-shield:item:ref-1084', 'Doge Shield'],
      ['mod:additional-boss-yasha-tar:monster:ref-1068', 'Additional Boss: Yasha Tar'],
      ['mod:additional-boss-pinga:monster:ref-1066', 'Additional Boss: Pinga'],
      ['mod:additional-boss-quintar-husk:monster:ref-1067', 'Additional Boss: Quintar Husk'],
      ['mod:additional-boss-elder-entities:monster:ref-1065', 'Additional Boss: Elder Entities'],
    ] as const
    for (const [id, mod] of cases) {
      expect(PREVIOUS_CATALOG.entities[id]).toBeDefined()
      expect(definitionModAvailability(localData, ref(id), undefined, [PREVIOUS_CATALOG])).toEqual({ requiredMod: mod, state: 'unknown' })
      expect(definitionModAvailability(localData, ref(id), { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known([mod]) }, [PREVIOUS_CATALOG])).toEqual({ requiredMod: mod, state: 'disabled' })
      expect(definitionModAvailability(localData, ref(id), { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], mods: known([mod]) }, [PREVIOUS_CATALOG])).toEqual({ requiredMod: mod, state: 'enabled' })
      expect(definitionModAvailability(localData, { ...ref(id), catalogRevisionId: 'synthetic-missing' as typeof PREVIOUS_CATALOG.revisionId }, { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known([mod]) }, [PREVIOUS_CATALOG])).toEqual({ state: 'unknown' })
    }
    expect(definitionModAvailability(localData, ref('base:innate:ref-1062'))).toEqual({ state: 'unknown' })
  })

  it('inherits source associations through overrides without classifying unrelated same-name definitions', () => {
    const base = ref('mod:doge-shield:item:ref-1084')
    const first = savedCatalogVersion(createTestLocalData(), [PREVIOUS_CATALOG], { sourceRef: base, name: 'Personal shield' })
    const second = savedCatalogVersion(first.localData, [PREVIOUS_CATALOG], { sourceRef: first.ref, name: 'Revised shield' })
    const gameSetup = { ...second.localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], disabledMods: known(['Doge Shield']) }
    expect(definitionModAvailability(second.localData, second.ref, gameSetup, [PREVIOUS_CATALOG]).state).toBe('disabled')
    const personal = createPersonalDefinition(second.localData, { kind: 'item', name: 'Doge Shield' })
    const independent = Object.values(personal.personalDefinitions).find(definition => !definition.baseRef)!
    expect(definitionModAvailability(personal, { kind: 'personal', definitionId: independent.id }, gameSetup, [PREVIOUS_CATALOG])).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogRevisionId: asId('another-revision') }, gameSetup, [PREVIOUS_CATALOG])).toEqual({ state: 'unknown' })
    expect(definitionModAvailability(personal, { ...base, catalogId: asId('unrelated-catalog') }, gameSetup, [PREVIOUS_CATALOG])).toEqual({ state: 'unknown' })
  })

  it('preserves an imported class association through overrides while keeping same-name entries independent', async () => {
    const catalog = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-class-association', Title: 'Synthetic class mod', EditorVersion: 34, Jobs: [{ ID: 26, Name: 'Synthetic Class' }] })), 'synthetic.json')).proposed.catalogs[0]!
    const entity = Object.values(catalog.entities)[0]!
    const sourceRef: CatalogRef = { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
    const original = createTestLocalData()
    const changed = savedCatalogVersion(original, [catalog], { sourceRef, name: 'Synthetic revised class' })
    const setup = { ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, modComposition: { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: false }], links: [] } }
    expect(definitionModAvailability(changed.localData, changed.ref, setup, [catalog])).toEqual({ requiredMod: 'Synthetic class mod', state: 'disabled' })
    for (const missing of [{ ...sourceRef, catalogId: asId<typeof catalog.id>('synthetic-foreign') }, { ...sourceRef, catalogRevisionId: asId<typeof catalog.revisionId>('synthetic-foreign') }]) expect(definitionModAvailability(original, missing, setup, [catalog])).toEqual({ state: 'unknown' })
  })

  it('classifies imported definitions by exact catalog identity and revision', async () => {
    const { catalogs } = await syntheticModLayers()
    const source = catalogs[1]!
    const entity = Object.values(source.entities).find(value => value.name === 'First Sword')!
    const currentRef: CatalogRef = { kind: 'catalog', catalogId: source.id, catalogRevisionId: source.revisionId, entityId: entity.id }
    const localData = createTestLocalData()
    expect(definitionModAvailability(localData, currentRef, undefined, catalogs)).toEqual({ requiredMod: 'Layer A', state: 'unknown' })
    expect(definitionModAvailability(localData, { ...currentRef, catalogRevisionId: asId('unavailable-revision') }, undefined, catalogs)).toEqual({ state: 'unknown' })
    expect(DEFAULT_CATALOG.entities[entity.id]).toBeUndefined()
  })

  it('keeps exact source availability while imported replacements take priority', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const localData = addGameSetupRevision(createBlankLocalData(), { label: 'Synthetic layered setup', modComposition: { ...composition, links: [...composition.links, { modelKey: 'crystal-edit:Equipment:50', targetEntityId: asId<EntityId>('base:equipment:0') }] } })
    const setup = localData.gameSetups[localData.planningGameSetupRevisionId!]!
    const effective = expandModCatalogs([...catalogs, composeModCatalog(setup, catalogs)!])
    const replacement: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: setup.catalogLock[DEFAULT_CATALOG.id]!, entityId: asId('base:equipment:0') }
    expect(definitionModAvailability(localData, replacement, setup, effective)).toEqual({ requiredMod: 'Layer A', state: 'enabled' })
    expect(definitionModAvailability(localData, replacement, undefined, effective)).toEqual({ requiredMod: 'Layer A', state: 'unknown' })
    expect(definitionModAvailability(localData, { ...replacement, entityId: asId('base:equipment:1') }, setup, effective)).toEqual({ state: 'unknown' })
  })

  it('retains all exact definitions while attaching the active gameSetup availability to search choices', () => {
    const original = createTestLocalData()
    const localData = { ...original, gameSetups: { ...original.gameSetups, [TEST_GAME_SETUP_REVISION_ID]: { ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID], mods: known(['Bloodmage']), disabledMods: known(['Doge Shield']) } } }
    const options = buildDefinitionOptions(localData, [PREVIOUS_CATALOG])
    expect(options.find(option => option.name === 'Doge Shield')?.modAvailability?.state).toBe('disabled')
    expect(options.find(option => option.name === 'Bloodmage')?.modAvailability?.state).toBe('enabled')
    expect(options.find(option => option.name === 'Tempest')?.modAvailability?.state).toBe('unknown')
    expect(options).toHaveLength(Object.keys(PREVIOUS_CATALOG.entities).length)
  })
})
