import { type SaveEditorCatalog, type SaveEditorModSource, resolveSaveEditorMods } from '../save-editor-mods'
import { type CrystalSave } from '../../interchange/crystal-save.ts'
import { type SaveEditorChoice, type Family, type SaveEditorSummary, DEFAULT_LEVEL_CAP, LEARNED, SAVE_EDITOR_MAX_LEVEL } from './model.ts'
import { randomizerStateHint } from './randomizer.ts'
import { validate } from './validation.ts'
import { levelCap, flag, flags, numbers, string, number, object, subJob, growthJob, array, stock, stockId, quantity, capacity, equippedCount } from './values.ts'

const DEBUG_NAME = /test|placeholder|debug|unused/i

export function saveEditorChoices(catalog: SaveEditorCatalog): { jobs: SaveEditorChoice[]; items: SaveEditorChoice[]; equipment: SaveEditorChoice[] } {
  const choices = (family: Family): SaveEditorChoice[] => [...catalog.records[family]].filter(([, value]) => typeof value.Name === 'string' && !DEBUG_NAME.test(value.Name) && !value.Name.startsWith('Cinema')).map(([id, value]) => ({ id, name: String(value.Name) })).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  return { jobs: choices('job'), items: choices('item'), equipment: choices('equipment') }
}

export function inspectSave(save: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): SaveEditorSummary {
  const resolution = resolveSaveEditorMods(save, nativeCatalog, modSources)
  const catalog = resolution.catalog
  // Read-only saves still expose recoverable details; inspection never grants editability by inference
  const summary: SaveEditorSummary = { editable: false, issues: [], mode: catalog.mode, randomized: randomizerStateHint(save), currency: save.header.currencyAmount, members: [], inventory: [], levelCap: DEFAULT_LEVEL_CAP, assistEnabled: false, levelCapCanBeRaised: false }
  try { const validated = validate(save, nativeCatalog, modSources); summary.editable = true; summary.randomized = validated.randomizer.enabled } catch (error) { summary.issues.push(error instanceof Error ? error.message : 'Unsupported save data') }
  try {
    const gameplay = flags(save).value
    summary.levelCap = levelCap(save)
    summary.assistEnabled = flag(gameplay.MaxLevelUp)
    summary.levelCapCanBeRaised = summary.levelCap < SAVE_EDITOR_MAX_LEVEL && !flag(gameplay.MaxLevelDown) && !flag(gameplay.NoAssistOptions)
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
  summary.levelCapCanBeRaised &&= summary.editable
  return summary
}
