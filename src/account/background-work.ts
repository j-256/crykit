import { assertActiveProfile, currentProfileToken, profileSignal, registerProfileCleanup, type ProfileToken } from './profile'

interface WorkState { count: number; listeners: Set<(pending: boolean) => void>; checkpoint?: () => Promise<void> }
const work = new WeakMap<ProfileToken, WorkState>()
function state(token: ProfileToken): WorkState {
  assertActiveProfile(token)
  const identity = currentProfileToken()!
  let value = work.get(identity)
  if (!value) {
    value = { count: 0, listeners: new Set() }
    work.set(identity, value)
    registerProfileCleanup(token, () => { value!.listeners.clear(); value!.checkpoint = undefined; work.delete(identity) })
  }
  return value
}

// Scheduling state grants no storage authority; every resumed unit still checks its captured profile
// Only the mapper worker installs a checkpoint, so foreground crypto does not wait on its own pause
export function installAccountWorkCheckpoint(token: ProfileToken, checkpoint: () => Promise<void>): void {
  const value = state(token)
  if (value.checkpoint) throw new Error('Background work already has a captured scheduler')
  value.checkpoint = checkpoint
}
export async function accountWorkCheckpoint(token: ProfileToken): Promise<void> {
  assertActiveProfile(token)
  await work.get(currentProfileToken()!)?.checkpoint?.()
  assertActiveProfile(token)
}
export function observeAccountForeground(token: ProfileToken, listener: (pending: boolean) => void): () => void {
  const value = state(token)
  value.listeners.add(listener); listener(value.count > 0)
  return () => value.listeners.delete(listener)
}
export async function withAccountForeground<T>(token: ProfileToken, operation: () => Promise<T>): Promise<T> {
  const value = state(token)
  if (++value.count === 1) for (const listener of value.listeners) listener(true)
  try { const result = await operation(); assertActiveProfile(token); return result }
  finally { if (--value.count === 0) for (const listener of value.listeners) listener(false) }
}

export async function waitForAccountForeground(token: ProfileToken, signal?: AbortSignal): Promise<void> {
  const value = state(token), profile = profileSignal(token)
  signal?.throwIfAborted()
  if (!value.count) return
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      value.listeners.delete(changed); profile.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const changed = (pending: boolean) => { if (!pending) finish() }
    const abort = () => finish(new Error('Captured account preparation was cancelled'))
    value.listeners.add(changed); profile.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
  })
  assertActiveProfile(token)
  signal?.throwIfAborted()
}
