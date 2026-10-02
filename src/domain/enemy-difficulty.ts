import rules from '../calculations/enemy-difficulty-v1.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { resolveGameRules, type DifficultyDefinition } from './game-rules'
import { nativeEntityId, nativeIdentity, nativeRecord } from './native-game'
import type { CatalogEntity, CatalogSnapshot, EntityId, JsonValue, Knowledge } from './types'

export interface EnemyDifficultyPreview {
  readonly hp: Knowledge<JsonValue>
  readonly mp: Knowledge<JsonValue>
  readonly attributes: Knowledge<JsonValue>
  readonly combatInputs: Knowledge<JsonValue>
}

const UNKNOWN: Knowledge<JsonValue> = Object.freeze({ state: 'unknown', reason: 'Difficulty-adjusted value is unresolved' })
export const ENEMY_GAME_MODES = [
  { value: 'standard', name: 'Standard', nativeMode: 'base' },
  { value: 'vanilla', name: 'Vanilla', nativeMode: 'Vanilla' },
  { value: 'chaos', name: 'Chaos', nativeMode: 'Chaos' },
] as const
export type EnemyGameMode = typeof ENEMY_GAME_MODES[number]['value']
export interface EnemyModeDefinition { readonly value: EnemyGameMode; readonly name: string; readonly nativeMode: string; readonly entityId?: EntityId }
const PATCH_MONSTERS = new Map((Array.isArray(NATIVE_GAME_DATA.databases.patch) ? NATIVE_GAME_DATA.databases.patch : []).flatMap(patch => nativeRecord(patch) && typeof patch.Name === 'string' && Array.isArray(patch.Monsters) ? [[patch.Name, new Set(patch.Monsters.filter(nativeRecord).map(monster => monster.ID))] as const] : []))

export function referenceEnemyGameMode(entity: CatalogEntity | undefined): EnemyGameMode | undefined {
  if (!entity) return undefined
  const identity = nativeIdentity(entity)
  const platform = entity.fields['Game platform']
  const version = entity.fields['Game version']
  if (identity?.database !== 'monster' || platform?.state !== 'known' || platform.value !== rules.source.platform || version?.state !== 'known' || version.value !== rules.source.gameVersion) return undefined
  return ENEMY_GAME_MODES.find(mode => mode.nativeMode === identity.mode)?.value
}

export function referenceEnemyModes(catalog: CatalogSnapshot | undefined, entity: CatalogEntity | undefined): readonly EnemyModeDefinition[] {
  if (!catalog || !entity || !referenceEnemyGameMode(entity)) return []
  const identity = nativeIdentity(entity)!
  const metadata = nativeRecord(catalog.legacy) ? catalog.legacy : {}
  const bindings = nativeRecord(metadata.nativeIdentityBindings) ? metadata.nativeIdentityBindings : {}
  const modeBindings = nativeRecord(metadata.nativeModeIdentityBindings) ? metadata.nativeModeIdentityBindings : {}
  return ENEMY_GAME_MODES.map(mode => {
    const patch = PATCH_MONSTERS.get(mode.nativeMode)
    if (mode.value !== 'standard' && !patch) return mode
    const nativeMode = patch?.has(identity.databaseId) ? mode.nativeMode : 'base'
    const boundId = modeBindings[`${nativeMode}:monster:${identity.databaseId}`] ?? (nativeMode === 'base' ? bindings[`monster:${identity.databaseId}`] : undefined)
    const id = typeof boundId === 'string' ? boundId : nativeEntityId('monster', identity.databaseId, nativeMode)
    const target = Object.hasOwn(catalog.entities, id) ? catalog.entities[id] : undefined
    const targetIdentity = target && nativeIdentity(target)
    return { ...mode, ...(target && referenceEnemyGameMode(target) && targetIdentity?.databaseId === identity.databaseId && targetIdentity.mode === nativeMode ? { entityId: target.id } : {}) }
  })
}

export function resolveReferenceEnemyMode(catalog: CatalogSnapshot | undefined, entity: CatalogEntity | undefined, requested?: string): EnemyModeDefinition | undefined {
  const value = requested ?? referenceEnemyGameMode(entity)
  return referenceEnemyModes(catalog, entity).find(mode => mode.value === value)
}

export function referenceEnemyDifficulties(entity: CatalogEntity | undefined, mode = referenceEnemyGameMode(entity)): readonly DifficultyDefinition[] {
  if (!referenceEnemyGameMode(entity) || !mode) return []
  return resolveGameRules({ mode: { state: 'known', value: mode } }, []).difficulties
}

function adjustedValue(value: Knowledge<JsonValue> | undefined, rate: number | undefined, vital = false): Knowledge<JsonValue> {
  if (!value || value.state === 'conflicting') return UNKNOWN
  if (value.state !== 'known') return value
  if (typeof value.value !== 'number' || !Number.isInteger(value.value) || value.value < 0 || value.value > rules.maxSignedInteger || rate === undefined || !Number.isInteger(rate) || rate < 0 || rate > rules.maxSignedInteger || value.value * rate > rules.maxSignedInteger) return UNKNOWN
  let adjusted = Math.trunc(value.value * rate / rules.percentageScale)
  if (vital && adjusted !== value.value) {
    const rounding = adjusted < rules.vitalRounding.threshold ? rules.vitalRounding.below : rules.vitalRounding.above
    adjusted = Math.trunc((adjusted + rounding.offset) / rounding.step) * rounding.step
  }
  return { state: 'known', value: adjusted }
}

function adjustedGroup(value: Knowledge<JsonValue> | undefined, fields: Readonly<Record<string, string>>, difficulty: DifficultyDefinition): Knowledge<JsonValue> {
  if (!value || value.state === 'conflicting') return UNKNOWN
  if (value.state !== 'known') return value
  if (!nativeRecord(value.value)) return UNKNOWN
  const entries = Object.entries(value.value).map(([field, input]) => {
    if (!Object.hasOwn(fields, field)) return [field, input] as const
    const adjusted = adjustedValue({ state: 'known', value: input }, difficulty.values[fields[field]!])
    return [field, adjusted.state === 'known' ? adjusted.value : undefined] as const
  })
  return entries.some(([, value]) => value === undefined) ? UNKNOWN : { state: 'known', value: Object.fromEntries(entries) as Record<string, JsonValue> }
}

export function previewEnemyDifficulty(entity: CatalogEntity, difficulty: DifficultyDefinition): EnemyDifficultyPreview {
  const boss = entity.fields.Boss
  const prefix = boss?.state === 'known' && typeof boss.value === 'boolean' ? boss.value ? 'Boss' : 'Monster' : undefined
  return {
    hp: adjustedValue(entity.fields.HP, prefix ? difficulty.values[`${prefix}HPRate`] : undefined, true),
    mp: adjustedValue(entity.fields.MP, prefix ? difficulty.values[`${prefix}MPRate`] : undefined, true),
    attributes: adjustedGroup(entity.fields['Raw attributes'], rules.attributes, difficulty),
    combatInputs: adjustedGroup(entity.fields['Raw combat inputs'], rules.combatInputs, difficulty),
  }
}
