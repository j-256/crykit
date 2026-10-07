import { gunzipSync, gzipSync } from 'fflate'
import type { WorldMapBounds } from './world-map'

export const MAP_GEOMETRY = Object.freeze({ tileSide: 32, height: 256, stride: 6, header: 24, bytes: 2 * 1024 * 1024, tiles: 2000, cacheTiles: 64, downloads: 4 })
export const MAP_FACE = Object.freeze({ top: 1, xNeg: 2, xPos: 4, zNeg: 8, zPos: 16, all: 31 })
export interface MapGeometryMetadata { readonly file: string; readonly size: number; readonly sha256: string; readonly bounds: WorldMapBounds; readonly minY: number; readonly maxY: number }
export interface MapGeometryTile { readonly bounds: WorldMapBounds; readonly layer: number; readonly cells: Uint8Array }
const MAGIC = 0x31474b43

// Each tuple retains a recorded vertical run and its exposed face mask, never a
// solid column inferred from the separate map's topmost selected surface
export function encodeMapGeometry(cells: Uint8Array, bounds: WorldMapBounds, layer: number): Uint8Array {
  const bytes = new Uint8Array(MAP_GEOMETRY.header + cells.length)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, MAGIC, true); header.setUint32(4, layer, true)
  header.setInt32(8, bounds.x, true); header.setInt32(12, bounds.z, true)
  header.setUint8(16, bounds.width); header.setUint8(17, bounds.height)
  header.setUint32(20, cells.length / MAP_GEOMETRY.stride, true)
  bytes.set(cells, MAP_GEOMETRY.header)
  return gzipSync(bytes, { level: 9, mtime: 0 })
}

export function decodeMapGeometry(compressed: Uint8Array, metadata: MapGeometryMetadata, layer: number): MapGeometryTile {
  const bounds = metadata.bounds
  const total = bounds.width * bounds.height * MAP_GEOMETRY.height
  if (!Object.values(bounds).every(Number.isSafeInteger) || bounds.width < 1 || bounds.height < 1 || bounds.width > MAP_GEOMETRY.tileSide || bounds.height > MAP_GEOMETRY.tileSide || compressed.length < 18 || compressed.length > MAP_GEOMETRY.bytes) throw new Error('Invalid geometry tile bounds')
  // Check the gzip expansion size before decompression; immutable hashes alone
  // do not bound allocation when a caller supplies malformed metadata
  const expanded = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength).getUint32(compressed.length - 4, true)
  if (expanded < MAP_GEOMETRY.header || expanded > MAP_GEOMETRY.header + total * MAP_GEOMETRY.stride) throw new Error('Geometry tile expansion exceeds bounds')
  const bytes = gunzipSync(compressed, { out: new Uint8Array(expanded) })
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length !== expanded || header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== layer || header.getInt32(8, true) !== bounds.x || header.getInt32(12, true) !== bounds.z || header.getUint8(16) !== bounds.width || header.getUint8(17) !== bounds.height || header.getUint16(18, true) !== 0 || header.getUint32(20, true) * MAP_GEOMETRY.stride !== bytes.length - MAP_GEOMETRY.header) throw new Error('Geometry tile identity differs')
  const cells = bytes.subarray(MAP_GEOMETRY.header)
  let previousEnd = -1
  let minY = Infinity
  let maxY = -Infinity
  for (let offset = 0; offset < cells.length; offset += MAP_GEOMETRY.stride) {
    const [x, y, z, voxelId, faces, height] = cells.subarray(offset, offset + MAP_GEOMETRY.stride) as Uint8Array
    const start = (x! * bounds.height + z!) * MAP_GEOMETRY.height + y!
    if (x! >= bounds.width || z! >= bounds.height || voxelId === 0 || voxelId === 255 || !faces || faces > MAP_FACE.all || !height || y! + height > MAP_GEOMETRY.height || start <= previousEnd) throw new Error('Invalid or overlapping geometry run')
    previousEnd = start + height - 1
    minY = Math.min(minY, y!); maxY = Math.max(maxY, y! + height)
  }
  if (!cells.length || minY !== metadata.minY || maxY !== metadata.maxY) throw new Error('Geometry height range differs')
  return { bounds, layer, cells }
}
