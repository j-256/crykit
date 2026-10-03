import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { worldMapImage } from '../catalog/world-map'
import { createWorldSpatialIndex, queryWorldSpatialIndex, worldMapClusters, type WorldMapCluster, type WorldMapManifest, type WorldMarker } from '../domain/world-map'
import { Icon, type IconName } from './icons'

export const MAP_KIND_ICONS: Readonly<Record<WorldMarker['kind'], IconName>> = { chest: 'chest', npc: 'user', shop: 'box', boss: 'sword', encounter: 'spark', crystal: 'crystal', home: 'compass', entrance: 'arrow-left', sign: 'info', resource: 'pickaxe', object: 'layers' }
export const MAP_KIND_LABELS: Readonly<Record<WorldMarker['kind'], string>> = { chest: 'Chests', npc: 'NPCs', resource: 'Resources', shop: 'Shops', boss: 'Bosses', crystal: 'Crystals', home: 'Home points', entrance: 'Entrances', encounter: 'Encounters', sign: 'Signs', object: 'Objects' }
const MAX_ZOOM = 32
const ZOOM_STEP = 1.6
const KEYBOARD_PAN_PIXELS = 70
const MARKER_MARGIN_PIXELS = 40
const MAX_RENDERED_GROUPS = 160
const GROUP_AREA_PIXELS = 80 * 80
const LABEL_WIDTH_PIXELS = 125
const LABEL_HEIGHT_PIXELS = 35
const SELECTED_CLEARANCE_PIXELS = 52
interface View { readonly x: number; readonly z: number; readonly zoom: number }
interface ScreenPoint { readonly x: number; readonly y: number }
interface Gesture { readonly points: Map<number, ScreenPoint>; startPoints: Map<number, ScreenPoint>; startView: View; moved: boolean }
const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: ScreenPoint, b: ScreenPoint): ScreenPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function WorldMapCanvas({ manifest, markers, layerId, selected, onSelect, onVisibleChange }: { readonly manifest: WorldMapManifest; readonly markers: readonly WorldMarker[]; readonly layerId: number; readonly selected?: WorldMarker; readonly onSelect: (marker: WorldMarker) => void; readonly onVisibleChange: (markers: readonly WorldMarker[]) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const bounds = manifest.bounds
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>(() => ({ x: bounds.x + bounds.width / 2, z: bounds.z + bounds.height / 2, zoom: 1 }))
  const [imageStatus, setImageStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState<WorldMapCluster>()
  const gesture = useRef<Gesture | null>(null)
  const fitScale = Math.max(0.01, Math.min(size.width / bounds.width, size.height / bounds.height))
  const scale = fitScale * view.zoom
  const viewRef = useRef(view)
  viewRef.current = view
  const index = useMemo(() => createWorldSpatialIndex(markers), [markers])
  const visible = useMemo(() => queryWorldSpatialIndex(index, { x: view.x - (size.width / 2 + MARKER_MARGIN_PIXELS) / scale, z: view.z - (size.height / 2 + MARKER_MARGIN_PIXELS) / scale, width: (size.width + MARKER_MARGIN_PIXELS * 2) / scale, height: (size.height + MARKER_MARGIN_PIXELS * 2) / scale }), [index, scale, size, view.x, view.z])
  const maxGroups = Math.max(8, Math.min(MAX_RENDERED_GROUPS, Math.floor(Math.min(size.width, bounds.width * scale) * Math.min(size.height, bounds.height * scale) / GROUP_AREA_PIXELS)))
  const clusters = useMemo(() => worldMapClusters(visible.filter(marker => marker.id !== selected?.id && Math.abs(marker.x - view.x) * scale <= size.width / 2 && Math.abs(marker.z - view.z) * scale <= size.height / 2), { zoom: view.zoom, pixelsPerUnit: scale, maxGroups }), [visible, selected?.id, view, scale, size, maxGroups])
  const terrainLayer = manifest.layers.find(layer => layer.id === layerId)
  const image = terrainLayer ? worldMapImage(terrainLayer) : ''
  useEffect(() => { onVisibleChange(visible) }, [visible, onVisibleChange])
  useEffect(() => { setExpanded(undefined) }, [layerId, markers, view])
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => { const rect = element.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setImageStatus('loading') }, [layerId, retry])
  const clamp = (next: View): View => {
    const nextScale = fitScale * next.zoom
    const halfWidth = Math.min(bounds.width / 2, size.width / nextScale / 2)
    const halfHeight = Math.min(bounds.height / 2, size.height / nextScale / 2)
    return { x: Math.max(bounds.x + halfWidth, Math.min(bounds.x + bounds.width - halfWidth, next.x)), z: Math.max(bounds.z + halfHeight, Math.min(bounds.z + bounds.height - halfHeight, next.z)), zoom: Math.max(1, Math.min(MAX_ZOOM, next.zoom)) }
  }
  const zoomAt = (previous: View, zoom: number, anchor: ScreenPoint): View => {
    const nextZoom = Math.max(1, Math.min(MAX_ZOOM, zoom))
    const oldScale = fitScale * previous.zoom
    const newScale = fitScale * nextZoom
    return clamp({ x: previous.x + (anchor.x - size.width / 2) * (1 / oldScale - 1 / newScale), z: previous.z + (anchor.y - size.height / 2) * (1 / oldScale - 1 / newScale), zoom: nextZoom })
  }
  useEffect(() => {
    if (!selected || !size.width) return
    setView(previous => clamp({ x: selected.x, z: selected.z, zoom: Math.max(8, previous.zoom) }))
    // Selection focus follows the source-qualified marker identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.x, selected?.z, size.width > 0])
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const amount = Math.exp(-Math.max(-180, Math.min(180, event.deltaY)) * 0.003)
      setView(previous => zoomAt(previous, previous.zoom * amount, { x: event.clientX - rect.left, y: event.clientY - rect.top }))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
    // The native listener needs the latest measured viewport
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitScale, size.width, size.height])
  const screenPoint = (event: PointerEvent<HTMLDivElement>): ScreenPoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const resetGesture = (current: Gesture) => { current.startPoints = new Map(current.points); current.startView = viewRef.current }
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button') || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const current = gesture.current ?? { points: new Map(), startPoints: new Map(), startView: viewRef.current, moved: false }
    current.points.set(event.pointerId, screenPoint(event))
    resetGesture(current)
    gesture.current = current
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current?.points.has(event.pointerId)) return
    current.points.set(event.pointerId, screenPoint(event))
    const starts = [...current.startPoints.values()]
    const points = [...current.points.values()]
    if (starts.length >= 2 && points.length >= 2) {
      const originalDistance = distance(starts[0]!, starts[1]!)
      if (originalDistance < 1) return
      const startMid = midpoint(starts[0]!, starts[1]!)
      const nextMid = midpoint(points[0]!, points[1]!)
      const zoomed = zoomAt(current.startView, current.startView.zoom * distance(points[0]!, points[1]!) / originalDistance, startMid)
      const nextScale = fitScale * zoomed.zoom
      setView(clamp({ ...zoomed, x: zoomed.x - (nextMid.x - startMid.x) / nextScale, z: zoomed.z - (nextMid.y - startMid.y) / nextScale }))
      current.moved = true
    } else if (starts[0] && points[0]) {
      const dx = points[0].x - starts[0].x
      const dy = points[0].y - starts[0].y
      if (Math.hypot(dx, dy) > 4) current.moved = true
      const startScale = fitScale * current.startView.zoom
      setView(clamp({ ...current.startView, x: current.startView.x - dx / startScale, z: current.startView.z - dy / startScale }))
    }
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current) return
    current.points.delete(event.pointerId)
    if (!current.points.size) gesture.current = null
    else resetGesture(current)
  }
  const changeZoom = (factor: number) => setView(previous => zoomAt(previous, previous.zoom * factor, { x: size.width / 2, y: size.height / 2 }))
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const pan: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (pan[event.key]) { event.preventDefault(); const delta = pan[event.key]!; setView(previous => clamp({ ...previous, x: previous.x + delta[0] * KEYBOARD_PAN_PIXELS / scale, z: previous.z + delta[1] * KEYBOARD_PAN_PIXELS / scale })) }
    else if (['+', '='].includes(event.key)) { event.preventDefault(); changeZoom(ZOOM_STEP) }
    else if (event.key === '-') { event.preventDefault(); changeZoom(1 / ZOOM_STEP) }
    else if (event.key === 'Home' || event.key === '0') { event.preventDefault(); fit() }
  }
  const fit = () => setView({ x: bounds.x + bounds.width / 2, z: bounds.z + bounds.height / 2, zoom: 1 })
  const position = (point: { x: number; z: number }): CSSProperties => ({ left: size.width / 2 + (point.x - view.x) * scale, top: size.height / 2 + (point.z - view.z) * scale })
  const labels = useMemo(() => {
    if (view.zoom < 2.5 || view.zoom > 7) return []
    const displayed: { x: number; z: number; id: number; name: string; layer: number }[] = []
    for (const region of manifest.regions) {
      if (region.layer !== layerId || !region.name.trim()) continue
      const x = size.width / 2 + (region.x - view.x) * scale
      const y = size.height / 2 + (region.z - view.z) * scale
      if (x < 40 || x > size.width - 40 || y < 25 || y > size.height - 25) continue
      if (displayed.some(other => Math.abs(region.x - other.x) * scale < LABEL_WIDTH_PIXELS && Math.abs(region.z - other.z) * scale < LABEL_HEIGHT_PIXELS)) continue
      if (clusters.some(cluster => Math.abs(region.x - cluster.x) * scale < LABEL_WIDTH_PIXELS / 2 && Math.abs(region.z - cluster.z) * scale < LABEL_HEIGHT_PIXELS)) continue
      displayed.push(region)
    }
    return displayed
  }, [manifest.regions, layerId, size, scale, view, clusters])
  return <div className="world-map-stage">
    <div aria-label="Interactive world map" aria-describedby="world-map-controls-help" className="world-map-viewport" onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) { const rect = event.currentTarget.getBoundingClientRect(); setView(previous => zoomAt(previous, previous.zoom * ZOOM_STEP, { x: event.clientX - rect.left, y: event.clientY - rect.top })) } }} onKeyDown={keyboard} onPointerCancel={pointerUp} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} ref={viewportRef} role="region" tabIndex={0}>
      <div aria-hidden="true" className="world-map-terrain" style={{ width: bounds.width, height: bounds.height, transform: `translate(${size.width / 2 + (bounds.x - view.x) * scale}px, ${size.height / 2 + (bounds.z - view.z) * scale}px) scale(${scale})` }}>
        {image && <img alt="" draggable={false} height={bounds.height} key={`${layerId}:${retry}`} onError={() => setImageStatus('error')} onLoad={() => setImageStatus('ready')} src={image} width={bounds.width}/>}
      </div>
      {imageStatus === 'ready' && <div aria-hidden="true" className="world-map-region-labels">{labels.map(region => <span className="world-map-region-label" key={region.id} style={position(region)}>{region.name}</span>)}</div>}
      {imageStatus === 'ready' && clusters.filter(cluster => !selected || Math.hypot(cluster.x - selected.x, cluster.z - selected.z) * scale >= SELECTED_CLEARANCE_PIXELS).map(cluster => {
        const first = cluster.markers[0]!
        const modded = cluster.markers.some(marker => marker.change !== 'base')
        const count = cluster.markers.length
        const stacked = count > 1 && (view.zoom >= MAX_ZOOM || view.zoom >= 8 && cluster.markers.every(marker => marker.x === first.x && marker.z === first.z))
        const label = count > 1 ? `${count} locations near ${first.region ?? first.name}. ${stacked ? 'Choose a location' : 'Zoom in'}` : `${MAP_KIND_LABELS[first.kind]}: ${first.name}${first.change === 'base' ? '' : ` (${first.sourceName})`}`
        return <button aria-label={label} className={`world-map-marker world-map-marker--${first.kind}${modded ? ' world-map-marker--mod' : ''}${count > 1 ? ' world-map-marker--cluster' : ''}`} key={cluster.id} onClick={() => { if (stacked) setExpanded(cluster); else if (count > 1) setView(previous => clamp({ x: cluster.x, z: cluster.z, zoom: Math.min(MAX_ZOOM, previous.zoom * 2) })); else onSelect(first) }} style={position(cluster)} title={label} type="button">{count > 1 ? <span className="world-map-marker-count">{count}</span> : <Icon name={MAP_KIND_ICONS[first.kind]}/>} {modded && <span className="world-map-marker-source" aria-hidden="true">M</span>}</button>
      })}
      {selected && <button aria-label={`Selected location: ${selected.name}`} aria-pressed="true" className={`world-map-marker world-map-marker--${selected.kind} world-map-marker--selected${selected.change === 'base' ? '' : ' world-map-marker--mod'}`} onClick={() => onSelect(selected)} style={position(selected)} title={selected.name} type="button"><Icon name={MAP_KIND_ICONS[selected.kind]}/><span className="world-map-selected-label">{selected.name}</span></button>}
      {imageStatus !== 'ready' && <div className="world-map-image-status" role={imageStatus === 'error' ? 'alert' : 'status'}><Icon name={imageStatus === 'error' ? 'warning' : 'compass'}/><strong>{imageStatus === 'error' ? 'Map image could not be opened' : 'Opening terrain...'}</strong>{imageStatus === 'error' && <button className="button button--secondary" onClick={() => setRetry(value => value + 1)} type="button">Retry map image</button>}</div>}
      {expanded && <section aria-label="Nearby map locations" className="world-map-stack"><header><strong>Choose a location</strong><button aria-label="Close nearby locations" onClick={() => setExpanded(undefined)} type="button"><Icon name="close"/></button></header>{expanded.markers.map(marker => <button key={marker.id} onClick={() => { setExpanded(undefined); onSelect(marker) }} type="button"><Icon name={MAP_KIND_ICONS[marker.kind]}/><span>{marker.name}<small>{marker.change === 'base' ? 'Vanilla' : marker.sourceName} · Height {marker.y}</small></span></button>)}</section>}
      <div className="world-map-zoom" onPointerDown={event => event.stopPropagation()}><button aria-label="Zoom in" disabled={view.zoom >= MAX_ZOOM} onClick={() => changeZoom(ZOOM_STEP)} title="Zoom in (+)" type="button">+</button><button aria-label="Zoom out" disabled={view.zoom <= 1} onClick={() => changeZoom(1 / ZOOM_STEP)} title="Zoom out (-)" type="button">−</button><button aria-label="Fit map" onClick={fit} title="Fit map (Home)" type="button"><Icon name="compass"/></button></div>
      <div className="world-map-scale" aria-live="off"><span>{view.zoom < 3 ? 'World' : view.zoom < 8 ? 'Region' : 'Detail'}</span><strong>{view.zoom.toFixed(1)}×</strong></div>
    </div>
    <p className="world-map-help" id="world-map-controls-help"><span>Drag to explore · Scroll or pinch to zoom</span><span>Arrow keys to pan · + / - to zoom · Home to fit</span></p>
  </div>
}
