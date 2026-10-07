import { useEffect, useRef, useState } from 'react'
import { isoDragCoord, type IsoCamera, type IsoPoint } from '../../mod-inspector/isometric'
import { MAP_EDITOR_LIMITS, type PlacementCoord } from '../../mod-inspector/map-editor'
import { brushPlaneCell, pickConstructionPlane, pickVoxelFace, voxelBrushStamp, voxelCellKey, voxelPlatformStamp, voxelStrokeLine, type BrushCell, type BrushPick } from '../../mod-inspector/voxel-brush'

export type VoxelBrushAction = 'paint' | 'erase' | 'platform'
interface Gesture {
  readonly pointerId: number; readonly pick: BrushPick; readonly camera: IsoCamera; readonly source: string
  readonly coords: Map<string, PlacementCoord>; readonly ids: Set<number>
  readonly start: IsoPoint; readonly size: number; readonly depth: number
  last: PlacementCoord; point: IsoPoint
}
interface Options {
  readonly camera: IsoCamera; readonly cells: readonly BrushCell[]; readonly action?: VoxelBrushAction
  readonly size: number; readonly depth?: number; readonly active: boolean; readonly disabled: boolean; readonly source: string; readonly cancelAttempt: number
  readonly planeHeight?: number
  readonly erasableIds: ReadonlySet<number>; readonly occupied: ReadonlySet<string>
  readonly onApply: (action: VoxelBrushAction, coords: readonly PlacementCoord[], ids: readonly number[], expected: string) => void
  readonly onGestureChange: (pending: boolean) => void
}
const SCREEN_SAMPLE_STEP = 4
const EMPTY_STROKE: readonly PlacementCoord[] = []

export function useVoxelBrush({ camera, cells, action, size, depth = size, active, disabled, source, cancelAttempt, planeHeight, erasableIds, occupied, onApply, onGestureChange }: Options) {
  const [hover, setHover] = useState<BrushPick>()
  const [stroke, setStroke] = useState<readonly PlacementCoord[]>(EMPTY_STROKE)
  const [hint, setHint] = useState('')
  const gesture = useRef<Gesture | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)
  const queuedPoint = useRef<IsoPoint | undefined>(undefined)

  function stopFrame() { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; queuedPoint.current = undefined }
  function cancel() {
    stopFrame()
    if (gesture.current) onGestureChange(false)
    gesture.current = undefined; setStroke(EMPTY_STROKE); setHover(undefined)
  }
  useEffect(() => { cancel(); setHint('') }, [source, action, active, disabled, camera.rotation, camera.elevation, camera.zoom, camera.coord.X, camera.coord.Y, camera.coord.Z, size, depth, cancelAttempt, planeHeight])
  useEffect(() => () => { stopFrame(); if (gesture.current) onGestureChange(false) }, [])

  const pickAt = (point: IsoPoint) => action !== 'erase' && planeHeight !== undefined ? pickConstructionPlane(point, camera, planeHeight) : pickVoxelFace(point, cells, camera)

  function collect(point: IsoPoint, current: Gesture) {
    if (action === 'platform') {
      // Drag relocates one horizontal footprint instead of accumulating a trail of platforms
      // Retain the first target's height and dimensions until a guarded release applies it
      const coord = isoDragCoord(current.pick.adjacent, { x: point.x - current.start.x, y: point.y - current.start.y }, current.camera, 'ground')
      const first = current.coords.values().next().value
      if (first && voxelCellKey(first) === voxelCellKey(coord)) return
      const next = voxelPlatformStamp(coord, current.size, current.depth)
      current.coords.clear()
      for (const cell of next) current.coords.set(voxelCellKey(cell), cell)
      setStroke(next)
      setHover({ ...current.pick, adjacent: coord })
      return
    }
    const count = current.coords.size
    if (action === 'paint') {
      const next = brushPlaneCell(point, current.camera, current.pick)
      if (!next) return
      // Lock the first face's plane so crossing the pending brush does not stack blocks
      // Interpolate skipped pointer cells; the entire bounded stroke commits on release
      for (const coord of voxelStrokeLine(current.last, next)) for (const cell of voxelBrushStamp(coord, current.pick.axis, size)) {
        if (!occupied.has(voxelCellKey(cell))) current.coords.set(voxelCellKey(cell), cell)
        if (current.coords.size > MAP_EDITOR_LIMITS.strokeCells) throw new Error('Stroke is too large. Release and paint a smaller area.')
      }
      current.last = next
    } else {
      const steps = Math.ceil(Math.hypot(point.x - current.point.x, point.y - current.point.y) / SCREEN_SAMPLE_STEP)
      if (steps > MAP_EDITOR_LIMITS.strokeCells) throw new Error('Erase stroke is too long. Release and start another stroke.')
      for (let index = 0; index <= steps; index++) {
        const sample = { x: current.point.x + (point.x - current.point.x) * (steps ? index / steps : 0), y: current.point.y + (point.y - current.point.y) * (steps ? index / steps : 0) }
        const pick = pickVoxelFace(sample, cells, current.camera)
        if (pick?.id !== undefined && erasableIds.has(pick.id)) { current.ids.add(pick.id); current.coords.set(voxelCellKey(pick.coord), pick.coord) }
        if (current.ids.size > MAP_EDITOR_LIMITS.strokeCells) throw new Error('Erase stroke is too large. Release and start another stroke.')
      }
    }
    current.point = point
    if (current.coords.size !== count) setStroke([...current.coords.values()])
  }
  function process(point: IsoPoint) {
    try {
      if (gesture.current) collect(point, gesture.current)
      else {
        const pick = pickAt(point)
        setHover(previous => previous && pick && previous.id === pick.id && previous.axis === pick.axis && voxelCellKey(previous.adjacent) === voxelCellKey(pick.adjacent) ? previous : pick)
      }
    } catch (reason) { cancel(); setHint(reason instanceof Error ? reason.message : String(reason)) }
  }
  function start(point: IsoPoint, pointerId: number) {
    if (gesture.current) { if (gesture.current.pointerId !== pointerId) cancel(); return false }
    if (!action || disabled || !active) return false
    const pick = pickAt(point)
    if (!pick || action === 'erase' && (pick.id === undefined || !erasableIds.has(pick.id))) { setHint(action === 'erase' ? 'Erase targets added stationary blocks. Native terrain and other entities stay unchanged.' : action === 'platform' ? 'Point at a visible face, or enter a valid Placement height Y to place a platform in empty space.' : 'Point at a visible block face to place blocks.'); return false }
    gesture.current = { pointerId, pick, camera, source, coords: new Map(), ids: new Set(), last: pick.adjacent, point, start: point, size, depth }
    setHint(''); onGestureChange(true); process(point)
    return Boolean(gesture.current)
  }
  function update(point: IsoPoint, pointerId: number) {
    if (gesture.current && gesture.current.pointerId !== pointerId) return
    if (!action || disabled || !active) return
    queuedPoint.current = point
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => { frame.current = undefined; const latest = queuedPoint.current; queuedPoint.current = undefined; if (latest) process(latest) })
  }
  function finish(point: IsoPoint, pointerId: number, cancelled: boolean) {
    const current = gesture.current
    if (!current || current.pointerId !== pointerId) return false
    stopFrame()
    if (cancelled || disabled || !active || current.source !== source || current.size !== size || current.depth !== depth) { cancel(); return true }
    process(point)
    if (!gesture.current) return true
    gesture.current = undefined; setStroke(EMPTY_STROKE); setHover(undefined); onGestureChange(false)
    if (action) onApply(action, [...current.coords.values()], [...current.ids], current.source)
    return true
  }
  return { hover, stroke, hint, start, update, finish, cancel, pointerId: gesture.current?.pointerId }
}
