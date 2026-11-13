import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountView } from './AccountView'
import { SignInForm } from './SignInForm'
import * as device from '../../account/device-store'
import * as lifecycle from '../../account/lifecycle'
import * as profile from '../../account/profile'
import * as credentials from '../../account/credential-workflow'
import * as storage from '../../account/storage'
import type { WorkspaceRepository } from '../../workspace/repository'

vi.mock('../../account/device-store', () => ({ listCachedProfiles: vi.fn(async () => []) }))
let container: HTMLDivElement
let root: Root
const readiness = (accountsAvailable: boolean, signupAvailable = accountsAvailable) => Response.json({ version: 1, accountsAvailable, signupAvailable, supportedWireVersions: [1] })
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(readiness(false))
  vi.mocked(device.listCachedProfiles).mockResolvedValue([])
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  profile.invalidateProfile()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const render = async () => { await act(async () => root.render(<AccountView onOpenWorkspace={async () => {}} onContinueLocal={async () => {}}/>)) }
const button = (name: string) => [...container.querySelectorAll('button')].find(button => button.textContent === name)

it('hides online account forms when accounts are closed while preserving local continuation and terms', async () => {
  await render()
  expect(container.textContent).toContain('Online accounts are unavailable')
  expect(container.querySelector('form')).toBeNull()
  expect(button('Create account')).toBeUndefined()
  expect(button('Request approval')).toBeUndefined()
  expect(button('Continue using this device')).toBeDefined()
  expect(container.querySelector('a[href$="privacy/"]')).not.toBeNull()
  expect(fetch).toHaveBeenCalledWith('/api/v1/service', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }))
})

it('does not flash online forms while readiness is pending', async () => {
  vi.mocked(fetch).mockReturnValue(new Promise(() => {}))
  await render()
  expect(container.textContent).toContain('Checking account availability')
  expect(container.querySelector('form')).toBeNull()
  expect(button('Continue using this device')?.disabled).toBe(false)
})

it('allows existing sign-in without offering registration when signup is paused', async () => {
  vi.mocked(fetch).mockResolvedValue(readiness(true, false))
  await render()
  expect(container.querySelector('input[aria-label="Email"]')).not.toBeNull()
  expect(button('Sign in')).toBeDefined()
  expect(button('Create account')).toBeUndefined()
  expect(container.textContent).toContain('New account registration is unavailable')
})

it('offers registration when both service gates are open', async () => {
  vi.mocked(fetch).mockResolvedValue(readiness(true))
  await render()
  await act(async () => button('Create account')!.click())
  expect(container.querySelector('input[aria-label="Public screen name"]')).not.toBeNull()
})

it('returns an open signup form to sign-in when registration closes', async () => {
  const submit = vi.fn(async () => {})
  await act(async () => root.render(<SignInForm busy={false} signupAvailable={true} onSubmit={submit}/>))
  await act(async () => button('Create account')!.click())
  await act(async () => root.render(<SignInForm busy={false} signupAvailable={false} onSubmit={submit}/>))
  expect(container.querySelector('input[aria-label="Public screen name"]')).toBeNull()
  expect(button('Create account and send email')).toBeUndefined()
  expect(button('Sign in')).toBeDefined()
})

it.each(['network', 'http', 'invalid'] as const)('keeps online forms closed after a %s readiness failure and permits retry', async kind => {
  if (kind === 'network') vi.mocked(fetch).mockRejectedValue(new TypeError('offline'))
  else vi.mocked(fetch).mockResolvedValue(kind === 'http' ? new Response('unavailable', { status: 503 }) : Response.json({ accountsAvailable: true }))
  await render()
  expect(container.textContent).toContain('Account availability could not be checked')
  expect(container.querySelector('form')).toBeNull()
  vi.mocked(fetch).mockResolvedValue(readiness(true))
  await act(async () => button('Check account availability')!.click())
  expect(button('Sign in')).toBeDefined()
  expect(button('Create account')).toBeDefined()
})

it('can recheck a closed service without reloading the application', async () => {
  await render()
  vi.mocked(fetch).mockResolvedValue(readiness(true))
  await act(async () => button('Check account availability')!.click())
  expect(button('Sign in')).toBeDefined()
})

it('preserves cached local unlocking while the service is closed', async () => {
  const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
  vi.mocked(device.listCachedProfiles).mockResolvedValue([{ accountId, remembered: true, passwordAvailable: true, revocationPending: false }])
  const unlock = vi.spyOn(lifecycle, 'unlockRememberedProfile').mockImplementation(async () => profile.installProfile(accountId, new Uint8Array(32)))
  await render()
  expect(container.querySelector('input[aria-label="Local password"]')).not.toBeNull()
  await act(async () => button('Unlock remembered account')!.click())
  expect(unlock).toHaveBeenCalledWith(accountId)
  expect(button('Open account workspace')).toBeDefined()
  expect(button('Reconnect')).toBeUndefined()
  expect(button('Sign in')).toBeUndefined()
})

it('keeps an already-generated recovery code downloadable when online accounts are closed', async () => {
  profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 })
  const workflow = { busy: false, repair: false, recoveryDisplay: 'synthetic recovery code' }
  vi.spyOn(credentials, 'credentialWorkflow').mockReturnValue(workflow)
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:synthetic')
    static revokeObjectURL = vi.fn()
  })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await render()
  expect(container.textContent).toContain('synthetic recovery code')
  expect(button('Download recovery code')?.disabled).toBe(false)
  await act(async () => button('Download recovery code')!.click())
  expect(download).toHaveBeenCalledOnce()
  expect(button('Hide recovery code')).toBeDefined()
  expect(button('Use recovery code')).toBeUndefined()
})

it('keeps local account storage actions while excluding cloud requests under closed readiness', async () => {
  profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  const remote = vi.fn(async () => { throw new Error('Cloud storage is closed') })
  const backup = vi.fn(async () => {})
  const prepareRemoval = vi.fn(async () => ({ pendingWork: false, remove: async () => {} }))
  const api: storage.StorageService = { local: async () => ({ observedAt: 1, pendingWork: false, categories: [], contentBytes: 0 }), remote, recovery: remote, backup, prepareRemoval, scanCleanup: vi.fn(async () => ({ candidates: [], unavailable: false })) }
  vi.spyOn(storage, 'createStorageService').mockReturnValue(api)
  await act(async () => root.render(<AccountView repository={{ kind: 'account' } as WorkspaceRepository} onOpenWorkspace={async () => {}} onContinueLocal={async () => {}} onBackup={backup}/>))
  await act(async () => button('Refresh storage')!.click())
  expect(remote).not.toHaveBeenCalled()
  expect(button('Find unused sync data')).toBeUndefined()
  await act(async () => button('Account backup')!.click())
  expect(backup).toHaveBeenCalledOnce()
  await act(async () => button('Remove saved account from this device')!.click())
  expect(prepareRemoval).toHaveBeenCalledOnce()
})

it('bounds a stalled readiness request and aborts it on unmount', async () => {
  vi.useFakeTimers()
  vi.mocked(fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
  await render()
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  expect(signal.aborted).toBe(true)
  expect(container.textContent).toContain('Account availability could not be checked')
  await act(async () => button('Check account availability')!.click())
  const retried = vi.mocked(fetch).mock.calls[1][1]!.signal!
  await act(async () => root.render(null))
  expect(retried.aborted).toBe(true)
})

it('does not reopen accounts after a timed-out request returns stale success', async () => {
  vi.useFakeTimers()
  let resolve!: (response: Response) => void
  vi.mocked(fetch).mockReturnValueOnce(new Promise(done => { resolve = done }))
  await render()
  await act(async () => vi.advanceTimersByTimeAsync(10_000))
  await act(async () => button('Check account availability')!.click())
  await act(async () => resolve(readiness(true)))
  expect(container.textContent).toContain('Online accounts are unavailable')
  expect(button('Sign in')).toBeUndefined()
})
