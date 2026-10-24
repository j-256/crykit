import type { UnlockResult } from './auth-client'
import type { AccountKey } from './crypto/types'

export interface ProfileToken { readonly accountId: string; readonly generation: number }
export class ProfileChangedError extends Error {
  readonly code = 'PROFILE_CHANGED'
  constructor() { super('PROFILE_CHANGED') }
}
export class ProfileSessionChangedError extends Error {
  readonly code = 'PROFILE_SESSION_CHANGED'
  constructor() { super('PROFILE_SESSION_CHANGED') }
}
interface ActiveProfile {
  token: ProfileToken
  key: AccountKey
  session?: Omit<UnlockResult, 'key'>
  cleanups: Set<() => void>
  urls: Set<string>
  sessionListeners: Set<() => void>
}
let generation = 0
let jobs = new AbortController()
let active: ActiveProfile | undefined
export type ProfileTransitionReason = 'transition' | 'pagehide'
const transitionCleanups = new Set<(reason: ProfileTransitionReason) => void>()
export function onProfileTransition(cleanup: (reason: ProfileTransitionReason) => void): () => void { transitionCleanups.add(cleanup); return () => transitionCleanups.delete(cleanup) }
export function captureProfileEpoch() {
  const captured = generation
  return { signal: jobs.signal, assertCurrent: () => { if (generation !== captured) throw new ProfileChangedError() } }
}
export function assertActiveProfile(token: ProfileToken): void {
  if (!active || active.token.accountId !== token.accountId || active.token.generation !== token.generation) throw new ProfileChangedError()
}
export function profileSignal(token: ProfileToken): AbortSignal { assertActiveProfile(token); return jobs.signal }
export function registerProfileCleanup(token: ProfileToken, cleanup: () => void): () => void {
  assertActiveProfile(token)
  const cleanups = active!.cleanups
  cleanups.add(cleanup)
  return () => cleanups.delete(cleanup)
}
export function trackProfileUrl(token: ProfileToken, url: string): void { assertActiveProfile(token); active!.urls.add(url) }
export function invalidateProfile(reason: ProfileTransitionReason = 'transition'): void {
  // Invalidate before notifying consumers so cleanup cannot publish old-generation projections
  generation++
  const previous = active
  active = undefined
  jobs.abort(new ProfileChangedError())
  jobs = new AbortController()
  previous?.key.fill(0)
  for (const url of previous?.urls ?? []) URL.revokeObjectURL(url)
  // One faulty consumer must not retain another consumer's secrets or jobs
  for (const cleanup of [...(previous?.cleanups ?? []), ...transitionCleanups]) { try { cleanup(reason) } catch { /* Remaining cleanup still runs */ } }
}
export function installProfile(accountId: string, key: AccountKey, session?: Omit<UnlockResult, 'key'>): ProfileToken {
  const token = Object.freeze({ accountId, generation })
  active = { token, key, session, cleanups: new Set(), urls: new Set(), sessionListeners: new Set() }
  return token
}
export async function withAccountKey<T>(token: ProfileToken, operation: (key: AccountKey) => Promise<T>): Promise<T> {
  assertActiveProfile(token)
  // Each operation owns a scratch copy: locking wipes the active key and rejects late publication
  const key = active!.key.slice()
  const signal = jobs.signal
  const clear = () => key.fill(0)
  signal.addEventListener('abort', clear, { once: true })
  try { const result = await operation(key); assertActiveProfile(token); return result }
  finally { signal.removeEventListener('abort', clear); key.fill(0) }
}
// Infrastructure-only bridge: UI calls lifecycle actions and never retains UnlockResult in React state
export async function withProfileSession<T>(token: ProfileToken, operation: (unlocked: UnlockResult) => Promise<T>): Promise<T> {
  assertActiveProfile(token)
  const session = active!.session
  if (!session) throw new Error('ONLINE_ACCESS_DISCONNECTED')
  // Renewal preserves the profile generation, so private results also bind to the captured session
  const assertSession = () => {
    assertActiveProfile(token)
    if (active!.session !== session) throw new ProfileSessionChangedError()
  }
  try {
    const result = await withAccountKey(token, key => operation({ ...session, key }))
    assertSession()
    return result
  } catch (error) {
    assertSession()
    // A failed old request cannot revoke authority installed by renewal or reconnection
    if (error instanceof Error && ['AUTH_REQUIRED', 'CSRF_FAILED'].includes(error.message)) setProfileSession(token)
    throw error
  }
}
export function setProfileSession(token: ProfileToken, session?: Omit<UnlockResult, 'key'>): void {
  assertActiveProfile(token)
  if (session && session.accountId !== token.accountId) throw new ProfileChangedError()
  active!.session = session
  for (const listener of active!.sessionListeners) listener()
}
export function onProfileSessionChange(token: ProfileToken, listener: () => void): () => void {
  assertActiveProfile(token)
  const listeners = active!.sessionListeners
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function profileAccess(token: ProfileToken): 'connected' | 'disconnected' { assertActiveProfile(token); return active!.session ? 'connected' : 'disconnected' }

export function profileSessionIdentity(token: ProfileToken): { accountId: string; sessionId?: string } { assertActiveProfile(token); return { accountId: token.accountId, sessionId: active!.session?.sessionId } }

// Safe projection for remounting account controls; possession alone never bypasses generation checks
export function currentProfileToken(): ProfileToken | undefined { return active?.token }
