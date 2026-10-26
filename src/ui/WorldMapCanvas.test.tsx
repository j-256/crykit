import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorldMapManifest } from '../domain/world-map'
import { WorldMapCanvas } from './WorldMapCanvas'

vi.mock('../catalog/world-map', () => ({ worldMapImage: (layer: { image: string }) => layer.image }))

const manifest: WorldMapManifest = {
  schemaVersion: 1, source: { platform: 'synthetic', gameVersion: 'synthetic' },
  bounds: { x: 0, z: 0, width: 100, height: 100 },
  layers: [{ id: 0, label: 'First layer', image: '/first.png' }, { id: 1, label: 'Second layer', image: '/second.png' }],
  regions: [], markers: [],
}
const ignore = () => {}
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

function Map({ layerId = 0, source = manifest, beforeEffects }: { layerId?: number; source?: WorldMapManifest; beforeEffects?: 'load' | 'error' }) {
  // A cached resource can settle during commit, before passive effects run
  useLayoutEffect(() => { if (beforeEffects) container.querySelector('img')!.dispatchEvent(new Event(beforeEffects)) }, [layerId, source, beforeEffects])
  return <WorldMapCanvas manifest={source} markers={source.markers} layerId={layerId} onSelect={ignore} onVisibleChange={ignore}/>
}

it.each(['load', 'error'] as const)('retains an image %s event delivered before passive effects', async event => {
  await act(async () => root.render(<Map beforeEffects={event}/>))
  expect(container.textContent).not.toContain('Opening terrain...')
  expect(container.querySelector('[role="alert"]') !== null).toBe(event === 'error')
})

it('scopes readiness to the image source and retry while ignoring detached image events', async () => {
  await act(async () => root.render(<Map beforeEffects="load"/>))
  const previous = container.querySelector('img')!
  const replacement = { ...manifest, layers: [{ ...manifest.layers[0], image: '/replacement.png' }] }
  await act(async () => root.render(<Map source={replacement}/>))
  expect(container.textContent).toContain('Opening terrain...')
  await act(async () => previous.dispatchEvent(new Event('load')))
  expect(container.textContent).toContain('Opening terrain...')
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(container.textContent).toContain('Map image could not be opened')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry map image')!.click())
  expect(container.textContent).toContain('Opening terrain...')
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => previous.dispatchEvent(new Event('error')))
  expect(container.querySelector('.world-map-image-status')).toBeNull()
})
