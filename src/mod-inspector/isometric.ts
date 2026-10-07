import { MAP_SURFACE_LIMITS, mapSurfaceCell, type MapSurface } from '../domain/map-surface'
import type { WorldMapBounds } from '../domain/world-map'
import { MAP_FACE, MAP_GEOMETRY, type MapGeometryMetadata, type MapGeometryTile } from '../domain/map-geometry'
import { MAP_EDITOR_LIMITS, type MapPlacement, type PlacementCoord } from './map-editor'

export const ISO = Object.freeze({ halfWidth: 24, halfDepth: 12, height: 24, viewWidth: 960, viewHeight: 600, maxPlacements: 400, rotations: 8, angleStep: 45, sideDepth: 96 })
export type IsoRotation = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
// The native default's Y/Z camera position yields 56 degrees downward
// This preset approximates that profile without reproducing the game's perspective
export const ISO_ELEVATION = Object.freeze({ side: 0, game: 56, angled: 45, top: 90, min: 20, max: 65, step: 5 } as const)
// Native baseline distances bound the orthographic approximation's viewing ray
export const ISO_CLIP = Object.freeze({ distance: 17.5, near: .1, far: 80 })
export const ISO_PRESET = Object.freeze({ isometric: { rotation: 0, elevation: ISO_ELEVATION.angled }, game: { rotation: 1, elevation: ISO_ELEVATION.game } } as const)
export type IsoElevation = number
export interface IsoPoint { readonly x: number; readonly y: number }
export interface IsoCamera { readonly coord: PlacementCoord; readonly rotation: IsoRotation; readonly zoom: number; readonly elevation?: IsoElevation; readonly clipDepth?: boolean }
export interface IsoHeightRange { readonly min: number; readonly max: number }
interface IsoSurfaceTile { readonly bounds: WorldMapBounds; readonly height: IsoHeightRange }
export interface IsoSurfaceIndex { readonly columns: number; readonly height: IsoHeightRange; readonly tiles: readonly (IsoSurfaceTile | undefined)[] }
export interface IsoSurfaceCell { readonly coord: PlacementCoord; readonly voxelId: number; readonly underwater: boolean }
export interface IsoGeometryCell { readonly coord: PlacementCoord; readonly voxelId: number; readonly faces: number; readonly height: number }
const VIEWPORT_MARGIN = 2
const SURFACE_STRIDE = 3
const SURFACE_TILE_SIDE = 32
const DIAGONAL = Math.SQRT1_2
const ORBITS = [[1, 0], [DIAGONAL, DIAGONAL], [0, 1], [-DIAGONAL, DIAGONAL], [-1, 0], [-DIAGONAL, -DIAGONAL], [0, -1], [DIAGONAL, -DIAGONAL]] as const
export type IsoAxis = 'X' | 'Y' | 'Z'
export interface IsoFace { readonly mask: number; readonly axis: IsoAxis; readonly direction: -1 | 1; readonly points: readonly PlacementCoord[] }

export function isoProjection(camera: Pick<IsoCamera, 'rotation' | 'elevation' | 'zoom'>) {
  const [c, s] = ORBITS[camera.rotation]
  const elevation = camera.elevation ?? ISO_ELEVATION.angled
  // Exact endpoints avoid tiny visible faces and singular inverses in side/top views
  // All world axes share one scale, so changing yaw cannot stretch a block face
  const angle = elevation * Math.PI / 180
  const depth = elevation === ISO_ELEVATION.side ? 0 : ISO.halfWidth * Math.sin(angle) * camera.zoom
  const height = elevation === ISO_ELEVATION.top ? 0 : ISO.height * Math.cos(angle) / DIAGONAL * camera.zoom
  return { xX: (c + s) * ISO.halfWidth * camera.zoom, xZ: (s - c) * ISO.halfWidth * camera.zoom, yX: (c - s) * depth, yY: -height, yZ: (s + c) * depth, viewX: (c - s) * height, viewY: 2 * depth, viewZ: (s + c) * height }
}

export function isoVisibleFaces(camera: IsoCamera): number {
  const p = isoProjection(camera)
  return (p.viewY > 0 ? MAP_FACE.top : 0) | (p.viewX > 0 ? MAP_FACE.xPos : p.viewX < 0 ? MAP_FACE.xNeg : 0) | (p.viewZ > 0 ? MAP_FACE.zPos : p.viewZ < 0 ? MAP_FACE.zNeg : 0)
}

function cameraRay(camera: IsoCamera) {
  const p = isoProjection(camera)
  const length = Math.hypot(p.viewX, p.viewY, p.viewZ)
  return { X: p.viewX / length, Y: p.viewY / length, Z: p.viewZ / length }
}
export function isoCameraDepth(coord: PlacementCoord, camera: IsoCamera): number {
  const ray = cameraRay(camera)
  return (coord.X - camera.coord.X) * ray.X + (coord.Y - camera.coord.Y) * ray.Y + (coord.Z - camera.coord.Z) * ray.Z
}
function clipFace(points: readonly PlacementCoord[], camera: IsoCamera): readonly PlacementCoord[] {
  if (!camera.clipDepth) return points
  const ray = cameraRay(camera)
  const depth = (p: PlacementCoord) => (p.X - camera.coord.X) * ray.X + (p.Y - camera.coord.Y) * ray.Y + (p.Z - camera.coord.Z) * ray.Z
  let result = points
  // Cull whole faces cheaply, then trim intersecting runs rather than inventing solid cut faces
  // A screen overlap alone includes walls behind the virtual camera and can hide the entire map
  for (const [bound, direction] of [[ISO_CLIP.distance - ISO_CLIP.far, 1], [ISO_CLIP.distance - ISO_CLIP.near, -1]] as const) {
    if (result.every(p => (depth(p) - bound) * direction >= 0)) continue
    const clipped: PlacementCoord[] = []
    for (let index = 0; index < result.length; index++) {
      const a = result[index]!
      const b = result[(index + 1) % result.length]!
      const da = depth(a) - bound
      const db = depth(b) - bound
      const insideA = da * direction >= 0
      const insideB = db * direction >= 0
      if (insideA) clipped.push(a)
      if (insideA !== insideB) {
        const ratio = da / (da - db)
        clipped.push({ X: a.X + (b.X - a.X) * ratio, Y: a.Y + (b.Y - a.Y) * ratio, Z: a.Z + (b.Z - a.Z) * ratio })
      }
    }
    result = clipped
  }
  return result
}

export function isoFaces(coord: PlacementCoord, height: number, camera: IsoCamera, mask: number = MAP_FACE.all, visibleFaces: number = isoVisibleFaces(camera)): readonly IsoFace[] {
  const corner = (x: number, y: number, z: number) => ({ X: coord.X + x, Y: coord.Y + y, Z: coord.Z + z })
  const visible = mask & visibleFaces
  const faces: IsoFace[] = []
  if (visible & (MAP_FACE.xNeg | MAP_FACE.xPos)) {
    const x = visible & MAP_FACE.xPos ? 1 : 0
    faces.push({ mask: x ? MAP_FACE.xPos : MAP_FACE.xNeg, axis: 'X', direction: x ? 1 : -1, points: [corner(x, 0, 0), corner(x, 0, 1), corner(x, height, 1), corner(x, height, 0)] })
  }
  if (visible & (MAP_FACE.zNeg | MAP_FACE.zPos)) {
    const z = visible & MAP_FACE.zPos ? 1 : 0
    faces.push({ mask: z ? MAP_FACE.zPos : MAP_FACE.zNeg, axis: 'Z', direction: z ? 1 : -1, points: [corner(0, 0, z), corner(1, 0, z), corner(1, height, z), corner(0, height, z)] })
  }
  if (visible & MAP_FACE.top) faces.push({ mask: MAP_FACE.top, axis: 'Y', direction: 1, points: [corner(0, height, 0), corner(1, height, 0), corner(1, height, 1), corner(0, height, 1)] })
  return camera.clipDepth ? faces.map(face => ({ ...face, points: clipFace(face.points, camera) })).filter(face => face.points.length >= 3) : faces
}

export function isoPointOnPlane(point: IsoPoint, camera: IsoCamera, axis: IsoAxis, value: number): PlacementCoord | undefined {
  const p = isoProjection(camera)
  const rows = { X: [p.xX, p.yX], Y: [0, p.yY], Z: [p.xZ, p.yZ] } as const
  const free = (['X', 'Y', 'Z'] as const).filter(key => key !== axis)
  const [a, b] = free as [IsoAxis, IsoAxis]
  const determinant = rows[a][0] * rows[b][1] - rows[b][0] * rows[a][1]
  // A face parallel to the viewing ray has no unique screen-to-world intersection
  if (!determinant) return undefined
  const fixed = value - camera.coord[axis]
  const x = point.x - ISO.viewWidth / 2 - rows[axis][0] * fixed
  const y = point.y - ISO.viewHeight / 2 - rows[axis][1] * fixed
  return { ...camera.coord, [axis]: value, [a]: camera.coord[a] + (x * rows[b][1] - rows[b][0] * y) / determinant, [b]: camera.coord[b] + (rows[a][0] * y - x * rows[a][1]) / determinant }
}

export function isoGeometryBoundsVisible(bounds: WorldMapBounds, minY: number, maxY: number, camera: IsoCamera): boolean {
  // Side view has an unbounded depth ray; use a finite camera neighborhood there
  if (camera.elevation === ISO_ELEVATION.side && (bounds.x > camera.coord.X + ISO.sideDepth || bounds.x + bounds.width < camera.coord.X - ISO.sideDepth || bounds.z > camera.coord.Z + ISO.sideDepth || bounds.z + bounds.height < camera.coord.Z - ISO.sideDepth)) return false
  // Absolute matrix coefficients give exact bounds at every yaw and elevation
  // A tall wall can intersect the viewport even when its base does not
  const p = isoProject({ X: bounds.x + bounds.width / 2, Y: (minY + maxY) / 2, Z: bounds.z + bounds.height / 2 }, camera)
  const matrix = isoProjection(camera)
  if (camera.clipDepth) {
    const ray = cameraRay(camera)
    const depth = (bounds.x + bounds.width / 2 - camera.coord.X) * ray.X + ((minY + maxY) / 2 - camera.coord.Y) * ray.Y + (bounds.z + bounds.height / 2 - camera.coord.Z) * ray.Z
    const radius = (bounds.width * Math.abs(ray.X) + bounds.height * Math.abs(ray.Z) + (maxY - minY) * Math.abs(ray.Y)) / 2
    if (depth - radius > ISO_CLIP.distance - ISO_CLIP.near || depth + radius < ISO_CLIP.distance - ISO_CLIP.far) return false
  }
  const halfWidth = (bounds.width * Math.abs(matrix.xX) + bounds.height * Math.abs(matrix.xZ)) / 2
  const halfHeight = (bounds.width * Math.abs(matrix.yX) + bounds.height * Math.abs(matrix.yZ) + (maxY - minY) * Math.abs(matrix.yY)) / 2
  return p.x + halfWidth >= 0 && p.x - halfWidth <= ISO.viewWidth && p.y + halfHeight >= 0 && p.y - halfHeight <= ISO.viewHeight
}
export function isoVisibleGeometryTiles(tiles: readonly MapGeometryMetadata[], camera: IsoCamera): readonly MapGeometryMetadata[] {
  return tiles.filter(tile => isoGeometryBoundsVisible(tile.bounds, tile.minY, tile.maxY, camera))
    .sort((a, b) => Math.hypot(a.bounds.x - camera.coord.X, a.bounds.z - camera.coord.Z) - Math.hypot(b.bounds.x - camera.coord.X, b.bounds.z - camera.coord.Z))
}
export function isoVisibleGeometry(tiles: readonly MapGeometryTile[], camera: IsoCamera): readonly IsoGeometryCell[] {
  const visibleFaces = isoVisibleFaces(camera)
  const cells: IsoGeometryCell[] = []
  for (const tile of tiles) for (let offset = 0; offset < tile.cells.length; offset += MAP_GEOMETRY.stride) {
    const faces = tile.cells[offset + 4]! & visibleFaces
    if (!faces) continue
    const X = tile.bounds.x + tile.cells[offset]!
    const Y = tile.cells[offset + 1]!
    const Z = tile.bounds.z + tile.cells[offset + 2]!
    const height = tile.cells[offset + 5]!
    if (isoGeometryBoundsVisible({ x: X, z: Z, width: 1, height: 1 }, Y, Y + height, camera)) cells.push({ coord: { X, Y, Z }, voxelId: tile.cells[offset + 3]!, faces, height })
  }
  return cells
}

export function isoProject(coord: PlacementCoord, camera: IsoCamera): IsoPoint {
  const p = isoProjection(camera)
  const x = coord.X - camera.coord.X
  const y = coord.Y - camera.coord.Y
  const z = coord.Z - camera.coord.Z
  return { x: ISO.viewWidth / 2 + x * p.xX + z * p.xZ, y: ISO.viewHeight / 2 + x * p.yX + y * p.yY + z * p.yZ }
}
export function isoViewportFootprint(camera: IsoCamera, height = camera.coord.Y): readonly PlacementCoord[] {
  if (camera.elevation === ISO_ELEVATION.side) return []
  return [[0, 0], [ISO.viewWidth, 0], [ISO.viewWidth, ISO.viewHeight], [0, ISO.viewHeight]].map(([x, y]) => isoPointOnPlane({ x: x!, y: y! }, camera, 'Y', height)!)
}
export function isoSurfaceIndex(surface: MapSurface): IsoSurfaceIndex {
  const columns = Math.ceil(surface.bounds.width / SURFACE_TILE_SIDE)
  const rows = Math.ceil(surface.bounds.height / SURFACE_TILE_SIDE)
  const tiles: (IsoSurfaceTile | undefined)[] = []
  let min = Infinity
  let max = -Infinity
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const localX = column * SURFACE_TILE_SIDE
    const localZ = row * SURFACE_TILE_SIDE
    const width = Math.min(SURFACE_TILE_SIDE, surface.bounds.width - localX)
    const height = Math.min(SURFACE_TILE_SIDE, surface.bounds.height - localZ)
    let tileMin = Infinity
    let tileMax = -Infinity
    for (let z = localZ; z < localZ + height; z++) for (let x = localX; x < localX + width; x++) {
      const offset = (z * surface.bounds.width + x) * SURFACE_STRIDE
      if (surface.cells[offset] === MAP_SURFACE_LIMITS.empty) continue
      tileMin = Math.min(tileMin, surface.cells[offset + 1]! - 1); tileMax = Math.max(tileMax, surface.cells[offset + 1]!)
    }
    tiles.push(Number.isFinite(tileMin) ? { bounds: { x: surface.bounds.x + localX, z: surface.bounds.z + localZ, width, height }, height: { min: tileMin, max: tileMax } } : undefined)
    min = Math.min(min, tileMin); max = Math.max(max, tileMax)
  }
  return { columns, tiles, height: Number.isFinite(min) ? { min, max } : { min: 0, max: 0 } }
}
export function isoVisibleSurface(surface: MapSurface, index: IsoSurfaceIndex, camera: IsoCamera): readonly IsoSurfaceCell[] {
  const cells: IsoSurfaceCell[] = []
  const candidates = isoTerrainBounds(camera, index.height, surface.bounds)
  if (!candidates.width || !candidates.height) return cells
  const firstColumn = Math.floor((candidates.x - surface.bounds.x) / SURFACE_TILE_SIDE)
  const firstRow = Math.floor((candidates.z - surface.bounds.z) / SURFACE_TILE_SIDE)
  const lastColumn = Math.floor((candidates.x + candidates.width - 1 - surface.bounds.x) / SURFACE_TILE_SIDE)
  const lastRow = Math.floor((candidates.z + candidates.height - 1 - surface.bounds.z) / SURFACE_TILE_SIDE)
  // Each tile retains its actual height extremes, so a distant tall cell does not
  // force every pan to scan unrelated low terrain or empty map regions
  for (let row = firstRow; row <= lastRow; row++) for (let column = firstColumn; column <= lastColumn; column++) {
    const tile = index.tiles[row * index.columns + column]
    if (!tile || !isoGeometryBoundsVisible(tile.bounds, tile.height.min, tile.height.max, camera)) continue
    const bounds = isoTerrainBounds(camera, tile.height, tile.bounds)
    for (let z = bounds.z; z < bounds.z + bounds.height; z++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const offset = ((z - surface.bounds.z) * surface.bounds.width + x - surface.bounds.x) * SURFACE_STRIDE
      const voxelId = surface.cells[offset]!
      if (voxelId === MAP_SURFACE_LIMITS.empty) continue
      const coord = { X: x, Y: surface.cells[offset + 1]! - 1, Z: z }
      if (isoCellVisible(coord, camera)) cells.push({ coord, voxelId, underwater: (surface.cells[offset + 2]! & MAP_SURFACE_LIMITS.underwater) !== 0 })
    }
  }
  return cells
}
export function isoTerrainBounds(camera: IsoCamera, height: IsoHeightRange, bounds: WorldMapBounds): WorldMapBounds {
  // An edge-on ground plane has no finite footprint; tile prism culling still bounds paint
  if (camera.elevation === ISO_ELEVATION.side) {
    const x = Math.max(bounds.x, Math.floor(camera.coord.X - ISO.sideDepth))
    const z = Math.max(bounds.z, Math.floor(camera.coord.Z - ISO.sideDepth))
    return { x, z, width: Math.max(0, Math.min(bounds.x + bounds.width, Math.ceil(camera.coord.X + ISO.sideDepth)) - x), height: Math.max(0, Math.min(bounds.z + bounds.height, Math.ceil(camera.coord.Z + ISO.sideDepth)) - z) }
  }
  // A high surface can project into view from beyond the ground-plane footprint
  // Union both height extremes before clipping; a fixed X/Z radius drops those cells
  const points = [...isoViewportFootprint(camera, height.min), ...isoViewportFootprint(camera, height.max)]
  const x = Math.max(bounds.x, Math.floor(Math.min(...points.map(point => point.X))) - VIEWPORT_MARGIN)
  const z = Math.max(bounds.z, Math.floor(Math.min(...points.map(point => point.Z))) - VIEWPORT_MARGIN)
  const right = Math.min(bounds.x + bounds.width, Math.ceil(Math.max(...points.map(point => point.X))) + VIEWPORT_MARGIN)
  const bottom = Math.min(bounds.z + bounds.height, Math.ceil(Math.max(...points.map(point => point.Z))) + VIEWPORT_MARGIN)
  return { x, z, width: Math.max(0, right - x), height: Math.max(0, bottom - z) }
}
export function isoCellVisible(coord: PlacementCoord, camera: IsoCamera): boolean {
  return isoGeometryBoundsVisible({ x: coord.X, z: coord.Z, width: 1, height: 1 }, coord.Y, coord.Y + 1, camera)
}
// Invert the ground plane at a fixed Y before undoing the camera orbit
// Height uses a separate handle because one screen position cannot determine all three axes
export function isoGroundDelta(point: IsoPoint, camera: Pick<IsoCamera, 'rotation' | 'zoom' | 'elevation'>): Pick<PlacementCoord, 'X' | 'Z'> {
  const coord = isoPointOnPlane({ x: point.x + ISO.viewWidth / 2, y: point.y + ISO.viewHeight / 2 }, { ...camera, coord: { X: 0, Y: 0, Z: 0 } }, 'Y', 0)
  if (!coord) throw new Error('Tilt up from side view to drag on X/Z.')
  return { X: Math.round(coord.X), Z: Math.round(coord.Z) }
}
export function isoDragCoord(origin: PlacementCoord, delta: IsoPoint, camera: IsoCamera, mode: 'ground' | 'height'): PlacementCoord {
  const ground = mode === 'ground' ? isoGroundDelta(delta, camera) : { X: 0, Z: 0 }
  const scale = -isoProjection(camera).yY
  if (mode === 'height' && !scale) throw new Error('Tilt down from top view to drag height Y.')
  const result = mode === 'height' ? { ...origin, Y: origin.Y - Math.round(delta.y / scale) } : { X: origin.X + ground.X, Y: origin.Y, Z: origin.Z + ground.Z }
  if (!Object.values(result).every(value => Number.isInteger(value) && value >= MAP_EDITOR_LIMITS.intMin && value <= MAP_EDITOR_LIMITS.intMax)) throw new Error('Drag exceeds the supported coordinate range.')
  return result
}
export function placementPreview(coord: PlacementCoord, placements: readonly MapPlacement[], selectedId: number | undefined, surface?: MapSurface): string {
  if (placements.some(value => value.id !== selectedId && value.hasVoxelOutfit && value.coord.X === coord.X && value.coord.Y === coord.Y && value.coord.Z === coord.Z)) return 'Overlaps an authored voxel placement'
  if (placements.some(value => value.id !== selectedId && value.staticVoxel && value.coord.X === coord.X && value.coord.Y + 1 === coord.Y && value.coord.Z === coord.Z)) return 'Rests on a stationary authored block'
  const ground = surface && mapSurfaceCell(surface, coord.X, coord.Z)
  if (!ground) return 'Native surface height unknown here'
  if (ground.underwater) return `Underwater mapped surface at Y ${ground.height}; support unknown`
  if (coord.Y === ground.height) return `Aligned with mapped surface at Y ${ground.height}`
  if (coord.Y > ground.height) return `${coord.Y - ground.height} cells above mapped surface; support unknown`
  return `${ground.height - coord.Y} cells below mapped surface; native clearance unknown`
}
