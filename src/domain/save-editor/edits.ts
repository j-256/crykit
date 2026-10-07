import { type CrystalSave } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog, type SaveEditorModSource } from '../save-editor-mods'
import { type SaveEditCommand, SAVE_EDITOR_MAX_CURRENCY, ATLAS, SAVE_EDITOR_MAX_LEVEL } from './model.ts'
import { validate } from './validation.ts'
import { bound, object, int, text, number, subJob, flag, flags, known, capacity, quantity, equippedCount } from './values.ts'
import { setLevel, learnJobs, unlockSelectedJob } from './progression.ts'
import { unequip, normalizeClassLoadout, applyLoadout } from './loadout.ts'
import { setStock, atlas, updateTreasureFinder } from './inventory.ts'
import { saveEditorChoices } from './inspection.ts'

const PRESET_EQUIPMENT_COPIES = 10

const PRESET_TOOL_IDS = new Set([55, 91, 97, 147, 149, 150, 151, 167, 186, 196, 201])

const PRESET_MATERIAL_IDS = new Set([3, 4, 5, 67, 68, 69, 70, 71, 72, 157, 178, 179, 180, 181, 182, 183, 187, 188, 189, 190, 200, 202, 203, 204, 205])

export function editSave(input: CrystalSave, nativeCatalog: SaveEditorCatalog, command: SaveEditCommand, now = new Date(), modSources: readonly SaveEditorModSource[] = []): CrystalSave {
  const { catalog, randomizer } = validate(input, nativeCatalog, modSources)
  if (!Number.isFinite(now.getTime())) throw new Error('Edit timestamp is invalid')
  // All helpers mutate this candidate; neither failed commands nor final validation alter the input
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
      if (id === previous) {
        if (command.type === 'loadout' && id !== null) unlockSelectedJob(save, member, catalog, randomizer, id, now)
        continue
      }
      if (field === 'Job' && flag(flags(save).value.NoJobChange) || field === 'SubJob' && flag(flags(save).value.NoSubJob)) throw new Error('This challenge prevents that class change')
      if (id !== null) {
        const job = known(catalog, 'job', id)
        if (field === 'Job' ? job.IsUnselectableJob : job.IsUnselectableSubJob) throw new Error('That class cannot be selected in this slot')
        if (field === 'SubJob' && id === number(member.value.Job, 'Job')) throw new Error('Subclass must differ from the main class')
        unlockSelectedJob(save, member, catalog, randomizer, id, now)
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
    if (command.type === 'loadout') applyLoadout(save, member, catalog, randomizer, command, now)
  }
  if (command.type === 'stock') {
    const record = known(catalog, command.kind, command.id)
    bound(command.count, 0, capacity(save, catalog, command.kind, command.id), `${String(record.Name ?? `${command.kind} ${command.id}`)} stock`)
    setStock(save, command.kind, command.id, command.count)
    if (command.kind === 'item' && typeof record.IncreaseMaxCapacityForItemID === 'number') {
      const targetId = record.IncreaseMaxCapacityForItemID
      const target = catalog.records.item.get(targetId)
      if (target) {
        const limit = capacity(save, catalog, 'item', targetId)
        const targetName = String(target.Name ?? `Item ${targetId}`)
        const pouchName = String(record.Name ?? 'this pouch')
        // Reject the candidate instead of silently discarding consumables when pouch capacity decreases
        if (quantity(save, 'item', targetId) > limit) throw new Error(`${targetName} stock must be a whole number from 0 to ${limit} after changing ${pouchName}. Reduce ${targetName} stock first.`)
      }
    }
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
  // Recheck shared constraints after every operation, including pouch removal and returned equipment
  validate(save, nativeCatalog, modSources)
  return save
}
