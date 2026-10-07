import { memo, useLayoutEffect } from 'react'
import { ISO, isoProject, isoViewportFootprint, type IsoCamera } from '../../mod-inspector/isometric'
import { useIsometricCanvas } from './useIsometricCanvas'

const MAX_GRID_LINES = 128
const MAJOR_GRID_INTERVAL = 4
const GUIDE_HALF_SIDE = 6
const GUIDE_MARGIN = 18
interface Props { readonly active: boolean; readonly height?: number; readonly mappedHeight?: number; readonly camera: IsoCamera }

export default memo(function IsometricConstructionPlane({ active, height, mappedHeight, camera }: Props) {
  const { canvasRef, size } = useIsometricCanvas()
  const origin = height === undefined ? undefined : isoProject({ ...camera.coord, Y: height }, camera)
  const difference = height === undefined || mappedHeight === undefined ? undefined : height - mappedHeight
  const surfaceLabel = difference === undefined ? 'Mapped surface unknown here' : difference === 0 ? `At mapped surface Y ${mappedHeight}` : `${Math.abs(difference)} ${difference > 0 ? 'above' : 'below'} mapped surface Y ${mappedHeight}`
  useLayoutEffect(() => {
    const canvas = canvasRef.current!
    const context = canvas.getContext('2d')
    if (!context) return
    const width = Math.round(size.width * size.ratio)
    const bitmapHeight = Math.round(size.height * size.ratio)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight
    context.setTransform(canvas.width / ISO.viewWidth, 0, 0, canvas.height / ISO.viewHeight, 0, 0)
    context.clearRect(0, 0, ISO.viewWidth, ISO.viewHeight)
    if (!active || height === undefined) return
    const footprint = isoViewportFootprint(camera, height)
    if (!footprint.length) return
    // Screen-sized strokes and markers remain legible when the canvas shrinks on mobile
    const pixel = ISO.viewWidth / size.width
    const anchor = isoProject({ ...camera.coord, Y: height }, camera)
    const halfSide = Math.min(GUIDE_HALF_SIDE, GUIDE_HALF_SIDE / camera.zoom)
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => isoProject({ X: camera.coord.X + x! * halfSide, Y: height, Z: camera.coord.Z + z! * halfSide }, camera))
    const outline = () => {
      context.beginPath()
      corners.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
      context.closePath()
    }
    // The outlined patch locates the infinite editing plane, never bounds where painting is allowed
    outline(); context.fillStyle = 'rgba(115, 236, 255, .16)'; context.fill()
    const bounds = { X: { min: Math.floor(Math.min(...footprint.map(p => p.X))), max: Math.ceil(Math.max(...footprint.map(p => p.X))) }, Z: { min: Math.floor(Math.min(...footprint.map(p => p.Z))), max: Math.ceil(Math.max(...footprint.map(p => p.Z))) } }
    // This grid is a camera reference, never an exported voxel or a collision claim
    // Bound its line count independently of zoom so an empty-space guide stays inexpensive
    for (const axis of ['X', 'Z'] as const) {
      const other = axis === 'X' ? 'Z' : 'X'
      const stride = Math.max(1, Math.ceil((bounds[axis].max - bounds[axis].min) / MAX_GRID_LINES))
      for (let value = Math.ceil(bounds[axis].min / stride) * stride; value <= bounds[axis].max; value += stride) {
        const from = isoProject({ X: 0, Y: height, Z: 0, [axis]: value, [other]: bounds[other].min }, camera)
        const to = isoProject({ X: 0, Y: height, Z: 0, [axis]: value, [other]: bounds[other].max }, camera)
        context.strokeStyle = value % MAJOR_GRID_INTERVAL === 0 ? 'rgba(115, 236, 255, .65)' : 'rgba(115, 236, 255, .3)'
        context.lineWidth = (value % MAJOR_GRID_INTERVAL === 0 ? 1 : .6) * pixel
        context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke()
      }
    }
    outline(); context.strokeStyle = '#102631'; context.lineWidth = 4 * pixel; context.stroke()
    context.strokeStyle = '#73ecff'; context.lineWidth = 2 * pixel; context.stroke()
    if (mappedHeight !== undefined && mappedHeight !== height) {
      const ground = isoProject({ ...camera.coord, Y: mappedHeight }, camera)
      const end = Math.max(GUIDE_MARGIN * pixel, Math.min(ISO.viewHeight - GUIDE_MARGIN * pixel, ground.y))
      context.beginPath(); context.moveTo(anchor.x, anchor.y); context.lineTo(anchor.x, end)
      context.strokeStyle = '#102631'; context.lineWidth = 4 * pixel; context.stroke()
      context.setLineDash([5 * pixel, 4 * pixel]); context.strokeStyle = '#73ecff'; context.lineWidth = 2 * pixel; context.stroke(); context.setLineDash([])
      // An off-screen surface gets an arrow, never a marker implying a different mapped height
      context.beginPath()
      if (ground.y === end) context.ellipse(anchor.x, end, 7 * pixel, 3 * pixel, 0, 0, Math.PI * 2)
      else {
        const direction = Math.sign(ground.y - anchor.y)
        context.moveTo(anchor.x - 5 * pixel, end - direction * 7 * pixel); context.lineTo(anchor.x, end); context.lineTo(anchor.x + 5 * pixel, end - direction * 7 * pixel)
      }
      context.stroke()
    }
    context.beginPath(); context.arc(anchor.x, anchor.y, 4 * pixel, 0, Math.PI * 2)
    context.fillStyle = '#73ecff'; context.fill(); context.strokeStyle = '#102631'; context.lineWidth = 2 * pixel; context.stroke()
  }, [active, height, mappedHeight, camera, size])
  return <><canvas ref={canvasRef} className="iso-plane-bitmap" aria-hidden="true" data-plane-height={active ? height : undefined}/>{active && origin && <div className="iso-plane-label" role="img" aria-label={`Construction plane Y ${height}. ${surfaceLabel}`} style={{ left: `${origin.x / ISO.viewWidth * 100}%`, top: `${origin.y / ISO.viewHeight * 100}%` }}><strong>Construction plane · Y {height}</strong><span>{surfaceLabel}</span></div>}</>
})
