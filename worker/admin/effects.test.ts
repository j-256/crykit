import { randomBytes } from 'node:crypto'
import * as opaque from '../../src/account/crypto/opaque'
import { afterEach, expect, it } from 'vitest'
import { adminFixture, adminCommand, adminTestNow } from '../testing/admin-fixture'
import type { ServiceFixture } from '../testing/service-fixture'
import { customer, prepared, command, post, id } from '../sync/testing'
import type { AdminCommand } from '../../src/account/admin-protocol'
import type { PublicSnapshot } from '../../src/interchange/public-share-schema'
import type { OperatorPrincipal } from './session'
import type { ServiceJob } from '../jobs/types'
import * as commands from './commands'

const fixtures: ServiceFixture[] = []
async function setup() {
  const s = await adminFixture()
  fixtures.push(s.f)
  return s
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
const snapshot: PublicSnapshot = {
  version: 5,
  kind: 'build',
  title: 'Intentional public snapshot',
  setup: {
    catalogLock: {},
    baseline: null,
    layers: [],
    mode: { state: 'unknown' },
    ppCostsNonNegative: { state: 'unknown' },
    slots: [],
  },
  slots: [
    {
      primaryClass: null,
      secondaryClass: null,
      equipment: [],
      equipmentGroups: [],
      passives: [],
    },
  ],
  receipts: [],
}
async function act(
  s: Awaited<ReturnType<typeof setup>>,
  cmd: AdminCommand['command'],
  target: AdminCommand['target'],
  revision?: number,
) {
  const table = {
    account: 'accounts',
    share: 'shares',
    operator: 'operators',
    invitation: 'admin_invitations',
    job: 'service_jobs',
    service: 'service_settings',
  }[target.kind]
  const expected =
    revision ??
    (await s.f.db
      .prepare(`SELECT revision FROM ${table} WHERE id=?`)
      .bind(target.id)
      .first<number>('revision'))
  const input = adminCommand(cmd, target, expected!)
  await s.confirm(input)
  return s.post('actions', input)
}
it('restrictionAffectsOrdinaryCustomerApisWithoutDeletingData', async () => {
  const s = await setup(),
    owner = await customer(s.f),
    item = await prepared(s.f, owner)
  expect((await post(s.f, 'sync/commits', command([item.descriptor]), owner.headers)).status).toBe(200)
  const target = { kind: 'account' as const, id: owner.accountId }
  const read = () =>
    s.f.request(`/api/v1/sync/revisions/${item.descriptor.revisionId}/chunks/0`, { headers: owner.headers })
  const before = await s.f.db
    .prepare('SELECT * FROM quota_counters WHERE scope=?')
    .bind(owner.accountId)
    .first()
  expect((await act(s, { type: 'accounts.restrict', policy: 'read-only' }, target)).status).toBe(200)
  expect((await read()).status).toBe(200)
  expect(
    (
      await post(
        s.f,
        'sync/uploads',
        { ...item.input, uploadId: id(), documentId: id(), revisionId: id() },
        owner.headers,
      )
    ).status,
  ).toBe(403)
  expect(
    (await post(s.f, 'shares', { mutationId: id(), snapshot, includeAttribution: true }, owner.headers))
      .status,
  ).toBe(403)
  expect((await act(s, { type: 'accounts.quota', quotaBytes: 0 }, target)).status).toBe(200)
  expect(
    await s.f.db.prepare('SELECT * FROM quota_counters WHERE scope=?').bind(owner.accountId).first(),
  ).toEqual(before)
  expect((await act(s, { type: 'accounts.restrict', policy: 'active' }, target)).status).toBe(200)
  expect((await read()).status).toBe(200)
  expect(
    (
      await post(
        s.f,
        'sync/uploads',
        { ...item.input, uploadId: id(), documentId: id(), revisionId: id() },
        owner.headers,
      )
    ).status,
  ).toBe(413)
  const approvalId = id()
  expect(
    (
      await post(s.f, 'auth/devices/start', {
        email: 'sync@example.org',
        requestId: approvalId,
        requestPublicKey: randomBytes(32).toString('base64url'),
        requestCapabilityHash: randomBytes(32).toString('base64url'),
      })
    ).status,
  ).toBe(200)
  expect((await act(s, { type: 'accounts.restrict', policy: 'blocked' }, target)).status).toBe(200)
  expect((await read()).status).toBe(401)
  expect((await act(s, { type: 'accounts.restrict', policy: 'active' }, target)).status).toBe(200)
  expect((await read()).status).toBe(401)
  expect(
    await s.f.db.prepare('SELECT state FROM device_approvals WHERE id=?').bind(approvalId).first('state'),
  ).toBe('rejected')
  const password = 'synthetic sync acceptance password',
    login = await opaque.startLogin(password)
  const challenge = (await (
    await post(s.f, 'auth/login/start', {
      email: 'sync@example.org',
      role: 'password',
      startLoginRequest: login.request,
    })
  ).json()) as {
    attemptId: string
    credentialId: string
    loginResponse: string
  }
  const finish = await opaque.finishLogin(
    login.state,
    challenge.loginResponse,
    password,
    challenge.credentialId,
  )
  const renewed = await post(s.f, 'auth/login/finish', {
    attemptId: challenge.attemptId,
    finishLoginRequest: finish.request,
    remember: true,
  })
  expect(renewed.status).toBe(200)
  const readable = await s.f.request(`/api/v1/sync/revisions/${item.descriptor.revisionId}/chunks/0`, {
    headers: { cookie: renewed.headers.get('set-cookie')!.split(';')[0] },
  })
  expect(new Uint8Array(await readable.arrayBuffer())).toEqual(new Uint8Array(item.bytes))
  expect(
    await s.f.db
      .prepare('SELECT count(*) AS n FROM sync_revisions WHERE account_id=?')
      .bind(owner.accountId)
      .first('n'),
  ).toBe(1)
})
it('readyUploadAndStaleQuotaPreviewCannotBypassRestriction', async () => {
  const s = await setup(),
    owner = await customer(s.f),
    item = await prepared(s.f, owner)
  const target = { kind: 'account' as const, id: owner.accountId }
  const quota = adminCommand({ type: 'accounts.quota', quotaBytes: 10000 }, target)
  expect((await s.post('actions/preview', quota)).status).toBe(200)
  expect((await act(s, { type: 'accounts.restrict', policy: 'read-only' }, target)).status).toBe(200)
  expect((await s.post('actions', quota)).status).toBe(409)
  expect((await post(s.f, 'sync/commits', command([item.descriptor]), owner.headers)).status).toBe(403)
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM sync_revisions').first('n')).toBe(0)
})
it('withheldAttributionResolvesThroughOrdinaryRenameAndStoppedShareStaysStoppedAfterRelease', async () => {
  const s = await setup(),
    owner = await customer(s.f)
  const published = await post(
    s.f,
    'shares',
    { mutationId: id(), snapshot, includeAttribution: true },
    owner.headers,
  )
  expect(published.status).toBe(200)
  const { shareId } = (await published.json()) as { shareId: string }
  const read = () => s.f.request(`/api/public/v1/shares/${shareId}`)
  expect(await (await read()).json()).toHaveProperty('attribution')
  const target = { kind: 'account' as const, id: owner.accountId }
  expect((await act(s, { type: 'accounts.username.withhold' }, target)).status).toBe(200)
  expect(await (await read()).json()).not.toHaveProperty('attribution')
  const revision = await s.f.db
    .prepare('SELECT revision FROM accounts WHERE id=?')
    .bind(owner.accountId)
    .first<number>('revision')
  const renamed = await s.f.request('/api/v1/account/username', {
    method: 'PATCH',
    headers: {
      ...owner.headers,
      origin: 'http://127.0.0.1',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      transactionId: id(),
      expectedRevision: revision,
      username: 'permitted_new_name',
    }),
  })
  expect(renamed.status).toBe(200)
  expect(await (await read()).json()).toMatchObject({
    attribution: { username: 'permitted_new_name' },
  })
  expect((await act(s, { type: 'shares.revoke' }, { kind: 'share', id: shareId })).status).toBe(200)
  expect((await act(s, { type: 'accounts.restrict', policy: 'blocked' }, target)).status).toBe(200)
  expect((await act(s, { type: 'accounts.restrict', policy: 'active' }, target)).status).toBe(200)
  expect((await read()).status).toBe(404)
  await s.f.db.prepare('UPDATE operators SET revision=revision+1 WHERE id=?').bind(s.operatorId).run()
  expect(
    (
      await s.f.request('/__accounts/control/initialize-revocations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(200)
  await s.f.runJobs()
  expect(await s.f.db.prepare('SELECT state FROM shares WHERE id=?').bind(shareId).first('state')).toBe(
    'stopped',
  )
  expect((await read()).status).toBe(404)
})
it('startedDeletionContinuesSafeCleanupAndAuditFailureCannotStartIt', async () => {
  const s = await setup(),
    owner = await customer(s.f),
    target = { kind: 'account' as const, id: owner.accountId }
  const input = adminCommand({ type: 'accounts.delete', confirmation: owner.accountId }, target)
  await s.confirm(input)
  await s.f.db
    .prepare(
      "CREATE TRIGGER fail_delete_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  expect((await s.post('actions', input)).status).toBe(503)
  expect(
    await s.f.db.prepare("SELECT count(*) AS n FROM service_jobs WHERE type='deletion'").first('n'),
  ).toBe(0)
  expect((await s.f.request('/api/v1/account', { headers: owner.headers })).status).toBe(200)
  await s.f.db.prepare('DROP TRIGGER fail_delete_audit').run()
  const response = await s.post('actions', input)
  expect(response.status).toBe(200)
  const { jobId } = (await response.json()) as { jobId: string }
  expect((await s.f.request('/api/v1/account', { headers: owner.headers })).status).toBe(403)
  await s.f.db
    .prepare("UPDATE operators SET state='revoked',revision=revision+1 WHERE id=?")
    .bind(s.operatorId)
    .run()
  expect(
    (
      await s.f.request('/__accounts/control/initialize-revocations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(200)
  for (let i = 0; i < 50; i++) {
    await s.f.runJobs()
    if (
      await s.f.db.prepare("SELECT 1 FROM service_jobs WHERE id=? AND outcome='complete'").bind(jobId).first()
    )
      break
  }
  expect(
    await s.f.db.prepare('SELECT outcome FROM service_jobs WHERE id=?').bind(jobId).first('outcome'),
  ).toBe('complete')
  expect(await s.f.db.prepare('SELECT id FROM accounts WHERE id=?').bind(owner.accountId).first()).toBeNull()
})
it('soleOwnerRemovalIsForbidden', async () => {
  const s = await setup()
  expect((await act(s, { type: 'operators.remove' }, { kind: 'operator', id: s.operatorId })).status).toBe(
    403,
  )
})
it('durableJobEligibilityNeverCancelsJournalsOrRetriesUnknownStages', async () => {
  const s = await setup(),
    jobId = id()
  await s.f.db
    .prepare(
      "INSERT INTO service_jobs(id,type,phase,expected_revision,next_at,request_id,created_at,code) VALUES (?,'cleanup','unknown',0,?,'synthetic',?,'RETRY_PENDING')",
    )
    .bind(jobId, adminTestNow, adminTestNow)
    .run()
  expect((await act(s, { type: 'jobs.retry' }, { kind: 'job', id: jobId }, 1)).status).toBe(400)
  const row = await s.f.db.prepare('SELECT * FROM service_jobs WHERE id=?').bind(jobId).first<ServiceJob>()
  const actor: OperatorPrincipal = {
    operatorId: s.operatorId,
    issuer: s.issuer.issuer,
    subject: 'synthetic-owner',
    role: 'owner',
    membershipRevision: 1,
    adminSessionId: s.session.sessionId,
    tokenExpiresAt: adminTestNow + 3600000,
  }
  const api = commands as typeof commands & {
    canRetryJob(actor: OperatorPrincipal, job: ServiceJob, now?: number): boolean
    canCancelJob(actor: OperatorPrincipal, job: ServiceJob): boolean
  }
  expect(api.canRetryJob(actor, row!, adminTestNow)).toBe(false)
  expect(api.canRetryJob(actor, { ...row!, phase: 'cleanup' }, adminTestNow)).toBe(true)
  expect(
    api.canRetryJob(actor, { ...row!, phase: 'cleanup', lease_until: adminTestNow + 1 }, adminTestNow),
  ).toBe(false)
  expect(api.canCancelJob(actor, { ...row!, phase: 'cleanup' })).toBe(false)
})
