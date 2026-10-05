import { CRYSTAL_SAVE_VERSION, isSupportedCrystalSaveVersion, type BsonDocument, type BsonValue, type CrystalSave } from '../interchange/crystal-save.ts'
import type { NativeGameSnapshot, NativeRecord } from './native-game'

export const SAVE_EDITOR_MAX_CURRENCY = 999_999_999
const DEFAULT_LEVEL_CAP = 60
export const SAVE_EDITOR_MAX_LEVEL = 99
const MAX_STOCK = 99
const MAX_JP = 10_000
const PASSIVE_POINT_BUDGET = 10
const PRESET_EQUIPMENT_COPIES = 10
const LEARN_NODE = Object.freeze({ ability: 2, passive: 3 })
const LEGACY_HEADER = Object.freeze({ flags: 14, mods: 24 })
const LEVEL_ASSIST_FLAG = 128
const TREASURE_FINDER_BONUS = 4
const ENABLE_EQUIPMENT_TYPE = 406
const EMPTY_DATE = -62_135_596_800_000n
const LEARNED = Object.freeze({ locked: 0, unlocked: 1, learned: 2 })
const ATLAS = Object.freeze({ seen: 2, acquired: 4 })
const DEBUG_NAME = /test|placeholder|debug|unused/i
const PRESET_TOOL_IDS = new Set([55, 91, 97, 147, 149, 150, 151, 167, 186, 196, 201])
const PRESET_MATERIAL_IDS = new Set([3, 4, 5, 67, 68, 69, 70, 71, 72, 157, 178, 179, 180, 181, 182, 183, 187, 188, 189, 190, 200, 202, 203, 204, 205])
type Family = 'job' | 'ability' | 'passive' | 'item' | 'equipment' | 'gender'
export type SaveInventoryKind = 'item' | 'equipment'
export interface SaveEditorChoice { id: number; name: string }
export interface SaveEditorCatalog { readonly source: string; readonly records: Readonly<Record<Family, ReadonlyMap<number, NativeRecord>>> }
export interface SaveEditorMemberSummary { index: number; name: string; level: number; jobId: number; subJobId: number | null; growthJobId: number; unlockedJobs: number; masteredJobs: number; learnedAbilities: number; learnedPassives: number }
export interface SaveEditorInventoryRow extends SaveEditorChoice { kind: SaveInventoryKind; count: number; capacity: number; equipped: number }
export interface SaveEditorSummary { editable: boolean; issues: string[]; currency: number; members: SaveEditorMemberSummary[]; inventory: SaveEditorInventoryRow[]; mapCount: number; levelCap: number; assistEnabled: boolean }
export type SaveEditCommand =
  | { type: 'currency'; value: number }
  | { type: 'member'; index: number; name?: string; level?: number; jobId?: number; subJobId?: number | null }
  | { type: 'stock'; kind: SaveInventoryKind; id: number; count: number }
  | { type: 'unlock-jobs' | 'master-jobs' | 'overpowered' | 'reveal-maps' }

export function createSaveEditorCatalog(snapshot: NativeGameSnapshot): SaveEditorCatalog {
  const records = {} as Record<Family, ReadonlyMap<number, NativeRecord>>
  for (const family of ['job', 'ability', 'passive', 'item', 'equipment', 'gender'] as const) {
    const values = snapshot.databases[family]
    if (!Array.isArray(values)) throw new Error(`Missing native ${family} definitions`)
    records[family] = new Map(values.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.ID === 'number' ? [[value.ID, value as NativeRecord] as const] : []))
  }
  return { source: `${snapshot.source.platform} PC ${snapshot.source.gameVersion}`, records }
}

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

export function saveEditorChoices(catalog: SaveEditorCatalog): { jobs: SaveEditorChoice[]; items: SaveEditorChoice[]; equipment: SaveEditorChoice[] } {
  const choices = (family: Family): SaveEditorChoice[] => [...catalog.records[family]].filter(([, value]) => typeof value.Name === 'string' && !DEBUG_NAME.test(value.Name) && !value.Name.startsWith('Cinema')).map(([id, value]) => ({ id, name: String(value.Name) })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  return { jobs: choices('job'), items: choices('item'), equipment: choices('equipment') }
}

function validate(save: CrystalSave, catalog: SaveEditorCatalog): void {
  if (!isSupportedCrystalSaveVersion(save.header.version)) throw new Error('Unsupported save format')
  if (save.header.isDemo || save.header.isHardcoreDefeat) throw new Error('Demo and defeated hardcore saves are read-only')
  const mods = object(save.party.value.Mods ?? (save.header.version < LEGACY_HEADER.mods ? document({ Mods: list([]), Redirects: list([]) }) : undefined), 'Mods')
  if (save.header.isModded || save.header.mods.length || save.header.modIdMaps.length || flag(mods.value.IsModded) || array(mods.value.Mods, 'Mods').length || array(mods.value.Redirects, 'Mod redirects').length) throw new Error('Modded saves are read-only because their definitions can differ')
  if (save.header.patchMode !== 0 || number(flags(save).value.PatchMode ?? int(0), 'Patch mode') !== 0) throw new Error('Editing supports Standard mode; other mode rules are unresolved')
  const randomizer = object(save.party.value.RandomizerFlags ?? (save.header.version < LEGACY_HEADER.flags ? document({}) : undefined), 'RandomizerFlags')
  if (save.header.randomizerFlags !== 0 || Object.values(randomizer.value).some(value => value.type === 'boolean' && value.value)) throw new Error('Randomized saves are read-only because their identities can differ')
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
}

export function inspectSave(save: CrystalSave, catalog: SaveEditorCatalog): SaveEditorSummary {
  const summary: SaveEditorSummary = { editable: false, issues: [], currency: save.header.currencyAmount, members: [], inventory: [], mapCount: save.maps.length, levelCap: DEFAULT_LEVEL_CAP, assistEnabled: false }
  try { validate(save, catalog); summary.editable = true } catch (error) { summary.issues.push(error instanceof Error ? error.message : 'Unsupported save data') }
  try {
    summary.levelCap = levelCap(save)
    summary.assistEnabled = flag(flags(save).value.MaxLevelUp)
    summary.members = save.members.map((member, index) => ({ index, name: string(member.value.Name, 'Name'), level: number(object(member.value.Levels, 'Levels').value.Level, 'Level'), jobId: number(member.value.Job, 'Job'), subJobId: subJob(member, save), growthJobId: growthJob(member, save), unlockedJobs: numbers(member.value.LearnedJobs, 'LearnedJobs').filter(value => value > 0).length, masteredJobs: numbers(member.value.LearnedJobs, 'LearnedJobs').filter(value => value === LEARNED.learned).length, learnedAbilities: numbers(member.value.LearnedAbilities, 'LearnedAbilities').filter(value => value === LEARNED.learned).length, learnedPassives: numbers(member.value.LearnedPassives, 'LearnedPassives').filter(value => value === LEARNED.learned).length }))
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
function learnJobs(save: CrystalSave, catalog: SaveEditorCatalog, master: boolean, now: Date): void {
  for (const member of save.members) {
    for (const [id, job] of catalog.records.job) {
      learn(save, member, 'LearnedJobs', id, master ? LEARNED.learned : LEARNED.unlocked, now)
      const abilityIds = new Set([...nativeIds(job, 'AbilityIDs'), ...(master ? treeNodes(job.LearnTree).filter(node => node.type === LEARN_NODE.ability).map(node => node.id) : [])])
      for (const abilityId of abilityIds) { const ability = known(catalog, 'ability', abilityId); if (master || !ability.IsDefaultLocked) learn(save, member, 'LearnedAbilities', abilityId, master || ability.JP === 0 ? LEARNED.learned : LEARNED.unlocked, now) }
      for (const passiveId of nativeIds(job, 'PassiveIDs')) { const passive = known(catalog, 'passive', passiveId); if (master || !passive.IsDefaultLocked) learn(save, member, 'LearnedPassives', passiveId, passive.IsLearnable && (master || passive.JP === 0) ? LEARNED.learned : LEARNED.unlocked, now) }
    }
    if (master) {
      const passives = new Set([...catalog.records.passive].filter(([, passive]) => passive.IsLearnable).map(([id]) => id))
      for (const job of catalog.records.job.values()) for (const node of treeNodes(job.LearnTree)) if (node.type === LEARN_NODE.passive) passives.add(node.id)
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

function normalizeClassLoadout(member: BsonDocument, save: CrystalSave, catalog: SaveEditorCatalog, mainChanged: boolean): void {
  const job = known(catalog, 'job', number(member.value.Job, 'Job'))
  if (mainChanged) {
    const passives = object(member.value.Passives, 'Passives')
    const jobPassives = new Set(nativeIds(job, 'PassiveIDs'))
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
    const commands = [...nativeIds(job, 'AbilityIDs'), ...(secondary === null ? [] : nativeIds(known(catalog, 'job', secondary), 'AbilityIDs'))]
    if (!commands.includes(id) || (numbers(member.value.LearnedAbilities, 'LearnedAbilities')[id] ?? 0) < LEARNED.learned) member.value.AutoAbilityID = { type: 'null' }
  }
}

export function editSave(input: CrystalSave, catalog: SaveEditorCatalog, command: SaveEditCommand, now = new Date()): CrystalSave {
  validate(input, catalog)
  if (!Number.isFinite(now.getTime())) throw new Error('Edit timestamp is invalid')
  const save = structuredClone(input)
  if (command.type === 'currency' || command.type === 'overpowered') {
    const value = command.type === 'currency' ? command.value : SAVE_EDITOR_MAX_CURRENCY
    bound(value, 0, SAVE_EDITOR_MAX_CURRENCY, 'Currency')
    object(save.party.value.Currency, 'Currency').value.Val = int(value)
    save.header.currencyAmount = value
  }
  if (command.type === 'member') {
    bound(command.index, 0, save.members.length - 1, 'Member index')
    const member = save.members[command.index]!
    let mainChanged = false
    let classChanged = false
    if (command.name !== undefined) {
      if (!command.name.trim() || [...command.name].length > 32 || /[\u0000-\u001f\u007f]/.test(command.name)) throw new Error('Names need 1 to 32 characters without control characters')
      member.value.Name = text(command.name)
      save.header.members[command.index]!.name = command.name
    }
    if (command.level !== undefined && command.level !== number(object(member.value.Levels, 'Levels').value.Level, 'Level')) setLevel(save, catalog, command.index, command.level, now)
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
    if (classChanged) { unequip(save, member); normalizeClassLoadout(member, save, catalog, mainChanged) }
  }
  if (command.type === 'stock') {
    known(catalog, command.kind, command.id)
    bound(command.count, 0, capacity(save, catalog, command.kind, command.id), 'Quantity')
    setStock(save, command.kind, command.id, command.count)
    if (command.count > 0) atlas(save, command.kind === 'item' ? 'Items' : 'Equipment', command.id, ATLAS.acquired, now)
    updateTreasureFinder(save, catalog)
  }
  if (command.type === 'unlock-jobs' || command.type === 'master-jobs' || command.type === 'overpowered') learnJobs(save, catalog, command.type !== 'unlock-jobs', now)
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
  validate(save, catalog)
  return save
}

export function previewSaveChanges(before: CrystalSave, after: CrystalSave, catalog: SaveEditorCatalog): string[] {
  const previous = inspectSave(before, catalog)
  const next = inspectSave(after, catalog)
  const result: string[] = []
  if (previous.currency !== next.currency) result.push(`Money: ${previous.currency.toLocaleString('en-US')} → ${next.currency.toLocaleString('en-US')} copper`)
  if (previous.levelCap !== next.levelCap) result.push(`Level cap: ${previous.levelCap} → ${next.levelCap}${next.assistEnabled ? ' (level-cap assist enabled)' : ''}`)
  for (const member of next.members) {
    const old = previous.members[member.index]
    if (!old) continue
    if (old.name !== member.name) result.push(`Member ${member.index + 1}: ${old.name} → ${member.name}`)
    if (old.level !== member.level) result.push(`${member.name}: level ${old.level} → ${member.level}; growth and experience updated`)
    if (old.jobId !== member.jobId) result.push(`${member.name}: class ${catalog.records.job.get(old.jobId)?.Name ?? old.jobId} → ${catalog.records.job.get(member.jobId)?.Name ?? member.jobId}; future growth follows the new class; equipment returned to inventory`)
    if (old.subJobId !== member.subJobId) result.push(`${member.name}: subclass ${old.subJobId === null ? 'None' : catalog.records.job.get(old.subJobId)?.Name ?? old.subJobId} → ${member.subJobId === null ? 'None' : catalog.records.job.get(member.subJobId)?.Name ?? member.subJobId}${old.jobId === member.jobId ? '; equipment returned to inventory' : ''}`)
    if (old.unlockedJobs !== member.unlockedJobs || old.masteredJobs !== member.masteredJobs || old.learnedAbilities !== member.learnedAbilities || old.learnedPassives !== member.learnedPassives) result.push(`${member.name}: ${member.unlockedJobs} classes unlocked, ${member.masteredJobs} mastered, ${member.learnedAbilities} abilities and ${member.learnedPassives} passives learned`)
    else if (['LearnedJobs', 'LearnedAbilities', 'LearnedPassives'].some(field => !sameBson(before.members[member.index]?.value[field], after.members[member.index]?.value[field]))) result.push(`${member.name}: ability and passive unlock states updated`)
    if (!sameBson(before.members[member.index]?.value.JP, after.members[member.index]?.value.JP)) result.push(`${member.name}: class JP updated`)
    if (old.level === member.level && !sameBson(before.members[member.index]?.value.Levels, after.members[member.index]?.value.Levels)) result.push(`${member.name}: growth and experience bookkeeping updated`)
    if (!sameBson(before.members[member.index]?.value.Passives, after.members[member.index]?.value.Passives)) result.push(`${member.name}: redundant passives removed and points returned`)
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
