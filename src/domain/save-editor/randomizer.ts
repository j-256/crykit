import { type NativeRecord } from '../native-game'
import { type CrystalSave, type BsonDocument } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { object, document, numbers } from './values.ts'
import { LEGACY_HEADER } from './model.ts'

const RANDOMIZER_HEADER_FLAGS = Object.freeze({ Crystals: 1, Monsters: 2, Items: 4, Equipment: 8, JobAbilities: 16, MonsterAbilities: 32, Passives: 64, InnatePassives: 128, TeleportPoints: 256, Music: 512, ProgressionGate: 1024, StartWithHomePointStone: 2048, StartWithTreasureFinder: 4096, StartWithAllMaps: 8192, MonsterDifficulties: 16384 })

const RANDOMIZER_BOOLEAN_FIELDS = ['Crystals', 'Monsters', 'MonstersScaled', 'Bosses', 'BossesScaled', 'Items', 'IncludeRecovery', 'IncludeQuest', 'IncludeProgression', 'ItemsScaled', 'Equipment', 'EquipmentScaled', 'JobAbilities', 'IncludeScholar', 'IncludeSummoner', 'JobAbilitiesUnrestricted', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music', 'ProgressionGate', 'StartWithHomePointStone', 'StartWithTreasureFinder', 'StartWithAllMaps', 'EnableSpoilerLog'] as const

const RANDOMIZER_PRIMARY_FIELDS = ['Crystals', 'Monsters', 'Bosses', 'Items', 'Equipment', 'JobAbilities', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music'] as const

const RANDOMIZER_TELEPORT_POINT_IDS = new Set([0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])

const RANDOMIZER_TRACK_CUE_IDS = new Set([...Array.from({ length: 5 }, (_, index) => index + 1), ...Array.from({ length: 23 }, (_, index) => index + 8), ...Array.from({ length: 43 }, (_, index) => index + 32), ...Array.from({ length: 7 }, (_, index) => index + 96)])

const RANDOMIZER_ENUM_BOUNDS = Object.freeze({ TeleportPoints: 32, Music: 103 })

type RandomizerBooleanField = typeof RANDOMIZER_BOOLEAN_FIELDS[number]

type RandomizerMappingField = 'AbilityJobs' | 'AbilityMonsters' | 'Equipment' | 'Items' | 'Jobs' | 'Passives' | 'Troops' | 'MonsterDifficulties' | 'TeleportPoints' | 'Music'

export interface SaveEditorRandomizerState { readonly enabled: boolean; readonly flags: Readonly<Record<RandomizerBooleanField, boolean>>; readonly mappings?: Readonly<Record<RandomizerMappingField, readonly number[]>> }

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

export function randomizerStateHint(save: CrystalSave): boolean {
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
      // Sparse native/mod ID holes are padding, so they cannot redirect into real records
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

export function readRandomizerState(save: CrystalSave, catalog: SaveEditorCatalog): SaveEditorRandomizerState {
  // The catalog already includes mode patches and exact mod redirects before mappings are checked
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

export function randomizedId(randomizer: SaveEditorRandomizerState, field: 'AbilityJobs' | 'Passives', id: number): number {
  // Resolve saved assignments without changing their seed or generating a replacement mapping
  return randomizer.mappings?.[field][id] ?? id
}
