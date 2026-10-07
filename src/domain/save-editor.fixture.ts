import type { BsonDocument, BsonValue, CrystalSave } from '../interchange/crystal-save'
import type { SaveEditorFamily, SaveEditorModSource } from './save-editor-mods'
import type { NativeRecord } from './native-game'

type SyntheticValue = null | boolean | number | bigint | string | SyntheticValue[] | { [key: string]: SyntheticValue }
function bson(value: SyntheticValue): BsonValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (typeof value === 'number') return { type: 'int32', value }
  if (typeof value === 'bigint') return { type: 'int64', value }
  if (Array.isArray(value)) return { type: 'array', value: value.map(bson) }
  return { type: 'document', value: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bson(entry)])) }
}

export function createSaveEditorFixture(version = 28): CrystalSave {
  const names = ['Alex', 'Blair', 'Casey', 'Drew']
  const members = names.map((name, index) => bson({
    Name: name, ID: index, IsPresent: true, Gender: 0, Job: 0, SubJob: 4, Growth: 0,
    Levels: { Entries: [5, ...Array<number>(23).fill(0)], Hist: [5, ...Array<number>(23).fill(0)], Level: 5, MaxLevel: 60, Exp: 0, TotExp: 1010 },
    JP: { Entries: Array.from({ length: 24 }, (_, Job) => ({ Job, Current: 0, Total: 0 })), TotalJP: 0 },
    LearnedJobs: Array.from({ length: 24 }, (_, id) => id === 0 || id === 4 ? 1 : 0),
    LearnedAbilities: Array<number>(508).fill(0), LearnedPassives: Array<number>(88).fill(0),
    Equipment: [0, null, null, null, null, null], Passives: { Passives: [], CurrentPP: 10 },
    HPCurrent: 100, MPCurrent: 20, APCurrent: 0, Cooldowns: [], Statuses: [],
    Info: { SyntheticHistory: 'Untouched' }, AutoAbilityID: null,
  }) as BsonDocument)
  const party = bson({
    Currency: { Val: 123 }, Items: { Stock: [{ Item: 0, Count: 2 }], TF: false }, Equipment: { Stock: [{ Equipment: 0, Count: 1 }] },
    GameplayFlags: { PatchMode: 0, MaxLevelUp: false, MaxLevelUpVal: 60, MaxLevelUpTS: '00:00:00', NoAssistOptions: false, MaxLevelDown: false, MaxLevelDownVal: 0, NoJobChange: false, NoSubJob: false, KeepEquipment: false, LimitlessEquipment: false },
    RandomizerFlags: { Seed: null, Crystals: false, Equipment: false }, Mods: { IsModded: false, Mods: [], Redirects: [] },
    PlayTime: '00:10:00', Difficulty: 2, HomePointName: 'Synthetic camp',
    Atlas: Object.fromEntries(['Jobs', 'Abilities', 'Passives', 'Items', 'Equipment'].map(key => [key, { Entries: [] }])),
    QuestState: { SyntheticQuest: 7 }, EntityVariables: { SyntheticEvent: 13 }, History: { SyntheticHistory: 'Untouched' },
  }) as BsonDocument
  party.value.SyntheticInt64 = { type: 'int64', value: 9_007_199_254_740_993n }
  return {
    originalBytes: new Uint8Array(),
    header: { version, isDemo: false, isHardcoreDefeat: false, playTime: { days: 0, hours: 0, minutes: 10, seconds: 0, milliseconds: 0 }, lastUpdated: version >= 28 ? { year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 } : null, homePointName: 'Synthetic camp', currencyAmount: 123, members: names.map(name => ({ isPresent: true, name, level: 5, genderId: 0, jobId: 0 })), difficultyId: version >= 12 ? 2 : -1, patchMode: 0, assistFlags: 0, challengeFlags: 0, randomizerFlags: 0, newGamePlusCount: 0, isModded: false, mods: [], modIdMaps: [] },
    party, members,
    maps: [{ id: 1, originX: -3, originY: 7, lengthX: 3, lengthY: 3, data: new Uint8Array([1, 0]) }],
    combatBytes: new Uint8Array(12),
  }
}

export function setSaveEditorFixtureMode(save: CrystalSave, patchMode: number): CrystalSave {
  save.header.patchMode = patchMode
  const gameplayFlags = save.party.value.GameplayFlags
  if (gameplayFlags?.type !== 'document') throw new Error('Synthetic save is missing gameplay flags')
  gameplayFlags.value.PatchMode = { type: 'int32', value: patchMode }
  return save
}

const RANDOMIZER_FIXTURE_HEADER_FLAGS = Object.freeze({ Crystals: 1, Monsters: 2, Items: 4, Equipment: 8, JobAbilities: 16, MonsterAbilities: 32, Passives: 64, InnatePassives: 128, TeleportPoints: 256, Music: 512, ProgressionGate: 1024, StartWithHomePointStone: 2048, StartWithTreasureFinder: 4096, StartWithAllMaps: 8192, MonsterDifficulties: 16384 })
const RANDOMIZER_FIXTURE_BOOLEAN_FIELDS = ['Crystals', 'Monsters', 'MonstersScaled', 'Bosses', 'BossesScaled', 'Items', 'IncludeRecovery', 'IncludeQuest', 'IncludeProgression', 'ItemsScaled', 'Equipment', 'EquipmentScaled', 'JobAbilities', 'IncludeScholar', 'IncludeSummoner', 'JobAbilitiesUnrestricted', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music', 'ProgressionGate', 'StartWithHomePointStone', 'StartWithTreasureFinder', 'StartWithAllMaps', 'EnableSpoilerLog'] as const
type RandomizerFixtureFlag = typeof RANDOMIZER_FIXTURE_BOOLEAN_FIELDS[number]
type RandomizerFixtureMapping = 'AbilityJobs' | 'AbilityMonsters' | 'Equipment' | 'Items' | 'Jobs' | 'Passives' | 'Troops' | 'MonsterDifficulties' | 'TeleportPoints' | 'Music'

export function setSaveEditorFixtureRandomizer(save: CrystalSave, options: { readonly flags?: Readonly<Partial<Record<RandomizerFixtureFlag, boolean>>>; readonly mappings?: Readonly<Partial<Record<RandomizerFixtureMapping, readonly number[]>>> } = {}): CrystalSave {
  const flags = Object.fromEntries(RANDOMIZER_FIXTURE_BOOLEAN_FIELDS.map(field => [field, options.flags?.[field] ?? false])) as Record<RandomizerFixtureFlag, boolean>
  const existing = save.party.value.RandomizerMapping?.type === 'document' ? save.party.value.RandomizerMapping.value : {}
  const identity = (field: RandomizerFixtureMapping, length: number): number[] => {
    const value = existing[field]
    if (value?.type === 'array') return value.value.map(entry => entry.type === 'int32' || entry.type === 'double' ? entry.value : -1)
    return Array.from({ length }, (_, id) => id)
  }
  const mappings: Record<RandomizerFixtureMapping, readonly number[]> = {
    AbilityJobs: identity('AbilityJobs', 508),
    AbilityMonsters: identity('AbilityMonsters', 508),
    Equipment: identity('Equipment', 591),
    Items: identity('Items', 264),
    Jobs: identity('Jobs', 24),
    Passives: identity('Passives', 88),
    Troops: identity('Troops', 339),
    MonsterDifficulties: Array<number>(324).fill(0),
    TeleportPoints: identity('TeleportPoints', 32),
    Music: identity('Music', 103),
    ...options.mappings,
  }
  const primaryEnabled = ['Crystals', 'Monsters', 'Bosses', 'Items', 'Equipment', 'JobAbilities', 'MonsterAbilities', 'MonsterDifficulties', 'Passives', 'InnatePassives', 'TeleportPoints', 'Music'].some(field => flags[field as RandomizerFixtureFlag])
  save.party.value.RandomizerFlags = bson({ Seed: primaryEnabled ? 'synthetic-seed' : null, ...flags })
  save.party.value.RandomizerMapping = bson(Object.fromEntries(Object.entries(mappings).map(([field, values]) => [field, [...values]])))
  save.header.randomizerFlags = Object.entries(RANDOMIZER_FIXTURE_HEADER_FLAGS).reduce((value, [field, bit]) => value | (flags[field as keyof typeof RANDOMIZER_FIXTURE_HEADER_FLAGS] ? bit : 0), 0)
  return save
}

export const SYNTHETIC_SAVE_MOD = Object.freeze({ id: 'synthetic-save-mod', title: 'Synthetic Save Mod', version: '1.0', jobId: 24, passiveIds: [88, 111] as const })
type SaveEditorFixtureMod = { readonly id: string; readonly title: string; readonly version: string; readonly steamWorkshopFileId?: string; readonly jobId?: number; readonly passiveIds?: readonly number[] }

export function createSaveEditorModProjectFixture() {
  return {
    ID: SYNTHETIC_SAVE_MOD.id,
    Title: SYNTHETIC_SAVE_MOD.title,
    Version: SYNTHETIC_SAVE_MOD.version,
    EditorVersion: 34,
    IsLocalization: false,
    SteamWorkshopFileID: 0,
    Jobs: [{ ID: SYNTHETIC_SAVE_MOD.jobId, Name: 'Synthetic mod class', SortOrder: 24, AbilityIDs: [], PassiveIDs: [...SYNTHETIC_SAVE_MOD.passiveIds], LearnTree: [], EquipmentTypes: [], IsUnselectableJob: false, IsUnselectableSubJob: false }],
    Passives: SYNTHETIC_SAVE_MOD.passiveIds.map(ID => ({ ID, Name: `Synthetic passive ${ID}`, PP: 0, JP: 0, IsLearnable: true, IsInnate: false, IsDefaultLocked: false, StatMods: [] })),
  }
}

function emptyModRecords(): Record<SaveEditorFamily, Map<number, NativeRecord>> {
  return { job: new Map(), ability: new Map(), passive: new Map(), item: new Map(), equipment: new Map(), gender: new Map() }
}

export function createSaveEditorModSourceFixture(): SaveEditorModSource {
  const records = emptyModRecords()
  records.job.set(SYNTHETIC_SAVE_MOD.jobId, { ID: SYNTHETIC_SAVE_MOD.jobId, Name: 'Synthetic mod class', SortOrder: 24, AbilityIDs: [], PassiveIDs: [...SYNTHETIC_SAVE_MOD.passiveIds], LearnTree: [], EquipmentTypes: [], IsUnselectableJob: false, IsUnselectableSubJob: false })
  for (const id of SYNTHETIC_SAVE_MOD.passiveIds) records.passive.set(id, { ID: id, Name: `Synthetic passive ${id}`, PP: 0, JP: 0, IsLearnable: true, IsInnate: false, IsDefaultLocked: false, StatMods: [] })
  return { id: SYNTHETIC_SAVE_MOD.id, title: SYNTHETIC_SAVE_MOD.title, version: SYNTHETIC_SAVE_MOD.version, editorVersion: 34, checksum: 'sha256:synthetic-save-mod', origin: 'file', records, issues: [] }
}

function atlasEntries(length: number, discoveredIds: readonly number[]): SyntheticValue[] {
  return Array.from({ length }, (_, ID) => ({ ID, S: discoveredIds.includes(ID) ? 4 : 0, HT: 0, ST: 0, AT: 0, PT: 0, BF: 0 }))
}

function redirectGroup(ids: readonly { readonly originalId: number; readonly newId: number }[]): SyntheticValue {
  return { IDs: ids.map(pair => ({ O: pair.originalId, N: pair.newId })), Count: ids.length }
}

export function createModdedSaveEditorFixture(options: { readonly active?: boolean; readonly equipped?: boolean; readonly relocated?: boolean; readonly unflagged?: boolean; readonly mod?: SaveEditorFixtureMod } = {}): CrystalSave {
  const save = createSaveEditorFixture()
  const active = options.active ?? true
  const mod: SaveEditorFixtureMod = options.mod ?? SYNTHETIC_SAVE_MOD
  const workshopId = BigInt(mod.steamWorkshopFileId ?? '0')
  const sourceJobId = mod.jobId ?? SYNTHETIC_SAVE_MOD.jobId
  const sourcePassiveIds = mod.passiveIds ?? SYNTHETIC_SAVE_MOD.passiveIds
  const jobId = options.relocated ? sourceJobId + 3 : sourceJobId
  const passiveIds = options.relocated ? sourcePassiveIds.map(id => id + 100) : [...sourcePassiveIds]
  const jobPairs = [{ originalId: sourceJobId, newId: jobId }]
  const passivePairs = sourcePassiveIds.map((originalId, index) => ({ originalId, newId: passiveIds[index]! }))
  const groups = { abilities: [], animations: [], biomes: [], difficulties: [], equipment: [], genders: [], items: [], jobs: jobPairs, monsters: [], passives: passivePairs, recipes: [], sparks: [], statuses: [], troops: [], entities: [] }
  const bodyGroups = Object.fromEntries(Object.entries({ Abilities: groups.abilities, Animations: groups.animations, Biomes: groups.biomes, Difficulties: groups.difficulties, Equipment: groups.equipment, Genders: groups.genders, Items: groups.items, Jobs: groups.jobs, Monsters: groups.monsters, Passives: groups.passives, Recipes: groups.recipes, Sparks: groups.sparks, Statuses: groups.statuses, Troops: groups.troops, Entities: groups.entities }).map(([key, pairs]) => [key, redirectGroup(pairs)]))
  save.header.isModded = !options.unflagged
  save.header.mods = active && !options.unflagged ? [{ id: mod.id, title: mod.title, version: mod.version, steamWorkshopFileId: workshopId }] : []
  save.header.modIdMaps = options.unflagged ? [] : [{ modId: mod.id, groups }]
  save.party.value.Mods = bson({
    IsModded: !options.unflagged,
    Mods: active && !options.unflagged ? [{ ID: mod.id, Title: mod.title, Description: 'Synthetic fixture', Author: 'Example', Version: mod.version, SteamWorkshopFileID: workshopId, Timestamp: 0, IsLocalization: false, Language: null }] : [],
    Redirects: options.unflagged ? [] : [{ ModID: mod.id, ...bodyGroups }],
  })
  const jobLength = jobId + 1
  const passiveLength = Math.max(...passiveIds) + 1
  for (const member of save.members) {
    const levels = (member.value.Levels as BsonDocument).value
    levels.Entries = bson([...Array<number>(jobLength).fill(0).map((value, id) => id === 0 ? 5 : value)])
    levels.Hist = structuredClone(levels.Entries)
    member.value.LearnedJobs = bson(Array.from({ length: jobLength }, (_, id) => id === 0 || id === 4 ? 1 : id === jobId ? 2 : 0))
    member.value.LearnedPassives = bson(Array.from({ length: passiveLength }, (_, id) => passiveIds.includes(id) ? 2 : 0))
    const jp = (member.value.JP as BsonDocument).value
    jp.Entries = bson([...Array.from({ length: 24 }, (_, Job) => ({ Job, Current: 0, Total: 0 })), ...(options.unflagged ? [{ Job: jobId, Current: 0, Total: 0 }] : active ? [{ Job: jobId, Current: 0, Total: 0 }] : [{ Job: null, Current: 0, Total: 0 }])])
    member.value.Passives = bson({ Passives: options.equipped ? passiveIds : [], CurrentPP: 10 })
  }
  const atlas = (save.party.value.Atlas as BsonDocument).value
  atlas.Jobs = bson({ Entries: atlasEntries(jobLength, [jobId]) })
  atlas.Passives = bson({ Entries: atlasEntries(passiveLength, passiveIds) })
  save.party.value.RandomizerMapping = bson({
    AbilityJobs: Array.from({ length: 508 }, (_, id) => id), AbilityMonsters: Array.from({ length: 508 }, (_, id) => id), Equipment: Array.from({ length: 591 }, (_, id) => id), Items: Array.from({ length: 264 }, (_, id) => id), Jobs: Array.from({ length: jobLength }, (_, id) => id), Passives: Array.from({ length: passiveLength }, (_, id) => id),
  })
  return save
}

export function createNeutralSaveEditorFixture(orphanJob: number | null = SYNTHETIC_SAVE_MOD.jobId): CrystalSave {
  const save = createModdedSaveEditorFixture({ unflagged: true })
  // Preserve expanded containers and identity tables while removing meaningful mod-only state
  for (const member of save.members) {
    const jobs = member.value.LearnedJobs
    const passives = member.value.LearnedPassives
    if (jobs?.type !== 'array' || passives?.type !== 'array') throw new Error('Synthetic save needs learning arrays')
    jobs.value[SYNTHETIC_SAVE_MOD.jobId] = bson(0)
    for (const id of SYNTHETIC_SAVE_MOD.passiveIds) passives.value[id] = bson(0)
    const jp = member.value.JP
    const entries = jp?.type === 'document' ? jp.value.Entries : undefined
    const orphan = entries?.type === 'array' ? entries.value.at(-1) : undefined
    if (orphan?.type !== 'document') throw new Error('Synthetic save needs an orphan JP entry')
    orphan.value.Job = bson(orphanJob)
  }
  const atlas = (save.party.value.Atlas as BsonDocument).value
  atlas.Jobs = bson({ Entries: atlasEntries(SYNTHETIC_SAVE_MOD.jobId + 1, []) })
  atlas.Passives = bson({ Entries: atlasEntries(Math.max(...SYNTHETIC_SAVE_MOD.passiveIds) + 1, []) })
  return save
}
