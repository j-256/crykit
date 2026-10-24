import { afterEach, expect, it } from 'vitest'
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
