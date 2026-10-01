import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SLOW_INSTALL_DELAY_MS = 60_000

type WorkerMessage = { type: string }

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
  readonly messages: WorkerMessage[] = []

  postMessage(message: WorkerMessage, transfer: Transferable[] = []): void {
    this.messages.push(message)
    const port = transfer[0] as MessagePort | undefined
    if (message.type === 'CHECK_READINESS' || message.type === 'PREPARE_CACHE') {
      queueMicrotask(() => port?.postMessage({ ready: true }))
    }
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
  return {
    register: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    ready,
    resolveReady: () => resolveReady(registration as unknown as ServiceWorkerRegistration),
  }
}

async function loadOffline(serviceWorker: ReturnType<typeof makeServiceWorkerContainer>) {
  vi.stubEnv('DEV', false)
  vi.stubEnv('BASE_URL', '/')
  vi.stubGlobal('window', { isSecureContext: true, location: { reload: vi.fn() } })
  vi.stubGlobal('navigator', { serviceWorker })
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
