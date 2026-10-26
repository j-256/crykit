import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isoProject, type IsoCamera } from '../../mod-inspector/isometric'
import { useVoxelBrush } from './useVoxelBrush'

const CAMERA: IsoCamera = { coord: { X: 0, Y: 140, Z: 0 }, rotation: 0, elevation: 45, zoom: 1 }
const POINTER_ID = 1
let container: HTMLDivElement, root: Root
let brush: ReturnType<typeof useVoxelBrush>
let frames: Map<number, FrameRequestCallback>
const apply = vi.fn(), interaction = vi.fn()

function Harness() {
  brush = useVoxelBrush({ camera: CAMERA, cells: [], action: 'paint', size: 1, active: true, disabled: false, source: 'original', cancelAttempt: 0, planeHeight: CAMERA.coord.Y, erasableIds: new Set(), occupied: new Set(), onApply: apply, onGestureChange: interaction })
  return null
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames = new Map()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  apply.mockClear(); interaction.mockClear()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<Harness/>))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

async function paintFrame() {
  const pending = [...frames.values()]
  frames.clear()
  await act(async () => { for (const callback of pending) callback(performance.now()) })
}

it('keeps a queued hover from adding cells to a newly started stroke', async () => {
  const point = (X: number) => isoProject({ X, Y: CAMERA.coord.Y, Z: .25 }, CAMERA)
  // Surface layout can change between hover and pointer down, so their projected points can differ
  await act(async () => brush.update(point(-1.75), POINTER_ID))
  await act(async () => { expect(brush.start(point(.25), POINTER_ID)).toBe(true) })
  await paintFrame()
  expect(brush.stroke).toEqual([{ X: 0, Y: 140, Z: 0 }])
  expect(apply).not.toHaveBeenCalled()

  await act(async () => brush.update(point(7.25), POINTER_ID))
  await paintFrame()
  const expected = Array.from({ length: 8 }, (_, X) => ({ X, Y: 140, Z: 0 }))
  expect(brush.stroke).toEqual(expected)
  await act(async () => { expect(brush.finish(point(7.25), POINTER_ID, false)).toBe(true) })
  expect(apply).toHaveBeenCalledExactlyOnceWith('paint', expected, [], 'original')
})
