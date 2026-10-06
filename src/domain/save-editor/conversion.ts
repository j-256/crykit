import { type BsonValue, type CrystalSave, type BsonDocument, decodeCrystalSave, encodeCrystalSave } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { document, int, flag, object, string, number, growthJob, subJob, array, list, numbers, stock, stockId, stockCount, capacity } from './values.ts'
import { EMPTY_DATE, type SaveVanillaConversionPreview, LEGACY_HEADER, PASSIVE_POINT_BUDGET } from './model.ts'
import { partyModList, partyModMaps, partyModDocument, sameModList, sameModMaps, saveEditorMode, nativeBound } from './mod-state.ts'
import { updateTreasureFinder } from './inventory.ts'
import { validate } from './validation.ts'

const CONVERTIBLE_MOD_GROUPS = new Set(['jobs', 'abilities', 'passives', 'items', 'equipment', 'genders'])

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
  // A rejected preview may contain partial cleanup, so only an isolated candidate is ever mutated
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
    // Clear both metadata copies after indexed cleanup so unresolved mod-only state stays blocked
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
      // Semantic validity alone cannot establish that the original binary layout can encode the draft
      validate(decodeCrystalSave(encodeCrystalSave(save)), nativeCatalog)
    } catch (error) { blockers.push(`Converted save is not valid against native definitions: ${error instanceof Error ? error.message : 'unsupported save data'}`) }
  }
  return { relevant, convertible: relevant && blockers.length === 0, changes: [...new Set(changes)], blockers: [...new Set(blockers)], ...(relevant && !blockers.length ? { draft: save } : {}) }
}
