import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { NATIVE_DATA } from './calculation-rules'
import { jsonRecord } from './crystal-edit'
import { modCatalogForPin } from './mod-layers'
import { modRevision } from './mod-library'
import type { BuildCalculationPlan, CatalogSnapshot, GameSetupRevision, JsonValue } from './types'

export const IMPORTED_RULES_VERSION = 1
export const IMPORTED_RULES_REVISION = `rules-v${IMPORTED_RULES_VERSION}`
export const SUPPORTED_EDITOR_VERSION = 34
export const PC_GAME_RULES = Object.freeze({ ppLimit: 10, equipmentSlots: 6, version: '1.6.9' })
const MIN_NATIVE_INTEGER = -2_147_483_648
const MAX_NATIVE_INTEGER = 2_147_483_647
const SHEET_CONSTANTS = new Set(['TwoHandedPAtkFlat', 'TwoHandedPAtkRate', 'DualWieldPAtkRate', 'StrWhileUnarmedBonusFlat'])
const DIFFICULTY_FIELDS = ['MonsterHPRate', 'BossHPRate', 'MonsterMPRate', 'BossMPRate', 'MonsterStrRate', 'MonsterVitRate', 'MonsterDexRate', 'MonsterAgiRate', 'MonsterMndRate', 'MonsterSpiRate', 'MonsterSpdRate', 'MonsterLckRate', 'MonsterPAtkRate', 'MonsterPDefRate', 'MonsterMDefRate', 'MemberHitChanceMod', 'MonsterHitChanceMod'] as const
export interface GameRuleChange { readonly field: string; readonly value: number | boolean; readonly baseline: number | boolean; readonly source: string; readonly calculated: boolean }
export interface DifficultyDefinition { readonly id: number; readonly name: string; readonly order: number; readonly isDefault: boolean; readonly source: string; readonly values: Readonly<Record<string, number>>; readonly issues: readonly string[] }
export interface GameRuleResolution {
  readonly mode?: BuildCalculationPlan['pcMode']
  readonly battleConfig: Readonly<Record<string, number | boolean>>
  readonly changes: readonly GameRuleChange[]
  readonly issues: readonly string[]
  readonly difficulties: readonly DifficultyDefinition[]
  readonly difficulty?: DifficultyDefinition
  readonly difficultyIssues: readonly string[]
}

export function gameSetupMode(setup: Pick<GameSetupRevision, 'mode'> | undefined): BuildCalculationPlan['pcMode'] {
  const mode = setup?.mode.state === 'known' ? setup.mode.value.toLowerCase() : undefined
  return mode === 'standard' || mode === 'vanilla' || mode === 'chaos' ? mode : undefined
}

type SetupRules = Pick<GameSetupRevision, 'modComposition'> & Partial<Pick<GameSetupRevision, 'difficulty' | 'mode' | 'mods'>>
const nativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_NATIVE_INTEGER && value <= MAX_NATIVE_INTEGER

export function importedGameRules(root: Readonly<Record<string, JsonValue>>): JsonValue {
  const system = jsonRecord(root.System) ? root.System : undefined
  return { version: IMPORTED_RULES_VERSION, battleConfig: system?.BattleConfig ?? (root.System != null && !system ? root.System : null), difficulties: root.Difficulties ?? [], localization: root.IsLocalization === true, unsupported: ['Genders'].filter(key => root[key] != null && (!Array.isArray(root[key]) || root[key].length > 0)) }
}

function difficultyDefinition(record: Readonly<Record<string, JsonValue>>, source: string): DifficultyDefinition {
  const invalid = DIFFICULTY_FIELDS.filter(key => !nativeInteger(record[key]))
  return { id: record.ID as number, name: typeof record.Name === 'string' ? record.Name : `Difficulty ${record.ID}`, order: nativeInteger(record.SortOrder) ? record.SortOrder : record.ID as number, isDefault: record.IsDefault === true, source, values: Object.fromEntries(DIFFICULTY_FIELDS.filter(key => nativeInteger(record[key])).map(key => [key, record[key] as number])), issues: invalid.length ? [`${source}: difficulty ${record.ID} has missing or invalid values (${invalid.join(', ')}).`] : [] }
}

export function resolveGameRules(setup: SetupRules | undefined, catalogs: readonly CatalogSnapshot[]): GameRuleResolution {
  const baseline: Readonly<Record<string, number | boolean>> = NATIVE_DATA.battleConfig
  let battleConfig = baseline
  let source = 'PC 1.6.9 game data'
  let configIssues: string[] = []
  const issues: string[] = []
  if (setup?.mods?.state === 'known' && setup.mods.value.length) issues.push('Named mod choices lack calculation settings. Import their files and select exact revisions to establish their effects.')
  const difficultyIssues: string[] = [...issues]
  const difficulties = new Map<number, DifficultyDefinition>()
  const applyDifficulties = (records: JsonValue | undefined, title: string) => {
    if (records == null) return
    if (!Array.isArray(records)) { difficultyIssues.push(`${title}: difficulty definitions are not a supported list.`); return }
    const ids = new Set<number>()
    for (const record of records) {
      if (!jsonRecord(record) || !nativeInteger(record.ID) || record.ID < 0 || ids.has(record.ID)) { difficultyIssues.push(`${title}: difficulty identities are invalid or ambiguous.`); continue }
      ids.add(record.ID)
      difficulties.set(record.ID, difficultyDefinition(record, title))
    }
  }
  applyDifficulties(NATIVE_GAME_DATA.databases.difficulty, source)
  const mode = setup?.mode ? gameSetupMode({ mode: setup.mode }) : undefined
  if (mode && ['vanilla', 'chaos'].includes(mode)) {
    const patches = NATIVE_GAME_DATA.databases.patch
    const patch = Array.isArray(patches) ? patches.find(value => jsonRecord(value) && typeof value.Name === 'string' && value.Name.toLowerCase() === mode) : undefined
    if (jsonRecord(patch)) applyDifficulties(patch.Difficulties, `PC 1.6.9 ${patch.Name}`)
  } else if (setup && mode !== 'standard') difficultyIssues.push('Choose the game mode to resolve its difficulty definitions.')
  for (const layer of setup?.modComposition?.layers ?? []) {
    if (!layer.enabled) continue
    const catalog = modCatalogForPin(catalogs, layer)
    const revision = catalog ? modRevision(catalog) : undefined
    if (!revision) { const issue = 'An enabled mod revision is unavailable.'; issues.push(issue); difficultyIssues.push(issue); continue }
    const { title, rules: metadata } = revision
    if (metadata?.version !== IMPORTED_RULES_VERSION || revision.editorVersion !== SUPPORTED_EDITOR_VERSION) {
      const issue = metadata?.version !== IMPORTED_RULES_VERSION ? `${title}: calculation settings are unavailable in this imported revision. Reimport and explicitly select the new revision.` : `${title}: calculation settings for editor format ${revision.editorVersion ?? 'unknown'} are unsupported.`
      issues.push(issue)
      difficultyIssues.push(issue)
      continue
    }
    if (metadata.localization === true) continue
    applyDifficulties(metadata.difficulties, title)
    if (Array.isArray(metadata.unsupported) && metadata.unsupported.length) issues.push(`${title}: ${metadata.unsupported.join(', ')} changes are retained but not modeled in calculations.`)
    if (metadata.battleConfig === null) continue
    source = title
    configIssues = []
    const config = metadata.battleConfig
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
  if (!difficulty) difficultyIssues.push(selection?.state === 'known' ? 'The selected difficulty is missing from these game and mod definitions.' : 'Difficulty is unknown or custom; difficulty-dependent estimates are unresolved.')
  return { mode, battleConfig, changes, issues: [...issues, ...configIssues], difficulties: [...difficulties.values()].sort((left, right) => left.order - right.order || left.id - right.id), difficulty, difficultyIssues: [...difficultyIssues, ...difficulty?.issues ?? []] }
}

export function difficultyHitChance(base: number | null, rules: GameRuleResolution, attacker: 'member' | 'monster' = 'member'): number | null {
  if (base === null || !Number.isFinite(base) || base < 0 || base > 100) return null
  if (base === 0 || base === 100) return base
  if (!rules.difficulty || rules.difficultyIssues.length) return null
  const adjustment = rules.difficulty.values[attacker === 'member' ? 'MemberHitChanceMod' : 'MonsterHitChanceMod']
  return adjustment === undefined ? null : Math.max(0, Math.min(100, base + adjustment))
}
