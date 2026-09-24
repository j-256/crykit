export interface OfflineStatus {
  state: 'checking' | 'not-ready' | 'ready' | 'unsupported' | 'error'
  detail?: string
  updateAvailable?: boolean
}

const READINESS_TIMEOUT_MS = 8_000
let registration: ServiceWorkerRegistration | undefined
let status: OfflineStatus = { state: 'not-ready', detail: 'Prepare the app for use without a connection.' }
const listeners = new Set<(status: OfflineStatus) => void>()
let pending: Promise<OfflineStatus> | undefined

function publish(next: OfflineStatus): OfflineStatus {
  status = next
  for (const listener of listeners) listener({ ...status })
  return { ...status }
}

export function subscribeOfflineStatus(listener: (value: OfflineStatus) => void): () => void {
  listeners.add(listener)
  listener({ ...status })
  return () => { listeners.delete(listener) }
}

async function inspectCache(): Promise<OfflineStatus> {
  const worker = registration?.active
  if (!worker) return publish({ state: 'not-ready', detail: 'The offline download has not finished.' })
  const ready = await new Promise<boolean>((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(false) }, READINESS_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<{ ready?: boolean }>) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(event.data.ready === true)
    }
    worker.postMessage({ type: 'CHECK_READINESS' }, [channel.port2])
  })
  return publish({
    state: ready ? 'ready' : 'not-ready',
    detail: ready ? 'The application is cached. Your records stay in this browser.' : 'Some application files are missing from the cache. Reconnect and prepare again.',
    updateAvailable: Boolean(registration?.waiting),
  })
}

export async function getOfflineStatus(): Promise<OfflineStatus> {
  if (!('serviceWorker' in navigator)) return publish({ state: 'unsupported', detail: 'This browser does not support offline installation.' })
  if (!registration && !import.meta.env.DEV) {
    try {
      registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
      if (registration) watchRegistration(registration)
    } catch {
      return publish({ state: 'error', detail: 'Unable to inspect the offline installation.' })
    }
  }
  return registration?.active ? inspectCache() : { ...status }
}

const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>()

function watchRegistration(value: ServiceWorkerRegistration): void {
  if (watchedRegistrations.has(value)) return
  watchedRegistrations.add(value)
  value.addEventListener('updatefound', () => {
    const installing = value.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' || installing.state === 'activated') void inspectCache()
    })
  })
}

export function requestOfflineReadiness(): Promise<OfflineStatus> {
  if (pending) return pending
  pending = prepareOffline().finally(() => { pending = undefined })
  return pending
}

async function prepareOffline(): Promise<OfflineStatus> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return publish({ state: 'unsupported', detail: 'Offline installation needs a secure browser context.' })
  }
  if (import.meta.env.DEV) {
    return publish({ state: 'not-ready', detail: 'Offline caching is available in the production preview or installed application.' })
  }
  publish({ state: 'checking', detail: 'Downloading and checking application files...' })
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    watchRegistration(registration)
    if (!registration.active) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Offline installation did not finish. Reconnect and retry.')), READINESS_TIMEOUT_MS)
        void navigator.serviceWorker.ready.then(() => { clearTimeout(timer); resolve() })
      })
    }
    return await inspectCache()
  } catch (error) {
    return publish({ state: 'error', detail: error instanceof Error ? error.message : 'Unable to cache the application.' })
  }
}

export async function activateOfflineUpdate(): Promise<void> {
  if (!registration?.waiting) return
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true })
  registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' })
}

export async function requestPersistentStorage(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false
}
