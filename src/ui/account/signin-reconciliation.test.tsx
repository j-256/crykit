import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SigninReconciliation } from './SigninReconciliation'
import type { SigninReconciliationState } from '../../workspace/signin-reconciliation'
let container: HTMLDivElement, root: Root
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })
const state: SigninReconciliationState = { phase: 'choosing', source: 'available', fresh: true, canOpenAccount: true }
const actions = () => ({ choose: vi.fn(async () => {}), confirm: vi.fn(async () => {}), cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}), reviewReplacement: vi.fn(async () => {}), declineReplacement: vi.fn(async () => {}), backup: vi.fn(async () => {}) })
const click = async (name: string) => { const button = [...container.querySelectorAll('button')].find(value => value.textContent === name); expect(button).toBeDefined(); await act(async () => button!.click()) }
it('requires account replacement confirmation before the opening action and focuses review', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={state} actions={controller}/>))
  await click('Use account data on this device')
  expect(controller.choose).not.toHaveBeenCalled()
  expect(document.activeElement?.textContent).toBe('Use account data on this device?')
  await click('Confirm use account data')
  expect(controller.choose).toHaveBeenCalledWith('account')
})
it('device confirmation is separate from choice and explains other devices', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'confirming', action: 'device' }} actions={controller}/>))
  expect(controller.confirm).not.toHaveBeenCalled()
  expect(container.textContent).toContain('other devices')
  await click('Confirm replace account data')
  expect(controller.confirm).toHaveBeenCalledOnce()
})
it.each([undefined, 'device'] as const)('preparation hides ordinary choices and unavailable summaries for %s', async action => {
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', fresh: false, action }} actions={actions()}/>))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Preparing')
  expect(container.textContent).not.toContain('0 Builds')
  expect([...container.querySelectorAll('button')].map(value => value.textContent)).toEqual(['Cancel and return to workspace'])
})
it('paused replacement has distinct keep-working and latest actions with confirmation', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, replacement: { state: 'paused' } as SigninReconciliationState['replacement'] }} actions={controller}/>))
  await click('Keep working on this device')
  expect(controller.declineReplacement).toHaveBeenCalledOnce()
  await click('Review latest account data')
  expect(controller.reviewReplacement).toHaveBeenCalledWith('latest')
  expect(controller.choose).not.toHaveBeenCalled()
})
it.each(['quota', 'offline', 'opening-failed'])('offers safe retry after %s without disclosing diagnostics', async reason => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'failed', reason }} actions={controller}/>))
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  await click(reason === 'opening-failed' ? 'Retry opening' : 'Retry preparation')
  expect(controller.retry).toHaveBeenCalledOnce()
})
it('labels a recovery source accurately without claiming it is the guest workspace', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={state} actions={controller} sourceLabel="Recovery snapshot"/>))
  await click('Replace account data with recovery data')
  expect(controller.choose).toHaveBeenCalledWith('device')
  await click('Use account data on this device')
  expect(container.textContent).toContain('The recovery point remains available in Account settings')
  await click('Cancel and return to workspace')
  expect(controller.cancel).toHaveBeenCalledOnce()
})

it('uses account names and friendly counts while keeping same-name Playthrough groups separate', async () => {
  const summary = { meaningful: true, builds: 1, progress: 2, other: 1, rootKeys: [], reasons: [], progressByPlaythrough: [{ playthroughId: 'private-first', label: 'Same name', count: 1 }, { playthroughId: 'private-second', label: 'Same name', count: 1 }], otherByKind: [{ kind: 'personal-definition', count: 1 }] }
  await act(async () => root.render(<SigninReconciliation state={{ ...state, local: summary }} actions={actions()} accountName="synthetic_account"/>))
  expect(container.textContent).toContain('Account: synthetic_account')
  expect(container.textContent).toContain('1 Build · 2 Progress records · 1 other record')
  expect([...container.querySelectorAll('li')].filter(value => value.textContent === 'Same name: 1 Progress record')).toHaveLength(2)
  expect(container.textContent).toContain('1 personal definition')
  expect(container.textContent).not.toContain('private-first')
  expect(container.textContent).not.toContain('private-second')
  expect(container.textContent).not.toContain('personal-definition')
})

it('offers online reconnect when pending recovery resumes with locally unlocked access', async () => {
  const controller = { ...actions(), reconnect: vi.fn(async () => {}) }
  await act(async () => root.render(<SigninReconciliation state={{ ...state, fresh: false, reason: 'signin-required' }} actions={controller} sourceLabel="Recovery snapshot"/>))
  await click('Reconnect to review')
  expect(controller.reconnect).toHaveBeenCalledOnce()
  expect(controller.choose).not.toHaveBeenCalled()
})

it('confirmation uses exact source display names and generic categories without showing stored key labels', async () => {
  const record = (kind: string, key: string) => ({ kind, key, label: `${kind}: private-storage-id`, sample: false })
  const records = [record('progress', '["progress","private-play","private-progress"]'), record('inventory', '["inventory","private-play"]'), record('playthrough', '["playthrough","private-play"]'), record('history', '["history","private-history"]')]
  const preview = { copyId: 'private-copy', accountId: 'private-account', snapshotId: 'private-snapshot', records, closure: records, selectedKeys: records.map(value => value.key), estimatedBytes: 1, conflicts: [], problems: [], resumable: true, signin: { version: 1 as const, requiredCompanionKeys: [records[2].key], progressMappings: [] } }
  const local = { meaningful: true, builds: 0, progress: 1, other: 3, rootKeys: [], reasons: [], progressByPlaythrough: [], otherByKind: [], recordNames: { [records[0].key]: 'Named run / Named class', [records[1].key]: 'Named run', [records[2].key]: 'Named run' } }
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'confirming', action: 'merge', preview, local }} actions={actions()}/>))
  expect(container.textContent).toContain('Progress record: Named run / Named class')
  expect(container.textContent).toContain('Inventory record: Named run')
  expect(container.textContent).toContain('Playthrough: Named run')
  expect(container.textContent).toContain('History entry')
  expect(container.textContent).not.toContain('private-')
})

it('explains shared recovery capacity without claiming a backup frees space or pending points expire', async () => {
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'failed', reason: 'quota', action: 'device' }} actions={actions()}/>))
  const message = container.querySelector('[role="alert"]')!.textContent!
  expect(message).toContain('recovery point limit or a storage limit')
  expect(message).toContain('Pending recovery points stay protected')
  expect(message).toContain('finish syncing or review pending replacements')
  expect(message).toContain('does not free capacity')
  expect(message).not.toContain('Storage is full')
  expect(message).not.toContain('No replacement has been approved')
  expect(message).not.toContain('pending points expire')
})

it('labels actual Progress destination conflicts through exact correspondence without leaking keys', async () => {
  const sourceKey = '["progress","play","guest-observation"]', destinationKey = '["progress","play","account-observation"]'
  const record = { kind: 'progress', key: sourceKey, label: sourceKey, sample: false }
  const preview = { copyId: 'copy', accountId: 'account', snapshotId: 'snapshot', records: [record], closure: [record], selectedKeys: [sourceKey], estimatedBytes: 1, conflicts: [destinationKey, 'unrecognized-private-key'], problems: [], resumable: false, signin: { version: 1 as const, requiredCompanionKeys: [], progressMappings: [{ version: 1 as const, sourceKey, destinationKey, equivalent: false }] } }
  const summary = { meaningful: true, builds: 0, progress: 1, other: 0, rootKeys: [], reasons: [], progressByPlaythrough: [], otherByKind: [] }
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'confirming', action: 'merge', preview, local: { ...summary, recordNames: { [sourceKey]: 'Guest run / Class' } }, account: { ...summary, recordNames: { [destinationKey]: 'Account run / Class' } } }} actions={actions()}/>))
  expect(container.textContent).toContain('Progress record: Account run / Class: Both versions will be kept')
  expect(container.textContent).toContain('Saved record: Both versions will be kept')
  for (const key of [sourceKey, destinationKey, 'unrecognized-private-key']) expect(container.textContent).not.toContain(key)
})

it('describes the backup beside its download action without an unrelated intro warning', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={state} actions={controller}/>))
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Download private account backup')!
  const description = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  expect(description?.textContent).toContain('imported files')
  expect(description?.textContent).toContain('not encrypted')
  expect(button.parentElement?.contains(description)).toBe(true)
  expect(container.textContent).not.toContain('sensitive records; store them privately')
  await click('Download private account backup')
  expect(controller.backup).toHaveBeenCalledOnce()
})


it('announces real preparation stages with indeterminate progress and keeps cancellation available', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', stage: 'comparing-records' }} actions={controller}/>))
  const status = container.querySelector('[role="status"]')!
  expect(status.textContent).toContain('Comparing')
  const indicator = container.querySelector('[role="progressbar"]')!
  expect(indicator).not.toBeNull()
  expect(indicator.getAttribute('aria-valuenow')).toBeNull()
  expect(indicator.getAttribute('aria-label')).toBe('Preparing your workspace')
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', stage: 'preparing-review' }} actions={controller}/>))
  expect(status.textContent).toContain('saved versions')
  await click('Cancel and return to workspace')
  expect(controller.cancel).toHaveBeenCalledOnce()
})

it('shows elapsed waiting time without repeated live announcements and resets after review', async () => {
  vi.useFakeTimers()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', stage: 'checking-account' }} actions={actions()}/>))
  await act(async () => vi.advanceTimersByTime(30_000))
  expect(container.textContent).toContain('30 seconds elapsed')
  expect(container.textContent).toContain('This is taking longer than expected')
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain('seconds elapsed')
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', stage: 'comparing-records' }} actions={actions()}/>))
  expect(container.textContent).toContain('30 seconds elapsed')
  await act(async () => root.render(<SigninReconciliation state={state} actions={actions()}/>))
  expect(container.querySelector('[role="progressbar"]')).toBeNull()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', stage: 'checking-source' }} actions={actions()}/>))
  expect(container.textContent).not.toContain('30 seconds elapsed')
  expect(container.textContent).not.toContain('This is taking longer than expected')
})

it('distinguishes unsaved merge review from confirmed durable preparation', async () => {
  const controller = actions()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'confirming', action: 'merge' }} actions={controller}/>))
  expect(container.textContent).toContain('Reloading before confirmation returns to choices')
  await click('Confirm merge')
  expect(controller.confirm).toHaveBeenCalledOnce()
  await act(async () => root.render(<SigninReconciliation state={{ ...state, phase: 'preparing', action: 'merge', stage: 'preparing-merge' }} actions={controller}/>))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Preparing your confirmed merge')
  expect(container.textContent).not.toContain('Reloading before confirmation')
})
