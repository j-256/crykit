import type { WorldMapBounds } from './world-map'

export const MAP_SURFACE_LIMITS = Object.freeze({ cells: 2_000_000, bytes: 32 * 1024 * 1024, empty: 255, underwater: 4 })
const CELL_STRIDE = 3
const RUN_STRIDE = 4
const BYTE_MAX = 255
export interface MapSurface { readonly bounds: WorldMapBounds; readonly layer: number; readonly cells: Uint8Array }
export interface MapSurfaceCell { readonly voxelId: number; readonly height: number; readonly underwater: boolean }

// These are the native map's selected surface tuples, not a volume of collision voxels
// Height is the world Y of the empty cell immediately above the mapped voxel
export function encodeMapSurface(cells: Uint8Array, bounds: WorldMapBounds, layer: number): string {
  if (cells.length !== bounds.width * bounds.height * CELL_STRIDE) throw new Error('Surface dimensions differ')
  // Row-major runs retain count, voxel type, surface Y and native variant/water flags
  const runs: number[] = []
  for (let offset = 0; offset < cells.length;) {
    const start = offset
    while (offset < cells.length && cells[offset] === cells[start] && cells[offset + 1] === cells[start + 1] && cells[offset + 2] === cells[start + 2]) offset += CELL_STRIDE
    runs.push((offset - start) / CELL_STRIDE, cells[start]!, cells[start + 1]!, cells[start + 2]!)
  }
  return JSON.stringify({ schemaVersion: 1, bounds, layer, runs }) + '\n'
}

export function decodeMapSurface(text: string, bounds: WorldMapBounds, layer: number): MapSurface {
  const total = bounds.width * bounds.height
  if (text.length > MAP_SURFACE_LIMITS.bytes || !Object.values(bounds).every(Number.isSafeInteger) || bounds.width <= 0 || bounds.height <= 0 || total > MAP_SURFACE_LIMITS.cells) throw new Error('Surface size exceeds bounds')
  const source: unknown = JSON.parse(text)
  if (!source || typeof source !== 'object' || !('schemaVersion' in source) || source.schemaVersion !== 1 || !('layer' in source) || source.layer !== layer || !('bounds' in source) || !source.bounds || typeof source.bounds !== 'object' || !Object.entries(bounds).every(([key, value]) => Reflect.get(source.bounds as object, key) === value) || !('runs' in source) || !Array.isArray(source.runs)) throw new Error('Surface identity differs')
  const runs = source.runs as unknown[]
  if (runs.length % RUN_STRIDE || runs.length > total * RUN_STRIDE) throw new Error('Invalid surface runs')
  // Validate coverage before allocation so malformed runs cannot expand past the bounded map
  let count = 0
  for (let index = 0; index < runs.length; index += RUN_STRIDE) {
    const run = runs.slice(index, index + RUN_STRIDE)
    if (!run.every(value => typeof value === 'number' && Number.isSafeInteger(value)) || Number(run[0]) <= 0 || run.slice(1).some(value => Number(value) < 0 || Number(value) > BYTE_MAX)) throw new Error('Invalid surface tuple')
    count += Number(run[0])
    if (count > total) throw new Error('Surface runs exceed map bounds')
  }
  if (count !== total) throw new Error('Incomplete surface coverage')
  const cells = new Uint8Array(total * CELL_STRIDE)
  let offset = 0
  for (let index = 0; index < runs.length; index += RUN_STRIDE) for (let cell = 0; cell < Number(runs[index]); cell++) {
    cells[offset++] = Number(runs[index + 1]); cells[offset++] = Number(runs[index + 2]); cells[offset++] = Number(runs[index + 3])
  }
  return { bounds, layer, cells }
}

export function mapSurfaceCell(surface: MapSurface, x: number, z: number): MapSurfaceCell | undefined {
  const localX = x - surface.bounds.x
  const localZ = z - surface.bounds.z
  if (!Number.isInteger(localX) || !Number.isInteger(localZ) || localX < 0 || localZ < 0 || localX >= surface.bounds.width || localZ >= surface.bounds.height) return undefined
  const offset = (localZ * surface.bounds.width + localX) * CELL_STRIDE
  if (surface.cells[offset] === MAP_SURFACE_LIMITS.empty) return undefined
  return { voxelId: surface.cells[offset]!, height: surface.cells[offset + 1]!, underwater: Boolean(surface.cells[offset + 2]! & MAP_SURFACE_LIMITS.underwater) }
}
