import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { DomainError } from './core'
import { jsonRecord, LEARN_NODE_TYPES } from './crystal-edit'
import { MAX_NATIVE_INTEGER, nativeInteger } from './native-number'
import type { CatalogId, CatalogSnapshot, JsonValue, ModComposition, ModIdentityMapping } from './types'

export const MOD_IDENTITY_FAMILIES = Object.freeze({ Abilities: 'ability', Biomes: 'biome', Difficulties: 'difficulty', Equipment: 'equipment', Genders: 'gender', Items: 'item', Jobs: 'job', Monsters: 'monster', Passives: 'passive', Recipes: 'recipe', Statuses: 'status' } as const)
const originals = new Map(Object.entries(MOD_IDENTITY_FAMILIES).map(([family, database]) => {
  const records = NATIVE_GAME_DATA.databases[database]
  return [family, new Set(Array.isArray(records) ? records.flatMap(record => jsonRecord(record) && nativeInteger(record.ID) ? [record.ID] : []) : [])]
}))
const identityKey = (projectId: string, family: string, originalId: number) => JSON.stringify([projectId, family, originalId])
export const originalModIdentity = (family: string, id: number): boolean => originals.get(family)?.has(id) === true

export function assertModIdentityMappings(composition: ModComposition): void {
  if (composition.version !== 3 && composition.identityMappings !== undefined) throw new DomainError('INVALID_INPUT', 'Project identity mappings require mod composition version 3')
  const sources = new Set<string>()
  const targets = new Set<string>()
  for (const mapping of composition.identityMappings ?? []) {
    const source = identityKey(mapping.projectId, mapping.family, mapping.originalId)
    const target = `${mapping.family}:${mapping.effectiveId}`
    if (!mapping.projectId || !Object.hasOwn(MOD_IDENTITY_FAMILIES, mapping.family) || !nativeInteger(mapping.originalId) || mapping.originalId < 0 || !nativeInteger(mapping.effectiveId) || mapping.effectiveId < 0 || originalModIdentity(mapping.family, mapping.originalId) || originalModIdentity(mapping.family, mapping.effectiveId) || sources.has(source) || targets.has(target)) throw new DomainError('INVALID_INPUT', 'Project identity mappings require unique added source and effective identities without native collisions')
    sources.add(source)
    targets.add(target)
  }
}

export function modIdentityMappings(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): readonly ModIdentityMapping[] {
  assertModIdentityMappings(composition)
  if (composition.version !== 3) return []
  const mappings = [...composition.identityMappings ?? []]
  const sources = new Set(mappings.map(mapping => identityKey(mapping.projectId, mapping.family, mapping.originalId)))
  const used = new Set(mappings.map(mapping => `${mapping.family}:${mapping.effectiveId}`))
  for (const layer of composition.layers) {
    const catalog = catalogs.find(value => value.id === layer.catalogId && value.revisionId === layer.catalogRevisionId)
    const metadata = catalog && jsonRecord(catalog.legacy) ? catalog.legacy : undefined
    if (jsonRecord(metadata?.gameRules) && metadata.gameRules.localization === true) continue
    const models = jsonRecord(metadata?.crystalEditIdentities) ? Object.keys(metadata.crystalEditIdentities) : []
    const difficulties = jsonRecord(metadata?.gameRules) && Array.isArray(metadata.gameRules.difficulties) ? metadata.gameRules.difficulties : []
    const keys = [...models, ...difficulties.flatMap(record => jsonRecord(record) && nativeInteger(record.ID) ? [`crystal-edit:Difficulties:${record.ID}`] : [])]
    for (const key of keys) {
      const [, family, id] = key.split(':')
      const originalId = Number(id)
      if (!family || !Object.hasOwn(MOD_IDENTITY_FAMILIES, family)) continue
      if (!nativeInteger(originalId) || originalId < 0) throw new DomainError('INVALID_INPUT', 'Added mod identities must fit the supported native integer range')
      if (originalModIdentity(family, originalId)) continue
      const source = identityKey(layer.catalogId, family, originalId)
      if (sources.has(source)) continue
      let effectiveId = originalId
      while (originalModIdentity(family, effectiveId) || used.has(`${family}:${effectiveId}`)) {
        if (effectiveId === MAX_NATIVE_INTEGER) throw new DomainError('INVALID_INPUT', 'No supported numeric identity remains for this added mod record')
        effectiveId++
      }
      mappings.push({ projectId: layer.catalogId, family, originalId, effectiveId })
      sources.add(source)
      used.add(`${family}:${effectiveId}`)
    }
  }
  return mappings
}

export function mappedModId(mappings: readonly ModIdentityMapping[], projectId: CatalogId, family: string, id: number): number {
  return mappings.find(mapping => mapping.projectId === projectId && mapping.family === family && mapping.originalId === id)?.effectiveId ?? id
}

const STAT_REFERENCES: Readonly<Record<string, readonly [string, string][]>> = Object.freeze(Object.fromEntries([
  ...['PStatusApply', 'StatusImmunity', 'StatusAuto', 'RemoveStatusOnApply', 'SetStatusOnApply', 'SetStatusAfterRemoval', 'SetStatusAfterExpiry'].map(tag => [tag, [['Value1', 'Statuses']]]),
  ...['ForceTurnAbility', 'Flat_AbilityAPCost', 'Mult_AbilityDmg', 'Flat_AbilityMPCost', 'ReplaceAttackWith'].map(tag => [tag, [['Value1', 'Abilities']]]),
  ['Reaction', [['Value2', 'Abilities']]],
  ...['JPBoost', 'SetAppearanceToJob', 'RestrictCommandTo'].map(tag => [tag, [['Value1', 'Jobs']]]),
]))
const ABILITY_REFERENCES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...['ItemRequired', 'ConsumeItem'].map(tag => [tag, 'Items']),
  ...['StatusRequiredTarget', 'StatusRequiredUser', 'StatusRestrictedTarget', 'StatusRestrictedUser', 'DamageRateVsStatus', 'AddSpecificStatusCountTarget', 'AddSpecificStatusCountUser', 'AddToSpecificStatusCountTarget', 'AddToSpecificStatusCountUser', 'HealingRateVsStatus'].map(tag => [tag, 'Statuses']),
  ...['JobRequired', 'SubJobRequired', 'SetSubJob'].map(tag => [tag, 'Jobs']),
  ['ChangeMonster', 'Monsters'],
]))
const LOOT_TYPES = Object.freeze({ item: 1, equipment: 2 })
const CONDITION_REFERENCES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ['DifficultyIs', 'Difficulties'],
  ...['ThreatSpecificStatusCount', 'SelfSpecificStatusCount', 'OneAllySpecificStatusCount', 'OneEnemySpecificStatusCount', 'SelfTurnsWithSpecificStatusApplied', 'SelfTurnsSinceSpecificStatusApplied', 'AllyTotalSpecificStatusCount', 'EnemyTotalSpecificStatusCount'].map(tag => [tag, 'Statuses']),
  ...['AllyTotalTimesSpecificAbilityUsed', 'SelfPreviousAbilityUsedIs', 'SelfTurnsSinceSpecificAbilityUsed', 'SelfTimesSpecificAbilityUsed', 'AllyPreparingSpecificAbilityCount'].map(tag => [tag, 'Abilities']),
]))

export function remapModRecord(record: Readonly<Record<string, JsonValue>>, family: string, projectId: CatalogId, mappings: readonly ModIdentityMapping[]): Record<string, JsonValue> {
  const map = (targetFamily: string, value: JsonValue): JsonValue => typeof value === 'number' ? mappedModId(mappings, projectId, targetFamily, value) : value
  const fields = (value: JsonValue, references: readonly (readonly [string, string])[]): JsonValue => !jsonRecord(value) ? value : { ...value, ...Object.fromEntries(references.flatMap(([field, targetFamily]) => value[field] === undefined ? [] : [[field, map(targetFamily, value[field])]])) }
  const list = (value: JsonValue | undefined, transform: (entry: JsonValue) => JsonValue): JsonValue | undefined => Array.isArray(value) ? value.map(transform) : value
  const condition = (value: JsonValue): JsonValue => {
    if (!jsonRecord(value)) return value
    const target = CONDITION_REFERENCES[NATIVE_GAME_DATA.enums.ActionConditionVar?.[String(value.CondVar)] ?? '']
    return { ...value, ...(target && value.Data1 !== undefined ? { Data1: map(target, value.Data1) } : {}), ...(value.SubConds !== undefined ? { SubConds: list(value.SubConds, condition)! } : {}) }
  }
  const loot = (value: JsonValue, field = 'LootID'): JsonValue => jsonRecord(value) ? fields(value, [[field, value.LootType === LOOT_TYPES.item ? 'Items' : value.LootType === LOOT_TYPES.equipment ? 'Equipment' : '']]) : value
  const updated: Record<string, JsonValue> = { ...record, ...(record.ID === undefined ? {} : { ID: map(family, record.ID) }) }
  if (record.StatMods !== undefined) updated.StatMods = list(record.StatMods, value => fields(value, STAT_REFERENCES[jsonRecord(value) ? NATIVE_GAME_DATA.enums.SangStatModTag?.[String(value.Tag)] ?? '' : ''] ?? []))!
  if (record.AbilityMods !== undefined) updated.AbilityMods = list(record.AbilityMods, value => {
    const target = jsonRecord(value) && ABILITY_REFERENCES[NATIVE_GAME_DATA.enums.SangAbilityModTag?.[String(value.Tag)] ?? '']
    return target ? fields(value, [['Value1', target]]) : value
  })!
  if (family === 'Jobs') {
    for (const [key, target] of [['AbilityIDs', 'Abilities'], ['PassiveIDs', 'Passives']] as const) if (record[key] !== undefined) updated[key] = list(record[key], value => map(target, value))!
    if (record.LearnTree !== undefined) updated.LearnTree = list(record.LearnTree, column => list(column, node => !jsonRecord(node) ? node : fields(node, [['DataID', node.NodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : node.NodeType === LEARN_NODE_TYPES.passive ? 'Passives' : '']]))!)!
  }
  if (family === 'Abilities') for (const key of ['TargetStatuses', 'UserStatuses']) if (record[key] !== undefined) updated[key] = list(record[key], value => fields(value, [['StatusID', 'Statuses']]))!
  if (family === 'Biomes' && record.InherentStatusID !== undefined) updated.InherentStatusID = map('Statuses', record.InherentStatusID)
  if (family === 'Items') Object.assign(updated, fields(updated, [['AbilityID', 'Abilities'], ['IncreaseMaxCapacityForItemID', 'Items']]))
  if (family === 'Monsters') {
    if (record.IsPvp === true) Object.assign(updated, fields(updated, [['PvpJobID', 'Jobs'], ['PvpGenderID', 'Genders'], ['PvpWeaponID', 'Equipment']]))
    for (const key of ['ItemDrops', 'ItemSteals']) if (record[key] !== undefined) updated[key] = list(record[key], value => jsonRecord(value) ? loot(value, value.LootType === LOOT_TYPES.item ? 'ItemID' : 'EquipmentID') : value)!
    if (record.Actions !== undefined) updated.Actions = list(record.Actions, value => {
      const action = fields(value, [['AbilityID', 'Abilities'], ['AllyMonsterIDFilter', 'Monsters']])
      return jsonRecord(action) && action.Conds !== undefined ? { ...action, Conds: list(action.Conds, condition)! } : action
    })!
  }
  if (family === 'Recipes') {
    Object.assign(updated, loot(updated))
    if (record.Ingredients !== undefined) updated.Ingredients = list(record.Ingredients, value => loot(value))!
  }
  return updated
}
