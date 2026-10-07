import { type CrystalSave, type BsonDocument } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { type NativeRecord } from '../native-game'
import { array, number, quantity, known, object, numbers, list, int, subJob, bound, capacity } from './values.ts'
import { setStock, atlas } from './inventory.ts'
import { type SaveEditorRandomizerState, randomizedId } from './randomizer.ts'
import { nativeIds, learn } from './progression.ts'
import { PASSIVE_POINT_BUDGET, LEARNED, ATLAS, type SaveEditCommand } from './model.ts'

const ENABLE_EQUIPMENT_TYPE = 406

const DUAL_WIELD = 511

export function unequip(save: CrystalSave, member: BsonDocument): void {
  const equipped = array(member.value.Equipment, 'Equipment')
  for (const [index, value] of equipped.entries()) if (value.type !== 'null') { const id = number(value, 'Equipped ID'); setStock(save, 'equipment', id, quantity(save, 'equipment', id) + 1); equipped[index] = { type: 'null' } }
}

export function normalizeClassLoadout(member: BsonDocument, save: CrystalSave, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, mainChanged: boolean): void {
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

export function applyLoadout(save: CrystalSave, member: BsonDocument, catalog: SaveEditorCatalog, randomizer: SaveEditorRandomizerState, command: Extract<SaveEditCommand, { type: 'loadout' }>, now: Date): void {
  const equipped = array(member.value.Equipment, 'Equipment')
  if (command.equipmentIds.length !== equipped.length) throw new Error(`A loadout needs exactly ${equipped.length} equipment slots`)
  if (new Set(command.passiveIds).size !== command.passiveIds.length) throw new Error('A loadout cannot equip the same passive twice')
  const passiveRecords = command.passiveIds.map(id => {
    const passive = known(catalog, 'passive', id)
    if (passive.IsLearnable === false) throw new Error(`${String(passive.Name ?? `Passive ${id}`)} cannot be equipped as a learned passive`)
    if ((numbers(member.value.LearnedPassives, 'LearnedPassives')[id] ?? LEARNED.locked) !== LEARNED.learned) learn(save, member, 'LearnedPassives', id, LEARNED.learned, now)
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
  // Return this member's gear before counting requested copies, allowing reuse of the same item
  // These mutations are confined to editSave's candidate and roll back if any later check fails
  unequip(save, member)
  // Add only the missing copies after returning this member's gear; other members keep theirs
  // Capacity still includes the rest of the party and final validation rolls back every prerequisite
  for (const [id, count] of counts) if (quantity(save, 'equipment', id) < count) {
    bound(count, 0, capacity(save, catalog, 'equipment', id), `${String(catalog.records.equipment.get(id)?.Name ?? `Equipment ${id}`)} stock`)
    setStock(save, 'equipment', id, count)
    atlas(save, 'Equipment', id, ATLAS.acquired, now)
  }
  for (const [id, count] of counts) setStock(save, 'equipment', id, quantity(save, 'equipment', id) - count)
  member.value.Equipment = list(command.equipmentIds.map(id => id === null ? { type: 'null' } : int(id)))
  const passives = object(member.value.Passives, 'Passives')
  passives.value.Passives = list(command.passiveIds.map(int))
  passives.value.CurrentPP = int(PASSIVE_POINT_BUDGET - passiveCost)
}
