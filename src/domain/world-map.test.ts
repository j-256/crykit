import { describe, expect, it } from 'vitest'
import { composeWorldMap, createWorldSpatialIndex, filterWorldMarkers, markerSearch, queryWorldSpatialIndex, worldMapClusters, worldMapModLayer, worldMapTargetRef } from './world-map'
import type { WorldMapManifest, WorldMapModLayer, WorldMarker } from './world-map'
import type { CatalogSnapshot } from './types'

function marker(entityId: number, overrides: Partial<WorldMarker> = {}): WorldMarker {
  return { id: `base:entity:${entityId}`, entityId, kind: 'chest', sourceId: 'base', sourceName: 'Vanilla', change: 'base', name: 'Potion', region: 'Synthetic meadow', biomeId: 1, layer: 0, x: entityId, y: 100, z: entityId, description: 'Treasure chest containing Potion', targets: [{ family: 'item', id: 4, name: 'Potion', sourceId: 'base' }], ...overrides }
}
function manifest(markers: readonly WorldMarker[] = [marker(1)]): WorldMapManifest {
  return { schemaVersion: 1, source: { platform: 'Windows', gameVersion: '1.6.9' }, bounds: { x: -100, z: -100, width: 200, height: 200 }, layers: [{ id: 0, label: 'Overworld', image: 'layer-0.png' }], regions: [{ id: 1, name: 'Synthetic meadow', layer: 0, x: 0, z: 0 }], markers, definitions: [{ family: 'item', id: 4, name: 'Potion', sourceId: 'base' }, { family: 'monster', id: 7, name: 'Synthetic boss', sourceId: 'base', record: { ID: 7, Name: 'Synthetic boss', IsBoss: true } }, { family: 'monster', id: 8, name: 'Synthetic slime', sourceId: 'base', record: { ID: 8, Name: 'Synthetic slime', IsBoss: false } }, { family: 'troop', id: 9, name: 'Synthetic troop', sourceId: 'base', record: { ID: 9, Name: 'Synthetic troop', Members: [{ MonsterID: 7 }] } }] }
}
function mod(root: unknown, sourceId = 'mod-a', revisionId = 'revision-a'): WorldMapModLayer { return worldMapModLayer({ sourceId, sourceName: sourceId, revisionId }, root) }
function chest(id: number, overrides = {}): unknown { return { ID: id, Coord: { X: 10, Y: 100, Z: 20 }, BiomeID: 1, EntityType: 5, TreasureData: { LootType: 1, LootValue: 4 }, ...overrides } }

describe('world map mod composition', () => {
  it('keeps stable world identities and applies the last selected layer without duplicate replacements', () => {
    const base = manifest()
    const a = mod({ Entities: [chest(1), chest(5000)] })
    const b = mod({ Entities: [chest(1, { Coord: { X: -30, Y: 200, Z: 40 }, TreasureData: { LootType: 2, LootValue: 50 } })], Equipment: [{ ID: 50, Name: 'Synthetic sword' }] }, 'mod-b')
    const result = composeWorldMap(base, [a, b])
    expect(result.markers).toHaveLength(2)
    expect(result.markers.find(value => value.entityId === 1)).toMatchObject({ id: 'base:entity:1', name: 'Synthetic sword', sourceId: 'mod-b', sourceRevisionId: 'revision-a', change: 'modified', x: -30, y: 200, z: 40 })
    expect(result.markers.find(value => value.entityId === 5000)).toMatchObject({ sourceId: 'mod-a', change: 'added' })
    expect(composeWorldMap(base, [b, a]).markers.find(value => value.entityId === 1)?.sourceId).toBe('mod-a')
    expect(base.markers[0]).toEqual(marker(1))
  })

  it('projects definition-only changes into base markers and keeps exact revision provenance', () => {
    const result = composeWorldMap(manifest(), [mod({ Items: [{ ID: 4, Name: 'Changed potion' }] }, 'mod-items', 'older-pin')])
    expect(result.markers[0]).toMatchObject({ id: 'base:entity:1', sourceId: 'mod-items', sourceRevisionId: 'older-pin', change: 'modified', name: 'Changed potion', targets: [{ family: 'item', id: 4, name: 'Changed potion', sourceId: 'mod-items', sourceRevisionId: 'older-pin' }] })
  })

  it('retains unknown layer and region without assigning N/A placements to the overworld', () => {
    const result = composeWorldMap(manifest([]), [mod({ Entities: [chest(30, { BiomeID: 0 })] })])
    expect(result.markers[0]).toMatchObject({ biomeId: 0, region: null, layer: null, x: 10, z: 20 })
    expect(result.markers[0]!.warnings).toContain('Region and map layer are unresolved; coordinates are retained')
    expect(filterWorldMarkers(result.markers, { layer: 0 })).toEqual([])
    expect(filterWorldMarkers(result.markers, { layer: null })).toHaveLength(1)
  })

  it('removes ambiguous native placement replacements instead of restoring a vanilla location', () => {
    const result = composeWorldMap(manifest(), [mod({ Entities: [chest(1), chest(1, { Coord: { X: 30, Y: 100, Z: 20 } })] })])
    expect(result.markers).toEqual([])
    expect(result.warnings.join(' ')).toContain('Duplicate Entities #1 is ambiguous')
  })

  it('omits invalid coordinates, warns on duplicate IDs and unresolved targets, and never guesses a replacement', () => {
    const invalid = mod({ Entities: [chest(1, { Coord: { X: 10, Z: 20 } }), chest(50), chest(50), chest(60, { TreasureData: { LootType: 2, LootValue: 999 } })] })
    const result = composeWorldMap(manifest(), [invalid])
    expect(result.markers.map(value => value.entityId)).toEqual([60])
    expect(result.warnings.join(' ')).toContain('Duplicate Entities #50')
    expect(result.warnings.join(' ')).toContain('unresolved coordinates')
    expect(result.markers[0]!.targets[0]).toMatchObject({ sourceId: 'unresolved', name: 'equipment #999 (unresolved)' })
    expect(result.markers[0]!.warnings).toContain('equipment #999 is unresolved')
  })

  it('distinguishes empty chests from copper and guards unsupported custom assets', () => {
    const result = composeWorldMap(manifest(), [mod({ HasCustomContent: true, Entities: [chest(1, { TreasureData: { LootType: 0, LootValue: 0 } }), chest(2, { TreasureData: { LootType: 3, LootValue: 123 } })] })])
    expect(result.markers[0]).toMatchObject({ name: 'Empty chest', targets: [], change: 'modified' })
    expect(result.markers[1]).toMatchObject({ name: 'Currency chest', description: '1 silver, 23 copper' })
    expect(result.warnings.join(' ')).toContain('terrain')
  })

  it('resolves placed and conditional scripted battles through overridden troops and monster flags', () => {
    const battle = { ID: 40, Coord: { X: 1, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 2, SparkData: { SparkID: 1, TroopPages: [{ TroopID: 9, Condition: null }] } }
    const npc = { ID: 41, Coord: { X: 2, Y: 100, Z: 2 }, BiomeID: 1, EntityType: 0, NpcData: { Key: 'synthetic-boss-npc', Outfits: [{ Name: 'Gatekeeper', TextureKey: 'synthetic' }], Pages: [{ Condition: { ConditionType: 3, Data: { VariableKey: 'synthetic-unlock' } }, Actions: [{ ActionType: 3, Data: { Condition: { ConditionType: 4, Data: { VariableKey: 'synthetic-level' } }, ConditionActionsTrue: [{ ActionType: 27, Data: { TroopID: 9 } }] } }] }] } }
    const result = composeWorldMap(manifest([]), [mod({ Entities: [battle, npc] })])
    expect(result.markers.map(value => value.kind)).toEqual(['boss', 'boss'])
    expect(result.markers[1]!.conditions).toEqual(expect.arrayContaining(['Requires story condition synthetic-unlock', 'Requires story condition synthetic-level']))
    expect(result.markers[0]!.targets.map(target => target.name)).toEqual(['Synthetic troop', 'Synthetic boss'])
    const overridden = composeWorldMap(manifest([]), [mod({ Entities: [battle, npc] }), mod({ Troops: [{ ID: 9, Name: 'Changed troop', Members: [{ MonsterID: 8 }] }] }, 'mod-troops')])
    expect(overridden.markers.map(value => value.kind)).toEqual(['encounter', 'encounter'])
    expect(overridden.markers[0]!.targets.map(target => target.name)).toEqual(['Changed troop', 'Synthetic slime'])
  })

  it('extracts nested shop stock and rewards while excluding invisible script helpers', () => {
    const entity = { ID: 40, Coord: { X: 1, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 0, NpcData: { Key: 'synthetic-shop', Outfits: [{ Name: 'Synthetic merchant', TextureKey: 'synthetic' }], Pages: [{ Actions: [{ ActionType: 3, Data: { ConditionActionsTrue: [{ ActionType: 5, Data: { Stock: [{ LootType: 1, LootValue: 4 }] } }, { ActionType: 8, Data: { LootType: 2, LootValue: 50 } }] } }] }] } }
    const helper = { ...entity, ID: 41, NpcData: { Key: 'invisible-helper', Outfits: [{ TextureKey: null }], Pages: [] } }
    const result = composeWorldMap(manifest([]), [mod({ Entities: [entity, helper], Equipment: [{ ID: 50, Name: 'Synthetic shield' }] })])
    expect(result.markers).toHaveLength(1)
    expect(result.markers[0]).toMatchObject({ kind: 'shop', name: 'Synthetic merchant' })
    expect(result.markers[0]!.targets.map(target => target.name)).toEqual(['Potion', 'Synthetic shield'])
  })

  it('updates base boss classification when a monster override removes its boss status', () => {
    const base = manifest([marker(1, { kind: 'boss', name: 'Synthetic boss', targets: [{ family: 'monster', id: 7, name: 'Synthetic boss', sourceId: 'base' }] })])
    const result = composeWorldMap(base, [mod({ Monsters: [{ ID: 7, Name: 'Ordinary enemy', IsBoss: false }] })])
    expect(result.markers[0]).toMatchObject({ kind: 'encounter', name: 'Ordinary enemy', change: 'modified', sourceId: 'mod-a' })
  })

  it('replaces base encounter members when a mod changes a troop without editing its placement', () => {
    const base = manifest([marker(1, { kind: 'boss', name: 'Synthetic boss', targets: [{ family: 'troop', id: 9, name: 'Synthetic troop', sourceId: 'base' }, { family: 'monster', id: 7, name: 'Synthetic boss', sourceId: 'base' }] })])
    const result = composeWorldMap(base, [mod({ Troops: [{ ID: 9, Name: 'Changed troop', Members: [{ MonsterID: 8 }] }] })])
    expect(result.markers[0]).toMatchObject({ kind: 'encounter', name: 'Synthetic slime', change: 'modified', sourceId: 'mod-a' })
    expect(result.markers[0]!.targets.map(target => [target.family, target.id])).toEqual([['troop', 9], ['monster', 8]])
  })

  it('marks region name overrides while keeping native terrain layer assignments', () => {
    const result = composeWorldMap(manifest(), [mod({ Biomes: [{ ID: 1, Name: 'Changed meadow' }] })])
    expect(result.markers[0]).toMatchObject({ region: 'Changed meadow', layer: 0, change: 'modified', sourceId: 'mod-a' })
    expect(result.regions[0]).toMatchObject({ name: 'Changed meadow', layer: 0, sourceId: 'mod-a', sourceName: 'mod-a', sourceRevisionId: 'revision-a', change: 'modified' })
  })

  it('preserves unknown boss flags and warns on incomplete troop definitions', () => {
    const base = manifest([marker(1, { kind: 'boss', name: 'Synthetic boss', targets: [{ family: 'troop', id: 9, name: 'Synthetic troop', sourceId: 'base' }, { family: 'monster', id: 7, name: 'Synthetic boss', sourceId: 'base' }] })])
    const unnamedFlag = composeWorldMap(base, [mod({ Monsters: [{ ID: 7, Name: 'Flag unspecified' }] })])
    expect(unnamedFlag.markers[0]?.kind).toBe('boss')
    expect(unnamedFlag.markers[0]?.warnings).toContain('Encounter boss classification is unresolved')
    const incompleteTroop = composeWorldMap(base, [mod({ Troops: [{ ID: 9, Name: 'Members unspecified' }] })])
    expect(incompleteTroop.markers[0]?.kind).toBe('boss')
    expect(incompleteTroop.markers[0]?.warnings).toContain('Troop #9 has unresolved member definitions')
  })

  it('keeps independently added entity and equipment IDs local to each mod project', () => {
    const a = mod({ Entities: [chest(5000, { TreasureData: { LootType: 2, LootValue: 900 } })], Equipment: [{ ID: 900, Name: 'A blade' }] }, 'project-a')
    const b = mod({ Entities: [chest(5000, { TreasureData: { LootType: 2, LootValue: 900 } })], Equipment: [{ ID: 900, Name: 'B blade' }] }, 'project-b')
    const result = composeWorldMap(manifest([]), [a, b])
    expect(result.markers).toHaveLength(2)
    expect(result.markers.map(marker => [marker.id, marker.name, marker.targets[0]?.sourceId])).toEqual([['project-a:entity:5000', 'A blade', 'project-a'], ['project-b:entity:5000', 'B blade', 'project-b']])
    expect(result.markers.every(marker => marker.change === 'added')).toBe(true)
  })

  it('keeps new troop and monster references scoped to their originating project', () => {
    const entity = { ID: 5000, Coord: { X: 1, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 2, SparkData: { TroopPages: [{ TroopID: 900 }] } }
    const a = mod({ Entities: [entity], Troops: [{ ID: 900, Name: 'A troop', Members: [{ MonsterID: 900 }] }], Monsters: [{ ID: 900, Name: 'A boss', IsBoss: true }] }, 'project-a')
    const b = mod({ Entities: [entity], Troops: [{ ID: 900, Name: 'B troop', Members: [{ MonsterID: 900 }] }], Monsters: [{ ID: 900, Name: 'B slime', IsBoss: false }] }, 'project-b')
    const result = composeWorldMap(manifest([]), [a, b])
    expect(result.markers.map(marker => [marker.kind, marker.name])).toEqual([['boss', 'A boss'], ['encounter', 'B slime']])
  })

  it('classifies authored mining, ground pickups, gardens, and voxel objects without relabeling quest NPCs', () => {
    const npc = (id: number, outfit: Record<string, unknown>, actions: readonly unknown[]) => ({ ID: id, Coord: { X: id, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 0, NpcData: { Key: `script-${id}`, Outfits: [outfit], Pages: [{ Actions: actions }] } })
    const reward = { ActionType: 8, Data: { LootType: 1, LootValue: 4 } }
    const mining = npc(5000, { TextureKey: 'Actor/Node_Silver', Name: null }, [{ ActionType: 59 }, reward])
    const pickup = npc(5001, { TextureKey: 'Actor/Effect_Sparkle', Name: null }, [reward])
    const garden = npc(5002, { VoxelID: 10, Name: null }, [{ ActionType: 71 }])
    const object = npc(5003, { VoxelID: 20, Name: null }, [])
    const quest = npc(5004, { TextureKey: 'Actor/Npc_WandererMaleA', Name: 'Quest giver' }, [reward])
    const decorativeEffect = npc(5005, { TextureKey: 'Actor/Effect_Fire', Name: null }, [reward])
    const base = manifest([])
    const result = composeWorldMap({ ...base, source: { ...base.source, voxelNames: { '20': 'Lever' } } }, [mod({ Entities: [mining, pickup, garden, object, quest, decorativeEffect] })])
    expect(result.markers.map(marker => [marker.kind, marker.name])).toEqual([['resource', 'Potion node'], ['resource', 'Potion pickup'], ['resource', 'Garden plot'], ['object', 'Lever'], ['npc', 'Quest giver'], ['object', 'Interaction point']])
    expect(result.markers[0]!.description).toContain('Mining node')
    expect(result.markers[1]!.description).toContain('Ground pickup')
    expect(result.markers[4]!.targets[0]!.name).toBe('Potion')
  })

  it('keeps shops and scripted bosses ahead of resource or object appearance', () => {
    const entity = (id: number, actions: readonly unknown[]) => ({ ID: id, Coord: { X: id, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 0, NpcData: { Key: `script-${id}`, Outfits: [{ VoxelID: 20, TextureKey: 'Actor/Effect_Sparkle', Name: 'Merchant' }], Pages: [{ Actions: actions }] } })
    const reward = { ActionType: 8, Data: { LootType: 1, LootValue: 4 } }
    const shop = entity(5000, [reward, { ActionType: 5, Data: { Stock: [{ LootType: 1, LootValue: 4 }] } }])
    const boss = entity(5001, [reward, { ActionType: 27, Data: { TroopID: 9 } }])
    expect(composeWorldMap(manifest([]), [mod({ Entities: [shop, boss] })]).markers.map(marker => marker.kind)).toEqual(['shop', 'boss'])
  })

  it('retains each linked NPC own outfits and pages instead of inheriting its peer', () => {
    const npc = (id: number, key: string, linkedKey: string, name: string, actions: readonly unknown[]) => ({ ID: id, Coord: { X: id, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 0, NpcData: { Key: key, LinkedKey: linkedKey, Outfits: [{ TextureKey: 'Actor/Npc_WandererMaleA', Name: name }], Pages: [{ Actions: actions }] } })
    const girl = npc(5000, 'girl', 'boy', 'Girl', [{ ActionType: 8, Data: { LootType: 1, LootValue: 4 } }])
    const boy = npc(5001, 'boy', 'girl', 'Boy', [{ ActionType: 5, Data: { Stock: [{ LootType: 1, LootValue: 4 }] } }])
    const result = composeWorldMap(manifest([]), [mod({ Entities: [girl, boy] })])
    expect(result.markers.map(marker => [marker.name, marker.kind])).toEqual([['Girl', 'npc'], ['Boy', 'shop']])
  })

  it('warns about explicitly changed biome geometry while retaining the native layer and region anchor', () => {
    const base = manifest()
    const baseline = { ...base, definitions: [...base.definitions!, { family: 'biome', id: 1, name: 'Synthetic meadow', sourceId: 'base', record: { ID: 1, Name: 'Synthetic meadow', MapLayer: 0, BaseID: 1, IsMapAlt: false, MapCenterXOverride: null, MapCenterYOverride: null } }] }
    const result = composeWorldMap(baseline, [mod({ Biomes: [{ ID: 1, Name: 'Moved meadow', MapLayer: 4, MapCenterXOverride: 100 }] })])
    expect(result.regions[0]).toMatchObject({ name: 'Moved meadow', layer: 0, x: 0, z: 0, sourceId: 'mod-a', change: 'modified' })
    expect(result.warnings.join(' ')).toContain('changes MapLayer, MapCenterXOverride')
    expect(result.warnings.join(' ')).toContain('region anchors are retained')
    expect(composeWorldMap(baseline, [mod({ Biomes: [{ ID: 1, Name: 'Renamed meadow' }] })]).warnings).toEqual([])
  })

  it('does not infer a battle from an unrelated action containing a troop-shaped field', () => {
    const entity = { ID: 5000, Coord: { X: 1, Y: 100, Z: 1 }, BiomeID: 1, EntityType: 0, NpcData: { Key: 'synthetic', Outfits: [{ TextureKey: 'Actor/Npc_WandererMaleA', Name: 'Synthetic NPC' }], Pages: [{ Actions: [{ ActionType: 999, Data: { TroopID: 9 } }] }] } }
    const marker = composeWorldMap(manifest([]), [mod({ Entities: [entity] })]).markers[0]
    expect(marker?.kind).toBe('npc')
    expect(marker?.targets).toEqual([])
  })
})

describe('world map search and rendering bounds', () => {
  it('searches content, region, source, and stable IDs with all query terms', () => {
    const sample = marker(12, { sourceName: 'Synthetic Equipment', targets: [{ family: 'equipment', id: 10, name: 'Hidden blade', sourceId: 'mod-a' }] })
    expect(markerSearch(sample, 'blade meadow')).toBe(true)
    expect(markerSearch(sample, '12 equipment')).toBe(true)
    expect(markerSearch(sample, 'blade dungeon')).toBe(false)
    expect(filterWorldMarkers([sample, marker(13, { kind: 'boss' })], { query: 'blade', kinds: ['chest'], sourceIds: ['base'] })).toEqual([sample])
  })

  it('queries negative coordinates and includes viewport edges without leaking offscreen points', () => {
    const points = [marker(1, { x: -32, z: -32 }), marker(2, { x: 0, z: 0 }), marker(3, { x: 32, z: 32 }), marker(4, { x: 33, z: 0 })]
    const index = createWorldSpatialIndex(points)
    expect(queryWorldSpatialIndex(index, { x: -32, z: -32, width: 64, height: 64 })).toEqual(expect.arrayContaining(points.slice(0, 3)))
    expect(queryWorldSpatialIndex(index, { x: -32, z: -32, width: 64, height: 64 })).toHaveLength(3)
    expect(queryWorldSpatialIndex(index, { x: 0, z: 0, width: -1, height: 10 })).toEqual([])
  })

  it('reveals detail as zoom increases and keeps every candidate within the render group limit', () => {
    const points = [marker(1, { x: 0, z: 0, kind: 'crystal' }), marker(2, { x: 50, z: 50, kind: 'npc' }), marker(3, { x: 100, z: 100, kind: 'sign' }), marker(4, { x: -100, z: -100, kind: 'encounter' })]
    expect(worldMapClusters(points, { zoom: 1, pixelsPerUnit: 1 }).flatMap(cluster => cluster.markers.map(value => value.kind))).toEqual(['crystal'])
    expect(worldMapClusters(points, { zoom: 3, pixelsPerUnit: 1 }).flatMap(cluster => cluster.markers.map(value => value.kind))).toEqual(['crystal', 'npc'])
    const close = worldMapClusters(points, { zoom: 8, pixelsPerUnit: 10, maxGroups: 1 })
    expect(close).toHaveLength(1)
    expect(close[0]!.markers).toHaveLength(4)
    expect(close[0]!.kind).toBe('crystal')
    const many = Array.from({ length: 1000 }, (_, id) => marker(id, { x: (id % 100) * 5, z: Math.floor(id / 100) * 5 }))
    const capped = worldMapClusters(many, { zoom: 8, pixelsPerUnit: 100, maxGroups: 30 })
    expect(capped.length).toBeLessThanOrEqual(30)
    expect(capped.flatMap(cluster => cluster.markers)).toHaveLength(many.length)
    expect(worldMapClusters(points, { zoom: 8, pixelsPerUnit: 0 })).toEqual([])
  })

  it('keeps mixed marker hit targets apart across spatial cell boundaries', () => {
    const points = [marker(1, { x: 51, z: 0, kind: 'crystal' }), marker(2, { x: 53, z: 0, kind: 'chest' }), marker(3, { x: 53, z: 1, kind: 'boss' }), marker(4, { x: 105, z: 0, kind: 'chest' })]
    const groups = worldMapClusters(points, { zoom: 8, pixelsPerUnit: 1 })
    expect(groups.flatMap(group => group.markers)).toHaveLength(points.length)
    expect(groups).toHaveLength(2)
    for (let index = 0; index < groups.length; index++) for (const other of groups.slice(index + 1)) expect(Math.hypot(groups[index]!.x - other.x, groups[index]!.z - other.z)).toBeGreaterThanOrEqual(52)
  })

  it('links imported targets to the exact pinned revision', () => {
    const catalog = (revisionId: string) => ({ id: 'mod-a', revisionId, entities: { item: { id: 'item', kind: 'item', name: revisionId, fields: { 'Crystal Edit model ID': { state: 'known', value: 4 }, 'Crystal Edit model type': { state: 'known', value: 'Items' } } } } } as unknown as CatalogSnapshot)
    const ref = worldMapTargetRef({ family: 'item', id: 4, name: 'Pinned potion', sourceId: 'mod-a', sourceRevisionId: 'older' }, [catalog('newer'), catalog('older')])
    expect(ref?.catalogRevisionId).toBe('older')
  })

  it('links bundled source previews only when the project and original source digest match', () => {
    const catalog = (id: string, checksum: string) => ({ id, revisionId: `${checksum}:parser-version`, checksum, entities: { item: { id: 'item', kind: 'item', name: 'Pinned potion', fields: { 'Crystal Edit model ID': { state: 'known', value: 4 }, 'Crystal Edit model type': { state: 'known', value: 'Items' } } } } } as unknown as CatalogSnapshot)
    const target = { family: 'item', id: 4, name: 'Pinned potion', sourceId: 'mod-a', sourceRevisionId: 'sha256:original' }
    const wrongSources = [catalog('mod-a', 'sha256:different'), catalog('mod-b', 'sha256:original')]
    expect(worldMapTargetRef(target, wrongSources)).toBeUndefined()
    expect(worldMapTargetRef(target, [...wrongSources, catalog('mod-a', 'sha256:original')])).toMatchObject({ catalogId: 'mod-a', catalogRevisionId: 'sha256:original:parser-version', entityId: 'item' })
  })
})
