import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { NATIVE_DATA } from './calculation-rules'
import { nativeInteger } from './native-number'
import { jsonRecord } from './crystal-edit'
import { modCatalogForPin, modModelRecords } from './mod-layers'
import { modIdentityMappings, remapModRecord } from './mod-identities'
import { modRevision } from './mod-library'
import { CURRENT_CRYSTAL_EDIT_VERSION, interpretCrystalEditBattleConfig, supportsCrystalEditVersion } from './crystal-edit-compatibility'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { normalizeModName } from './mods'
import { genderDefinition, nativeGenderDefinitions, MAX_GENDER_ID, type GenderDefinition } from './calculation-genders'
import type { BuildCalculationPlan, CatalogSnapshot, GameSetupRevision, JsonValue } from './types'

export const IMPORTED_RULES_VERSION = 2
const SUPPORTED_IMPORTED_RULES_VERSIONS = [1, IMPORTED_RULES_VERSION] as const
export const IMPORTED_RULES_REVISION = `rules-v${IMPORTED_RULES_VERSION}`
export const SUPPORTED_EDITOR_VERSION = CURRENT_CRYSTAL_EDIT_VERSION
export const PC_GAME_RULES = Object.freeze({ ppLimit: 10, equipmentSlots: 6, version: '1.6.9' })
export const ASSUMED_COMPATIBLE_PC_VERSIONS = ['1.6.6', '1.6.6.0'] as const
const SUPPORTED_PC_CALCULATION_VERSIONS: readonly string[] = [PC_GAME_RULES.version, `${PC_GAME_RULES.version}.0`, ...ASSUMED_COMPATIBLE_PC_VERSIONS]
const SHEET_CONSTANTS = new Set(['TwoHandedPAtkFlat', 'TwoHandedPAtkRate', 'DualWieldPAtkRate', 'StrWhileUnarmedBonusFlat'])
const CALCULATION_FAMILIES = Object.freeze({ Jobs: 'job', Equipment: 'equipment', Passives: 'passive', Abilities: 'ability', Statuses: 'status', Genders: 'gender' } as const)
const BASE_CALCULATION_MODELS = new Set(Object.entries(CALCULATION_FAMILIES).flatMap(([family, database]) => NATIVE_DATA.records[database].map(record => `crystal-edit:${family}:${record.ID}`)))
const DIFFICULTY_FIELDS = ['MonsterHPRate', 'BossHPRate', 'MonsterMPRate', 'BossMPRate', 'MonsterStrRate', 'MonsterVitRate', 'MonsterDexRate', 'MonsterAgiRate', 'MonsterMndRate', 'MonsterSpiRate', 'MonsterSpdRate', 'MonsterLckRate', 'MonsterPAtkRate', 'MonsterPDefRate', 'MonsterMDefRate', 'MemberHitChanceMod', 'MonsterHitChanceMod'] as const
export interface GameRuleChange { readonly field: string; readonly value: number | boolean; readonly baseline: number | boolean; readonly source: string; readonly calculated: boolean }
export interface DifficultyDefinition { readonly id: number; readonly name: string; readonly order: number; readonly isDefault: boolean; readonly source: string; readonly sourceKind: 'native' | 'mod'; readonly values: Readonly<Record<string, number>>; readonly issues: readonly string[] }
export interface GameRuleResolution {
  readonly mode?: BuildCalculationPlan['pcMode']
  readonly battleConfig: Readonly<Record<string, number | boolean>>
  readonly changes: readonly GameRuleChange[]
  readonly issues: readonly string[]
  readonly difficulties: readonly DifficultyDefinition[]
  readonly difficulty?: DifficultyDefinition
  readonly difficultyIssues: readonly string[]
  readonly genders: readonly GenderDefinition[]
}

export function gameSetupMode(setup: Pick<GameSetupRevision, 'mode'> | undefined): BuildCalculationPlan['pcMode'] {
  const mode = setup?.mode.state === 'known' ? setup.mode.value.toLowerCase() : undefined
  return mode === 'standard' || mode === 'vanilla' || mode === 'chaos' ? mode : undefined
}

type SetupRules = Pick<GameSetupRevision, 'modComposition'> & Partial<Pick<GameSetupRevision, 'difficulty' | 'mode' | 'mods' | 'platform' | 'gameVersion'>>

export function importedGameRules(root: Readonly<Record<string, JsonValue>>): JsonValue {
  const system = jsonRecord(root.System) ? root.System : undefined
  return { version: IMPORTED_RULES_VERSION, battleConfig: system?.BattleConfig ?? (root.System != null && !system ? root.System : null), difficulties: root.Difficulties ?? [], genders: root.Genders ?? [], localization: root.IsLocalization === true, unsupported: [] }
}

function difficultyDefinition(record: Readonly<Record<string, JsonValue>>, source: string, sourceKind: DifficultyDefinition['sourceKind']): DifficultyDefinition {
  const invalid = DIFFICULTY_FIELDS.filter(key => !nativeInteger(record[key]))
  return { id: record.ID as number, name: typeof record.Name === 'string' ? record.Name : `Difficulty ${record.ID}`, order: nativeInteger(record.SortOrder) ? record.SortOrder : record.ID as number, isDefault: record.IsDefault === true, source, sourceKind, values: Object.fromEntries(DIFFICULTY_FIELDS.filter(key => nativeInteger(record[key])).map(key => [key, record[key] as number])), issues: invalid.length ? [`${source}: difficulty ${record.ID} has missing or invalid values (${invalid.join(', ')}).`] : [] }
}

export function resolveGameRules(setup: SetupRules | undefined, catalogs: readonly CatalogSnapshot[]): GameRuleResolution {
  const baseline: Readonly<Record<string, number | boolean>> = NATIVE_DATA.battleConfig
  let battleConfig = baseline
  let source = 'PC 1.6.9 game data'
  let configIssues: string[] = []
  const issues: string[] = []
  // Recorded Game Setup applicability is separate from the verified Windows/macOS gameplay comparison
  if (setup?.platform?.state === 'known' && !['windows', 'pc'].includes(setup.platform.value.toLowerCase())) issues.push(`The calculation rules package has no recorded Game Setup applicability for ${setup.platform.value}.`)
  if (setup?.gameVersion?.state === 'known' && !SUPPORTED_PC_CALCULATION_VERSIONS.includes(setup.gameVersion.value)) issues.push(`Native calculations do not support game version ${setup.gameVersion.value}.`)
  const unboundNames = setup?.mods?.state === 'known' ? setup.mods.value.filter(name => {
    // Imported titles corroborate an explicitly selected project pin, even without library metadata
    // Duplicate titles remain ambiguous; a name alone never supplies a source revision
    const selected = (setup.modComposition?.layers ?? []).filter(layer => layer.enabled).flatMap(layer => {
      const catalog = modCatalogForPin(catalogs, layer)
      return catalog && normalizeModName(modRevision(catalog)?.title ?? '') === normalizeModName(name) ? [catalog.id] : []
    })
    const projects = [...new Set([...BUNDLED_MOD_LIBRARY.filter(mod => mod.catalogNames?.some(alias => normalizeModName(alias) === normalizeModName(name))).map(mod => mod.id), ...selected])]
    return projects.length !== 1 || !setup.modComposition?.layers.some(layer => layer.enabled && layer.catalogId === projects[0])
  }) : []
  if (unboundNames.length) issues.push(`Select source versions for enabled mods: ${unboundNames.join(', ')}. Mod names alone cannot provide calculation settings.`)
  const difficultyIssues: string[] = [...issues]
  const difficulties = new Map<number, DifficultyDefinition>()
  const applyDifficulties = (records: JsonValue | undefined, title: string, sourceKind: DifficultyDefinition['sourceKind']) => {
    if (records == null) return
    if (!Array.isArray(records)) { difficultyIssues.push(`${title}: difficulty definitions are not a supported list.`); return }
    const ids = new Set<number>()
    for (const record of records) {
      if (!jsonRecord(record) || !nativeInteger(record.ID) || record.ID < 0 || ids.has(record.ID)) { difficultyIssues.push(`${title}: difficulty identities are invalid or ambiguous.`); continue }
      ids.add(record.ID)
      difficulties.set(record.ID, difficultyDefinition(record, title, sourceKind))
    }
  }
  applyDifficulties(NATIVE_GAME_DATA.databases.difficulty, source, 'native')
  const mode = setup?.mode ? gameSetupMode({ mode: setup.mode }) : undefined
  const genders = new Map(nativeGenderDefinitions(mode).map(gender => [gender.id, gender]))
  const mappings = setup?.modComposition?.version === 3 ? modIdentityMappings(setup.modComposition, catalogs) : []
  const addedModels = new Map<string, { readonly project: string; readonly title: string }>()
  if (mode && ['vanilla', 'chaos'].includes(mode)) {
    const patches = NATIVE_GAME_DATA.databases.patch
    const patch = Array.isArray(patches) ? patches.find(value => jsonRecord(value) && typeof value.Name === 'string' && value.Name.toLowerCase() === mode) : undefined
    if (jsonRecord(patch)) applyDifficulties(patch.Difficulties, `PC 1.6.9 ${patch.Name}`, 'native')
  } else if (setup && mode !== 'standard') difficultyIssues.push('Choose the game mode to resolve its difficulty definitions.')
  for (const layer of setup?.modComposition?.layers ?? []) {
    if (!layer.enabled) continue
    const catalog = modCatalogForPin(catalogs, layer)
    const revision = catalog ? modRevision(catalog) : undefined
    if (!revision) { const issue = 'An enabled mod revision is unavailable.'; issues.push(issue); difficultyIssues.push(issue); continue }
    const { title, rules: metadata } = revision
    if (!metadata || !SUPPORTED_IMPORTED_RULES_VERSIONS.some(version => metadata.version === version) || !supportsCrystalEditVersion(revision.editorVersion)) {
      const issue = !SUPPORTED_IMPORTED_RULES_VERSIONS.some(version => metadata?.version === version) ? `${title}: calculation settings are unavailable in this imported revision. Reimport and explicitly select the new revision.` : `${title}: calculation settings for editor format ${revision.editorVersion ?? 'unknown'} are unsupported.`
      issues.push(issue)
      difficultyIssues.push(issue)
      continue
    }
    if (metadata.localization === true) {
      if (metadata.version === IMPORTED_RULES_VERSION && Array.isArray(metadata.genders)) for (const record of metadata.genders) {
        if (!jsonRecord(record) || !nativeInteger(record.ID) || typeof record.Name !== 'string') continue
        const original = genders.get(record.ID)
        if (original) genders.set(record.ID, { ...original, name: record.Name, nameSource: title })
      }
      continue
    }
    if (setup?.modComposition?.version === 2) for (const modelKey of modModelRecords(catalog!).keys()) {
      const family = modelKey.split(':')[1]!
      if (!Object.hasOwn(CALCULATION_FAMILIES, family) || BASE_CALCULATION_MODELS.has(modelKey)) continue
      const previous = addedModels.get(modelKey)
      if (previous && previous.project !== catalog!.id) issues.push(`${modelKey}: added identity occurs in both ${previous.title} and ${title}. CryKit cannot combine these added IDs; combined totals are unavailable.`)
      addedModels.set(modelKey, { project: catalog!.id, title })
    }
    applyDifficulties(Array.isArray(metadata.difficulties) ? metadata.difficulties.map(record => jsonRecord(record) ? remapModRecord(record, 'Difficulties', catalog!.id, mappings) : record) : metadata.difficulties, title, 'mod')
    if (Array.isArray(metadata.unsupported) && metadata.unsupported.length) issues.push(`${title}: ${metadata.unsupported.join(', ')} changes are retained but not modeled in this imported revision. Reimport and select the new version to use supported settings.`)
    if (metadata.version === IMPORTED_RULES_VERSION) {
      if (!Array.isArray(metadata.genders)) issues.push(`${title}: gender definitions are not a supported list.`)
      else {
        const ids = new Set<number>()
        for (const record of metadata.genders) {
          if (!jsonRecord(record) || !nativeInteger(record.ID) || record.ID < 0 || record.ID > MAX_GENDER_ID || ids.has(record.ID)) { issues.push(`${title}: gender identities are invalid or ambiguous.`); continue }
          ids.add(record.ID)
          const effective = remapModRecord(record, 'Genders', catalog!.id, mappings)
          genders.set(effective.ID as number, genderDefinition(effective, title, 'mod'))
        }
      }
    }
    if (metadata.battleConfig === null) continue
    source = title
    configIssues = []
    const config = interpretCrystalEditBattleConfig(metadata.battleConfig, revision.editorVersion)
    if (!jsonRecord(config)) { configIssues.push(`${title}: battle settings are not a supported object.`); continue }
    const invalid = Object.keys(baseline).filter(key => typeof config[key] !== typeof baseline[key] || typeof config[key] === 'number' && !nativeInteger(config[key]))
    const unsupported = Object.keys(config).filter(key => !Object.hasOwn(baseline, key))
    if (invalid.length || unsupported.length) {
      configIssues.push(`${title}: battle settings need review (${[...invalid.map(key => `${key} missing or invalid`), ...unsupported.map(key => `${key} unsupported`)].join(', ')}).`)
      continue
    }
    battleConfig = config as Readonly<Record<string, number | boolean>>
  }
  const changes = configIssues.length ? [] : Object.entries(battleConfig).flatMap(([field, value]) => value === baseline[field] ? [] : [{ field, value, baseline: baseline[field]!, source, calculated: SHEET_CONSTANTS.has(field) }])
  const selection = setup?.difficulty?.selection
  const difficulty = selection?.state === 'known' ? difficulties.get(selection.value) : undefined
  if (!difficulty) difficultyIssues.push(selection?.state === 'known' ? 'The selected difficulty is missing from these game and mod definitions.' : 'Difficulty is unknown or custom. Results that depend on it are unavailable.')
  return { mode, battleConfig, changes, issues: [...issues, ...configIssues], difficulties: [...difficulties.values()].sort((left, right) => left.order - right.order || left.id - right.id), difficulty, difficultyIssues: [...difficultyIssues, ...difficulty?.issues ?? []], genders: [...genders.values()].sort((left, right) => left.id - right.id) }
}

export function difficultyHitChance(base: number | null, rules: GameRuleResolution, attacker: 'member' | 'monster' = 'member'): number | null {
  if (base === null || !Number.isFinite(base) || base < 0 || base > 100) return null
  if (base === 0 || base === 100) return base
  if (!rules.difficulty || rules.difficultyIssues.length) return null
  const adjustment = rules.difficulty.values[attacker === 'member' ? 'MemberHitChanceMod' : 'MonsterHitChanceMod']
  return adjustment === undefined ? null : Math.max(0, Math.min(100, base + adjustment))
}
