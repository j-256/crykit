import { readWorldZip, biomeLayer } from './world-map.mjs'
import { MAP_FACE, MAP_GEOMETRY } from '../../src/domain/map-geometry.ts'

const CHUNK_SIDE = 16
const CHUNK_CELLS = CHUNK_SIDE ** 3
const CHUNK_PLANE = CHUNK_SIDE ** 2
const CHUNK_LAST = CHUNK_SIDE - 1
const BIOME_SIDE = CHUNK_SIDE / 2
const CHUNK_HEADER = 13
const CHUNK_BYTES = CHUNK_HEADER + CHUNK_CELLS * 4
const MAX_REGIONS = 10_000
const MAX_BYTES = 32 * 1024 * 1024
const BYTE_VALUES = 256
const FACE_VALUES = MAP_FACE.all + 1
const RECORD_BASE = FACE_VALUES * BYTE_VALUES
const key = (x, y, z) => `${x},${y},${z}`
const require = (condition, message) => { if (!condition) throw new Error(message) }

export function readVoxelChunks(bytes) {
  require(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'Missing or oversized native voxel world')
  let offset = 0
  const integer = () => { require(offset + 4 <= bytes.length, 'Truncated voxel lookup'); const value = bytes.readInt32LE(offset); offset += 4; return value }
  // ZLookup stores settings and the entity ledger before its region directory
  // Skip both private payloads; only region coordinates and voxel tuples are retained
  for (let index = 0; index < 2; index++) { const length = integer(); require(length >= 0 && offset + length <= bytes.length, 'Invalid voxel lookup preamble'); offset += length }
  const count = integer()
  require(count > 0 && count <= MAX_REGIONS, 'Invalid voxel region count')
  const regions = []
  for (let index = 0; index < count; index++) regions.push({ x: integer(), z: integer(), offset: integer(), length: integer() })
  integer()
  const size = integer()
  require(size > 0 && offset + size === bytes.length, 'Invalid voxel lookup payload')
  const chunks = new Map()
  const seen = new Set()
  for (const region of regions) {
    require(region.offset >= 0 && region.length > 0 && region.offset + region.length <= size && !seen.has(key(region.x, 0, region.z)), 'Invalid or duplicate voxel region')
    seen.add(key(region.x, 0, region.z))
    const entries = readWorldZip(bytes.subarray(offset + region.offset, offset + region.offset + region.length), name => /^y\d+\.dat$/.test(name))
    for (const [name, data] of entries) {
      const y = Number(name.slice(1, -4))
      require(y >= 0 && y < MAP_GEOMETRY.height / CHUNK_SIDE && data.length === CHUNK_BYTES && data[0] <= 8, 'Unsupported native voxel chunk')
      const types = new Uint8Array(CHUNK_CELLS)
      // Native order is X, then Y, then Z; four bytes retain type, params and lighting
      // This block preview keeps exact occupancy/type, with special meshes left explicit
      for (let index = 0; index < types.length; index++) types[index] = data[CHUNK_HEADER + index * 4]
      chunks.set(key(region.x, y, region.z), { x: region.x, y, z: region.z, types, biomes: Uint8Array.from(data.subarray(5, CHUNK_HEADER)) })
    }
  }
  return chunks
}

export function exposedVoxelTiles(chunks, biomes, voxels, bounds) {
  const layers = new Int16Array(256).fill(-1)
  for (const [id, biome] of biomes) layers[id] = biomeLayer(biome, biomes) ?? -1
  const visible = voxels.map(voxel => Boolean(voxel?.Visible && !voxel.IsInvalid))
  const occludes = voxels.map(voxel => Boolean(voxel?.OccludesGeometry))
  const tiles = new Map()
  const wrapChunk = (value, origin, length) => Math.floor((origin + ((value * CHUNK_SIDE - origin) % length + length) % length) / CHUNK_SIDE)
  for (const chunk of chunks.values()) {
    const { x: cx, y: cy, z: cz, types } = chunk
    const adjacent = [
      chunks.get(key(cx, cy + 1, cz)),
      chunks.get(key(wrapChunk(cx - 1, bounds.x, bounds.width), cy, cz)),
      chunks.get(key(wrapChunk(cx + 1, bounds.x, bounds.width), cy, cz)),
      chunks.get(key(cx, cy, wrapChunk(cz - 1, bounds.z, bounds.height))),
      chunks.get(key(cx, cy, wrapChunk(cz + 1, bounds.z, bounds.height))),
    ]
    for (let x = 0; x < CHUNK_SIDE; x++) for (let y = 0; y < CHUNK_SIDE; y++) for (let z = 0; z < CHUNK_SIDE; z++) {
      const index = (x * CHUNK_SIDE + y) * CHUNK_SIDE + z
      const type = types[index]
      if (!visible[type]) continue
      const layer = layers[chunk.biomes[(Math.floor(x / BIOME_SIDE) * 2 + Math.floor(y / BIOME_SIDE)) * 2 + Math.floor(z / BIOME_SIDE)]]
      // Unassigned biomes have no map-layer authority; never guess a layer from height
      if (layer < 0) continue
      const neighbors = [
        y < CHUNK_LAST ? types[index + CHUNK_SIDE] : adjacent[0]?.types[x * CHUNK_PLANE + z],
        x > 0 ? types[index - CHUNK_PLANE] : adjacent[1]?.types[CHUNK_LAST * CHUNK_PLANE + y * CHUNK_SIDE + z],
        x < CHUNK_LAST ? types[index + CHUNK_PLANE] : adjacent[2]?.types[y * CHUNK_SIDE + z],
        z > 0 ? types[index - 1] : adjacent[3]?.types[x * CHUNK_PLANE + y * CHUNK_SIDE + CHUNK_LAST],
        z < CHUNK_LAST ? types[index + 1] : adjacent[4]?.types[x * CHUNK_PLANE + y * CHUNK_SIDE],
      ]
      let faces = 0
      // Match the solid builder's same-type and geometry-occlusion boundary rules
      // Adjacent chunks participate, so tile seams do not acquire fabricated walls
      neighbors.forEach((neighbor, direction) => { if (neighbor !== type && !occludes[neighbor]) faces |= 1 << direction })
      if (!faces) continue
      const worldX = cx * CHUNK_SIDE + x
      const worldY = cy * CHUNK_SIDE + y
      const worldZ = cz * CHUNK_SIDE + z
      if (worldX < bounds.x || worldX >= bounds.x + bounds.width || worldZ < bounds.z || worldZ >= bounds.z + bounds.height) continue
      const column = Math.floor((worldX - bounds.x) / MAP_GEOMETRY.tileSide)
      const row = Math.floor((worldZ - bounds.z) / MAP_GEOMETRY.tileSide)
      const tileKey = key(layer, column, row)
      let tile = tiles.get(tileKey)
      if (!tile) {
        const bx = bounds.x + column * MAP_GEOMETRY.tileSide
        const bz = bounds.z + row * MAP_GEOMETRY.tileSide
        tile = { layer, column, row, bounds: { x: bx, z: bz, width: Math.min(MAP_GEOMETRY.tileSide, bounds.x + bounds.width - bx), height: Math.min(MAP_GEOMETRY.tileSide, bounds.z + bounds.height - bz) }, records: [] }
        tiles.set(tileKey, tile)
      }
      const localIndex = ((worldX - tile.bounds.x) * tile.bounds.height + worldZ - tile.bounds.z) * MAP_GEOMETRY.height + worldY
      tile.records.push(localIndex * RECORD_BASE + faces * BYTE_VALUES + type)
    }
  }
  return [...tiles.values()].sort((a, b) => a.layer - b.layer || a.column - b.column || a.row - b.row).map(tile => {
    tile.records.sort((a, b) => a - b)
    const runs = []
    let minY = Infinity
    let maxY = -Infinity
    for (const record of tile.records) {
      const index = Math.floor(record / RECORD_BASE)
      const x = Math.floor(index / MAP_GEOMETRY.height / tile.bounds.height)
      const y = index % MAP_GEOMETRY.height
      const z = Math.floor(index / MAP_GEOMETRY.height) % tile.bounds.height
      const voxelId = record % BYTE_VALUES
      const faces = Math.floor(record / BYTE_VALUES) % FACE_VALUES
      const previous = runs.length - MAP_GEOMETRY.stride
      // Merge continuous sides only across real neighboring voxels of the same type
      // A top face ends a run; gaps and changing face masks must remain visible
      if (previous >= 0 && runs[previous] === x && runs[previous + 2] === z && runs[previous + 3] === voxelId && !(runs[previous + 4] & MAP_FACE.top) && (faces & ~MAP_FACE.top) === runs[previous + 4] && runs[previous + 1] + runs[previous + 5] === y && runs[previous + 5] < 255) {
        runs[previous + 4] = faces; runs[previous + 5]++
      } else runs.push(x, y, z, voxelId, faces, 1)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y + 1)
    }
    return { layer: tile.layer, column: tile.column, row: tile.row, bounds: tile.bounds, minY, maxY, cells: Uint8Array.from(runs) }
  })
}
