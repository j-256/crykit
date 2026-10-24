import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CatalogEntity } from '../../domain/types'
import { PrivateArtwork } from './PrivateArtwork'

const context = vi.hoisted(() => ({ current: undefined as unknown, open: vi.fn(), find: vi.fn(), region: vi.fn() }))
vi.mock('../WorkspaceProvider', () => ({ useOptionalWorkspace: () => context.current }))
vi.mock('../../workspace/artwork-repository', () => ({ findPrivateArtworkForEntity: context.find, openLocalArtwork: context.open, openPrivateArtwork: context.open, privateArtworkRegion: context.region }))

let container: HTMLDivElement
let root: Root
const entity = { id: 'synthetic:item' as CatalogEntity['id'], kind: 'item' as const, name: 'Synthetic item', fields: {} }
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  context.current = { repository: { kind: 'guest', readWorkspace: async () => ({}) } }
  context.find.mockReturnValue({ id: 'asset', width: 240, height: 36 })
  context.region.mockReturnValue({ x: 2, y: 2, width: 32, height: 32 })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks() })

it('revokesPrivateArtworkOnUnmountAndImageFailure', async () => {
  const revoke = vi.fn()
  context.open.mockResolvedValue({ url: 'blob:own', revoke })
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" entity={entity} fallback={<span>Missing</span>}/>))
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:own')
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error', { bubbles: true })))
  expect(revoke).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Missing')
})

it('revokesPrivateArtworkAfterLateCompletion', async () => {
  let finish!: (value: { url: string; revoke: () => void }) => void
  const revoke = vi.fn()
  context.open.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" entity={entity} fallback={<span>Missing</span>}/>))
  await act(async () => root.unmount())
  await act(async () => finish({ url: 'blob:late', revoke }))
  expect(revoke).toHaveBeenCalledOnce()
  root = createRoot(container)
})

it('keepsEquivalentBindingAndRevokesChangedReferenceOrProfile', async () => {
  const revoke = vi.fn()
  const repository = { kind: 'guest', readWorkspace: async () => ({}) }
  context.current = { repository, token: { accountId: 'one', generation: 0 } }
  context.open.mockImplementation(async () => ({ url: `blob:own-${context.open.mock.calls.length}`, revoke }))
  const record = { state: 'known' as const, value: { ID: 7, TexturePath: 'icon', TextureIndex: 0 }, sources: [{ sourceId: 'source:sha256:synthetic' }] }
  const original = { ...entity, fields: { 'Crystal Edit source record': record } }
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" entity={original} fallback={<span>Missing</span>}/>))
  expect(context.open).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" entity={{ ...original, fields: { ...original.fields } }} fallback={<span>Missing</span>}/>))
  expect(context.open).toHaveBeenCalledTimes(1)
  expect(revoke).not.toHaveBeenCalled()
  const changed = { ...original, fields: { 'Crystal Edit source record': { ...record, value: { ...record.value, TextureIndex: 1 } } } }
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" entity={changed} fallback={<span>Missing</span>}/>))
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(context.open).toHaveBeenCalledTimes(2)
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" catalogRevisionId="changed-revision" entity={changed} fallback={<span>Missing</span>}/>))
  expect(revoke).toHaveBeenCalledTimes(2)
  expect(context.open).toHaveBeenCalledTimes(3)
  context.current = { repository, token: { accountId: 'two', generation: 1 } }
  await act(async () => root.render(<PrivateArtwork catalogId="synthetic" catalogRevisionId="changed-revision" entity={changed} fallback={<span>Missing</span>}/>))
  expect(revoke).toHaveBeenCalledTimes(3)
  expect(context.open).toHaveBeenCalledTimes(4)
})
