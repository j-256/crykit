import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { loadMapSurface } from '../../catalog/world-map'
import { mapSurfaceCell, type MapSurface } from '../../domain/map-surface'
import { MAP_FACE } from '../../domain/map-geometry'
import type { WorldMapManifest, WorldMarker } from '../../domain/world-map'
import { MAP_EDITOR_LIMITS, type MapPlacement, type PlacementCoord } from '../../mod-inspector/map-editor'
import { ISO, ISO_ELEVATION, ISO_PRESET, isoCellVisible, isoDragCoord, isoGroundDelta, isoFaces, isoProject, isoSurfaceIndex, isoVisibleSurface, isoVisibleGeometry, placementPreview, type IsoCamera, type IsoElevation, type IsoPoint, type IsoRotation } from '../../mod-inspector/isometric'
import { Button, Field, IconButton, InlineNotice } from '../components'
import MapOrientation from './MapOrientation'
import IsometricScene, { type IsoTerrainCell } from './IsometricScene'
import IsometricBrushOverlay from './IsometricBrushOverlay'
import IsometricConstructionPlane from './IsometricConstructionPlane'
import MapEditorTools, { isMapShortcut, type MapEditorHistory, type MapEditorTool } from './MapEditorTools'
import { useMapGeometry } from './useMapGeometry'
import { useVoxelBrush, type VoxelBrushAction } from './useVoxelBrush'
import { voxelBrushStamp, voxelCellKey, type BrushCell } from '../../mod-inspector/voxel-brush'

interface Drag { readonly pointerId: number; readonly start: IsoPoint; readonly origin: PlacementCoord; readonly camera: IsoCamera; readonly mode: 'ground' | 'height' | 'pan'; readonly placement?: MapPlacement; readonly brush?: boolean; readonly source: string; moved: boolean; coord: PlacementCoord }
interface Props {
  readonly manifest: WorldMapManifest; readonly layerId: number; readonly placements: readonly MapPlacement[]; readonly nativeMarkers: readonly WorldMarker[]
  readonly selected?: MapPlacement; readonly destination?: PlacementCoord; readonly brush?: { readonly width: number; readonly depth: number; readonly voxelId: number }
  readonly visibleIds: ReadonlySet<number>; readonly active: boolean; readonly disabled: boolean; readonly source: string; readonly onSelect: (placement: MapPlacement) => void
  readonly brushAction?: VoxelBrushAction; readonly cancelAttempt: number; readonly onGestureChange: (pending: boolean) => void
  readonly tool: MapEditorTool; readonly onTool: (tool: MapEditorTool) => void; readonly history: MapEditorHistory; readonly constructionPlane: boolean; readonly onPlane: () => void; readonly platformHeight?: number
  readonly onBrush: (action: VoxelBrushAction, coords: readonly PlacementCoord[], ids: readonly number[], expected: string) => void
  readonly onMove: (id: number, coord: PlacementCoord, source: string) => void; readonly onDestination: (coord: PlacementCoord) => void
}
const DEFAULT_COLOR = '#7ba1ad'
const MIN_HANDLE_DIAMETER = 44
const DRAG_THRESHOLD = 4
const ZOOM_LIMITS = Object.freeze({ min: .5, max: 2, step: .25 })
const sameCoord = (a: PlacementCoord, b: PlacementCoord) => a.X === b.X && a.Y === b.Y && a.Z === b.Z
function planeCoordinate(value: string | undefined): number | undefined {
  const height = value?.trim() ? Number(value) : NaN
  return Number.isSafeInteger(height) && height >= MAP_EDITOR_LIMITS.intMin && height <= MAP_EDITOR_LIMITS.intMax ? height : undefined
}

export default function IsometricPlacementView({ manifest, layerId, placements, nativeMarkers, selected, destination, brush, visibleIds, active, disabled, source, onSelect, onMove, onDestination, brushAction, cancelAttempt, onBrush, onGestureChange, tool, onTool, history, constructionPlane, onPlane, platformHeight }: Props) {
  const [surface, setSurface] = useState<MapSurface>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [rotation, setRotation] = useState<IsoRotation>(ISO_PRESET.isometric.rotation)
  const [elevation, setElevation] = useState<IsoElevation>(ISO_PRESET.isometric.elevation)
  const [planeHeight, setPlaneHeight] = useState<string>()
  const [zoom, setZoom] = useState(1)
  const [canvasScale, setCanvasScale] = useState(1)
  const [center, setCenter] = useState<PlacementCoord>({ X: 0, Y: 0, Z: 0 })
  const [preview, setPreview] = useState<{ readonly id?: number; readonly coord: PlacementCoord }>()
  const [mode, setMode] = useState<'ground' | 'height'>('ground')
  const dragRef = useRef<Drag | undefined>(undefined)
  const frameRef = useRef<number | undefined>(undefined)
  const frameUpdate = useRef<{ readonly coord: PlacementCoord; readonly pan: boolean; readonly id?: number } | undefined>(undefined)
  const svgRef = useRef<SVGSVGElement>(null)
  const startRef = useRef(start)
  startRef.current = start
  const camera: IsoCamera = useMemo(() => ({ coord: center, rotation, zoom, elevation, clipDepth: true }), [center, rotation, zoom, elevation])
  const focus = destination ?? selected?.coord
  const focusX = focus?.X ?? 0
  const focusZ = focus?.Z ?? 0
  const focusY = focus?.Y
  const colors = manifest.source.voxelColors as Readonly<Record<string, string>> | undefined
  const sideColors = manifest.source.voxelSideColors as Readonly<Record<string, string>> | undefined
  const geometry = useMapGeometry(manifest, layerId, camera, active && Boolean(surface), attempt)
  const planeY = planeCoordinate(planeHeight)
  // Panning produces fractional coordinates; compare the column containing the guide's origin
  const planeSurface = surface && mapSurfaceCell(surface, Math.floor(center.X), Math.floor(center.Z))
  useEffect(() => {
    // Initialize once from the camera; clearing the input must remain invalid rather than repaint terrain
    if (constructionPlane) setPlaneHeight(previous => previous ?? String(center.Y))
  }, [constructionPlane, center.Y])
  useEffect(() => {
    // Selection, undo and surface loading can recenter the camera at another height
    // Keep the active guide visible without changing any authored coordinate
    if (constructionPlane && planeY !== undefined && center.Y !== planeY) setCenter(previous => ({ ...previous, Y: planeY }))
  }, [constructionPlane, planeY, center.Y])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    // Keep the height handle usable on touch screens while world units retain their scale
    const observer = new ResizeObserver(() => { const transform = svg.getScreenCTM(); if (transform && transform.a > 0) setCanvasScale(Math.hypot(transform.a, transform.b)) })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setSurface(undefined); setError('')
    void loadMapSurface(manifest, layerId).then(value => { if (!cancelled) setSurface(value) }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [manifest, layerId, attempt, active])
  useEffect(() => {
    // Recenter on explicit coordinates without manufacturing a placement height
    // When height is blank, the mapped height positions only the camera
    const ground = surface && mapSurfaceCell(surface, focusX, focusZ)
    setCenter({ X: focusX, Y: focusY ?? ground?.height ?? 0, Z: focusZ })
  }, [selected?.id, focusX, focusY, focusZ, surface])
  useEffect(() => {
    // Document, layer, view and camera changes invalidate any in-flight gesture
    // No partially dragged coordinate reaches storage until the release is accepted
    cancelFrame(); dragRef.current = undefined; setPreview(undefined)
  }, [source, layerId, disabled, rotation, elevation, zoom, active])
  useEffect(() => () => { cancelFrame() }, [])

  const surfaceIndex = useMemo(() => surface && isoSurfaceIndex(surface), [surface])
  const terrain = useMemo(() => {
    if (!active || !surface || !surfaceIndex) return []
    const native = isoVisibleGeometry(geometry.tiles, camera).map<IsoTerrainCell>(cell => ({ ...cell, color: colors?.[String(cell.voxelId)] ?? DEFAULT_COLOR, sideColor: sideColors?.[String(cell.voxelId)], underwater: false, nativeGeometry: true }))
    // Retain the map projection only where a volume tile has not loaded
    // A loaded tile replaces its whole footprint, including recorded gaps below roofs
    const fallback = isoVisibleSurface(surface, surfaceIndex, camera).filter(cell => !geometry.tiles.some(tile => cell.coord.X >= tile.bounds.x && cell.coord.X < tile.bounds.x + tile.bounds.width && cell.coord.Z >= tile.bounds.z && cell.coord.Z < tile.bounds.z + tile.bounds.height)).map<IsoTerrainCell>(cell => ({ coord: cell.coord, color: colors?.[String(cell.voxelId)] ?? DEFAULT_COLOR, underwater: cell.underwater, faces: MAP_FACE.all, height: 1, nativeGeometry: false, voxelId: cell.voxelId }))
    return [...native, ...fallback]
  }, [surface, surfaceIndex, geometry.tiles, camera, colors, sideColors, active])
  const nearby = useMemo(() => placements.filter(value => visibleIds.has(value.id) && (value.id === selected?.id || isoCellVisible(value.coord, camera))), [placements, visibleIds, selected?.id, camera])
  const visible = useMemo(() => {
    const result = nearby.slice(0, ISO.maxPlacements)
    if (selected && nearby.some(value => value.id === selected.id) && !result.some(value => value.id === selected.id)) result[result.length - 1] = selected
    return result
  }, [nearby, selected])
  const pickingCells = useMemo<readonly BrushCell[]>(() => [...terrain, ...visible.filter(placement => placement.hasVoxelOutfit).map(placement => ({ coord: placement.coord, height: 1, faces: MAP_FACE.all, id: placement.id }))], [terrain, visible])
  const erasableIds = useMemo(() => new Set(placements.filter(placement => placement.staticVoxel && placement.id > Number(manifest.source.lastVanillaEntityId)).map(placement => placement.id)), [placements, manifest])
  const occupied = useMemo(() => new Set(placements.filter(placement => placement.hasVoxelOutfit).map(placement => voxelCellKey(placement.coord))), [placements])
  const voxelBrush = useVoxelBrush({ camera, cells: pickingCells, action: brushAction, size: brush?.width ?? 1, depth: brush?.depth, active, disabled: disabled || constructionPlane && planeY === undefined, planeHeight: constructionPlane ? planeY : brushAction === 'platform' ? platformHeight : undefined, source, cancelAttempt, erasableIds, occupied, onApply: onBrush, onGestureChange })
  useEffect(() => { voxelBrush.cancel() }, [layerId, brush?.voxelId])
  const proposed = brushAction === 'platform' ? voxelBrush.hover?.adjacent ?? destination : brushAction ? voxelBrush.hover?.adjacent : preview?.coord ?? destination ?? selected?.coord
  const warning = proposed ? placementPreview(proposed, placements, preview?.id ?? selected?.id, surface) : ''
  const project = (coord: PlacementCoord) => isoProject(coord, camera)
  const points = (coords: readonly PlacementCoord[]) => coords.map(coord => { const p = project(coord); return `${p.x},${p.y}` }).join(' ')
  function cube(coord: PlacementCoord, color: string, key: string, className = '', onDown?: (event: PointerEvent<SVGGElement>) => void) {
    return <g key={key} className={`iso-cube ${className}`} data-cell={`${coord.X},${coord.Y},${coord.Z}`} onPointerDown={onDown} style={{ fill: color }}>{isoFaces(coord, 1, camera).map(face => <polygon key={face.mask} className={face.axis === 'Y' ? '' : `iso-cube-side${face.axis === 'Z' ? ' iso-cube-side--dark' : ''}`} points={points(face.points)}/>)}</g>
  }
  function eventPoint(event: PointerEvent): IsoPoint {
    // The SVG matrix includes responsive scaling, borders and aspect-ratio letterboxing
    // Bounding-box division alone shifts snapped cells and shrinks touch targets
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svgRef.current!.getScreenCTM()!.inverse())
    return { x: point.x, y: point.y }
  }
  function start(event: PointerEvent, placement?: MapPlacement, height = false, dragBrush = false) {
    if (![0, 1, 2].includes(event.button) || dragRef.current) return
    if (brushAction && event.button === 0 && !event.shiftKey) {
      event.stopPropagation()
      if (voxelBrush.start(eventPoint(event), event.pointerId)) svgRef.current!.setPointerCapture(event.pointerId)
      return
    }
    if (event.button !== 0 || event.shiftKey) { placement = undefined; dragBrush = false; height = false }
    event.stopPropagation()
    if ((placement || dragBrush) && disabled) return
    const origin = placement?.coord ?? (dragBrush ? destination : undefined) ?? center
    dragRef.current = { pointerId: event.pointerId, start: eventPoint(event), origin, coord: origin, camera, mode: placement || dragBrush ? height || mode === 'height' ? 'height' : 'ground' : 'pan', placement, brush: dragBrush, source, moved: false }
    svgRef.current!.setPointerCapture(event.pointerId)
  }
  function cancelFrame() {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current)
    frameRef.current = undefined; frameUpdate.current = undefined
  }
  function changePlane(value: string) {
    voxelBrush.cancel(); setPlaneHeight(value)
    const height = planeCoordinate(value)
    // Centering the camera is transient navigation; height changes never author support blocks
    if (height !== undefined) setCenter(previous => ({ ...previous, Y: height }))
  }
  function scheduleFrame(coord: PlacementCoord, pan: boolean, id?: number) {
    // Coalesce high-frequency pointer input while retaining the exact latest release coordinate
    // Replacing queued visual state never publishes an intermediate document edit
    frameUpdate.current = { coord, pan, id }
    if (frameRef.current !== undefined) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined
      const latest = frameUpdate.current
      frameUpdate.current = undefined
      if (!latest) return
      if (latest.pan) setCenter(previous => sameCoord(previous, latest.coord) ? previous : latest.coord)
      else setPreview(previous => previous && previous.id === latest.id && sameCoord(previous.coord, latest.coord) ? previous : { id: latest.id, coord: latest.coord })
    })
  }
  function update(event: PointerEvent) {
    const drag = dragRef.current
    if (!drag) { if (brushAction) voxelBrush.update(eventPoint(event), event.pointerId); return }
    if (drag.pointerId !== event.pointerId) return
    const p = eventPoint(event)
    const delta = { x: p.x - drag.start.x, y: p.y - drag.start.y }
    if (Math.hypot(delta.x, delta.y) > DRAG_THRESHOLD) drag.moved = true
    if (!drag.moved) return
    try {
      if (drag.mode === 'pan') {
        const movement = isoGroundDelta(delta, drag.camera)
        drag.coord = { X: drag.origin.X - movement.X, Y: drag.origin.Y, Z: drag.origin.Z - movement.Z }
        scheduleFrame(drag.coord, true)
      } else {
        drag.coord = isoDragCoord(drag.origin, delta, drag.camera, drag.mode)
        scheduleFrame(drag.coord, false, drag.placement?.id)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); cancelFrame(); dragRef.current = undefined; setPreview(undefined) }
  }
  function finish(event: PointerEvent, cancelled = false) {
    if (voxelBrush.finish(eventPoint(event), event.pointerId, cancelled)) {
      if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    cancelFrame(); dragRef.current = undefined; setPreview(undefined)
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
    if (cancelled || !active || drag.source !== source || disabled && (drag.placement || drag.brush)) return
    if (drag.mode === 'pan') { if (drag.moved) setCenter(drag.coord); return }
    if (drag.brush) { if (drag.moved && !sameCoord(drag.origin, drag.coord)) onDestination(drag.coord) }
    else if (drag.placement) {
      if (drag.moved && !sameCoord(drag.origin, drag.coord)) onMove(drag.placement.id, drag.coord, drag.source)
      else if (!drag.moved) onSelect(drag.placement)
    }
  }
  // Transparent SVG hit areas follow the painted placements; height handles stay above the scene
  // Cached hit regions avoid rebuilding every authored block for cursor feedback
  // Their event ref still reads the latest tool, source revision and gesture state
  const sorted = useMemo(() => [
    ...visible.map(placement => {
      const coord = preview?.id === placement.id ? preview.coord : placement.coord
      const color = colors?.[String(placement.voxelId)] ?? DEFAULT_COLOR
      const p = project({ ...coord, X: coord.X + .5, Z: coord.Z + .5 })
      const onDown = (event: PointerEvent<SVGGElement>) => startRef.current(event, placement)
      return { coord, render: <g key={`placement:${placement.id}`} data-placement-id={placement.id} className={`iso-placement${selected?.id === placement.id ? ' iso-placement--selected' : ''}`}><title>{placement.name} at X {coord.X}, Y {coord.Y}, Z {coord.Z}</title>{placement.hasVoxelOutfit ? cube(coord, color, `block:${placement.id}`, '', onDown) : <g onPointerDown={onDown}><path d={`M ${p.x} ${p.y - 34} l 13 17 -13 17 -13 -17 Z`} fill={color}/><circle cx={p.x} cy={p.y} r={5}/></g>}</g> }
    }),
  ].sort((a, b) => { const pa = isoProject({ ...a.coord, Y: camera.coord.Y }, { ...camera, elevation: ISO_ELEVATION.angled }); const pb = isoProject({ ...b.coord, Y: camera.coord.Y }, { ...camera, elevation: ISO_ELEVATION.angled }); return pa.y - pb.y || a.coord.Y - b.coord.Y }), [visible, preview, colors, camera, selected?.id])
  const contextMarkers = useMemo(() => nativeMarkers.filter(value => isoCellVisible({ X: value.x, Y: value.y, Z: value.z }, camera)).slice(0, ISO.maxPlacements).map(value => { const p = project({ X: value.x + .5, Y: value.y, Z: value.z + .5 }); return <g key={value.id} className="iso-native-context"><title>{value.name} (read-only context)</title><circle cx={p.x} cy={p.y} r={6}/></g> }), [nativeMarkers, camera])
  const draftDestination = selected && destination && !sameCoord(destination, selected.coord) ? destination : undefined
  const draftPoint = draftDestination && project({ ...draftDestination, X: draftDestination.X + .5, Z: draftDestination.Z + .5 })
  const selectedCoord = selected ? preview?.id === selected.id ? preview.coord : draftDestination ?? selected.coord : brush ? preview?.coord ?? destination : undefined
  const mappedGround = selectedCoord && surface && mapSurfaceCell(surface, selectedCoord.X, selectedCoord.Z)
  const groundPoint = selectedCoord && mappedGround && project({ ...selectedCoord, X: selectedCoord.X + .5, Y: mappedGround.height, Z: selectedCoord.Z + .5 })
  const basePoint = selectedCoord && project({ ...selectedCoord, X: selectedCoord.X + .5, Z: selectedCoord.Z + .5 })
  // Clamp transient brush inputs only for rendering; the authoring function validates exact dimensions
  const brushWidth = Math.max(1, Math.min(MAP_EDITOR_LIMITS.brushSide, Math.floor(brush?.width || 1)))
  const brushDepth = Math.max(1, Math.min(MAP_EDITOR_LIMITS.brushSide, Math.floor(brush?.depth || 1)))
  const brushOrigin = brushAction === 'paint' ? voxelBrush.hover?.adjacent : brushAction === 'platform' ? voxelBrush.hover?.adjacent ?? destination : !selected && preview?.coord || destination
  const brushPreview = brushOrigin && brush && !(brushAction === 'platform' && voxelBrush.stroke.length) ? brushAction === 'paint' && voxelBrush.hover ? voxelBrushStamp(brushOrigin, voxelBrush.hover.axis, brushWidth) : Array.from({ length: brushWidth * brushDepth }, (_, index) => ({ X: brushOrigin.X + index % brushWidth, Y: brushOrigin.Y, Z: brushOrigin.Z + Math.floor(index / brushWidth) })) : []
  const handleRadius = Math.max(14, MIN_HANDLE_DIAMETER / 2 / canvasScale)
  const handleOffset = Math.max(52, handleRadius * 2 + 8)
  const handle = selectedCoord && project({ ...selectedCoord, X: selectedCoord.X + .5, Y: selectedCoord.Y + 1, Z: selectedCoord.Z + .5 })
  const axisOrigin = project(center)
  const axisVectors = (['X', 'Z'] as const).map(axis => { const p = project({ ...center, [axis]: center[axis] + 1 }); return { axis, x: (p.x - axisOrigin.x) * 1.5 / zoom, y: (p.y - axisOrigin.y) * 1.5 / zoom } })
  return <section className="iso-view stack" aria-label="Isometric placement view" onKeyDown={event => {
    if (!constructionPlane || planeY === undefined || disabled || !isMapShortcut(event) || !['[', ']'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    changePlane(String(Math.max(MAP_EDITOR_LIMITS.intMin, Math.min(MAP_EDITOR_LIMITS.intMax, planeY + (event.key === ']' ? 1 : -1)))))
  }}>
    <div className="iso-toolbar">
      <MapEditorTools tool={tool} plane={constructionPlane} history={history} disabled={disabled} onTool={onTool} onPlane={onPlane}/>
      <div className="iso-camera-controls" role="group" aria-label="Rotate and tilt camera">
        <IconButton icon="arrow-left" label="Rotate view left" onClick={() => setRotation(value => ((value + ISO.rotations - 1) % ISO.rotations) as IsoRotation)}/>
        <IconButton icon="arrow-right" label="Rotate view right" onClick={() => setRotation(value => ((value + 1) % ISO.rotations) as IsoRotation)}/>
        <IconButton icon="arrow-up" label="Tilt view up" disabled={elevation >= ISO_ELEVATION.max} onClick={() => setElevation(value => Math.min(ISO_ELEVATION.max, value + ISO_ELEVATION.step))}/>
        <IconButton icon="arrow-down" label="Tilt view down" disabled={elevation <= ISO_ELEVATION.min} onClick={() => setElevation(value => Math.max(ISO_ELEVATION.min, value - ISO_ELEVATION.step))}/>
        <IconButton icon="eye" label="Game-style view" aria-pressed={rotation === ISO_PRESET.game.rotation && elevation === ISO_PRESET.game.elevation} onClick={() => { setRotation(ISO_PRESET.game.rotation); setElevation(ISO_PRESET.game.elevation) }}/>
        <IconButton icon="box" label="Isometric camera" aria-pressed={rotation === ISO_PRESET.isometric.rotation && elevation === ISO_PRESET.isometric.elevation} onClick={() => { setRotation(ISO_PRESET.isometric.rotation); setElevation(ISO_PRESET.isometric.elevation) }}/>
        <output aria-label="Camera angles">{rotation * ISO.angleStep}° / {elevation}°</output>
        <IconButton icon="plus" label="Zoom isometric in" disabled={zoom >= ZOOM_LIMITS.max} onClick={() => setZoom(value => Math.min(ZOOM_LIMITS.max, value + ZOOM_LIMITS.step))}/>
        <IconButton icon="minus" label="Zoom isometric out" disabled={zoom <= ZOOM_LIMITS.min} onClick={() => setZoom(value => Math.max(ZOOM_LIMITS.min, value - ZOOM_LIMITS.step))}/>
        <IconButton icon="compass" label="Center on placement" onClick={() => { voxelBrush.cancel(); setCenter({ X: focusX, Y: constructionPlane && planeY !== undefined ? planeY : focusY ?? (surface && mapSurfaceCell(surface, focusX, focusZ)?.height) ?? 0, Z: focusZ }) }}/>
      </div>
      {!brushAction && <label className="map-editor-checkbox"><input type="checkbox" checked={mode === 'height'} onChange={event => setMode(event.target.checked ? 'height' : 'ground')}/>Drag placements vertically</label>}
      {constructionPlane && <div className="iso-plane-controls">
        <Field label="Construction height Y"><input type="number" step={1} min={MAP_EDITOR_LIMITS.intMin} max={MAP_EDITOR_LIMITS.intMax} value={planeHeight ?? ''} disabled={disabled} aria-invalid={planeY === undefined} onChange={event => changePlane(event.target.value)}/></Field>
        <IconButton icon="minus" label="Lower construction plane" disabled={disabled || planeY === undefined || planeY <= MAP_EDITOR_LIMITS.intMin} onClick={() => changePlane(String(planeY! - 1))}/>
        <IconButton icon="plus" label="Raise construction plane" disabled={disabled || planeY === undefined || planeY >= MAP_EDITOR_LIMITS.intMax} onClick={() => changePlane(String(planeY! + 1))}/>
        <IconButton icon="compass" label="Center on construction plane" disabled={planeY === undefined} onClick={() => { voxelBrush.cancel(); setCenter(previous => ({ ...previous, Y: planeY! })) }}/>
        <span className="field__hint">Paint anywhere on the grid. The cyan outline is a guide. <kbd>[</kbd> / <kbd>]</kbd> lower / raise it.</span>
      </div>}
    </div>
    {constructionPlane && planeY === undefined && <p role="status">Enter an integer construction height Y before painting.</p>}
    {error && <InlineNotice title="Isometric preview needs attention" tone="warning"><p>{error}</p><Button tone="secondary" onClick={() => setAttempt(value => value + 1)}>Retry surface heights</Button></InlineNotice>}
    {!surface && !error && <p role="status">Opening native surface heights...</p>}
    {geometry.pending && <p role="status">Loading nearby native voxel geometry...</p>}
    {geometry.error && <InlineNotice title="Native geometry needs attention" tone="warning"><p>{geometry.error}</p><Button tone="secondary" onClick={() => setAttempt(value => value + 1)}>Retry native geometry</Button></InlineNotice>}
    <div className="iso-workspace"><div className="iso-scene"><IsometricScene active={active} terrain={terrain} placements={visible} camera={camera} colors={colors} selectedId={selected?.id} preview={preview?.id === undefined ? undefined : preview}/><IsometricConstructionPlane active={active && constructionPlane} height={planeY} mappedHeight={planeSurface?.height} camera={camera}/><IsometricBrushOverlay active={active} stroke={voxelBrush.stroke} camera={camera} color={brushAction === 'erase' ? '#ed7777' : colors?.[String(brush?.voxelId)] ?? DEFAULT_COLOR}/><svg ref={svgRef} className={`iso-canvas${brushAction ? ' iso-canvas--brush' : ''}`} tabIndex={0} onKeyDown={event => { if (event.key === 'Escape') { voxelBrush.cancel(); cancelFrame(); dragRef.current = undefined; setPreview(undefined) } }} onContextMenu={event => event.preventDefault()} viewBox={`0 0 ${ISO.viewWidth} ${ISO.viewHeight}`} role="img" aria-label="Isometric terrain and authored placements" data-camera={`${center.X},${center.Y},${center.Z}`} data-zoom={zoom} data-rotation={rotation * ISO.angleStep} data-elevation={elevation} data-terrain-cells={terrain.length} onPointerDown={event => start(event)} onPointerMove={update} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
      {sorted.map(value => value.render)}
      {contextMarkers}
      {brush && brushPreview.map((coord, index) => cube(coord, colors?.[String(brush.voxelId)] ?? DEFAULT_COLOR, `ghost:${index}`, brushAction ? 'iso-ghost iso-brush-ghost' : 'iso-ghost', brushAction ? undefined : event => start(event, undefined, false, true)))}
      {brushAction === 'erase' && voxelBrush.hover?.id !== undefined && erasableIds.has(voxelBrush.hover.id) && cube(voxelBrush.hover.coord, '#ed7777', 'erase-preview', 'iso-ghost iso-brush-ghost')}
      {draftDestination && selected && <g className="iso-draft-destination" data-coord={`${draftDestination.X},${draftDestination.Y},${draftDestination.Z}`}><title>Pending destination for {selected.name}</title>{selected.hasVoxelOutfit ? cube(draftDestination, colors?.[String(selected.voxelId)] ?? DEFAULT_COLOR, 'draft-destination', 'iso-ghost') : draftPoint && <path d={`M ${draftPoint.x} ${draftPoint.y - 34} l 13 17 -13 17 -13 -17 Z`} fill="none" stroke="currentColor" strokeWidth={2}/>}</g>}
      {!brushAction && groundPoint && basePoint && <g className="iso-height-guide"><line x1={basePoint.x} y1={basePoint.y} x2={groundPoint.x} y2={groundPoint.y}/><ellipse cx={groundPoint.x} cy={groundPoint.y} rx={10} ry={5}/><text x={groundPoint.x + 14} y={groundPoint.y + 5} style={{ fontSize: 12 / canvasScale, strokeWidth: 3 / canvasScale }}>Surface Y {mappedGround!.height}</text></g>}
      {handle && !brushAction && (selected || brush) && <g className="iso-height-handle" data-height-handle={selected?.id ?? 'brush'} onPointerDown={event => start(event, selected, true, !selected)}><title>Drag height Y for {selected?.name ?? 'new blocks'}</title><line x1={handle.x} x2={handle.x} y1={handle.y} y2={handle.y - handleOffset}/><circle cx={handle.x} cy={handle.y - handleOffset} r={handleRadius}/><text x={handle.x} y={handle.y - handleOffset + 5 / canvasScale} textAnchor="middle" style={{ fontSize: 14 / canvasScale }}>Y</text></g>}
      <g className="iso-axis-legend" style={{ fontSize: 12 / canvasScale, strokeWidth: 3 / canvasScale }} transform="translate(85 530)">{axisVectors.map(axis => <g key={axis.axis}><path d={`M 0 0 L ${axis.x} ${axis.y}`}/><text x={axis.x * 1.3} y={axis.y * 1.3 + 5}>{axis.axis}</text></g>)}<path d="M 0 0 L 0 -45"/><text x="0" y="-52">Y</text></g>
    </svg></div><MapOrientation manifest={manifest} layerId={layerId} camera={camera} onNavigate={(x, z) => {
      // Plane editing keeps its height in view; other navigation follows the mapped surface
      cancelFrame(); dragRef.current = undefined; setPreview(undefined); voxelBrush.cancel()
      setCenter({ X: x, Y: constructionPlane && planeY !== undefined ? planeY : (surface && mapSurfaceCell(surface, x, z)?.height) ?? center.Y, Z: z })
    }}/></div>
    <p className="field__hint">{constructionPlane ? 'Click or drag on the grid to paint at the construction height, even in empty space. The grid adds no air or support blocks. Release to save; Escape cancels.' : brushAction === 'platform' ? 'Click or tap a face to place one platform. Drag to reposition its preview; release adds the whole platform, Escape cancels. Width X and depth Z set its size. An explicit Placement height Y overrides the face height.' : brushAction === 'paint' ? 'Click or tap a block face to add blocks beside it. Drag to paint a connected stroke at that face height or wall plane. Release to save; Escape cancels.' : brushAction === 'erase' ? 'Click or drag across added stationary blocks to erase them. Release to save; Escape cancels.' : 'Drag a placement on X/Z, or use its Y handle for height. Drag empty space to pan.'} Hold Shift or use the middle/right mouse button to pan while brushing, or choose Move / pan. Horizontal rotation steps by 45°; tilt uses 5° adjustments. Game-style view approximates the native camera profile; Isometric camera restores the diagonal angle.</p>
    {voxelBrush.hint && <p role="status">{voxelBrush.hint}</p>}
    {voxelBrush.stroke.length > 0 && <p role="status">{voxelBrush.stroke.length} blocks in this {brushAction === 'platform' ? 'platform' : 'stroke'}. Release to apply or press Escape to cancel.</p>}
    {proposed && <p role="status" className="iso-preview-status">X {proposed.X} · Y {proposed.Y} · Z {proposed.Z}: {warning}</p>}
    {(!brushAction || brushAction === 'platform') && proposed && surface && mapSurfaceCell(surface, proposed.X, proposed.Z) && <Button tone="secondary" disabled={disabled || voxelBrush.stroke.length > 0} onClick={() => onDestination({ ...proposed, Y: mapSurfaceCell(surface, proposed.X, proposed.Z)!.height })}>Use mapped surface height</Button>}
    {nearby.length > visible.length && <p>Some nearby placements are hidden to keep the preview responsive. Use the placement list to select them.</p>}
    <p className="field__hint">Native terrain shows exposed voxel faces, including walls and trunks, with averaged native colors. Only nearby geometry tiles load. Special shapes, including stairs and liquids, use block previews. Unassigned biome layers, conditions and game physics remain unknown.</p>
  </section>
}
