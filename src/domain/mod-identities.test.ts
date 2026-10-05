import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { buildBehavior } from './build-behavior'
import { buildContentForModSetup, selectBuildModRevision } from './build-mods'
import { exportedTree, jsonRecord } from './crystal-edit'
import { crystalEditPlanningRecord } from './crystal-edit-compatibility'
import { catalogEntity } from './entity-identities'
import { resolveGameRules } from './game-rules'
import { modIdentityMappings, remapModRecord } from './mod-identities'
import { composeModCatalog, composeModLayers, modCatalogRevision, modModelEntity, prepareModComposition } from './mod-layers'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import { defaultBattleCalculation } from './battle-plan'
import { defaultCalculation } from './calculation-plan'
import type { CatalogRef, CatalogSnapshot, GameSetupRevision, JsonValue, ModComposition } from './types'

const ADDED_ID = 9000
const tag = (kind: 'SangStatModTag' | 'SangAbilityModTag' | 'ActionConditionVar', name: string) => Number(Object.entries(NATIVE_GAME_DATA.enums[kind]!).find(([, label]) => label === name)![0])
const sourceRecord = (entity: ReturnType<typeof modModelEntity>) => {
  const field = entity!.fields['Crystal Edit source record']!
  if (field.state !== 'known' || !jsonRecord(field.value)) throw new Error('Expected a source record')
  return field.value
}
const imported = async (id: string, extra: Record<string, unknown> = {}) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, Title: id, EditorVersion: 34,
  Jobs: [{ ID: ADDED_ID, Name: `${id} class`, AbilityIDs: [ADDED_ID], PassiveIDs: [ADDED_ID], LearnTree: [[{ NodeType: 2, DataID: ADDED_ID, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }, { NodeType: 3, DataID: ADDED_ID, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }]] }],
  Abilities: [{ ID: ADDED_ID, Name: `${id} ability`, TargetStatuses: [{ StatusID: ADDED_ID }], UserStatuses: [{ StatusID: ADDED_ID }], AbilityMods: [{ Tag: tag('SangAbilityModTag', 'StatusRequiredTarget'), Value1: ADDED_ID }] }],
  Passives: [{ ID: ADDED_ID, Name: `${id} passive`, IsInnate: true, StatMods: [{ Tag: tag('SangStatModTag', 'StatusAuto'), Value1: ADDED_ID }, { Tag: tag('SangStatModTag', 'Flat_AbilityMPCost'), Value1: ADDED_ID, Value2: 5 }] }],
  Statuses: [{ ID: ADDED_ID, Name: `${id} status`, StatMods: [] }],
  Genders: [{ ID: 8, Name: `${id} gender`, BoostHP: true, BoostMP: false, BoostStr: false, BoostVit: false, BoostDex: false, BoostAgi: false, BoostMnd: false, BoostSpi: false, BoostSpd: false, BoostLck: false }],
  Difficulties: [{ ID: 8, Name: `${id} difficulty` }], ...extra,
})), 'synthetic.json')).proposed.catalogs[0]!

function composed(catalogs: readonly CatalogSnapshot[]) {
  const original = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const all = [DEFAULT_CATALOG, ...catalogs]
  const behavior = catalogs.reduce((value, catalog) => selectBuildModRevision(value, catalog, all), buildBehavior(original))
  const setup: GameSetupRevision = { ...original, ...behavior, catalogLock: { [DEFAULT_CATALOG.id]: modCatalogRevision(original.id) } }
  return { all, setup, composition: behavior.modComposition!, catalog: composeModCatalog(setup, all)!, result: composeModLayers(behavior.modComposition!, all) }
}

describe('project-scoped mod identities', () => {
  it('retains each added definition and rewrites its class, status, and ability references', async () => {
    const first = await imported('first')
    const second = await imported('second')
    const before = JSON.stringify([first, second])
    const context = composed([first, second])
    const firstJob = context.result.entities[modModelEntity(first, `crystal-edit:Jobs:${ADDED_ID}`)!.id]!
    const secondJob = context.result.entities[modModelEntity(second, `crystal-edit:Jobs:${ADDED_ID}`)!.id]!
    expect(firstJob.name).toBe('first class')
    expect(secondJob.name).toBe('second class')
    expect(sourceRecord(firstJob).AbilityIDs).toEqual([ADDED_ID])
    expect(sourceRecord(secondJob).AbilityIDs).toEqual([ADDED_ID + 1])
    expect(exportedTree(secondJob).map(node => node.dataId)).toEqual([ADDED_ID + 1, ADDED_ID + 1])
    const ability = modModelEntity(context.catalog, `crystal-edit:Abilities:${ADDED_ID + 1}`)!
    expect(ability.name).toBe('second ability')
    expect(sourceRecord(ability)).toMatchObject({ ID: ADDED_ID + 1, TargetStatuses: [{ StatusID: ADDED_ID + 1 }], UserStatuses: [{ StatusID: ADDED_ID + 1 }], AbilityMods: [{ Value1: ADDED_ID + 1 }] })
    expect(sourceRecord(modModelEntity(context.catalog, `crystal-edit:Passives:${ADDED_ID + 1}`))).toMatchObject({ StatMods: [{ Value1: ADDED_ID + 1 }, { Value1: ADDED_ID + 1, Value2: 5 }] })
    expect(catalogEntity(context.catalog, `crystal-edit:Statuses:${ADDED_ID + 1}`)?.name).toBe('second status')
    expect(ability.fields['Crystal Edit original source record']).toMatchObject({ value: { ID: ADDED_ID } })
    expect(ability.sources).toEqual(modModelEntity(second, `crystal-edit:Abilities:${ADDED_ID}`)!.sources)
    expect(context.result.unresolvedReferences).toEqual([])
    expect(JSON.stringify([first, second])).toBe(before)
  })

  it('keeps saved added gender and difficulty identities stable through disabling, removing, reordering, and later additions', async () => {
    const first = await imported('first')
    const second = await imported('second')
    const third = await imported('third')
    const context = composed([first, second])
    const mappings = context.composition.identityMappings!
    const firstGender = mappings.find(mapping => mapping.projectId === first.id && mapping.family === 'Genders')!
    const secondGender = mappings.find(mapping => mapping.projectId === second.id && mapping.family === 'Genders')!
    expect(secondGender.effectiveId).not.toBe(firstGender.effectiveId)
    const changed = prepareModComposition({ ...context.composition, layers: [context.composition.layers[1]!, { ...context.composition.layers[0]!, enabled: false }] }, context.all)
    expect(changed.identityMappings).toEqual(mappings)
    const rules = resolveGameRules({ ...context.setup, modComposition: changed, difficulty: { version: 1, selection: { state: 'known', value: secondGender.effectiveId } } }, context.all)
    expect(rules.genders.find(gender => gender.id === secondGender.effectiveId)?.name).toBe('second gender')
    expect(rules.genders.find(gender => gender.id === firstGender.effectiveId)).toBeUndefined()
    expect(rules.difficulty?.name).toBe('second difficulty')
    const removed = prepareModComposition({ ...changed, layers: [changed.layers[0]!] }, context.all)
    const added = selectBuildModRevision({ ...buildBehavior(context.setup), modComposition: removed }, third, [...context.all, third]).modComposition!
    expect(added.identityMappings).toEqual(expect.arrayContaining([...mappings]))
    expect(added.identityMappings!.find(mapping => mapping.projectId === third.id && mapping.family === 'Genders')!.effectiveId).not.toBe(firstGender.effectiveId)
  })

  it('binds source selections and every battle reference to their own project while preserving ordered native overrides', async () => {
    const first = await imported('first', { Equipment: [{ ID: ADDED_ID, Name: 'first equipment' }] })
    const second = await imported('second', { Jobs: [{ ID: 0, Name: 'second Warrior', AbilityIDs: [ADDED_ID], PassiveIDs: [ADDED_ID] }] })
    const context = composed([first, second])
    const ref = (catalog: CatalogSnapshot, family: string): CatalogRef => ({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: modModelEntity(catalog, `crystal-edit:${family}:${ADDED_ID}`)!.id })
    const primary = ref(first, 'Jobs')
    const status = ref(second, 'Statuses')
    const ability = ref(second, 'Abilities')
    const battle = { ...defaultBattleCalculation(), statuses: [{ ref: status, count: 2 }], targetStatuses: [{ ref: status, count: null }], previouslyAppliedStatuses: [status], userPreviouslyAppliedStatuses: [status] }
    const content = { primaryClass: primary, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(primary), ability, battle } }
    const rebound = buildContentForModSetup(content, context.setup, context.all)
    expect(rebound.primaryClass).toMatchObject({ catalogId: DEFAULT_CATALOG.id, entityId: primary.entityId })
    expect(rebound.calculation.ability).toMatchObject({ catalogId: DEFAULT_CATALOG.id, entityId: ability.entityId })
    expect(rebound.calculation.battle.statuses[0]!.ref).toMatchObject({ catalogId: DEFAULT_CATALOG.id, entityId: status.entityId })
    expect(rebound.calculation.battle.targetStatuses[0]!.ref).toEqual(rebound.calculation.battle.statuses[0]!.ref)
    expect(rebound.calculation.battle.previouslyAppliedStatuses[0]).toEqual(rebound.calculation.battle.statuses[0]!.ref)
    expect(rebound.calculation.battle.userPreviouslyAppliedStatuses[0]).toEqual(rebound.calculation.battle.statuses[0]!.ref)
    expect(context.result.entities['base:job:0']!.name).toBe('second Warrior')
  })

  it('rejects malformed persisted identity mappings and keeps prior composition semantics unchanged', async () => {
    const first = await imported('first')
    const second = await imported('second')
    const context = composed([first, second])
    const mapping = context.composition.identityMappings![0]!
    expect(() => modIdentityMappings({ ...context.composition, identityMappings: [mapping, mapping] }, context.all)).toThrow('unique added source')
    expect(() => modIdentityMappings({ ...context.composition, identityMappings: [{ ...mapping, effectiveId: 0 }] }, context.all)).toThrow('native collisions')
    const historical: ModComposition = { ...context.composition, version: 2, identityMappings: undefined, links: [] }
    const old = composeModLayers(historical, context.all)
    expect(old.entities[old.identities[`crystal-edit:Jobs:${ADDED_ID}`]!]!.name).toBe('second class')
    expect(old.entities[modModelEntity(first, `crystal-edit:Jobs:${ADDED_ID}`)!.id]).toBeUndefined()
    const upgraded = prepareModComposition(historical, context.all)
    expect(upgraded.identityMappings!.find(value => value.projectId === second.id && value.family === 'Genders')!.effectiveId).toBe(8)
    expect(historical.identityMappings).toBeUndefined()
  })

  it('drops only removed project links and never rebinds a removed selection to another project', async () => {
    const first = await imported('first')
    const second = await imported('second')
    const newer = await imported('second', { Abilities: [] })
    const context = composed([first, second])
    const selected: CatalogRef = { kind: 'catalog', catalogId: second.id, catalogRevisionId: second.revisionId, entityId: modModelEntity(second, `crystal-edit:Abilities:${ADDED_ID}`)!.id }
    const links = [{ projectId: first.id, modelKey: `crystal-edit:Abilities:${ADDED_ID}`, targetEntityId: null }, { projectId: second.id, modelKey: `crystal-edit:Abilities:${ADDED_ID}`, targetEntityId: null }]
    const changed = selectBuildModRevision({ ...buildBehavior(context.setup), modComposition: { ...context.composition, links } }, newer, [...context.all, newer])
    expect(changed.modComposition!.links).toEqual([links[0]])
    const content = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(null), ability: selected } }
    const rebound = buildContentForModSetup(content, { ...changed, catalogLock: context.setup.catalogLock }, [...context.all, newer])
    expect(rebound.calculation.ability).toEqual(selected)
  })

  it('converts older editor modifiers before redirecting IDs and does not convert them twice', async () => {
    const first = await imported('first')
    const second = await imported('second', { EditorVersion: 9, Passives: [{ ID: ADDED_ID, Name: 'Legacy cost', IsInnate: true, StatMods: [{ Tag: tag('SangStatModTag', 'Flat_AbilityMPCost'), Value1: ADDED_ID, Value2: 7 }] }] })
    const context = composed([first, second])
    const passive = modModelEntity(context.catalog, `crystal-edit:Passives:${ADDED_ID + 1}`)!
    expect(sourceRecord(passive).StatMods).toEqual([{ Tag: tag('SangStatModTag', 'Flat_AbilityMPCost'), Value1: 233, Value2: ADDED_ID }])
    expect(crystalEditPlanningRecord(passive)?.StatMods).toEqual(sourceRecord(passive).StatMods)
    expect(passive.fields['Crystal Edit original source record']).toMatchObject({ value: { StatMods: [{ Value1: ADDED_ID, Value2: 7 }] } })
  })

  it('retains the owning project when a localization renames an added record', async () => {
    const first = await imported('first')
    const locale = await imported('translated', { IsLocalization: true })
    const context = composed([first, locale])
    const definition = modModelEntity(context.catalog, `crystal-edit:Jobs:${ADDED_ID}`)!
    expect(definition.name).toBe('translated class')
    expect(definition.id).toBe(modModelEntity(first, `crystal-edit:Jobs:${ADDED_ID}`)!.id)
    expect(context.result.sourceIdentities[first.id]![`crystal-edit:Jobs:${ADDED_ID}`]).toBe(definition.id)
    expect(context.composition.identityMappings!.some(mapping => mapping.projectId === locale.id)).toBe(false)
    expect(definition.sources).toEqual([...modModelEntity(first, `crystal-edit:Jobs:${ADDED_ID}`)!.sources, ...modModelEntity(locale, `crystal-edit:Jobs:${ADDED_ID}`)!.sources])
  })

  it('rewrites loot, monster actions, nested conditions, and PvP relationships with native tag semantics', () => {
    const projectId = 'crystal-edit:synthetic' as CatalogSnapshot['id']
    const mappings = ['Items', 'Equipment', 'Abilities', 'Statuses', 'Jobs', 'Genders', 'Monsters', 'Difficulties'].map(family => ({ projectId, family, originalId: ADDED_ID, effectiveId: ADDED_ID + 1 }))
    const record: Record<string, JsonValue> = { ID: ADDED_ID, IsPvp: true, PvpJobID: ADDED_ID, PvpGenderID: ADDED_ID, PvpWeaponID: ADDED_ID, ItemDrops: [{ LootType: 1, ItemID: ADDED_ID }, { LootType: 2, EquipmentID: ADDED_ID }], Actions: [{ AbilityID: ADDED_ID, AllyMonsterIDFilter: ADDED_ID, Conds: [{ CondVar: tag('ActionConditionVar', 'DifficultyIs'), Data1: ADDED_ID, SubConds: [{ CondVar: tag('ActionConditionVar', 'SelfSpecificStatusCount'), Data1: ADDED_ID }] }] }] }
    expect(remapModRecord(record, 'Monsters', projectId, mappings)).toMatchObject({ ID: ADDED_ID + 1, PvpJobID: ADDED_ID + 1, PvpGenderID: ADDED_ID + 1, PvpWeaponID: ADDED_ID + 1, ItemDrops: [{ ItemID: ADDED_ID + 1 }, { EquipmentID: ADDED_ID + 1 }], Actions: [{ AbilityID: ADDED_ID + 1, AllyMonsterIDFilter: ADDED_ID + 1, Conds: [{ Data1: ADDED_ID + 1, SubConds: [{ Data1: ADDED_ID + 1 }] }] }] })
    expect(remapModRecord({ LootType: 2, LootID: ADDED_ID, Ingredients: [{ LootType: 1, LootID: ADDED_ID }] }, 'Recipes', projectId, mappings)).toMatchObject({ LootID: ADDED_ID + 1, Ingredients: [{ LootID: ADDED_ID + 1 }] })
  })
})
