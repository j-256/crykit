import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createGuestManagedMonitor } from './guest-managed-monitor'
import { invalidateProfile } from '../account/profile'
import { LEGACY_CHECK_BUDGET_MS } from './legacy-capture'
import type { GuestManagedManifest } from './guest-local-store'
import type { GuestMonitorRequest, GuestMonitorResponse } from './guest-managed-monitor-worker'

class WorkerStub {
  static instances: WorkerStub[] = []
  onmessage?: (event: MessageEvent<GuestMonitorResponse>) => void
  onerror?: () => void
  messages: GuestMonitorRequest[] = []
  terminated = false
  constructor() { WorkerStub.instances.push(this) }
  postMessage(message: GuestMonitorRequest) { this.messages.push(message) }
  terminate() { this.terminated = true }
  reply(notices: Extract<GuestMonitorResponse, { status: 'complete' }>['notices'] = []) {
    this.onmessage?.({ data: { id: this.messages[0]!.id, status: 'complete', notices } } as MessageEvent<GuestMonitorResponse>)
  }
}
const manifest = { version: 3, id: 'captured-lineage', revision: 0, root: { documentId: 'root', revisionId: 'revision' } } satisfies GuestManagedManifest
let visibility: EventTarget & { visibilityState: string }
beforeEach(() => {
  vi.useFakeTimers(); WorkerStub.instances = []
  visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('Worker', WorkerStub); vi.stubGlobal('document', visibility)
})
afterEach(() => { invalidateProfile(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('coalesces within one captured owner and blocks a divergent result at the activation gate', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest)
  expect(() => monitor.assertReady()).toThrow()
  const first = monitor.compare(), second = monitor.compare()
  expect(second).toBe(first); expect(WorkerStub.instances).toHaveLength(1)
  WorkerStub.instances[0]!.reply(); await first
  expect(() => monitor.assertReady()).not.toThrow()
  const next = monitor.compare()
  WorkerStub.instances[1]!.reply([{ id: 'retained', status: 'diverged', frozenCaptureId: 'capture' }])
  expect(await next).toEqual([{ id: 'retained', status: 'diverged', frozenCaptureId: 'capture' }])
  expect(() => monitor.assertReady()).toThrow()
  monitor.dispose()
})

it('keeps the automatic attempt budget separate and discards late completion after expiry', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest)
  const pending = monitor.compare(), failure = expect(pending).rejects.toThrow('expired')
  await vi.advanceTimersByTimeAsync(LEGACY_CHECK_BUDGET_MS - 1)
  expect(WorkerStub.instances[0]!.terminated).toBe(false)
  await vi.advanceTimersByTimeAsync(1); await failure
  expect(WorkerStub.instances[0]!.terminated).toBe(true)
  WorkerStub.instances[0]!.reply()
  expect(() => monitor.assertReady()).toThrow()
  monitor.dispose()
})

it('cancels shared readers promptly and cannot adopt their late reply into a new attempt', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest), controller = new AbortController()
  const pending = monitor.compare(), shared = monitor.compare(controller.signal)
  const failure = expect(shared).rejects.toThrow('cancelled')
  controller.abort(); expect(WorkerStub.instances[0]!.terminated).toBe(true)
  await failure; await pending.catch(() => {})
  const next = monitor.compare()
  WorkerStub.instances[0]!.reply(); expect(() => monitor.assertReady()).toThrow()
  WorkerStub.instances[1]!.reply(); await next
  expect(() => monitor.assertReady()).not.toThrow()
  invalidateProfile(); expect(() => monitor.assertReady()).toThrow('PROFILE_CHANGED')
})

it('revokes readiness when hidden even without an active notice caller and requires a new foreground comparison', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest)
  const initial = monitor.compare(); WorkerStub.instances[0]!.reply(); await initial
  visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'))
  expect(() => monitor.assertReady()).toThrow()
  await expect(monitor.compare()).rejects.toThrow('hidden')
  visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange'))
  expect(() => monitor.assertReady()).toThrow()
  const next = monitor.compare(); WorkerStub.instances[1]!.reply(); await next
  expect(() => monitor.assertReady()).not.toThrow()
  const active = monitor.compare(), failure = expect(active).rejects.toThrow('cancelled')
  visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'))
  expect(WorkerStub.instances[2]!.terminated).toBe(true); await failure
  monitor.dispose()
})

it('keeps the same comparison schedule across observer remounts and reacts to storage notifications', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest)
  const first = monitor.compare(); WorkerStub.instances[0]!.reply(); await first
  const observed: boolean[] = []
  const stop = monitor.observe(value => observed.push(value.checking))
  await vi.advanceTimersByTimeAsync(20_000); stop()
  const nextStop = monitor.observe(value => observed.push(value.checking))
  expect(WorkerStub.instances).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(9_999); expect(WorkerStub.instances).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1); expect(WorkerStub.instances).toHaveLength(2)
  WorkerStub.instances[1]!.reply(); await Promise.resolve(); await Promise.resolve()
  monitor.notifyStorageChange(); expect(WorkerStub.instances).toHaveLength(3)
  WorkerStub.instances[2]!.reply(); await Promise.resolve()
  expect(observed).toContain(true)
  nextStop(); monitor.dispose()
})

it('revokes an in-flight worker with the profile and ignores its late successful reply', async () => {
  const monitor = createGuestManagedMonitor('coordinator', manifest)
  const pending = monitor.compare(), failure = expect(pending).rejects.toThrow('cancelled')
  invalidateProfile(); expect(WorkerStub.instances[0]!.terminated).toBe(true)
  await failure; WorkerStub.instances[0]!.reply()
  expect(() => monitor.assertReady()).toThrow('PROFILE_CHANGED')
})

it('does not transfer a pending equal reply across an explicit recovery baseline incarnation', async () => {
  const old = createGuestManagedMonitor('coordinator', manifest)
  const pending = old.compare(), rejected = expect(pending).rejects.toThrow('cancelled')
  const previousWorker = WorkerStub.instances[0]!
  old.dispose(); await rejected
  const successor = createGuestManagedMonitor('coordinator', { ...manifest, revision: 1, recoveryId: 'explicit-copy', root: { documentId: 'root', revisionId: 'copied' } })
  const comparing = successor.compare()
  previousWorker.reply()
  expect(() => old.assertReady()).toThrow()
  expect(() => successor.assertReady()).toThrow()
  expect(WorkerStub.instances[1]!.messages[0]).toMatchObject({ manifest: { recoveryId: 'explicit-copy' } })
  WorkerStub.instances[1]!.reply(); await comparing
  expect(() => successor.assertReady()).not.toThrow()
  successor.dispose()
})
