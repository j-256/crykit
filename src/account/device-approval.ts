import { withAuthLock } from './auth-coordinator'
import { captureProfileEpoch } from './profile'
import { z } from 'zod'
import { accountRequest, type UnlockResult } from './auth-client'
import { getSodium, decodeBytes, encodeBytes } from './crypto/sodium'
import { AccountMetadataSchema, ApprovalRequestListSchema, ApprovalRequestSchema, DeviceApprovalReceiptSchema, DevicePageSchema, DeviceRejectedReceiptSchema, DeviceRemovedReceiptSchema, DeviceStartedSchema, DeviceStatusSchema, DigestSchema, OpaqueIdSchema, SessionReceiptSchema, deviceApprovalLifetimeMs, digestBytes, opaqueIdBytes, deviceFingerprint, deviceSecretHash, type ApprovalRequest } from './protocol'

export type { ApprovalRequest } from './protocol'
export interface PendingDeviceApproval {
  readonly requestId: string; requestCapability: string; readonly privateKey: Uint8Array; readonly publicKey: Uint8Array
  readonly pairingContext: string; readonly fingerprint: string; readonly expiresAt: number
}
const abortCleanups = new WeakMap<PendingDeviceApproval, () => void>()
const expiryTimers = new WeakMap<PendingDeviceApproval, ReturnType<typeof setTimeout>>()
const PayloadSchema = z.strictObject({ version: z.literal(1), accountId: OpaqueIdSchema, pairingContext: OpaqueIdSchema, requestId: OpaqueIdSchema, expiresAt: z.number().int().nonnegative(), key: DigestSchema, completionSecret: DigestSchema })
const pollIntervalMs = 5_000
const maxStatusPolls = deviceApprovalLifetimeMs / pollIntervalMs
function assertPending(pending: PendingDeviceApproval): void {
  if (pending.expiresAt <= Date.now() || !pending.requestCapability) { clearDeviceApproval(pending); throw new Error('DEVICE_APPROVAL_EXPIRED') }
}
export function clearDeviceApproval(pending: PendingDeviceApproval): void {
  // Requester secrets stay only in this owned transient object; no URL, guest store or object URL is created
  abortCleanups.get(pending)?.(); abortCleanups.delete(pending)
  pending.privateKey.fill(0)
  pending.requestCapability = ''
  clearTimeout(expiryTimers.get(pending)); expiryTimers.delete(pending)
}
export async function beginDeviceApproval(email: string, signal?: AbortSignal): Promise<PendingDeviceApproval> {
  signal?.throwIfAborted()
  const sodium = await getSodium()
  signal?.throwIfAborted()
  const keys = sodium.crypto_box_keypair()
  let capabilityBytes: Uint8Array = new Uint8Array(0)
  let requestCapability = ''
  let pending: PendingDeviceApproval | undefined
  // Own generated material before hashing or transport can suspend; cancellation must not await either
  const cancel = () => {
    keys.privateKey.fill(0); capabilityBytes.fill(0); requestCapability = ''
    if (pending) clearDeviceApproval(pending)
  }
  const detach = () => signal?.removeEventListener('abort', cancel)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    capabilityBytes = sodium.randombytes_buf(digestBytes)
    requestCapability = encodeBytes(sodium, capabilityBytes)
    const requestId = encodeBytes(sodium, sodium.randombytes_buf(opaqueIdBytes))
    const requestPublicKey = encodeBytes(sodium, keys.publicKey)
    const requestCapabilityHash = await deviceSecretHash(requestCapability)
    signal?.throwIfAborted()
    const started = await accountRequest('auth/devices/start', { email, requestId, requestPublicKey, requestCapabilityHash }, DeviceStartedSchema, undefined, 'POST', signal)
    if (started.requestId !== requestId || started.expiresAt <= Date.now() || started.expiresAt > Date.now() + deviceApprovalLifetimeMs) throw new Error('INVALID_REQUEST')
    const fingerprint = await deviceFingerprint({ ...started, requestPublicKey })
    signal?.throwIfAborted()
    pending = { ...started, requestCapability, privateKey: keys.privateKey, publicKey: keys.publicKey, fingerprint }
    // Retain cancellation through the promise handoff; clear/expiry removes the listener with the secrets
    abortCleanups.set(pending, detach)
    const owned = pending
    expiryTimers.set(owned, setTimeout(() => clearDeviceApproval(owned), Math.max(0, owned.expiresAt - Date.now())))
    return owned
  } catch (error) { cancel(); detach(); signal?.throwIfAborted(); throw error } finally { capabilityBytes.fill(0) }
}
export async function getApprovalRequest(unlocked: UnlockResult, requestId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const result = await accountRequest(`account/devices/requests/${OpaqueIdSchema.parse(requestId)}`, undefined, ApprovalRequestSchema, undefined, 'GET', signal)
  if (result.accountId !== unlocked.accountId || result.requestId !== requestId || result.expiresAt <= Date.now() || result.fingerprint !== await deviceFingerprint(result)) throw new Error('INVALID_REQUEST')
  return result
}
export async function sealDeviceApproval(key: Uint8Array, request: ApprovalRequest): Promise<{ sealedPayload: string; completionHash: string }> {
  const sodium = await getSodium(), completionBytes = sodium.randombytes_buf(digestBytes)
  let plaintext: Uint8Array | undefined
  try {
    const payload = PayloadSchema.parse({ version: 1, accountId: request.accountId, pairingContext: request.pairingContext, requestId: request.requestId, expiresAt: request.expiresAt, key: encodeBytes(sodium, key), completionSecret: encodeBytes(sodium, completionBytes) })
    plaintext = new TextEncoder().encode(JSON.stringify(payload))
    return { sealedPayload: encodeBytes(sodium, sodium.crypto_box_seal(plaintext, decodeBytes(sodium, request.requestPublicKey))), completionHash: await deviceSecretHash(payload.completionSecret) }
  } finally { completionBytes.fill(0); plaintext?.fill(0) }
}
export async function approveDevice(unlocked: UnlockResult, request: ApprovalRequest, comparedFingerprint: string, signal?: AbortSignal): Promise<void> {
  // Re-fetch server-owned context immediately before sealing; cached local keys alone grant no authority
  const current = await getApprovalRequest(unlocked, request.requestId, signal)
  if (comparedFingerprint !== current.fingerprint || request.fingerprint !== current.fingerprint || request.accountId !== current.accountId || request.requestPublicKey !== current.requestPublicKey || request.pairingContext !== current.pairingContext || request.expiresAt !== current.expiresAt) throw new Error('FINGERPRINT_MISMATCH')
  const sealed = await sealDeviceApproval(unlocked.key, current)
  await accountRequest('account/devices/approve', { requestId: current.requestId, requestPublicKey: current.requestPublicKey, ...sealed }, DeviceApprovalReceiptSchema, unlocked.csrf, 'POST', signal)
}
export async function openDeviceApproval(pending: PendingDeviceApproval, approved: { accountId: string; sealedPayload: string }): Promise<{ key: Uint8Array; completionSecret: string }> {
  assertPending(pending)
  const sodium = await getSodium()
  const plaintext = sodium.crypto_box_seal_open(decodeBytes(sodium, approved.sealedPayload), pending.publicKey, pending.privateKey)
  try {
    const payload = PayloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)))
    // A valid anonymous sealed box alone does not bind account, request or expiration
    // Compare all server-authoritative context before releasing either the root or completion proof
    if (payload.accountId !== approved.accountId || payload.pairingContext !== pending.pairingContext || payload.requestId !== pending.requestId || payload.expiresAt !== pending.expiresAt) throw new Error('INVALID_REQUEST')
    assertPending(pending)
    return { key: decodeBytes(sodium, payload.key), completionSecret: payload.completionSecret }
  } finally { plaintext.fill(0) }
}
export async function deviceApprovalStatus(pending: PendingDeviceApproval, signal?: AbortSignal) {
  assertPending(pending)
  const status = await accountRequest('auth/devices/status', { requestId: pending.requestId, requestCapability: pending.requestCapability }, DeviceStatusSchema, undefined, 'POST', signal)
  assertPending(pending)
  if (['expired', 'rejected', 'consumed'].includes(status.state)) clearDeviceApproval(pending)
  return status
}
export async function completeDeviceApproval(pending: PendingDeviceApproval, remember: boolean): Promise<UnlockResult> {
  const epoch = captureProfileEpoch()
  let key: Uint8Array | undefined
  try {
    const status = await deviceApprovalStatus(pending)
    if (status.state !== 'approved') throw new Error('DEVICE_APPROVAL_NOT_READY')
    const opened = await openDeviceApproval(pending, status); key = opened.key
    return await withAuthLock(async run => {
      const receipt = await run(signal => accountRequest('auth/devices/complete', { requestId: pending.requestId, requestCapability: pending.requestCapability, completionSecret: opened.completionSecret, remember }, SessionReceiptSchema, undefined, 'POST', signal))
      if (receipt.accountId !== status.accountId) throw new Error('INVALID_REQUEST')
      const actual = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      if (actual.accountId !== receipt.accountId || actual.sessionId !== receipt.sessionId) throw new Error('AUTH_SESSION_UNCERTAIN')
      epoch.assertCurrent()
      return { ...receipt, key: opened.key }
    }, epoch)
  } catch (error) { key?.fill(0); throw error } finally { clearDeviceApproval(pending) }
}
export async function waitForDeviceApproval(pending: PendingDeviceApproval, options: { signal: AbortSignal; isCurrentProfile: () => boolean }): Promise<void> {
  const visibility = (globalThis as unknown as { document?: EventTarget & { visibilityState: string } }).document
  const transport = new AbortController()
  let deadline: ReturnType<typeof setTimeout> | undefined
  let delay: ReturnType<typeof setTimeout> | undefined
  let finishDelay: (() => void) | undefined
  let rejectCancellation!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
  const cancel = (code: string) => {
    if (transport.signal.aborted) return
    const error = new Error(code)
    clearDeviceApproval(pending)
    // Settle independently of fetch cooperation, while also cancelling the real network/body read
    rejectCancellation(error)
    transport.abort(error)
  }
  // The profile owner must abort this signal on lock, sign-out or profile change
  // The predicate is an additional result fence, not an observable lifecycle notification
  const onAbort = () => cancel('DEVICE_APPROVAL_CANCELLED')
  const onVisibility = () => { if (visibility?.visibilityState !== 'visible') cancel('DEVICE_APPROVAL_CANCELLED') }
  const assertActive = () => {
    transport.signal.throwIfAborted()
    if (options.signal.aborted || !options.isCurrentProfile() || (visibility && visibility.visibilityState !== 'visible')) throw new Error('DEVICE_APPROVAL_CANCELLED')
  }
  const poll = async () => {
    for (let attempt = 0; attempt < maxStatusPolls; attempt++) {
      assertActive()
      const status = await deviceApprovalStatus(pending, transport.signal)
      assertActive()
      if (status.state !== 'approved' && status.state !== 'pending') throw new Error('DEVICE_APPROVAL_NOT_READY')
      assertPending(pending)
      if (status.state === 'approved') return
      await new Promise<void>(resolve => {
        finishDelay = resolve
        delay = setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, pending.expiresAt - Date.now())))
      })
    }
    throw new Error('DEVICE_APPROVAL_EXPIRED')
  }
  try {
    assertPending(pending)
    assertActive()
    options.signal.addEventListener('abort', onAbort, { once: true })
    visibility?.addEventListener('visibilitychange', onVisibility)
    deadline = setTimeout(() => cancel('DEVICE_APPROVAL_EXPIRED'), Math.max(0, pending.expiresAt - Date.now()))
    // Recheck after registration in case a caller's validity check already aborted its signal
    if (options.signal.aborted) onAbort()
    await Promise.race([poll(), cancelled])
  } catch (error) { clearDeviceApproval(pending); throw error } finally {
    options.signal.removeEventListener('abort', onAbort)
    visibility?.removeEventListener('visibilitychange', onVisibility)
    clearTimeout(deadline)
    clearTimeout(delay)
    transport.abort()
    // A cancelled delay must release the losing poll promise so its frame can be collected
    finishDelay?.()
  }
}
export async function rejectDeviceApproval(unlocked: UnlockResult, requestId: string, signal?: AbortSignal): Promise<void> {
  await accountRequest('account/devices/reject', { requestId }, DeviceRejectedReceiptSchema, unlocked.csrf, 'POST', signal)
}
export async function removeDevice(unlocked: UnlockResult, deviceId: string, signal?: AbortSignal): Promise<void> {
  await accountRequest(`account/devices/${OpaqueIdSchema.parse(deviceId)}`, undefined, DeviceRemovedReceiptSchema, unlocked.csrf, 'DELETE', signal)
}
export async function listDevices(unlocked: UnlockResult, cursor?: string, signal?: AbortSignal) {
  // The cookie owns account scope; validate it against the captured unlock before showing management state
  const page = await accountRequest(`account/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, DevicePageSchema, undefined, 'GET', signal)
  if (page.currentDevice.id !== unlocked.deviceId) throw new Error('AUTH_REQUIRED')
  return page
}

export async function listApprovalRequests(unlocked: UnlockResult, signal?: AbortSignal) {
  const page = await accountRequest('account/devices/requests', undefined, ApprovalRequestListSchema, undefined, 'GET', signal)
  for (const request of page.requests) {
    if (request.accountId !== unlocked.accountId || request.fingerprint !== await deviceFingerprint(request)) throw new Error('INVALID_REQUEST')
  }
  return page
}
