import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AdminApp from './AdminApp'
import AdminSettings from './AdminSettings'
import { CapacityMeter } from './admin-components'
import { AdminHelp, statusTone } from './admin-help'
import type { AdminClient } from './admin-client'

const idA = 'AQEBAQEBAQEBAQEBAQEBAQ'
const idB = 'AgICAgICAgICAgICAgICAg'
const observation = {
  observedAt: 1_800_000_000_000,
  source: 'application-database',
  freshness: 'request-read',
  offlineOutboxes: 'unobserved',
  providerHeadroom: 'unknown',
}
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

function client(get: (path: string) => Promise<unknown>) {
  return {
    session: vi.fn().mockResolvedValue({
      role: 'owner',
      csrf: 'csrf',
      sessionId: 'session',
      expiresAt: Date.now() + 60_000,
      permissions: [],
    }),
    get: vi.fn(get),
    onSessionLost: vi.fn(() => () => {}),
    preview: vi.fn(),
    execute: vi.fn(),
    lookup: vi.fn(),
    confirm: vi.fn(),
  } as unknown as AdminClient
}
function settings() {
  return {
    revision: 7,
    registrationPaused: false,
    uploadsPaused: false,
    sharingPaused: false,
    emailPaused: false,
    maxAccountBytes: 1,
    projectCapacityBytes: 1024,
    deploymentCapacity: 2048,
    ...observation,
  }
}
function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  )
  expect(button).toBeDefined()
  button!.click()
}
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('opens contextual help on focus and tap, then dismisses it with Escape or outside input', async () => {
  await act(async () => root.render(<AdminHelp label="Reserved metadata" text="Already counted toward capacity" />))
  const button = host.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toBe('Reserved metadata')
  expect(button.getAttribute('aria-label')).toBeNull()
  expect(host.textContent).not.toContain('?')
  await act(async () => button.focus())
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Already counted')
  expect(button.getAttribute('aria-describedby')).toBeTruthy()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => button.click())
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  await act(async () => { button.focus(); button.click() })
  expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')).toBeNull()
})

it('marks completed, waiting and blocking states with matching semantic tones', () => {
  expect(statusTone('Running')).toBe('good')
  expect(statusTone('Transport accepted, delivery unconfirmed')).toBe('warning')
  expect(statusTone('Delivery uncertain')).toBe('warning')
  expect(statusTone('Failed')).toBe('danger')
})

it('returns cancelled action focus to its invoking button when pointer activation leaves an input focused', async () => {
  window.history.replaceState(null, '', '#settings')
  const api = client(async () => settings())
  vi.mocked(api.preview).mockResolvedValue({
    version: 1,
    target: { kind: 'service', id: 'service' },
    expectedRevision: 7,
    settingsRevision: 7,
    impact: ['Pause registration'],
    requiresConfirmation: true,
    expiresAt: Date.now() + 60_000,
    commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  await act(async () => root.render(<AdminApp client={api} />))
  const quota = host.querySelector<HTMLInputElement>('.admin-byte-input input')!
  const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Pause registration')!
  await act(async () => quota.focus())
  await act(async () => trigger.click())
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(api.execute).not.toHaveBeenCalled()
})

it('reviews a single service control without changing it or discarding a capacity draft', async () => {
  let resolveRead!: (value: unknown) => void
  let reads = 0
  const openAction = vi.fn()
  const api = client(async () => {
    reads++
    if (reads === 1) return settings()
    if (reads === 2)
      return new Promise((resolve) => {
        resolveRead = resolve
      })
    return { ...settings(), registrationPaused: true, revision: 9 }
  })
  const view = (refreshKey: number) => (
    <AdminSettings client={api} openAction={openAction} refreshKey={refreshKey} />
  )
  await act(async () => root.render(view(0)))
  const quota = host.querySelector<HTMLInputElement>('.admin-byte-input input')!
  expect(quota.labels?.[0]?.textContent).toBe('Maximum account quota')
  expect(host.querySelector<HTMLSelectElement>('.admin-byte-input select')?.getAttribute('aria-label')).toBe('Maximum account quota unit')
  expect(host.querySelector('.admin-byte-control .admin-help-trigger')?.textContent).toBe('Maximum account quota')
  await act(async () => type(quota, '0.000002.'))
  expect(quota.value).toBe('0.000002.')
  await act(async () => click('Pause registration'))
  expect(openAction).toHaveBeenCalledWith(
    host.querySelector('.admin-switch button'),
    { kind: 'service', id: 'service' }, 7,
    { type: 'service.settings', patch: { registrationPaused: true } }, 'maintenance',
  )
  expect(host.textContent).toContain('Running')
  expect(quota.value).toBe('0.000002.')
  await act(async () => root.render(view(1)))
  expect(host.querySelector<HTMLButtonElement>('.admin-switch button')?.disabled).toBe(true)
  expect(host.querySelector<HTMLInputElement>('.admin-byte-input input')?.disabled).toBe(true)
  expect(host.querySelector<HTMLSelectElement>('.admin-byte-input select')?.disabled).toBe(true)
  await act(async () => resolveRead({ ...settings(), emailPaused: true, revision: 8 }))
  expect(quota.value).toBe('0.000002.')
  expect(host.textContent).toContain('Observed revision 8')
  expect(host.querySelector('.admin-settings-review')?.textContent).toContain('Maximum account quota:')
  await act(async () => root.render(view(2)))
  expect(quota.value).toBe('0.000002.')
  expect(host.querySelector('.admin-switch')?.textContent).toContain('Paused')
  expect(host.textContent).toContain('Observed revision 9')
  await act(async () => click('Reset draft'))
  expect(quota.value).not.toBe('0.000002.')
})

it('renders zero-quota over-capacity state distinctly from unknown and ordinary usage', async () => {
  await act(async () => root.render(<CapacityMeter label="Storage" used={1} limit={0} />))
  expect(host.textContent).toContain('percentage unavailable; over capacity')
  expect(host.querySelector<HTMLElement>('.admin-meter span')?.style.width).toBe('100%')
  await act(async () => root.render(<CapacityMeter label="Storage" used={null} limit={0} />))
  expect(host.textContent).toContain('Storage: unavailable')
  expect(host.querySelector<HTMLElement>('.admin-meter span')?.style.width).toBe('0%')
  await act(async () => root.render(<CapacityMeter label="Storage" used={25} limit={100} />))
  expect(host.textContent).toContain('(25.0%)')
  expect(host.querySelector<HTMLElement>('.admin-meter span')?.style.width).toBe('25%')
})

it('shows current detail failure and ignores a rejected stale detail request', async () => {
  window.history.replaceState(null, '', '#accounts')
  let rejectOlder!: (reason: unknown) => void
  let secondFails = true
  const api = client(async (path) => {
    if (path.startsWith('accounts?')) {
      return {
        items: [idA, idB].map((id) => ({
          id,
          email: 'm***@***',
          username: 'synthetic',
          access: 'active',
          capacity_bytes: 100,
          created_at: 1,
        })),
        next: null,
        limit: 50,
        ...observation,
      }
    }
    if (path === `accounts/${idA}`)
      return new Promise((_, reject) => {
        rejectOlder = reject
      })
    if (secondFails) throw new Error('detail unavailable')
    return {
      id: idB,
      email: 'second@example.org',
      username: 'second',
      access: 'active',
      revision: 1,
      capacity_bytes: 100,
      created_at: 1,
      verified_at: 1,
      storage: null,
      counts: null,
      sessions: [],
      sessionsTruncated: false,
      ...observation,
    }
  })
  await act(async () => root.render(<AdminApp client={api} />))
  await act(async () => click(idB))
  expect(host.querySelector('[role="alert"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Account detail"]')).toBeNull()
  await act(async () => click(idA))
  secondFails = false
  await act(async () => click(idB))
  await act(async () => rejectOlder(new Error('old detail unavailable')))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('[aria-label="Account detail"]')?.textContent).toContain(
    'second@example.org',
  )
  const reservedLabel = Array.from(host.querySelectorAll('.admin-detail .admin-help-trigger')).find(
    (item) => item.textContent === 'Reserved metadata',
  )
  expect(reservedLabel).toBeDefined()
  await act(async () => reservedLabel!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('already counts toward capacity')
  const quota = host.querySelector('.admin-detail .admin-capacity')!
  expect(quota.textContent?.match(/Account quota/g)).toHaveLength(1)
  const quotaInput = host.querySelector<HTMLInputElement>('.admin-detail input[inputmode="decimal"]')!
  await act(async () => type(quotaInput, '0.1'))
  expect(quotaInput.value).toBe('0.1')
  expect(host.textContent).toContain('Rounded up to 1 byte.')
  expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.admin-detail button')).find((button) => button.textContent === 'Preview quota')?.disabled).toBe(false)
})

it('keeps unit-only changes clean and requires explicit discard before refreshing a dirty draft', async () => {
  window.history.replaceState(null, '', '#settings')
  const api = client(async (path) =>
    path === 'settings' ? settings() : { items: [], next: null, limit: 50, ...observation },
  )
  await act(async () => root.render(<AdminApp client={api} />))
  const units = host.querySelectorAll<HTMLSelectElement>('.admin-byte-input select')
  await act(async () => {
    units[0].value = 'GiB'
    units[0].dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    (
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Preview settings change',
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true)
  await act(async () => { units[0].value = 'Bytes'; units[0].dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => type(host.querySelector<HTMLInputElement>('.admin-byte-input input')!, '2'))
  expect(host.textContent).toContain('Discard draft and refresh')
  expect(
    (
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Preview settings change',
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(false)
  vi.mocked(api.preview).mockResolvedValue({
    version: 1,
    target: { kind: 'service', id: 'service' },
    expectedRevision: 7,
    settingsRevision: 7,
    impact: ['Pause registration'],
    requiresConfirmation: true,
    expiresAt: Date.now() + 60_000,
    commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  await act(async () => click('Preview settings change'))
  await act(async () => click('Cancel'))
  expect(host.textContent).toContain('Discard draft and refresh')
  await act(async () => click('Discard draft and refresh'))
  expect(host.textContent).toContain('No changes to preview')
  expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === 'settings')).toHaveLength(2)
})

it('keeps decimal typing stable and shows upward byte rounding separately from range errors', async () => {
  const api = client(async () => ({ ...settings(), maxAccountBytes: 1024, projectCapacityBytes: 4096, deploymentCapacity: 8192 }))
  const openAction = vi.fn()
  await act(async () => root.render(<AdminSettings client={api} openAction={openAction} />))
  const input = host.querySelector<HTMLInputElement>('.admin-byte-input input')!
  const unit = host.querySelector<HTMLSelectElement>('.admin-byte-input select')!
  await act(async () => { unit.value = 'KiB'; unit.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => type(input, '2.'))
  expect(input.value).toBe('2.')
  await act(async () => type(input, '2.5'))
  expect(input.value).toBe('2.5')
  expect(input.getAttribute('aria-invalid')).toBe('false')
  await act(async () => type(input, '2.6'))
  expect(input.value).toBe('2.6')
  expect(input.getAttribute('aria-invalid')).toBe('false')
  expect(host.textContent).toContain('2,663 bytes')
  expect(host.textContent).toContain('Rounded up')
  await act(async () => click('Preview settings change'))
  expect(openAction).toHaveBeenCalledWith(
    host.querySelector('.admin-settings-review .admin-actions button'),
    { kind: 'service', id: 'service' }, 7,
    { type: 'service.settings', patch: { maxAccountBytes: 2663 } }, 'maintenance',
  )
  await act(async () => type(input, '9'))
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(host.textContent).toContain('deployment capacity')
  await act(async () => { unit.value = 'Bytes'; unit.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => type(input, '0.1'))
  expect(input.value).toBe('0.1')
  expect(input.getAttribute('aria-invalid')).toBe('false')
  expect(host.textContent).toContain('Draft: 1 byte')
})

it('refreshes unchanged numeric drafts from a new observation while preserving unit conversion of dirty bytes', async () => {
  let observed = settings()
  const api = client(async () => observed)
  const view = (key: number) => <AdminSettings client={api} openAction={vi.fn()} refreshKey={key} />
  await act(async () => root.render(view(0)))
  const input = host.querySelector<HTMLInputElement>('.admin-byte-input input')!
  const unit = host.querySelector<HTMLSelectElement>('.admin-byte-input select')!
  await act(async () => { unit.value = 'Bytes'; unit.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => type(input, '1.'))
  expect(input.value).toBe('1.')
  observed = { ...observed, maxAccountBytes: 2, revision: 8 }
  await act(async () => root.render(view(1)))
  expect(input.value).toBe('2')
  await act(async () => type(input, '3'))
  await act(async () => { unit.value = 'KiB'; unit.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(input.value).toBe('0.0029296875')
  observed = { ...observed, emailPaused: true, revision: 9 }
  await act(async () => root.render(view(2)))
  expect(input.value).toBe('0.0029296875')
  expect(host.querySelector('.admin-settings-review')?.textContent).toContain('Maximum account quota:')
})

it('ignores an older detail response after selecting a different account', async () => {
  window.history.replaceState(null, '', '#accounts')
  let release!: (value: unknown) => void
  const api = client(async (path) =>
    path.startsWith('accounts?')
      ? {
          items: [idA, idB].map((id) => ({
            id,
            email: 'm***@***',
            username: 'synthetic',
            access: 'active',
            capacity_bytes: 100,
            created_at: 1,
          })),
          next: null,
          limit: 50,
          ...observation,
        }
      : path === `accounts/${idA}`
        ? new Promise((resolve) => {
            release = resolve
          })
        : {
            id: idB,
            email: 'second@example.org',
            username: 'second',
            access: 'active',
            revision: 1,
            capacity_bytes: 100,
            created_at: 1,
            verified_at: 1,
            storage: null,
            counts: null,
            sessions: [],
            sessionsTruncated: false,
            ...observation,
          },
  )
  await act(async () => root.render(<AdminApp client={api} />))
  await act(async () => click(idA))
  await act(async () => click(idB))
  await act(async () =>
    release({
      id: idA,
      email: 'first@example.org',
      username: 'first',
      access: 'active',
      revision: 1,
      capacity_bytes: 100,
      created_at: 1,
      verified_at: 1,
      storage: null,
      counts: null,
      sessions: [],
      sessionsTruncated: false,
      ...observation,
    }),
  )
  expect(host.querySelector('[aria-label="Account detail"]')?.textContent).toContain(
    'second@example.org',
  )
  expect(host.querySelector('[aria-label="Account detail"]')?.textContent).not.toContain(
    'first@example.org',
  )
})

it('rejects an invalid deep link before any detail request', async () => {
  window.history.replaceState(null, '', '#accounts?accountId=..%2Fsettings')
  const api = client(async () => ({
    items: [],
    next: null,
    limit: 50,
    ...observation,
  }))
  await act(async () => root.render(<AdminApp client={api} />))
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('accounts/'))).toBe(false)
})

it('loads a valid account deep link without searching for it first', async () => {
  window.history.replaceState(null, '', `#accounts?accountId=${idA}`)
  const api = client(async (path) =>
    path === `accounts/${idA}`
      ? {
          id: idA,
          email: 'linked@example.org',
          username: 'linked',
          access: 'active',
          revision: 1,
          capacity_bytes: 100,
          created_at: 1,
          verified_at: 1,
          storage: null,
          counts: null,
          sessions: [],
          sessionsTruncated: false,
          ...observation,
        }
      : { items: [], next: null, limit: 50, ...observation },
  )
  await act(async () => root.render(<AdminApp client={api} />))
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path === `accounts/${idA}`)).toBe(true)
  expect(host.querySelector('[aria-label="Account detail"]')?.textContent).toContain(
    'linked@example.org',
  )
})

it('keeps observed settings visible but blocks preview after a failed refresh', async () => {
  window.history.replaceState(null, '', '#settings')
  let reads = 0
  const api = client(async (path) => {
    if (path === 'settings') {
      reads++
      if (reads === 2) throw new Error('read unavailable')
      return settings()
    }
    return { items: [], next: null, limit: 50, ...observation }
  })
  await act(async () => root.render(<AdminApp client={api} />))
  await act(async () => click('Refresh settings'))
  expect(host.textContent).toContain('Settings read failed')
  expect(host.textContent).toContain('Observed revision 7')
  const preview = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent === 'Preview settings change',
  ) as HTMLButtonElement
  expect(preview.disabled).toBe(true)
  await act(async () => click('Refresh settings'))
  expect(host.textContent).not.toContain('Settings read failed')
})

it('keeps filtered account context and rereads detail after a completed action', async () => {
  window.history.replaceState(null, '', '#accounts')
  let detailReads = 0
  const api = client(async (path) =>
    path.startsWith('accounts?')
      ? {
          items: [
            {
              id: idA,
              email: 'm***@***',
              username: 'synthetic',
              access: 'active',
              capacity_bytes: 100,
              created_at: 1,
            },
          ],
          next: null,
          limit: 50,
          ...observation,
        }
      : {
          id: idA,
          email: 'owner@example.org',
          username: 'synthetic',
          access: 'active',
          revision: ++detailReads,
          capacity_bytes: 100,
          created_at: 1,
          verified_at: 1,
          storage: null,
          counts: null,
          sessions: [],
          sessionsTruncated: false,
          ...observation,
        },
  )
  vi.mocked(api.preview).mockResolvedValue({
    version: 1,
    target: { kind: 'account', id: idA },
    expectedRevision: 1,
    settingsRevision: 1,
    impact: ['Stop writes'],
    requiresConfirmation: false,
    expiresAt: Date.now() + 60_000,
    commandDigest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  vi.mocked(api.execute).mockResolvedValue({
    version: 1,
    actionId: 'AAAAAAAAAAAAAAAAAAAAAA',
    targetRevision: 2,
    state: 'complete',
    requestId: 'request-id',
  })
  await act(async () => root.render(<AdminApp client={api} />))
  const access = Array.from(host.querySelectorAll('select')).find((select) =>
    select.parentElement?.textContent?.includes('Access'),
  )!
  await act(async () => {
    access.value = 'active'
    access.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => click(`Inspect account ${idA}`))
  const policy = Array.from(host.querySelectorAll('select')).find((select) =>
    select.parentElement?.textContent?.includes('Cloud access'),
  )!
  await act(async () => {
    policy.value = 'read-only'
    policy.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => click('Preview access change'))
  await act(async () => click('Apply action'))
  await act(async () => click('Close'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(window.location.hash).toBe(`#accounts?accountId=${idA}`)
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes('access=active'))).toBe(true)
  expect(detailReads).toBe(2)
  expect(host.querySelector('[aria-label="Account detail"]')?.textContent).toContain('Revision 2')
  expect(document.activeElement).toBe(host.querySelector('h1'))
})

it('resets keyset position and rows when a server filter changes', async () => {
  window.history.replaceState(null, '', '#accounts')
  const api = client(async (path) =>
    path.startsWith('accounts?')
      ? {
          items: [
            {
              id: path.includes('cursor=') ? idB : idA,
              email: 'm***@***',
              username: 'synthetic',
              access: 'active',
              capacity_bytes: 100,
              created_at: 1,
            },
          ],
          next: path.includes('cursor=') ? null : 'next-token',
          limit: 50,
          ...observation,
        }
      : { items: [], next: null, limit: 50, ...observation },
  )
  await act(async () => root.render(<AdminApp client={api} />))
  await act(async () => click('Next page'))
  expect(host.textContent).toContain('Page 2')
  expect(host.textContent).toContain(idB)
  const access = Array.from(host.querySelectorAll('select')).find((select) =>
    select.parentElement?.textContent?.includes('Access'),
  )!
  await act(async () => {
    access.value = 'blocked'
    access.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.textContent).toContain('Page 1')
  expect(host.textContent).not.toContain(idB)
  expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).toContain('access=blocked')
  expect(vi.mocked(api.get).mock.calls.at(-1)?.[0]).not.toContain('cursor=')
})
