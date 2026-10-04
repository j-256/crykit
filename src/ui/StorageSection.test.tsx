// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain'
import type { OfflineStatus } from '../offline'
import { NavigationProvider, useNavigationController } from './navigation'
import { StorageSection } from './StorageSection'

const refresh = vi.hoisted(() => vi.fn(async () => undefined))

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
  return <NavigationProvider controller={navigation}><StorageSection {...props}/></NavigationProvider>
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubEnv('DEV', true)
  window.history.replaceState(null, '', '#/reference')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
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
})
