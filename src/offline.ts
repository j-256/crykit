import { OFFLINE_CONTENT_MANIFEST, OFFLINE_CONTENT_VERSION, OFFLINE_EXTRAS, type OfflineContent, type OfflineExtra, type OfflineProgress } from './offline-content'

export interface OfflineStatus {
  state: 'checking' | 'not-ready' | 'ready' | 'unsupported' | 'error'
  detail?: string
  updateAvailable?: boolean
  contents?: readonly OfflineContent[]
  selectionKnown?: boolean
  progress?: OfflineProgress
}

interface CacheReply { ready: boolean; error?: string; pending?: boolean; contents?: readonly OfflineContent[] }

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
let manifestPending: Promise<readonly OfflineContent[] | undefined> | undefined

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

function requestCache(worker: ServiceWorker, type: 'CHECK_READINESS' | 'PREPARE_CACHE' | 'REFRESH_CACHE', extras?: readonly OfflineExtra[]): Promise<CacheReply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    // A preparation can outlive this status request; the worker still reports its actual completion
    const timer = setTimeout(() => { channel.port1.close(); resolve({ ready: false, pending: type === 'PREPARE_CACHE' }) }, type === 'REFRESH_CACHE' ? REFRESH_TIMEOUT_MS : READINESS_TIMEOUT_MS)
    channel.port1.onmessage = (event: MessageEvent<CacheReply>) => {
      clearTimeout(timer)
      channel.port1.close()
      if (type === 'REFRESH_CACHE' && event.data.error) { reject(new Error(event.data.error)); return }
      resolve(event.data)
    }
    try { worker.postMessage({ type, contentVersion: OFFLINE_CONTENT_VERSION, ...(extras === undefined ? {} : { extras }) }, [channel.port2]) } catch (error) { clearTimeout(timer); channel.port1.close(); reject(error) }
  })
}

function publishCacheReply(reply: CacheReply): OfflineStatus {
  // Older workers report readiness only after caching every feature, without per-feature metadata
  const contents = reply.contents ?? (reply.ready ? status.contents?.map(content => ({ ...content, ready: true, selected: true })) : status.contents)
  return publish({
    state: reply.error ? 'error' : reply.pending ? 'checking' : reply.ready ? 'ready' : 'not-ready',
    detail: reply.error ?? (reply.pending ? 'The download is continuing in the background.' : reply.ready ? 'Selected app files are ready offline. Your saved work is kept.' : 'Some selected app files are missing. Reconnect and prepare again.'),
    contents,
    selectionKnown: !reply.pending,
    ...(reply.pending && status.progress ? { progress: status.progress } : {}),
    updateAvailable: Boolean(registration?.waiting),
  })
}

async function inspectCache(prepare = false, extras?: readonly OfflineExtra[]): Promise<OfflineStatus> {
  const worker = registration?.active
  if (!worker) return publish({ state: 'not-ready', detail: 'The offline download has not finished.' })
  return publishCacheReply(await requestCache(worker, prepare ? 'PREPARE_CACHE' : 'CHECK_READINESS', extras))
}

function readContentManifest(): Promise<readonly OfflineContent[] | undefined> {
  manifestPending ??= (async () => {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}${OFFLINE_CONTENT_MANIFEST}`)
      if (!response.ok) return
      const data = await response.json() as { version?: unknown; contents?: OfflineContent[] }
      const ids = new Set(['core', ...Object.keys(OFFLINE_EXTRAS)])
      if (data.version !== OFFLINE_CONTENT_VERSION || !Array.isArray(data.contents) || data.contents.length !== ids.size) return
      if (data.contents.some(content => !ids.delete(content.id) || !Number.isSafeInteger(content.files) || content.files < 0 || !Number.isSafeInteger(content.bytes) || content.bytes < 0)) return
      return data.contents.map(content => ({ ...content, ready: false, selected: content.id === 'core' }))
    } catch { return }
  })()
  return manifestPending
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
  if (registration?.active) return inspectCache()
  const contents = !import.meta.env.DEV ? await readContentManifest() : undefined
  // A first-install reply can arrive while the size manifest loads; verified worker state takes precedence
  return contents && !status.selectionKnown ? publish({ ...status, contents }) : { ...status }
}

const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>()
let watchingMessages = false

function watchRegistration(value: ServiceWorkerRegistration): void {
  if (!watchingMessages) {
    watchingMessages = true
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string; progress?: OfflineProgress } & CacheReply>) => {
      if (!event.source || ![registration?.active, registration?.installing, registration?.waiting].includes(event.source as ServiceWorker)) return
      if (event.data.type === 'OFFLINE_PROGRESS' && event.data.progress) publish({ ...status, state: 'checking', detail: 'Downloading and checking selected app files...', progress: event.data.progress })
      if (event.data.type === 'OFFLINE_STATUS') publishCacheReply(event.data)
    })
  }
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

export function requestOfflineReadiness(extras: readonly OfflineExtra[] = []): Promise<OfflineStatus> {
  if (pending) return pending
  pending = prepareOffline(extras).finally(() => { pending = undefined })
  return pending
}

async function prepareOffline(extras: readonly OfflineExtra[]): Promise<OfflineStatus> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return publish({ state: 'unsupported', detail: 'Offline installation needs a secure browser context.' })
  }
  if (import.meta.env.DEV) {
    return publish({ state: 'not-ready', detail: 'Offline caching is available in the production preview or installed application.' })
  }
  publish({ ...status, state: 'checking', detail: 'Downloading and checking selected app files...' })
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    watchRegistration(registration)
    if (!registration.active) await waitForActiveWorker(registration)
    const inspected = await inspectCache()
    const changedSelection = inspected.contents?.some(content => content.id !== 'core' && content.selected !== extras.includes(content.id))
    const missingSelection = extras.some(id => inspected.contents?.find(content => content.id === id)?.ready === false)
    return inspected.state === 'ready' && !changedSelection && !missingSelection ? inspected : await inspectCache(true, extras)
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
    if (!worker || !(await requestCache(worker, registration.waiting ? 'CHECK_READINESS' : 'REFRESH_CACHE')).ready) throw new Error(REFRESH_FAILURE_MESSAGE)
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
