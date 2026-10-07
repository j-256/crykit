import { describe, expect, it } from 'vitest'
import { parseDocument } from './document'
import { addVoxelPlatform, paintVoxelBlocks, eraseVoxelBlocks, applyMapTextPatch, inspectMapProject, MAP_EDITOR_LIMITS, mapTextPatch, moveMapPlacement, newMapProject } from './map-editor'

const PROJECT_ID = 'a1943ce8-2a42-486a-9549-d497685b671e'
const TIMESTAMP = '2026-01-01T00:00:00.000Z'
const LAST_NATIVE_ENTITY = 3824
const treasure = '{"ID":1,"Coord":{"X":-12,"Y":99,"Z":4,"Unknown":9007199254740993},"BiomeID":1,"EntityType":5,"TreasureData":{"LootType":2,"LootValue":18,"Amount":1,"Condition":{"Opaque":true}},"Unknown":1.234567890123456789}'
const imported = newMapProject(PROJECT_ID, TIMESTAMP).replace('"Entities": []', '"Entities": ['+treasure+']').replace('"Jobs": []', '"Jobs": [{"Opaque":true}]').replace('"Description": ""', '"Description": "", "Unknown":12345678901234567890')
const options = { coord: { X: 10, Y: 99, Z: -20 }, width: 2, depth: 2, biomeId: 1, voxelId: 9, lastNativeEntityId: LAST_NATIVE_ENTITY, knownVoxelIds: [1, 9] }

describe('precise map placement authoring', () => {
  it('moves coordinate leaves while preserving identity, conditions and exact numeric tokens', () => {
    const next = moveMapPlacement(imported, 1, { X: -10, Y: 100, Z: 3 })
    expect(next).toBe(imported.replace('"X":-12,"Y":99,"Z":4', '"X":-10,"Y":100,"Z":3'))
    expect(inspectMapProject(parseDocument(next)).placements[0]).toMatchObject({ id: 1, coord: { X: -10, Y: 100, Z: 3 } })
    expect(moveMapPlacement(imported, 1, { X: -12, Y: 99, Z: 4 })).toBe(imported)
  })
  it('appends stationary cubic NPC blocks with IDs above both native and imported entities', () => {
    const next = addVoxelPlatform(imported, options)
    const boundary = imported.indexOf(']', imported.indexOf('"Entities":'))
    expect(next.startsWith(imported.slice(0, boundary))).toBe(true)
    expect(next.endsWith(imported.slice(boundary))).toBe(true)
    expect(next).toContain(treasure)
    const placements = inspectMapProject(parseDocument(next)).placements
    expect(placements.slice(1).map(record => record.id)).toEqual([3825, 3826, 3827, 3828])
    expect(placements.slice(1).map(record => record.coord)).toEqual([{ X: 10, Y: 99, Z: -20 }, { X: 10, Y: 99, Z: -19 }, { X: 11, Y: 99, Z: -20 }, { X: 11, Y: 99, Z: -19 }])
    const record = JSON.parse(next).Entities[1]
    expect(record.NpcData).toMatchObject({ TieToSpawn: true, UniquePerKey: false, Pages: [], Outfits: [{ Condition: { ConditionType: 0, Data: null, IsNegation: false }, VoxelID: 9, PlayerCollision: 3, NpcCollision: 3, MountType: 20, WanderType: 0, WanderRoute: [] }] })
    const higher = imported.replace('"ID":1,', '"ID":9000,')
    expect(inspectMapProject(parseDocument(addVoxelPlatform(higher, options))).placements[1].id).toBe(9001)
  })
  it('preserves whitespace before the closing array and makes a new export-ready envelope', () => {
    const blank = newMapProject(PROJECT_ID, TIMESTAMP)
    const next = addVoxelPlatform(blank, { ...options, width: 1, depth: 1 })
    expect(inspectMapProject(parseDocument(next)).editable).toBe(true)
    expect(JSON.parse(next)).toMatchObject({ ID: PROJECT_ID, Title: 'Map placements', EditorVersion: 34, IsLocalization: false, Entities: [{ ID: 3825 }], Jobs: [], Tree: [], Folders: [] })
    expect(JSON.parse(blank).Entities).toEqual([])
  })
  it('rejects duplicate identities, unsupported formats, localization and malformed source records', () => {
    for (const text of [imported.replace('['+treasure+']', '['+treasure+','+treasure+']'), imported.replace('"EditorVersion": 34', '"EditorVersion": 27'), imported.replace('"EditorVersion": 34', '"EditorVersion": 35'), imported.replace('"IsLocalization": false', '"IsLocalization": true'), imported.replace('"Y":99', '"Y":null'), imported.replace('"ID":1,', '"ID":9007199254740993,'), imported.replace('"EntityType":5', '"EntityType":100'), imported.replace('"Abilities": []', '"Abilities": null'), imported.replace('"Biomes": []', '"Biomes": [{"ID":1},{"ID":1}]'), imported.replace('"Biomes": []', '"Biomes": [{"ID":256}]')]) {
      expect(inspectMapProject(parseDocument(text)).editable).toBe(false)
      expect(() => addVoxelPlatform(text, options)).toThrow()
      expect(() => moveMapPlacement(text, 1, options.coord)).toThrow()
    }
  })
  it('validates the entire platform before authoring any block', () => {
    const invalid = [{ ...options, width: MAP_EDITOR_LIMITS.brushSide + 1 }, { ...options, depth: 0 }, { ...options, voxelId: 0 }, { ...options, voxelId: 8 }, { ...options, voxelId: 255, knownVoxelIds: [255] }, { ...options, biomeId: 256 }, { ...options, coord: { ...options.coord, X: MAP_EDITOR_LIMITS.intMax } }, { ...options, coord: { ...options.coord, Y: 1.5 } }, { ...options, lastNativeEntityId: NaN }]
    for (const option of invalid) expect(() => addVoxelPlatform(imported, option)).toThrow()
    const fullIds = imported.replace('"ID":1,', '"ID":2147483647,')
    expect(() => addVoxelPlatform(fullIds, options)).toThrow('safe entity IDs')
    const next = addVoxelPlatform(imported, options)
    expect(() => addVoxelPlatform(next, options)).toThrow('overlaps')
    expect(inspectMapProject(parseDocument(next)).placements).toHaveLength(5)
  })
  it('treats conditional voxel outfits conservatively and prevents authored block overlap on move', () => {
    const next = addVoxelPlatform(imported, options)
    const conditional = next.replace('"Outfits":[{', '"Outfits":[{"VoxelID":null},{')
    expect(() => addVoxelPlatform(conditional, { ...options, width: 1, depth: 1 })).toThrow('overlaps')
    expect(() => moveMapPlacement(next, 3825, { X: 11, Y: 99, Z: -20 })).toThrow('overlaps')
    expect(moveMapPlacement(next, 3825, { X: 11, Y: 100, Z: -20 })).toContain('"ID":3825,"Coord":{"X":11,"Y":100,"Z":-20}')
  })
  it('paints arbitrary cells atomically, skips existing outfits and preserves exact source', () => {
    const first = paintVoxelBlocks(imported, [options.coord, options.coord, { ...options.coord, Y: 100 }], options)
    expect(first).toContain(treasure)
    expect(inspectMapProject(parseDocument(first)).placements).toHaveLength(3)
    expect(paintVoxelBlocks(first, [options.coord], options)).toBe(first)
    const conditional = first.replace('"ConditionType":0', '"ConditionType":1')
    expect(paintVoxelBlocks(conditional, [options.coord], options)).toBe(conditional)
    expect(() => paintVoxelBlocks(imported, [options.coord, { ...options.coord, Y: 1.5 }], options)).toThrow('integers')
    expect(() => paintVoxelBlocks(imported, Array.from({ length: MAP_EDITOR_LIMITS.strokeCells + 1 }, () => options.coord), options)).toThrow('limit')
  })
  it('erases only added stationary blocks, preserving surviving records and exact undo', () => {
    const next = addVoxelPlatform(imported, options)
    for (const ids of [[3825], [3828], [3825, 3827], [3825, 3826, 3827, 3828]]) {
      const erased = eraseVoxelBlocks(next, ids, LAST_NATIVE_ENTITY)
      expect(erased).toContain(treasure)
      expect(inspectMapProject(parseDocument(erased)).placements.map(record => record.id)).toEqual([1, ...[3825, 3826, 3827, 3828].filter(id => !ids.includes(id))])
      expect(applyMapTextPatch(erased, mapTextPatch(next, erased), 'undo')).toBe(next)
    }
    const blank = newMapProject(PROJECT_ID, TIMESTAMP)
    const onlyBlocks = addVoxelPlatform(blank, options)
    expect(inspectMapProject(parseDocument(eraseVoxelBlocks(onlyBlocks, [3825, 3826, 3827, 3828], LAST_NATIVE_ENTITY))).placements).toEqual([])
    expect(() => eraseVoxelBlocks(next, [1], LAST_NATIVE_ENTITY)).toThrow('Native overrides')
    expect(() => eraseVoxelBlocks(next.replace('"ConditionType":0', '"ConditionType":1'), [3825], LAST_NATIVE_ENTITY)).toThrow('stationary')
    expect(() => eraseVoxelBlocks(next, [9999], LAST_NATIVE_ENTITY)).toThrow('stationary')
  })
  it('undoes and redoes exact text patches and rejects stale targets', () => {
    const moved = moveMapPlacement(imported, 1, options.coord)
    const platform = addVoxelPlatform(moved, options)
    const move = mapTextPatch(imported, moved)
    const add = mapTextPatch(moved, platform)
    expect(applyMapTextPatch(platform, add, 'undo')).toBe(moved)
    expect(applyMapTextPatch(moved, move, 'undo')).toBe(imported)
    expect(applyMapTextPatch(imported, move, 'redo')).toBe(moved)
    expect(applyMapTextPatch(moved, add, 'redo')).toBe(platform)
    expect(() => applyMapTextPatch(imported, add, 'undo')).toThrow('changed outside')
    expect(add.before.length + add.after.length).toBeLessThan(platform.length)
  })
})
