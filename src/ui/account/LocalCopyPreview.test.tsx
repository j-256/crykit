import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalCopyPreview } from './LocalCopyPreview'
import { installProfile, invalidateProfile } from '../../account/profile'
import { accountLocalId } from '../../workspace/account-cache'
import type { GuestCopyPreview } from '../../workspace/guest-copy'

let container: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile() })
const recoveryMethods = () => ({ listSavedGuestCopies: vi.fn(async () => []), keepSavedCopyAndRepreview: vi.fn(async () => ({ activated: false })), withSavedGuestCopy: vi.fn() })
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!
it('requiresPreviewAndExplicitSampleSelectionAndDisclosesDependencies', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const original: GuestCopyPreview = { copyId: 'copy', snapshotId: 'snapshot', accountId: token.accountId, records: [{ key: 'sample', kind: 'build', label: 'Edited sample', sample: true }], selectedKeys: [], closure: [], estimatedBytes: 0, conflicts: [], problems: [], resumable: false }
  const previewGuestCopy = vi.fn(async (_token, selection: readonly string[] = []) => ({ ...original, selectedKeys: [...selection], closure: selection.length ? [{ key: 'catalog', kind: 'catalog', label: 'Exact pinned catalog', sample: false }] : [] }))
  const commitGuestCopy = vi.fn(async () => ({ copyId: 'copy', accountId: token.accountId, mappings: [] }))
  const service = { ...recoveryMethods(), previewGuestCopy, commitGuestCopy, previewRetainedComparison: vi.fn(), inspectCopiedComparisons: vi.fn(async () => []), continueCopiedComparisons: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  await act(async () => root.render(<LocalCopyPreview token={token} service={service}/>))
  expect(previewGuestCopy).not.toHaveBeenCalled()
  await act(async () => button('Copy local work').click())
  expect(container.querySelector('input')?.checked).toBe(false)
  expect(container.textContent).toContain('Sample provenance')
  await act(async () => container.querySelector('input')!.click())
  expect(container.textContent).toContain('Exact pinned catalog')
  await act(async () => button('Copy selected work').click())
  expect(commitGuestCopy).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Copied to this account')
})
it('cancellationDoesNotCommitAndLatePreviewCannotAppearInAnotherProfile', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  let finish!: (value: GuestCopyPreview) => void
  const service = { ...recoveryMethods(), previewGuestCopy: vi.fn(() => new Promise<GuestCopyPreview>(resolve => { finish = resolve })), commitGuestCopy: vi.fn(), previewRetainedComparison: vi.fn(), inspectCopiedComparisons: vi.fn(async () => []), continueCopiedComparisons: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  await act(async () => root.render(<LocalCopyPreview token={token} service={service}/>))
  await act(async () => button('Copy local work').click())
  await act(async () => button('Cancel').click())
  await act(async () => finish({ copyId: 'copy', snapshotId: 'old', accountId: token.accountId, records: [], selectedKeys: [], closure: [], estimatedBytes: 0, conflicts: [], problems: [], resumable: false }))
  expect(container.textContent).not.toContain('Choose local records')
  expect(service.commitGuestCopy).not.toHaveBeenCalled()
})
it('showsPendingOriginalsAndRequiresAnExplicitContinuationAfterTheAccountChoice', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  let collision = true
  const service = { ...recoveryMethods(), previewGuestCopy: vi.fn(), commitGuestCopy: vi.fn(), previewRetainedComparison: vi.fn(), inspectCopiedComparisons: vi.fn(async () => [{ id: 'comparison', originalId: 'original', copyId: 'copy', registered: false, historical: false, collision, versions: [{ value: { name: 'Pending original' }, documents: [] }, { value: { name: 'Accepted original' }, documents: [] }], blobs: [] }]), continueCopiedComparisons: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  await act(async () => root.render(<LocalCopyPreview token={token} service={service}/>))
  expect(service.inspectCopiedComparisons).not.toHaveBeenCalled()
  await act(async () => button('Review copied comparisons').click())
  expect(container.textContent).toContain('Pending original')
  expect(container.textContent).toContain('Accepted original')
  expect(button('Continue copied comparison').disabled).toBe(true)
  expect(service.continueCopiedComparisons).not.toHaveBeenCalled()
  collision = false
  await act(async () => button('Review copied comparisons').click())
  await act(async () => button('Continue copied comparison').click())
  expect(service.continueCopiedComparisons).toHaveBeenCalledWith(token, 'copy')
  expect(service.commitGuestCopy).not.toHaveBeenCalled()
})

it('cannotCommitAnOldPreviewAfterAnOwnerlessComparisonSelectionFailsAndKeepsVisibleSelectionsForCorrection', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const original: GuestCopyPreview = { copyId: 'copy', snapshotId: 'snapshot', accountId: token.accountId, records: ['Editor', 'Ownerless comparison', 'Owning Playthrough'].map(key => ({ key, kind: key, label: key, sample: false })), selectedKeys: [], closure: [], estimatedBytes: 0, conflicts: [], problems: [], resumable: false }
  let rejectSelection!: (reason: Error) => void
  const previewGuestCopy = vi.fn(async (_token, selection: readonly string[] = []) => {
    if (selection.includes('Ownerless comparison') && !selection.includes('Owning Playthrough')) await new Promise<void>((_resolve, reject) => { rejectSelection = reject })
    return { ...original, selectedKeys: [...selection] }
  })
  const service = { ...recoveryMethods(), previewGuestCopy, commitGuestCopy: vi.fn(), previewRetainedComparison: vi.fn(), inspectCopiedComparisons: vi.fn(async () => []), continueCopiedComparisons: vi.fn(), dispose: vi.fn(async () => {}) }
  await act(async () => root.render(<LocalCopyPreview token={token} service={service}/>))
  await act(async () => button('Copy local work').click())
  const checkboxes = () => [...container.querySelectorAll('input')]
  await act(async () => checkboxes()[0].click())
  expect(button('Copy selected work').disabled).toBe(false)
  await act(async () => checkboxes()[1].click())
  expect(checkboxes().map(input => input.checked)).toEqual([true, true, false])
  expect(button('Copy selected work').disabled).toBe(true)
  await act(async () => rejectSelection(new Error('Select the complete owning Playthrough')))
  expect(container.textContent).toContain('Select the complete owning Playthrough')
  expect(button('Copy selected work').disabled).toBe(true)
  await act(async () => button('Copy selected work').click())
  expect(service.commitGuestCopy).not.toHaveBeenCalled()
  await act(async () => checkboxes()[2].click())
  expect(previewGuestCopy).toHaveBeenLastCalledWith(token, ['Editor', 'Ownerless comparison', 'Owning Playthrough'])
  expect(checkboxes().map(input => input.checked)).toEqual([true, true, true])
  expect(button('Copy selected work').disabled).toBe(false)
  await act(async () => button('Copy selected work').click())
  expect(service.commitGuestCopy).toHaveBeenCalledWith(token, expect.objectContaining({ selectedKeys: ['Editor', 'Ownerless comparison', 'Owning Playthrough'] }))
})
it('offersExplicitSavedCopyRecoveryThenAFreshPreviewAndDiscoverableBackup', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const stale: GuestCopyPreview = { copyId: 'old', snapshotId: 'snapshot', accountId: token.accountId, records: [], selectedKeys: ['Editor'], closure: [], estimatedBytes: 0, conflicts: [], problems: ['The account changed'], resumable: true }
  const service = { ...recoveryMethods(), previewGuestCopy: vi.fn().mockResolvedValueOnce(stale).mockResolvedValue({ ...stale, copyId: 'fresh', selectedKeys: [], problems: [], resumable: false }), commitGuestCopy: vi.fn(), previewRetainedComparison: vi.fn(), inspectCopiedComparisons: vi.fn(async () => []), continueCopiedComparisons: vi.fn(), dispose: vi.fn(async () => {}), listSavedGuestCopies: vi.fn(async () => [{ copyId: 'old', labels: ['Editor'], activated: false, pending: false }]) }
  await act(async () => root.render(<LocalCopyPreview token={token} service={service}/>))
  await act(async () => button('Copy local work').click())
  expect(button('Resume copy').disabled).toBe(true)
  await act(async () => button('Keep saved copy and preview again').click())
  expect(service.keepSavedCopyAndRepreview).toHaveBeenCalledWith(token, stale)
  expect(service.previewGuestCopy).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Choose local records')
  await act(async () => button('Cancel').click())
  await act(async () => button('Review saved copies').click())
  expect(container.textContent).toContain('Editor')
  await act(async () => button('Download saved copy').click())
  expect(service.withSavedGuestCopy).toHaveBeenCalledWith(token, 'old', expect.any(Function))
  expect(service.commitGuestCopy).not.toHaveBeenCalled()
})
