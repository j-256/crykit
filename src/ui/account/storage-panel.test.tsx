import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StoragePanel } from './StoragePanel'
import { STORAGE_WARNING_FRACTION, type StorageService } from '../../account/storage'
let container: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const button = (name: string) => [...container.querySelectorAll('button')].find(value => value.textContent === name)!
const service = (): StorageService => ({
  local: async () => ({ observedAt: 1800000000000, pendingWork: true, categories: [{ label: 'Save files', count: 2 }], contentBytes: 42 }),
  remote: async () => ({ version: 1, source: 'application-database', observedAt: 1800000000000, capacityBytes: 100, usedBytes: 80 }),
  recovery: async () => ({ version: 1, state: 'paused', lastVerifiedAt: null, ageMs: null, code: 'MEASURED_POLICY_REQUIRED' }),
  backup: vi.fn(async () => {}), prepareRemoval: async () => ({ pendingWork: true, remove: vi.fn(async () => {}) }),
})
it('shows observed quota and honest paused recovery without claiming a backup exists', async () => {
  await act(async () => root.render(<StoragePanel service={service()}/>))
  await act(async () => button('Refresh storage').click())
  expect(STORAGE_WARNING_FRACTION).toBe(0.8)
  expect(container.textContent).toContain('Storage is nearly full')
  expect(container.textContent).toContain('Service recovery paused')
  expect(container.textContent).toContain('No verified recovery point')
  expect(container.textContent).toContain('Save files: 2')
  expect(container.textContent).toContain('Other devices and provider headroom are unknown')
})
it('keeps backup failure visible and does not remove account data', async () => {
  const api = service(), remove = vi.fn(async () => {})
  api.backup = vi.fn(async () => { throw new Error('QuotaExceededError') })
  api.prepareRemoval = async () => ({ pendingWork: true, remove })
  await act(async () => root.render(<StoragePanel service={api}/>))
  await act(async () => button('Remove saved account from this device').click())
  expect(container.textContent).toContain('Changes are waiting to sync')
  await act(async () => button('Download backup first').click())
  expect(container.textContent).toContain('Backup could not be downloaded')
  expect(remove).not.toHaveBeenCalled()
  expect(button('Remove this device copy').disabled).toBe(true)
})
it('requires explicit loss acknowledgment and invokes the captured real removal action', async () => {
  const api = service(), remove = vi.fn(async () => {})
  api.prepareRemoval = async () => ({ pendingWork: true, remove })
  await act(async () => root.render(<StoragePanel service={api}/>))
  await act(async () => button('Remove saved account from this device').click())
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await act(async () => button('Remove this device copy').click())
  expect(remove).toHaveBeenCalledOnce()
})
it('keeps local backup usable when online storage fails', async () => {
  const api = service(); api.remote = async () => { throw new Error('offline') }; api.recovery = api.remote as unknown as StorageService['recovery']
  await act(async () => root.render(<StoragePanel service={api}/>))
  await act(async () => button('Refresh storage').click())
  expect(container.textContent).toContain('Cloud usage unknown')
  expect(container.textContent).toContain('Save files: 2')
  await act(async () => button('Account backup').click())
  expect(api.backup).toHaveBeenCalledOnce()
})
it('reviews exact retained dependencies and retries the same pending cleanup before reporting completion', async () => {
  const api = service(), ref = { documentId: 'AAAAAAAAAAAAAAAAAAAAAA', revisionId: 'BBBBBBBBBBBBBBBBBBBBBA' }
  const preview = { version: 1 as const, ref, generation: 'CCCCCCCCCCCCCCCCCCCCCA', publicationEpoch: 9, observedAt: 1800000000000, eligible: true, reasons: [], reclaimableBytes: 2048, dependencies: [{ documentId: ref.documentId, revisionId: 'DDDDDDDDDDDDDDDDDDDDDA' }] }
  api.scanCleanup = async () => ({ candidates: [{ ref, category: 'build' }], unavailable: false })
  api.previewCleanup = vi.fn(async () => preview)
  api.cleanup = vi.fn().mockResolvedValueOnce({ version: 1, state: 'pending', releasedBytes: 0 }).mockResolvedValueOnce({ version: 1, state: 'complete', releasedBytes: 2048 })
  await act(async () => root.render(<StoragePanel service={api}/>))
  await act(async () => button('Find unused sync data').click())
  expect(api.cleanup).not.toHaveBeenCalled()
  await act(async () => button(`Review unused version ${ref.revisionId.slice(-6)}`).click())
  expect(container.querySelector('details')?.textContent).toContain(preview.dependencies[0].revisionId)
  await act(async () => button('Remove unused sync data').click())
  expect(container.textContent).toContain('Cleanup is pending')
  await act(async () => button('Remove unused sync data').click())
  expect(api.cleanup).toHaveBeenNthCalledWith(1, preview)
  expect(api.cleanup).toHaveBeenNthCalledWith(2, preview)
  expect(container.textContent).toContain('Source files and history remain')
})
