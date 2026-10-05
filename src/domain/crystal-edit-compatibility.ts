import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { jsonRecord } from './crystal-edit'
import type { JsonValue, Knowledge } from './types'

export const CURRENT_CRYSTAL_EDIT_VERSION = 34
export const CRYSTAL_EDIT_VERSION_FIELD = 'Crystal Edit editor version'
export const CRYSTAL_EDIT_LOCALIZATION_FIELD = 'Crystal Edit localization project'
const LEGACY_STAT_TAG = Object.freeze({ COMMAND: 534, COOLDOWN: 482, ABILITY_MP: 483 })
const LEGACY_ABILITY_TAG = Object.freeze({ ITEM_REQUIRED: 29, TURN_VALUES: [37, 38, 39, 42, 43, 44] })
const LEGACY_LOST_AND_FOUND_ITEMS = new Set([157, 200, 201, 202, 203, 204, 205])
const STAT_FAMILIES = new Set(['Equipment', 'Monsters', 'Passives', 'Statuses'])

export function supportsCrystalEditVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 && version <= CURRENT_CRYSTAL_EDIT_VERSION
}

export function interpretCrystalEditRecord(record: Readonly<Record<string, JsonValue>>, family: string, version: number): Readonly<Record<string, JsonValue>> {
  if (!supportsCrystalEditVersion(version)) return record
  const next = { ...record }
  if (STAT_FAMILIES.has(family) && Array.isArray(record.StatMods)) next.StatMods = record.StatMods.map(value => {
    if (!jsonRecord(value)) return value
    const modifier = { ...value }
    if (version < 4 && modifier.Tag === LEGACY_STAT_TAG.COMMAND) modifier.Value1 = 14
    if (version < 8 && modifier.Tag === LEGACY_STAT_TAG.COOLDOWN) modifier.Value1 = -1
    if (version < 10 && modifier.Tag === LEGACY_STAT_TAG.ABILITY_MP) { modifier.Value2 = modifier.Value1 ?? 0; modifier.Value1 = 233 }
    return modifier
  })
  if (family === 'Abilities') {
    if (version < 2) {
      const jobs = NATIVE_GAME_DATA.databases.job
      const owns = (id: number) => Array.isArray(jobs) && jobs.some(job => jsonRecord(job) && job.ID === id && Array.isArray(job.AbilityIDs) && job.AbilityIDs.includes(record.ID!))
      next.IsDefaultLocked = owns(13) || owns(21) && record.ID !== 230
      next.IsSightLearned = owns(13)
    }
    if (version < 33) next.HideIfUnusable = false
    if (Array.isArray(record.AbilityMods)) next.AbilityMods = record.AbilityMods.map(value => {
      if (!jsonRecord(value)) return value
      const modifier = { ...value }
      if (version < 23 && typeof modifier.Tag === 'number' && LEGACY_ABILITY_TAG.TURN_VALUES.includes(modifier.Tag)) modifier.Value2 = 6
      if (version < 33 && modifier.Tag === LEGACY_ABILITY_TAG.ITEM_REQUIRED) modifier.Value2 = 1
      return modifier
    })
  }
  if (family === 'Difficulties' && version < 6) next.Rating = record.SortOrder ?? 0
  if (family === 'Statuses' && version < 12) next.VisualPriority = 0
  if (version < 13 && family === 'Biomes') next.DisableSunlight = false
  if (version < 13 && family === 'Passives') next.IsDefaultLocked = false
  if (family === 'Items') {
    if (version < 15 && record.ID === 263) next.IsCombat = true
    if (version < 24) next.AutoLostAndFound = record.IsConsumable === true && typeof record.Cost === 'number' && record.Cost > 0 || typeof record.ID === 'number' && LEGACY_LOST_AND_FOUND_ITEMS.has(record.ID)
  }
  return next
}

export function crystalEditPlanningRecord(definition: { readonly fields: Readonly<Record<string, Knowledge<JsonValue>>>; readonly legacy?: JsonValue } | undefined): Readonly<Record<string, JsonValue>> | undefined {
  const source = definition?.fields['Crystal Edit source record']
  if (source?.state !== 'known' || !jsonRecord(source.value)) return undefined
  const localization = definition?.fields[CRYSTAL_EDIT_LOCALIZATION_FIELD]
  if (localization?.state === 'known' && localization.value === true) return source.value
  const marker = definition?.fields[CRYSTAL_EDIT_VERSION_FIELD]
  const legacy = jsonRecord(definition?.legacy) ? definition.legacy : undefined
  const bundled = jsonRecord(legacy?.bundledMod) ? legacy.bundledMod : undefined
  const version = marker?.state === 'known' ? marker.value : bundled ? BUNDLED_MOD_LIBRARY.find(mod => mod.key === bundled.key && mod.sourceDigest === `sha256:${bundled.sourceDigest}`)?.editorVersion : undefined
  if (version === undefined) return source.value
  if (!supportsCrystalEditVersion(version)) return undefined
  if (legacy?.modRecordVersion === 3) return source.value
  const family = definition?.fields['Crystal Edit model type']
  return family?.state === 'known' && typeof family.value === 'string' ? interpretCrystalEditRecord(source.value, family.value, version) : source.value
}

export function interpretCrystalEditBattleConfig(config: JsonValue | undefined, version: number): JsonValue | undefined {
  return jsonRecord(config) && supportsCrystalEditVersion(version) && version < 7 ? { ...config, LearnAllJobZeroJPAbilities: false } : config
}
