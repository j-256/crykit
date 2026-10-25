import { afterEach, expect, it, vi } from 'vitest'
import { adminFixture, adminCommand, adminTestNow } from '../testing/admin-fixture'
import type { ServiceFixture } from '../testing/service-fixture'
import { randomId } from '../auth/identity'

const fixtures: ServiceFixture[] = []
async function setup() {
  const s = await adminFixture()
  fixtures.push(s.f)
  return s
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
async function invite(s: Awaited<ReturnType<typeof setup>>, email = 'invitee@example.org', dispatch = true) {
  const input = adminCommand(
    { type: 'operators.invite', email, role: 'administrator' },
    { kind: 'invitation', id: randomId() },
    0,
  )
  await s.confirm(input)
  const response = await s.post('actions', input)
  expect(response.status).toBe(200)
  const receipt = (await response.json()) as { jobId: string }
  if (dispatch) await s.f.runJobs()
  const mail = (await s.f.emails()).find((m) => m.recipient === email)!
  return { input, receipt, mail }
}
async function invitee(
  s: Awaited<ReturnType<typeof setup>>,
  email = 'invitee@example.org',
  subject = 'invited-subject',
  time = adminTestNow,
) {
  const assertion = s.issuer.token(time, { email, sub: subject })
  const response = await s.f.request('/api/admin/v1/access-session', {
    headers: { 'cf-access-jwt-assertion': assertion },
  })
  expect(response.status).toBe(200)
  const session = (await response.json()) as {
    csrf: string
    sessionId: string
  }
  const headers = {
    ...s.headers,
    'cf-access-jwt-assertion': assertion,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    'x-csrf-token': session.csrf,
  }
  return {
    headers,
    session,
    accept: (capability: string, overrides = {}) =>
      s.post('invitations/accept', { capability }, { ...headers, ...overrides }),
  }
}
it('invitationRequiresMatchingIdentityAndSingleUse', async () => {
  const s = await setup(),
    { input, receipt, mail } = await invite(s)
  const row = await s.f.db.prepare('SELECT * FROM admin_invitations WHERE id=?').bind(input.target.id).first<{
    token_hash: string
    root_job_id: string
    created_at: number
    expires_at: number
  }>()
  expect(row!.expires_at - row!.created_at).toBe(24 * 60 * 60 * 1000)
  expect(row!.root_job_id).toBe(receipt.jobId)
  expect(row!.token_hash).not.toBe(mail.capability)
  const wrong = await invitee(s, 'wrong@example.org')
  expect((await wrong.accept(mail.capability!)).status).toBe(403)
  const right = await invitee(s)
  expect(
    (
      await right.accept(mail.capability!, {
        origin: 'https://other.example.org',
      })
    ).status,
  ).toBe(403)
  expect((await right.accept(mail.capability!, { 'x-csrf-token': '' })).status).toBe(403)
  const accepted = await right.accept(mail.capability!)
  expect(accepted.status).toBe(200)
  expect(accepted.headers.get('set-cookie')).toContain('__Host-crykit-admin-session=')
  const body = (await accepted.json()) as { role: string }
  expect(body.role).toBe('administrator')
  expect(
    (
      await s.f.request('/api/admin/v1/session', {
        headers: {
          ...right.headers,
          cookie: accepted.headers.get('set-cookie')!.split(';')[0],
        },
      })
    ).status,
  ).toBe(200)
  expect((await right.accept(mail.capability!)).status).toBe(400)
  expect(
    await s.f.db
      .prepare('SELECT issuer,subject,role FROM operators WHERE subject=?')
      .bind('invited-subject')
      .first(),
  ).toEqual({
    issuer: s.issuer.issuer,
    subject: 'invited-subject',
    role: 'administrator',
  })
  expect(
    await s.f.db.prepare('SELECT eligible FROM email_jobs WHERE id=?').bind(receipt.jobId).first('eligible'),
  ).toBe(0)
  expect(JSON.stringify(await s.f.events())).not.toContain(mail.capability)
})
it('invitationCancellationExpiryDuplicateAndAuditFailureAreExplicit', async () => {
  const s = await setup(),
    invited = await invite(s),
    person = await invitee(s)
  const duplicate = adminCommand(
    {
      type: 'operators.invite',
      email: 'INVITEE@example.org',
      role: 'administrator',
    },
    { kind: 'invitation', id: randomId() },
    0,
  )
  await s.confirm(duplicate)
  expect((await s.post('actions', duplicate)).status).toBe(409)
  await s.f.db
    .prepare(
      "CREATE TRIGGER fail_invitation_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  expect((await person.accept(invited.mail.capability!)).status).toBe(503)
  expect(
    await s.f.db.prepare("SELECT count(*) AS n FROM operators WHERE role='administrator'").first('n'),
  ).toBe(0)
  expect(await s.f.db.prepare('SELECT state FROM admin_invitations').first('state')).toBe('pending')
  await s.f.db.prepare('DROP TRIGGER fail_invitation_audit').run()
  const cancel = adminCommand({ type: 'operators.invitation.cancel' }, invited.input.target)
  await s.confirm(cancel)
  expect((await s.post('actions', cancel)).status).toBe(200)
  expect((await person.accept(invited.mail.capability!)).status).toBe(400)
  expect(
    await s.f.db
      .prepare('SELECT eligible FROM email_jobs WHERE id=?')
      .bind(invited.receipt.jobId)
      .first('eligible'),
  ).toBe(0)
  const expired = await invite(s, 'expired@example.org')
  s.f.advance(24 * 60 * 60 * 1000)
  const late = await invitee(s, 'expired@example.org', 'expired-subject', adminTestNow + 24 * 60 * 60 * 1000)
  expect((await late.accept(expired.mail.capability!)).status).toBe(400)
})

it('revokedActorCannotStartQueuedCommandAndUnrelatedCustomerMailSurvives', async () => {
  const s = await setup(),
    invited = await invite(s, 'invitee@example.org', false)
  const { enqueueServiceEmail } = await import('../email/jobs')
  const { createServiceContext } = await import('../context')
  const context = createServiceContext(
    new Request('http://127.0.0.1'),
    s.f.env as unknown as import('../context').ServiceEnv,
    { now: () => adminTestNow, emit: () => {} },
  )
  const unrelated = randomId()
  await enqueueServiceEmail(
    {
      kind: 'security-notice',
      recipient: 'customer@example.org',
      correlationId: 'synthetic',
    },
    unrelated,
    context,
  )
  await s.f.db.prepare('UPDATE operators SET revision=revision+1 WHERE id=?').bind(s.operatorId).run()
  expect(
    await s.f.db
      .prepare('SELECT eligible FROM email_jobs WHERE id=?')
      .bind(invited.receipt.jobId)
      .first('eligible'),
  ).toBe(0)
  expect(
    await s.f.db.prepare('SELECT eligible FROM email_jobs WHERE id=?').bind(unrelated).first('eligible'),
  ).toBe(1)
  await s.f.runJobs()
  expect((await s.f.emails()).map((m) => m.kind)).toEqual(['security-notice'])
  expect((await s.post('actions', invited.input)).status).toBe(403)
})
it('uncertainInvitationSendIsNeverRetriedOrRelabeledAfterRevocation', async () => {
  const s = await setup(),
    invited = await invite(s, 'invitee@example.org', false)
  s.f.failNext('email.after-send')
  await s.f.runJobs()
  expect(
    await s.f.db
      .prepare('SELECT delivery,attempts FROM email_jobs WHERE id=?')
      .bind(invited.receipt.jobId)
      .first(),
  ).toEqual({ delivery: 'uncertain', attempts: 1 })
  const revision = await s.f.db
    .prepare('SELECT admin_revision FROM email_jobs WHERE id=?')
    .bind(invited.receipt.jobId)
    .first<number>('admin_revision')
  const retry = adminCommand({ type: 'jobs.retry' }, { kind: 'job', id: invited.receipt.jobId }, revision!)
  await s.confirm(retry)
  expect((await s.post('actions', retry)).status).toBe(409)
  await s.f.db.prepare('UPDATE operators SET revision=revision+1 WHERE id=?').bind(s.operatorId).run()
  await s.f.runJobs()
  expect(
    await s.f.db
      .prepare('SELECT delivery,attempts,eligible FROM email_jobs WHERE id=?')
      .bind(invited.receipt.jobId)
      .first(),
  ).toEqual({ delivery: 'uncertain', attempts: 1, eligible: 0 })
  expect(await s.f.emails()).toHaveLength(1)
  const person = await invitee(s)
  expect((await person.accept((await s.f.emails())[0].capability!)).status).toBe(400)
})
it.each(['session', 'creator', 'invitation'] as const)(
  'acceptanceRechecksExactLiveAuthorityAtFinalBatch: %s',
  async (raced) => {
    const s = await setup(),
      invited = await invite(s),
      person = await invitee(s)
    const { createServiceContext } = await import('../context')
    const { verifyAccessIdentity } = await import('./auth')
    const { acceptAdminInvitation } = await import('./invitations')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(s.issuer.jwks))
    let changed = false
    const db = new Proxy(s.f.db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: Parameters<typeof target.batch>[0]) => {
            if (!changed) {
              changed = true
              if (raced === 'session')
                await target
                  .prepare('UPDATE admin_access_sessions SET revoked_at=? WHERE id=?')
                  .bind(adminTestNow, person.session.sessionId)
                  .run()
              if (raced === 'creator')
                await target
                  .prepare('UPDATE operators SET revision=revision+1 WHERE id=?')
                  .bind(s.operatorId)
                  .run()
              if (raced === 'invitation')
                await target
                  .prepare("UPDATE admin_invitations SET state='cancelled',revision=revision+1 WHERE id=?")
                  .bind(invited.input.target.id)
                  .run()
            }
            return target.batch(statements)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const context = createServiceContext(
      new Request('http://127.0.0.1'),
      {
        ...s.f.env,
        DB: db,
        ADMIN_ACCESS_CONFIG: JSON.stringify(s.config),
      } as unknown as import('../context').ServiceEnv,
      { now: () => adminTestNow, emit: () => {} },
    )
    const identity = await verifyAccessIdentity(
      new Request('http://127.0.0.1', { headers: person.headers }),
      context,
      'admin',
    )
    await expect(
      acceptAdminInvitation(identity, invited.mail.capability!, person.session.sessionId, context),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(changed).toBe(true)
    expect(
      await s.f.db.prepare("SELECT count(*) AS n FROM operators WHERE role='administrator'").first('n'),
    ).toBe(0)
  },
)
it('simultaneousAcceptanceGrantsExactlyOneMembershipAndDuplicateIdentityIsExplicit', async () => {
  const s = await setup(),
    invited = await invite(s),
    person = await invitee(s)
  const responses = await Promise.all([
    person.accept(invited.mail.capability!),
    person.accept(invited.mail.capability!),
  ])
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
  expect(
    await s.f.db.prepare("SELECT count(*) AS n FROM operators WHERE role='administrator'").first('n'),
  ).toBe(1)
  const another = await invite(s, 'different@example.org'),
    duplicate = await invitee(s, 'different@example.org')
  expect((await duplicate.accept(another.mail.capability!)).status).toBe(409)
  expect(
    await s.f.db
      .prepare('SELECT state FROM admin_invitations WHERE id=?')
      .bind(another.input.target.id)
      .first('state'),
  ).toBe('pending')
})
it('invitationLandingOnlyAllowsPreMembershipAssetsWithoutOpeningManagement', async () => {
  const s = await setup(),
    assertion = s.issuer.token(adminTestNow, {
      sub: 'pre-member',
      email: 'invitee@example.org',
    })
  expect((await s.f.request('/admin/accept-invitation/')).status).toBe(401)
  for (const path of ['/admin/accept-invitation/', '/admin/accept-invitation/assets/accept.js']) {
    const response = await s.f.request(path, {
      headers: { 'cf-access-jwt-assertion': assertion },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('__Host-crykit-admin-access=')
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  for (const path of [
    '/admin',
    '/admin/assets/panel.js',
    '/admin/accept-invitation-other',
    '/api/admin/v1/operators',
  ]) {
    expect(
      (
        await s.f.request(path, {
          headers: { 'cf-access-jwt-assertion': assertion },
        })
      ).status,
    ).toBe(403)
  }
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM operators').first('n')).toBe(1)
  const { renderServiceEmail } = await import('../email/templates')
  const text = renderServiceEmail(
    {
      kind: 'admin-invite',
      recipient: 'invitee@example.org',
      capability: 'a'.repeat(43),
      expiresAt: adminTestNow + 1,
      correlationId: 'synthetic',
    },
    'https://example.org',
  ).text
  expect(text).toContain('/admin/accept-invitation/#')
  expect(text).toContain('Access policy')
})
it('creationAuditRollbackAndConcurrentRetryPreserveOneActualRootReceipt', async () => {
  const s = await setup(),
    input = adminCommand(
      {
        type: 'operators.invite',
        email: 'invitee@example.org',
        role: 'administrator',
      },
      { kind: 'invitation', id: randomId() },
      0,
    )
  await s.confirm(input)
  await s.f.db
    .prepare(
      "CREATE TRIGGER fail_invite_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  expect((await s.post('actions', input)).status).toBe(503)
  for (const table of ['admin_invitations', 'email_jobs', 'admin_actions'])
    expect(await s.f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
  await s.f.db.prepare('DROP TRIGGER fail_invite_audit').run()
  const responses = await Promise.all([s.post('actions', input), s.post('actions', input)])
  expect(responses.map((r) => r.status)).toEqual([200, 200])
  const receipts = await Promise.all(responses.map((r) => r.json()))
  expect(receipts[0]).toEqual(receipts[1])
  expect(await s.f.db.prepare('SELECT root_job_id FROM admin_invitations').first('root_job_id')).toBe(
    (receipts[0] as { jobId: string }).jobId,
  )
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM email_jobs').first('n')).toBe(1)
})
it('ownerRemovalInvalidatesAnAdministratorsQueuedVerificationWithoutStoppingAcceptedHistory', async () => {
  const s = await setup(),
    invited = await invite(s),
    person = await invitee(s)
  const accepted = await person.accept(invited.mail.capability!)
  expect(accepted.status).toBe(200)
  const memberSession = (await accepted.json()) as { csrf: string }
  const memberHeaders = {
    ...person.headers,
    cookie: accepted.headers.get('set-cookie')!.split(';')[0],
    'x-csrf-token': memberSession.csrf,
  }
  const pendingId = randomId(),
    accountId = randomId()
  await s.f.db
    .prepare(
      "INSERT INTO pending_registrations(id,account_id,normalized_email,delivery_email,username,registration_record,account_envelope,verification_revision,expires_at,created_at) VALUES (?,?,'pending@example.org','pending@example.org','pending_user','synthetic-opaque','PRIVATE-ENVELOPE-SENTINEL',1,?,?)",
    )
    .bind(pendingId, accountId, adminTestNow + 86400000, adminTestNow)
    .run()
  const resend = adminCommand({ type: 'accounts.verification.resend' }, { kind: 'account', id: accountId })
  expect((await s.post('actions/preview', resend, memberHeaders)).status).toBe(200)
  const response = await s.post('actions', resend, memberHeaders)
  expect(response.status).toBe(200)
  const { jobId } = (await response.json()) as { jobId: string }
  const memberId = await s.f.db
    .prepare("SELECT id FROM operators WHERE subject='invited-subject'")
    .first<string>('id')
  const removal = adminCommand({ type: 'operators.remove' }, { kind: 'operator', id: memberId! })
  await s.confirm(removal)
  expect((await s.post('actions', removal)).status).toBe(200)
  expect((await s.post('actions', resend, memberHeaders)).status).toBe(403)
  await s.f.runJobs()
  expect(
    await s.f.db.prepare('SELECT eligible,attempts FROM email_jobs WHERE id=?').bind(jobId).first(),
  ).toEqual({ eligible: 0, attempts: 0 })
  expect(
    await s.f.db
      .prepare('SELECT delivery,attempts FROM email_jobs WHERE id=?')
      .bind(invited.receipt.jobId)
      .first(),
  ).toEqual({ delivery: 'accepted', attempts: 1 })
  expect((await s.f.emails()).map((m) => m.kind)).toEqual(['admin-invite'])
})
