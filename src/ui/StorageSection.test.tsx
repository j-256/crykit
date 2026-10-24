// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain'
import type { OfflineStatus } from '../offline'
import { NavigationProvider, useNavigationController } from './navigation'
import { APP_REFRESH_PENDING_MESSAGE, StorageSection } from './StorageSection'

const refresh = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined))
const offlineState = vi.hoisted(() => ({
  value: { state: 'unsupported', detail: 'This browser does not support offline installation.' } as OfflineStatus,
  prepare: vi.fn(),
  listener: undefined as ((status: OfflineStatus) => void) | undefined,
}))

vi.mock('../offline', () => ({
  activateOfflineUpdate: vi.fn(),
  getOfflineStatus: vi.fn(async () => offlineState.value),
  refreshOfflineApplication: refresh,
  requestOfflineReadiness: offlineState.prepare,
  requestPersistentStorage: vi.fn(),
  subscribeOfflineStatus: (listener: (status: OfflineStatus) => void) => {
    offlineState.listener = listener
    listener(offlineState.value)
    return () => undefined
  },
}))

type Props = Parameters<typeof StorageSection>[0]

function Harness(props: Props) {
  const navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><StorageSection {...props}/><button onClick={() => navigation.navigate({ page: { page: 'inventory', view: 'list' }, overlays: [], query: {} })}>Leave storage</button></NavigationProvider>
}

let container: HTMLDivElement
let root: Root
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const scrollIntoView = vi.fn()

beforeEach(() => {
  offlineState.value = { state: 'unsupported', detail: 'This browser does not support offline installation.' }
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubEnv('DEV', true)
  window.history.replaceState(null, '', '#/reference')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

async function render(props: Partial<Props> = {}) {
  await act(async () => root.render(<Harness localData={createBlankLocalData()} dirty={false} saving={false} onExport={async () => new Uint8Array()} onReloadingChange={() => undefined} {...props}/>))
  return [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh app')!
}

it('keeps core included and submits only the optional downloads chosen by the user', async () => {
  offlineState.value = { state: 'not-ready', contents: [
    { id: 'core', files: 10, bytes: 2_000_000, ready: false, selected: true },
    { id: 'maps', files: 20, bytes: 3_000_000, ready: false, selected: false },
  ] }
  await render()
  const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(checkboxes).toHaveLength(3)
  expect(checkboxes.every(checkbox => !checkbox.checked)).toBe(true)
  expect(container.textContent).toContain('Core app included')
  expect(container.textContent).toContain('3.0 MB')
  const maps = container.querySelector<HTMLInputElement>('input[aria-label="Maps"]')!
  await act(async () => maps.click())
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Prepare for offline use')!
  await act(async () => button.click())
  expect(offlineState.prepare).toHaveBeenCalledWith(['maps'])
})

it('shows actual completed-file progress and preserves downloaded-extra choices', async () => {
  offlineState.value = { state: 'ready', selectionKnown: true, contents: [
    { id: 'core', files: 10, bytes: 2_000_000, ready: true, selected: true },
    { id: 'maps', files: 20, bytes: 3_000_000, ready: true, selected: true },
  ] }
  await render()
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Maps"]')?.checked).toBe(true)
  await act(async () => offlineState.listener?.({ state: 'checking', progress: { completedFiles: 7, totalFiles: 20, completedBytes: 100, totalBytes: 300 } }))
  const progress = container.querySelector('progress')!
  expect(progress.value).toBe(7)
  expect(progress.max).toBe(20)
  expect(container.textContent).toContain('7 of 20 files')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh app')!.disabled).toBe(true)
})

describe('development preview refresh controls', () => {
  it('allows a clean preview to reload when offline installation is unsupported', async () => {
    const onReloadingChange = vi.fn()
    const button = await render({ onReloadingChange })
    expect(button.disabled).toBe(false)
    expect(container.textContent).toContain('Reload this tab to load the latest preview.')
    expect(container.textContent).not.toContain('Refresh the app files')

    await act(async () => button.click())

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onReloadingChange.mock.calls).toEqual([[true], [false]])
  })

  it.each<Partial<Props>>([{ dirty: true }, { saving: true }, { saveError: 'Synthetic retained save failure' }])('blocks reload while a save guard is active: %j', async props => {
    const button = await render(props)
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('Save or discard changes and resolve any failed save before refreshing.')

    await act(async () => button.click())

    expect(refresh).not.toHaveBeenCalled()
  })

  it('retains the production cache-refresh support requirement and copy', async () => {
    vi.stubEnv('DEV', false)
    const button = await render()

    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('Refresh the app files and reload this tab.')
    expect(container.textContent).toContain('A connection is required.')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reveals repeated blocked navigation without abandoning or completing a pending refresh', async () => {
    let completeRefresh!: () => void
    const pendingRefresh = new Promise<void>(resolve => { completeRefresh = resolve })
    refresh.mockImplementationOnce(() => pendingRefresh)
    const onReloadingChange = vi.fn()
    const refreshButton = await render({ onReloadingChange })
    const leaveButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'Leave storage')!
    const originalHash = window.location.hash

    await act(async () => refreshButton.click())
    expect(onReloadingChange.mock.calls).toEqual([[true]])
    for (let attempt = 0; attempt < 2; attempt += 1) {
      leaveButton.focus()
      await act(async () => leaveButton.click())
      const notice = container.querySelector<HTMLDivElement>('[aria-label="Storage navigation warning"]')!
      expect(document.activeElement).toBe(notice)
      expect(notice.textContent).toContain('App refresh is still in progress')
      expect(notice.textContent).toContain(APP_REFRESH_PENDING_MESSAGE)
      expect(notice.textContent).not.toContain('Storage operation failed')
      expect(window.location.hash).toBe(originalHash)
      expect(onReloadingChange.mock.calls).toEqual([[true]])
      expect(refresh).toHaveBeenCalledTimes(1)
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(2)

    await act(async () => { completeRefresh(); await pendingRefresh })
    expect(onReloadingChange.mock.calls).toEqual([[true], [false]])
    expect(window.location.hash).toBe(originalHash)
    await act(async () => leaveButton.click())
    expect(window.location.hash).not.toBe(originalHash)
  })
})

it('downloadsCompleteWorkspaceAndSurfacesCaptureFailure', async () => {
  const onExportWorkspace = vi.fn(async () => { throw new Error('Open form could not be saved') })
  await render({ onExportWorkspace })
  expect(container.textContent).toContain('private files')
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Export backup')!
  await act(async () => button.click())
  expect(onExportWorkspace).toHaveBeenCalledOnce()
  expect(container.textContent).toContain('Open form could not be saved')
})
