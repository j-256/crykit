import { assertActiveProfile, registerProfileCleanup, type ProfileToken } from '../account/profile'

// Loading a module grants no account authority: only the later profile lease sends initialization
// Keep failed loads owned until choice so a dead realm cannot leave readiness pending forever
export function prewarmSigninMergeWorker(token: ProfileToken, signal: AbortSignal, create: () => Worker) {
  assertActiveProfile(token)
  let worker: Worker | undefined, disposed = false
  let unregister = () => {}
  const detach = () => {
    unregister()
    signal.removeEventListener('abort', dispose)
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', dispose)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    detach()
    if (worker) {
      worker.onerror = null; worker.onmessageerror = null
      worker.terminate(); worker = undefined
    }
  }
  unregister = registerProfileCleanup(token, dispose)
  signal.addEventListener('abort', dispose, { once: true })
  if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose, { once: true })
  if (signal.aborted) dispose()
  if (!disposed) {
    try {
      const created = create()
      // A constructor can synchronously revoke ownership before returning its realm
      if (disposed) created.terminate()
      else { worker = created; worker.onerror = dispose; worker.onmessageerror = dispose }
    } catch { dispose() }
  }
  return {
    dispose,
    take() {
      assertActiveProfile(token)
      if (disposed || signal.aborted || !worker) throw new Error('SIGNIN_PREPARATION_FAILED')
      const captured = worker
      worker = undefined; disposed = true; detach()
      captured.onerror = null; captured.onmessageerror = null
      // The caller must synchronously enter createProfileWorker, which registers cleanup and
      // readiness handlers before its first await; no event-loop turn may separate these owners
      return captured
    },
  }
}
