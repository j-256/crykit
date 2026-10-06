import { type CrystalSave, type BsonDocument, CRYSTAL_SAVE_VERSION } from '../../interchange/crystal-save.ts'
import { type NativeRecord } from '../native-game'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { array, int, number, known, object, document, bound, flags, levelCap, flag, numbers, growthJob, growthHistory, list } from './values.ts'
import { LEARNED, ATLAS, MAX_JP, SAVE_EDITOR_MAX_LEVEL, LEGACY_HEADER, LEVEL_ASSIST_FLAG } from './model.ts'
import { atlas } from './inventory.ts'
import { type SaveEditorRandomizerState, randomizedId } from './randomizer.ts'

const LEARN_NODE = Object.freeze({ ability: 2, passive: 3 })

function learn(save: CrystalSave, member: BsonDocument, field: 'LearnedJobs' | 'LearnedAbilities' | 'LearnedPassives', id: number, state: number, now: Date): void {
  const values = array(member.value[field], field)
  while (values.length <= id) values.push(int(LEARNED.locked))
  if (number(values[id], field) < state) values[id] = int(state)
  atlas(save, field === 'LearnedJobs' ? 'Jobs' : field === 'LearnedAbilities' ? 'Abilities' : 'Passives', id, state === LEARNED.learned ? ATLAS.acquired : ATLAS.seen, now)
}

export function nativeIds(record: NativeRecord, field: string): number[] { const value = record[field]; return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number') : [] }

function treeNodes(value: unknown): { type: number; id: number }[] {
  if (Array.isArray(value)) return value.flatMap(treeNodes)
  if (value && typeof value === 'object' && 'NodeType' in value && 'DataID' in value && typeof value.NodeType === 'number' && typeof value.DataID === 'number') return [{ type: value.NodeType, id: value.DataID }]
  return []
}

export function learnJobs(save: CrystalSave, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, master: boolean, now: Date): void {
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

export function setLevel(save: CrystalSave, catalog: SaveEditorCatalog, index: number, level: number, now: Date): void {
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
  // Lowering follows native allocation order, rather than undoing only the selected growth class
  else for (let remaining = oldLevel - level; remaining > 0; remaining--) {
    const candidates = growth.map((count, id) => ({ count, id })).filter(entry => entry.count > 0).sort((a, b) => a.count - b.count || Number(known(catalog, 'job', b.id).SortOrder) - Number(known(catalog, 'job', a.id).SortOrder))
    growth[candidates[0]!.id]!--
  }
  const history = growthHistory(levels, save)
  levels.value.Entries = list(growth.map(int))
  // Historical growth is a high-water mark and must not shrink with the active level allocation
  levels.value.Hist = list(Array.from({ length: Math.max(growth.length, history.length) }, (_, id) => int(Math.max(history[id] ?? 0, growth[id] ?? 0))))
  levels.value.Level = int(level)
  levels.value.MaxLevel = int(Math.max(levelCap(save), level))
  levels.value.Exp = int(0)
  levels.value.TotExp = int(Math.max(number(levels.value.TotExp ?? (save.header.version < CRYSTAL_SAVE_VERSION ? int(0) : undefined), 'Lifetime experience'), totalExperience(level)))
  save.header.members[index]!.level = level
}
