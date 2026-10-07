import { memo, useLayoutEffect } from 'react'
import { ISO, isoFaces, isoProject, isoVisibleFaces, type IsoCamera } from '../../mod-inspector/isometric'
import type { PlacementCoord } from '../../mod-inspector/map-editor'
import { MAP_FACE } from '../../domain/map-geometry'
import { useIsometricCanvas } from './useIsometricCanvas'

interface Props { readonly active: boolean; readonly stroke: readonly PlacementCoord[]; readonly camera: IsoCamera; readonly color: string }

export default memo(function IsometricBrushOverlay({ active, stroke, camera, color }: Props) {
  const { canvasRef, size } = useIsometricCanvas()
  useLayoutEffect(() => {
    const canvas = canvasRef.current!
    const context = canvas.getContext('2d')
    if (!context) return
    const width = Math.round(size.width * size.ratio)
    const height = Math.round(size.height * size.ratio)
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    context.setTransform(canvas.width / ISO.viewWidth, 0, 0, canvas.height / ISO.viewHeight, 0, 0)
    context.clearRect(0, 0, ISO.viewWidth, ISO.viewHeight)
    if (!active) return
    context.globalAlpha = .65; context.fillStyle = color; context.strokeStyle = '#73ecff'; context.lineWidth = 1.5
    const visible = isoVisibleFaces(camera)
    // Cursor/stroke feedback has its own bitmap, so it never repaints native terrain
    // The bounded stroke remains transient paint data until the document accepts release
    for (const coord of stroke) for (const face of isoFaces(coord, 1, camera, MAP_FACE.all, visible)) {
      context.beginPath()
      face.points.forEach((coord, index) => { const p = isoProject(coord, camera); if (index) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y) })
      context.closePath(); context.fill(); context.stroke()
    }
    context.globalAlpha = 1
  }, [active, stroke, camera, color, size])
  return <canvas ref={canvasRef} className="iso-brush-bitmap" aria-hidden="true" data-stroke-cells={stroke.length}/>
})
