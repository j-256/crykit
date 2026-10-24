import { OpaqueIdSchema } from './protocol'
import { assertKey, type AccountKey } from './crypto/types'
import type { LocalPasswordEnvelope } from './crypto/local-unlock'

const databaseName = 'crykit-account-device-v1'
const databaseVersion = 1
const profileStore = 'profiles'
const rememberedVersion = 1
const ivBytes = 12
export interface RememberedEnvelope { version: 1; deviceKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
export interface DeviceProfile {
  version: 1
  accountId: string
  passwordEnvelope?: LocalPasswordEnvelope
  remembered?: RememberedEnvelope
  lastSessionId?: string
  pendingRevocations: string[]
}
function context(accountId: string): Uint8Array<ArrayBuffer> { OpaqueIdSchema.parse(accountId); return new TextEncoder().encode(JSON.stringify(['crykit/remembered/v1', accountId])) }
export async function createRememberedEnvelope(key: AccountKey, accountId: string): Promise<RememberedEnvelope> {
  assertKey(key)
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
  const bytes = new Uint8Array(key)
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(accountId) }, deviceKey, bytes)
    return { version: rememberedVersion, deviceKey, iv, ciphertext }
  } finally { bytes.fill(0) }
}
export async function openRememberedEnvelope(envelope: RememberedEnvelope, accountId: string): Promise<AccountKey> {
  if (envelope.version !== rememberedVersion || envelope.deviceKey.extractable || envelope.deviceKey.algorithm.name !== 'AES-GCM' || (envelope.deviceKey.algorithm as AesKeyAlgorithm).length !== 256 || envelope.iv.byteLength !== ivBytes) throw new Error('UNSUPPORTED_DEVICE_ENVELOPE')
  const key = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.iv, additionalData: context(accountId) }, envelope.deviceKey, envelope.ciphertext))
  try { assertKey(key); return key } catch (error) { key.fill(0); throw error }
}
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let abandoned = false
    const request = indexedDB.open(databaseName, databaseVersion)
    request.onupgradeneeded = () => { request.result.createObjectStore(profileStore, { keyPath: 'accountId' }) }
    request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result) }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { abandoned = true; reject(new Error('DEVICE_STORE_BLOCKED')) }
  })
}
function checkRecord(record: DeviceProfile | undefined, accountId: string): void {
  if (record && (record.version !== 1 || record.accountId !== accountId || (record.lastSessionId !== undefined && !OpaqueIdSchema.safeParse(record.lastSessionId).success) || !Array.isArray(record.pendingRevocations) || record.pendingRevocations.some(id => !OpaqueIdSchema.safeParse(id).success))) throw new Error('UNSUPPORTED_DEVICE_PROFILE')
}
export async function readDeviceProfile(accountId: string): Promise<DeviceProfile | undefined> {
  OpaqueIdSchema.parse(accountId)
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(profileStore).objectStore(profileStore).get(accountId)
      request.onsuccess = () => { try { checkRecord(request.result, accountId); resolve(request.result) } catch (error) { reject(error) } }
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}
export async function listCachedProfiles(): Promise<readonly { accountId: string; remembered: boolean; passwordAvailable: boolean; revocationPending: boolean }[]> {
  const db = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(profileStore).objectStore(profileStore).getAll()
      request.onsuccess = () => { try { resolve((request.result as DeviceProfile[]).map(record => { OpaqueIdSchema.parse(record.accountId); checkRecord(record, record.accountId); return { accountId: record.accountId, remembered: !!record.remembered, passwordAvailable: !!record.passwordEnvelope, revocationPending: record.pendingRevocations.length > 0 } })) } catch (error) { reject(error) } }
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}
export async function updateDeviceProfile(accountId: string, update: (record: DeviceProfile) => DeviceProfile, assertCurrent: () => void = () => {}, signal?: AbortSignal): Promise<void> {
  OpaqueIdSchema.parse(accountId); assertCurrent(); signal?.throwIfAborted()
  const db = await openDatabase()
  try {
    assertCurrent(); signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(profileStore, 'readwrite')
      let failure: unknown
      const abort = () => { try { tx.abort() } catch { /* A completed transaction cannot be rolled back */ } }
      signal?.addEventListener('abort', abort, { once: true })
      const cleanup = () => signal?.removeEventListener('abort', abort)
      tx.oncomplete = () => { cleanup(); try { assertCurrent(); signal?.throwIfAborted(); resolve() } catch (error) { reject(error) } }
      tx.onabort = tx.onerror = () => { cleanup(); reject(failure ?? tx.error ?? signal?.reason ?? new Error('DEVICE_STORE_WRITE_FAILED')) }
      const store = tx.objectStore(profileStore), request = store.get(accountId)
      request.onsuccess = () => {
        try {
          assertCurrent(); signal?.throwIfAborted(); checkRecord(request.result, accountId)
          const next = update(request.result ?? { version: 1, accountId, pendingRevocations: [] })
          checkRecord(next, accountId); assertCurrent(); store.put(next)
        } catch (error) { failure = error; abort() }
      }
    })
  } finally { db.close() }
}
// This only removes unlock material; S01 owns deleting its encrypted account database after recovery review
export async function removeDeviceEnvelopes(accountId: string, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
  await updateDeviceProfile(accountId, record => ({ version: 1, accountId, pendingRevocations: record.pendingRevocations }), assertCurrent, signal)
}
