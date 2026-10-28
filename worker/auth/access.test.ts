import { afterEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ready, server } from '@serenity-kit/opaque'
import * as opaque from '../../src/account/crypto/opaque'
import { deriveWrappingKey, wrapSecret, unwrapSecret } from '../../src/account/crypto/envelopes'
import { assertCustomerWrite, requireRecent } from './session'
import type { ServiceContext } from '../context'
import type { KeyEnvelope } from '../../src/account/protocol'
import { createServiceFixture, type FixtureOptions, type ServiceFixture } from '../testing/service-fixture'

const fixtures: ServiceFixture[] = []
const password = ' e\u0301 synthetic account password '
const id = () => randomBytes(16).toString('base64url')
async function fixture(options: FixtureOptions = {}) { const f = await createServiceFixture({ now: 1_800_000_000_000, ...options }); fixtures.push(f); return f }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
function post(f: ServiceFixture, path: string, body: object, headers: Record<string, string> = {}) {
  return f.request(`/api/v1/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
async function signup(f: ServiceFixture, email = 'person@example.org', username = 'person', finishNow = true) {
  const start = await opaque.startRegistration(password)
  const response = await post(f, 'auth/signup/start', { email, username, registrationRequest: start.request })
  expect(response.status).toBe(200)
  const s = await response.json() as { attemptId: string; accountId: string; credentialId: string; registrationResponse: string }
  const registered = await opaque.finishRegistration(start.state, s.registrationResponse, password, s.credentialId)
  const key = randomBytes(32)
  const accountEnvelope = await wrapSecret(key, await deriveWrappingKey(registered.exportKey, s.accountId, 'password'), [1, s.accountId])
  const input = { attemptId: s.attemptId, transactionId: id(), registrationRecord: registered.record, accountEnvelope, remember: false }
  if (finishNow) {
    const finished = await post(f, 'auth/signup/finish', input)
    expect(finished.status).toBe(200)
    expect(finished.headers.get('set-cookie')).toBeNull()
  }
  return { ...s, input, key, exportKeyEncoded: Buffer.from(registered.exportKey).toString('base64url') }
}
async function verify(f: ServiceFixture) {
  await f.runJobs()
  const messages = await f.emails()
  const capability = messages.at(-1)!.capability!
  const response = await post(f, 'auth/verify', { capability })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toBeNull()
  return capability
}
async function login(f: ServiceFixture, remember = false, cookie?: string) {
  const start = await opaque.startLogin(password)
  const response = await post(f, 'auth/login/start', { email: ' PERSON@example.org ', role: 'password', startLoginRequest: start.request })
  expect(response.status).toBe(200)
  const s = await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(start.state, s.loginResponse, password, s.credentialId)
  const result = await post(f, 'auth/login/finish', { attemptId: s.attemptId, finishLoginRequest: finish.request, remember }, cookie ? { cookie } : {})
  expect(result.status).toBe(200)
  const receipt = await result.json() as { accountId: string; sessionId: string; csrf: string; accountEnvelope: KeyEnvelope; authenticatedAt: number }
  const key = await unwrapSecret(receipt.accountEnvelope, await deriveWrappingKey(finish.exportKey, receipt.accountId, 'password'), [1, receipt.accountId])
  return { ...receipt, key, cookie: result.headers.get('set-cookie')!.split(';')[0], setCookie: result.headers.get('set-cookie')! }
}

it('activatesOnlyVerifiedAtomicRegistration', async () => {
  const f = await fixture()
  const registered = await signup(f)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM credentials').first('n')).toBe(0)
  const retry = await post(f, 'auth/signup/finish', registered.input)
  expect(retry.status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM email_jobs').first('n')).toBe(1)
  const pendingLogin = await opaque.startLogin(password)
  const before = await post(f, 'auth/login/start', { email: 'person@example.org', role: 'password', startLoginRequest: pendingLogin.request })
  expect(before.headers.get('set-cookie')).toBeNull()
  const pendingResponse = await before.json() as { attemptId: string; credentialId: string; loginResponse: string }
  await expect(opaque.finishLogin(pendingLogin.state, pendingResponse.loginResponse, password, pendingResponse.credentialId)).rejects.toThrow('AUTH_FAILED')
  const pendingFinish = await post(f, 'auth/login/finish', { attemptId: pendingResponse.attemptId, finishLoginRequest: randomBytes(64).toString('base64url'), remember: false })
  expect(pendingFinish.status).toBe(401)
  expect(pendingFinish.headers.get('set-cookie')).toBeNull()
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(0)
  const capability = await verify(f)
  expect(await f.db.prepare('SELECT capacity_bytes FROM accounts WHERE id = ?').bind(registered.accountId).first('capacity_bytes')).toBe(512 * 1024 * 1024)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(400)
  expect(await f.db.prepare('SELECT eligible FROM email_jobs').first('eligible')).toBe(0)
  const signed = await login(f)
  expect(signed.key).toEqual(new Uint8Array(registered.key))
  expect(signed.setCookie).toContain('__Host-crykit-session=')
  expect(signed.setCookie).toContain('Secure; HttpOnly; SameSite=Lax; Path=/')
  expect(signed.setCookie).not.toContain('Domain')
  const tables = ['accounts', 'credentials', 'pending_registrations', 'auth_attempts', 'auth_transactions', 'verification_capabilities', 'customer_sessions', 'devices', 'email_jobs', 'email_audit', 'rate_counters']
  const dump = JSON.stringify(await Promise.all(tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all())))
  expect(dump).not.toContain(password)
  expect(dump).not.toContain(capability)
  expect(dump).not.toContain(registered.key.toString('base64url'))
  expect(dump).not.toContain(registered.exportKeyEncoded)
  expect(dump).not.toContain(signed.cookie.split('=')[1])
  const cap = await f.db.prepare('SELECT token_hash FROM verification_capabilities').first('token_hash')
  expect(cap).not.toBe(capability)
  const events = JSON.stringify(await f.events())
  for (const secret of [capability, password, registered.exportKeyEncoded, registered.key.toString('base64url'), signed.cookie.split('=')[1]]) expect(events).not.toContain(secret)
  expect(f.emailCaptureStats().outboundNetworkMessages).toBe(0)
})

it('rotatesSessionWithoutExtendingAbsoluteExpiry', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  const original = await login(f)
  const row = await f.db.prepare('SELECT * FROM customer_sessions WHERE id = ?').bind(original.sessionId).first<{ idle_expires_at: number; absolute_expires_at: number; authenticated_at: number }>()
  expect(row!.idle_expires_at - row!.authenticated_at).toBe(8 * 60 * 60 * 1000)
  expect(row!.absolute_expires_at - row!.authenticated_at).toBe(24 * 60 * 60 * 1000)
  f.advance(60_000)
  const rotated = await post(f, 'auth/renew', {}, { cookie: original.cookie, 'x-csrf-token': original.csrf })
  expect(rotated.status).toBe(200)
  const next = await rotated.json() as { sessionId: string; csrf: string }
  expect(rotated.headers.get('set-cookie')).not.toContain(original.cookie)
  expect(await f.db.prepare('SELECT absolute_expires_at FROM customer_sessions WHERE id = ?').bind(next.sessionId).first('absolute_expires_at')).toBe(row!.absolute_expires_at)
  expect((await f.request('/api/v1/account', { headers: { cookie: original.cookie } })).status).toBe(401)
  const remembered = await login(f, true, rotated.headers.get('set-cookie')!.split(';')[0])
  expect((await f.request('/api/v1/account', { headers: { cookie: rotated.headers.get('set-cookie')!.split(';')[0] } })).status).toBe(401)
  const rememberedRow = await f.db.prepare('SELECT idle_expires_at, absolute_expires_at, authenticated_at FROM customer_sessions WHERE id = ?').bind(remembered.sessionId).first<typeof row>()
  expect(rememberedRow!.idle_expires_at - rememberedRow!.authenticated_at).toBe(7 * 24 * 60 * 60 * 1000)
  expect(rememberedRow!.absolute_expires_at - rememberedRow!.authenticated_at).toBe(30 * 24 * 60 * 60 * 1000)
  expect((await post(f, 'auth/logout', { sessionId: next.sessionId }, { cookie: remembered.cookie, 'x-csrf-token': remembered.csrf })).status).toBe(200)
  expect((await f.request('/api/v1/account', { headers: { cookie: remembered.cookie } })).status).toBe(200)
  f.advance(7 * 24 * 60 * 60 * 1000)
  expect((await f.request('/api/v1/account', { headers: { cookie: remembered.cookie } })).status).toBe(401)
})

it('boundsSharedNetworkAndTargetAttempts', async () => {
  const request = (await opaque.startLogin(password)).request
  const target = await fixture()
  for (let i = 0; i < 10; i++) expect((await post(target, 'auth/login/start', { email: 'missing@example.org', role: 'password', startLoginRequest: request })).status).toBe(200)
  expect((await post(target, 'auth/login/start', { email: ' MISSING@example.org ', role: 'password', startLoginRequest: request })).status).toBe(429)
  target.advance(10 * 60 * 1000)
  expect((await post(target, 'auth/login/start', { email: 'unrelated@example.org', role: 'password', startLoginRequest: request })).status).toBe(200)
  const network = await fixture()
  for (let i = 0; i < 30; i++) expect((await post(network, 'auth/login/start', { email: `person${i}@example.org`, role: 'password', startLoginRequest: request })).status).toBe(200)
  expect((await post(network, 'auth/login/start', { email: 'last@example.org', role: 'password', startLoginRequest: request })).status).toBe(429)
})

it('rejectsCrossOriginAndForgedAccountAuthority', async () => {
  const f = await fixture(); await signup(f); await verify(f); const signed = await login(f)
  expect((await post(f, 'auth/renew', {}, { cookie: signed.cookie, 'x-csrf-token': signed.csrf, origin: 'https://other.example.org' })).status).toBe(403)
  expect((await post(f, 'auth/renew', {}, { cookie: signed.cookie })).status).toBe(403)
  expect((await f.request('/api/v1/account', { headers: { 'x-account-id': signed.accountId } })).status).toBe(401)
  expect((await post(f, 'auth/logout', { sessionId: signed.sessionId, accountId: signed.accountId }, { cookie: signed.cookie, 'x-csrf-token': signed.csrf })).status).toBe(400)
  await f.db.prepare("UPDATE accounts SET access = 'blocked' WHERE id = ?").bind(signed.accountId).run()
  expect((await f.request('/api/v1/account', { headers: { cookie: signed.cookie } })).status).toBe(403)
})

it('usesStableDistinctRoleBoundDummyIdentityAndNeutralOneShotFailure', async () => {
  const f = await fixture()
  const clientStart = await opaque.startLogin(password)
  const request = clientStart.request
  const start = async (email: string, role = 'password') => {
    const response = await post(f, 'auth/login/start', { email, role, startLoginRequest: request })
    expect(response.status).toBe(200)
    return await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
  }
  const first = await start('missing@example.org')
  expect((await start(' MISSING@example.org ')).credentialId).toBe(first.credentialId)
  expect((await start('other@example.org')).credentialId).not.toBe(first.credentialId)
  expect((await start('missing@example.org', 'recovery')).credentialId).toBe(first.credentialId.replace('/password/', '/recovery/'))
  for (let i = 0; i < 2; i++) {
    const failed = await post(f, 'auth/login/finish', { attemptId: first.attemptId, finishLoginRequest: randomBytes(64).toString('base64url'), remember: false })
    expect(failed.status).toBe(401)
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect((await failed.json() as { error: { code: string } }).error.code).toBe('AUTH_FAILED')
  }
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(0)
  const registered = await signup(f); await verify(f)
  const known = await start('person@example.org')
  const absentRole = await start('person@example.org', 'recovery')
  expect(known.credentialId).toBe(registered.credentialId)
  expect(absentRole.credentialId).toBe(known.credentialId.replace('/password/', '/recovery/'))
  expect((await start(' PERSON@example.org ', 'recovery')).credentialId).toBe(absentRole.credentialId)
  await expect(opaque.finishLogin(clientStart.state, absentRole.loginResponse, password, absentRole.credentialId)).rejects.toThrow('AUTH_FAILED')
  for (const attemptId of [absentRole.attemptId, first.attemptId]) {
    const failed = await post(f, 'auth/login/finish', { attemptId, finishLoginRequest: randomBytes(64).toString('base64url'), remember: false })
    expect(failed.status).toBe(401)
    expect(failed.headers.get('set-cookie')).toBeNull()
    expect(await failed.json()).toMatchObject({ error: { code: 'AUTH_FAILED' } })
  }
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(0)
})

it('expiresVerificationAndReservesNamesOnlyForThePendingLifetime', async () => {
  const f = await fixture(); await signup(f); await f.runJobs()
  const capability = (await f.emails())[0].capability!
  f.advance(30 * 60 * 1000)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(400)
  const start = await opaque.startRegistration(password)
  expect((await post(f, 'auth/signup/start', { email: 'new@example.org', username: 'person', registrationRequest: start.request })).status).toBe(400)
  f.advance(24 * 60 * 60 * 1000)
  expect((await post(f, 'auth/signup/start', { email: 'new@example.org', username: 'person', registrationRequest: start.request })).status).toBe(200)
  expect(await f.db.prepare('SELECT eligible FROM email_jobs').first('eligible')).toBe(0)
})

it('rollsBackAuthorityAndOutboxTogetherThenActivatesAtomically', async () => {
  const f = await fixture()
  await f.db.prepare("CREATE TRIGGER fail_email BEFORE INSERT ON email_jobs BEGIN SELECT RAISE(ABORT, 'synthetic outbox failure'); END").run()
  const start = await opaque.startRegistration(password)
  const response = await post(f, 'auth/signup/start', { email: 'person@example.org', username: 'person', registrationRequest: start.request })
  const s = await response.json() as { accountId: string; credentialId: string; attemptId: string; registrationResponse: string }
  const registration = await opaque.finishRegistration(start.state, s.registrationResponse, password, s.credentialId)
  const accountEnvelope = await wrapSecret(randomBytes(32), await deriveWrappingKey(registration.exportKey, s.accountId, 'password'), [1, s.accountId])
  const input = { attemptId: s.attemptId, transactionId: id(), registrationRecord: registration.record, accountEnvelope, remember: false }
  expect((await post(f, 'auth/signup/finish', input)).status).toBe(503)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM verification_capabilities').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM auth_transactions').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT registration_record FROM pending_registrations').first('registration_record')).toBeNull()
  await f.db.prepare('DROP TRIGGER fail_email').run()
  expect((await post(f, 'auth/signup/finish', input)).status).toBe(200)
  await f.runJobs()
  const capability = (await f.emails())[0].capability!
  await f.db.prepare("CREATE TRIGGER fail_credential BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT, 'synthetic credential failure'); END").run()
  expect((await post(f, 'auth/verify', { capability })).status).toBe(503)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT consumed_at FROM verification_capabilities').first('consumed_at')).toBeNull()
  expect(await f.db.prepare('SELECT eligible FROM email_jobs').first('eligible')).toBe(1)
  await f.db.prepare('DROP TRIGGER fail_credential').run()
  await f.db.prepare("CREATE TRIGGER fail_invalidation BEFORE UPDATE ON email_jobs WHEN NEW.eligible = 0 BEGIN SELECT RAISE(ABORT, 'synthetic invalidation failure'); END").run()
  expect((await post(f, 'auth/verify', { capability })).status).toBe(503)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM credentials').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT consumed_at FROM verification_capabilities').first('consumed_at')).toBeNull()
  expect(await f.db.prepare('SELECT eligible FROM email_jobs').first('eligible')).toBe(1)
  await f.db.prepare('DROP TRIGGER fail_invalidation').run()
  expect((await post(f, 'auth/verify', { capability })).status).toBe(200)
})

it('resendsWithBoundedAttemptsAndAtomicallyRevokesOldCapabilityLineages', async () => {
  const f = await fixture(); await signup(f); await f.runJobs()
  const old = (await f.emails())[0].capability!
  const root = await f.db.prepare('SELECT id FROM email_jobs').first<string>('id')
  const child = await f.request('/__accounts/email/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: root, resendId: id() }) })
  expect(child.status).toBe(200)
  for (let i = 0; i < 5; i++) {
    expect((await post(f, 'auth/resend', { email: 'person@example.org' })).status).toBe(200)
    expect((await post(f, 'auth/resend', { email: 'person@example.org' })).status).toBe(429)
    f.advance(60_000)
  }
  expect((await post(f, 'auth/resend', { email: 'person@example.org' })).status).toBe(429)
  expect((await post(f, 'auth/verify', { capability: old })).status).toBe(400)
  expect((await f.db.prepare('SELECT eligible FROM email_jobs WHERE id = ? OR resend_of = ?').bind(root, root).all<{ eligible: number }>()).results.every(row => row.eligible === 0)).toBe(true)
  await verify(f)
})

it('loadsProductionAuthenticationThroughStaticWasmWithoutEmailReadiness', async () => {
  const f = await createServiceFixture({ runtimeProbes: true }); fixtures.push(f)
  await signup(f); await verify(f)
  const start = await opaque.startLogin(password)
  const response = await f.request('/__accounts/production/auth/login/start', { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'person@example.org', role: 'password', startLoginRequest: start.request }) })
  expect(response.status).toBe(200)
  const s = await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(start.state, s.loginResponse, password, s.credentialId)
  const result = await f.request('/__accounts/production/auth/login/finish', { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify({ attemptId: s.attemptId, finishLoginRequest: finish.request, remember: false }) })
  expect(result.status).toBe(200)
  expect(result.headers.get('set-cookie')).toContain('Secure; HttpOnly')
  const service = await f.request('/__accounts/production/service')
  expect(await service.json()).toMatchObject({ accountsAvailable: true, signupAvailable: false })
})

it('checksPersistedWriteAuthorityForPendingRevokedAndReadOnlyAccounts', async () => {
  const f = await fixture()
  const pending = await signup(f)
  const now = 1_800_000_000_000
  const context = { env: { DB: f.db }, now: () => now } as unknown as ServiceContext
  const unauthenticated = { accountId: pending.accountId, sessionId: id(), deviceId: id(), authenticatedAt: now, absoluteExpiresAt: now + 1000, access: 'active' as const }
  await expect(assertCustomerWrite(unauthenticated, 'upload', context)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await verify(f); const logged = await login(f)
  const principal = { ...unauthenticated, ...logged, deviceId: (await f.db.prepare('SELECT device_id FROM customer_sessions WHERE id = ?').bind(logged.sessionId).first<string>('device_id'))! }
  await expect(assertCustomerWrite(principal, 'upload', context)).resolves.toBeUndefined()
  expect(() => requireRecent(principal, now + 10 * 60 * 1000 - 1)).not.toThrow()
  expect(() => requireRecent(principal, now + 10 * 60 * 1000)).toThrow('AUTH_REQUIRED')
  await f.db.prepare("UPDATE accounts SET access = 'read-only' WHERE id = ?").bind(logged.accountId).run()
  await expect(assertCustomerWrite(principal, 'commit', context)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect((await f.request('/api/v1/account', { headers: { cookie: logged.cookie } })).status).toBe(200)
  await f.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(now, principal.deviceId).run()
  expect((await f.request('/api/v1/account', { headers: { cookie: logged.cookie } })).status).toBe(401)
})

it('coalescesConcurrentSignupFinishAndRejectsChangedTransactionContent', async () => {
  const f = await fixture()
  const registration = await signup(f)
  const changed = await post(f, 'auth/signup/finish', { ...registration.input, remember: true })
  expect(changed.status).toBe(409)
  const started = await opaque.startRegistration(password)
  const response = await post(f, 'auth/signup/start', { email: 'another@example.org', username: 'another', registrationRequest: started.request })
  const s = await response.json() as { attemptId: string; accountId: string; credentialId: string; registrationResponse: string }
  const result = await opaque.finishRegistration(started.state, s.registrationResponse, password, s.credentialId)
  const envelope = await wrapSecret(randomBytes(32), await deriveWrappingKey(result.exportKey, s.accountId, 'password'), [1, s.accountId])
  const input = { attemptId: s.attemptId, transactionId: id(), registrationRecord: result.record, accountEnvelope: envelope, remember: false }
  const both = await Promise.all(Array.from({ length: 10 }, () => post(f, 'auth/signup/finish', input)))
  expect(both.map(response => response.status)).toEqual(Array(10).fill(200))
  expect((await post(f, 'auth/signup/finish', input)).status).toBe(429)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM verification_capabilities WHERE pending_id = ?').bind(s.attemptId).first('n')).toBe(1)
})

it('rejectsPasswordFieldsReservedNamesOversizeBodiesAndExpiredAttempts', async () => {
  const f = await fixture()
  const registrationRequest = (await opaque.startRegistration(password)).request
  for (const username of ['admin', 'administrator', 'crykit', 'crystal_kit', 'support', 'system', 'api', 'account', 'accounts', 'login', 'logout', 'signup', 'settings', 'mods', 'teams', 'builds', 'share', 'staff', 'owner', 'MixedCase', 'ab', 'a'.repeat(25)]) {
    expect((await post(f, 'auth/signup/start', { email: 'person@example.org', username, registrationRequest })).status).toBe(400)
  }
  expect((await post(f, 'auth/signup/start', { email: 'person@example.org', username: 'person', registrationRequest, password })).status).toBe(400)
  expect((await post(f, 'auth/signup/start', { email: 'person@example.org', username: 'person', registrationRequest, extra: 'x'.repeat(65_536) })).status).toBe(413)
  await signup(f); await verify(f)
  const started = await opaque.startLogin(password)
  const response = await post(f, 'auth/login/start', { email: 'person@example.org', role: 'password', startLoginRequest: started.request })
  const s = await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
  const completed = await opaque.finishLogin(started.state, s.loginResponse, password, s.credentialId)
  f.advance(10 * 60 * 1000)
  expect((await post(f, 'auth/login/finish', { attemptId: s.attemptId, finishLoginRequest: completed.request, remember: false })).status).toBe(401)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(0)
})

it('consumesLoginProofOnceAndRechecksCredentialRevision', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  async function prepare() {
    const started = await opaque.startLogin(password)
    const response = await post(f, 'auth/login/start', { email: 'person@example.org', role: 'password', startLoginRequest: started.request })
    const s = await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
    const completed = await opaque.finishLogin(started.state, s.loginResponse, password, s.credentialId)
    return { attemptId: s.attemptId, finishLoginRequest: completed.request, remember: false }
  }
  const stale = await prepare()
  await f.db.prepare('UPDATE credentials SET revision = revision + 1').run()
  expect((await post(f, 'auth/login/finish', stale)).status).toBe(401)
  const fresh = await prepare()
  const both = await Promise.all([post(f, 'auth/login/finish', fresh), post(f, 'auth/login/finish', fresh)])
  expect(both.map(response => response.status).sort()).toEqual([200, 401])
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(1)
})

it('missingEmailSecretDisablesSignupButKeepsRestoredAccountLogin', async () => {
  await ready
  const setup = server.createSetup()
  const donor = await createServiceFixture({ opaqueSetup: setup }); fixtures.push(donor)
  await signup(donor); await verify(donor)
  const restored = await createServiceFixture({ opaqueSetup: setup, emailReady: false }); fixtures.push(restored)
  // Restore real activated rows, then require a fresh full OPAQUE proof on the receiver
  for (const table of ['accounts', 'credentials']) {
    const rows = (await donor.db.prepare(`SELECT * FROM ${table}`).all<Record<string, string | number>>()).results
    for (const row of rows) await restored.db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row)).run()
  }
  expect(await (await restored.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: true, signupAvailable: false })
  expect((await post(restored, 'auth/signup/start', { email: 'new@example.org', username: 'newperson', registrationRequest: (await opaque.startRegistration(password)).request })).status).toBe(503)
  const session = await login(restored)
  expect((await restored.request('/api/v1/account', { headers: { cookie: session.cookie } })).status).toBe(200)
})

it('ordinaryActivityCannotExtendAbsoluteExpiryAndMatchingLogoutRevokes', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  const session = await login(f)
  for (let i = 0; i < 3; i++) {
    f.advance(7 * 60 * 60 * 1000)
    expect((await f.request('/api/v1/account', { headers: { cookie: session.cookie } })).status).toBe(200)
  }
  f.advance(3 * 60 * 60 * 1000)
  expect((await f.request('/api/v1/account', { headers: { cookie: session.cookie } })).status).toBe(401)
  const replacement = await login(f)
  const logout = await post(f, 'auth/logout', { sessionId: replacement.sessionId }, { cookie: replacement.cookie, 'x-csrf-token': replacement.csrf })
  expect(await logout.json()).toEqual({ revoked: true })
  expect(logout.headers.get('set-cookie')).toBeNull()
  expect((await f.request('/api/v1/account', { headers: { cookie: replacement.cookie } })).status).toBe(401)
})

it('rejectsMalformedOpaquePointsAsInvalidRequests', async () => {
  const f = await fixture()
  expect((await post(f, 'auth/signup/start', { email: 'person@example.org', username: 'person', registrationRequest: Buffer.alloc(32, 255).toString('base64url') })).status).toBe(400)
  expect((await post(f, 'auth/login/start', { email: 'person@example.org', role: 'password', startLoginRequest: Buffer.alloc(96, 255).toString('base64url') })).status).toBe(400)
})

const rateWindowMs = 10 * 60_000
function invalidLoginFinish(attemptId = id()) {
  return { attemptId, finishLoginRequest: randomBytes(64).toString('base64url'), remember: false }
}

it('boundsSignupFinishRetriesAndRecoversWithoutChangingTheReceipt', async () => {
  const f = await fixture()
  const registered = await signup(f)
  // The same opaque ID in the other finish kind must have a distinct target budget
  for (let i = 0; i < 10; i++) expect((await post(f, 'auth/login/finish', invalidLoginFinish(registered.attemptId))).status).toBe(401)
  for (let i = 1; i < 10; i++) expect((await post(f, 'auth/signup/finish', registered.input)).status).toBe(200)
  expect((await post(f, 'auth/signup/finish', registered.input)).status).toBe(429)
  f.advance(rateWindowMs)
  const retry = await post(f, 'auth/signup/finish', registered.input)
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({ pending: true, transactionId: registered.input.transactionId })
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM email_jobs').first('n')).toBe(1)
})

it('boundsLoginFinishAndVerificationReplaysPerTargetWithBackoff', async () => {
  const f = await fixture(); await signup(f); const capability = await verify(f)
  for (let i = 1; i < 10; i++) expect((await post(f, 'auth/verify', { capability })).status).toBe(400)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(429)
  const missing = invalidLoginFinish()
  for (let i = 0; i < 10; i++) expect((await post(f, 'auth/login/finish', missing)).status).toBe(401)
  expect((await post(f, 'auth/login/finish', missing)).status).toBe(429)
  f.advance(rateWindowMs)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(400)
  expect((await post(f, 'auth/login/finish', missing)).status).toBe(401)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(0)
})

it('sharesFinishNetworkBudgetAcrossKindsAndPreservesThrottledAuthority', async () => {
  // This journey advances D1 time while the native limiter still uses wall time
  // Native admission has separate real-binding tests; retain every D1 boundary assertion here
  const nativeAuthBudgetForVirtualClock = 120
  const f = await fixture({ admissionLimits: { auth: nativeAuthBudgetForVirtualClock } })
  const registered = await signup(f, 'person@example.org', 'person', false)
  // Real registration material makes random attempt IDs schema-valid without issuing authority
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => i % 2
    ? post(f, 'auth/login/finish', invalidLoginFinish())
    : post(f, 'auth/signup/finish', { ...registered.input, attemptId: id(), transactionId: id() })))
  expect(responses.filter(response => response.status === 429)).toHaveLength(10)
  expect(responses.filter(response => [400, 401].includes(response.status))).toHaveLength(30)
  expect((await post(f, 'auth/signup/finish', registered.input)).status).toBe(429)
  expect(await f.db.prepare('SELECT registration_record FROM pending_registrations').first('registration_record')).toBeNull()
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM email_jobs').first('n')).toBe(0)
  f.advance(rateWindowMs)
  expect((await post(f, 'auth/signup/finish', registered.input)).status).toBe(200)
  await verify(f)
  // Fill the remaining shared network budget, then issue a fresh real OPAQUE attempt
  await Promise.all(Array.from({ length: 29 }, () => post(f, 'auth/login/finish', invalidLoginFinish())))
  f.advance(60_000)
  const started = await opaque.startLogin(password)
  const response = await post(f, 'auth/login/start', { email: 'person@example.org', role: 'password', startLoginRequest: started.request })
  expect(response.status).toBe(200)
  const s = await response.json() as { attemptId: string; credentialId: string; loginResponse: string }
  const completed = await opaque.finishLogin(started.state, s.loginResponse, password, s.credentialId)
  const input = { attemptId: s.attemptId, finishLoginRequest: completed.request, remember: false }
  const throttled = await post(f, 'auth/login/finish', input)
  expect(throttled.status).toBe(429)
  expect(throttled.headers.get('set-cookie')).toBeNull()
  expect(await f.db.prepare('SELECT id FROM auth_attempts WHERE id = ?').bind(s.attemptId).first('id')).toBe(s.attemptId)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(0)
  f.advance(rateWindowMs - 60_000)
  expect((await post(f, 'auth/login/finish', input)).status).toBe(200)
  for (let i = 1; i < 10; i++) expect((await post(f, 'auth/login/finish', input)).status).toBe(401)
  expect((await post(f, 'auth/login/finish', input)).status).toBe(429)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions').first('n')).toBe(1)
})

it('boundsConcurrentVerificationNetworksWithoutConsumingThrottledCapabilities', async () => {
  const f = await fixture(); const registered = await signup(f); await f.runJobs()
  const capability = (await f.emails())[0].capability!
  const randomCapabilities = Array.from({ length: 40 }, () => randomBytes(32).toString('base64url'))
  const responses = await Promise.all(randomCapabilities.map(value => post(f, 'auth/verify', { capability: value })))
  expect(responses.filter(response => response.status === 400)).toHaveLength(30)
  expect(responses.filter(response => response.status === 429)).toHaveLength(10)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(429)
  expect(await f.db.prepare('SELECT consumed_at FROM verification_capabilities').first('consumed_at')).toBeNull()
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(0)
  // Verification saturation does not spend finish access or interfere with exact receipts
  expect((await post(f, 'auth/signup/finish', registered.input)).status).toBe(200)
  const counters = JSON.stringify(await f.db.prepare('SELECT * FROM rate_counters').all())
  for (const value of [capability, ...randomCapabilities, registered.attemptId]) expect(counters).not.toContain(value)
  f.advance(rateWindowMs)
  expect((await post(f, 'auth/verify', { capability })).status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM accounts').first('n')).toBe(1)
})

it('pendingLogoutCannotRevokeNewSession', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  const old = await login(f)
  const current = await login(f)
  const headers = { cookie: current.cookie, 'x-csrf-token': current.csrf }
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId })).status).toBe(401)
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, { cookie: current.cookie })).status).toBe(403)
  expect((await post(f, 'account/sessions/revoke', { sessionId: id() }, headers)).status).toBe(404)
  for (let i = 0; i < 2; i++) {
    const result = await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, headers)
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ revoked: true })
    expect(result.headers.get('set-cookie')).toBeNull()
  }
  expect((await f.request('/api/v1/account', { headers: { cookie: old.cookie } })).status).toBe(401)
  expect((await f.request('/api/v1/account', { headers: { cookie: current.cookie } })).status).toBe(200)
})

it('exactSessionRevocationRejectsForeignOwnersAndRollsBackFailures', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  const old = await login(f), current = await login(f)
  const headers = { cookie: current.cookie, 'x-csrf-token': current.csrf }
  await signup(f, 'foreign@example.net', 'foreign'); await verify(f)
  const foreignAccount = await f.db.prepare("SELECT id FROM accounts WHERE username = 'foreign'").first<string>('id')
  const foreignTarget = id()
  await f.db.prepare('INSERT INTO customer_sessions (id, token_hash, account_id, device_id, authenticated_at, idle_expires_at, absolute_expires_at, remembered) SELECT ?, ?, ?, device_id, authenticated_at, idle_expires_at, absolute_expires_at, remembered FROM customer_sessions WHERE id = ?').bind(foreignTarget, id(), foreignAccount, old.sessionId).run()
  const foreign = await post(f, 'account/sessions/revoke', { sessionId: foreignTarget }, headers)
  const missing = await post(f, 'account/sessions/revoke', { sessionId: id() }, headers)
  expect(foreign.status).toBe(404); expect(missing.status).toBe(404)
  expect(await foreign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  await f.db.exec("CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON customer_sessions BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, headers)).status).toBe(503)
  expect(await f.db.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(old.sessionId).first('revoked_at')).toBeNull()
  await f.db.exec('DROP TRIGGER fail_revoke')
  await f.db.prepare('UPDATE customer_sessions SET idle_expires_at = 0 WHERE id = ?').bind(old.sessionId).run()
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, headers)).status).toBe(200)
  const revokedAt = await f.db.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(old.sessionId).first('revoked_at')
  f.advance(1000)
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(old.sessionId).first('revoked_at')).toBe(revokedAt)
})

it('rechecksLiveCallerInsideExactRevocationBatch', async () => {
  const f = await fixture(); await signup(f); await verify(f)
  const old = await login(f), current = await login(f)
  await f.db.exec(`CREATE TRIGGER revoke_caller AFTER UPDATE OF idle_expires_at ON customer_sessions WHEN NEW.id = '${current.sessionId}' BEGIN UPDATE customer_sessions SET revoked_at = 1 WHERE id = NEW.id; END`)
  expect((await post(f, 'account/sessions/revoke', { sessionId: old.sessionId }, { cookie: current.cookie, 'x-csrf-token': current.csrf })).status).toBe(401)
  expect(await f.db.prepare('SELECT revoked_at FROM customer_sessions WHERE id = ?').bind(old.sessionId).first('revoked_at')).toBeNull()
})
