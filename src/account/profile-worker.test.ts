import { afterEach, expect, it, vi } from 'vitest'
import { createProfileWorker } from './profile-worker'
import { installProfile, invalidateProfile, withAccountKey } from './profile'
import { withAccountForeground } from './background-work'
import { accountLocalId } from '../workspace/account-cache'

class Transport {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  terminated = false
  messages: { kind: string; incarnation: string; id?: string; key?: Uint8Array; pending?: boolean }[] = []
  sentKey?: Uint8Array
  postMessage(value: unknown, transfer: Transferable[] = []) {
    this.sentKey ??= (value as { key?: Uint8Array }).key
    this.messages.push(structuredClone(value, { transfer }) as Transport['messages'][number])
  }
  terminate() { this.terminated = true }
  reply(value: unknown) { this.onmessage?.call(this as unknown as Worker, { data: value } as MessageEvent) }
}
afterEach(() => invalidateProfile())
it('transfers only a detached disposable key copy and rejects late output after profile revocation', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32)), token = installProfile(accountLocalId(), secret.slice()), transport = new Transport()
  const lease = await createProfileWorker(token, transport as unknown as Worker)
  expect(transport.sentKey?.byteLength).toBe(0)
  expect(transport.messages[0]?.key).toEqual(secret)
  expect(await withAccountKey(token, async key => [...key])).toEqual([...secret])
  await withAccountForeground(token, async () => {})
  expect(transport.messages.filter(value => value.kind === 'foreground').map(value => value.pending)).toEqual([false, true, false])
  const promise = lease.request({ kind: 'map', row: { id: 'opaque' } })
  const request = transport.messages.at(-1)!
  transport.reply({ incarnation: 'foreign', id: request.id, status: 'complete', value: 'wrong' })
  invalidateProfile()
  await expect(promise).rejects.toThrow(/released/)
  expect(transport.terminated).toBe(true)
  transport.reply({ incarnation: lease.incarnation, id: request.id, status: 'complete', value: 'late' })
  secret.fill(0)
})
it('cancels the captured realm on request cancellation without affecting a successor profile', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport()
  const lease = await createProfileWorker(token, transport as unknown as Worker), controller = new AbortController()
  const request = lease.request({ kind: 'map' }, controller.signal)
  controller.abort()
  await expect(request).rejects.toThrow(/released/)
  expect(transport.terminated).toBe(true)
  expect(await withAccountKey(token, async key => key.length)).toBe(32)
})

it('waits for readiness and binds progress and terminal responses to the requested operation', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport()
  let initialized = false
  const creating = createProfileWorker(token, transport as unknown as Worker, { ready: true }).then(value => { initialized = true; return value })
  await Promise.resolve(); await Promise.resolve()
  expect(initialized).toBe(false)
  const incarnation = transport.messages[0]!.incarnation
  transport.reply({ incarnation: 'foreign', status: 'ready' })
  await Promise.resolve()
  expect(initialized).toBe(false)
  transport.reply({ incarnation, status: 'ready' })
  const lease = await creating
  const progress: unknown[] = []
  const operationId = accountLocalId()
  const pending = lease.request({ kind: 'review', operationId }, undefined, value => progress.push(value))
  const request = transport.messages.at(-1)!
  transport.reply({ incarnation, id: request.id, operationId: 'foreign', status: 'complete', value: 'wrong' })
  transport.reply({ incarnation, id: request.id, operationId, status: 'progress', value: { stage: 'reading-source' } })
  transport.reply({ incarnation, id: request.id, operationId, status: 'complete', value: 'reviewed' })
  expect(await pending).toBe('reviewed')
  expect(progress).toEqual([{ stage: 'reading-source' }])
  expect(transport.messages.filter(value => value.kind === 'foreground').map(value => value.pending)).toEqual([false])
  lease.dispose()
})

it('rejects initialization and pending work on a message deserialization failure', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport()
  const pending = createProfileWorker(token, transport as unknown as Worker, { ready: true })
  const rejection = expect(pending).rejects.toThrow(/released/)
  await Promise.resolve(); await Promise.resolve()
  ;(transport as unknown as Worker).onmessageerror?.call(transport as unknown as Worker, new MessageEvent('messageerror'))
  await rejection
  expect(transport.terminated).toBe(true)
})

it('cancels initialization before readiness when the caller aborts', async () => {
  const token = installProfile('captured-account', new Uint8Array(32)), controller = new AbortController()
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker
  const pending = createProfileWorker(token, worker, { ready: true, signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  controller.abort()
  await rejected
  expect(worker.terminate).toHaveBeenCalledOnce()
  invalidateProfile()
})

it('retires an initial foreground subscription when its immediate notification fails', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport(), post = transport.postMessage.bind(transport)
  let foreground = 0
  transport.postMessage = value => {
    if ((value as { kind?: string }).kind === 'foreground') { foreground++; throw new Error('synthetic failed worker transport') }
    post(value)
  }
  await expect(createProfileWorker(token, transport as unknown as Worker)).rejects.toThrow(/released/)
  const before = foreground
  await withAccountForeground(token, async () => {})
  expect(foreground).toBe(before)
  expect(transport.terminated).toBe(true)
})

it('ignores completed review progress and aborted preparation progress without accepting prior request IDs', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport()
  const lease = await createProfileWorker(token, transport as unknown as Worker), operationId = accountLocalId()
  const review = lease.request({ kind: 'review', operationId }), previous = transport.messages.at(-1)!
  transport.reply({ incarnation: lease.incarnation, id: previous.id, operationId, status: 'complete', value: 'review' }); await review
  const progress: unknown[] = [], controller = new AbortController()
  const preparation = lease.request({ kind: 'prepare', operationId }, controller.signal, value => progress.push(value)), active = transport.messages.at(-1)!
  const emit = (id: string | undefined) => transport.reply({ incarnation: lease.incarnation, id, operationId, status: 'progress', value: { stage: 'preparing-merge', observations: { status: 'complete', records: 1, bytes: 99 } } })
  emit(previous.id); expect(progress).toEqual([])
  emit(active.id); expect(progress).toHaveLength(1)
  const rejection = expect(preparation).rejects.toThrow(/released/)
  controller.abort(); await rejection
  emit(active.id); emit(previous.id); expect(progress).toHaveLength(1)
})

it('ignores numeric refusal progress from foreign and retired request envelopes', async () => {
  const { SIGNIN_MERGE_LIMITS } = await import('../workspace/signin-merge-protocol')
  const token = installProfile(accountLocalId(), new Uint8Array(32)), transport = new Transport()
  const lease = await createProfileWorker(token, transport as unknown as Worker), operationId = accountLocalId()
  const progress: unknown[] = []
  const prior = lease.request({ kind: 'review', operationId }), old = transport.messages.at(-1)!
  transport.reply({ incarnation: lease.incarnation, id: old.id, operationId, status: 'complete', value: 'review' }); await prior
  const controller = new AbortController()
  const pending = lease.request({ kind: 'prepare', operationId }, controller.signal, value => progress.push(value)), active = transport.messages.at(-1)!
  const value = { stage: 'preparing-merge', resourceFailure: { dimension: 'records', value: SIGNIN_MERGE_LIMITS.records + 1, limit: SIGNIN_MERGE_LIMITS.records, basis: 'record-cardinality' } }
  const envelope = { incarnation: lease.incarnation, id: active.id, operationId, status: 'progress', value }
  transport.reply({ ...envelope, incarnation: 'foreign' })
  transport.reply({ ...envelope, operationId: 'foreign' })
  transport.reply({ ...envelope, id: old.id })
  expect(progress).toEqual([])
  transport.reply(envelope)
  expect(progress).toEqual([value])
  const rejection = expect(pending).rejects.toThrow(/released/)
  controller.abort(); await rejection
  transport.reply(envelope)
  expect(progress).toEqual([value])
})
