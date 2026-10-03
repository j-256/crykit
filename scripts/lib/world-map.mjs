import { inflateRawSync } from 'node:zlib'
import { coinAmounts } from '../../src/domain/money.ts'

export const MAP_LAYERS = Object.freeze([{ id: 0, key: 'Overworld' }, { id: 1, key: 'Caves' }, { id: 4, key: 'DungeonL1' }, { id: 5, key: 'DungeonL2' }, { id: 6, key: 'DungeonL3' }, { id: 7, key: 'DungeonL4' }, { id: 8, key: 'DungeonL5' }, { id: 9, key: 'DungeonL6' }])
export const MAP_CELL_SIZE = 4
export const MAP_HEIGHT_SHADES = Object.freeze([255, 192, 128, 64, 0])
const MAX_BYTES = 32 * 1024 * 1024
const MAX_CELLS = 2_000_000
const ZIP = Object.freeze({ end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 })
const EMPTY = 255
const WATER = 246
const UNDERWATER = 4
const VARIANT_MASK = 3
const ATLAS_STRIDE = 18
const ATLAS_INSET = 1
const WATER_SAMPLE = Object.freeze({ x: 397, y: 415 })
const WATER_OPACITY = 0.65
const require = (condition, message) => { if (!condition) throw new Error(message) }

function range(bytes, offset, length) {
  require(Buffer.isBuffer(bytes) && Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= bytes.length, 'Truncated map archive')
  return bytes.subarray(offset, offset + length)
}

export function readMapArchive(world) {
  require(world.length <= MAX_BYTES && world.length >= 24 && world.readUInt16LE(0) === 5, 'Unsupported field world header')
  const bytes = world.subarray(2)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP.end && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  require(end >= 0, 'Missing map archive directory')
  require(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === bytes.readUInt16LE(end + 10), 'Unsupported multi-disk map archive')
  const count = bytes.readUInt16LE(end + 10)
  const directorySize = bytes.readUInt32LE(end + 12)
  let offset = bytes.readUInt32LE(end + 16)
  const directoryEnd = offset + directorySize
  require(count > 0 && count < 65_535 && directoryEnd === end, 'Invalid map archive directory bounds')
  const names = new Set()
  const entries = new Map()
  let expanded = 0
  for (let index = 0; index < count; index += 1) {
    range(bytes, offset, 46)
    require(bytes.readUInt32LE(offset) === ZIP.central, 'Invalid map archive directory entry')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameSize = bytes.readUInt16LE(offset + 28)
    const extraSize = bytes.readUInt16LE(offset + 30)
    const commentSize = bytes.readUInt16LE(offset + 32)
    const local = bytes.readUInt32LE(offset + 42)
    const nameBytes = range(bytes, offset + 46, nameSize)
    const name = nameBytes.toString('utf8')
    require(name && !name.includes('\0') && Buffer.from(name).equals(nameBytes) && !names.has(name), 'Invalid or duplicate map archive path')
    names.add(name)
    offset += 46 + nameSize + extraSize + commentSize
    require(offset <= directoryEnd, 'Map archive entry exceeds directory')
    if (!/^map\/map_(?:world|biome\d+)\/(?:meta|region_\d+_\d+)\.dat$/.test(name)) continue
    require(!(flags & 1) && [0, 8].includes(method) && size > 0 && size <= MAX_BYTES, 'Unsupported map archive compression or size')
    range(bytes, local, 30)
    require(bytes.readUInt32LE(local) === ZIP.local && bytes.readUInt16LE(local + 8) === method, 'Invalid map archive local header')
    const localNameSize = bytes.readUInt16LE(local + 26)
    require(range(bytes, local + 30, localNameSize).equals(nameBytes), 'Map archive local path differs')
    const dataOffset = local + 30 + localNameSize + bytes.readUInt16LE(local + 28)
    require(dataOffset + compressedSize <= directoryEnd, 'Map archive data exceeds bounds')
    const compressed = range(bytes, dataOffset, compressedSize)
    expanded += size
    require(expanded <= MAX_BYTES, 'Expanded map archive exceeds size limit')
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: size })
    require(data.length === size, 'Map archive entry size differs')
    entries.set(name, data)
  }
  require(offset === directoryEnd && entries.has('map/map_world/meta.dat'), 'Map archive is incomplete')
  return entries
}

export function readMapHeader(bytes, expectedId) {
  require(bytes?.length === 37 && bytes[0] <= 2, 'Unsupported map metadata')
  const fields = ['id', 'x', 'z', 'width', 'height', 'regionWidth', 'regionHeight', 'regionCountX', 'regionCountZ']
  const header = Object.fromEntries(fields.map((key, index) => [key, bytes.readInt32LE(1 + index * 4)]))
  require(header.id === expectedId && header.width > 0 && header.height > 0 && header.width * header.height <= MAX_CELLS, 'Invalid map identity or dimensions')
  require(Number.isSafeInteger(header.x + header.width) && Number.isSafeInteger(header.z + header.height) && header.regionWidth === 64 && header.regionHeight === 64 && header.regionCountX === Math.ceil(header.width / 64) && header.regionCountZ === Math.ceil(header.height / 64), 'Invalid map region layout')
  return header
}

export function readTerrainMaps(entries) {
  return [...entries].filter(([name]) => name.endsWith('/meta.dat')).map(([name, bytes]) => {
    const match = /^map\/map_(world|biome(\d+))\//.exec(name)
    const header = readMapHeader(bytes, match[1] === 'world' ? -1 : Number(match[2]))
    const cells = Buffer.alloc(header.width * header.height * 3)
    for (let index = 0; index < cells.length; index += 3) cells[index] = EMPTY
    const prefix = name.slice(0, -8)
    for (let rx = 0; rx < header.regionCountX; rx += 1) for (let rz = 0; rz < header.regionCountZ; rz += 1) {
      const region = entries.get(`${prefix}region_${rx}_${rz}.dat`)
      const xEnd = Math.min(header.width, (rx + 1) * header.regionWidth)
      const zEnd = Math.min(header.height, (rz + 1) * header.regionHeight)
      const expected = 1 + (xEnd - rx * header.regionWidth) * (zEnd - rz * header.regionHeight) * 3
      require(region?.length === expected && region[0] <= 2, 'Missing, truncated or unsupported terrain region')
      let source = 1
      for (let x = rx * header.regionWidth; x < xEnd; x += 1) for (let z = rz * header.regionHeight; z < zEnd; z += 1) {
        region.copy(cells, (z * header.width + x) * 3, source, source + 3)
        source += 3
      }
    }
    return { ...header, cells }
  }).sort((a, b) => a.id - b.id)
}

export function biomeLayer(biome, biomes) {
  if (!biome || biome.ID === 0) return null
  const mapBiome = biome.BaseID && !biome.IsMapAlt ? biomes.get(biome.BaseID) : biome
  return MAP_LAYERS.some(layer => layer.id === mapBiome?.MapLayer) ? mapBiome.MapLayer : null
}

export function composeTerrain(maps, biomes, bounds, layer) {
  const output = Buffer.alloc(bounds.width * bounds.height * 3)
  for (let offset = 0; offset < output.length; offset += 3) output[offset] = EMPTY
  for (const map of maps) {
    if (map.id === -1 || biomeLayer(biomes.get(map.id), biomes) !== layer) continue
    for (let z = 0; z < map.height; z += 1) for (let x = 0; x < map.width; x += 1) {
      const source = (z * map.width + x) * 3
      if (map.cells[source] === EMPTY) continue
      const targetX = (map.x + x - bounds.x + bounds.width) % bounds.width
      const targetZ = (map.z + z - bounds.z + bounds.height) % bounds.height
      require(targetX >= 0 && targetZ >= 0, 'Terrain coordinate exceeds world bounds')
      const target = (targetZ * bounds.width + targetX) * 3
      const underwater = Boolean(output[target + 2] & UNDERWATER)
      if (output[target + 1] < map.cells[source + 1] && (!underwater || map.cells[source] !== WATER) || output[target] === WATER && (map.cells[source + 2] & UNDERWATER)) map.cells.copy(output, target, source, source + 3)
    }
  }
  return output
}

export function renderTerrain(cells, bounds, voxels, atlas) {
  require(cells.length === bounds.width * bounds.height * 3 && atlas.channels === 4 && atlas.width === 432 && atlas.height === 432 && atlas.data.length === 432 * 432 * 4, 'Invalid terrain or atlas dimensions')
  const width = bounds.width * MAP_CELL_SIZE
  const height = bounds.height * MAP_CELL_SIZE
  const pixels = Buffer.alloc(width * height * 4)
  const neighbor = (x, z) => cells[(((z + bounds.height) % bounds.height) * bounds.width + (x + bounds.width) % bounds.width) * 3 + 1] || EMPTY
  for (let z = 0; z < bounds.height; z += 1) for (let x = 0; x < bounds.width; x += 1) {
    const offset = (z * bounds.width + x) * 3
    const id = cells[offset]
    if (id === EMPTY) continue
    const voxel = voxels[id]
    require(voxel && !voxel.IsInvalid, 'Unresolved map terrain type')
    const variant = cells[offset + 2] & VARIANT_MASK
    const water = voxel.IsLiquid && !voxel.IsBurning
    const atlasX = water ? WATER_SAMPLE.x : ATLAS_INSET + (voxel.TexTopU + variant) * ATLAS_STRIDE
    const atlasZ = water ? WATER_SAMPLE.y : ATLAS_INSET + voxel.TexTopV * ATLAS_STRIDE
    require(Number.isInteger(atlasX) && Number.isInteger(atlasZ) && atlasX >= 0 && atlasZ >= 0 && atlasX + 16 <= atlas.width && atlasZ + 16 <= atlas.height, 'Terrain texture rectangle exceeds atlas')
    const edgesX = [neighbor(x - 1, z), neighbor(x + 1, z)]
    const edgesZ = [neighbor(x, z - 1), neighbor(x, z + 1)]
    for (let pz = 0; pz < MAP_CELL_SIZE; pz += 1) for (let px = 0; px < MAP_CELL_SIZE; px += 1) {
      const shadeIndex = Math.min(4, Math.max(0, Math.max(edgesX[px < 2 ? 0 : 1], edgesZ[pz < 2 ? 0 : 1]) - cells[offset + 1]))
      const shade = MAP_HEIGHT_SHADES[shadeIndex] / 255
      const sx = 2 + px * 4
      const sz = 2 + pz * 4
      const source = ((atlasZ + sz) * atlas.width + atlasX + sx) * 4
      const target = ((z * MAP_CELL_SIZE + pz) * width + x * MAP_CELL_SIZE + px) * 4
      for (let channel = 0; channel < 3; channel += 1) pixels[target + channel] = Math.round(atlas.data[source + channel] * shade)
      pixels[target + 3] = atlas.data[source + 3]
      if (cells[offset + 2] & UNDERWATER) {
        const waterSource = ((WATER_SAMPLE.y + sz) * atlas.width + WATER_SAMPLE.x + sx) * 4
        const opacity = WATER_OPACITY * atlas.data[waterSource + 3] / 255
        for (let channel = 0; channel < 3; channel += 1) pixels[target + channel] = Math.round(atlas.data[waterSource + channel] * opacity + pixels[target + channel] * (1 - opacity))
        pixels[target + 3] = Math.round(255 * opacity + pixels[target + 3] * (1 - opacity))
      }
    }
  }
  return { data: pixels, width, height, channels: 4 }
}

export function mapRegions(maps, biomes) {
  const mapById = new Map(maps.map(map => [map.id, map]))
  return [...biomes.values()].filter(biome => biome.ID > 0).flatMap(biome => {
    const map = mapById.get(biome.ID) ?? mapById.get(biome.BaseID)
    const layer = biomeLayer(biome, biomes)
    if (!map || layer === null) return []
    return [{ id: biome.ID, name: biome.Name, layer, x: biome.MapCenterXOverride ?? map.x + Math.floor(map.width / 2), z: biome.MapCenterYOverride ?? map.z + Math.floor(map.height / 2) }]
  }).sort((a, b) => a.id - b.id)
}

export function projectMapMarkers(entities, databases, regions, system = {}, voxels = []) {
  const biomes = new Map(databases.biome.filter(Boolean).map(record => [record.ID, record]))
  const regionIds = new Set(regions.map(region => region.id))
  const records = family => databases[family] ?? []
  const definition = (family, id) => records(family).find(record => record?.ID === id)
  const vocab = system.Vocab?.General ?? {}
  const resolveText = value => {
    if (typeof value !== 'string') return ''
    let result = value
    for (let pass = 0; pass < 5; pass += 1) {
      const previous = result
      result = result.replace(/@C(@[A-Za-z_]+)\.Name/g, (token, key) => system.MainNpcs?.find(npc => npc.Key === key)?.Name ?? token).replace(/@([ZIJME])(\d+)\.Name/g, (token, type, id) => definition({ Z: 'biome', I: 'item', J: 'job', M: 'monster', E: 'equipment' }[type], Number(id))?.Name ?? token).replace(/@V\.([A-Za-z_]+)/g, (token, name) => vocab[name] ?? token)
      if (result === previous) break
    }
    const mainNpc = system.MainNpcs?.find(npc => npc.Key === result)
    if (mainNpc) return mainNpc.Name
    if (/^@Quintar\d+$/.test(result)) return `Quintar (slot ${Number(result.slice(8)) + 1})`
    if (/^@Seed\d+$/.test(result)) return `Garden plot ${Number(result.slice(5)) + 1}`
    return result
  }
  const target = (family, id) => {
    const record = definition(family, id)
    return record ? { family, id, name: resolveText(record.Name), sourceId: 'base' } : null
  }
  const conditionText = condition => {
    if (!condition || condition.ConditionType === 'Always' && !condition.IsNegation) return null
    const type = condition.ConditionType ?? 'Unknown'
    const key = condition.Data?.VariableKey
    return `${condition.IsNegation ? 'Not: ' : ''}${type.replace(/([a-z])([A-Z])/g, '$1 $2')}${key ? ` (${key})` : ''}`
  }
  const markers = []
  for (const entity of entities) {
    if (entity.EntityType === 'Marker') continue
    const targets = []
    const conditions = new Set()
    const addCondition = condition => { const text = conditionText(condition); if (text) conditions.add(text) }
    const addTarget = (family, id) => { const found = target(family, id); if (found && !targets.some(other => other.family === family && other.id === id)) targets.push(found) }
    const addTroop = id => { addTarget('troop', id); for (const member of definition('troop', id)?.Members ?? []) addTarget('monster', member.MonsterID) }
    const biome = biomes.get(entity.BiomeID)
    const layer = regionIds.has(entity.BiomeID) ? biomeLayer(biome, biomes) : null
    let kind = 'npc'
    let name = 'NPC'
    let description = ''
    const warnings = []
    if (entity.EntityType === 'Treasure') {
      kind = 'chest'
      const loot = entity.TreasureData
      if (['Item', 'Equipment'].includes(loot.LootType)) addTarget(loot.LootType.toLowerCase(), loot.LootValue)
      description = loot.LootType === 'Currency' ? coinAmounts(loot.LootValue).map(({ coin, amount }) => `${amount} ${coin}`).join(', ') : loot.LootType === 'Nothing' ? 'Empty chest' : targets[0]?.name ?? 'Unknown contents'
      name = `${description} chest`
    } else if (entity.EntityType === 'Npc') {
      const npc = entity.NpcData
      const outfits = npc.Outfits ?? []
      const visible = outfits.some(outfit => outfit.TextureKey || outfit.Name?.startsWith('@') || outfit.VoxelID !== null && outfit.VoxelID !== undefined)
      const names = [...new Set(outfits.map(outfit => resolveText(outfit.Name)).filter(Boolean))]
      name = names[0] ?? 'NPC'
      if (outfits.some(outfit => /^@(?:Quintar|Seed)\d+$/.test(outfit.Name ?? ''))) warnings.push('Appearance or name depends on your playthrough')
      for (const outfit of outfits) addCondition(outfit.Condition)
      let shop = false
      const actionTypes = new Set()
      const visit = (actions, depth = 0) => {
        require(depth < 64, 'NPC action nesting exceeds limit')
        for (const action of actions ?? []) {
          const data = action.Data ?? {}
          actionTypes.add(action.ActionType)
          if (action.ActionType === 'Battle') addTroop(data.TroopID)
          if (action.ActionType === 'Shop' || action.ActionType === 'ShopRecipe') {
            shop = true
            for (const stock of data.Stock ?? []) {
              if (action.ActionType === 'ShopRecipe') addTarget('recipe', stock.LootValue)
              else if (['Item', 'Equipment'].includes(stock.LootType)) addTarget(stock.LootType.toLowerCase(), stock.LootValue)
            }
          }
          if (action.ActionType === 'AddInventory' && ['Item', 'Equipment'].includes(data.LootType)) addTarget(data.LootType.toLowerCase(), data.LootValue)
          if (action.ActionType === 'Condition') addCondition(data.Condition)
          for (const nested of Object.values(data)) if (Array.isArray(nested) && nested.some(value => value?.ActionType)) visit(nested, depth + 1)
        }
      }
      for (const page of npc.Pages ?? []) { addCondition(page.Condition); visit(page.Actions) }
      const bossTargets = targets.filter(value => value.family === 'monster' && definition('monster', value.id)?.IsBoss)
      const battleTargets = targets.filter(value => value.family === 'monster')
      if (!visible && !bossTargets.length && !shop) continue
      const effectAppearance = outfits.some(outfit => /^Actor\/Effect_/.test(outfit.TextureKey ?? ''))
      const pickupAppearance = outfits.some(outfit => ['Actor/Effect_Sparkle', 'Actor/Effect_Question'].includes(outfit.TextureKey))
      const mining = actionTypes.has('PlaySEMineOre')
      const gardening = actionTypes.has('Garden')
      const pickup = pickupAppearance && actionTypes.has('AddInventory') && targets.length > 0
      const resource = mining || gardening || pickup
      const voxelAppearance = outfits.some(outfit => outfit.VoxelID !== null && outfit.VoxelID !== undefined)
      kind = bossTargets.length ? 'boss' : shop ? 'shop' : battleTargets.length ? 'encounter' : resource ? 'resource' : voxelAppearance || effectAppearance ? 'object' : 'npc'
      if (bossTargets.length) name = bossTargets.map(value => value.name).join(', ')
      else if (shop && name === 'NPC') name = 'Shop'
      else if (kind === 'encounter') name = battleTargets.map(value => value.name).join(', ')
      else if (mining) name = `${targets.filter(value => value.family === 'item' || value.family === 'equipment').map(value => value.name).join(', ') || 'Resource'} node`
      else if (pickup) name = `${targets.filter(value => value.family === 'item' || value.family === 'equipment').map(value => value.name).join(', ') || 'Item'} pickup`
      else if (gardening && name === 'NPC') name = 'Garden plot'
      else if (kind === 'object' && name === 'NPC') {
        const labels = [...new Set(outfits.map(outfit => voxels[outfit.VoxelID]?.Name).filter(Boolean))]
        name = labels.join(' / ') || (actionTypes.has('HazardBurn') ? 'Fire' : 'Interaction point')
      }
      description = bossTargets.length || kind === 'encounter' ? 'Scripted battle' : shop ? 'Shop stock and interaction rewards' : mining ? 'Mining point' : gardening ? 'Planting and harvesting plot' : pickup ? 'Ground pickup' : kind === 'object' ? 'World object' : targets.length ? 'Interaction rewards' : 'NPC placement'
    } else if (entity.EntityType === 'Spark') {
      for (const page of entity.SparkData.TroopPages ?? []) { addTroop(page.TroopID); addCondition(page.Condition) }
      const monsters = targets.filter(value => value.family === 'monster')
      const bosses = monsters.filter(value => definition('monster', value.id)?.IsBoss)
      kind = bosses.length ? 'boss' : 'encounter'
      name = (bosses.length ? bosses : monsters).map(value => value.name).join(', ') || 'Encounter'
      description = 'Placed encounter'
    } else if (entity.EntityType === 'Crystal') {
      kind = 'crystal'; addTarget('job', entity.CrystalData.JobID)
      name = `${targets[0]?.name ?? 'Class'} crystal`; description = 'Class crystal'
    } else if (entity.EntityType === 'HomePoint') {
      kind = 'home'; name = resolveText(entity.HomePointData.Name) || 'Home point'; description = 'Home point'
    } else if (entity.EntityType === 'Door') {
      kind = 'entrance'; name = 'Door'; description = entity.DoorData.IsLocked ? 'Locked in the source' : 'Door placement'
      addTarget('item', entity.DoorData.RequiredItemID)
      if (targets.length) description += `; key: ${targets[0].name}`
      if (entity.DoorData.RequiredGlobalFlag) conditions.add(`Required flag (${entity.DoorData.RequiredGlobalFlag})`)
    } else if (entity.EntityType === 'Sign') {
      kind = 'sign'; name = resolveText(entity.SignData.Title) || 'Sign'; description = 'Sign placement'
    } else continue
    const marker = { id: `base:entity:${entity.ID}`, entityId: entity.ID, kind, sourceId: 'base', sourceName: 'Base game', change: 'base', name, region: entity.BiomeID === 0 ? null : biome?.Name ?? null, biomeId: entity.BiomeID, layer, x: entity.Coord.X, y: entity.Coord.Y, z: entity.Coord.Z, description, targets }
    if (conditions.size) marker.conditions = [...conditions].sort()
    if (layer === null) warnings.push('Map layer is unknown for this placement')
    if (warnings.length) marker.warnings = warnings
    markers.push(marker)
  }
  return markers.sort((a, b) => a.entityId - b.entityId)
}
