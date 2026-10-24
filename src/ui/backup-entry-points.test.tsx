// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain'
import { DataPanel } from './DataPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { NavigationProvider, useNavigationController } from './navigation'
import type { GuestRestorePreview } from '../workspace/restore'
import type { AccountRestorePreview } from '../workspace/account-restore'

let container: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState(null, '', '#/settings/data')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const noop = async () => {}
function Harness({ complete, native, restore, target = 'guest' }: { complete: () => Promise<void>; native: () => Promise<Uint8Array>; target?: 'guest' | 'account'; restore?: { preview(file: File): Promise<GuestRestorePreview | AccountRestorePreview>; activate(preview: GuestRestorePreview | AccountRestorePreview): Promise<void>; clear(): Promise<void> } }) {
  const navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><DataPanel open localData={createBlankLocalData()} busy={false} canUndo={false} dirty={false} onClose={() => {}} onPreview={noop} onCommit={noop} onClearPreview={() => {}} onExport={native} onExportWorkspace={complete} onWorkspaceRestoreTarget={target} onWorkspaceRestorePreview={restore?.preview} onWorkspaceRestoreActivate={restore?.activate} onWorkspaceRestoreClear={restore?.clear} onSaveGameSetup={noop} onRetrySave={noop} onSelectGameSetup={noop} onCreatePlaythrough={noop} onSelectPlaythrough={noop} onUndo={noop}/></NavigationProvider>
}
it('DataPanel uses complete backup and preserves captured-workspace errors', async () => {
  const complete = vi.fn(async () => { throw new Error('The captured workspace changed. Retry export.') }), native = vi.fn(async () => new Uint8Array())
  await act(async () => root.render(<Harness complete={complete} native={native}/>))
  const button = [...document.querySelectorAll('button')].find(value => value.textContent === 'Export backup')!
  expect(button).toBeDefined()
  await act(async () => button.click())
  expect(complete).toHaveBeenCalledOnce(); expect(native).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('The captured workspace changed. Retry export.')
  expect(document.body.textContent).toContain('Export planner ZIP')
})
it('ErrorBoundary uses captured durable complete recovery and keeps failed export visible', async () => {
  const complete = vi.fn(async () => { throw new Error('Saved source bytes are unavailable.') }), native = vi.fn(async () => new Uint8Array())
  // Render the boundary through React so its event callback owns the real component state
  const ref = { current: null as ErrorBoundary | null }
  await act(async () => root.render(<ErrorBoundary ref={ref} recoveryDownload={complete} recoveryExport={native}>{null}</ErrorBoundary>))
  await act(async () => ref.current!.setState({ error: new Error('Synthetic render failure') }))
  expect(container.textContent).toContain('Open fields that were never saved cannot be recovered here.')
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Export last saved data')!
  await act(async () => button.click())
  expect(complete).toHaveBeenCalledOnce(); expect(native).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Saved source bytes are unavailable.')
})

it('complete restore previews all private categories and requires replacement confirmation', async () => {
  const preview: GuestRestorePreview = { target: 'guest', selectedProfileId: 'old', categories: { planner: 1, editor: 2, save: 3, asset: 4, history: 5 }, privateBytes: 1024, effect: 'replace-selected-profile' }
  const activate = vi.fn(async () => {})
  const restore = { preview: vi.fn(async () => preview), activate, clear: vi.fn(async () => {}) }
  await act(async () => root.render(<Harness complete={noop} native={async () => new Uint8Array()} restore={restore}/>))
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose complete workspace backup"]')!
  expect(input).toBeDefined()
  const file = new File([new Uint8Array([1, 2])], 'private.crykit')
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(document.body.textContent).toContain('private.crykit')
  expect(document.body.textContent).toContain('Editor documents')
  expect(document.body.textContent).toContain('Save documents')
  expect(document.body.textContent).toContain('History')
  const button = [...document.querySelectorAll('button')].find(value => value.textContent === 'Replace saved workspace')!
  expect(button.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Confirm complete workspace replacement"]')!.click())
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(activate).toHaveBeenCalledWith(preview)
})

it('failed complete restore leaves an explicit reopen and recovery path', async () => {
  const preview: GuestRestorePreview = { target: 'guest', selectedProfileId: 'old', categories: { planner: 1, editor: 0, save: 0, asset: 0, history: 1 }, privateBytes: 12, effect: 'replace-selected-profile' }
  const restore = { preview: vi.fn(async () => preview), activate: vi.fn(async () => { throw new Error('Staging was blocked') }), clear: vi.fn(async () => {}) }
  await act(async () => root.render(<Harness complete={noop} native={async () => new Uint8Array()} restore={restore}/>))
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose complete workspace backup"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([1])], 'blocked.crykit')] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Confirm complete workspace replacement"]')!.click())
  await act(async () => [...document.querySelectorAll('button')].find(value => value.textContent === 'Replace saved workspace')!.click())
  expect(document.body.textContent).toContain('Staging was blocked')
  expect(document.body.textContent).toContain('Reopen CryKit to check saved data')
  expect(document.body.textContent).toContain('Choose another backup')
})

it('account restore explains that replacement syncs and requires confirmation', async () => {
  const preview: AccountRestorePreview = { target: 'account', selectedProfileId: 'owned', categories: { planner: 1, editor: 2, save: 0, asset: 0, history: 3 }, privateBytes: 1024, effect: 'replace-selected-profile' }
  const activate = vi.fn(async () => {})
  const restore = { preview: vi.fn(async () => preview), activate, clear: vi.fn(async () => {}) }
  await act(async () => root.render(<Harness complete={noop} native={async () => new Uint8Array()} restore={restore} target="account"/>))
  expect(document.body.textContent).toContain('selected account workspace')
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose complete workspace backup"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([1])], 'account.crykit')] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  expect(document.body.textContent).toContain('Sign in to resume sync after reopening if prompted')
  const button = [...document.querySelectorAll('button')].find(value => value.textContent === 'Replace saved workspace')!
  expect(button.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="Confirm complete workspace replacement"]')!.click())
  await act(async () => button.click())
  expect(activate).toHaveBeenCalledWith(preview)
})
