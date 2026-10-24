import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AdminApp from './AdminApp'
import { AdminClient, AdminRequestError } from './admin-client'
import { AdminActionDialog } from './AdminActionDialog'
import type { AdminCommand, AdminPreview, AdminReceipt } from '../../account/admin-protocol'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})
const observation = { observedAt: 1_800_000_000_000, source: 'application-database', freshness: 'request-read', offlineOutboxes: 'unobserved', providerHeadroom: 'unknown' }
const testCommand = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
const testPreview = { version: 1, target: testCommand.target, expectedRevision: 1, settingsRevision: 1, impact: ['Stop new uploads.'], requiresConfirmation: false, expiresAt: Date.now() + 60_000, commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } satisfies AdminPreview
const testReceipt = { version: 1, actionId: testCommand.actionId, targetRevision: 2, state: 'complete', requestId: 'request-id' } as const
function fakeClient(role: 'owner' | 'administrator' = 'owner') {
  return {
    session: vi.fn().mockResolvedValue({ role, csrf: 'csrf', sessionId: 'session', expiresAt: Date.now() + 60_000, permissions: [] }),
    get: vi.fn(async (path: string) => path === 'overview'
      ? { accounts: 1, counters: { payload_bytes: 7, reserved_metadata: 2, metadata_bytes: 3, metadata_rows: 1 }, settings: { projectCapacityBytes: 10000 }, capacity: { usedBytes: 12, availableBytes: 9988, overCapacity: false }, email: { windowStart: 0, windowEnd: 1, states: [] }, recentFailures: [], oldestUnfinishedJob: null, estimate: true, ...observation }
      : path === 'settings' ? { revision: 1, registrationPaused: false, uploadsPaused: false, sharingPaused: false, emailPaused: false, maxAccountBytes: 1000, projectCapacityBytes: 10000, deploymentCapacity: 10000, ...observation }
      : { items: [], next: null, limit: 50, ...observation }),
    preview: vi.fn(), execute: vi.fn(), lookup: vi.fn(), confirm: vi.fn(),
    onSessionLost: vi.fn(() => () => {}),
  } as unknown as AdminClient
}
it('exposesAnAccessibleWorkspaceAndRoleAwareNavigation', async () => {
  const client = fakeClient('administrator')
  await act(async () => root.render(<AdminApp client={client} environmentLabel="Local synthetic service" />))
  const skip = host.querySelector<HTMLAnchorElement>('a[href="#main"]')
  expect(skip?.textContent).toMatch(/skip to main content/i)
  expect(host.querySelector('main#main')).not.toBeNull()
  const nav = host.querySelector('nav[aria-label="Administration"]')
  expect(nav).not.toBeNull()
  expect(nav?.querySelectorAll('a')).toHaveLength(5)
  expect(nav?.querySelector('a[href="#settings"]')).toBeNull()
  expect(nav?.querySelector('a[href="#overview"]')?.getAttribute('aria-current')).toBe('page')
  expect(host.querySelector('header')?.textContent).toContain('administrator')
  expect(host.querySelector('.admin-workspace')?.classList.contains('admin-workspace--no-nav')).toBe(false)
})
it('announcesPendingSessionInTheMainLandmark', async () => {
  const client = fakeClient()
  vi.mocked(client.session).mockImplementation(() => new Promise(() => {}))
  await act(async () => root.render(<AdminApp client={client} environmentLabel="Local synthetic service" />))
  expect(host.querySelector('main#main [role="status"]')?.textContent).toMatch(/loading.*session/i)
  expect(host.querySelector('.admin-workspace')?.classList.contains('admin-workspace--no-nav')).toBe(true)
})
it('expandsTheWorkspaceWhenSessionFails', async () => {
  const client = fakeClient()
  vi.mocked(client.session).mockRejectedValue(new AdminRequestError('AUTH_REQUIRED', 'session-request'))
  await act(async () => root.render(<AdminApp client={client} environmentLabel="Local synthetic service" />))
  expect(host.querySelector('main#main [role="alert"]')).not.toBeNull()
  expect(host.querySelector('.admin-workspace')?.classList.contains('admin-workspace--no-nav')).toBe(true)
})
it('keepsTheCurrentSectionWhenSkippingToMainContent', async () => {
  window.history.replaceState(null, '', '#accounts')
  await act(async () => root.render(<AdminApp client={fakeClient()} environmentLabel="Local synthetic service" />))
  await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#main"]')!.click())
  expect(window.location.hash).toBe('#accounts')
  expect(document.activeElement).toBe(host.querySelector('main#main'))
  expect(host.querySelector('h1')?.textContent).toBe('Accounts')
})
it('showsEnvironmentTargetAndRealActionOutcome', async () => {
  const client = fakeClient()
  await act(async () => root.render(<AdminApp client={client} environmentLabel="Local synthetic service" />))
  expect(host.textContent).toContain('Local synthetic service')
  expect(host.querySelector('h1')?.textContent).toBe('Overview')
  await act(async () => (host.querySelector('a[href="#accounts"]') as HTMLAnchorElement).click())
  expect(host.querySelector('h1')?.textContent).toBe('Accounts')
  expect(host.textContent).not.toContain('Private build title')
})
it('doesNotNeedCustomerUnlockOrShowPrivateCategories', async () => {
  await act(async () => root.render(<AdminApp client={fakeClient('administrator')} environmentLabel="Local synthetic service" />))
  expect(host.textContent).toContain('Overview')
  expect(host.textContent).not.toContain('Private build title')
  expect(host.textContent).not.toContain('Category count')
  expect(host.querySelector('a[href="#settings"]')).toBeNull()
})
it('stalePreviewRequiresRefresh', async () => {
  const client = fakeClient()
  vi.mocked(client.preview).mockRejectedValue(new AdminRequestError('HEAD_CONFLICT', 'request-id'))
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
  await act(async () => root.render(<AdminActionDialog client={client} command={command} environmentLabel="Local synthetic service" onClose={() => {}} onSubmitted={() => {}} onUncertain={() => {}} onDefinitiveFailure={() => {}} onComplete={() => {}} />))
  expect(host.textContent).toContain('Conflicting changes. Refresh the preview.')
  expect(vi.mocked(client.execute)).not.toHaveBeenCalled()
})
it('showsUncertainEmailWithoutClaimingDelivery', async () => {
  const client = fakeClient()
  vi.mocked(client.preview).mockResolvedValue({ version: 1, target: { kind: 'account', id: 'BBBBBBBBBBBBBBBBBBBBBB' }, expectedRevision: 1, settingsRevision: 1, impact: ['Queue mail to stored recipient.'], requiresConfirmation: false, expiresAt: Date.now() + 60_000, commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } satisfies AdminPreview)
  vi.mocked(client.execute).mockResolvedValue({ version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', targetRevision: 2, state: 'queued', jobId: 'CCCCCCCCCCCCCCCCCCCCCC', requestId: 'request-id' })
  vi.mocked(client.get).mockResolvedValue({ id: 'CCCCCCCCCCCCCCCCCCCCCC', type: 'email', outcome: 'waiting', phase: 'uncertain', attempts: 1, code: 'SEND_UNCERTAIN', ...observation })
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'BBBBBBBBBBBBBBBBBBBBBB' }, reason: 'support', command: { type: 'accounts.verification.resend' } } as AdminCommand
  await act(async () => root.render(<AdminActionDialog client={client} command={command} environmentLabel="Local synthetic service" onClose={() => {}} onSubmitted={() => {}} onUncertain={() => {}} onDefinitiveFailure={() => {}} onComplete={() => {}} />))
  await act(async () => (host.querySelector('button[data-action="apply"]') as HTMLButtonElement).click())
  expect(host.textContent).toContain('Delivery uncertain')
})
it('reconcilesAnUncertainResponseByTheSameActionId', async () => {
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
  const receipt = { version: 1, actionId: command.actionId, targetRevision: 2, state: 'complete', requestId: 'request-id' }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'csrf', sessionId: 'session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json(receipt))
  const client = new AdminClient()
  await client.session()
  await expect(client.execute(command)).resolves.toEqual(receipt)
  expect(fetcher.mock.calls[1][0]).toBe('/api/admin/v1/actions')
  expect(fetcher.mock.calls[2][0]).toBe(`/api/admin/v1/actions/${command.actionId}`)
})
it('keepsAnUnresolvedActionIdForFurtherLookup', async () => {
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'csrf', sessionId: 'session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ error: { code: 'NOT_FOUND', requestId: 'lookup-request' } }, { status: 404 }))
  const client = new AdminClient()
  await client.session()
  await expect(client.execute(command)).rejects.toMatchObject({ code: 'NETWORK_UNCERTAIN', actionId: command.actionId })
})
it('reconcilesAnUnreadableSuccessfulActionResponse', async () => {
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
  const receipt = { version: 1, actionId: command.actionId, targetRevision: 2, state: 'complete', requestId: 'request-id' }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'csrf', sessionId: 'session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockResolvedValueOnce(new Response('{', { status: 200 })).mockResolvedValueOnce(Response.json(receipt))
  const client = new AdminClient()
  await client.session()
  await expect(client.execute(command)).resolves.toEqual(receipt)
  expect(fetcher.mock.calls[2][0]).toBe(`/api/admin/v1/actions/${command.actionId}`)
})
it('reconcilesAnInvalidSuccessfulReceipt', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'csrf', sessionId: 'session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockResolvedValueOnce(Response.json({ ...testReceipt, state: 'invented' })).mockResolvedValueOnce(Response.json(testReceipt))
  const client = new AdminClient()
  await client.session()
  await expect(client.execute(testCommand)).resolves.toEqual(testReceipt)
  expect(fetcher.mock.calls[2][0]).toBe(`/api/admin/v1/actions/${testCommand.actionId}`)
})
it('keepsTheActionIdAndLookupDiagnosticWhenReconciliationIsUnavailable', async () => {
  const command = { version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'csrf', sessionId: 'session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(Response.json({ error: { code: 'SERVICE_UNAVAILABLE', requestId: 'lookup-request' } }, { status: 503 }))
  const client = new AdminClient()
  await client.session()
  await expect(client.execute(command)).rejects.toMatchObject({ code: 'NETWORK_UNCERTAIN', actionId: command.actionId, diagnostic: 'SERVICE_UNAVAILABLE', requestId: 'lookup-request' })
})
it('doesNotInstallAnOldSessionResponseAfterMembershipLossAndNewLogin', async () => {
  let releaseOld!: (response: Response) => void
  const old = new Promise<Response>(resolve => { releaseOld = resolve })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => old).mockResolvedValueOnce(Response.json({ error: { code: 'AUTH_REQUIRED', requestId: 'lost-session' } }, { status: 401 })).mockResolvedValueOnce(Response.json({ csrf: 'new-csrf', sessionId: 'new-session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockResolvedValueOnce(Response.json({ version: 1, commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, expectedRevision: 1, settingsRevision: 1, impact: [], requiresConfirmation: false, expiresAt: Date.now() + 60_000 }))
  const client = new AdminClient()
  const stale = client.session()
  await expect(client.get('overview')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  await client.session()
  releaseOld(Response.json({ csrf: 'old-csrf', sessionId: 'old-session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] }))
  await expect(stale).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  await client.preview({ version: 1, actionId: 'AAAAAAAAAAAAAAAAAAAAAA', expectedRevision: 1, target: { kind: 'account', id: 'AQEBAQEBAQEBAQEBAQEBAQ' }, reason: 'support', command: { type: 'accounts.restrict', policy: 'read-only' } } as AdminCommand)
  expect((fetcher.mock.calls[3][1]?.headers as Record<string, string>)['x-csrf-token']).toBe('new-csrf')
})
it('doesNotClearNewCredentialsForAnOldUnauthorizedResponse', async () => {
  let releaseOld!: (response: Response) => void
  const old = new Promise<Response>(resolve => { releaseOld = resolve })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ csrf: 'old-csrf', sessionId: 'old-session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockImplementationOnce(() => old).mockResolvedValueOnce(Response.json({ csrf: 'new-csrf', sessionId: 'new-session', role: 'owner', expiresAt: Date.now() + 60_000, permissions: [] })).mockResolvedValueOnce(Response.json({ ...testPreview }))
  const client = new AdminClient()
  await client.session()
  const stale = client.get('overview')
  await client.session()
  releaseOld(Response.json({ error: { code: 'AUTH_REQUIRED', requestId: 'old-request' } }, { status: 401 }))
  await expect(stale).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  await client.preview(testCommand)
  expect((fetcher.mock.calls[3][1]?.headers as Record<string, string>)['x-csrf-token']).toBe('new-csrf')
})
function actionableClient() {
  const client = fakeClient()
  const listeners = new Set<() => void>()
  client.onSessionLost = vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  client.get = vi.fn(async (path: string) => path.startsWith('accounts?')
    ? { items: [{ id: testCommand.target.id, email: 'c***@***', username: 'synthetic', access: 'active', capacity_bytes: 1000, created_at: 1 }], next: null, limit: 50, ...observation }
    : path.startsWith('accounts/')
      ? { id: testCommand.target.id, email: 'customer@example.org', username: 'synthetic', access: 'active', revision: 1, capacity_bytes: 1000, verified_at: 1, created_at: 1, storage: null, counts: null, sessions: [], sessionsTruncated: false, ...observation }
      : { items: [], next: null, limit: 50, ...observation }) as AdminClient['get']
  vi.mocked(client.preview).mockResolvedValue(testPreview)
  return { client, loseSession: () => { for (const listener of [...listeners]) listener() } }
}
async function openAccountAction(client: AdminClient) {
  window.history.replaceState(null, '', '#accounts')
  await act(async () => root.render(<AdminApp client={client} environmentLabel="Local synthetic service" />))
  const inspect = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Inspect account'))!
  await act(async () => inspect.click())
  const policy = Array.from(host.querySelectorAll('select')).find(select => select.parentElement?.textContent?.includes('Cloud access'))!
  await act(async () => { policy.value = 'read-only'; policy.dispatchEvent(new Event('change', { bubbles: true })) })
  const preview = Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Preview access change')!
  await act(async () => preview.click())
}
it('hidingAnInFlightActionRetainsItsIdUntilReceipt', async () => {
  const { client } = actionableClient()
  let release!: (receipt: AdminReceipt) => void
  vi.mocked(client.execute).mockImplementation(() => new Promise(resolve => { release = resolve }))
  await openAccountAction(client)
  await act(async () => (host.querySelector('button[data-action="apply"]') as HTMLButtonElement).click())
  const actionId = vi.mocked(client.execute).mock.calls[0][0].actionId
  expect(host.textContent).toContain('Hide status')
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Hide status')!.click())
  expect(host.textContent).toContain(`Action ${actionId}`)
  expect(host.textContent).toContain('does not cancel the server action')
  await act(async () => release({ ...testReceipt, actionId }))
  expect(host.textContent).not.toContain('does not cancel the server action')
  expect(host.textContent).toContain('accepted: complete')
})
it('escapeAfterAnUnresolvedLookupRetainsTheExactActionId', async () => {
  const { client } = actionableClient()
  vi.mocked(client.execute).mockImplementation(command => Promise.reject(new AdminRequestError('NETWORK_UNCERTAIN', undefined, command.actionId, 'SERVICE_UNAVAILABLE')))
  vi.mocked(client.lookup).mockRejectedValue(new AdminRequestError('NOT_FOUND', 'lookup-request'))
  await openAccountAction(client)
  await act(async () => (host.querySelector('button[data-action="apply"]') as HTMLButtonElement).click())
  const actionId = vi.mocked(client.execute).mock.calls[0][0].actionId
  await act(async () => Array.from(host.querySelector('[role="dialog"]')!.querySelectorAll('button')).find(button => button.textContent === 'Check action status')!.click())
  expect(vi.mocked(client.lookup)).toHaveBeenCalledWith(actionId)
  await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.textContent).toContain(`Action ${actionId}`)
  expect(host.textContent).toContain('Check action status')
})
it('membershipLossDuringASubmittedActionRetainsTheLookupPath', async () => {
  const { client, loseSession } = actionableClient()
  vi.mocked(client.execute).mockImplementation(() => new Promise(() => {}))
  await openAccountAction(client)
  await act(async () => (host.querySelector('button[data-action="apply"]') as HTMLButtonElement).click())
  const actionId = vi.mocked(client.execute).mock.calls[0][0].actionId
  await act(async () => loseSession())
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.textContent).toContain(`Action ${actionId}`)
  expect(host.textContent).toContain('Sign in again to check its receipt')
  vi.mocked(client.lookup).mockResolvedValue({ ...testReceipt, actionId })
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Retry session')!.click())
  await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Check action status')!.click())
  expect(vi.mocked(client.lookup)).toHaveBeenCalledWith(actionId)
  expect(host.textContent).not.toContain('Sign in again to check its receipt')
})
