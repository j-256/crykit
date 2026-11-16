import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { createProfileWorker } from '../account/profile-worker'
import { prewarmSigninMergeWorker } from './signin-merge-prewarm'

function fixture() {
  vi.stubGlobal('window', new EventTarget())
  const token = installProfile('synthetic-account', new Uint8Array(32)), lifetime = new AbortController()
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onerror: null, onmessageerror: null, onmessage: null } as unknown as Worker
  const create = vi.fn(() => worker)
  return { token, lifetime, worker, create }
}
afterEach(() => { invalidateProfile(); vi.unstubAllGlobals() })

it('loads exactly one module without messages and transfers once into the profile lease', async () => {
  const f = fixture(), warm = prewarmSigninMergeWorker(f.token, f.lifetime.signal, f.create)
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  const ready = createProfileWorker(f.token, warm.take(), { ready: true, signal: f.lifetime.signal })
  const initialization = vi.mocked(f.worker.postMessage).mock.calls[0]![0] as { kind: string; incarnation: string }
  expect(initialization.kind).toBe('initialize')
  expect(() => warm.take()).toThrow('SIGNIN_PREPARATION_FAILED')
  warm.dispose()
  expect(f.worker.terminate).not.toHaveBeenCalled()
  f.worker.onmessage?.call(f.worker, { data: { incarnation: initialization.incarnation, status: 'ready' } } as MessageEvent)
  const lease = await ready
  f.lifetime.abort()
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  lease.dispose()
  expect(f.worker.terminate).toHaveBeenCalledOnce()
})

it.each(['dispose', 'cancel', 'profile', 'pagehide'] as const)('retires uninitialized ownership on %s', cause => {
  const f = fixture(), warm = prewarmSigninMergeWorker(f.token, f.lifetime.signal, f.create)
  if (cause === 'dispose') warm.dispose()
  else if (cause === 'cancel') f.lifetime.abort()
  else if (cause === 'profile') invalidateProfile()
  else window.dispatchEvent(new Event('pagehide'))
  warm.dispose()
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  expect(() => warm.take()).toThrow()
})

it.each(['error', 'messageerror', 'constructor'] as const)('retains %s failure until explicit retry instead of initializing a dead module', cause => {
  const f = fixture()
  if (cause === 'constructor') f.create.mockImplementationOnce(() => { throw new Error('synthetic module unavailable') })
  const warm = prewarmSigninMergeWorker(f.token, f.lifetime.signal, f.create)
  if (cause === 'error') f.worker.onerror?.call(f.worker, new Event('error') as ErrorEvent)
  if (cause === 'messageerror') f.worker.onmessageerror?.call(f.worker, new MessageEvent('messageerror'))
  expect(() => warm.take()).toThrow('SIGNIN_PREPARATION_FAILED')
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  warm.dispose()
  const replacement = { ...f.worker, terminate: vi.fn() } as Worker
  const retry = prewarmSigninMergeWorker(f.token, f.lifetime.signal, () => replacement)
  expect(retry.take()).toBe(replacement)
  replacement.terminate()
})

it('registers cancellation before a constructor can return ownership', () => {
  const f = fixture()
  f.create.mockImplementation(() => { f.lifetime.abort(); return f.worker })
  const warm = prewarmSigninMergeWorker(f.token, f.lifetime.signal, f.create)
  expect(f.worker.terminate).toHaveBeenCalledOnce()
  expect(() => warm.take()).toThrow('SIGNIN_PREPARATION_FAILED')
  expect(f.worker.postMessage).not.toHaveBeenCalled()
})

it('rejects a load failure immediately after transfer through the readiness lease', async () => {
  const f = fixture(), warm = prewarmSigninMergeWorker(f.token, f.lifetime.signal, f.create)
  const pending = createProfileWorker(f.token, warm.take(), { ready: true, signal: f.lifetime.signal })
  const rejected = expect(pending).rejects.toThrow(/released/)
  f.worker.onerror?.call(f.worker, new Event('error') as ErrorEvent)
  await rejected
  expect(f.worker.terminate).toHaveBeenCalledOnce()
})
