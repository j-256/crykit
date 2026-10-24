import { assertActiveProfile, profileSignal, registerProfileCleanup, withAccountKey, type ProfileToken } from './profile'
import { observeAccountForeground } from './background-work'

export interface ProfileWorkerLease {
  readonly incarnation: string
  request<T>(value: object, signal?: AbortSignal): Promise<T>
  dispose(): void
}

// A worker belongs to exactly one captured unlocked profile and is never retargeted
// Transfer only a disposable key copy; lock terminates the realm and rejects all late replies
export async function createProfileWorker(token: ProfileToken, worker: Worker): Promise<ProfileWorkerLease> {
  assertActiveProfile(token)
  const incarnation = crypto.randomUUID()
  let disposed = false
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; detach: () => void }>()
  let unregister = () => {}, unobserve = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { worker.postMessage({ kind: 'cancel', incarnation }) } catch { /* Termination still releases the captured realm */ }
    worker.terminate(); unregister(); unobserve()
    for (const value of pending.values()) { value.detach(); value.reject(new Error('Captured account worker was released')) }
    pending.clear()
    worker.onmessage = null; worker.onerror = null
  }
  unregister = registerProfileCleanup(token, dispose)
  worker.onerror = dispose
  worker.onmessage = (event: MessageEvent<{ incarnation: string; id: string; status: 'complete' | 'failed'; value?: unknown }>) => {
    if (disposed || event.data.incarnation !== incarnation) return
    try { assertActiveProfile(token) } catch { dispose(); return }
    const value = pending.get(event.data.id)
    if (!value) return
    pending.delete(event.data.id); value.detach()
    if (event.data.status === 'complete') value.resolve(event.data.value)
    else value.reject(new Error('Account background preparation failed'))
  }
  try {
    await withAccountKey(token, async key => {
      // The sender's transferred copy is detached; withAccountKey clears its separate scratch buffer
      const transfer = key.slice()
      try { worker.postMessage({ kind: 'initialize', incarnation, accountId: token.accountId, key: transfer }, [transfer.buffer]) }
      catch (error) { transfer.fill(0); throw error }
    })
    assertActiveProfile(token)
    unobserve = observeAccountForeground(token, pending => {
      try { worker.postMessage({ kind: 'foreground', incarnation, pending }) } catch { dispose() }
    })
    return {
      incarnation, dispose,
      request<T>(input: object, signal?: AbortSignal): Promise<T> {
        assertActiveProfile(token)
        if (disposed || signal?.aborted || profileSignal(token).aborted) return Promise.reject(new Error('Captured account worker was released'))
        const id = crypto.randomUUID()
        return new Promise<T>((resolve, reject) => {
          // Cancelling one operation cancels the captured preparation realm, not a successor worker
          const abort = () => dispose()
          signal?.addEventListener('abort', abort, { once: true })
          pending.set(id, { resolve: value => resolve(value as T), reject, detach: () => signal?.removeEventListener('abort', abort) })
          try { worker.postMessage({ ...input, incarnation, id }) } catch { dispose() }
        })
      },
    }
  } catch (error) { dispose(); throw error }
}
