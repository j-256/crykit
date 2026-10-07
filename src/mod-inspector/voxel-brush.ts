import { isoFaces, isoPointOnPlane, isoProject, isoProjection, type IsoAxis, type IsoCamera, type IsoPoint } from './isometric'
import { MAP_EDITOR_LIMITS, type PlacementCoord } from './map-editor'

export interface BrushCell { readonly coord: PlacementCoord; readonly height: number; readonly faces: number; readonly id?: number }
export interface BrushPick { readonly coord: PlacementCoord; readonly adjacent: PlacementCoord; readonly axis: IsoAxis; readonly plane: number; readonly id?: number }
const AXES = ['X', 'Y', 'Z'] as const
const EPSILON = 1e-7
export const voxelCellKey = (coord: PlacementCoord) => `${coord.X},${coord.Y},${coord.Z}`

function contains(point: IsoPoint, polygon: readonly IsoPoint[]): boolean {
  let positive = false
  let negative = false
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!
    const b = polygon[(index + 1) % polygon.length]!
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    positive ||= cross > EPSILON; negative ||= cross < -EPSILON
    if (positive && negative) return false
  }
  return positive || negative
}

export function pickVoxelFace(point: IsoPoint, cells: readonly BrushCell[], camera: IsoCamera): BrushPick | undefined {
  const matrix = isoProjection(camera)
  let nearest = -Infinity
  let picked: BrushPick | undefined
  for (const cell of cells) {
    const center = isoProject({ X: cell.coord.X + .5, Y: cell.coord.Y + cell.height / 2, Z: cell.coord.Z + .5 }, camera)
    const width = (Math.abs(matrix.xX) + Math.abs(matrix.xZ)) / 2
    const height = (Math.abs(matrix.yX) + Math.abs(matrix.yZ) + cell.height * Math.abs(matrix.yY)) / 2
    if (Math.abs(point.x - center.x) > width + EPSILON || Math.abs(point.y - center.y) > height + EPSILON) continue
    for (const face of isoFaces(cell.coord, cell.height, camera, cell.faces)) {
      if (!contains(point, face.points.map(coord => isoProject(coord, camera)))) continue
      const plane = face.points[0]![face.axis]
      const intersection = isoPointOnPlane(point, camera, face.axis, plane)
      if (!intersection) continue
      // Pick the frontmost recorded face along the viewing ray, including side/top endpoints
      // Coordinate rounding is biased only at numerical boundaries, including negative cells
      const distance = (intersection.X - camera.coord.X) * matrix.viewX + (intersection.Y - camera.coord.Y) * matrix.viewY + (intersection.Z - camera.coord.Z) * matrix.viewZ
      if (distance < nearest) continue
      const coord = { X: cell.coord.X, Y: Math.max(cell.coord.Y, Math.min(cell.coord.Y + cell.height - 1, Math.floor(intersection.Y + EPSILON))), Z: cell.coord.Z }
      const adjacent = Object.fromEntries(AXES.map(axis => [axis, axis === face.axis ? face.direction > 0 ? axis === 'Y' ? cell.coord.Y + cell.height : cell.coord[axis] + 1 : cell.coord[axis] - 1 : Math.floor(intersection[axis] + EPSILON)])) as unknown as PlacementCoord
      nearest = distance; picked = { coord, adjacent, axis: face.axis, plane, id: cell.id }
    }
  }
  return picked
}

export function brushPlaneCell(point: IsoPoint, camera: IsoCamera, pick: BrushPick): PlacementCoord | undefined {
  const intersection = isoPointOnPlane(point, camera, pick.axis, pick.plane)
  if (!intersection) return undefined
  return { X: pick.axis === 'X' ? pick.adjacent.X : Math.floor(intersection.X + EPSILON), Y: pick.axis === 'Y' ? pick.adjacent.Y : Math.floor(intersection.Y + EPSILON), Z: pick.axis === 'Z' ? pick.adjacent.Z : Math.floor(intersection.Z + EPSILON) }
}

export function pickConstructionPlane(point: IsoPoint, camera: IsoCamera, height: number): BrushPick | undefined {
  if (!Number.isSafeInteger(height) || height < MAP_EDITOR_LIMITS.intMin || height > MAP_EDITOR_LIMITS.intMax) return undefined
  const intersection = isoPointOnPlane(point, camera, 'Y', height)
  if (!intersection) return undefined
  const adjacent = { X: Math.floor(intersection.X + EPSILON), Y: height, Z: Math.floor(intersection.Z + EPSILON) }
  if (![adjacent.X, adjacent.Z].every(value => value >= MAP_EDITOR_LIMITS.intMin && value <= MAP_EDITOR_LIMITS.intMax)) return undefined
  // A construction target is only a plane intersection, never an air entity or support claim
  return { coord: adjacent, adjacent, axis: 'Y', plane: height }
}

export function voxelStrokeLine(start: PlacementCoord, end: PlacementCoord): readonly PlacementCoord[] {
  const steps = Math.max(...AXES.map(axis => Math.abs(end[axis] - start[axis])))
  if (!Number.isInteger(steps) || steps >= MAP_EDITOR_LIMITS.strokeCells) throw new Error('The brush stroke is too long. Release and start another stroke.')
  return Array.from({ length: steps + 1 }, (_, index) => Object.fromEntries(AXES.map(axis => [axis, Math.round(start[axis] + (end[axis] - start[axis]) * (steps ? index / steps : 0))])) as unknown as PlacementCoord)
}

export function voxelBrushStamp(coord: PlacementCoord, axis: IsoAxis, size: number): readonly PlacementCoord[] {
  if (!Number.isInteger(size) || size < 1 || size > MAP_EDITOR_LIMITS.brushSide) throw new Error('Unsupported voxel brush size.')
  const free = AXES.filter(value => value !== axis)
  return Array.from({ length: size * size }, (_, index) => ({ ...coord, [free[0]!]: coord[free[0]!] + Math.floor(index / size), [free[1]!]: coord[free[1]!] + index % size }))
}

export function voxelPlatformStamp(coord: PlacementCoord, width: number, depth: number): readonly PlacementCoord[] {
  if (![width, depth].every(value => Number.isInteger(value) && value >= 1 && value <= MAP_EDITOR_LIMITS.brushSide)) throw new Error(`Platform width and depth must be between 1 and ${MAP_EDITOR_LIMITS.brushSide}.`)
  if (!AXES.every(axis => Number.isSafeInteger(coord[axis]) && coord[axis] >= MAP_EDITOR_LIMITS.intMin && coord[axis] <= MAP_EDITOR_LIMITS.intMax) || coord.X + width - 1 > MAP_EDITOR_LIMITS.intMax || coord.Z + depth - 1 > MAP_EDITOR_LIMITS.intMax) throw new Error('Platform exceeds the supported coordinate range.')
  return Array.from({ length: width * depth }, (_, index) => ({ X: coord.X + Math.floor(index / depth), Y: coord.Y, Z: coord.Z + index % depth }))
}
