import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { worldMapImage } from '../../catalog/world-map'
import type { WorldMapManifest } from '../../domain/world-map'
import { ISO_ELEVATION, isoViewportFootprint, type IsoCamera } from '../../mod-inspector/isometric'
import { Button, Segmented } from '../components'

const REGION_WIDTH = 160
const REGION_HEIGHT = 120
const KEYBOARD_STEP = 8
const MIN_LABEL_DISTANCE = 30
const TAP_TOLERANCE = 5
interface Props { readonly manifest: WorldMapManifest; readonly layerId: number; readonly camera: IsoCamera; readonly onNavigate: (x: number, z: number) => void }

export default function MapOrientation({ manifest, layerId, camera, onNavigate }: Props) {
  const helpId = useId()
  const [scale, setScale] = useState<'region' | 'world'>('region')
  const [imageError, setImageError] = useState(false)
  const [retry, setRetry] = useState(0)
  const pointerStart = useRef<{ readonly id: number; readonly x: number; readonly y: number } | undefined>(undefined)
  const bounds = manifest.bounds
  const layer = manifest.layers.find(value => value.id === layerId)!
  const width = scale === 'world' ? bounds.width : Math.min(REGION_WIDTH, bounds.width)
  const height = scale === 'world' ? bounds.height : Math.min(REGION_HEIGHT, bounds.height)
  const x = scale === 'world' ? bounds.x : Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, camera.coord.X - width / 2))
  const z = scale === 'world' ? bounds.z : Math.max(bounds.z, Math.min(bounds.z + bounds.height - height, camera.coord.Z - height / 2))
  const footprint = isoViewportFootprint(camera)
  const labels: WorldMapManifest['regions'][number][] = []
  for (const region of manifest.regions) if (region.layer === layerId && region.name.trim() && region.x > x && region.x < x + width && region.z > z && region.z < z + height && !labels.some(other => Math.hypot(region.x - other.x, region.z - other.z) < MIN_LABEL_DISTANCE * width / REGION_WIDTH)) labels.push(region)
  const navigate = (nextX: number, nextZ: number) => onNavigate(Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, Math.round(nextX))), Math.max(bounds.z, Math.min(bounds.z + bounds.height - 1, Math.round(nextZ))))
  function pick(event: PointerEvent<SVGSVGElement>) {
    const start = pointerStart.current
    pointerStart.current = undefined
    if (event.button !== 0 || imageError || start?.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_TOLERANCE) return
    // Camera navigation never writes placement coordinates or a document patch
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(event.currentTarget.getScreenCTM()!.inverse())
    if (point.x >= x && point.x < x + width && point.y >= z && point.y < z + height) navigate(point.x, point.y)
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const directions: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const direction = directions[event.key]
    if (direction) { event.preventDefault(); navigate(camera.coord.X + direction[0] * KEYBOARD_STEP, camera.coord.Z + direction[1] * KEYBOARD_STEP) }
  }
  const strokeWidth = width / 240
  return <aside className="map-orientation stack" aria-label="Workspace orientation">
    <h3>Orientation Map</h3>
    <Segmented label="Orientation map scale" value={scale} options={[{ value: 'region', label: 'Region' }, { value: 'world', label: 'World' }]} onChange={setScale}/>
    <div className="map-orientation-control" role="region" tabIndex={0} aria-label="Navigate editor camera" aria-describedby={helpId} onKeyDown={keyboard}>
      <svg className="map-orientation-canvas" role="img" aria-label={`${layer.label} orientation map`} viewBox={`${x} ${z} ${width} ${height}`} onPointerDown={event => { pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY } }} onPointerUp={pick} onPointerCancel={() => { pointerStart.current = undefined }} data-center={`${camera.coord.X},${camera.coord.Z}`}>
        <image key={`${layerId}:${retry}`} href={worldMapImage(layer)} x={bounds.x} y={bounds.z} width={bounds.width} height={bounds.height} onLoad={() => setImageError(false)} onError={() => setImageError(true)}/>
        <g className="map-orientation-labels" style={{ fontSize: width / 24, strokeWidth }}>{labels.map(region => <text key={region.id} x={region.x} y={region.z} textAnchor="middle">{region.name}</text>)}</g>
        {footprint.length > 0 && <polygon className="map-orientation-footprint" points={footprint.map(point => `${point.X},${point.Z}`).join(' ')} strokeWidth={strokeWidth * 2}/>}
        <path className="map-orientation-center" d={`M ${camera.coord.X - width / 40} ${camera.coord.Z} h ${width / 20} M ${camera.coord.X} ${camera.coord.Z - width / 40} v ${width / 20}`} strokeWidth={strokeWidth * 2}/>
      </svg>
    </div>
    {imageError && <p role="alert">Orientation map could not be opened. <Button tone="secondary" onClick={() => setRetry(value => value + 1)}>Retry orientation map</Button></p>}
    <p className="field__hint" id={helpId}>Click or tap to navigate. Arrow keys move the camera. {camera.elevation === ISO_ELEVATION.side ? 'Tilt up from side view to see the ground footprint.' : 'The outline shows the workspace at camera height.'}</p>
    <p className="field__hint map-orientation-position">Camera X {camera.coord.X} · Y {camera.coord.Y} · Z {camera.coord.Z}</p>
  </aside>
}
