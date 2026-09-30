import type { CatalogEntity, JsonValue, Knowledge, SourceRef } from './types'

export const STAT_KEYS = ['HP', 'MP', 'STR', 'VIT', 'DEX', 'AGI', 'MND', 'SPI', 'SPD', 'LUK'] as const
export type GrowthStat = typeof STAT_KEYS[number]
export type GrowthRatings = Readonly<Partial<Record<GrowthStat, number>>>
export const MAX_GROWTH_RATING = 10_000
export const MAX_TREE_COLUMNS = 32
export const MAX_TREE_ROWS = 64
export const RATING_FIELDS: Readonly<Record<GrowthStat, string>> = Object.freeze({ HP: 'HPRating', MP: 'MPRating', STR: 'StrRating', VIT: 'VitRating', DEX: 'DexRating', AGI: 'AgiRating', MND: 'MndRating', SPI: 'SpiRating', SPD: 'SpdRating', LUK: 'LckRating' })
export const EQUIPMENT_TYPES = Object.freeze(['Sword', 'Axe', 'Dagger', 'Rapier', 'Katana', 'Spear', 'Scythe', 'Bow', 'Staff', 'Wand', 'Book', 'Shield', 'Heavy Head', 'Medium Head', 'Light Head', 'Heavy Body', 'Medium Body', 'Light Body', 'Accessory'])
export const CRYSTAL_EDIT_FIELDS = Object.freeze({ ratings: 'Crystal Edit growth ratings', equipment: 'Crystal Edit equipment types', tree: 'Crystal Edit learn tree', abilities: 'Crystal Edit ability IDs', passives: 'Crystal Edit passive IDs', command: 'Crystal Edit command' })
export const CLASS_FIELDS = Object.freeze({ ratings: 'Class growth ratings', equipment: 'Class equipment types', tree: 'Class learn tree', abilities: 'Class ability IDs', passives: 'Class passive IDs', command: 'Class command' })
export const LEARN_NODE_TYPES = Object.freeze({ blank: 0, gate: 1, ability: 2, passive: 3 })
export const LAST_VANILLA_JOB_ID = 23
export const CRYSTAL_EDIT_SCHEMA_SOURCE: SourceRef = { sourceId: 'https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/job.yaml', locator: 'EquipmentType and LearnTree definitions', applicability: 'Crystal Edit data format interpretation' }

export interface ExportedTreeNode {
  readonly row: number
  readonly column: number
  readonly nodeType: number
  readonly dataId: number
  readonly prerequisites: readonly { readonly row: number; readonly column: number }[]
}

export function jsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function growthRatings(entity: Pick<CatalogEntity, 'fields'>): GrowthRatings {
  const field = entity.fields[CLASS_FIELDS.ratings] ?? entity.fields[CRYSTAL_EDIT_FIELDS.ratings]
  if (field?.state !== 'known' || !jsonRecord(field.value)) return {}
  const values = field.value
  return Object.fromEntries(STAT_KEYS.flatMap(stat => {
    const value = values[stat]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_GROWTH_RATING ? [[stat, value]] : []
  }))
}

export function classFields(record: Readonly<Record<string, JsonValue>>, source: SourceRef, fieldNames: Readonly<Record<keyof typeof CRYSTAL_EDIT_FIELDS, string>> = CRYSTAL_EDIT_FIELDS): Readonly<Record<string, Knowledge<JsonValue>>> {
  const sources = [source]
  const known = (value: JsonValue, interpreted = false): Knowledge<JsonValue> => ({ state: 'known', value, sources: interpreted && fieldNames !== CLASS_FIELDS ? [...sources, CRYSTAL_EDIT_SCHEMA_SOURCE] : sources })
  const unknown = (reason: string): Knowledge<JsonValue> => ({ state: 'unknown', reason, sources })
  const ratings = Object.fromEntries(STAT_KEYS.flatMap(stat => typeof record[RATING_FIELDS[stat]] === 'number' ? [[stat, record[RATING_FIELDS[stat]]!]] : []))
  const fields: Record<string, Knowledge<JsonValue>> = {
    [fieldNames.ratings]: Object.keys(ratings).length ? known(ratings) : unknown('No numeric class growth ratings in this source'),
    [fieldNames.equipment]: Array.isArray(record.EquipmentTypes) ? known(record.EquipmentTypes.map(id => typeof id === 'number' ? EQUIPMENT_TYPES[id] ?? `Unrecognized equipment type ${id}` : String(id)), true) : unknown('Equipment permissions are absent'),
    [fieldNames.abilities]: Array.isArray(record.AbilityIDs) ? known(record.AbilityIDs) : unknown('Ability membership is absent'),
    [fieldNames.passives]: Array.isArray(record.PassiveIDs) ? known(record.PassiveIDs) : unknown('Passive membership is absent'),
  }
  if (Array.isArray(record.LearnTree)) {
    const nodes = record.LearnTree.flatMap((column, x) => Array.isArray(column) ? column.flatMap((node, y) => {
      if (!jsonRecord(node)) return []
      return [{ row: y, column: x, nodeType: node.NodeType!, dataId: node.DataID!, prerequisites: [
        ...(node.PrereqLeft === true ? [{ row: y - 1, column: x - 1 }] : []),
        ...(node.PrereqMiddle === true ? [{ row: y - 1, column: x }] : []),
        ...(node.PrereqRight === true ? [{ row: y - 1, column: x + 1 }] : []),
      ] }]
    }) : [])
    fields[fieldNames.tree] = known(nodes, true)
  }
  for (const [key, label] of Object.entries({ AbilitiesName: fieldNames.command, CrystalName: fieldNames === CLASS_FIELDS ? 'Crystal name' : 'Crystal Edit crystal name', IsStartingJob: 'Available as a starting class', IsUnselectableJob: 'Primary class selection disabled', IsUnselectableSubJob: 'Secondary class selection disabled', IsNotCrystalJob: 'Excluded from crystal count' })) {
    fields[label] = record[key] === undefined || record[key] === null ? unknown('Not supplied in the export') : known(record[key]!)
  }
  return fields
}

export function exportedTree(entity: Pick<CatalogEntity, 'fields'>): readonly ExportedTreeNode[] {
  const field = entity.fields[CLASS_FIELDS.tree] ?? entity.fields[CRYSTAL_EDIT_FIELDS.tree]
  if (field?.state !== 'known' || !Array.isArray(field.value)) return []
  return field.value.flatMap(node => {
    if (!jsonRecord(node) || typeof node.row !== 'number' || !Number.isInteger(node.row) || node.row < 0 || node.row >= MAX_TREE_ROWS || typeof node.column !== 'number' || !Number.isInteger(node.column) || node.column < 0 || node.column >= MAX_TREE_COLUMNS || !Number.isInteger(node.nodeType) || !Number.isInteger(node.dataId) || !Array.isArray(node.prerequisites)) return []
    const prerequisites = node.prerequisites.filter(p => jsonRecord(p) && Number.isInteger(p.row) && Number.isInteger(p.column)) as unknown as ExportedTreeNode['prerequisites']
    return [{ row: node.row as number, column: node.column as number, nodeType: node.nodeType as number, dataId: node.dataId as number, prerequisites }]
  })
}
