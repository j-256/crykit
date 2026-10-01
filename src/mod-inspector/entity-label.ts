import { childAt, objectProperty } from './document'
import type { JsonNode } from './types'
import schemaData from './reference-schema.json' with { type: 'json' }

const SUMMARY_TEXT_LIMIT = 120
const ENTITY_TYPES: Readonly<Record<string, string>> = schemaData.enums.ModelEntityType
const LOOT_TYPES: Readonly<Record<string, string>> = schemaData.enums.ModelEntityLootType
const DOOR_TYPES: Readonly<Record<string, string>> = schemaData.enums.ModelEntityDoorType
const CSHARP_INT_MIN = -2147483648n
const CSHARP_INT_MAX = 2147483647n
const BIOME_ID_MAX = 255n
const SIGN_EXCERPT_LENGTH = 32
export interface BaseEntityRecord {
  readonly ID: number
  readonly Name: string
  readonly NameSource: string
  readonly EntityType: string
  readonly BiomeID: number
  readonly BiomeName: string
  readonly Coord: { readonly X: number; readonly Y: number; readonly Z: number }
  readonly JobID?: number | null
  readonly TroopIDs?: readonly number[]
  readonly LootType?: string
  readonly LootValue?: number
  readonly DoorType?: string
  readonly NpcKey?: string | null
  readonly NpcOutfitNames?: readonly (string | null)[]
  readonly NpcOutfitTextureKeys?: readonly (string | null)[]
}
export type EntityRelatedLookup = (model: string, id: string) => string | undefined
export interface EntityLabel { readonly label: string; readonly detail: string; readonly status: 'resolved' | 'unknown' }
interface Facts { type?: string; name?: string; nameSource?: string; biome?: string; biomeID?: string; coord: readonly (string | undefined)[]; jobID?: string; troopID?: string; lootType?: string; lootValue?: string; doorType?: string }
const bounded = (value: string) => value.length > SUMMARY_TEXT_LIMIT ? `${value.slice(0, SUMMARY_TEXT_LIMIT)}...` : value
const property = (node: JsonNode | undefined, field: string) => node ? objectProperty(node, field) : undefined
export function entityInteger(node: JsonNode | undefined): string | undefined {
  if (node?.kind !== 'number' || !/^-?\d+$/.test(node.raw)) return undefined
  const value = BigInt(node.raw)
  return value >= CSHARP_INT_MIN && value <= CSHARP_INT_MAX ? value.toString() : undefined
}
const integer = entityInteger
function text(node: JsonNode | undefined): string | undefined { const value = node?.kind === 'string' ? node.value : undefined; return typeof value === 'string' && value.length ? bounded(value) : undefined }
function summary(facts: Facts, lookup: EntityRelatedLookup): EntityLabel {
  let name = facts.name
  let nameSource = facts.nameSource
  if (!name && facts.type === 'Crystal' && facts.jobID !== undefined) { name = lookup('ModelJob', facts.jobID); nameSource = `CrystalData.JobID ${bounded(facts.jobID)}` }
  if (!name && facts.type === 'Spark' && facts.troopID !== undefined) { name = lookup('ModelTroop', facts.troopID); nameSource = `SparkData.TroopPages[0].TroopID ${bounded(facts.troopID)}` }
  if (!name && facts.type === 'Door') { name = facts.doorType; nameSource = 'DoorData.DoorType' }
  if (!name && facts.type === 'Treasure') {
    if (facts.lootType === 'Nothing') name = 'Empty'
    else if (facts.lootValue !== undefined && facts.lootType === 'Currency') name = `$${bounded(facts.lootValue)}`
    else if (facts.lootValue !== undefined && (facts.lootType === 'Item' || facts.lootType === 'Equipment')) name = lookup(facts.lootType === 'Item' ? 'ModelItem' : 'ModelEquipment', facts.lootValue)
    nameSource = `TreasureData.${facts.lootType ?? 'unknown loot type'}${facts.lootValue === undefined ? '' : ` ${bounded(facts.lootValue)}`}`
  }
  const biome = facts.biome ?? (facts.biomeID !== undefined ? lookup('ModelBiome', facts.biomeID) : undefined)
  const location = `${biome ? bounded(biome) : 'Biome unknown'}${facts.biomeID === undefined ? '' : ` (BiomeID ${bounded(facts.biomeID)})`}; Coord (${facts.coord.map(value => value === undefined ? '?' : bounded(value)).join(', ')})`
  return { label: `${facts.type ?? 'Unknown entity type'}${name ? `: ${bounded(name)}` : ' (name unknown)'}`, detail: `${location}; ${name ? `Name from ${nameSource ?? 'stored field'}` : `Name unavailable${nameSource ? ` (${nameSource})` : ''}; type fallback only`}`, status: facts.type ? 'resolved' : 'unknown' }
}

export function labelModEntity(node: JsonNode, lookup: EntityRelatedLookup): EntityLabel {
  const typeCode = integer(property(node, 'EntityType'))
  const facts: Facts = { type: typeCode === undefined ? undefined : ENTITY_TYPES[typeCode], biomeID: integer(property(node, 'BiomeID')), coord: ['X', 'Y', 'Z'].map(axis => integer(property(property(node, 'Coord'), axis))) }
  if (facts.biomeID !== undefined && (BigInt(facts.biomeID) < 0n || BigInt(facts.biomeID) > BIOME_ID_MAX)) facts.biomeID = undefined
  const nested = (field: string) => property(node, `${field}Data`)
  if (facts.type === 'Npc') {
    const npc = nested('Npc')
    const outfits = property(npc, 'Outfits')
    const outfit = outfits?.kind === 'array' ? childAt(outfits, 0) : undefined
    for (const [candidate, source] of [[property(npc, 'Key'), 'NpcData.Key'], [property(outfit, 'Name'), 'NpcData.Outfits[0].Name'], [property(outfit, 'TextureKey'), 'NpcData.Outfits[0].TextureKey']] as const) { const name = text(candidate); if (name) { facts.name = name; facts.nameSource = source; break } }
  } else if (facts.type === 'Sign') {
    facts.name = text(property(nested('Sign'), 'Title')); facts.nameSource = 'SignData.Title'
    if (!facts.name) { const message = text(property(nested('Sign'), 'Message')); if (message) { facts.name = message.split('\r', 1)[0]!.slice(0, SIGN_EXCERPT_LENGTH); facts.nameSource = 'SignData.Message excerpt' } }
  } else if (facts.type === 'HomePoint' || facts.type === 'Marker') { const field = facts.type === 'HomePoint' ? 'Name' : 'Key'; facts.name = text(property(nested(facts.type), field)); facts.nameSource = `${facts.type}Data.${field}` }
  else if (facts.type === 'Crystal') facts.jobID = integer(property(nested('Crystal'), 'JobID'))
  else if (facts.type === 'Spark') { const pages = property(nested('Spark'), 'TroopPages'); facts.troopID = integer(property(pages?.kind === 'array' ? childAt(pages, 0) : undefined, 'TroopID')) }
  else if (facts.type === 'Door') { const value = integer(property(nested('Door'), 'DoorType')); facts.doorType = value === undefined ? undefined : DOOR_TYPES[value] }
  else if (facts.type === 'Treasure') { const value = integer(property(nested('Treasure'), 'LootType')); facts.lootType = value === undefined ? undefined : LOOT_TYPES[value]; facts.lootValue = integer(property(nested('Treasure'), 'LootValue')) }
  return summary(facts, lookup)
}

export function labelBaseEntity(record: BaseEntityRecord, lookup: EntityRelatedLookup): EntityLabel {
  const facts: Facts = { type: record.EntityType, name: record.NameSource === 'EntityType' ? undefined : bounded(record.Name), nameSource: record.NameSource, biome: bounded(record.BiomeName), biomeID: String(record.BiomeID), coord: [record.Coord.X, record.Coord.Y, record.Coord.Z].map(String), jobID: record.JobID == null ? undefined : String(record.JobID), troopID: record.TroopIDs?.[0] === undefined ? undefined : String(record.TroopIDs[0]), lootType: record.LootType, lootValue: record.LootValue === undefined ? undefined : String(record.LootValue), doorType: record.DoorType }
  if (!facts.name && facts.type === 'Npc') {
    for (const [name, source] of [[record.NpcKey, 'NpcData.Key'], [record.NpcOutfitNames?.[0], 'NpcData.Outfits[0].Name'], [record.NpcOutfitTextureKeys?.[0], 'NpcData.Outfits[0].TextureKey']] as const) if (name) { facts.name = bounded(name); facts.nameSource = source; break }
  }
  return summary(facts, lookup)
}
