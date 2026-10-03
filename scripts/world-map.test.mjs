import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { zipSync } from 'fflate'
import { contentDigest } from './update-entity-reference.mjs'
import { validateWorldMap } from './update-world-map.mjs'
import { readMapArchive, readMapHeader, readTerrainMaps, composeTerrain, renderTerrain, mapRegions, projectMapMarkers } from './lib/world-map.mjs'

function metadata(id, x = 0, z = 0, width = 2, height = 2) {
  const data = Buffer.alloc(37)
  data[0] = 2
  ;[id, x, z, width, height, 64, 64, Math.ceil(width / 64), Math.ceil(height / 64)].forEach((value, index) => data.writeInt32LE(value, 1 + index * 4))
  return data
}
function archive(entries) { return Buffer.concat([Buffer.from([5, 0]), zipSync(entries)]) }
const fields = { 'map/map_world/meta.dat': metadata(-1), 'map/map_world/region_0_0.dat': Buffer.from([2, 1, 7, 0, 2, 8, 1, 3, 9, 2, 4, 10, 3]) }

test('native map parser retains column-major region cells and rejects malformed bounds', () => {
  const maps = readTerrainMaps(readMapArchive(archive(fields)))
  assert.deepEqual([...maps[0].cells], [1, 7, 0, 3, 9, 2, 2, 8, 1, 4, 10, 3])
  for (const bytes of [Buffer.alloc(0), archive(fields).subarray(0, 25), archive(fields).subarray(1)]) assert.throws(() => readMapArchive(bytes))
  assert.throws(() => readMapHeader(metadata(1), 2), /identity/)
  assert.throws(() => readMapHeader(metadata(-1, 0, 0, 1_000_000, 1_000_000), -1), /dimensions/)
  assert.throws(() => readTerrainMaps(readMapArchive(archive({ ...fields, 'map/map_world/region_0_0.dat': Buffer.from([2, 1]) }))), /region/)
  const invalidLayout = metadata(-1)
  invalidLayout.writeInt32LE(3, 21)
  assert.throws(() => readMapHeader(invalidLayout, -1), /layout/)
})

test('native terrain composition keeps height priority, underwater precedence and exact layer identities', () => {
  const biomes = new Map([{ ID: 1, BaseID: 0, MapLayer: 0 }, { ID: 2, BaseID: 0, MapLayer: 1 }, { ID: 3, BaseID: 1, MapLayer: 1, IsMapAlt: false }].map(value => [value.ID, value]))
  const map = (id, type, height, params = 0) => ({ id, x: 0, z: 0, width: 1, height: 1, cells: Buffer.from([type, height, params]) })
  const bounds = { x: 0, z: 0, width: 1, height: 1 }
  assert.deepEqual([...composeTerrain([map(1, 246, 9), map(2, 4, 10), map(3, 5, 8, 4)], biomes, bounds, 0)], [5, 8, 4])
  assert.deepEqual([...composeTerrain([map(1, 5, 8, 4), map(3, 246, 9)], biomes, bounds, 0)], [5, 8, 4])
  assert.deepEqual([...composeTerrain([map(1, 5, 8), map(3, 6, 7)], biomes, bounds, 0)], [5, 8, 0])
  assert.deepEqual([...composeTerrain([map(1, 5, 8), map(2, 6, 7)], biomes, bounds, 1)], [6, 7, 0])
})

test('native atlas renderer uses point samples, preserves empty pixels and overlays water', () => {
  const atlas = { width: 432, height: 432, channels: 4, data: Buffer.alloc(432 * 432 * 4) }
  const sample = (x, z, rgba) => atlas.data.set(rgba, (z * 432 + x) * 4)
  for (const z of [3, 7, 11, 15]) for (const x of [3, 7, 11, 15]) sample(x, z, [200, 100, 50, 255])
  for (const z of [417, 421, 425, 429]) for (const x of [399, 403, 407, 411]) sample(x, z, [0, 100, 200, 255])
  const voxels = [null, { TexTopU: 0, TexTopV: 0 }]
  const bounds = { x: 0, z: 0, width: 1, height: 1 }
  assert.deepEqual([...renderTerrain(Buffer.from([1, 1, 0]), bounds, voxels, atlas).data.subarray(0, 4)], [200, 100, 50, 255])
  assert.deepEqual([...renderTerrain(Buffer.from([1, 1, 4]), bounds, voxels, atlas).data.subarray(0, 4)], [70, 100, 148, 255])
  assert.ok(renderTerrain(Buffer.from([255, 0, 0]), bounds, voxels, atlas).data.every(value => value === 0))
  assert.throws(() => renderTerrain(Buffer.from([2, 1, 0]), bounds, voxels, atlas), /Unresolved/)
})

function markerFixture() {
  const databases = {
    biome: [{ ID: 0, Name: 'N/A', BaseID: 0, MapLayer: 0 }, { ID: 1, Name: 'Meadow', BaseID: 0, MapLayer: 0 }, { ID: 2, Name: 'Lower room', BaseID: 1, IsMapAlt: true, MapLayer: 5, MapCenterXOverride: 4, MapCenterYOverride: 6 }],
    item: [{ ID: 3, Name: 'Potion' }], equipment: [{ ID: 4, Name: 'Sword' }], job: [{ ID: 5, Name: 'Knight' }], recipe: [],
    troop: [{ ID: 6, Name: 'Boss troop', Members: [{ MonsterID: 7 }] }], monster: [{ ID: 7, Name: 'Guardian', IsBoss: true }],
  }
  const entity = (ID, EntityType, data, BiomeID = 1) => ({ ID, EntityType, BiomeID, Coord: { X: 1, Y: 2, Z: 3 }, ...data })
  const always = { ConditionType: 'Always', IsNegation: false }
  const npc = (outfits, actions) => ({ NpcData: { Outfits: outfits, Pages: [{ Condition: always, Actions: actions }] } })
  const entities = [
    entity(1, 'Treasure', { TreasureData: { LootType: 'Equipment', LootValue: 4 } }),
    entity(2, 'Npc', npc([], [])),
    entity(3, 'Npc', npc([{ Name: '@Friend', TextureKey: null, VoxelID: null, Condition: always }], [{ ActionType: 'Condition', Data: { Condition: { ConditionType: 'CheckFlag', Data: { VariableKey: 'Gate' } }, ConditionActionsTrue: [{ ActionType: 'Battle', Data: { TroopID: 6 } }] } }])),
    entity(4, 'Npc', npc([{ Name: 'Trader', TextureKey: 'Npc/Trader', Condition: always }], [{ ActionType: 'Shop', Data: { Stock: [{ LootType: 'Item', LootValue: 3 }] } }])),
    entity(5, 'Treasure', { TreasureData: { LootType: 'Nothing', LootValue: 0 } }, 0),
    entity(6, 'Crystal', { CrystalData: { JobID: 5 } }),
    entity(7, 'Marker', { MarkerData: { Key: 'Invisible camera anchor' } }),
    entity(8, 'HomePoint', { HomePointData: { Name: '@Z1.Name camp' } }),
    entity(9, 'Treasure', { TreasureData: { LootType: 'Currency', LootValue: 10123 } }),
    entity(10, 'Npc', npc([{ Name: null, TextureKey: 'Actor/Node_Silver', Condition: always }], [{ ActionType: 'PlaySEMineOre' }, { ActionType: 'AddInventory', Data: { LootType: 'Item', LootValue: 3 } }])),
    entity(11, 'Npc', npc([{ Name: null, TextureKey: null, VoxelID: 1, Condition: always }], [{ ActionType: 'PlaySESwitchPressed' }])),
    entity(12, 'Npc', npc([{ Name: null, TextureKey: 'Actor/Effect_Sparkle', Condition: always }], [{ ActionType: 'AddInventory', Data: { LootType: 'Item', LootValue: 3 } }])),
    entity(13, 'Npc', npc([{ Name: 'Friend', TextureKey: 'Actor/Npc_Example', Condition: always }], [{ ActionType: 'AddInventory', Data: { LootType: 'Item', LootValue: 3 } }])),
    entity(14, 'Npc', npc([{ Name: '@M7.Name', TextureKey: 'Actor/Monster_Example', Condition: always }], [])),
    entity(15, 'HomePoint', { HomePointData: { Name: "\u0040C\u0040Friend.Name's room" } }),
    entity(16, 'Npc', npc([{ Name: '@Quintar0', TextureKey: null, Condition: always }], [])),
    entity(17, 'Npc', npc([{ Name: '@Seed0', VoxelID: 0, Condition: always }], [{ ActionType: 'Garden' }])),
  ]
  return { databases, entities }
}

test('marker projection identifies nested scripted bosses, shops and vocabulary without inventing layers', () => {
  const { databases, entities } = markerFixture()
  const biomes = new Map(databases.biome.map(value => [value.ID, value]))
  const regions = mapRegions([{ id: 1, x: 0, z: 0, width: 20, height: 10 }, { id: 2, x: 0, z: 0, width: 20, height: 10 }], biomes)
  assert.deepEqual(regions[1], { id: 2, name: 'Lower room', layer: 5, x: 4, z: 6 })
  const markers = projectMapMarkers(entities, databases, regions, { MainNpcs: [{ Key: '@Friend', Name: 'Friend' }] }, [null, { ID: 1, Name: 'Button' }])
  assert.equal(markers.some(marker => marker.entityId === 2 || marker.entityId === 7), false)
  assert.equal(markers.find(marker => marker.entityId === 3).kind, 'boss')
  assert.equal(markers.find(marker => marker.entityId === 3).name, 'Guardian')
  assert.equal(markers.find(marker => marker.entityId === 4).kind, 'shop')
  assert.deepEqual(markers.find(marker => marker.entityId === 4).targets[0], { family: 'item', id: 3, name: 'Potion', sourceId: 'base' })
  assert.equal(markers.find(marker => marker.entityId === 5).layer, null)
  assert.equal(markers.find(marker => marker.entityId === 5).region, null)
  assert.equal(markers.find(marker => marker.entityId === 6).name, 'Knight crystal')
  assert.equal(markers.find(marker => marker.entityId === 8).name, 'Meadow camp')
  assert.equal(markers.find(marker => marker.entityId === 9).description, '1 gold, 1 silver, 23 copper')
  assert.equal(markers.find(marker => marker.entityId === 10).kind, 'resource')
  assert.equal(markers.find(marker => marker.entityId === 10).name, 'Potion node')
  assert.equal(markers.find(marker => marker.entityId === 11).kind, 'object')
  assert.equal(markers.find(marker => marker.entityId === 11).name, 'Button')
  assert.equal(markers.find(marker => marker.entityId === 12).kind, 'resource')
  assert.equal(markers.find(marker => marker.entityId === 12).name, 'Potion pickup')
  assert.equal(markers.find(marker => marker.entityId === 13).kind, 'npc')
  assert.equal(markers.find(marker => marker.entityId === 14).name, 'Guardian')
  assert.equal(markers.find(marker => marker.entityId === 15).name, "Friend's room")
  assert.equal(markers.find(marker => marker.entityId === 16).name, 'Quintar (slot 1)')
  assert.equal(markers.find(marker => marker.entityId === 17).kind, 'resource')
  assert.equal(markers.find(marker => marker.entityId === 17).name, 'Garden plot 1')
  assert.ok(markers.find(marker => marker.entityId === 3).conditions.includes('Check Flag (Gate)'))
})

test('committed maps enforce source pins, chest coverage, coordinates, target identities and portable assets', async () => {
  const [snapshot, native, reference, schema] = await Promise.all(['src/catalog/world-map.json', 'src/catalog/native-game-data.json', 'src/mod-inspector/entity-reference.json', 'src/mod-inspector/reference-schema.json'].map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8').then(JSON.parse)))
  validateWorldMap(snapshot, native, reference, schema)
  for (const change of [
    value => { value.source.gameExecutableSha256 = '0'.repeat(64) },
    value => { value.source.voxel.sha256 = '0'.repeat(64) },
    value => { value.source.evidence = ['/private/source'] },
    value => { value.layers[0].image = '../private.png' },
    value => { value.markers[0].x += 1 },
    value => { value.markers[0].layer = 999 },
    value => { value.markers = value.markers.filter(marker => marker.kind !== 'chest') },
    value => { value.markers[0].targets[0].id = -1 },
    value => { value.markers[0].dialogue = 'Raw dialogue is forbidden' },
  ]) {
    const changed = structuredClone(snapshot)
    change(changed)
    changed.contentDigest = contentDigest(changed)
    assert.throws(() => validateWorldMap(changed, native, reference, schema))
  }
})

test('world-map CLI validates forms and checks offline without the installed SDK or image dependency', () => {
  const script = new URL('./update-world-map.mjs', import.meta.url).pathname
  for (const flag of ['--help', '-h', '-hiunused']) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [[], ['--unknown'], ['--input'], ['--input='], ['-i', ''], ['--check', '-iunused'], ['--check', '--', 'unexpected']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.length > 0)
  }
  const checked = spawnSync(process.execPath, ['--experimental-strip-types', script, '--check'], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
  assert.equal(checked.status, 0)
  assert.match(checked.stdout, /Verified native world maps/)
  assert.equal(checked.stderr, '')
})
