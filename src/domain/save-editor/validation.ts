import { type SaveEditorCatalog, type SaveEditorModSource, resolveSaveEditorMods } from '../save-editor-mods'
import { type CrystalSave, isSupportedCrystalSaveVersion } from '../../interchange/crystal-save.ts'
import { type SaveEditorRandomizerState, readRandomizerState } from './randomizer.ts'
import { saveEditorMode, partyModDocument, partyModList, partyModMaps, sameModList, sameModMaps } from './mod-state.ts'
import { flag, number, object, bound, flags, levelCap, numbers, growthHistory, known, growthJob, subJob, string, array, stock, stockId, stockCount, capacity } from './values.ts'
import { SAVE_EDITOR_MAX_CURRENCY, DEFAULT_LEVEL_CAP, SAVE_EDITOR_MAX_LEVEL, LEGACY_HEADER, LEVEL_ASSIST_FLAG, LEARNED, PASSIVE_POINT_BUDGET, MAX_JP } from './model.ts'

interface ValidatedSaveEditor { readonly catalog: SaveEditorCatalog; readonly randomizer: SaveEditorRandomizerState }

export function validate(save: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): ValidatedSaveEditor {
  if (!isSupportedCrystalSaveVersion(save.header.version)) throw new Error('Unsupported save format')
  if (save.header.isDemo || save.header.isHardcoreDefeat) throw new Error('Demo and defeated hardcore saves are read-only')
  saveEditorMode(save, nativeCatalog)
  const mods = partyModDocument(save)
  const bodyMods = partyModList(mods)
  const bodyMaps = partyModMaps(mods)
  // The game stores mod identities twice; disagreement cannot be repaired by choosing one copy
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
