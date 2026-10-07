import { type CrystalSave, type BsonValue } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog, type SaveEditorModSource, resolveSaveEditorMods } from '../save-editor-mods'
import { type SaveEditorSummary } from './model.ts'
import { inspectSave } from './inspection.ts'
import { object } from './values.ts'

function loadoutAdditions(previous: SaveEditorSummary, next: SaveEditorSummary, catalog: SaveEditorCatalog): string[] {
  const result: string[] = []
  for (const member of next.members) {
    const old = previous.members[member.index]
    if (!old) continue
    for (const id of member.unlockedJobIds) if (!old.unlockedJobIds.includes(id)) result.push(`${member.name}: ${String(catalog.records.job.get(id)?.Name ?? `Class ${id}`)} unlocked`)
    for (const id of member.learnedPassiveIds) if (!old.learnedPassiveIds.includes(id)) result.push(`${member.name}: ${String(catalog.records.passive.get(id)?.Name ?? `Passive ${id}`)} learned`)
  }
  // Moving gear is not an addition; include inactive members even though stock capacity excludes them
  const equipped = (summary: SaveEditorSummary, id: number) => summary.members.reduce((count, member) => count + member.equipmentIds.filter(equipmentId => equipmentId === id).length, 0)
  const oldEquipment = new Map(previous.inventory.filter(row => row.kind === 'equipment').map(row => [row.id, row.count + equipped(previous, row.id)]))
  for (const row of next.inventory) if (row.kind === 'equipment') {
    const added = row.count + equipped(next, row.id) - (oldEquipment.get(row.id) ?? 0)
    if (added > 0) result.push(`${row.name}: ${added} ${added === 1 ? 'copy' : 'copies'} added`)
  }
  return result
}

export function previewSaveAdditions(before: CrystalSave, after: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): string[] {
  const catalog = resolveSaveEditorMods(after, nativeCatalog, modSources).catalog
  return loadoutAdditions(inspectSave(before, nativeCatalog, modSources), inspectSave(after, nativeCatalog, modSources), catalog)
}

export function previewSaveChanges(before: CrystalSave, after: CrystalSave, nativeCatalog: SaveEditorCatalog, modSources: readonly SaveEditorModSource[] = []): string[] {
  const previousCatalog = resolveSaveEditorMods(before, nativeCatalog, modSources).catalog
  const nextCatalog = resolveSaveEditorMods(after, nativeCatalog, modSources).catalog
  const previous = inspectSave(before, nativeCatalog, modSources)
  const next = inspectSave(after, nativeCatalog, modSources)
  const result: string[] = loadoutAdditions(previous, next, nextCatalog)
  if (previous.currency !== next.currency) result.push(`Money: ${previous.currency.toLocaleString('en-US')} → ${next.currency.toLocaleString('en-US')} copper`)
  if (previous.levelCap !== next.levelCap) result.push(`Level cap: ${previous.levelCap} → ${next.levelCap}${next.assistEnabled ? ' (level-cap assist enabled)' : ''}`)
  for (const member of next.members) {
    const old = previous.members[member.index]
    if (!old) continue
    if (old.name !== member.name) result.push(`Member ${member.index + 1}: ${old.name} → ${member.name}`)
    if (old.level !== member.level) result.push(`${member.name}: level ${old.level} → ${member.level}; growth and experience updated`)
    if (old.jobId !== member.jobId) result.push(`${member.name}: class ${previousCatalog.records.job.get(old.jobId)?.Name ?? old.jobId} → ${nextCatalog.records.job.get(member.jobId)?.Name ?? member.jobId}; future growth follows the new class; equipment returned to inventory`)
    if (old.subJobId !== member.subJobId) result.push(`${member.name}: subclass ${old.subJobId === null ? 'None' : previousCatalog.records.job.get(old.subJobId)?.Name ?? old.subJobId} → ${member.subJobId === null ? 'None' : nextCatalog.records.job.get(member.subJobId)?.Name ?? member.subJobId}${old.jobId === member.jobId ? '; equipment returned to inventory' : ''}`)
    if (old.unlockedJobs !== member.unlockedJobs || old.masteredJobs !== member.masteredJobs || old.learnedAbilities !== member.learnedAbilities || old.learnedPassives !== member.learnedPassives) result.push(`${member.name}: ${member.unlockedJobs} classes unlocked, ${member.masteredJobs} mastered, ${member.learnedAbilities} abilities and ${member.learnedPassives} passives learned`)
    else if (['LearnedJobs', 'LearnedAbilities', 'LearnedPassives'].some(field => !sameBson(before.members[member.index]?.value[field], after.members[member.index]?.value[field]))) result.push(`${member.name}: ability and passive unlock states updated`)
    if (!sameBson(before.members[member.index]?.value.JP, after.members[member.index]?.value.JP)) result.push(`${member.name}: class JP updated`)
    if (old.level === member.level && !sameBson(before.members[member.index]?.value.Levels, after.members[member.index]?.value.Levels)) result.push(`${member.name}: growth and experience bookkeeping updated`)
    if (!sameBson(before.members[member.index]?.value.Passives, after.members[member.index]?.value.Passives)) result.push(`${member.name}: equipped passives and available points updated`)
    if (!sameBson(before.members[member.index]?.value.Equipment, after.members[member.index]?.value.Equipment)) result.push(`${member.name}: equipped loadout updated and inventory reconciled`)
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
  if (before.header.isModded !== after.header.isModded || before.header.mods.length !== after.header.mods.length || before.header.modIdMaps.length !== after.header.modIdMaps.length) result.push('Saved mod flags, active list, and ID redirects updated')
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
