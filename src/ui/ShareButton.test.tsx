// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, setProfileSession, type ProfileToken } from '../account/profile'
import { addTestBuild, createTestLocalData } from '../domain/test-helpers'
import { ShareButton } from './ShareButton'

let token: ProfileToken
const repository = { kind: 'account' }
vi.mock('./WorkspaceProvider', () => ({ useOptionalWorkspace: () => ({ token, repository }) }))
vi.mock('./definitions', () => ({ useDefinitionLibrary: () => ({ catalogs: [] }) }))
vi.mock('./Sheet', () => ({ Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }))

const accountId = 'AAAAAAAAAAAAAAAAAAAAAA', sessionId = 'BBBBBBBBBBBBBBBBBBBBBA'
const session = { accountId, username: 'person', sessionId, deviceId: 'CCCCCCCCCCCCCCCCCCCCCA', csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authenticatedAt: 0 }
const recovery = 'Account connection changed. Close and reopen sharing to continue.'
const paginationError = 'More links could not be loaded.'
let root: Root, container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  token = installProfile(accountId, new Uint8Array(32), session)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile(); vi.unstubAllGlobals() })

async function startPagination() {
  let reject!: (reason: Error) => void
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url === '/api/v1/shares') return Response.json({ shares: [{ shareId: accountId, revision: 1, active: true, url: `https://example.test/#/s/${accountId}`, title: 'Published build', kind: 'build', state: 'active', includeAttribution: false }], next: accountId })
    expect(url).toBe(`/api/v1/shares?after=${accountId}`)
    signal = options.signal as AbortSignal
    // Keep settlement under test control after cancellation to exercise the originating UI catch
    return new Promise<Response>((_, fail) => { reject = fail })
  }))
  const localData = addTestBuild(createTestLocalData(), 'pagination-build', '', {})
  const revisionId = localData.buildRevisions['pagination-build-revision']!.id
  await act(async () => root.render(<ShareButton localData={localData} target={{ kind: 'build', revisionId }}/>))
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Share build')!.click() })
  const dialog = container.querySelector('[role="dialog"]')!
  const more = [...container.querySelectorAll('button')].find(button => button.textContent === 'Load more links')
  expect(more).toBeDefined()
  await act(async () => { more!.click() })
  expect(signal.aborted).toBe(false)
  return { dialog, signal, reject }
}

it.each(['renewed', 'disconnected'])('preserves session recovery after an old pagination request rejects with the session %s', async change => {
  const pending = await startPagination()
  await act(async () => { setProfileSession(token, change === 'renewed' ? { ...session, sessionId: session.deviceId } : undefined) })
  expect(pending.signal.aborted).toBe(true)
  expect(container.textContent).toContain(recovery)
  await act(async () => { pending.reject(new Error('Synthetic old request failure')) })
  expect(container.querySelector('[role="dialog"]')).toBe(pending.dialog)
  expect(container.textContent).toContain(recovery)
  expect(container.textContent).not.toContain(paginationError)
})

it('shows pagination failures while the originating session remains live', async () => {
  const pending = await startPagination()
  await act(async () => { pending.reject(new Error('Synthetic live request failure')) })
  expect(pending.signal.aborted).toBe(false)
  expect(container.textContent).toContain(paginationError)
  expect(container.textContent).not.toContain(recovery)
})
