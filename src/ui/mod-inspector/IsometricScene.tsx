import { memo, useLayoutEffect } from 'react'
import type { MapPlacement, PlacementCoord } from '../../mod-inspector/map-editor'
import { ISO, ISO_ELEVATION, isoFaces, isoProjection, isoProject, isoVisibleFaces, type IsoCamera } from '../../mod-inspector/isometric'
import { MAP_FACE } from '../../domain/map-geometry'
import { useIsometricCanvas } from './useIsometricCanvas'

export interface IsoTerrainCell { readonly coord: PlacementCoord; readonly color: string; readonly sideColor?: string; readonly underwater: boolean; readonly voxelId: number; readonly faces: number; readonly height: number; readonly nativeGeometry: boolean }
interface Props {
  readonly active: boolean
  readonly terrain: readonly IsoTerrainCell[]; readonly placements: readonly MapPlacement[]; readonly camera: IsoCamera
  readonly colors?: Readonly<Record<string, string>>; readonly selectedId?: number; readonly preview?: { readonly id?: number; readonly coord: PlacementCoord }
}
const DEFAULT_COLOR = '#7ba1ad'
const EDGE_COLOR = '#101820'
const SELECTED_COLOR = '#73ecff'
const TERRAIN_OPACITY = 1
const WATER_OPACITY = .6
const SIDE_LIGHT = .72
const SIDE_DARK = .5
const GRID_WIDTH = 48
const GRID_HEIGHT = 24
const NATIVE_TRUNK_VOXEL_ID = 49
const shades = new Map<string, readonly [string, string]>()
function shade(color: string): readonly [string, string] {
  let result = shades.get(color)
  if (!result) {
    const rgb = [1, 3, 5].map(start => Number.parseInt(color.slice(start, start + 2), 16))
    const tone = (amount: number) => `rgb(${rgb.map(value => Math.round(value * amount)).join(',')})`
    result = [tone(SIDE_LIGHT), tone(SIDE_DARK)]; shades.set(color, result)
  }
  return result
}

export default memo(function IsometricScene({ active, terrain, placements, camera, colors, selectedId, preview }: Props) {
  const { canvasRef, size } = useIsometricCanvas()
  useLayoutEffect(() => {
    if (!active) return
    const canvas = canvasRef.current!
    const context = canvas.getContext('2d')
    if (!context) return
    const width = Math.round(size.width * size.ratio)
    const height = Math.round(size.height * size.ratio)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    context.setTransform(canvas.width / ISO.viewWidth, 0, 0, canvas.height / ISO.viewHeight, 0, 0)
    context.fillStyle = '#10151b'; context.fillRect(0, 0, ISO.viewWidth, ISO.viewHeight)
    context.strokeStyle = '#ffffff18'; context.lineWidth = .5
    context.beginPath()
    const gridSlope = GRID_WIDTH / GRID_HEIGHT
    for (let x = -ISO.viewHeight * gridSlope; x <= ISO.viewWidth + ISO.viewHeight * gridSlope; x += GRID_WIDTH) {
      context.moveTo(x, 0); context.lineTo(x + ISO.viewHeight * gridSlope, ISO.viewHeight)
      context.moveTo(x, 0); context.lineTo(x - ISO.viewHeight * gridSlope, ISO.viewHeight)
    }
    context.stroke()
    const projection = isoProjection(camera)
    const visibleFaces = isoVisibleFaces(camera)
    const polygon = (points: readonly PlacementCoord[], color: string) => {
      context.beginPath()
      points.forEach((point, index) => { const x = point.X - camera.coord.X; const y = point.Y - camera.coord.Y; const z = point.Z - camera.coord.Z; const screenX = ISO.viewWidth / 2 + x * projection.xX + z * projection.xZ; const screenY = ISO.viewHeight / 2 + x * projection.yX + y * projection.yY + z * projection.yZ; if (index) context.lineTo(screenX, screenY); else context.moveTo(screenX, screenY) })
      context.closePath(); context.fillStyle = color; context.fill(); context.stroke()
    }
    const cube = (coord: PlacementCoord, color: string, faces: number = MAP_FACE.all, height = 1, sideColor = color) => {
      const tones = shade(sideColor)
      for (const face of isoFaces(coord, height, camera, faces, visibleFaces)) polygon(face.points, face.axis === 'Y' ? color : face.axis === 'X' ? tones[0] : tones[1])
    }
    // Terrain and placements share depth order, so drawing on a canvas does not make
    // authored blocks appear in front of terrain that should visually occlude them
    // Side view flattens the ground plane, but its hidden depth still orders occlusion
    const order = isoProjection({ ...camera, elevation: ISO_ELEVATION.angled })
    const entries = [
      ...terrain.map(cell => ({ coord: cell.coord, cell, placement: undefined })),
      ...placements.map(placement => ({ coord: preview?.id === placement.id ? preview.coord : placement.coord, cell: undefined, placement })),
    ].map(entry => ({ ...entry, depth: entry.coord.X * order.yX + entry.coord.Z * order.yZ }))
      .sort((a, b) => a.depth - b.depth || a.coord.Y - b.coord.Y)
    for (const entry of entries) {
      const selected = entry.placement !== undefined && entry.placement.id === selectedId
      context.strokeStyle = selected ? SELECTED_COLOR : EDGE_COLOR
      context.lineWidth = selected ? 2 : .7
      context.globalAlpha = entry.cell ? entry.cell.underwater ? WATER_OPACITY : TERRAIN_OPACITY : 1
      const color = entry.cell?.color ?? colors?.[String(entry.placement?.voxelId)] ?? DEFAULT_COLOR
      if (entry.cell || entry.placement?.hasVoxelOutfit) cube(entry.coord, color, entry.cell?.faces, entry.cell?.height, entry.cell?.sideColor)
      else {
        const p = isoProject({ ...entry.coord, X: entry.coord.X + .5, Z: entry.coord.Z + .5 }, camera)
        context.beginPath(); context.moveTo(p.x, p.y - 34); context.lineTo(p.x + 13, p.y - 17); context.lineTo(p.x, p.y); context.lineTo(p.x - 13, p.y - 17); context.closePath()
        context.fillStyle = color; context.fill(); context.stroke()
        context.beginPath(); context.arc(p.x, p.y, 5, 0, Math.PI * 2); context.fill()
      }
    }
    context.globalAlpha = 1
  }, [active, terrain, placements, camera, colors, selectedId, preview, size])
  // The SVG above this bitmap supplies placement hit areas and accessible controls
  // Visible terrain is paint data, not thousands of React nodes rebuilt per pointer event
  return <canvas ref={canvasRef} className="iso-scene-bitmap" aria-hidden="true" data-terrain-cells={terrain.length} data-geometry-runs={terrain.filter(cell => cell.nativeGeometry).length} data-wall-runs={terrain.filter(cell => cell.nativeGeometry && (cell.faces & ~MAP_FACE.top)).length} data-trunk-runs={terrain.filter(cell => cell.nativeGeometry && cell.voxelId === NATIVE_TRUNK_VOXEL_ID).length}/>
})
