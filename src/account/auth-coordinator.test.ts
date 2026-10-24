import { afterEach, expect, it, vi } from 'vitest'
import { authAcquisitionDeadlineMs, authLockName, authRequestDeadlineMs, withAuthLock } from './auth-coordinator'
import { invalidateProfile } from './profile'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); invalidateProfile() })
it('keepsCookieExclusionUntilAnAbortedNativeOperationActuallySettles', async () => {
  let release!: () => void
  let signal!: AbortSignal
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const first = withAuthLock(run => run(async captured => { signal = captured; entered(); await new Promise<void>(resolve => { release = resolve }); return 'late' }))
  const rejected = expect(first).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  await started
  invalidateProfile()
  expect(signal.aborted).toBe(true)
  let successor = false
  const second = withAuthLock(async () => { successor = true })
  await new Promise(resolve => setTimeout(resolve, 15))
  expect(successor).toBe(false)
  release()
  await rejected
  await second
  expect(successor).toBe(true)
})
it('boundsWaitingAcquisitionWithoutDispatchingItsCallback', async () => {
  vi.useFakeTimers()
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const owner = navigator.locks.request(authLockName, async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  await started
  let dispatched = false
  const pending = withAuthLock(async () => { dispatched = true })
  const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_ACQUISITION_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(authAcquisitionDeadlineMs)
  await rejection
  expect(dispatched).toBe(false)
  release(); await owner
})
it('abortsRequestDeadlineAndDoesNotPretendServerRollback', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = withAuthLock(run => run(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); entered() })))
  const rejection = expect(pending).rejects.toMatchObject({ code: 'AUTH_REQUEST_TIMEOUT' })
  await started
  await vi.advanceTimersByTimeAsync(authRequestDeadlineMs)
  await rejection
})
it('unavailableCrossTabCoordinationNeverFallsBackToAnInTabMutex', async () => {
  vi.stubGlobal('navigator', {})
  let dispatched = false
  await expect(withAuthLock(async () => { dispatched = true })).rejects.toMatchObject({ code: 'AUTH_COORDINATION_UNAVAILABLE' })
  expect(dispatched).toBe(false)
})

it('normalizesNativeAbortErrorsToTheOwnedDeadlineReasonAfterSettlement', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = withAuthLock(run => run(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('Fetch is aborted', 'AbortError'))); entered() })))
  const outcome = pending.catch(error => error)
  await started
  await vi.advanceTimersByTimeAsync(authRequestDeadlineMs)
  expect(await outcome).toMatchObject({ code: 'AUTH_REQUEST_TIMEOUT' })
})
