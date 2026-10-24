import { assertActiveProfile, onProfileSessionChange, profileAccess, profileSignal, registerProfileCleanup, type ProfileToken } from '../profile'
import { SyncError } from './client'
import { CommitProgress } from './commit-progress'

export const QUIET_UPLOAD_MS = 2000
export const FOREGROUND_POLL_MS = 30_000
export const INITIAL_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 60_000
export const MAX_TRANSIENT_FAILURES = 8
export const MAX_BULK_CONFLICTS_PER_TURN = 3
const bulkConflicts = new Map<string, number>()
export function claimBulkRebase(token: ProfileToken): boolean {
  assertActiveProfile(token)
  const key = identity(token), count = (bulkConflicts.get(key) ?? 0) + 1
  bulkConflicts.set(key, count)
  return count < MAX_BULK_CONFLICTS_PER_TURN
}
export type SyncState = 'synced' | 'syncing' | 'offline' | 'signin-required' | 'conflict' | 'quota' | 'failed' | 'paused'
export interface SyncOutcome { readonly state: SyncState; readonly moreWork: boolean }
export type SyncReason = 'quiet' | 'save' | 'retry' | 'foreground'
type Runner = (token: ProfileToken, signal: AbortSignal) => Promise<SyncOutcome>
interface ScheduledSync {
  request(reason: SyncReason): void
  subscribe(listener: (state: SyncState) => void): () => void
  dispose(): void
}
const schedulers = new Map<string, ScheduledSync>()
const identity = (token: ProfileToken) => `${token.accountId}:${token.generation}`
function foreground() { return typeof document !== 'undefined' && document.visibilityState === 'visible' }
function connected() { return typeof navigator === 'undefined' || navigator.onLine !== false }
export function requestSync(token: ProfileToken, reason: SyncReason): void { assertActiveProfile(token); schedulers.get(identity(token))?.request(reason) }
export function subscribeSync(token: ProfileToken, listener: (state: SyncState) => void): () => void { assertActiveProfile(token); const scheduler = schedulers.get(identity(token)); if (!scheduler) { listener('paused'); return () => {} }; return scheduler.subscribe(listener) }
export function attachSyncScheduler(token: ProfileToken, run: Runner): () => void {
  assertActiveProfile(token)
  const key = identity(token)
  schedulers.get(key)?.dispose()
  const listeners = new Set<(state: SyncState) => void>()
  let state: SyncState = 'paused', failures = 0, blocked = false, disposed = false, busy = false
  let timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined, requestedAt: number | undefined
  let retryNotBefore = 0, urgentRequest = false
  const publish = (next: SyncState) => { state = next; for (const listener of listeners) listener(next) }
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const eligible = () => !disposed && foreground() && connected() && profileAccess(token) === 'connected'
  const schedule = (delay: number) => { clear(); if (eligible() && !blocked) timer = setTimeout(() => { timer = undefined; void iterate() }, Math.max(0, delay, retryNotBefore - Date.now())) }
  async function iterate() {
    if (busy || !eligible() || blocked) return
    busy = true; requestedAt = undefined; urgentRequest = false
    active = new AbortController()
    const signal = AbortSignal.any([active.signal, profileSignal(token)])
    publish('syncing')
    let nextDelay: number | undefined
    try {
      const outcome = await run(token, signal)
      signal.throwIfAborted(); assertActiveProfile(token)
      failures = 0; publish(outcome.state)
      // Retained comparisons do not suspend unrelated edits or a subsequent explicit choice
      blocked = ['signin-required', 'quota', 'failed', 'paused'].includes(outcome.state)
      if (!blocked) nextDelay = outcome.moreWork ? 0 : FOREGROUND_POLL_MS
    } catch (error) {
      if (!signal.aborted && !disposed) {
        const code = error instanceof Error ? error.message : 'FAILED'
        if (error instanceof CommitProgress) {
          failures = 0; publish('syncing')
          retryNotBefore = Math.max(retryNotBefore, Date.now() + error.retryAfterMs)
          nextDelay = error.retryAfterMs
        }
        else if (['PROFILE_SESSION_CHANGED', 'LOCAL_REVISION_CONFLICT'].includes(code)) { publish('paused'); nextDelay = 0 }
        else if (['AUTH_REQUIRED', 'CSRF_FAILED', 'ONLINE_ACCESS_DISCONNECTED'].includes(code)) { publish('signin-required'); blocked = true }
        else if (code === 'QUOTA_EXCEEDED') { publish('quota'); blocked = true }
        else if (code === 'HEAD_CONFLICT') { publish('conflict'); blocked = true }
        else if (['SERVICE_UNAVAILABLE', 'RATE_LIMITED'].includes(code) || error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError') {
          failures++
          blocked = failures >= MAX_TRANSIENT_FAILURES
          publish(blocked ? 'paused' : connected() ? 'failed' : 'offline')
          // Retry/visibility/local activity may resume work, but cannot erase the server or transient retry floor
          const delay = Math.max((error instanceof SyncError ? error.retryAfterMs : 0), Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (failures - 1) * (0.5 + Math.random())))
          retryNotBefore = Math.max(retryNotBefore, Date.now() + delay)
          if (!blocked) nextDelay = delay
        } else { publish(code === 'SERVICE_PAUSED' ? 'paused' : 'failed'); blocked = true }
      }
    } finally {
      busy = false; active = undefined
      if (!disposed && (nextDelay !== undefined || requestedAt !== undefined)) schedule(Math.min(nextDelay ?? Infinity, requestedAt === undefined ? Infinity : requestedAt - Date.now()))
    }
  }
  const request = (reason: SyncReason) => {
    if (disposed) return
    assertActiveProfile(token)
    if (reason === 'retry' || reason === 'foreground') { failures = 0; blocked = false; bulkConflicts.delete(key) }
    if (!foreground()) { clear(); active?.abort(); publish('paused'); return }
    if (!connected()) { clear(); active?.abort(); publish('offline'); return }
    if (profileAccess(token) !== 'connected') { clear(); publish('signin-required'); return }
    if (blocked) return
    const delay = reason === 'quiet' ? QUIET_UPLOAD_MS : 0
    // Quiet edits debounce each other, but cannot postpone a deliberate flush already waiting on this iteration
    if (reason !== 'quiet' || !urgentRequest) requestedAt = Date.now() + delay
    urgentRequest ||= reason !== 'quiet'
    if (!busy) schedule(requestedAt! - Date.now())
  }
  const visibility = () => { if (foreground()) request('foreground'); else { clear(); active?.abort(); publish('paused') } }
  const offline = () => { clear(); active?.abort(); publish('offline') }
  const online = () => request('foreground')
  const dispose = () => {
    if (disposed) return
    disposed = true; unsubscribeSession(); bulkConflicts.delete(key); clear(); active?.abort(); publish('paused'); listeners.clear()
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('focus', online)
    if (schedulers.get(key) === scheduler) schedulers.delete(key)
  }
  const scheduler: ScheduledSync = { request, dispose, subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) } }
  schedulers.set(key, scheduler)
  const unsubscribeSession = onProfileSessionChange(token, () => request('foreground'))
  const unregister = registerProfileCleanup(token, dispose)
  document.addEventListener('visibilitychange', visibility); window.addEventListener('online', online); window.addEventListener('offline', offline); window.addEventListener('focus', online)
  request('foreground')
  return () => { unregister(); dispose() }
}
