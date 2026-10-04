export interface OfflineStatus {
  state: 'checking' | 'not-ready' | 'ready' | 'unsupported' | 'error'
  detail?: string
  updateAvailable?: boolean
}

const READINESS_TIMEOUT_MS = 8_000
const REFRESH_TIMEOUT_MS = 120_000
const UPDATE_ACTIVATION_TIMEOUT_MS = 8_000
const INSTALLATION_FAILURE_MESSAGE = 'Offline installation failed. Reconnect and retry.'
const REFRESH_FAILURE_MESSAGE = 'App files could not be refreshed. Check your connection and try again. Your saved records have been kept.'
let registration: ServiceWorkerRegistration | undefined
let status: OfflineStatus = { state: 'not-ready', detail: 'Prepare the app for use without a connection.' }
const listeners = new Set<(status: OfflineStatus) => void>()
let pending: Promise<OfflineStatus> | undefined
let refreshPending: Promise<void> | undefined

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

function requestCache(worker: ServiceWorker, type: 'CHECK_READINESS' | 'PREPARE_CACHE' | 'REFRESH_CACHE'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(false) }, type === 'REFRESH_CACHE' ? REFRESH_TIMEOUT_MS : READINESS_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<{ ready?: boolean; error?: string }>) => {
      clearTimeout(timer)
      channel.port1.close()
      if (type === 'REFRESH_CACHE' && event.data.error) { reject(new Error(event.data.error)); return }
      resolve(event.data.ready === true)
    }
    try { worker.postMessage({ type }, [channel.port2]) } catch (error) { clearTimeout(timer); channel.port1.close(); reject(error) }
  })
}

async function inspectCache(prepare = false): Promise<OfflineStatus> {
  const worker = registration?.active
  if (!worker) return publish({ state: 'not-ready', detail: 'The offline download has not finished.' })
  const ready = await requestCache(worker, prepare ? 'PREPARE_CACHE' : 'CHECK_READINESS')
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
  const watchedWorkers = new WeakSet<ServiceWorker>()
  const watchInstalling = () => {
    const installing = value.installing
    if (!installing || watchedWorkers.has(installing)) return
    watchedWorkers.add(installing)
    installing.addEventListener('statechange', () => {
      if (value.active && (installing.state === 'installed' || installing.state === 'activated')) void inspectCache()
    })
  }
  value.addEventListener('updatefound', watchInstalling)
  watchInstalling()
}

function waitForActiveWorker(value: ServiceWorkerRegistration): Promise<void> {
  return new Promise((resolve, reject) => {
    let observedWorker: ServiceWorker | null = null
    const cleanup = () => {
      value.removeEventListener('updatefound', inspect)
      observedWorker?.removeEventListener('statechange', inspect)
    }
    const inspect = () => {
      if (value.active) {
        cleanup()
        resolve()
        return
      }
      const worker = value.installing ?? value.waiting ?? observedWorker
      if (!worker || worker.state === 'redundant') {
        cleanup()
        reject(new Error(INSTALLATION_FAILURE_MESSAGE))
        return
      }
      if (worker !== observedWorker) {
        observedWorker?.removeEventListener('statechange', inspect)
        observedWorker = worker
        observedWorker.addEventListener('statechange', inspect)
      }
    }
    value.addEventListener('updatefound', inspect)
    inspect()
  })
}

function waitForInstalledWorker(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', inspect)
        reject(new Error(INSTALLATION_FAILURE_MESSAGE))
      } else if (worker.state !== 'installing' && worker.state !== 'parsed') {
        worker.removeEventListener('statechange', inspect)
        resolve()
      }
    }
    worker.addEventListener('statechange', inspect)
    inspect()
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
    if (!registration.active) await waitForActiveWorker(registration)
    const inspected = await inspectCache()
    return inspected.state === 'ready' ? inspected : await inspectCache(true)
  } catch (error) {
    return publish({ state: 'error', detail: error instanceof Error ? error.message : 'Unable to cache the application.' })
  }
}

export async function activateOfflineUpdate(): Promise<void> {
  const worker = registration?.waiting
  if (!worker) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', activated) }
    const activated = () => {
      if (navigator.serviceWorker.controller !== worker) return
      cleanup()
      window.location.reload()
      resolve()
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('The app update could not be activated. Try again.')) }, UPDATE_ACTIVATION_TIMEOUT_MS)
    navigator.serviceWorker.addEventListener('controllerchange', activated)
    try { worker.postMessage({ type: 'ACTIVATE_UPDATE' }) } catch (error) { cleanup(); reject(error) }
  })
}

export function refreshOfflineApplication(): Promise<void> {
  if (refreshPending) return refreshPending
  refreshPending = refreshApplication().finally(() => { refreshPending = undefined })
  return refreshPending
}

async function refreshApplication(): Promise<void> {
  if (import.meta.env.DEV) { window.location.reload(); return }
  if (!('serviceWorker' in navigator) || !window.isSecureContext) throw new Error('App refresh needs a secure browser with offline installation support.')
  publish({ state: 'checking', detail: 'Downloading the latest app files. Your saved records will be kept.' })
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: 'none' })
    watchRegistration(registration)
    await registration.update()
    if (registration.installing) await waitForInstalledWorker(registration.installing)
    if (!registration.active) await waitForActiveWorker(registration)
    const worker = registration.waiting ?? registration.active
    if (!worker || !await requestCache(worker, registration.waiting ? 'CHECK_READINESS' : 'REFRESH_CACHE')) throw new Error(REFRESH_FAILURE_MESSAGE)
    if (registration.waiting) await activateOfflineUpdate()
    else window.location.reload()
  } catch (error) {
    console.warn('Application refresh failed', error)
    if (registration?.active) {
      try { await inspectCache() } catch { publish({ state: 'error', detail: REFRESH_FAILURE_MESSAGE }) }
    } else publish({ state: 'error', detail: REFRESH_FAILURE_MESSAGE })
    throw new Error(REFRESH_FAILURE_MESSAGE, { cause: error })
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false
}
