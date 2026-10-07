import { useLayoutEffect, useRef, useState } from 'react'
import { ISO } from '../../mod-inspector/isometric'

export function useIsometricCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<{ readonly width: number; readonly height: number; readonly ratio: number }>({ width: ISO.viewWidth, height: ISO.viewHeight, ratio: 1 })
  useLayoutEffect(() => {
    const element = canvasRef.current!
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width && rect.height) setSize(previous => {
        const next = { width: Math.round(rect.width), height: Math.round(rect.height), ratio: window.devicePixelRatio || 1 }
        return previous.width === next.width && previous.height === next.height && previous.ratio === next.ratio ? previous : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { canvasRef, size }
}
