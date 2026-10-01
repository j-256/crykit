import { describe, expect, it } from 'vitest'
import { parseDocument } from './document'
import { labelBaseEntity, labelModEntity, type BaseEntityRecord } from './entity-label'

const labels: Readonly<Record<string, string>> = { 'ModelJob:7': 'Synthetic job', 'ModelItem:8': 'Synthetic item', 'ModelEquipment:9': 'Synthetic equipment', 'ModelTroop:10': 'Synthetic troop', 'ModelBiome:1': 'Synthetic biome' }
const lookup = (model: string, id: string) => labels[`${model}:${id}`]
const label = (record: unknown) => labelModEntity(parseDocument(JSON.stringify(record)).root, lookup)

describe('source-backed entity labels', () => {
  it('uses the NPC key and only the first outfit fallback with exact coordinates', () => {
    expect(label({ EntityType: 0, BiomeID: 1, Coord: { X: -2, Y: 3, Z: 4 }, NpcData: { Key: 'Synthetic key', Outfits: [{ Name: 'Other' }] } })).toMatchObject({ label: 'Npc: Synthetic key', detail: expect.stringContaining('Synthetic biome (BiomeID 1); Coord (-2, 3, 4)') })
    expect(label({ EntityType: 0, NpcData: { Outfits: [{ TextureKey: 'Actor/Synthetic' }, { Name: 'Do not select second outfit' }] } }).label).toBe('Npc: Actor/Synthetic')
  })
  it('resolves related jobs, first troop, items and equipment without guessing unknown IDs', () => {
    expect(label({ EntityType: 6, CrystalData: { JobID: 7 } }).label).toBe('Crystal: Synthetic job')
    expect(label({ EntityType: 2, SparkData: { TroopPages: [{ TroopID: 10 }, { TroopID: 999 }] } }).label).toBe('Spark: Synthetic troop')
    expect(label({ EntityType: 5, TreasureData: { LootType: 1, LootValue: 8 } }).label).toBe('Treasure: Synthetic item')
    expect(label({ EntityType: 5, TreasureData: { LootType: 2, LootValue: 9 } }).label).toBe('Treasure: Synthetic equipment')
    expect(label({ EntityType: 5, TreasureData: { LootType: 3, LootValue: 123 } }).label).toBe('Treasure: $123')
    expect(label({ EntityType: 5, TreasureData: { LootType: 0 } }).label).toBe('Treasure: Empty')
    expect(label({ EntityType: 5, TreasureData: { LootType: 1, LootValue: 999 } }).label).toBe('Treasure (name unknown)')
  })
  it('keeps missing, malformed and out-of-range fields unknown without deriving type from nested data', () => {
    expect(label({ Name: 'Not serialized editor header', CrystalData: { JobID: 7 } })).toMatchObject({ label: 'Unknown entity type (name unknown)', status: 'unknown' })
    const invalid = label({ EntityType: 6, BiomeID: 256, Coord: { X: 2147483648, Y: '3', Z: null }, CrystalData: { JobID: 9007199254740993 } })
    expect(invalid.label).toBe('Crystal (name unknown)')
    expect(invalid.detail).toContain('Biome unknown; Coord (?, ?, ?)')
    expect(label({ EntityType: '0', NpcData: { Key: 'Ignored' } }).status).toBe('unknown')
  })
  it('bounds arbitrary name text and preserves the source document', () => {
    const text = JSON.stringify({ EntityType: 0, NpcData: { Key: 'X'.repeat(5000) } })
    const document = parseDocument(text)
    expect(labelModEntity(document.root, lookup).label.length).toBeLessThan(200)
    expect(document.text).toBe(text)
  })
  it('uses retained baseline NPC texture keys and marks omitted sign names explicitly', () => {
    const base: BaseEntityRecord = { ID: 1, Name: 'Npc', NameSource: 'EntityType', EntityType: 'Npc', BiomeID: 1, BiomeName: 'Synthetic biome', Coord: { X: 0, Y: 0, Z: 0 }, NpcOutfitTextureKeys: ['Actor/Synthetic'] }
    expect(labelBaseEntity(base, lookup).label).toBe('Npc: Actor/Synthetic')
    expect(labelBaseEntity({ ...base, EntityType: 'Sign', Name: 'Sign' }, lookup).detail).toContain('Name unavailable')
  })
})
