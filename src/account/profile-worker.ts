import { assertActiveProfile, profileSignal, registerProfileCleanup, withAccountKey, type ProfileToken } from './profile'
import { observeAccountForeground } from './background-work'

export interface ProfileWorkerLease {
  readonly incarnation: string
  request<T>(value: object, signal?: AbortSignal, progress?: (value: unknown) => void): Promise<T>
  check(): void
  dispose(): void
}

// A worker belongs to exactly one captured unlocked profile and is never retargeted
// Transfer only a disposable key copy; lock terminates the realm and rejects all late replies
export async function createProfileWorker(token: ProfileToken, worker: Worker, options?: { readonly ready?: true; readonly errorCodes?: readonly string[]; readonly signal?: AbortSignal; readonly diagnostics?: true }): Promise<ProfileWorkerLease> {
  assertActiveProfile(token)
  const incarnation = crypto.randomUUID()
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = options?.ready ? new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject }) : undefined
  // Initialization may fail during key transfer before the caller starts awaiting readiness
  void ready?.catch(() => {})
  let disposed = false
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; detach: () => void; operationId?: string; progress?: (value: unknown) => void }>()
  let unregister = () => {}, unobserve = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    readyReject?.(new Error('Captured account worker was released'))
    try { worker.postMessage({ kind: 'cancel', incarnation }) } catch { /* Termination still releases the captured realm */ }
    worker.terminate(); unregister(); unobserve(); options?.signal?.removeEventListener('abort', dispose)
    for (const value of pending.values()) { value.detach(); value.reject(new Error('Captured account worker was released')) }
    pending.clear()
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
  }
  unregister = registerProfileCleanup(token, dispose)
  options?.signal?.addEventListener('abort', dispose, { once: true })
  if (options?.signal?.aborted) dispose()
  worker.onerror = dispose
  worker.onmessageerror = dispose
  worker.onmessage = (event: MessageEvent<{ incarnation: string; id: string; status: 'ready' | 'progress' | 'complete' | 'failed'; operationId?: string; code?: string; value?: unknown }>) => {
    if (disposed || event.data.incarnation !== incarnation) return
    try { assertActiveProfile(token) } catch { dispose(); return }
    if (ready && event.data.status === 'failed' && !event.data.id) { dispose(); return }
    if (event.data.status === 'ready') { readyResolve?.(); return }
    const value = pending.get(event.data.id)
    if (!value || value.operationId !== event.data.operationId) return
    if (event.data.status === 'progress') { try { value.progress?.(event.data.value) } catch { dispose() }; return }
    pending.delete(event.data.id); value.detach()
    if (event.data.status === 'complete') value.resolve(event.data.value)
    else value.reject(new Error(event.data.code && options?.errorCodes?.includes(event.data.code) ? event.data.code : 'Account background preparation failed'))
  }
  try {
    if (disposed) throw new Error('Captured account worker was released')
    await withAccountKey(token, async key => {
      // The sender's transferred copy is detached; withAccountKey clears its separate scratch buffer
      const transfer = key.slice()
      try { worker.postMessage({ kind: 'initialize', incarnation, accountId: token.accountId, key: transfer, ...(options?.diagnostics ? { diagnostics: true } : {}) }, [transfer.buffer]) }
      catch (error) { transfer.fill(0); throw error }
    })
    assertActiveProfile(token)
    if (disposed) throw new Error('Captured account worker was released')
    unobserve = observeAccountForeground(token, pending => {
      try { worker.postMessage({ kind: 'foreground', incarnation, pending }) } catch { dispose() }
    })
    // Observation calls back before returning its disposer, so a failed first notification needs this retirement
    if (disposed) { unobserve(); throw new Error('Captured account worker was released') }
    await ready
    assertActiveProfile(token)
    if (disposed) throw new Error('Captured account worker was released')
    return {
      incarnation, dispose, check() { assertActiveProfile(token); if (disposed) throw new Error('Captured account worker was released') },
      request<T>(input: object, signal?: AbortSignal, progress?: (value: unknown) => void): Promise<T> {
        assertActiveProfile(token)
        if (disposed || signal?.aborted || profileSignal(token).aborted) return Promise.reject(new Error('Captured account worker was released'))
        const id = crypto.randomUUID()
        return new Promise<T>((resolve, reject) => {
          // Cancelling one operation cancels the captured preparation realm, not a successor worker
          const abort = () => dispose()
          signal?.addEventListener('abort', abort, { once: true })
          pending.set(id, { resolve: value => resolve(value as T), reject, operationId: (input as { operationId?: string }).operationId, progress, detach: () => signal?.removeEventListener('abort', abort) })
          try { worker.postMessage({ ...input, incarnation, id }) } catch { dispose() }
        })
      },
    }
  } catch (error) { dispose(); throw error }
}
