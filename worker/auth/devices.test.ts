import { afterEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { accountMetadata, loginAccount, registerAccount } from '../../src/account/auth-client'
import { approveDevice, beginDeviceApproval, completeDeviceApproval, getApprovalRequest, rejectDeviceApproval, removeDevice, listDevices, listApprovalRequests, deviceApprovalStatus, openDeviceApproval, waitForDeviceApproval } from '../../src/account/device-approval'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'

const fixtures: ServiceFixture[] = []
const email = 'device@example.org', password = 'synthetic device password'
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
async function fixture() {
  const f = await createServiceFixture(); fixtures.push(f)
  const cookies = { approver: '', requester: '' }
  let actor: keyof typeof cookies = 'approver'
  const bodies: { path: string; input: Record<string, unknown> }[] = []
  const transport = async (path: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set('origin', 'http://127.0.0.1'); headers.set('cookie', cookies[actor])
    if (init?.body) bodies.push({ path: String(path), input: JSON.parse(String(init.body)) })
    const response = await f.request(String(path), { ...init, headers })
    if (response.headers.has('set-cookie')) cookies[actor] = response.headers.get('set-cookie')!.split(';')[0]
    return response
  }
  vi.stubGlobal('fetch', transport)
  await registerAccount({ email, username: 'device_user', password, remember: false }); await f.runJobs()
  expect((await transport('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: (await f.emails())[0].capability }) })).status).toBe(200)
  const unlocked = await loginAccount({ email, password, remember: false })
  const post = (path: string, input: object) => transport(`/api/v1/${path}`, { method: 'POST', headers: { 'x-csrf-token': unlocked.csrf, 'content-type': 'application/json' }, body: JSON.stringify(input) })
  return { f, unlocked, cookies, bodies, post, transport, as: (next: keyof typeof cookies) => { actor = next } }
}
async function approved(h: Awaited<ReturnType<typeof fixture>>) {
  h.as('requester'); const pending = await beginDeviceApproval(email)
  h.as('approver'); const request = await getApprovalRequest(h.unlocked, pending.requestId)
  await approveDevice(h.unlocked, request, pending.fingerprint)
  return pending
}
it('requiresVerifiedFingerprintAndAuthenticatedApprover', async () => {
  const h = await fixture()
  h.as('requester'); const pending = await beginDeviceApproval(email)
  expect(pending.expiresAt - Date.now()).toBeGreaterThan(590_000)
  expect(pending.fingerprint.replace(/ /g, '').length).toBeGreaterThanOrEqual(16)
  h.as('approver'); const request = await getApprovalRequest(h.unlocked, pending.requestId)
  await expect(approveDevice(h.unlocked, request, '0000 0000 0000 0000')).rejects.toThrow()
  await expect(approveDevice(h.unlocked, { ...request, requestPublicKey: randomBytes(32).toString('base64url') }, pending.fingerprint)).rejects.toThrow()
  expect((await h.post('account/devices/approve', { requestId: pending.requestId, requestPublicKey: randomBytes(32).toString('base64url'), sealedPayload: randomBytes(100).toString('base64url'), completionHash: randomBytes(32).toString('base64url') })).status).toBe(400)
  await approveDevice(h.unlocked, request, pending.fingerprint)
  const input = h.bodies.find(body => body.path.endsWith('/devices/approve'))!.input
  expect((await h.post('account/devices/approve', { ...input, requestPublicKey: randomBytes(32).toString('base64url') })).status).toBe(400)
  h.as('requester'); const requester = await completeDeviceApproval(pending, false)
  expect(requester.key).toEqual(h.unlocked.key)
  expect((await accountMetadata(requester)).credentials.passwordRevision).toBe(1)
  h.as('approver'); h.f.advance(24 * 60 * 60 * 1000)
  expect((await h.post('account/devices/approve', input)).status).toBe(401)
})
it('expiresAndConsumesCompletionExactlyOnce', async () => {
  const h = await fixture(), pending = await approved(h)
  h.as('requester')
  expect((await h.post('auth/devices/complete', { requestId: pending.requestId, requestCapability: pending.requestCapability, completionSecret: randomBytes(32).toString('base64url'), remember: false })).status).toBe(400)
  const stolen = { ...pending, privateKey: new Uint8Array(32) }
  await expect(completeDeviceApproval(stolen, false)).rejects.toThrow()
  const requester = await completeDeviceApproval(pending, false)
  expect(requester.key).toEqual(h.unlocked.key)
  const command = h.bodies.find(body => body.path.endsWith('/devices/complete') && body.input.completionSecret !== undefined && body.input.completionSecret !== '')!
  const finalCommand = h.bodies.filter(body => body.path.endsWith('/devices/complete')).at(-1)!
  expect(command).toBeDefined()
  expect((await h.post('auth/devices/complete', finalCommand.input)).status).toBe(400)
  h.as('approver'); const next = await approved(h)
  h.as('requester'); const status = await deviceApprovalStatus(next)
  if (status.state !== 'approved') throw new Error('Expected approval')
  const opened = await openDeviceApproval(next, status)
  h.f.advance(10 * 60 * 1000)
  expect((await h.post('auth/devices/complete', { requestId: next.requestId, requestCapability: next.requestCapability, completionSecret: opened.completionSecret, remember: false })).status).toBe(400)
})
it('removingDeviceCancelsItsSessionsAndPendingApprovals', async () => {
  const h = await fixture(), first = await approved(h)
  h.as('requester'); const requester = await completeDeviceApproval(first, false)
  const pending = await approved(h)
  h.as('approver'); await removeDevice(h.unlocked, h.unlocked.deviceId)
  expect((await h.transport('/api/v1/account')).status).toBe(401)
  h.as('requester'); expect((await accountMetadata(requester)).accountId).toBe(h.unlocked.accountId)
  await expect(completeDeviceApproval(pending, false)).rejects.toThrow()
  expect(await h.f.db.prepare('SELECT state FROM device_approvals WHERE id = ?').bind(pending.requestId).first('state')).toBe('rejected')
})
it('rejectsUnknownForeignRejectedAndSubstitutedApprovalContext', async () => {
  const h = await fixture()
  h.as('requester'); const missing = await beginDeviceApproval('missing@example.net')
  h.as('approver'); await expect(getApprovalRequest(h.unlocked, missing.requestId)).rejects.toThrow('INVALID_REQUEST')
  const pending = await beginDeviceApproval(email)
  await rejectDeviceApproval(h.unlocked, pending.requestId)
  await expect(completeDeviceApproval(pending, false)).rejects.toThrow()
  const second = await approved(h)
  const third = await approved(h)
  await h.f.db.prepare('UPDATE device_approvals SET sealed_payload = (SELECT sealed_payload FROM device_approvals WHERE id = ?) WHERE id = ?').bind(third.requestId, second.requestId).run()
  h.as('requester'); await expect(completeDeviceApproval(second, false)).rejects.toThrow()
})
it('rollsBackCompletionAndRevocationOnActualSqlFailure', async () => {
  const h = await fixture(), pending = await approved(h)
  await h.f.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON customer_sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  h.as('requester'); await expect(completeDeviceApproval(pending, false)).rejects.toThrow()
  expect(await h.f.db.prepare('SELECT state FROM device_approvals WHERE id = ?').bind(pending.requestId).first('state')).toBe('approved')
  await h.f.db.exec('DROP TRIGGER fail_session')
  h.as('approver')
  await h.f.db.exec("CREATE TRIGGER fail_revocation BEFORE UPDATE OF revoked_at ON customer_sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expect(removeDevice(h.unlocked, h.unlocked.deviceId)).rejects.toThrow()
  expect(await h.f.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').bind(h.unlocked.deviceId).first('revoked_at')).toBeNull()
})
it('paginatesNewestDevicesWithoutHidingCurrentOrOmittedResults', async () => {
  const h = await fixture()
  const ids = Array.from({ length: 105 }, () => randomBytes(16).toString('base64url'))
  await h.f.db.batch(ids.map((id, index) => h.f.db.prepare('INSERT INTO devices (id, account_id, created_at) VALUES (?, ?, ?)').bind(id, h.unlocked.accountId, Date.now() + index + 1)))
  const metadata = await accountMetadata(h.unlocked)
  expect(metadata.devicePage.currentDevice.id).toBe(h.unlocked.deviceId)
  expect(metadata.devicePage.devices[0].id).toBe(ids.at(-1))
  expect(metadata.devicePage.hasMore).toBe(true)
  const seen = new Set(metadata.devicePage.devices.map(d => d.id))
  let cursor = metadata.devicePage.nextCursor
  while (cursor) { const page = await listDevices(h.unlocked, cursor); page.devices.forEach(d => seen.add(d.id)); cursor = page.nextCursor }
  expect(seen.size).toBe(106)
  await expect(listDevices(h.unlocked, 'tampered')).rejects.toThrow('INVALID_REQUEST')
})
it('expiresDeviceCursorAndRejectsForeignAccountCursor', async () => {
  const h = await fixture()
  await h.f.db.batch(Array.from({ length: 51 }, (_, index) => h.f.db.prepare('INSERT INTO devices (id, account_id, created_at) VALUES (?, ?, ?)').bind(randomBytes(16).toString('base64url'), h.unlocked.accountId, Date.now() + index)))
  const cursor = (await listDevices(h.unlocked)).nextCursor!
  h.as('requester')
  await registerAccount({ email: 'foreign@example.net', username: 'foreign_user', password, remember: false }); await h.f.runJobs()
  expect((await h.post('auth/verify', { capability: (await h.f.emails()).find(mail => mail.recipient === 'foreign@example.net')!.capability })).status).toBe(200)
  const foreign = await loginAccount({ email: 'foreign@example.net', password, remember: false })
  await expect(listDevices(foreign, cursor)).rejects.toThrow('INVALID_REQUEST')
  h.as('approver'); const pending = await beginDeviceApproval(email)
  h.as('requester'); await expect(getApprovalRequest(foreign, pending.requestId)).rejects.toThrow('INVALID_REQUEST')
  expect((await listApprovalRequests(foreign)).requests).toEqual([])
  h.as('approver'); h.f.advance(600_000)
  await expect(listDevices(h.unlocked, cursor)).rejects.toThrow('INVALID_REQUEST')
})
it.each(['revoked', 'blocked', 'expired'])('rechecksApprovalAuthorityAfterCapturedPrincipal: %s', async mode => {
  const h = await fixture()
  h.as('requester'); const pending = await beginDeviceApproval(email)
  h.as('approver')
  const mutation = mode === 'revoked' ? 'UPDATE devices SET revoked_at = 1' : mode === 'blocked' ? "UPDATE accounts SET access = 'blocked'" : 'UPDATE customer_sessions SET absolute_expires_at = 1'
  await h.f.db.exec(`CREATE TRIGGER change_authority AFTER UPDATE OF idle_expires_at ON customer_sessions BEGIN ${mutation}; END`)
  expect((await h.post('account/devices/approve', { requestId: pending.requestId, requestPublicKey: Buffer.from(pending.publicKey).toString('base64url'), sealedPayload: randomBytes(100).toString('base64url'), completionHash: randomBytes(32).toString('base64url') })).status).toBe(400)
  expect(await h.f.db.prepare('SELECT state FROM device_approvals WHERE id = ?').bind(pending.requestId).first('state')).toBe('pending')
})
it.each(['revoked-session', 'blocked-account', 'expired-session'])('rechecksApproverAuthorityDuringCompletion: %s', async mode => {
  const h = await fixture(), pending = await approved(h)
  await h.f.db.exec(mode === 'revoked-session' ? 'UPDATE customer_sessions SET revoked_at = 1' : mode === 'blocked-account' ? "UPDATE accounts SET access = 'blocked'" : 'UPDATE customer_sessions SET absolute_expires_at = 1')
  h.as('requester'); await expect(completeDeviceApproval(pending, false)).rejects.toThrow('INVALID_REQUEST')
  expect(h.cookies.requester).toBe('')
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(1)
})
it('allowsBoundedStatusPollingWithoutSpendingStartOrCompletionBudgets', async () => {
  const h = await fixture(), pending = await approved(h)
  h.as('requester')
  for (let attempt = 0; attempt < 120; attempt++) expect((await h.post('auth/devices/status', { requestId: pending.requestId, requestCapability: pending.requestCapability })).status).toBe(200)
  expect((await completeDeviceApproval(pending, true)).key).toEqual(h.unlocked.key)
})

it('listsOnlyOwnedEligiblePublicRequestsWithExplicitOverflow', async () => {
  const h = await fixture()
  const pending = await beginDeviceApproval(email)
  await beginDeviceApproval('unknown@example.net')
  const page = await listApprovalRequests(h.unlocked)
  expect(page.requests.map(request => request.requestId)).toEqual([pending.requestId])
  expect(page.hasMore).toBe(false)
  expect(JSON.stringify(page)).not.toContain(pending.requestCapability)
  await h.f.db.batch(Array.from({ length: 21 }, () => h.f.db.prepare('INSERT INTO device_approvals (id, account_id, pairing_context, request_public_key, capability_hash, expires_at) SELECT ?, account_id, pairing_context, request_public_key, capability_hash, expires_at FROM device_approvals WHERE id = ?').bind(randomBytes(16).toString('base64url'), pending.requestId)))
  expect((await listApprovalRequests(h.unlocked)).hasMore).toBe(true)
  expect((await listApprovalRequests(h.unlocked)).requests.length).toBe(20)
  h.f.advance(600_000)
  expect((await listApprovalRequests(h.unlocked)).requests).toEqual([])
})
it('consumesConcurrentCompletionOnceAndNeverStoresPlaintextSecrets', async () => {
  const h = await fixture(), pending = await approved(h)
  h.as('requester'); const status = await deviceApprovalStatus(pending)
  if (status.state !== 'approved') throw new Error('Expected approval')
  const opened = await openDeviceApproval(pending, status)
  const dump = JSON.stringify(await h.f.db.prepare('SELECT * FROM device_approvals').all())
  for (const secret of [pending.requestCapability, Buffer.from(pending.privateKey).toString('base64url'), opened.completionSecret, Buffer.from(opened.key).toString('base64url')]) expect(dump).not.toContain(secret)
  const input = { requestId: pending.requestId, requestCapability: pending.requestCapability, completionSecret: opened.completionSecret, remember: false }
  const responses = await Promise.all([h.post('auth/devices/complete', input), h.post('auth/devices/complete', input)])
  expect(responses.map(response => response.status).sort()).toEqual([200, 400])
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(2)
})
it('stopsPollingOnHiddenPageProfileChangeOrRejectionAndClearsPrivateMaterial', async () => {
  const h = await fixture()
  for (const reason of ['hidden', 'profile', 'rejected']) {
    const pending = await beginDeviceApproval(email)
    if (reason === 'rejected') await rejectDeviceApproval(h.unlocked, pending.requestId)
    const visibility = Object.assign(new EventTarget(), { visibilityState: reason === 'hidden' ? 'hidden' : 'visible' })
    vi.stubGlobal('document', visibility)
    await expect(waitForDeviceApproval(pending, { signal: new AbortController().signal, isCurrentProfile: () => reason !== 'profile' })).rejects.toThrow()
    expect(pending.privateKey.every(byte => byte === 0)).toBe(true)
    expect(pending.requestCapability).toBe('')
  }
})
it('cancelsAnInFlightPollWhenThePageWasHiddenEvenIfVisibleAgain', async () => {
  const h = await fixture(), pending = await approved(h)
  h.as('requester')
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', visibility)
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const response = await h.transport(path, init)
    visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'))
    visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange'))
    return response
  })
  await expect(waitForDeviceApproval(pending, { signal: new AbortController().signal, isCurrentProfile: () => true })).rejects.toThrow('DEVICE_APPROVAL_CANCELLED')
  expect(pending.privateKey.every(byte => byte === 0)).toBe(true)
})
it('requiresExactRoutesOriginCapabilityAndStrictApprovalBodies', async () => {
  const h = await fixture(), pending = await beginDeviceApproval(email)
  const start = h.bodies.find(body => body.path.endsWith('/devices/start'))!.input
  expect((await h.post('auth/devices/extra/start', { ...start, requestId: randomBytes(16).toString('base64url') })).status).toBe(401)
  expect((await h.post('auth/devices/start', { ...start, requestId: randomBytes(16).toString('base64url'), password })).status).toBe(400)
  expect((await h.f.request('/api/v1/auth/devices/status', { method: 'POST', headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: pending.requestId, requestCapability: pending.requestCapability }) })).status).toBe(403)
  expect((await h.post('auth/devices/status', { requestId: pending.requestId, requestCapability: randomBytes(32).toString('base64url') })).status).toBe(400)
})

it.each(['A'.repeat(65), 'A'.repeat(65) + 'B', 'A'.repeat(66) + 'B'])('rejectsMalformedCiphertextBeforePersistingApproval: %s', async sealedPayload => {
  const h = await fixture(), pending = await beginDeviceApproval(email)
  expect((await h.post('account/devices/approve', { requestId: pending.requestId, requestPublicKey: Buffer.from(pending.publicKey).toString('base64url'), sealedPayload, completionHash: randomBytes(32).toString('base64url') })).status).toBe(400)
  expect(await h.f.db.prepare('SELECT state FROM device_approvals WHERE id = ?').bind(pending.requestId).first('state')).toBe('pending')
  expect(await h.f.db.prepare('SELECT sealed_payload FROM device_approvals WHERE id = ?').bind(pending.requestId).first('sealed_payload')).toBeNull()
})
