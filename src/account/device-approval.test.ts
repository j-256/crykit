import { afterEach, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { DeviceApproveSchema, DeviceStatusSchema, deviceFingerprint } from './protocol'
import { beginDeviceApproval, clearDeviceApproval, openDeviceApproval, sealDeviceApproval, waitForDeviceApproval, type PendingDeviceApproval } from './device-approval'
import { getSodium, encodeBytes } from './crypto/sodium'

it('bindsSealedTransferToExactAccountRequestExpiryAndIndependentCompletionSecret', async () => {
  const sodium = await getSodium(), keys = sodium.crypto_box_keypair()
  const request = { accountId: encodeBytes(sodium, new Uint8Array(16)), requestId: encodeBytes(sodium, new Uint8Array(16).fill(1)), pairingContext: encodeBytes(sodium, new Uint8Array(16).fill(2)), requestPublicKey: encodeBytes(sodium, keys.publicKey), expiresAt: Date.now() + 600_000, fingerprint: '' }
  request.fingerprint = await deviceFingerprint(request)
  const key = new Uint8Array(32).fill(3)
  const sealed = await sealDeviceApproval(key, request)
  const pending = { ...request, privateKey: keys.privateKey, publicKey: keys.publicKey, requestCapability: encodeBytes(sodium, new Uint8Array(32).fill(4)) }
  const opened = await openDeviceApproval(pending, { ...sealed, accountId: request.accountId })
  expect(opened.key).toEqual(key)
  expect(opened.completionSecret).not.toEqual(encodeBytes(sodium, key))
  for (const override of [{ accountId: encodeBytes(sodium, new Uint8Array(16).fill(5)) }, { sealedPayload: encodeBytes(sodium, sodium.randombytes_buf(100)) }]) {
    await expect(openDeviceApproval(pending, { ...sealed, accountId: request.accountId, ...override })).rejects.toThrow()
  }
  await expect(openDeviceApproval({ ...pending, expiresAt: pending.expiresAt + 1 }, { ...sealed, accountId: request.accountId })).rejects.toThrow()
  clearDeviceApproval(pending)
  expect(pending.privateKey.every(value => value === 0)).toBe(true)
  expect(pending.requestCapability).toBe('')
})

it('usesTheExplicitFingerprintTupleAndAtLeast64ComparisonBits', async () => {
  expect(await deviceFingerprint({ pairingContext: 'context', requestId: 'request', requestPublicKey: 'public' })).toBe('81D2 A43F 7D7F E30F')
  expect(await deviceFingerprint({ pairingContext: 'request', requestId: 'context', requestPublicKey: 'public' })).not.toBe('81D2 A43F 7D7F E30F')
})


afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function pendingRequest(): PendingDeviceApproval {
  return { requestId: 'A'.repeat(22), requestCapability: 'A'.repeat(43), privateKey: new Uint8Array(32).fill(7), publicKey: new Uint8Array(32), pairingContext: 'B'.repeat(21) + 'A', fingerprint: '0000 0000 0000 0000', expiresAt: Date.now() + 600_000 }
}
const approvedStatus = { state: 'approved', accountId: 'A'.repeat(22), sealedPayload: 'A'.repeat(64) }
it.each(['abort', 'hidden', 'expiry', 'profile-abort'])('settlesUnresolvedStatusAndDisposesResourcesOn: %s', async trigger => {
  vi.useFakeTimers()
  const pending = pendingRequest(), controller = new AbortController()
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', visibility)
  let release!: (response: Response) => void
  let reject!: (error: Error) => void
  let transportSignal: AbortSignal | null | undefined
  let receivedRequests = 0
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
    receivedRequests++; transportSignal = init.signal
    // Deliberately ignore abort to prove settlement and late-result fencing independently of fetch cooperation
    return new Promise<Response>((resolve, fail) => { release = resolve; reject = fail })
  })
  let currentProfile = true, outcome = 'pending'
  const waiting = waitForDeviceApproval(pending, { signal: controller.signal, isCurrentProfile: () => currentProfile })
    .then(() => { outcome = 'success' }, (error: Error) => { outcome = error.message })
  expect(receivedRequests).toBe(1)
  if (trigger === 'expiry') await vi.advanceTimersByTimeAsync(600_000)
  else if (trigger === 'hidden') { visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange')) }
  else { if (trigger === 'profile-abort') currentProfile = false; controller.abort() }
  await vi.advanceTimersByTimeAsync(0)
  // No response has been released: this assertion catches a wait that only notices cancellation after HTTP resolves
  expect(outcome).toBe(trigger === 'expiry' ? 'DEVICE_APPROVAL_EXPIRED' : 'DEVICE_APPROVAL_CANCELLED')
  expect(pending.privateKey.every(byte => byte === 0)).toBe(true)
  expect(pending.requestCapability).toBe('')
  expect(transportSignal?.aborted).toBe(true)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(getEventListeners(visibility, 'visibilitychange')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  const lateResponse = new Response(JSON.stringify(approvedStatus))
  if (trigger === 'hidden') reject(new Error('Late transport failure'))
  else release(lateResponse)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(outcome).not.toBe('success')
  expect(lateResponse.bodyUsed).toBe(false)
  expect(receivedRequests).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  await waiting
})
it('fencesProfileValidityBeforeAcceptingAResponseAndKeepsSuccessfulApprovalMaterial', async () => {
  vi.useFakeTimers()
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', visibility)
  for (const currentProfile of [true, false]) {
    const pending = pendingRequest(), controller = new AbortController()
    let release!: (response: Response) => void
    let valid = true
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { release = resolve }))
    let outcome = 'pending'
    const waiting = waitForDeviceApproval(pending, { signal: controller.signal, isCurrentProfile: () => valid })
      .then(() => { outcome = 'success' }, (error: Error) => { outcome = error.message })
    valid = currentProfile
    release(new Response(JSON.stringify(approvedStatus)))
    await waiting
    expect(outcome).toBe(currentProfile ? 'success' : 'DEVICE_APPROVAL_CANCELLED')
    expect(pending.privateKey.every(byte => byte === 0)).toBe(!currentProfile)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(visibility, 'visibilitychange')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    clearDeviceApproval(pending)
  }
})
it('disposesTheInterPollDelayWhenAborted', async () => {
  vi.useFakeTimers()
  const pending = pendingRequest(), controller = new AbortController()
  let receivedRequests = 0
  vi.stubGlobal('fetch', async () => { receivedRequests++; return new Response(JSON.stringify({ state: 'pending' })) })
  const waiting = waitForDeviceApproval(pending, { signal: controller.signal, isCurrentProfile: () => true }).catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  expect(await waiting).toBe('DEVICE_APPROVAL_CANCELLED')
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(receivedRequests).toBe(1)
})
it.each(['A'.repeat(65), 'A'.repeat(65) + 'B', 'A'.repeat(66) + 'B'])('rejectsNoncanonicalSealedPayloadAtBothWireBoundaries: %s', sealedPayload => {
  const approval = { requestId: 'A'.repeat(22), requestPublicKey: 'A'.repeat(43), completionHash: 'A'.repeat(43), sealedPayload }
  expect(DeviceApproveSchema.safeParse(approval).success).toBe(false)
  expect(DeviceStatusSchema.safeParse({ ...approvedStatus, sealedPayload }).success).toBe(false)
})
it.each(['A'.repeat(64), 'A'.repeat(66), 'A'.repeat(67), 'A'.repeat(2048)])('acceptsBoundedCanonicalSealedPayload: %s', sealedPayload => {
  expect(DeviceStatusSchema.safeParse({ ...approvedStatus, sealedPayload }).success).toBe(true)
})
it('keepsRejectedStatusDistinctFromLocalDeadlineExpiry', async () => {
  vi.useFakeTimers()
  const pending = pendingRequest(), controller = new AbortController()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ state: 'rejected' })))
  await expect(waitForDeviceApproval(pending, { signal: controller.signal, isCurrentProfile: () => true })).rejects.toThrow('DEVICE_APPROVAL_NOT_READY')
  expect(pending.privateKey.every(byte => byte === 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('approvalStartKeepsCancellationOwnershipThroughHandoffAndDetachesAfterCleanup', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string)
    return new Response(JSON.stringify({ requestId: input.requestId, pairingContext: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: Date.now() + 600_000 }))
  })
  const pending = await beginDeviceApproval('synthetic@example.org', controller.signal)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  expect(pending.privateKey.some(byte => byte !== 0)).toBe(true)
  controller.abort(new Error('Synthetic transition'))
  expect(pending.privateKey.every(byte => byte === 0)).toBe(true)
  expect(pending.requestCapability).toBe('')
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  clearDeviceApproval(pending)
})
