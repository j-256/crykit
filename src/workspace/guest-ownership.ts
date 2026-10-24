import type Dexie from 'dexie'
import { LEGACY_CHECK_BUDGET_MS } from './legacy-capture'

export const GUEST_OWNERSHIP_STORE = 'operationOwnership'
export interface GuestOperationOwner { readonly id: string; readonly signal: AbortSignal; assertAlive(): void }

export async function withGuestOperationOwner<T>(database: Dexie, signal: AbortSignal | undefined, action: (owner: GuestOperationOwner) => Promise<T>): Promise<T> {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`${database.name}-operation-ownership-v1`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(GUEST_OWNERSHIP_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  // Native readwrite ownership serializes tabs and is released by the browser on crash
  // A separate lock-only database avoids Dexie schema reads spanning all coordinator stores
  // The only durable authority remains the coordinator journal token and active pointer
  const transaction = connection.transaction(GUEST_OWNERSHIP_STORE, 'readwrite')
  const controller = new AbortController()
  let live = true, stopping = false, failure: unknown
  let acquiredResolve!: () => void, acquiredReject!: (reason: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => { acquiredResolve = resolve; acquiredReject = reject })
  let finishedResolve!: () => void, finishedReject!: (reason: unknown) => void
  const finished = new Promise<void>((resolve, reject) => { finishedResolve = resolve; finishedReject = reject })
  void finished.catch(() => {})
  const abort = () => { failure ??= new Error('Guest operation ownership cancelled or expired'); try { transaction.abort() } catch { /* The native transaction outcome remains authoritative */ } }
  transaction.onabort = () => { live = false; controller.abort(); failure ??= transaction.error ?? new Error('Guest operation ownership lost'); acquiredReject(failure); finishedReject(failure) }
  transaction.oncomplete = () => { live = false; controller.abort(); if (stopping) finishedResolve(); else { failure = new Error('Guest operation ownership ended unexpectedly'); acquiredReject(failure); finishedReject(failure) } }
  const owner: GuestOperationOwner = { id: crypto.randomUUID(), signal: controller.signal, assertAlive() { if (!live || stopping || failure || signal?.aborted) throw failure ?? new Error('Guest operation ownership lost') } }
  const deadline = setTimeout(abort, LEGACY_CHECK_BUDGET_MS)
  signal?.addEventListener('abort', abort, { once: true })
  const pump = () => {
    if (stopping) return
    try {
      owner.assertAlive()
      const request = transaction.objectStore(GUEST_OWNERSHIP_STORE).get('owner')
      request.onsuccess = () => { if (stopping) return; acquiredResolve(); pump() }
      request.onerror = abort
    } catch { abort() }
  }
  pump()
  try {
    await acquired
    // Abort returns promptly even if a stale callback is still awaiting an external transaction
    // Its journal token and assertAlive checks fence every subsequent authority-bearing step
    const result = await Promise.race([action(owner), finished.then(() => { throw new Error('Guest operation ownership ended') })])
    owner.assertAlive()
    stopping = true
    await finished
    return result
  } finally {
    clearTimeout(deadline); signal?.removeEventListener('abort', abort)
    if (!stopping) abort()
    await finished.catch(() => {})
    connection.close()
  }
}
