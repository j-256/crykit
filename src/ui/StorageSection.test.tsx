// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain'
import type { OfflineStatus } from '../offline'
import { NavigationProvider, useNavigationController } from './navigation'
import { APP_REFRESH_PENDING_MESSAGE, StorageSection } from './StorageSection'

const refresh = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined))

vi.mock('../offline', () => ({
  activateOfflineUpdate: vi.fn(),
  getOfflineStatus: vi.fn(async () => ({ state: 'unsupported' })),
  refreshOfflineApplication: refresh,
  requestOfflineReadiness: vi.fn(),
  requestPersistentStorage: vi.fn(),
  subscribeOfflineStatus: (listener: (status: OfflineStatus) => void) => {
    listener({ state: 'unsupported', detail: 'This browser does not support offline installation.' })
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
