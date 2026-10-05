import type { BsonDocument, BsonValue, CrystalSave } from '../interchange/crystal-save'

type SyntheticValue = null | boolean | number | string | SyntheticValue[] | { [key: string]: SyntheticValue }
function bson(value: SyntheticValue): BsonValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'string') return { type: 'string', value }
  if (typeof value === 'number') return { type: 'int32', value }
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
