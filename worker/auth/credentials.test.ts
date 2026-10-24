import { afterEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { accountMetadata, clearPendingCredentialChanges, resumeCredentialChange, changePassword, changeUsername, reauthenticateAccount, loginAccount, loginWithRecovery, registerAccount, replaceRecoveryCode } from '../../src/account/auth-client'
import * as opaque from '../../src/account/crypto/opaque'
import { deriveWrappingKey, wrapSecret } from '../../src/account/crypto/envelopes'
import { credentialIdForRole } from '../../src/account/protocol'
import { parseRecoveryCode, recoveryCredentialSecret } from '../../src/account/recovery'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'

const fixtures: ServiceFixture[] = []
const password = 'original synthetic password'
const replacement = 'replacement synthetic password'
const email = 'person@example.org'
const id = () => randomBytes(16).toString('base64url')
afterEach(async () => { clearPendingCredentialChanges(); vi.unstubAllGlobals(); await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
async function fixture(production = false) {
  const f = await createServiceFixture({ now: production ? Date.now() : 1_800_000_000_000 }); fixtures.push(f)
  let cookie = ''
  let useProduction = false
  const bodies: string[] = []
  const transport = async (path: string | URL | Request, init?: RequestInit) => {
    bodies.push(init?.body as string ?? '')
    const headers = new Headers(init?.headers); headers.set('origin', 'http://127.0.0.1'); if (cookie) headers.set('cookie', cookie)
    const route = useProduction ? String(path).replace('/api/v1/auth/', '/__accounts/production/auth/').replace('/api/v1/account/', '/__accounts/production/account/').replace(/^\/api\/v1\/account$/, '/__accounts/production/identity') : String(path)
    const response = await f.request(route, { ...init, headers })
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    return response
  }
  vi.stubGlobal('fetch', transport)
  await registerAccount({ email, username: 'person', password, remember: false })
  await f.runJobs()
  expect((await transport('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: (await f.emails())[0].capability }) })).status).toBe(200)
  // Captured mail activates the fixture account; the real production entry has no native mail binding
  useProduction = production
  const unlocked = await loginAccount({ email, password, remember: false })
  const post = (path: string, input: object, session = unlocked) => transport(`/api/v1/account/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify(input) })
  return { f, unlocked, post, transport, bodies }
}
async function prepared(h: Awaited<ReturnType<typeof fixture>>, role: 'password' | 'recovery' = 'password', transactionId = id()) {
  const start = await opaque.startRegistration(replacement)
  const response = await h.post('credentials/start', { transactionId, role, registrationRequest: start.request })
  expect(response.status).toBe(200)
  const s = await response.json() as { credentialId: string; registrationResponse: string }
  const registered = await opaque.finishRegistration(start.state, s.registrationResponse, replacement, s.credentialId)
  return { transactionId, role, expectedCredentialRevision: 1, registrationRecord: registered.record, accountEnvelope: await wrapSecret(h.unlocked.key, await deriveWrappingKey(registered.exportKey, h.unlocked.accountId, 'password'), [1, h.unlocked.accountId]) }
}
it('interruptedCredentialChangePreservesOldAccess', async () => {
  const h = await fixture(), before = h.unlocked
  const input = await prepared(h)
  await h.f.db.exec("CREATE TRIGGER reject_credential BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END")
  expect((await h.post('credentials/commit', input)).status).toBe(503)
  expect(await h.f.db.prepare('SELECT COUNT(*) FROM auth_transactions WHERE id = ?').bind(input.transactionId).first('COUNT(*)')).toBe(0)
  const after = await loginAccount({ email, password, remember: false })
  expect(after.key).toEqual(before.key)
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(1)
})
it('lostResponseReconcilesExactlyOneCredentialCommit', async () => {
  const h = await fixture(), transactionId = id()
  const ciphertext = randomBytes(128)
  await h.f.objects.put('synthetic-encrypted-body', ciphertext)
  const beforeObjects = await h.f.objects.list()
  let dropped = false
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const response = await h.transport(path, init)
    if (path.endsWith('credentials/commit') && !dropped) { dropped = true; expect(response.status).toBe(200); throw new TypeError('Synthetic lost response') }
    return response
  })
  await changePassword(h.unlocked, replacement, transactionId)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM auth_transactions WHERE id = ?').bind(transactionId).first('n')).toBe(1)
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(2)
  expect((await loginAccount({ email, password: replacement, remember: false })).key).toEqual(h.unlocked.key)
  expect(h.bodies.filter(body => body.includes('uploadId'))).toHaveLength(0)
  expect((await h.f.objects.list()).objects).toEqual(beforeObjects.objects)
  expect(new Uint8Array(await (await h.f.objects.get('synthetic-encrypted-body'))!.arrayBuffer())).toEqual(new Uint8Array(ciphertext))
})
it('recoveryAuthenticatesAndDecryptsBeforeReplacement', async () => {
  const h = await fixture()
  const code = await replaceRecoveryCode(h.unlocked, id())
  const recovered = await loginWithRecovery(email, code, false)
  expect(recovered.key).toEqual(h.unlocked.key)
  await changePassword(recovered, replacement, id())
  const newCode = await replaceRecoveryCode(recovered, id())
  await expect(loginWithRecovery(email, code, false)).rejects.toThrow('AUTH_FAILED')
  expect((await loginWithRecovery(email, newCode, false)).key).toEqual(h.unlocked.key)
  const rawSecret = recoveryCredentialSecret(await parseRecoveryCode(code))
  const dump = JSON.stringify(await h.f.db.prepare('SELECT * FROM credentials').all())
  for (const secret of [code, rawSecret, password, replacement, Buffer.from(h.unlocked.key).toString('base64url')]) {
    expect(JSON.stringify(h.bodies)).not.toContain(secret)
    expect(JSON.stringify(h.f.events())).not.toContain(secret)
    expect(dump).not.toContain(secret)
  }
})
it('emailChangeKeepsAccountIdentity', async () => {
  const h = await fixture(), transactionId = id()
  const before = await h.f.db.prepare('SELECT credential_id FROM credentials').first('credential_id')
  expect((await h.post('email/start', { transactionId, expectedRevision: 1, email: 'changed@example.net' })).status).toBe(200)
  await h.f.runJobs()
  const capability = (await h.f.emails()).find(message => message.kind === 'verify-email')!.capability
  await h.f.db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON email_jobs BEGIN SELECT RAISE(ABORT, 'synthetic notice interruption'); END")
  expect((await h.post('email/confirm', { capability })).status).toBe(503)
  expect(await h.f.db.prepare('SELECT delivery_email FROM accounts').first('delivery_email')).toBe(email)
  expect(await h.f.db.prepare('SELECT consumed_at FROM pending_email_changes').first('consumed_at')).toBeNull()
  expect(await h.f.db.prepare('SELECT eligible FROM email_jobs WHERE id = (SELECT root_job_id FROM pending_email_changes)').first('eligible')).toBe(1)
  await h.f.db.exec('DROP TRIGGER reject_notice')
  expect((await h.post('email/confirm', { capability })).status).toBe(200)
  expect(await (await h.post('email/start', { transactionId, expectedRevision: 1, email: 'changed@example.net' })).json()).toEqual({ pending: true })
  expect(await h.f.db.prepare('SELECT credential_id FROM credentials').first('credential_id')).toBe(before)
  expect((await loginAccount({ email: 'changed@example.net', password, remember: false })).key).toEqual(h.unlocked.key)
})
it('rejectsMissingEnvelopeStaleRevisionAndChangedTransactionInput', async () => {
  const h = await fixture(), input = await prepared(h)
  const { accountEnvelope: _envelope, ...missing } = input
  expect((await h.post('credentials/commit', missing)).status).toBe(400)
  expect((await h.post('credentials/commit', { ...input, password })).status).toBe(400)
  expect((await h.post('credentials/commit', { ...input, expectedCredentialRevision: 0 })).status).toBe(409)
  expect((await h.post('credentials/commit', input)).status).toBe(200)
  expect((await h.post('credentials/commit', input)).status).toBe(200)
  expect((await h.post('credentials/commit', { ...input, expectedCredentialRevision: 2 })).status).toBe(409)
})
it('credentialCommitRequiresLiveRecentAuthorityInsideBatch', async () => {
  const h = await fixture(), input = await prepared(h)
  h.f.advance(10 * 60 * 1000)
  expect((await h.post('credentials/commit', input)).status).toBe(401)
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(1)
})
it('rejectsWrongRecoveryEnvelopeAfterSuccessfulProtocolAuthentication', async () => {
  const h = await fixture()
  const code = await replaceRecoveryCode(h.unlocked, id())
  const wrong = await wrapSecret(new Uint8Array(32), new Uint8Array(32), [1, h.unlocked.accountId])
  await h.f.db.prepare("UPDATE credentials SET account_envelope = ? WHERE role = 'recovery'").bind(JSON.stringify(wrong)).run()
  await expect(loginWithRecovery(email, code, false)).rejects.toThrow('INTEGRITY_FAILED')
  expect(await h.f.db.prepare("SELECT credential_id FROM credentials WHERE role = 'recovery'").first('credential_id')).toBe(credentialIdForRole(h.unlocked.accountId, 'recovery'))
})

it('reauthenticatesSameSessionWithoutExtendingAbsoluteExpiry', async () => {
  const h = await fixture()
  const before = await accountMetadata(h.unlocked)
  expect(before.credentials).toEqual({ passwordRevision: 1, recoveryRevision: null })
  h.f.advance(10 * 60 * 1000)
  const receipt = await reauthenticateAccount(h.unlocked, { role: 'password', secret: password })
  expect(receipt.authenticatedAt).toBe(h.unlocked.authenticatedAt + 10 * 60 * 1000)
  const after = await accountMetadata(h.unlocked)
  expect(after.sessionId).toBe(before.sessionId)
  expect(after.absoluteExpiresAt).toBe(before.absoluteExpiresAt)
  await changePassword(h.unlocked, replacement, id())
})
it('revokesOtherSessionsOnlyOnSuccessfulActivationAndRejectsStalePreparedChanges', async () => {
  const h = await fixture(), first = await prepared(h), second = await prepared(h)
  await h.f.db.prepare("INSERT INTO customer_sessions (id, token_hash, account_id, device_id, authenticated_at, idle_expires_at, absolute_expires_at, remembered) SELECT ?, ?, account_id, device_id, authenticated_at, idle_expires_at, absolute_expires_at, remembered FROM customer_sessions WHERE id = ?").bind(id(), randomBytes(32).toString('base64url'), h.unlocked.sessionId).run()
  h.f.failNext('auth.credentials.before-batch')
  expect((await h.post('credentials/commit', first)).status).toBe(503)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions WHERE revoked_at IS NULL').first('n')).toBe(2)
  expect((await h.post('credentials/commit', first)).status).toBe(200)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM customer_sessions WHERE revoked_at IS NULL').first('n')).toBe(1)
  expect((await h.post('credentials/commit', second)).status).toBe(409)
  expect((await accountMetadata(h.unlocked)).credentials.passwordRevision).toBe(2)
})
it('usernameChangesRespectRevisionUniquenessAndModeration', async () => {
  const h = await fixture()
  await expect(changeUsername(h.unlocked, 'admin', id(), 1)).rejects.toThrow('INVALID_REQUEST')
  const transactionId = id()
  expect((await changeUsername(h.unlocked, 'person_2', transactionId, 1)).revision).toBe(2)
  expect((await changeUsername(h.unlocked, 'person_2', transactionId, 1)).revision).toBe(2)
  await expect(changeUsername(h.unlocked, 'person_3', id(), 1)).rejects.toThrow('HEAD_CONFLICT')
  await h.f.db.prepare("UPDATE accounts SET access = 'read-only'").run()
  await expect(changeUsername(h.unlocked, 'person_3', id(), 2)).rejects.toThrow('HEAD_CONFLICT')
})
it('emailEnqueueRollsBackAuthorityAndInvalidatesReplacedAndConsumedLineages', async () => {
  const h = await fixture(), transactionId = id()
  await h.f.db.exec("CREATE TRIGGER reject_email BEFORE INSERT ON email_jobs BEGIN SELECT RAISE(ABORT, 'synthetic email interruption'); END")
  const input = { transactionId, expectedRevision: 1, email: 'changed@example.net' }
  expect((await h.post('email/start', input)).status).toBe(503)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM pending_email_changes').first('n')).toBe(0)
  expect(await h.f.db.prepare('SELECT revision FROM accounts').first('revision')).toBe(1)
  await h.f.db.exec('DROP TRIGGER reject_email')
  h.f.advance(60_000)
  expect((await h.post('email/start', input)).status).toBe(200)
  expect((await h.post('email/start', input)).status).toBe(200)
  expect((await h.post('email/start', { ...input, email: 'different@example.net' })).status).toBe(409)
  const root = await h.f.db.prepare('SELECT root_job_id FROM pending_email_changes').first<string>('root_job_id')
  await h.f.runJobs()
  const oldCapability = (await h.f.emails()).find(message => message.kind === 'verify-email')!.capability
  const resend = await h.f.request('/__accounts/email/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: root, resendId: id() }) })
  expect(resend.status).toBe(200)
  h.f.advance(60_000)
  expect((await h.post('email/start', { transactionId: id(), expectedRevision: 2, email: 'latest@example.org' })).status).toBe(200)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM email_jobs WHERE (id = ? OR resend_of = ?) AND eligible != 0').bind(root, root).first('n')).toBe(0)
  expect((await h.post('email/confirm', { capability: oldCapability })).status).toBe(400)
  await h.f.runJobs()
  const capability = (await h.f.emails()).find(message => message.recipient === 'latest@example.org')!.capability
  h.f.advance(10 * 60 * 1000)
  expect((await h.post('email/confirm', { capability })).status).toBe(401)
  await reauthenticateAccount(h.unlocked, { role: 'password', secret: password })
  expect((await h.post('email/confirm', { capability })).status).toBe(200)
  expect((await h.post('email/confirm', { capability })).status).toBe(400)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM account_security_notices').first('n')).toBe(1)
  expect(await h.f.db.prepare("SELECT COUNT(*) AS n FROM email_jobs WHERE id IN (SELECT root_job_id FROM pending_email_changes) AND eligible != 0").first('n')).toBe(0)
})
it('passwordChangesDoNotDependOnEmailOutboxWritesAndUnknownTransactionsReturn404', async () => {
  const h = await fixture()
  const transactionId = id()
  await h.f.db.exec("CREATE TRIGGER reject_email BEFORE INSERT ON email_jobs BEGIN SELECT RAISE(ABORT, 'email unavailable'); END")
  await changePassword(h.unlocked, replacement, transactionId)
  expect((await h.transport(`/api/v1/account/transactions/${id()}`)).status).toBe(404)
  expect((await h.transport(`/api/v1/account/transactions/${transactionId}`)).status).toBe(200)
})

it('resumesExactRecoveryCommandAfterOutageAndRejectsWrongAccountOrChangedRequest', async () => {
  const h = await fixture(), transactionId = id()
  let down = false
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (down) throw new TypeError('Synthetic offline')
    const response = await h.transport(path, init)
    if (path.endsWith('credentials/commit')) { expect(response.status).toBe(200); down = true; throw new TypeError('Synthetic lost response') }
    return response
  })
  await expect(replaceRecoveryCode(h.unlocked, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_UNCONFIRMED')
  await expect(resumeCredentialChange({ ...h.unlocked, accountId: id() }, transactionId)).rejects.toThrow('AUTH_REQUIRED')
  await expect(changePassword(h.unlocked, replacement, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_PENDING')
  vi.stubGlobal('fetch', h.transport)
  const result = await resumeCredentialChange(h.unlocked, transactionId)
  expect(result.role).toBe('recovery')
  if (result.role !== 'recovery') throw new Error('Expected recovery result')
  expect((await loginWithRecovery(email, result.display, false)).key).toEqual(h.unlocked.key)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM auth_transactions WHERE id = ?').bind(transactionId).first('n')).toBe(1)
  await expect(resumeCredentialChange(h.unlocked, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_NOT_PENDING')
})
it('clearsPendingCommandsOnLockAndExpiresResumeAuthority', async () => {
  const h = await fixture(), transactionId = id()
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.endsWith('credentials/commit')) throw new TypeError('Synthetic offline before activation')
    return h.transport(path, init)
  })
  await expect(changePassword(h.unlocked, replacement, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_UNCONFIRMED')
  clearPendingCredentialChanges(h.unlocked.accountId)
  await expect(resumeCredentialChange(h.unlocked, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_NOT_PENDING')
  const next = id()
  await expect(changePassword(h.unlocked, replacement, next)).rejects.toThrow('CREDENTIAL_CHANGE_UNCONFIRMED')
  const now = Date.now()
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000)
  try { await expect(resumeCredentialChange(h.unlocked, next)).rejects.toThrow('CREDENTIAL_CHANGE_NOT_PENDING') } finally { spy.mockRestore() }
  vi.stubGlobal('fetch', h.transport)
  expect((await loginAccount({ email, password, remember: false })).key).toEqual(h.unlocked.key)
})
it.each(['recent-auth', 'revoked', 'moderated'])('guardsCapturedAuthorityAfterSessionRead: %s', async mode => {
  const h = await fixture(), input = await prepared(h)
  const mutation = mode === 'recent-auth' ? 'UPDATE customer_sessions SET authenticated_at = authenticated_at - 600000' : mode === 'revoked' ? 'UPDATE customer_sessions SET revoked_at = 1' : "UPDATE accounts SET access = 'read-only'"
  // requireCustomer reads the principal before touching idle expiry; this trigger changes authority after that read
  await h.f.db.exec(`CREATE TRIGGER change_authority AFTER UPDATE OF idle_expires_at ON customer_sessions BEGIN ${mutation}; END`)
  expect((await h.post('credentials/commit', input)).status).toBe(409)
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(1)
  expect(await h.f.db.prepare('SELECT COUNT(*) AS n FROM auth_transactions WHERE id = ?').bind(input.transactionId).first('n')).toBe(0)
})

it('productionEntryActivatesSameKeyCredentialsAndRecoveryWithStrictPrivateRoutes', async () => {
  const h = await fixture(true)
  await changePassword(h.unlocked, replacement, id())
  const code = await replaceRecoveryCode(h.unlocked, id())
  expect((await loginWithRecovery(email, code, false)).key).toEqual(h.unlocked.key)
  expect(h.f.emailCaptureStats().outboundNetworkMessages).toBe(0)
})

it('cleanupFencesPreparationThatWasAlreadyInFlight', async () => {
  const h = await fixture(), transactionId = id()
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const response = await h.transport(path, init)
    if (path.endsWith('credentials/start')) clearPendingCredentialChanges(h.unlocked.accountId)
    return response
  })
  await expect(changePassword(h.unlocked, replacement, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_LOCAL_STATE_CLEARED')
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(1)
  await expect(resumeCredentialChange(h.unlocked, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_NOT_PENDING')
})

it('cleanupDoesNotClaimAnUnconfirmedServerCommitWasCancelled', async () => {
  const h = await fixture(), transactionId = id()
  let unavailable = false
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (unavailable) throw new TypeError('Synthetic offline')
    const response = await h.transport(path, init)
    if (path.endsWith('credentials/commit')) { expect(response.status).toBe(200); unavailable = true; throw new TypeError('Synthetic lost response') }
    return response
  })
  await expect(changePassword(h.unlocked, replacement, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_UNCONFIRMED')
  clearPendingCredentialChanges()
  await expect(resumeCredentialChange(h.unlocked, transactionId)).rejects.toThrow('CREDENTIAL_CHANGE_NOT_PENDING')
  expect(await h.f.db.prepare('SELECT revision FROM credentials').first('revision')).toBe(2)
  vi.stubGlobal('fetch', h.transport)
  expect((await loginAccount({ email, password: replacement, remember: false })).key).toEqual(h.unlocked.key)
  await expect(loginAccount({ email, password, remember: false })).rejects.toThrow('AUTH_FAILED')
})
