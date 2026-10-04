import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SLOW_INSTALL_DELAY_MS = 60_000
const CACHE_REFRESH_TIMEOUT_MS = 120_000
const UPDATE_ACTIVATION_TIMEOUT_MS = 8_000

type WorkerMessage = { type: string }

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
  readonly messages: WorkerMessage[] = []
  refreshReady = true
  onActivate?: () => void

  postMessage(message: WorkerMessage, transfer: Transferable[] = []): void {
    this.messages.push(message)
    const port = transfer[0] as MessagePort | undefined
    if (message.type === 'CHECK_READINESS' || message.type === 'PREPARE_CACHE' || message.type === 'REFRESH_CACHE') {
      queueMicrotask(() => port?.postMessage({ ready: message.type !== 'REFRESH_CACHE' || this.refreshReady }))
    }
    if (message.type === 'ACTIVATE_UPDATE') this.onActivate?.()
  }

  setState(state: ServiceWorkerState): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null
  peer: FakeMessagePort | undefined

  postMessage(data: unknown): void {
    this.peer?.onmessage?.({ data } as MessageEvent)
  }

  close(): void {}
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort()
  readonly port2 = new FakeMessagePort()

  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  update = vi.fn(async () => this as unknown as ServiceWorkerRegistration)

  constructor(worker?: FakeWorker, active?: FakeWorker) {
    super()
    this.installing = worker ?? null
    this.active = active ?? null
  }

  activate(worker: FakeWorker): void {
    this.active = worker
    this.installing = null
    worker.setState('activated')
  }
}

function makeServiceWorkerContainer(registration: FakeRegistration) {
  let resolveReady!: (value: ServiceWorkerRegistration) => void
  const ready = new Promise<ServiceWorkerRegistration>(resolve => { resolveReady = resolve })
  if (registration.active) resolveReady(registration as unknown as ServiceWorkerRegistration)
  return Object.assign(new EventTarget(), {
    controller: registration.active,
    register: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    ready,
    resolveReady: () => resolveReady(registration as unknown as ServiceWorkerRegistration),
  })
}

async function loadOffline(serviceWorker: ReturnType<typeof makeServiceWorkerContainer> | undefined, development = false) {
  vi.stubEnv('DEV', development)
  vi.stubEnv('BASE_URL', '/')
  vi.stubGlobal('window', { isSecureContext: true, location: { reload: vi.fn() } })
  vi.stubGlobal('navigator', serviceWorker ? { serviceWorker } : {})
  vi.stubGlobal('MessageChannel', FakeMessageChannel)
  vi.resetModules()
  return import('./offline')
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('manual app refresh', () => {
  it('reloads the development preview once without registering or refreshing offline files', async () => {
    const registration = new FakeRegistration()
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker, true)
    const statuses: string[] = []
    offline.subscribeOfflineStatus(value => statuses.push(value.state))

    const request = offline.refreshOfflineApplication()
    expect(offline.refreshOfflineApplication()).toBe(request)
    await request

    expect(window.location.reload).toHaveBeenCalledTimes(1)
    expect(serviceWorker.register).not.toHaveBeenCalled()
    expect(serviceWorker.getRegistration).not.toHaveBeenCalled()
    expect(registration.update).not.toHaveBeenCalled()
    expect(statuses).toEqual(['not-ready'])
  })

  it('allows a normal development reload without service worker support or a secure context', async () => {
    const offline = await loadOffline(undefined, true)
    vi.stubGlobal('window', { isSecureContext: false, location: { reload: vi.fn() } })

    await expect(offline.refreshOfflineApplication()).resolves.toBeUndefined()

    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the offline support requirement for production refresh', async () => {
    const offline = await loadOffline(undefined)

    await expect(offline.refreshOfflineApplication()).rejects.toThrow('App refresh needs a secure browser with offline installation support.')

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('redownloads a current build once and reloads after its cache is ready', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const registration = new FakeRegistration(undefined, active)
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)

    const request = offline.refreshOfflineApplication()
    expect(offline.refreshOfflineApplication()).toBe(request)
    await request

    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' })
    expect(registration.update).toHaveBeenCalledTimes(1)
    expect(active.messages.map(message => message.type)).toEqual(['REFRESH_CACHE'])
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('waits for a slow new build before explicitly activating it and reloading', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const installing = new FakeWorker()
    const registration = new FakeRegistration(installing, active)
    const serviceWorker = makeServiceWorkerContainer(registration)
    installing.onActivate = () => {
      registration.waiting = null
      registration.activate(installing)
      serviceWorker.controller = installing
      serviceWorker.dispatchEvent(new Event('controllerchange'))
    }
    const offline = await loadOffline(serviceWorker)

    const request = offline.refreshOfflineApplication()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(SLOW_INSTALL_DELAY_MS)
    expect(window.location.reload).not.toHaveBeenCalled()
    expect(installing.messages).toEqual([])
    registration.installing = null
    registration.waiting = installing
    installing.setState('installed')
    await request

    const messages = installing.messages.map(message => message.type)
    expect(messages[0]).toBe('CHECK_READINESS')
    expect(messages.filter(type => type === 'ACTIVATE_UPDATE')).toHaveLength(1)
    expect(messages).not.toContain('REFRESH_CACHE')
    expect(active.messages.map(message => message.type)).not.toContain('REFRESH_CACHE')
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('leaves an active build usable after refresh fails and permits retry', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    active.refreshReady = false
    const registration = new FakeRegistration(undefined, active)
    const offline = await loadOffline(makeServiceWorkerContainer(registration))

    await expect(offline.refreshOfflineApplication()).rejects.toThrow(/Check your connection and try again/)
    expect(window.location.reload).not.toHaveBeenCalled()
    await expect(offline.getOfflineStatus()).resolves.toMatchObject({ state: 'ready' })
    active.refreshReady = true
    await offline.refreshOfflineApplication()
    expect(window.location.reload).toHaveBeenCalledTimes(1)
  })

  it('does not activate a failed update or reload the working page', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const installing = new FakeWorker()
    const registration = new FakeRegistration(installing, active)
    const offline = await loadOffline(makeServiceWorkerContainer(registration))
    const request = offline.refreshOfflineApplication()
    const rejected = expect(request).rejects.toThrow(/saved records have been kept/)
    await flushMicrotasks()
    registration.installing = null
    installing.setState('redundant')
    await rejected

    expect(window.location.reload).not.toHaveBeenCalled()
    expect(installing.messages).toEqual([])
    await expect(offline.getOfflineStatus()).resolves.toMatchObject({ state: 'ready' })
  })

  it('times out an unresponsive refresh without reloading and keeps the active installation', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const original = active.postMessage.bind(active)
    vi.spyOn(active, 'postMessage').mockImplementation((message, transfer) => {
      if (message.type !== 'REFRESH_CACHE') original(message, transfer)
    })
    const offline = await loadOffline(makeServiceWorkerContainer(new FakeRegistration(undefined, active)))
    const request = offline.refreshOfflineApplication()
    const rejected = expect(request).rejects.toThrow(/try again/)
    await vi.advanceTimersByTimeAsync(CACHE_REFRESH_TIMEOUT_MS)
    await rejected

    expect(window.location.reload).not.toHaveBeenCalled()
    await expect(offline.getOfflineStatus()).resolves.toMatchObject({ state: 'ready' })
  })

  it('removes a failed activation listener so a later update cannot reload a draft', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const waiting = new FakeWorker()
    waiting.state = 'installed'
    const registration = new FakeRegistration(undefined, active)
    registration.waiting = waiting
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)
    await offline.getOfflineStatus()
    const request = offline.activateOfflineUpdate()
    const rejected = expect(request).rejects.toThrow(/could not be activated/)
    await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATION_TIMEOUT_MS)
    await rejected
    serviceWorker.controller = waiting
    serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})

describe('offline installation readiness', () => {
  it('keeps a slow initial installation pending until activation', async () => {
    const worker = new FakeWorker()
    const registration = new FakeRegistration(worker)
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)
    const statuses: string[] = []
    offline.subscribeOfflineStatus(value => statuses.push(value.state))

    const request = offline.requestOfflineReadiness()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(SLOW_INSTALL_DELAY_MS)
    await flushMicrotasks()

    expect(statuses.at(-1)).toBe('checking')
    expect(serviceWorker.register).toHaveBeenCalledTimes(1)
    worker.setState('installed')
    worker.setState('activating')
    registration.activate(worker)
    serviceWorker.resolveReady()

    await expect(request).resolves.toMatchObject({ state: 'ready' })
  })

  it('observes an already-installing worker and publishes readiness when it activates', async () => {
    const worker = new FakeWorker()
    const registration = new FakeRegistration(worker)
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)
    const statuses: string[] = []
    offline.subscribeOfflineStatus(value => statuses.push(value.state))

    const status = offline.getOfflineStatus()
    await expect(status).resolves.toMatchObject({ state: 'not-ready' })
    await flushMicrotasks()
    worker.setState('installed')
    worker.setState('activating')
    registration.activate(worker)
    await flushMicrotasks()

    expect(statuses.at(-1)).toBe('ready')
    expect(worker.messages.map(message => message.type)).toContain('CHECK_READINESS')
  })

  it('reports a redundant first-install worker as an actionable error', async () => {
    const worker = new FakeWorker()
    const registration = new FakeRegistration(worker)
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)
    const statuses: string[] = []
    offline.subscribeOfflineStatus(value => statuses.push(value.state))

    const request = offline.requestOfflineReadiness()
    await flushMicrotasks()
    registration.installing = null
    worker.setState('redundant')

    await expect(request).resolves.toMatchObject({ state: 'error', detail: expect.stringMatching(/retry/i) })
    expect(statuses).toContain('error')
    expect(statuses.at(-1)).toBe('error')
  })

  it('keeps an active installation ready when a later update worker fails', async () => {
    const active = new FakeWorker()
    active.state = 'activated'
    const installingUpdate = new FakeWorker()
    const registration = new FakeRegistration(installingUpdate, active)
    const serviceWorker = makeServiceWorkerContainer(registration)
    const offline = await loadOffline(serviceWorker)

    await expect(offline.requestOfflineReadiness()).resolves.toMatchObject({ state: 'ready' })
    installingUpdate.setState('redundant')
    await flushMicrotasks()

    await expect(offline.getOfflineStatus()).resolves.toMatchObject({ state: 'ready' })
  })
})
