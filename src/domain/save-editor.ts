import { CRYSTAL_SAVE_VERSION, decodeCrystalSave, encodeCrystalSave, isSupportedCrystalSaveVersion, type BsonDocument, type BsonValue, type CrystalSave } from '../interchange/crystal-save.ts'
import type { NativeRecord } from './native-game'
import { createSaveEditorCatalog, resolveSaveEditorMods, saveEditorCatalogForMode, type SaveEditorCatalog, type SaveEditorFamily, type SaveEditorMode, type SaveEditorModSource } from './save-editor-mods'

export { createSaveEditorCatalog }
export type { SaveEditorCatalog, SaveEditorMode, SaveEditorModSource }

export const SAVE_EDITOR_MAX_CURRENCY = 999_999_999
const DEFAULT_LEVEL_CAP = 60
export const SAVE_EDITOR_MAX_LEVEL = 99
const MAX_STOCK = 99
const MAX_JP = 10_000
const PASSIVE_POINT_BUDGET = 10
const PRESET_EQUIPMENT_COPIES = 10
const LEARN_NODE = Object.freeze({ ability: 2, passive: 3 })
const LEGACY_HEADER = Object.freeze({ flags: 14, mods: 24 })
const RANDOMIZER_HEADER_FLAGS = Object.freeze({ Crystals: 1, Monsters: 2, Items: 4, Equipment: 8, JobAbilities: 16, MonsterAbilities: 32, Passives: 64, InnatePassives: 128, TeleportPoints: 256, Music: 512, ProgressionGate: 1024, StartWithHomePointStone: 2048, StartWithTreasureFinder: 4096, StartWithAllMaps: 8192, MonsterDifficulties: 16384 })
const RANDOMIZER_BOOLEAN_FIELDS = ['Crystals', 'Monsters', 'MonstersScaled', 'Bosses', 'BossesScaled', 'Items', 'IncludeRecovery', 'IncludeQuest', 'IncludeProgression', 'ItemsScaled', 'Equipment', 'EquipmentScaled', 'JobAbilities', 'IncludeScholar', 'IncludeSummoner', 'JobAbilitiesUnrestricted', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music', 'ProgressionGate', 'StartWithHomePointStone', 'StartWithTreasureFinder', 'StartWithAllMaps', 'EnableSpoilerLog'] as const
const RANDOMIZER_PRIMARY_FIELDS = ['Crystals', 'Monsters', 'Bosses', 'Items', 'Equipment', 'JobAbilities', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music'] as const
const RANDOMIZER_TELEPORT_POINT_IDS = new Set([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
const RANDOMIZER_TRACK_CUE_IDS = new Set([...Array.from({ length: 5 }, (_, index) => index + 1), ...Array.from({ length: 23 }, (_, index) => index + 8), ...Array.from({ length: 43 }, (_, index) => index + 32), ...Array.from({ length: 7 }, (_, index) => index + 96)])
const RANDOMIZER_ENUM_BOUNDS = Object.freeze({ TeleportPoints: 32, Music: 103 })
const LEVEL_ASSIST_FLAG = 128
const TREASURE_FINDER_BONUS = 4
const ENABLE_EQUIPMENT_TYPE = 406
const DUAL_WIELD = 511
const EMPTY_DATE = -62_135_596_800_000n
const LEARNED = Object.freeze({ locked: 0, unlocked: 1, learned: 2 })
const ATLAS = Object.freeze({ seen: 2, acquired: 4 })
const DEBUG_NAME = /test|placeholder|debug|unused/i
const PRESET_TOOL_IDS = new Set([55, 91, 97, 147, 149, 150, 151, 167, 186, 196, 201])
const PRESET_MATERIAL_IDS = new Set([3, 4, 5, 67, 68, 69, 70, 71, 72, 157, 178, 179, 180, 181, 182, 183, 187, 188, 189, 190, 200, 202, 203, 204, 205])
const MOD_GROUP_FIELDS = Object.freeze({ abilities: 'Abilities', animations: 'Animations', biomes: 'Biomes', difficulties: 'Difficulties', equipment: 'Equipment', genders: 'Genders', items: 'Items', jobs: 'Jobs', monsters: 'Monsters', passives: 'Passives', recipes: 'Recipes', sparks: 'Sparks', statuses: 'Statuses', troops: 'Troops', entities: 'Entities' })
const CONVERTIBLE_MOD_GROUPS = new Set(['jobs', 'abilities', 'passives', 'items', 'equipment', 'genders'])
type Family = SaveEditorFamily
export type SaveInventoryKind = 'item' | 'equipment'
export interface SaveEditorChoice { id: number; name: string }
export interface SaveEditorMemberSummary { index: number; name: string; level: number; jobId: number; subJobId: number | null; growthJobId: number; equipmentIds: readonly (number | null)[]; passiveIds: readonly number[]; unlockedJobIds: readonly number[]; learnedPassiveIds: readonly number[]; unlockedJobs: number; masteredJobs: number; learnedAbilities: number; learnedPassives: number }
export interface SaveEditorInventoryRow extends SaveEditorChoice { kind: SaveInventoryKind; count: number; capacity: number; equipped: number }
export interface SaveEditorSummary { editable: boolean; issues: string[]; mode: SaveEditorMode; randomized: boolean; currency: number; members: SaveEditorMemberSummary[]; inventory: SaveEditorInventoryRow[]; levelCap: number; assistEnabled: boolean }
export interface SaveVanillaConversionPreview { relevant: boolean; convertible: boolean; changes: readonly string[]; blockers: readonly string[]; draft?: CrystalSave }
type RandomizerBooleanField = typeof RANDOMIZER_BOOLEAN_FIELDS[number]
type RandomizerMappingField = 'AbilityJobs' | 'AbilityMonsters' | 'Equipment' | 'Items' | 'Jobs' | 'Passives' | 'Troops' | 'MonsterDifficulties' | 'TeleportPoints' | 'Music'
interface SaveEditorRandomizerState { readonly enabled: boolean; readonly flags: Readonly<Record<RandomizerBooleanField, boolean>>; readonly mappings?: Readonly<Record<RandomizerMappingField, readonly number[]>> }
interface ValidatedSaveEditor { readonly catalog: SaveEditorCatalog; readonly randomizer: SaveEditorRandomizerState }
export type SaveEditCommand =
  | { type: 'currency'; value: number }
  | { type: 'member'; index: number; name?: string; level?: number; jobId?: number; subJobId?: number | null }
  | { type: 'loadout'; index: number; jobId: number; subJobId: number | null; equipmentIds: readonly (number | null)[]; passiveIds: readonly number[] }
  | { type: 'stock'; kind: SaveInventoryKind; id: number; count: number }
  | { type: 'unlock-jobs' | 'master-jobs' | 'overpowered' | 'reveal-maps' }

function object(value: BsonValue | undefined, context: string): BsonDocument {
  if (value?.type !== 'document') throw new Error(`${context} must be a BSON document`)
  return value
}
function array(value: BsonValue | undefined, context: string): BsonValue[] {
  if (value?.type !== 'array') throw new Error(`${context} must be a BSON array`)
  return value.value
}
function number(value: BsonValue | undefined, context: string): number {
  if ((value?.type !== 'int32' && value?.type !== 'double') || !Number.isSafeInteger(value.value)) throw new Error(`${context} must be an integer`)
  return value.value
}
function string(value: BsonValue | undefined, context: string): string {
  if (value?.type !== 'string') throw new Error(`${context} must be text`)
  return value.value
}
function unsignedBigInt(value: BsonValue | undefined, context: string): bigint {
  if (value?.type === 'string' && /^\d+$/.test(value.value)) return BigInt(value.value)
  if (value?.type === 'int64' && value.value >= 0n) return value.value
  if ((value?.type === 'int32' || value?.type === 'double') && Number.isSafeInteger(value.value) && value.value >= 0) return BigInt(value.value)
  throw new Error(`${context} must be an unsigned integer`)
}
function flag(value: BsonValue | undefined): boolean { return value?.type === 'boolean' && value.value }
function int(value: number): BsonValue { return { type: 'int32', value } }
function text(value: string): BsonValue { return { type: 'string', value } }
function list(value: BsonValue[]): BsonValue { return { type: 'array', value } }
function document(value: Record<string, BsonValue>): BsonDocument { return { type: 'document', value } }
function numbers(value: BsonValue | undefined, context: string): number[] { return array(value, context).map(entry => number(entry, context)) }
function bound(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`)
}
function known(catalog: SaveEditorCatalog, family: Family, id: number): NativeRecord {
  const result = catalog.records[family].get(id)
  if (!result) throw new Error(`Unknown ${family} ID ${id}; editing requires matching native definitions`)
  return result
}
function flags(save: CrystalSave): BsonDocument { return object(save.party.value.GameplayFlags ?? (save.header.version < CRYSTAL_SAVE_VERSION ? document({}) : undefined), 'GameplayFlags') }
export function saveEditorMode(save: CrystalSave, nativeCatalog: SaveEditorCatalog): SaveEditorMode {
  const bodyMode = number(flags(save).value.PatchMode ?? int(0), 'Patch mode')
  if (save.header.patchMode !== bodyMode) throw new Error('Header and party game modes disagree')
  return saveEditorCatalogForMode(nativeCatalog, bodyMode).mode
}
function subJob(member: BsonDocument, save: CrystalSave): number | null {
  const value = member.value.SubJob
  return value?.type === 'null' || (!value && save.header.version < CRYSTAL_SAVE_VERSION) ? null : number(value, 'SubJob')
}
function growthJob(member: BsonDocument, save: CrystalSave): number {
  const value = member.value.Growth
  return number(save.header.version < CRYSTAL_SAVE_VERSION && (!value || value.type === 'null') ? member.value.Job : value, 'Growth')
}
function growthHistory(levels: BsonDocument, save: CrystalSave): number[] {
  const growth = numbers(levels.value.Entries, 'Growth levels')
  const history = levels.value.Hist ? numbers(levels.value.Hist, 'Growth history') : save.header.version < CRYSTAL_SAVE_VERSION ? [] : numbers(undefined, 'Growth history')
  return save.header.version < CRYSTAL_SAVE_VERSION ? Array.from({ length: Math.max(growth.length, history.length) }, (_, id) => Math.max(history[id] ?? 0, growth[id] ?? 0)) : history
}
function stock(save: CrystalSave, kind: SaveInventoryKind): BsonValue[] {
  return array(object(save.party.value[kind === 'item' ? 'Items' : 'Equipment'], kind).value.Stock, `${kind} stock`)
}
function stockId(entry: BsonValue, kind: SaveInventoryKind): number { return number(object(entry, 'Stock entry').value[kind === 'item' ? 'Item' : 'Equipment'], 'Stock ID') }
function stockCount(entry: BsonValue): number { return number(object(entry, 'Stock entry').value.Count, 'Stock count') }
function quantity(save: CrystalSave, kind: SaveInventoryKind, id: number): number { return stock(save, kind).filter(entry => stockId(entry, kind) === id).reduce((sum, entry) => sum + stockCount(entry), 0) }
function equippedCount(save: CrystalSave, id: number): number { return save.members.reduce((sum, member) => sum + (flag(member.value.IsPresent) ? array(member.value.Equipment, 'Member equipment').filter(value => value.type !== 'null' && number(value, 'Equipped ID') === id).length : 0), 0) }
function levelCap(save: CrystalSave): number {
  const values = flags(save).value
  if (flag(values.MaxLevelDown)) return number(values.MaxLevelDownVal, 'Level limit')
  return flag(values.MaxLevelUp) ? number(values.MaxLevelUpVal, 'Level cap') : DEFAULT_LEVEL_CAP
}
function capacity(save: CrystalSave, catalog: SaveEditorCatalog, kind: SaveInventoryKind, id: number): number {
  const record = known(catalog, kind, id)
  const base = typeof record.MaxCapacity === 'number' ? record.MaxCapacity : 0
  if (kind === 'equipment') {
    const limit = flag(flags(save).value.KeepEquipment) && !flag(flags(save).value.LimitlessEquipment) && base > 0 ? base : MAX_STOCK
    return Math.max(0, limit - equippedCount(save, id))
  }
  if (base === 0) return record.MapForBiomeID !== null && record.MapForBiomeID !== undefined ? 1 : MAX_STOCK
  return Math.min(MAX_STOCK, stock(save, 'item').reduce((sum, entry) => {
    const pouch = catalog.records.item.get(stockId(entry, 'item'))
    return sum + (pouch?.IncreaseMaxCapacityForItemID === id && typeof pouch.IncreaseMaxCapacityBy === 'number' ? pouch.IncreaseMaxCapacityBy * stockCount(entry) : 0)
  }, base))
}

function partyModDocument(save: CrystalSave): BsonDocument {
  return object(save.party.value.Mods ?? (save.header.version < LEGACY_HEADER.mods ? document({ IsModded: { type: 'boolean', value: false }, Mods: list([]), Redirects: list([]) }) : undefined), 'Mods')
}

function partyModList(mods: BsonDocument): { id: string; title: string; version: string; steamWorkshopFileId: bigint }[] {
  return array(mods.value.Mods, 'Mods').map((entry, index) => {
    const value = object(entry, `Mod ${index + 1}`).value
    return { id: string(value.ID, 'Mod ID'), title: string(value.Title, 'Mod title'), version: string(value.Version, 'Mod version'), steamWorkshopFileId: unsignedBigInt(value.SteamWorkshopFileID, 'Steam Workshop ID') }
  })
}

function partyModMaps(mods: BsonDocument): CrystalSave['header']['modIdMaps'] {
  return array(mods.value.Redirects, 'Mod redirects').map((entry, index) => {
    const value = object(entry, `Mod redirect ${index + 1}`).value
    const groups: CrystalSave['header']['modIdMaps'][number]['groups'] = Object.create(null)
    for (const [group, field] of Object.entries(MOD_GROUP_FIELDS)) {
      const collection = object(value[field], `${field} redirects`).value
      const ids = array(collection.IDs, `${field} redirect IDs`).map(pair => {
        const item = object(pair, `${field} redirect`).value
        return { originalId: number(item.O, 'Original ID'), newId: number(item.N, 'New ID') }
      })
      if (number(collection.Count, `${field} redirect count`) !== ids.length) throw new Error(`${field} redirect count is inconsistent`)
      groups[group] = ids
    }
    return { modId: string(value.ModID, 'Redirect mod ID'), groups }
  })
}

function sameModList(left: CrystalSave['header']['mods'], right: CrystalSave['header']['mods']): boolean {
  return left.length === right.length && left.every((mod, index) => {
    const other = right[index]
    return other && mod.id === other.id && mod.title === other.title && mod.version === other.version && mod.steamWorkshopFileId === other.steamWorkshopFileId
  })
}

function sameModMaps(left: CrystalSave['header']['modIdMaps'], right: CrystalSave['header']['modIdMaps']): boolean {
  return left.length === right.length && left.every((map, index) => {
    const other = right[index]
    if (!other || map.modId !== other.modId) return false
    return Object.keys(MOD_GROUP_FIELDS).every(group => {
      const pairs = map.groups[group] ?? []
      const otherPairs = other.groups[group] ?? []
      return pairs.length === otherPairs.length && pairs.every((pair, pairIndex) => pair.originalId === otherPairs[pairIndex]?.originalId && pair.newId === otherPairs[pairIndex]?.newId)
    })
  })
}

function nativeBound(catalog: SaveEditorCatalog, family: Family): number {
  return Math.max(-1, ...catalog.records[family].keys()) + 1
}

function recordBound(records: ReadonlyMap<number, NativeRecord>): number {
  return Math.max(-1, ...records.keys()) + 1
}

function randomizerFlagValues(save: CrystalSave): { readonly document: BsonDocument; readonly flags: Record<RandomizerBooleanField, boolean> } {
  const randomizer = object(save.party.value.RandomizerFlags ?? (save.header.version < LEGACY_HEADER.flags ? document({}) : undefined), 'RandomizerFlags')
  const values = {} as Record<RandomizerBooleanField, boolean>
  for (const field of RANDOMIZER_BOOLEAN_FIELDS) {
    const value = randomizer.value[field]
    if (value !== undefined && value.type !== 'boolean') throw new Error(`Randomizer ${field} flag must be a boolean`)
    values[field] = value?.type === 'boolean' && value.value
  }
  return { document: randomizer, flags: values }
}

function randomizerStateHint(save: CrystalSave): boolean {
  if (save.header.randomizerFlags !== 0) return true
  const value = save.party.value.RandomizerFlags
  return value?.type === 'document' && Object.values(value.value).some(entry => entry.type === 'boolean' && entry.value)
}

function validateRandomizerPermutation(label: string, values: readonly number[], records: ReadonlyMap<number, NativeRecord>, active: boolean): void {
  const expected = recordBound(records)
  if (values.length !== expected) throw new Error(`${label} randomizer mapping has ${values.length} entries; expected ${expected}`)
  const targets = new Set<number>()
  for (const [source, target] of values.entries()) {
    if (!Number.isSafeInteger(target) || target < 0) throw new Error(`${label} randomizer mapping contains an invalid ID`)
    if (!records.has(source)) {
      if (target !== source) throw new Error(`${label} randomizer mapping redirects an unavailable source ID ${source}`)
      continue
    }
    if (!records.has(target)) throw new Error(`${label} randomizer mapping targets unknown ID ${target}`)
    if (targets.has(target)) throw new Error(`${label} randomizer mapping targets ID ${target} more than once`)
    targets.add(target)
    if (!active && target !== source) throw new Error(`${label} randomizer mapping is active while its option is disabled`)
  }
}

function validateRandomizerEnumPermutation(label: 'TeleportPoints' | 'Music', values: readonly number[], validIds: ReadonlySet<number>, active: boolean): void {
  const expected = RANDOMIZER_ENUM_BOUNDS[label]
  if (values.length !== expected) throw new Error(`${label} randomizer mapping has ${values.length} entries; expected ${expected}`)
  const targets = new Set<number>()
  for (const [source, target] of values.entries()) {
    if (!Number.isSafeInteger(target) || target < 0 || target >= expected) throw new Error(`${label} randomizer mapping contains an invalid ID`)
    if (!validIds.has(source)) {
      if (target !== source) throw new Error(`${label} randomizer mapping redirects unavailable source ID ${source}`)
      continue
    }
    if (!validIds.has(target)) throw new Error(`${label} randomizer mapping targets unknown ID ${target}`)
    if (targets.has(target)) throw new Error(`${label} randomizer mapping targets ID ${target} more than once`)
    targets.add(target)
    if (!active && target !== source) throw new Error(`${label} randomizer mapping is active while its option is disabled`)
  }
}

function readRandomizerState(save: CrystalSave, catalog: SaveEditorCatalog): SaveEditorRandomizerState {
  const { document: randomizer, flags } = randomizerFlagValues(save)
  const expectedHeader = Object.entries(RANDOMIZER_HEADER_FLAGS).reduce((value, [field, bit]) => value | (flags[field as keyof typeof RANDOMIZER_HEADER_FLAGS] ? bit : 0), 0)
  if (save.header.version >= LEGACY_HEADER.flags && save.header.randomizerFlags !== expectedHeader) throw new Error('Header and party randomizer flags disagree')
  if ((!flags.Monsters && flags.MonstersScaled) || (!flags.Bosses && flags.BossesScaled)) throw new Error('Scaled monster randomizer options require their matching monster option')
  if (!flags.Items && (flags.IncludeRecovery || flags.IncludeQuest || flags.IncludeProgression || flags.ItemsScaled)) throw new Error('Item randomizer sub-options require item randomization')
  if (!flags.IncludeProgression && flags.EnableSpoilerLog) throw new Error('The spoiler log requires randomized progression items')
  if (!flags.Equipment && flags.EquipmentScaled) throw new Error('Scaled equipment requires equipment randomization')
  if (!flags.JobAbilities && (flags.IncludeScholar || flags.IncludeSummoner || flags.JobAbilitiesUnrestricted)) throw new Error('Job ability sub-options require job ability randomization')
  const primaryEnabled = RANDOMIZER_PRIMARY_FIELDS.some(field => flags[field])
  const enabled = Object.values(flags).some(Boolean)
  const seed = randomizer.value.Seed
  if (seed !== undefined && seed.type !== 'null' && seed.type !== 'string') throw new Error('Randomizer seed must be text or null')
  if (primaryEnabled && (seed?.type !== 'string' || !seed.value)) throw new Error('Enabled randomizer options require a saved seed')
  if (!primaryEnabled) return { enabled, flags }

  const mapping = object(save.party.value.RandomizerMapping, 'RandomizerMapping')
  const mappings = {} as Record<RandomizerMappingField, readonly number[]>
  for (const field of ['AbilityJobs', 'AbilityMonsters', 'Equipment', 'Items', 'Jobs', 'Passives', 'Troops', 'MonsterDifficulties', 'TeleportPoints', 'Music'] as const) mappings[field] = numbers(mapping.value[field], `${field} randomizer mapping`)
  validateRandomizerPermutation('Job ability', mappings.AbilityJobs, catalog.records.ability, flags.JobAbilities)
  validateRandomizerPermutation('Monster ability', mappings.AbilityMonsters, catalog.records.ability, flags.MonsterAbilities)
  validateRandomizerPermutation('Equipment', mappings.Equipment, catalog.records.equipment, flags.Equipment)
  validateRandomizerPermutation('Item', mappings.Items, catalog.records.item, flags.Items)
  validateRandomizerPermutation('Class', mappings.Jobs, catalog.records.job, flags.Crystals)
  validateRandomizerPermutation('Passive', mappings.Passives, catalog.records.passive, flags.Passives || flags.InnatePassives)
  validateRandomizerPermutation('Troop', mappings.Troops, catalog.randomizerRecords.troop, flags.Monsters || flags.Bosses)

  const monsterBound = recordBound(catalog.randomizerRecords.monster)
  if (mappings.MonsterDifficulties.length !== monsterBound) throw new Error(`Monster difficulty randomizer mapping has ${mappings.MonsterDifficulties.length} entries; expected ${monsterBound}`)
  const defaultDifficulty = [...catalog.randomizerRecords.difficulty].find(([, record]) => record.IsDefault)?.[0]
  if (defaultDifficulty === undefined) throw new Error('Native randomizer data has no default difficulty')
  for (const target of mappings.MonsterDifficulties) {
    if (!Number.isSafeInteger(target) || !catalog.randomizerRecords.difficulty.has(target)) throw new Error(`Monster difficulty randomizer mapping targets unknown ID ${target}`)
    if (!flags.MonsterDifficulties && target !== defaultDifficulty) throw new Error('Monster difficulty randomizer mapping is active while its option is disabled')
  }
  validateRandomizerEnumPermutation('TeleportPoints', mappings.TeleportPoints, RANDOMIZER_TELEPORT_POINT_IDS, flags.TeleportPoints)
  validateRandomizerEnumPermutation('Music', mappings.Music, RANDOMIZER_TRACK_CUE_IDS, flags.Music)
  return { enabled: true, flags, mappings }
}

function randomizedId(randomizer: SaveEditorRandomizerState, field: 'AbilityJobs' | 'Passives', id: number): number {
  return randomizer.mappings?.[field][id] ?? id
}

function neutralAtlasEntry(id: number): BsonValue {
  return document({ ID: int(id), S: int(0), HT: { type: 'datetime', value: EMPTY_DATE }, ST: { type: 'datetime', value: EMPTY_DATE }, AT: { type: 'datetime', value: EMPTY_DATE }, PT: { type: 'datetime', value: EMPTY_DATE }, BF: int(0) })
}

function sameNumberList(value: BsonValue[], expected: readonly number[]): boolean {
  return value.length === expected.length && value.every((entry, index) => (entry.type === 'int32' || entry.type === 'double') && entry.value === expected[index])
}

export function previewVanillaConversion(input: CrystalSave, nativeCatalog: SaveEditorCatalog): SaveVanillaConversionPreview {
  const blockers: string[] = []
  const changes: string[] = []
  let nonNativeState = false
  const save = structuredClone(input)
  let mods: BsonDocument
  let bodyMods: ReturnType<typeof partyModList>
  let bodyMaps: ReturnType<typeof partyModMaps>
  try {
    mods = partyModDocument(save)
    bodyMods = partyModList(mods)
    bodyMaps = partyModMaps(mods)
  } catch (error) {
    return { relevant: true, convertible: false, changes, blockers: [error instanceof Error ? error.message : 'Mod metadata could not be read'] }
  }
  const headerState = save.header.isModded || save.header.mods.length > 0 || save.header.modIdMaps.length > 0
  const bodyState = flag(mods.value.IsModded) || bodyMods.length > 0 || bodyMaps.length > 0
  let incompatibleConfiguration = false
  if (!sameModList(save.header.mods, bodyMods) || !sameModMaps(save.header.modIdMaps, bodyMaps) || flag(mods.value.IsModded) !== save.header.isModded) blockers.push('Header and party mod metadata disagree')
  if ((headerState || bodyState) && save.header.version < 25) blockers.push('Removing mod state requires save format 25 or newer when mod metadata is present')
  try {
    saveEditorMode(save, nativeCatalog)
    const randomizer = object(save.party.value.RandomizerFlags ?? (save.header.version < LEGACY_HEADER.flags ? document({}) : undefined), 'RandomizerFlags')
    if (save.header.randomizerFlags !== 0 || Object.values(randomizer.value).some(value => value.type === 'boolean' && value.value)) { incompatibleConfiguration = true; blockers.push('Removing mod state does not rewrite randomized identities') }
  } catch (error) { incompatibleConfiguration = true; blockers.push(error instanceof Error ? error.message : 'Game mode flags could not be read') }
  if (!headerState && !bodyState && incompatibleConfiguration) return { relevant: false, convertible: false, changes: [], blockers: [] }
  const unsupported = [...new Set([...save.header.modIdMaps, ...bodyMaps].flatMap(map => Object.entries(map.groups).flatMap(([group, pairs]) => pairs.length && !CONVERTIBLE_MOD_GROUPS.has(group) ? [group] : [])))]
  if (unsupported.length) blockers.push(`Conversion cannot verify saved redirects for ${unsupported.sort().join(', ')}`)

  const memberChanges: string[] = []
  for (const [index, member] of save.members.entries()) {
    const name = (() => { try { return string(member.value.Name, 'Name') } catch { return `Member ${index + 1}` } })()
    try {
      const currentJob = number(member.value.Job, 'Job')
      const currentGrowth = growthJob(member, save)
      const currentSubJob = subJob(member, save)
      const currentGender = number(member.value.Gender, 'Gender')
      if (!nativeCatalog.records.job.has(currentJob)) { nonNativeState = true; blockers.push(`${name} uses mod-only current class ${currentJob}`) }
      if (!nativeCatalog.records.job.has(currentGrowth)) { nonNativeState = true; blockers.push(`${name} uses mod-only growth class ${currentGrowth}`) }
      if (currentSubJob !== null && !nativeCatalog.records.job.has(currentSubJob)) { nonNativeState = true; blockers.push(`${name} uses mod-only subclass ${currentSubJob}`) }
      if (!nativeCatalog.records.gender.has(currentGender)) { nonNativeState = true; blockers.push(`${name} uses mod-only gender ${currentGender}`) }
      const levels = object(member.value.Levels, 'Levels')
      for (const field of ['Entries', 'Hist'] as const) {
        const values = array(levels.value[field], field)
        for (const [id, value] of values.entries()) if (!nativeCatalog.records.job.has(id)) {
          nonNativeState = true
          if (number(value, field) !== 0) blockers.push(`${name} has nonzero mod-only ${field === 'Entries' ? 'growth' : 'growth history'} for class ${id}`)
        }
        const bound = nativeBound(nativeCatalog, 'job')
        let changed = false
        for (let id = 0; id < Math.min(values.length, bound); id++) if (!nativeCatalog.records.job.has(id) && number(values[id], field) !== 0) { values[id] = int(0); changed = true }
        if (values.length > bound) { values.splice(bound); changed = true }
        if (changed) memberChanges.push(`${name}: mod-only ${field === 'Entries' ? 'growth slots' : 'growth history slots'} removed`)
      }
      let learningRemoved = 0
      let learningTrimmed = false
      for (const [field, family] of [['LearnedJobs', 'job'], ['LearnedAbilities', 'ability'], ['LearnedPassives', 'passive']] as const) {
        const values = array(member.value[field], field)
        const bound = nativeBound(nativeCatalog, family)
        for (let id = 0; id < values.length; id++) if (!nativeCatalog.records[family].has(id)) {
          nonNativeState = true
          learningTrimmed = true
          if (number(values[id], field) > 0) learningRemoved++
          if (id < bound) values[id] = int(0)
        }
        if (values.length > bound) { nonNativeState = true; learningTrimmed = true; values.splice(bound) }
      }
      if (learningRemoved) memberChanges.push(`${name}: ${learningRemoved} mod-only learning entries removed`)
      else if (learningTrimmed) memberChanges.push(`${name}: empty mod-only learning slots removed`)
      const jp = object(member.value.JP, 'JP')
      const jpEntries = array(jp.value.Entries, 'JP entries')
      const retainedJp = jpEntries.filter(entry => {
        const job = object(entry, 'JP entry').value.Job
        return job?.type !== 'null' && nativeCatalog.records.job.has(number(job, 'JP class'))
      })
      if (retainedJp.length !== jpEntries.length) { nonNativeState = true; jp.value.Entries = list(retainedJp); memberChanges.push(`${name}: ${jpEntries.length - retainedJp.length} mod-only JP entries removed`) }
      const passiveState = object(member.value.Passives, 'Equipped passives')
      const passiveIds = numbers(passiveState.value.Passives, 'Equipped passive IDs')
      const retainedPassives = passiveIds.filter(id => nativeCatalog.records.passive.has(id))
      if (retainedPassives.length !== passiveIds.length) { nonNativeState = true; memberChanges.push(`${name}: ${passiveIds.length - retainedPassives.length} equipped mod-only passives removed`) }
      const passiveCost = retainedPassives.reduce((sum, id) => sum + Number(nativeCatalog.records.passive.get(id)?.PP), 0)
      if (!Number.isSafeInteger(passiveCost) || passiveCost > PASSIVE_POINT_BUDGET) blockers.push(`${name} has a native passive loadout above the ${PASSIVE_POINT_BUDGET} point limit`)
      passiveState.value.Passives = list(retainedPassives.map(int))
      passiveState.value.CurrentPP = int(PASSIVE_POINT_BUDGET - passiveCost)
      const equipment = array(member.value.Equipment, 'Equipment')
      let equipmentRemoved = 0
      for (const [slot, value] of equipment.entries()) if (value.type !== 'null' && !nativeCatalog.records.equipment.has(number(value, 'Equipped ID'))) { equipment[slot] = { type: 'null' }; equipmentRemoved++ }
      if (equipmentRemoved) { nonNativeState = true; memberChanges.push(`${name}: ${equipmentRemoved} equipped mod-only items removed`) }
      const auto = member.value.AutoAbilityID
      if (auto && auto.type !== 'null' && !nativeCatalog.records.ability.has(number(auto, 'Automatic ability'))) { nonNativeState = true; member.value.AutoAbilityID = { type: 'null' }; memberChanges.push(`${name}: mod-only automatic ability removed`) }
    } catch (error) { blockers.push(error instanceof Error ? error.message : `${name} could not be converted`) }
  }
  changes.push(...memberChanges)

  try {
    for (const kind of ['item', 'equipment'] as const) {
      const values = stock(save, kind)
      const retained = values.filter(entry => nativeCatalog.records[kind].has(stockId(entry, kind)))
      if (retained.length !== values.length) { nonNativeState = true; object(save.party.value[kind === 'item' ? 'Items' : 'Equipment'], kind).value.Stock = list(retained); changes.push(`${values.length - retained.length} mod-only ${kind} stock entries removed`) }
    }
    for (const kind of ['item', 'equipment'] as const) for (const entry of stock(save, kind)) {
      const id = stockId(entry, kind)
      const count = stockCount(entry)
      const maximum = capacity(save, nativeCatalog, kind, id)
      if (count > maximum) { object(entry, 'Stock entry').value.Count = int(maximum); changes.push(`${kind} ${id} stock reduced from ${count} to native limit ${maximum}`) }
    }
    updateTreasureFinder(save, nativeCatalog)
  } catch (error) { blockers.push(error instanceof Error ? error.message : 'Inventory could not be converted') }

  try {
    const atlasDocument = save.party.value.Atlas
    if (atlasDocument) {
      const atlasValue = object(atlasDocument, 'Atlas').value
      for (const [field, family] of [['Jobs', 'job'], ['Abilities', 'ability'], ['Passives', 'passive'], ['Items', 'item'], ['Equipment', 'equipment']] as const) {
        const section = atlasValue[field]
        if (!section) continue
        const entries = array(object(section, `Atlas ${field}`).value.Entries, `Atlas ${field} entries`)
        const bound = nativeBound(nativeCatalog, family)
        let changed = false
        for (let id = 0; id < Math.min(entries.length, bound); id++) if (!nativeCatalog.records[family].has(id)) { entries[id] = neutralAtlasEntry(id); changed = true }
        if (entries.length > bound) { entries.splice(bound); changed = true }
        if (changed) { nonNativeState = true; changes.push(`Mod-only ${field.toLocaleLowerCase()} atlas entries removed`) }
      }
    }
    const mapping = save.party.value.RandomizerMapping
    if (mapping) {
      const mappingValue = object(mapping, 'Randomizer mapping').value
      for (const [field, family] of [['AbilityJobs', 'ability'], ['AbilityMonsters', 'ability'], ['Equipment', 'equipment'], ['Items', 'item'], ['Jobs', 'job'], ['Passives', 'passive']] as const) {
        const existing = mappingValue[field]
        if (!existing) continue
        const values = array(existing, `${field} mapping`)
        const identity = Array.from({ length: nativeBound(nativeCatalog, family) }, (_, id) => id)
        if (!sameNumberList(values, identity) && (headerState || bodyState || nonNativeState)) { mappingValue[field] = list(identity.map(int)); changes.push(`${field} mapping restored to native identities`) }
      }
    }
  } catch (error) { blockers.push(error instanceof Error ? error.message : 'Indexed save records could not be converted') }

  if (headerState || bodyState) {
    save.header.isModded = false
    save.header.mods = []
    save.header.modIdMaps = []
    mods.value.IsModded = { type: 'boolean', value: false }
    mods.value.Mods = list([])
    mods.value.Redirects = list([])
    changes.push('Saved mod flags, active list, and ID redirects cleared')
  }
  const relevant = headerState || bodyState || nonNativeState
  if (!relevant) return { relevant: false, convertible: false, changes: [], blockers: [] }
  if (!blockers.length && relevant) {
    try {
      validate(save, nativeCatalog)
      validate(decodeCrystalSave(encodeCrystalSave(save)), nativeCatalog)
    } catch (error) { blockers.push(`Converted save is not valid against native definitions: ${error instanceof Error ? error.message : 'unsupported save data'}`) }
  }
  return { relevant, convertible: relevant && blockers.length === 0, changes: [...new Set(changes)], blockers: [...new Set(blockers)], ...(relevant && !blockers.length ? { draft: save } : {}) }
}

export function saveEditorChoices(catalog: SaveEditorCatalog): { jobs: SaveEditorChoice[]; items: SaveEditorChoice[]; equipment: SaveEditorChoice[] } {
  const choices = (family: Family): SaveEditorChoice[] => [...catalog.records[family]].filter(([, value]) => typeof value.Name === 'string' && !DEBUG_NAME.test(value.Name) && !value.Name.startsWith('Cinema')).map(([id, value]) => ({ id, name: String(value.Name) })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  return { jobs: choices('job'), items: choices('item'), equipment: choices('equipment') }
}

function validate(save: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): ValidatedSaveEditor {
  if (!isSupportedCrystalSaveVersion(save.header.version)) throw new Error('Unsupported save format')
  if (save.header.isDemo || save.header.isHardcoreDefeat) throw new Error('Demo and defeated hardcore saves are read-only')
  saveEditorMode(save, nativeCatalog)
  const mods = partyModDocument(save)
  const bodyMods = partyModList(mods)
  const bodyMaps = partyModMaps(mods)
  if (flag(mods.value.IsModded) !== save.header.isModded || !sameModList(save.header.mods, bodyMods) || !sameModMaps(save.header.modIdMaps, bodyMaps)) throw new Error('Header and party mod metadata disagree')
  const resolution = resolveSaveEditorMods(save, nativeCatalog, modSources)
  if (resolution.issues.length) throw new Error(resolution.issues[0])
  if (!save.header.mods.length && resolution.hasHeaderModState) throw new Error('Disabled mod state must be removed before editing')
  if (save.header.mods.length && !save.header.isModded) throw new Error('Active mods require the save modded flag')
  const catalog = resolution.catalog
  const randomizer = readRandomizerState(save, catalog)
  const currency = number(object(save.party.value.Currency, 'Currency').value.Val, 'Currency')
  bound(currency, 0, SAVE_EDITOR_MAX_CURRENCY, 'Currency')
  if (currency !== save.header.currencyAmount) throw new Error('Header currency disagrees with party currency')
  const gameplay = flags(save).value
  if (flag(gameplay.MaxLevelUp) && (flag(gameplay.NoAssistOptions) || flag(gameplay.MaxLevelDown))) throw new Error('Conflicting level assist and challenge settings are read-only')
  if (flag(gameplay.MaxLevelUp)) bound(number(gameplay.MaxLevelUpVal, 'Level cap'), DEFAULT_LEVEL_CAP, SAVE_EDITOR_MAX_LEVEL, 'Level assist cap')
  if (flag(gameplay.MaxLevelDown)) bound(number(gameplay.MaxLevelDownVal, 'Level limit'), 1, DEFAULT_LEVEL_CAP, 'Challenge level cap')
  if (save.header.version >= LEGACY_HEADER.flags && Boolean(save.header.assistFlags & LEVEL_ASSIST_FLAG) !== flag(gameplay.MaxLevelUp)) throw new Error('Header level assist disagrees with party settings')
  bound(levelCap(save), 1, SAVE_EDITOR_MAX_LEVEL, 'Level cap')
  if (save.members.length !== save.header.members.length) throw new Error('Party and header member counts disagree')
  for (const [index, member] of save.members.entries()) {
    const v = member.value
    const header = save.header.members[index]!
    const levels = object(v.Levels, 'Levels')
    const level = number(levels.value.Level, 'Level')
    bound(level, 1, SAVE_EDITOR_MAX_LEVEL, 'Level')
    const growth = numbers(levels.value.Entries, 'Growth levels')
    const history = growthHistory(levels, save)
    if (growth.some(value => value < 0) || growth.reduce((sum, value) => sum + value, 0) !== level) throw new Error('Growth levels do not match character level')
    growth.forEach((value, id) => { if (value > 0) known(catalog, 'job', id) })
    if (history.length < growth.length || history.some((value, id) => value < (growth[id] ?? 0))) throw new Error('Growth history is inconsistent')
    known(catalog, 'job', number(v.Job, 'Job'))
    known(catalog, 'job', growthJob(member, save))
    const secondary = subJob(member, save)
    if (secondary !== null) known(catalog, 'job', secondary)
    known(catalog, 'gender', number(v.Gender, 'Gender'))
    if (header.name !== string(v.Name, 'Name') || header.level !== level || header.jobId !== number(v.Job, 'Job') || header.genderId !== number(v.Gender, 'Gender') || header.isPresent !== flag(v.IsPresent)) throw new Error(`Member ${index + 1} disagrees with its header`)
    for (const [field, family] of [['LearnedJobs', 'job'], ['LearnedAbilities', 'ability'], ['LearnedPassives', 'passive']] as const) numbers(v[field], field).forEach((state, id) => { bound(state, 0, LEARNED.learned, field); if (state > 0) known(catalog, family, id) })
    for (const equipment of array(v.Equipment, 'Equipment')) if (equipment.type !== 'null') known(catalog, 'equipment', number(equipment, 'Equipped ID'))
    const passives = object(v.Passives, 'Equipped passives')
    const passiveIds = numbers(passives.value.Passives, 'Equipped passive IDs')
    if (new Set(passiveIds).size !== passiveIds.length) throw new Error('Equipped passive IDs are duplicated')
    const passiveCost = passiveIds.reduce((sum, id) => sum + Number(known(catalog, 'passive', id).PP), 0)
    if (!Number.isSafeInteger(passiveCost) || passiveCost > PASSIVE_POINT_BUDGET || number(passives.value.CurrentPP, 'Available PP') !== PASSIVE_POINT_BUDGET - passiveCost) throw new Error('Equipped passive point accounting is inconsistent')
    const jp = object(v.JP, 'JP')
    for (const entry of array(jp.value.Entries, 'JP entries')) { const item = object(entry, 'JP entry'); known(catalog, 'job', number(item.value.Job, 'JP class')); bound(number(item.value.Current, 'Current JP'), 0, MAX_JP, 'Current JP'); bound(number(item.value.Total, 'Total JP'), 0, MAX_JP, 'Total JP') }
  }
  for (const kind of ['item', 'equipment'] as const) {
    const seen = new Set<number>()
    for (const entry of stock(save, kind)) {
      const id = stockId(entry, kind)
      known(catalog, kind, id)
      if (seen.has(id)) throw new Error(`Duplicate ${kind} stock ID ${id}`)
      seen.add(id)
      bound(stockCount(entry), 0, capacity(save, catalog, kind, id), `${kind} ${id} quantity`)
    }
  }
  return { catalog, randomizer }
}

export function inspectSave(save: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): SaveEditorSummary {
  const resolution = resolveSaveEditorMods(save, nativeCatalog, modSources)
  const catalog = resolution.catalog
  const summary: SaveEditorSummary = { editable: false, issues: [], mode: catalog.mode, randomized: randomizerStateHint(save), currency: save.header.currencyAmount, members: [], inventory: [], levelCap: DEFAULT_LEVEL_CAP, assistEnabled: false }
  try { const validated = validate(save, nativeCatalog, modSources); summary.editable = true; summary.randomized = validated.randomizer.enabled } catch (error) { summary.issues.push(error instanceof Error ? error.message : 'Unsupported save data') }
  try {
    summary.levelCap = levelCap(save)
    summary.assistEnabled = flag(flags(save).value.MaxLevelUp)
    summary.members = save.members.map((member, index) => {
      const jobs = numbers(member.value.LearnedJobs, 'LearnedJobs')
      const passives = numbers(member.value.LearnedPassives, 'LearnedPassives')
      return { index, name: string(member.value.Name, 'Name'), level: number(object(member.value.Levels, 'Levels').value.Level, 'Level'), jobId: number(member.value.Job, 'Job'), subJobId: subJob(member, save), growthJobId: growthJob(member, save), equipmentIds: array(member.value.Equipment, 'Equipment').map(value => value.type === 'null' ? null : number(value, 'Equipped ID')), passiveIds: numbers(object(member.value.Passives, 'Equipped passives').value.Passives, 'Equipped passive IDs'), unlockedJobIds: jobs.flatMap((state, id) => state > 0 ? [id] : []), learnedPassiveIds: passives.flatMap((state, id) => state === LEARNED.learned ? [id] : []), unlockedJobs: jobs.filter(value => value > 0).length, masteredJobs: jobs.filter(value => value === LEARNED.learned).length, learnedAbilities: numbers(member.value.LearnedAbilities, 'LearnedAbilities').filter(value => value === LEARNED.learned).length, learnedPassives: passives.filter(value => value === LEARNED.learned).length }
    })
    const choices = saveEditorChoices(catalog)
    summary.inventory = (['item', 'equipment'] as const).flatMap(kind => {
      const entries = new Map((kind === 'item' ? choices.items : choices.equipment).map(choice => [choice.id, choice]))
      for (const value of stock(save, kind)) { const id = stockId(value, kind); if (!entries.has(id)) entries.set(id, { id, name: String(catalog.records[kind].get(id)?.Name ?? `Unknown ${kind} #${id}`) }) }
      return [...entries.values()].map(choice => ({ ...choice, kind, count: quantity(save, kind, choice.id), capacity: catalog.records[kind].has(choice.id) ? capacity(save, catalog, kind, choice.id) : 0, equipped: kind === 'equipment' ? equippedCount(save, choice.id) : 0 }))
    })
  } catch (error) { if (!summary.issues.length) summary.issues.push(error instanceof Error ? error.message : 'Unsupported save data'); summary.editable = false }
  return summary
}

function setStock(save: CrystalSave, kind: SaveInventoryKind, id: number, count: number): void {
  const values = stock(save, kind)
  const index = values.findIndex(entry => stockId(entry, kind) === id)
  if (index >= 0) {
    if (count === 0) values.splice(index, 1)
    else object(values[index], 'Stock entry').value.Count = int(count)
  } else if (count > 0) values.push(document({ [kind === 'item' ? 'Item' : 'Equipment']: int(id), Count: int(count) }))
}
function updateTreasureFinder(save: CrystalSave, catalog: SaveEditorCatalog): void {
  object(save.party.value.Items, 'Items').value.TF = { type: 'boolean', value: stock(save, 'item').some(entry => stockCount(entry) > 0 && ((Number(catalog.records.item.get(stockId(entry, 'item'))?.SpecialBonus) || 0) & TREASURE_FINDER_BONUS) !== 0) }
}
function atlas(save: CrystalSave, family: 'Jobs' | 'Abilities' | 'Passives' | 'Items' | 'Equipment', id: number, state: number, now: Date): void {
  if (save.header.version < CRYSTAL_SAVE_VERSION) {
    save.party.value.Atlas ??= document({})
    object(save.party.value.Atlas, 'Atlas').value[family] ??= document({ Entries: list([]) })
  }
  const entries = array(object(object(save.party.value.Atlas, 'Atlas').value[family], `Atlas ${family}`).value.Entries, 'Atlas entries')
  while (entries.length <= id) entries.push(document({ ID: int(entries.length), S: int(0), HT: { type: 'datetime', value: EMPTY_DATE }, ST: { type: 'datetime', value: EMPTY_DATE }, AT: { type: 'datetime', value: EMPTY_DATE }, PT: { type: 'datetime', value: EMPTY_DATE }, BF: int(0) }))
  const entry = object(entries[id], 'Atlas entry')
  if (number(entry.value.ID, 'Atlas ID') !== id) throw new Error('Atlas entry identity does not match its position')
  if (number(entry.value.S, 'Atlas state') < state) {
    entry.value.S = int(state)
    entry.value[state === ATLAS.acquired ? 'AT' : 'ST'] = { type: 'datetime', value: BigInt(now.getTime()) }
  }
}
function learn(save: CrystalSave, member: BsonDocument, field: 'LearnedJobs' | 'LearnedAbilities' | 'LearnedPassives', id: number, state: number, now: Date): void {
  const values = array(member.value[field], field)
  while (values.length <= id) values.push(int(LEARNED.locked))
  if (number(values[id], field) < state) values[id] = int(state)
  atlas(save, field === 'LearnedJobs' ? 'Jobs' : field === 'LearnedAbilities' ? 'Abilities' : 'Passives', id, state === LEARNED.learned ? ATLAS.acquired : ATLAS.seen, now)
}
function nativeIds(record: NativeRecord, field: string): number[] { const value = record[field]; return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [] }
function treeNodes(value: unknown): { type: number; id: number }[] {
  if (Array.isArray(value)) return value.flatMap(treeNodes)
  if (value && typeof value === 'object' && 'NodeType' in value && 'DataID' in value && typeof value.NodeType === 'number' && typeof value.DataID === 'number') return [{ type: value.NodeType, id: value.DataID }]
  return []
}
function learnJobs(save: CrystalSave, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, master: boolean, now: Date): void {
  for (const member of save.members) {
    for (const [id, job] of catalog.records.job) {
      learn(save, member, 'LearnedJobs', id, master ? LEARNED.learned : LEARNED.unlocked, now)
      const abilityIds = new Set([...nativeIds(job, 'AbilityIDs'), ...(master ? treeNodes(job.LearnTree).filter(node => node.type === LEARN_NODE.ability).map(node => node.id) : [])].map(id => randomizedId(randomizer, 'AbilityJobs', id)))
      for (const abilityId of abilityIds) { const ability = known(catalog, 'ability', abilityId); if (master || !ability.IsDefaultLocked) learn(save, member, 'LearnedAbilities', abilityId, master || ability.JP === 0 ? LEARNED.learned : LEARNED.unlocked, now) }
      for (const sourceId of nativeIds(job, 'PassiveIDs')) { const passiveId = randomizedId(randomizer, 'Passives', sourceId); const passive = known(catalog, 'passive', passiveId); if (master || !passive.IsDefaultLocked) learn(save, member, 'LearnedPassives', passiveId, passive.IsLearnable && (master || passive.JP === 0) ? LEARNED.learned : LEARNED.unlocked, now) }
    }
    if (master) {
      const passives = new Set([...catalog.records.passive].filter(([, passive]) => passive.IsLearnable).map(([id]) => id))
      for (const job of catalog.records.job.values()) for (const node of treeNodes(job.LearnTree)) if (node.type === LEARN_NODE.passive) passives.add(randomizedId(randomizer, 'Passives', node.id))
      for (const id of passives) learn(save, member, 'LearnedPassives', id, LEARNED.learned, now)
      const jp = object(member.value.JP, 'JP')
      const entries = array(jp.value.Entries, 'JP entries')
      for (const id of catalog.records.job.keys()) {
        const entry = entries.find(value => number(object(value, 'JP entry').value.Job, 'JP class') === id)
        if (entry) { const value = object(entry, 'JP entry').value; value.Current = int(MAX_JP); value.Total = int(MAX_JP) }
        else entries.push(document({ Job: int(id), Current: int(MAX_JP), Total: int(MAX_JP) }))
      }
      jp.value.TotalJP = int(Math.max(number(jp.value.TotalJP ?? (save.header.version < CRYSTAL_SAVE_VERSION ? int(0) : undefined), 'Lifetime JP'), catalog.records.job.size * MAX_JP))
    }
  }
}

const EXP_STEPS = [[3, 50], [5, 60], [10, 80], [20, 100], [28, 150], [34, 100], [40, 150], [59, 200], [69, 100], [79, 200], [89, 450], [94, 500], [99, 1000]] as const
const EXP_BONUSES: Readonly<Record<number, number>> = { 5: 100, 10: 30, 35: 150, 50: 50, 59: 400, 79: 500, 89: 500, 98: 1000 }
function totalExperience(level: number): number {
  let requirement = 100
  let total = 0
  for (let index = 0; index < level; index++) { if (index > 0) requirement += EXP_STEPS.find(([maximum]) => index <= maximum)![1] + (EXP_BONUSES[index] ?? 0); total += requirement }
  return total
}
function setLevel(save: CrystalSave, catalog: SaveEditorCatalog, index: number, level: number, now: Date): void {
  bound(level, 1, SAVE_EDITOR_MAX_LEVEL, 'Level')
  const member = save.members[index]!
  const gameplay = flags(save)
  const values = gameplay.value
  if (level > levelCap(save)) {
    if (flag(values.NoAssistOptions) || flag(values.MaxLevelDown)) throw new Error('This challenge prevents raising the level cap')
    save.party.value.GameplayFlags ??= gameplay
    values.MaxLevelUp = { type: 'boolean', value: true }
    values.MaxLevelUpVal = int(level)
    values.MaxLevelUpTS = save.party.value.PlayTime!
    values.MaxLevelUpDT = { type: 'datetime', value: BigInt(now.getTime()) }
    if (save.header.version >= LEGACY_HEADER.flags) save.header.assistFlags |= LEVEL_ASSIST_FLAG
    for (const entry of save.members) { const levels = object(entry.value.Levels, 'Levels'); levels.value.MaxLevel = int(Math.max(level, number(levels.value.Level, 'Level'))) }
  }
  const levels = object(member.value.Levels, 'Levels')
  const growth = numbers(levels.value.Entries, 'Growth')
  const oldLevel = number(levels.value.Level, 'Level')
  const job = growthJob(member, save)
  while (growth.length <= job) growth.push(0)
  if (level >= oldLevel) growth[job] = (growth[job] ?? 0) + level - oldLevel
  else for (let remaining = oldLevel - level; remaining > 0; remaining--) {
    const candidates = growth.map((count, id) => ({ count, id })).filter(entry => entry.count > 0).sort((a, b) => a.count - b.count || Number(known(catalog, 'job', b.id).SortOrder) - Number(known(catalog, 'job', a.id).SortOrder))
    growth[candidates[0]!.id]!--
  }
  const history = growthHistory(levels, save)
  levels.value.Entries = list(growth.map(int))
  levels.value.Hist = list(Array.from({ length: Math.max(growth.length, history.length) }, (_, id) => int(Math.max(history[id] ?? 0, growth[id] ?? 0))))
  levels.value.Level = int(level)
  levels.value.MaxLevel = int(Math.max(levelCap(save), level))
  levels.value.Exp = int(0)
  levels.value.TotExp = int(Math.max(number(levels.value.TotExp ?? (save.header.version < CRYSTAL_SAVE_VERSION ? int(0) : undefined), 'Lifetime experience'), totalExperience(level)))
  save.header.members[index]!.level = level
}
function unequip(save: CrystalSave, member: BsonDocument): void {
  const equipped = array(member.value.Equipment, 'Equipment')
  for (const [index, value] of equipped.entries()) if (value.type !== 'null') { const id = number(value, 'Equipped ID'); setStock(save, 'equipment', id, quantity(save, 'equipment', id) + 1); equipped[index] = { type: 'null' } }
}

function normalizeClassLoadout(member: BsonDocument, save: CrystalSave, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, mainChanged: boolean): void {
  const job = known(catalog, 'job', number(member.value.Job, 'Job'))
  if (mainChanged) {
    const passives = object(member.value.Passives, 'Passives')
    const jobPassives = new Set(nativeIds(job, 'PassiveIDs').map(id => randomizedId(randomizer, 'Passives', id)))
    const jobEquipment = new Set(nativeIds(job, 'EquipmentTypes'))
    const retained = numbers(passives.value.Passives, 'Equipped passives').filter(id => {
      const passive = known(catalog, 'passive', id)
      if (Number(passive.PP) <= 0) return true
      if (passive.IsInnate && jobPassives.has(id)) return false
      const mods = Array.isArray(passive.StatMods) ? passive.StatMods : []
      const enabled = mods.flatMap(mod => mod && typeof mod === 'object' && !Array.isArray(mod) && mod.Tag === ENABLE_EQUIPMENT_TYPE && typeof mod.Value1 === 'number' ? [mod.Value1] : [])
      return !enabled.length || !enabled.every(type => jobEquipment.has(type))
    })
    passives.value.Passives = list(retained.map(int))
    passives.value.CurrentPP = int(PASSIVE_POINT_BUDGET - retained.reduce((sum, id) => sum + Number(known(catalog, 'passive', id).PP), 0))
  }
  if (member.value.AutoAbilityID && member.value.AutoAbilityID.type !== 'null') {
    const id = number(member.value.AutoAbilityID, 'Automatic ability')
    const secondary = subJob(member, save)
    const commands = [...nativeIds(job, 'AbilityIDs'), ...(secondary === null ? [] : nativeIds(known(catalog, 'job', secondary), 'AbilityIDs'))].map(command => randomizedId(randomizer, 'AbilityJobs', command))
    if (!commands.includes(id) || (numbers(member.value.LearnedAbilities, 'LearnedAbilities')[id] ?? 0) < LEARNED.learned) member.value.AutoAbilityID = { type: 'null' }
  }
}

function statModifierTags(record: NativeRecord): readonly number[] {
  return Array.isArray(record.StatMods) ? record.StatMods.flatMap(modifier => modifier && typeof modifier === 'object' && !Array.isArray(modifier) && typeof modifier.Tag === 'number' ? [modifier.Tag] : []) : []
}

function applyLoadout(save: CrystalSave, member: BsonDocument, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, command: Extract<SaveEditCommand, { type: 'loadout' }>): void {
  const equipped = array(member.value.Equipment, 'Equipment')
  if (command.equipmentIds.length !== equipped.length) throw new Error(`A loadout needs exactly ${equipped.length} equipment slots`)
  if (new Set(command.passiveIds).size !== command.passiveIds.length) throw new Error('A loadout cannot equip the same passive twice')
  const learnedPassives = numbers(member.value.LearnedPassives, 'LearnedPassives')
  const passiveRecords = command.passiveIds.map(id => {
    const passive = known(catalog, 'passive', id)
    if ((learnedPassives[id] ?? LEARNED.locked) !== LEARNED.learned) throw new Error(`${String(passive.Name ?? `Passive ${id}`)} has not been learned by this member`)
    if (passive.IsLearnable === false) throw new Error(`${String(passive.Name ?? `Passive ${id}`)} cannot be equipped as a learned passive`)
    return passive
  })
  const passiveCost = passiveRecords.reduce((sum, passive) => sum + Number(passive.PP), 0)
  if (!Number.isSafeInteger(passiveCost) || passiveCost > PASSIVE_POINT_BUDGET) throw new Error(`Equipped passives exceed the ${PASSIVE_POINT_BUDGET} PP limit`)
  const job = known(catalog, 'job', number(member.value.Job, 'Job'))
  const innatePassives = nativeIds(job, 'PassiveIDs').map(id => randomizedId(randomizer, 'Passives', id)).flatMap(id => {
    const passive = catalog.records.passive.get(id)
    return passive?.IsInnate ? [passive] : []
  })
  const permissionRecords = [...passiveRecords, ...innatePassives]
  const equipmentTypes = new Set(nativeIds(job, 'EquipmentTypes'))
  for (const passive of permissionRecords) for (const modifier of Array.isArray(passive.StatMods) ? passive.StatMods : []) {
    if (modifier && typeof modifier === 'object' && !Array.isArray(modifier) && modifier.Tag === ENABLE_EQUIPMENT_TYPE && typeof modifier.Value1 === 'number') equipmentTypes.add(modifier.Value1)
  }
  const dualWield = permissionRecords.some(passive => statModifierTags(passive).includes(DUAL_WIELD))
  const requested = command.equipmentIds.map((id, index) => {
    if (id === null) return null
    const equipment = known(catalog, 'equipment', id)
    const type = Number(equipment.EquipmentType)
    const fitsSlot = index <= 1 ? type <= 11 : index === 2 ? type >= 12 && type <= 14 : index === 3 ? type >= 15 && type <= 17 : type === 18
    if (!fitsSlot) throw new Error(`${String(equipment.Name ?? `Equipment ${id}`)} does not fit ${['main hand', 'off hand', 'head', 'body', 'accessory 1', 'accessory 2'][index]}`)
    if (!equipmentTypes.has(type)) throw new Error(`${String(job.Name ?? 'This class')} cannot equip ${String(equipment.Name ?? `equipment ${id}`)}`)
    if (index === 1 && type <= 10 && !dualWield) throw new Error(`${String(equipment.Name ?? `Equipment ${id}`)} requires Dual Wield in the off hand`)
    return equipment
  })
  const counts = new Map<number, number>()
  if ((requested[0]?.IsTwoHanded === true && requested[1]) || (requested[1]?.IsTwoHanded === true && requested[0])) throw new Error('A two-handed weapon requires the other hand to stay empty')
  for (const [index, id] of command.equipmentIds.entries()) if (id !== null) {
    const next = (counts.get(id) ?? 0) + 1
    counts.set(id, next)
    if (requested[index]?.IsOneOnly && next > 1) throw new Error(`${String(requested[index]?.Name ?? `Equipment ${id}`)} can only be equipped once`)
  }
  unequip(save, member)
  for (const [id, count] of counts) if (quantity(save, 'equipment', id) < count) throw new Error(`Inventory needs ${count} ${String(catalog.records.equipment.get(id)?.Name ?? `equipment ${id}`)} for this loadout`)
  for (const [id, count] of counts) setStock(save, 'equipment', id, quantity(save, 'equipment', id) - count)
  member.value.Equipment = list(command.equipmentIds.map(id => id === null ? { type: 'null' } : int(id)))
  const passives = object(member.value.Passives, 'Passives')
  passives.value.Passives = list(command.passiveIds.map(int))
  passives.value.CurrentPP = int(PASSIVE_POINT_BUDGET - passiveCost)
}

export function editSave(input: CrystalSave, nativeCatalog: SaveEditorCatalog, command: SaveEditCommand, now = new Date(), modSources: readonly SaveEditorModSource[] = []): CrystalSave {
  const { catalog, randomizer } = validate(input, nativeCatalog, modSources)
  if (!Number.isFinite(now.getTime())) throw new Error('Edit timestamp is invalid')
  const save = structuredClone(input)
  if (command.type === 'currency' || command.type === 'overpowered') {
    const value = command.type === 'currency' ? command.value : SAVE_EDITOR_MAX_CURRENCY
    bound(value, 0, SAVE_EDITOR_MAX_CURRENCY, 'Currency')
    object(save.party.value.Currency, 'Currency').value.Val = int(value)
    save.header.currencyAmount = value
  }
  if (command.type === 'member' || command.type === 'loadout') {
    bound(command.index, 0, save.members.length - 1, 'Member index')
    const member = save.members[command.index]!
    let mainChanged = false
    let classChanged = false
    if (command.type === 'member' && command.name !== undefined) {
      if (!command.name.trim() || [...command.name].length > 32 || /[\u0000-\u001f\u007f]/.test(command.name)) throw new Error('Names need 1 to 32 characters without control characters')
      member.value.Name = text(command.name)
      save.header.members[command.index]!.name = command.name
    }
    if (command.type === 'member' && command.level !== undefined && command.level !== number(object(member.value.Levels, 'Levels').value.Level, 'Level')) setLevel(save, catalog, command.index, command.level, now)
    for (const [field, id] of [['Job', command.jobId], ['SubJob', command.subJobId]] as const) if (id !== undefined) {
      const previous = field === 'SubJob' ? subJob(member, save) : number(member.value.Job, 'Job')
      if (id === previous) continue
      if (field === 'Job' && flag(flags(save).value.NoJobChange) || field === 'SubJob' && flag(flags(save).value.NoSubJob)) throw new Error('This challenge prevents that class change')
      if (id !== null) {
        const job = known(catalog, 'job', id)
        if (field === 'Job' ? job.IsUnselectableJob : job.IsUnselectableSubJob) throw new Error('That class cannot be selected in this slot')
        if ((numbers(member.value.LearnedJobs, 'LearnedJobs')[id] ?? 0) < LEARNED.unlocked) throw new Error('Unlock this class before selecting it')
        if (field === 'SubJob' && id === number(member.value.Job, 'Job')) throw new Error('Subclass must differ from the main class')
      }
      if (field === 'Job' && id !== number(member.value.Job, 'Job')) {
        mainChanged = true
        member.value.Growth = int(id!)
        if (subJob(member, save) === id) member.value.SubJob = { type: 'null' }
        save.header.members[command.index]!.jobId = id!
      }
      member.value[field] = id === null ? { type: 'null' } : int(id)
      classChanged = true
    }
    if (classChanged) {
      if (command.type === 'member') unequip(save, member)
      normalizeClassLoadout(member, save, catalog, randomizer, mainChanged)
    }
    if (command.type === 'loadout') applyLoadout(save, member, catalog, randomizer, command)
  }
  if (command.type === 'stock') {
    known(catalog, command.kind, command.id)
    bound(command.count, 0, capacity(save, catalog, command.kind, command.id), 'Quantity')
    setStock(save, command.kind, command.id, command.count)
    if (command.count > 0) atlas(save, command.kind === 'item' ? 'Items' : 'Equipment', command.id, ATLAS.acquired, now)
    updateTreasureFinder(save, catalog)
  }
  if (command.type === 'unlock-jobs' || command.type === 'master-jobs' || command.type === 'overpowered') learnJobs(save, catalog, randomizer, command.type !== 'unlock-jobs', now)
  if (command.type === 'overpowered') {
    for (const [index] of save.members.entries()) setLevel(save, catalog, index, SAVE_EDITOR_MAX_LEVEL, now)
    const choices = saveEditorChoices(catalog)
    const selectedItems = choices.items.filter(({ id }) => { const item = known(catalog, 'item', id); return item.IsConsumable || item.IsCombat || item.AbilityID !== null && item.AbilityID !== undefined || item.MapForBiomeID !== null && item.MapForBiomeID !== undefined || item.IncreaseMaxCapacityForItemID !== null && item.IncreaseMaxCapacityForItemID !== undefined || PRESET_TOOL_IDS.has(id) || PRESET_MATERIAL_IDS.has(id) })
    for (const { id } of selectedItems) { const target = known(catalog, 'item', id).IncreaseMaxCapacityForItemID; if (target !== null && target !== undefined) setStock(save, 'item', id, capacity(save, catalog, 'item', id)) }
    for (const { id } of selectedItems) {
      const item = known(catalog, 'item', id)
      const stack = item.IsConsumable || item.IsCombat || item.IncreaseMaxCapacityForItemID !== null && item.IncreaseMaxCapacityForItemID !== undefined || PRESET_MATERIAL_IDS.has(id)
      setStock(save, 'item', id, Math.max(quantity(save, 'item', id), stack ? capacity(save, catalog, 'item', id) : 1))
      atlas(save, 'Items', id, ATLAS.acquired, now)
    }
    for (const { id } of choices.equipment) { setStock(save, 'equipment', id, Math.max(quantity(save, 'equipment', id), Math.min(capacity(save, catalog, 'equipment', id), Math.max(0, PRESET_EQUIPMENT_COPIES - equippedCount(save, id))))); atlas(save, 'Equipment', id, ATLAS.acquired, now) }
    updateTreasureFinder(save, catalog)
  }
  if (command.type === 'reveal-maps') for (const map of save.maps) {
    map.data.fill(255)
    const remainder = map.lengthX * map.lengthY % 8
    if (remainder && map.data.length) map.data[map.data.length - 1] = (1 << remainder) - 1
  }
  validate(save, nativeCatalog, modSources)
  return save
}

export function previewSaveChanges(before: CrystalSave, after: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): string[] {
  const previousCatalog = resolveSaveEditorMods(before, nativeCatalog, modSources).catalog
  const nextCatalog = resolveSaveEditorMods(after, nativeCatalog, modSources).catalog
  const previous = inspectSave(before, nativeCatalog, modSources)
  const next = inspectSave(after, nativeCatalog, modSources)
  const result: string[] = []
  if (previous.currency !== next.currency) result.push(`Money: ${previous.currency.toLocaleString('en-US')} → ${next.currency.toLocaleString('en-US')} copper`)
  if (previous.levelCap !== next.levelCap) result.push(`Level cap: ${previous.levelCap} → ${next.levelCap}${next.assistEnabled ? ' (level-cap assist enabled)' : ''}`)
  for (const member of next.members) {
    const old = previous.members[member.index]
    if (!old) continue
    if (old.name !== member.name) result.push(`Member ${member.index + 1}: ${old.name} → ${member.name}`)
    if (old.level !== member.level) result.push(`${member.name}: level ${old.level} → ${member.level}; growth and experience updated`)
    if (old.jobId !== member.jobId) result.push(`${member.name}: class ${previousCatalog.records.job.get(old.jobId)?.Name ?? old.jobId} → ${nextCatalog.records.job.get(member.jobId)?.Name ?? member.jobId}; future growth follows the new class; equipment returned to inventory`)
    if (old.subJobId !== member.subJobId) result.push(`${member.name}: subclass ${old.subJobId === null ? 'None' : previousCatalog.records.job.get(old.subJobId)?.Name ?? old.subJobId} → ${member.subJobId === null ? 'None' : nextCatalog.records.job.get(member.subJobId)?.Name ?? member.subJobId}${old.jobId === member.jobId ? '; equipment returned to inventory' : ''}`)
    if (old.unlockedJobs !== member.unlockedJobs || old.masteredJobs !== member.masteredJobs || old.learnedAbilities !== member.learnedAbilities || old.learnedPassives !== member.learnedPassives) result.push(`${member.name}: ${member.unlockedJobs} classes unlocked, ${member.masteredJobs} mastered, ${member.learnedAbilities} abilities and ${member.learnedPassives} passives learned`)
    else if (['LearnedJobs', 'LearnedAbilities', 'LearnedPassives'].some(field => !sameBson(before.members[member.index]?.value[field], after.members[member.index]?.value[field]))) result.push(`${member.name}: ability and passive unlock states updated`)
    if (!sameBson(before.members[member.index]?.value.JP, after.members[member.index]?.value.JP)) result.push(`${member.name}: class JP updated`)
    if (old.level === member.level && !sameBson(before.members[member.index]?.value.Levels, after.members[member.index]?.value.Levels)) result.push(`${member.name}: growth and experience bookkeeping updated`)
    if (!sameBson(before.members[member.index]?.value.Passives, after.members[member.index]?.value.Passives)) result.push(`${member.name}: equipped passives and available points updated`)
    if (!sameBson(before.members[member.index]?.value.Equipment, after.members[member.index]?.value.Equipment)) result.push(`${member.name}: equipped loadout updated and inventory reconciled`)
    if (!sameBson(before.members[member.index]?.value.AutoAbilityID, after.members[member.index]?.value.AutoAbilityID)) result.push(`${member.name}: unavailable automatic ability cleared`)
  }
  for (const kind of ['item', 'equipment'] as const) {
    const old = new Map(previous.inventory.filter(row => row.kind === kind).map(row => [row.id, row.count]))
    const changed = next.inventory.filter(row => row.kind === kind && row.count !== (old.get(row.id) ?? 0))
    if (changed.length > 6) result.push(`${changed.length} ${kind === 'item' ? 'item' : 'equipment'} quantities changed`)
    else for (const row of changed) result.push(`${row.name}: ${old.get(row.id) ?? 0} → ${row.count} in inventory`)
  }
  const mapChanges = after.maps.filter((map, index) => map.data.some((value, byte) => value !== before.maps[index]?.data[byte])).length
  if (mapChanges) result.push(`${mapChanges} stored maps revealed`)
  if (!sameBson(before.party.value.Atlas, after.party.value.Atlas)) result.push('Atlas entries updated to match the edited inventory and learning')
  if (!sameBson(object(before.party.value.Items, 'Items').value.TF, object(after.party.value.Items, 'Items').value.TF)) result.push('Treasure Finder availability updated')
  if (before.header.isModded !== after.header.isModded || before.header.mods.length !== after.header.mods.length || before.header.modIdMaps.length !== after.header.modIdMaps.length) result.push('Saved mod flags, active list, and ID redirects updated')
  return result
}

function sameBson(left: BsonValue | undefined, right: BsonValue | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.type !== right.type) return false
  if (left.type === 'document' && right.type === 'document') {
    const keys = Object.keys(left.value)
    return keys.length === Object.keys(right.value).length && keys.every(key => Object.hasOwn(right.value, key) && sameBson(left.value[key], right.value[key]))
  }
  if (left.type === 'array' && right.type === 'array') return left.value.length === right.value.length && left.value.every((value, index) => sameBson(value, right.value[index]))
  if (left.type === 'opaque' && right.type === 'opaque') return left.bsonType === right.bsonType && left.value.length === right.value.length && left.value.every((value, index) => value === right.value[index])
  if (left.type === 'null' || right.type === 'null') return true
  return Object.is(left.value, right.value)
}
