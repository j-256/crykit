import { captureProfileEpoch } from '../account/profile'
import { LEGACY_CHECK_BUDGET_MS, LEGACY_MONITOR_INTERVAL_MS } from './legacy-capture'
import { GuestManagedManifestSchema, type GuestManagedManifest } from './guest-managed-contract'
import type { GuestRecoveryNotice } from './guest-recovery'
import type { GuestMonitorRequest, GuestMonitorResponse } from './guest-managed-monitor-worker'

export interface GuestMonitorState {
  readonly notices: readonly GuestRecoveryNotice[]
  readonly checking: boolean
  readonly incomplete: boolean
  readonly paused: boolean
}
export interface GuestManagedMonitor {
  assertReady(): void
  compare(signal?: AbortSignal): Promise<readonly GuestRecoveryNotice[]>
  observe(listener: (state: GuestMonitorState) => void): () => void
  notifyStorageChange(): void
  invalidate(): void
  dispose(): void
}

// One repository incarnation owns the schedule, including across its exact owned successor wrappers
// Hidden/cancelled attempts cannot grant readiness, and old worker replies cannot revive a revoked owner
export function createGuestManagedMonitor(databaseName: string, manifest: GuestManagedManifest, onDispose: () => void = () => {}): GuestManagedMonitor {
  const profile = captureProfileEpoch()
  const capturedManifest = GuestManagedManifestSchema.parse(manifest)
  let ready = false, disposed = false, generation = 0, failures = 0
  let pending: Promise<readonly GuestRecoveryNotice[]> | undefined
  let cancel: (() => void) | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let state: GuestMonitorState = { notices: [], checking: false, incomplete: false, paused: false }
  const listeners = new Set<(value: GuestMonitorState) => void>()
  const publish = (next: GuestMonitorState) => { state = next; for (const listener of listeners) listener(state) }
  const check = () => { profile.assertCurrent(); if (disposed) throw new Error('The retained guest monitor was released') }
  const visibility = typeof document === 'undefined' ? undefined : document
  const events = typeof window === 'undefined' ? undefined : window
  const hidden = () => visibility?.visibilityState === 'hidden'
  const invalidate = () => { ready = false; generation++; cancel?.() }
  const automatic = () => {
    if (disposed || hidden() || state.paused || pending) return
    void compare().catch(() => {})
  }
  const onVisibility = () => {
    if (hidden()) { invalidate(); publish({ ...state, incomplete: true }) }
    else automatic()
  }
  const onFocus = () => { if (!hidden() && !pending) { invalidate(); automatic() } }
  const dispose = () => {
    if (disposed) return
    disposed = true; invalidate(); clearInterval(interval)
    profile.signal.removeEventListener('abort', dispose)
    visibility?.removeEventListener('visibilitychange', onVisibility); events?.removeEventListener('focus', onFocus)
    listeners.clear(); onDispose()
  }
  visibility?.addEventListener('visibilitychange', onVisibility); events?.addEventListener('focus', onFocus)
  profile.signal.addEventListener('abort', dispose, { once: true })
  function compare(signal?: AbortSignal): Promise<readonly GuestRecoveryNotice[]> {
    check()
    if (hidden()) { invalidate(); return Promise.reject(new Error('Retained guest comparison is hidden')) }
    if (signal?.aborted) return Promise.reject(new Error('Retained guest comparison cancelled'))
    if (pending) {
      if (signal) {
        const abort = () => invalidate()
        signal.addEventListener('abort', abort, { once: true })
        void pending.finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
      }
      return pending
    }
    // The interval belongs to admission, not observer mount or ordinary Save completion
    interval ??= setInterval(automatic, LEGACY_MONITOR_INTERVAL_MS)
    const captured = ++generation
    let worker: Worker
    try { worker = new Worker(new URL('./guest-managed-monitor-worker.ts', import.meta.url), { type: 'module' }) }
    catch (error) { ready = false; publish({ ...state, checking: false, incomplete: true, paused: ++failures >= 2 }); return Promise.reject(error) }
    const id = crypto.randomUUID()
    publish({ ...state, checking: true })
    pending = new Promise<readonly GuestRecoveryNotice[]>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error, notices?: readonly GuestRecoveryNotice[]) => {
        if (finished) return
        finished = true
        clearTimeout(deadline); signal?.removeEventListener('abort', abort)
        worker.terminate(); cancel = undefined
        const incomplete = !!error || !!notices?.some(value => value.status === 'incomplete')
        failures = incomplete ? failures + 1 : 0
        ready = !error && !notices!.length
        publish({ notices: notices ?? state.notices, checking: false, incomplete, paused: failures >= 2 })
        if (error) reject(error)
        else resolve(notices!)
      }
      // Termination releases native held readers; an incomplete attempt is never cached as equal
      const abort = () => {
        ready = false; generation++
        try { worker.postMessage({ kind: 'cancel', id } satisfies GuestMonitorRequest) }
        finally { finish(new Error('Retained guest comparison cancelled')) }
      }
      const deadline = setTimeout(() => { ready = false; generation++; finish(new Error('Retained guest comparison expired')) }, LEGACY_CHECK_BUDGET_MS)
      cancel = abort
      signal?.addEventListener('abort', abort, { once: true })
      worker.onerror = () => finish(new Error('Retained guest comparison is unavailable'))
      worker.onmessage = (event: MessageEvent<GuestMonitorResponse>) => {
        try {
          check()
          if (generation !== captured || event.data.id !== id) throw new Error('Retained guest comparison owner changed')
          if (event.data.status !== 'complete') {
            finish(new Error('Retained guest comparison did not complete'))
            if (event.data.reason === 'selection-changed') dispose()
            return
          }
          finish(undefined, event.data.notices)
        } catch (error) { finish(error instanceof Error ? error : new Error('Retained guest comparison failed')) }
      }
      try { worker.postMessage({ kind: 'compare', id, databaseName, manifest: capturedManifest } satisfies GuestMonitorRequest) }
      catch { finish(new Error('Retained guest worker could not start')) }
    }).finally(() => { pending = undefined })
    return pending
  }
  return {
    assertReady() { check(); if (!ready) throw new Error('Retained local data needs a complete comparison before saving') },
    invalidate, dispose,
    compare(signal) { failures = 0; publish({ ...state, paused: false }); return compare(signal) },
    observe(listener) { check(); listeners.add(listener); listener(state); return () => listeners.delete(listener) },
    notifyStorageChange: automatic,
  }
}
