import { afterEach, expect, it } from 'vitest'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { createAccessIssuer } from '../testing/access-issuer'
import { keyedHash, randomId } from '../auth/identity'

const fixtures: ServiceFixture[] = []
const now = 1_800_000_000_000
async function setup(role = 'owner') {
  const issuer = createAccessIssuer()
  const config = {
    version: 1,
    issuer: issuer.issuer,
    jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
    adminAudience: 'ordinary-admin',
    confirmationAudience: 'action-confirmation',
    confirmationEnabled: true,
  }
  const f = await createServiceFixture({
    now,
    adminConfig: JSON.stringify(config),
    accessKeys: async () => Response.json(issuer.jwks),
  })
  fixtures.push(f)
  const accountId = randomId(),
    operatorId = randomId()
  await f.db
    .prepare(
      "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'synthetic-owner','owner@example.org',?,'active',1,?)",
    )
    .bind(operatorId, issuer.issuer, role, now)
    .run()
  await f.db
    .prepare(
      "INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at) VALUES (?,'customer@example.org','customer@example.org','synthetic',?,1000000,?)",
    )
    .bind(accountId, now, now)
    .run()
  const response = await f.request('/api/admin/v1/session', {
    headers: { 'cf-access-jwt-assertion': issuer.token(now) },
  })
  const session = (await response.json()) as {
    csrf: string
    sessionId: string
  }
  const headers = {
    'cf-access-jwt-assertion': issuer.token(now),
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    origin: 'http://127.0.0.1',
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  }
  const input = {
    version: 1,
    actionId: randomId(),
    expectedRevision: 1,
    target: { kind: 'account', id: accountId },
    reason: 'support',
    command: { type: 'accounts.restrict', policy: 'read-only' },
  }
  const post = (path: string, body: unknown, override: Record<string, string> = headers) =>
    f.request('/api/admin/v1/' + path, {
      method: 'POST',
      headers: override,
      body: JSON.stringify(body),
    })
  return {
    f,
    input,
    post,
    headers,
    issuer,
    accountId,
    operatorId,
    config,
    session,
  }
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
it('sameActionIdReturnsSameReceiptAndDifferentPayloadFails', async () => {
  const { input, post } = await setup()
  expect((await post('actions/preview', input)).status).toBe(200)
  const first = await post('actions', input)
  expect(first.status).toBe(200)
  const receipt = await first.json()
  expect(await (await post('actions', input)).json()).toEqual(receipt)
  expect(
    (
      await post('actions', {
        ...input,
        command: { type: 'accounts.restrict', policy: 'active' },
      })
    ).status,
  ).toBe(409)
})
it('auditFailureRollsBackTargetAndJob', async () => {
  const { f, input, post, accountId } = await setup()
  expect((await post('actions/preview', input)).status).toBe(200)
  await f.db
    .prepare(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  expect((await post('actions', input)).status).toBe(503)
  expect(await f.db.prepare('SELECT access FROM accounts WHERE id=?').bind(accountId).first('access')).toBe(
    'active',
  )
  expect(await f.db.prepare('SELECT count(*) AS n FROM admin_actions').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT count(*) AS n FROM service_jobs').first('n')).toBe(0)
})
it('stalePreviewCannotChangeAnotherTarget', async () => {
  const { input, post } = await setup()
  expect((await post('actions/preview', input)).status).toBe(200)
  expect((await post('actions', input)).status).toBe(200)
  expect((await post('actions', { ...input, actionId: randomId() })).status).toBe(409)
  expect(
    (
      await post('actions', {
        ...input,
        actionId: randomId(),
        target: { kind: 'share', id: input.target.id },
      })
    ).status,
  ).toBe(400)
})
it('auditsFullEmailDetailWithoutLoggingSearch', async () => {
  const { f, headers, accountId } = await setup()
  const list = await f.request('/api/admin/v1/accounts?email=customer%40example.org', { headers })
  expect(list.status).toBe(200)
  expect(JSON.stringify(await list.json())).not.toContain('customer@example.org')
  const detail = await f.request(`/api/admin/v1/accounts/${accountId}`, {
    headers,
  })
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({ email: 'customer@example.org' })
  expect(
    await f.db.prepare("SELECT target_id FROM admin_audit WHERE action='accounts.detail'").first('target_id'),
  ).toBe(accountId)
  expect(JSON.stringify(f.events())).not.toContain('customer@example.org')
})

async function confirm(s: Awaited<ReturnType<typeof setup>>, input: unknown) {
  const preview = await s.post('actions/preview', input)
  expect(preview.status).toBe(200)
  const { commandDigest } = (await preview.json()) as { commandDigest: string }
  const challenge = await s.post('confirmations', { commandDigest })
  expect(challenge.status).toBe(200)
  const { challengeId } = (await challenge.json()) as { challengeId: string }
  const response = await s.f.request('/admin/confirm/api/v1/complete', {
    method: 'POST',
    headers: {
      ...s.headers,
      'cf-access-jwt-assertion': s.issuer.token(now, {
        aud: ['action-confirmation'],
        exp: now / 1000 + 900,
      }),
    },
    body: JSON.stringify({ challengeId }),
  })
  expect(response.status).toBe(200)
}
it('enforcesEveryOwnerOnlyActionAndRejectsCustomerAuthority', async () => {
  const s = await setup('administrator')
  const commands = [
    { type: 'service.settings', patch: { uploadsPaused: true } },
    {
      type: 'operators.invite',
      email: 'invitee@example.org',
      role: 'administrator',
    },
    { type: 'operators.invitation.cancel' },
    { type: 'operators.remove' },
    { type: 'accounts.delete', confirmation: s.accountId },
  ]
  const kinds = ['service', 'invitation', 'invitation', 'operator', 'account']
  for (let i = 0; i < commands.length; i++) {
    const input = {
      ...s.input,
      actionId: randomId(),
      target: { kind: kinds[i], id: i === 0 ? 'service' : s.accountId },
      command: commands[i],
    }
    expect((await s.post('actions/preview', input)).status).toBe(403)
    expect((await s.post('actions', input)).status).toBe(403)
  }
  const response = await s.post('actions/preview', s.input, {
    'content-type': 'application/json',
    origin: 'http://127.0.0.1',
    cookie: '__Host-crykit-session=synthetic',
  })
  expect(response.status).toBe(401)
})
it('requiresOriginCsrfStrictReasonCaseAndCommandFields', async () => {
  const s = await setup()
  for (const patch of [{ origin: 'https://foreign.example.org' }, { 'x-csrf-token': 'wrong' }])
    expect((await s.post('actions/preview', s.input, { ...s.headers, ...patch })).status).toBe(403)
  for (const patch of [
    { reason: 'free text' },
    { caseId: 'x'.repeat(65) },
    { caseId: 'private title?' },
    { caseId: 'é' },
    { extra: 'x' },
    { command: { type: 'accounts.quota', quotaBytes: -1 } },
    {
      command: {
        type: 'accounts.quota',
        quotaBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    { command: { type: 'jobs.retry', parameters: { sql: 'unsafe' } } },
    {
      command: {
        type: 'accounts.sessions.revoke',
        all: false,
        revokePendingApprovals: false,
      },
    },
    {
      command: {
        type: 'accounts.sessions.revoke',
        all: true,
        sessionIds: [randomId()],
        revokePendingApprovals: false,
      },
    },
  ])
    expect((await s.post('actions/preview', { ...s.input, ...patch })).status).toBe(400)
})
it('requiresFreshConfirmationAndRejectsDigestTargetSubstitution', async () => {
  const s = await setup(),
    input = {
      ...s.input,
      command: { type: 'accounts.restrict', policy: 'blocked' },
    }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  expect((await s.post('actions', input)).status).toBe(409)
  await confirm(s, input)
  const changed = {
    ...input,
    actionId: randomId(),
    command: {
      type: 'accounts.sessions.revoke',
      all: true,
      revokePendingApprovals: true,
    },
  }
  expect((await s.post('actions/preview', changed)).status).toBe(200)
  expect((await s.post('actions', changed)).status).toBe(409)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(
    await s.f.db.prepare('SELECT access FROM accounts WHERE id=?').bind(s.accountId).first('access'),
  ).toBe('blocked')
})
it('configurationChangeAndExpiredPreviewCannotCommit', async () => {
  const s = await setup()
  expect((await s.post('actions/preview', s.input)).status).toBe(200)
  await s.f.db.prepare("UPDATE service_settings SET revision=revision+1 WHERE id='service'").run()
  expect((await s.post('actions', s.input)).status).toBe(409)
  const another = { ...s.input, actionId: randomId() }
  expect((await s.post('actions/preview', another)).status).toBe(200)
  s.f.advance(900_001)
  expect((await s.post('actions', another)).status).toBe(409)
})
it('rollsBackDeletionIntentAndTargetWhenAuditFails', async () => {
  const s = await setup(),
    input = {
      ...s.input,
      command: { type: 'accounts.delete', confirmation: s.accountId },
    }
  await confirm(s, input)
  await s.f.db
    .prepare(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  expect((await s.post('actions', input)).status).toBe(503)
  expect(
    await s.f.db.prepare('SELECT access FROM accounts WHERE id=?').bind(s.accountId).first('access'),
  ).toBe('active')
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM service_jobs').first('n')).toBe(0)
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM revocation_intents').first('n')).toBe(0)
  await s.f.db.prepare('DROP TRIGGER fail_admin_audit').run()
  const response = await s.post('actions', input)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    state: 'queued',
    targetRevision: 2,
  })
  expect(
    await s.f.db.prepare('SELECT access FROM accounts WHERE id=?').bind(s.accountId).first('access'),
  ).toBe('deleting')
  expect(await s.f.db.prepare('SELECT actor_id FROM service_jobs').first('actor_id')).toBe(s.operatorId)
  expect(
    (
      await s.post('actions', {
        ...input,
        actionId: randomId(),
        command: { ...input.command, confirmation: randomId() },
      })
    ).status,
  ).toBe(400)
})
it('quotaReductionPreservesDataAndOwnerCeilingIsGuarded', async () => {
  const s = await setup('administrator'),
    input = { ...s.input, command: { type: 'accounts.quota', quotaBytes: 0 } }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT capacity_bytes FROM accounts WHERE id=?')
      .bind(s.accountId)
      .first('capacity_bytes'),
  ).toBe(0)
  expect(
    await s.f.db.prepare('SELECT count(*) AS n FROM accounts WHERE id=?').bind(s.accountId).first('n'),
  ).toBe(1)
  const excessive = {
    ...input,
    actionId: randomId(),
    expectedRevision: 2,
    command: { type: 'accounts.quota', quotaBytes: 2147483649 },
  }
  expect((await s.post('actions/preview', excessive)).status).toBe(200)
  expect((await s.post('actions', excessive)).status).toBe(400)
})
it('boundsIndexedListsBindsCursorsAndAuditsBeforeFullEmailRead', async () => {
  const s = await setup()
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'q=private', 'username=invalid%20search'])
    expect(
      (
        await s.f.request('/api/admin/v1/accounts?' + query, {
          headers: s.headers,
        })
      ).status,
    ).toBe(400)
  const second = randomId()
  await s.f.db
    .prepare(
      "INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at) VALUES (?,'other@example.org','other@example.org','another',?,1,?)",
    )
    .bind(second, now, now + 1)
    .run()
  const first = (await (
    await s.f.request('/api/admin/v1/accounts?limit=1', { headers: s.headers })
  ).json()) as { next: string; items: unknown[] }
  expect(first.items).toHaveLength(1)
  const next = await s.f.request('/api/admin/v1/accounts?limit=1&cursor=' + encodeURIComponent(first.next), {
    headers: s.headers,
  })
  expect(next.status).toBe(200)
  expect(((await next.json()) as { items: unknown[] }).items).toHaveLength(1)
  expect(
    (
      await s.f.request(
        '/api/admin/v1/accounts?email=other%40example.org&cursor=' + encodeURIComponent(first.next),
        { headers: s.headers },
      )
    ).status,
  ).toBe(409)
  await s.f.db
    .prepare(
      "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_fault'); END",
    )
    .run()
  const failed = await s.f.request('/api/admin/v1/accounts/' + s.accountId, {
    headers: s.headers,
  })
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain('customer@example.org')
})
it('pages newest accounts with tied timestamps and combines identity with access', async () => {
  const s = await setup()
  const active = randomId()
  const blocked = randomId()
  await s.f.db.prepare("INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at,access) VALUES (?,'second@example.org','second@example.org','second',?,1,?,'active')").bind(active, now, now).run()
  await s.f.db.prepare("INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at,access) VALUES (?,'blocked@example.org','blocked@example.org','blocked',?,1,?,'blocked')").bind(blocked, now, now).run()
  const pending = randomId()
  await s.f.db.prepare("INSERT INTO pending_registrations(id,account_id,normalized_email,delivery_email,username,registration_record,expires_at,created_at) VALUES (?,?,?,?,?,'synthetic',?,?)").bind(randomId(), pending, 'pending@example.org', 'pending@example.org', 'pending', now + 1000, now).run()
  const read = async (query: string) => {
    const response = await s.f.request('/api/admin/v1/accounts?' + query, { headers: s.headers })
    expect(response.status).toBe(200)
    return response.json() as Promise<{ items: { id: string; access: string; email: string }[]; next: string | null }>
  }
  const expected = [s.accountId, active, blocked, pending].sort().reverse()
  const ids: string[] = []
  let next: string | null = null
  do {
    const page = await read('order=desc&limit=1' + (next ? '&cursor=' + encodeURIComponent(next) : ''))
    ids.push(...page.items.map((item) => item.id))
    expect(JSON.stringify(page.items)).not.toContain('@example.org')
    next = page.next
  } while (next)
  expect(ids).toEqual(expected)
  expect((await read('access=pending')).items.map((item) => item.id)).toEqual([pending])
  expect((await read('accountId=' + blocked + '&access=blocked')).items.map((item) => item.id)).toEqual([blocked])
  expect((await read('email=blocked%40example.org&access=active')).items).toEqual([])
  const first = await read('order=desc&limit=1&access=active')
  for (const changed of ['order=asc&access=active', 'order=desc&access=blocked', 'order=desc&access=active&accountId=' + active]) {
    expect((await s.f.request('/api/admin/v1/accounts?' + changed + '&limit=1&cursor=' + encodeURIComponent(first.next!), { headers: s.headers })).status).toBe(409)
  }
  const legacy = await read('limit=1')
  const body = btoa(JSON.stringify([now, legacy.items[0].id]))
  const legacyScope = await keyedHash(
    s.f.env.CURSOR_SECRET,
    'admin-search',
    JSON.stringify([s.operatorId, 'accounts', null]),
  )
  const legacyCursor = `${body}.${await keyedHash(s.f.env.CURSOR_SECRET, `admin-cursor:${legacyScope}`, body)}`
  expect((await read('limit=1&cursor=' + encodeURIComponent(legacyCursor))).items).toHaveLength(1)
})
it('pages mixed job branches in global descending order and validates route facets', async () => {
  const s = await setup()
  const service = [randomId(), randomId()]
  const email = [randomId(), randomId()]
  for (const [i, id] of service.entries()) await s.f.db.prepare("INSERT INTO service_jobs(id,type,phase,account_id,expected_revision,next_at,outcome,request_id,created_at) VALUES (?,'cleanup','queued',?,1,?,'pending','synthetic',?)").bind(id, i ? null : s.accountId, now, now).run()
  for (const [i, id] of email.entries()) await s.f.db.prepare("INSERT INTO email_jobs(id,request_digest,request_id,state,delivery,next_attempt_at,expires_at,created_at,updated_at) VALUES (?,?,'synthetic',?,'pending',?,?,?,?)").bind(id, id, i ? 'failed' : 'queued', now, now + 1000, now, now).run()
  const get = async (path: string) => s.f.request('/api/admin/v1/' + path, { headers: s.headers })
  const ids: string[] = []
  let next: string | null = null
  do {
    const result = await get('jobs?order=desc&limit=1' + (next ? '&cursor=' + encodeURIComponent(next) : ''))
    expect(result.status).toBe(200)
    const page = await result.json() as { items: { id: string }[]; next: string | null }
    ids.push(...page.items.map((item) => item.id))
    next = page.next
  } while (next)
  expect(ids).toEqual([...service, ...email].sort().reverse())
  expect(((await (await get('jobs?type=email&outcome=failed')).json()) as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([email[1]])
  expect(((await (await get('jobs?accountId=' + s.accountId + '&type=cleanup&outcome=pending')).json()) as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([service[0]])
  for (const path of ['accounts?type=email', 'jobs?state=active', 'shares?access=active', 'operators?outcome=read', 'audit?action=invented', 'audit?outcome=failed', 'accounts?order=sideways', 'jobs?type=email&type=cleanup']) expect((await get(path)).status).toBe(400)
})
it('filters share states and authored audit actions with signed page scopes', async () => {
  const s = await setup()
  const shareIds = [randomId(), randomId(), randomId()]
  for (const [i, id] of shareIds.entries()) await s.f.db.prepare('INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,?,0,?,?)').bind(id, s.accountId, ['active', 'stopping', 'stopped'][i], now, now).run()
  const get = async (path: string) => s.f.request('/api/admin/v1/' + path, { headers: s.headers })
  const share = await get('shares?accountId=' + s.accountId + '&state=stopping')
  expect(share.status).toBe(200)
  expect(((await share.json()) as { items: { id: string }[] }).items.map((row) => row.id)).toEqual([shareIds[1]])
  for (const action of ['accounts.detail', 'operators.invitation.accept', 'accounts.sessions.revoke', 'session.login']) expect((await get('audit?action=' + action)).status).toBe(200)
  const login = await get('audit?action=session.login&outcome=complete')
  expect(login.status).toBe(200)
  expect(((await login.json()) as { items: unknown[] }).items).toMatchObject([
    { action: 'session.login', outcome: 'complete', actor_id: s.operatorId },
  ])
  const detail = await get('accounts/' + s.accountId)
  expect(detail.status).toBe(200)
  expect((await get('accounts/' + s.accountId)).status).toBe(200)
  const audit = await get('audit?action=accounts.detail&outcome=read&limit=1')
  expect(audit.status).toBe(200)
  const page = (await audit.json()) as { items: unknown[]; next: string | null }
  expect(page.items).toMatchObject([{ action: 'accounts.detail', outcome: 'read' }])
  expect(page.next).not.toBeNull()
  for (const changed of ['action=session.login&outcome=read', 'action=accounts.detail&outcome=complete']) {
    expect((await get('audit?' + changed + '&limit=1&cursor=' + encodeURIComponent(page.next!))).status).toBe(409)
  }
  expect((await get('audit?action=accounts.detail&outcome=pending')).status).toBe(400)
  expect((await get('shares?state=deleted')).status).toBe(400)
})
it('projects coherent settings and nullable logical capacity without changing email bounds', async () => {
  const s = await setup()
  const get = async () => (await (await s.f.request('/api/admin/v1/overview', { headers: s.headers })).json()) as Record<string, any>
  const initial = await get()
  expect(initial.settings).toMatchObject({ revision: 1, deploymentCapacity: Number(s.f.env.STORAGE_CAP_BYTES) })
  expect(initial.capacity.usedBytes).toBe(initial.counters.payload_bytes + initial.counters.reserved_metadata + initial.counters.metadata_bytes)
  await s.f.db.prepare("INSERT INTO pending_registrations(id,account_id,normalized_email,delivery_email,username,registration_record,expires_at,created_at) VALUES (?,?,?,?,?,'synthetic',?,?)").bind(randomId(), randomId(), 'pending-count@example.org', 'pending-count@example.org', 'pendingcount', now + 1000, now).run()
  expect((await get()).accounts).toBe(1)
  for (const [i, createdAt] of [now - 24 * 60 * 60 * 1000, now - 24 * 60 * 60 * 1000 - 1, now + 1].entries()) await s.f.db.prepare("INSERT INTO email_jobs(id,request_digest,request_id,state,delivery,next_attempt_at,expires_at,created_at,updated_at) VALUES (?,?,'synthetic','queued','pending',?,?,?,?)").bind(randomId(), `synthetic-${i}`, now, now + 1000, createdAt, createdAt).run()
  const bounded = await get()
  expect(bounded.email.states).toEqual([{ state: 'queued', count: 1 }])
  expect(bounded.oldestUnfinishedJob).toBeNull()
  await s.f.db.prepare('UPDATE service_settings SET project_capacity_bytes=?,max_account_bytes=? WHERE id=\'service\'').bind(Number(s.f.env.STORAGE_CAP_BYTES) + 100, Number(s.f.env.STORAGE_CAP_BYTES) + 100).run()
  expect((await get()).settings).toMatchObject({ projectCapacityBytes: Number(s.f.env.STORAGE_CAP_BYTES), maxAccountBytes: Number(s.f.env.STORAGE_CAP_BYTES) })
  await s.f.db.prepare('UPDATE service_settings SET project_capacity_bytes=100,max_account_bytes=50,uploads_paused=1 WHERE id=\'service\'').run()
  await s.f.db.prepare("UPDATE quota_counters SET payload_bytes=0,reserved_metadata=0,metadata_bytes=0 WHERE scope='global'").run()
  const zero = await get()
  expect(zero.settings).toMatchObject({ maxAccountBytes: 50, projectCapacityBytes: 100, uploadsPaused: true })
  expect(zero.capacity).toEqual({ usedBytes: 0, availableBytes: 100, overCapacity: false })
  await s.f.db.prepare("UPDATE quota_counters SET payload_bytes=80,reserved_metadata=20,metadata_bytes=1 WHERE scope='global'").run()
  expect((await get()).capacity).toEqual({ usedBytes: 101, availableBytes: 0, overCapacity: true })
  await s.f.db.prepare("DELETE FROM quota_counters WHERE scope='global'").run()
  const missing = await get()
  expect(missing.counters).toBeNull()
  expect(missing.capacity).toBeNull()
  expect(missing.email).toMatchObject({ windowStart: now - 24 * 60 * 60 * 1000, windowEnd: now })
})
it('invitationCommandsUseC03PreparedAuthorityAndOutbox', async () => {
  const s = await setup(),
    input = {
      ...s.input,
      expectedRevision: 0,
      target: { kind: 'invitation', id: randomId() },
      command: {
        type: 'operators.invite',
        email: 'invitee@example.org',
        role: 'administrator',
      },
    }
  await confirm(s, input)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM admin_invitations').first('n')).toBe(1)
  expect((await s.f.emails()).length).toBe(0)
})
it('safeOperationalQueriesNeverExposePrivateDescriptorsOrTransport', async () => {
  const s = await setup()
  for (const path of ['overview', 'accounts', 'shares', 'jobs', 'settings', 'audit', 'operators']) {
    const response = await s.f.request('/api/admin/v1/' + path, {
      headers: s.headers,
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toMatch(
      /account_envelope|keyEnvelope|token_hash|"payload":|server_state|registration_record|delivery_email/,
    )
    expect(text).toContain('application-database')
  }
  expect((await s.f.request('/api/admin/v1/jobs/' + randomId(), { headers: s.headers })).status).toBe(404)
  expect(
    (
      await s.f.request('/api/admin/v1/accounts/' + s.accountId + '/private', {
        headers: s.headers,
      })
    ).status,
  ).toBe(404)
})

it('selectedSessionsAreScopedAndWithholdingPreservesAccountIdentity', async () => {
  const s = await setup('administrator'),
    device = randomId(),
    session = randomId(),
    other = randomId()
  await s.f.db
    .prepare('INSERT INTO devices(id,account_id,created_at) VALUES (?,?,?)')
    .bind(device, s.accountId, now)
    .run()
  for (const id of [session, other])
    await s.f.db
      .prepare(
        'INSERT INTO customer_sessions(id,token_hash,account_id,device_id,authenticated_at,idle_expires_at,absolute_expires_at,remembered) VALUES (?,?,?,?,?,?,?,0)',
      )
      .bind(id, randomId(), s.accountId, device, now, now + 10000, now + 10000)
      .run()
  const input = {
    ...s.input,
    command: {
      type: 'accounts.sessions.revoke',
      all: false,
      sessionIds: [session],
      revokePendingApprovals: false,
    },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT revoked_at FROM customer_sessions WHERE id=?')
      .bind(session)
      .first('revoked_at'),
  ).toBe(now)
  expect(
    await s.f.db
      .prepare('SELECT revoked_at FROM customer_sessions WHERE id=?')
      .bind(other)
      .first('revoked_at'),
  ).toBeNull()
  const foreign = {
    ...input,
    expectedRevision: 2,
    actionId: randomId(),
    command: { ...input.command, sessionIds: [randomId()] },
  }
  expect((await s.post('actions/preview', foreign)).status).toBe(200)
  expect((await s.post('actions', foreign)).status).toBe(409)
  const withheld = {
    ...s.input,
    expectedRevision: 2,
    actionId: randomId(),
    command: { type: 'accounts.username.withhold' },
  }
  expect((await s.post('actions/preview', withheld)).status).toBe(200)
  expect((await s.post('actions', withheld)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT username,username_withheld FROM accounts WHERE id=?')
      .bind(s.accountId)
      .first(),
  ).toEqual({ username: 'synthetic', username_withheld: 1 })
  expect(
    await (await s.f.request('/api/admin/v1/accounts/' + s.accountId, { headers: s.headers })).json(),
  ).toMatchObject({ username_withheld: 1 })
})
it('jobRevisionsAdvanceWithoutResettingAttemptsAndRejectStaleCommands', async () => {
  const s = await setup('administrator'),
    id = randomId()
  await s.f.db
    .prepare(
      "INSERT INTO service_jobs(id,type,phase,account_id,expected_revision,next_at,request_id,created_at,code,attempts) VALUES (?,'deletion','ledger',?,2,?,'synthetic',?,'RETRY_PENDING',3)",
    )
    .bind(id, s.accountId, now + 10000, now)
    .run()
  const input = {
    ...s.input,
    target: { kind: 'job', id },
    command: { type: 'jobs.retry' },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  await s.f.db.prepare('UPDATE service_jobs SET next_at=next_at+1 WHERE id=?').bind(id).run()
  expect((await s.post('actions', input)).status).toBe(409)
  const fresh = { ...input, actionId: randomId(), expectedRevision: 2 }
  expect((await s.post('actions/preview', fresh)).status).toBe(200)
  expect((await s.post('actions', fresh)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT admin_revision,expected_revision,attempts FROM service_jobs WHERE id=?')
      .bind(id)
      .first(),
  ).toEqual({ admin_revision: 3, expected_revision: 2, attempts: 3 })
  const cancel = {
    ...fresh,
    actionId: randomId(),
    expectedRevision: 3,
    command: { type: 'jobs.cancel' },
  }
  expect((await s.post('actions/preview', cancel)).status).toBe(200)
  expect((await s.post('actions', cancel)).status).toBe(400)
})
it('migrationBackfillsJobRevisionsAndChargesExactMonotonicChanges', async () => {
  const { readFile } = await import('node:fs/promises'),
    { unstable_splitSqlQuery: split } = await import('wrangler')
  const f = await createServiceFixture({
    now,
    migrationThrough: '0012-operators.sql',
  })
  fixtures.push(f)
  const id = randomId()
  await f.db
    .prepare(
      "INSERT INTO service_jobs(id,type,phase,expected_revision,next_at,request_id,created_at) VALUES (?,'cleanup','cleanup',0,?,'synthetic',?)",
    )
    .bind(id, now, now)
    .run()
  await f.db.batch(
    split(await readFile('worker/migrations/0013-admin-commands.sql', 'utf8')).map((sql) =>
      f.db.prepare(sql),
    ),
  )
  expect(
    await f.db.prepare('SELECT admin_revision FROM service_jobs WHERE id=?').bind(id).first('admin_revision'),
  ).toBe(1)
  const before = await f.db
    .prepare("SELECT metadata_bytes FROM quota_counters WHERE scope='global'")
    .first<number>('metadata_bytes')
  const old = await f.db
    .prepare('SELECT metadata_bytes FROM service_jobs WHERE id=?')
    .bind(id)
    .first<number>('metadata_bytes')
  await f.db.prepare('UPDATE service_jobs SET admin_revision=9 WHERE id=?').bind(id).run()
  await f.db.prepare("UPDATE service_jobs SET phase='another' WHERE id=?").bind(id).run()
  expect(
    await f.db.prepare('SELECT admin_revision FROM service_jobs WHERE id=?').bind(id).first('admin_revision'),
  ).toBe(10)
  const changed = await f.db
    .prepare('SELECT metadata_bytes FROM service_jobs WHERE id=?')
    .bind(id)
    .first<number>('metadata_bytes')
  expect(
    await f.db
      .prepare("SELECT metadata_bytes FROM quota_counters WHERE scope='global'")
      .first('metadata_bytes'),
  ).toBe(before! + changed! - old! + 1)
  await expect(
    f.db.prepare('UPDATE service_jobs SET admin_revision=1 WHERE id=?').bind(id).run(),
  ).rejects.toThrow('revision_regressed')
  await f.db.prepare("UPDATE recovery_control SET state='closed' WHERE id=1").run()
  await expect(
    f.db.prepare("UPDATE service_settings SET revision=revision+1 WHERE id='service'").run(),
  ).rejects.toThrow()
})
it('emailRetryAndCancelPreserveDeliveryOwnershipAndCumulativeBudget', async () => {
  const s = await setup('administrator'),
    { enqueueServiceEmail } = await import('../email/jobs'),
    { createServiceContext } = await import('../context')
  const context = createServiceContext(
    new Request('http://127.0.0.1'),
    s.f.env as unknown as import('../context').ServiceEnv,
    { now: () => now, emit: () => {} },
  )
  const id = randomId()
  await enqueueServiceEmail(
    {
      kind: 'security-notice',
      recipient: 'customer@example.org',
      correlationId: 'synthetic',
    },
    id,
    context,
  )
  await s.f.db
    .prepare("UPDATE email_jobs SET state='failed',delivery='unsent',attempts=2 WHERE id=?")
    .bind(id)
    .run()
  const input = {
    ...s.input,
    target: { kind: 'job', id },
    expectedRevision: 2,
    command: { type: 'jobs.retry' },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(
    await s.f.db.prepare('SELECT state,attempts,admin_revision FROM email_jobs WHERE id=?').bind(id).first(),
  ).toEqual({ state: 'queued', attempts: 2, admin_revision: 3 })
  const cancel = {
    ...input,
    actionId: randomId(),
    expectedRevision: 3,
    command: { type: 'jobs.cancel' },
  }
  expect((await s.post('actions/preview', cancel)).status).toBe(200)
  expect((await s.post('actions', cancel)).status).toBe(409)
  const fresh = randomId()
  await enqueueServiceEmail(
    {
      kind: 'security-notice',
      recipient: 'customer@example.org',
      correlationId: 'synthetic-fresh',
    },
    fresh,
    context,
  )
  const safe = {
    ...cancel,
    actionId: randomId(),
    expectedRevision: 1,
    target: { kind: 'job', id: fresh },
  }
  expect((await s.post('actions/preview', safe)).status).toBe(200)
  expect((await s.post('actions', safe)).status).toBe(200)
  expect(
    await s.f.db.prepare('SELECT eligible FROM email_jobs WHERE id=?').bind(fresh).first('eligible'),
  ).toBe(0)
  const listed = await s.f.request('/api/admin/v1/jobs?jobId=' + fresh, {
    headers: s.headers,
  })
  expect(listed.status).toBe(200)
  expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(1)
})
it('adminStopUsesActualFrozenPendingJournalAndTrustedLedgerReconciliation', async () => {
  const s = await setup(),
    id = randomId(),
    snapshot = {
      version: 5,
      kind: 'build',
      title: 'Public synthetic build',
      setup: {
        catalogLock: { 'exact-public-baseline': 'historical-source-v1' },
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
  await s.f.db
    .prepare(
      "INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',0,?,?)",
    )
    .bind(id, s.accountId, now, now)
    .run()
  await s.f.db
    .prepare('INSERT INTO share_snapshots(share_id,account_id,revision,snapshot) VALUES (?,?,1,?)')
    .bind(id, s.accountId, JSON.stringify(snapshot))
    .run()
  expect((await s.f.request('/api/public/v1/shares/' + id)).status).toBe(200)
  const input = {
    ...s.input,
    target: { kind: 'share', id },
    command: { type: 'shares.revoke' },
  }
  await confirm(s, input)
  const response = await s.post('actions', input)
  expect(response.status).toBe(200)
  const receipt = (await response.json()) as { state: string; jobId: string }
  expect(receipt.state).toBe('queued')
  const jobDetail = await s.f.request('/api/admin/v1/jobs/' + receipt.jobId, { headers: s.headers })
  expect(jobDetail.status).toBe(200)
  expect(await jobDetail.json()).toMatchObject({
    id: receipt.jobId,
    share_id: id,
    type: 'share-stop',
    outcome: 'pending',
  })
  expect((await s.f.request('/api/public/v1/shares/' + id)).status).toBe(404)
  const frozen = await s.f.db
    .prepare('SELECT event,receipt FROM share_mutations WHERE mutation_id=?')
    .bind(receipt.jobId)
    .first<{ event: string; receipt: string | null }>()
  expect(frozen!.receipt).toBeNull()
  await s.f.runJobs()
  expect(
    await s.f.db
      .prepare('SELECT receipt FROM share_mutations WHERE mutation_id=?')
      .bind(receipt.jobId)
      .first('receipt'),
  ).toBeNull()
  await s.f.request('/__accounts/control/initialize-revocations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  await s.f.runJobs()
  expect(await s.f.db.prepare('SELECT state,revision FROM shares WHERE id=?').bind(id).first()).toEqual({
    state: 'stopped',
    revision: 2,
  })
  expect(
    await s.f.db
      .prepare('SELECT event FROM share_mutations WHERE mutation_id=?')
      .bind(receipt.jobId)
      .first('event'),
  ).toBe(frozen!.event)
  expect(await (await s.post('actions', input)).json()).toEqual(receipt)
})
it('actualSettingsPauseEmailAdmissionAndCustomerWritesWithoutHidingReads', async () => {
  const s = await setup(),
    { customer, prepared, post, command } = await import('../sync/testing')
  const signed = await customer(s.f, 'settings'),
    upload = await prepared(s.f, signed)
  const input = {
    ...s.input,
    target: { kind: 'service', id: 'service' },
    command: {
      type: 'service.settings',
      patch: {
        registrationPaused: true,
        uploadsPaused: true,
        sharingPaused: true,
        emailPaused: true,
        projectCapacityBytes: 1000000,
        maxAccountBytes: 1000000,
      },
    },
  }
  await confirm(s, input)
  expect((await s.post('actions', input)).status).toBe(200)
  expect((await post(s.f, 'sync/commits', command([upload.descriptor]), signed.headers)).status).toBe(403)
  expect((await s.f.request('/api/v1/account', { headers: signed.headers })).status).toBe(200)
  expect(await (await s.f.request('/api/v1/service')).json()).toMatchObject({
    accountsAvailable: true,
    signupAvailable: false,
  })
  const { enqueueServiceEmail } = await import('../email/jobs'),
    { createServiceContext } = await import('../context')
  const context = createServiceContext(
    new Request('http://127.0.0.1'),
    s.f.env as unknown as import('../context').ServiceEnv,
    { now: () => now, emit: () => {} },
  )
  const id = randomId(),
    before = (await s.f.emails()).length
  await enqueueServiceEmail(
    {
      kind: 'security-notice',
      recipient: 'customer@example.org',
      correlationId: 'paused',
    },
    id,
    context,
  )
  await s.f.runJobs()
  expect((await s.f.emails()).length).toBe(before)
  expect(
    await s.f.db.prepare('SELECT attempts,delivery FROM email_jobs WHERE id=?').bind(id).first(),
  ).toEqual({ attempts: 0, delivery: 'paused' })
})
it('finalBatchRejectsRevokedAuthorityAfterSuccessfulPreparation', async () => {
  const s = await setup(),
    { executeAdminCommand } = await import('./commands'),
    { AdminCommandSchema } = await import('../../src/account/admin-protocol'),
    { createServiceContext } = await import('../context')
  expect((await s.post('actions/preview', s.input)).status).toBe(200)
  let intercepted = false
  const db = new Proxy(s.f.db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: Parameters<typeof target.batch>[0]) => {
          if (!intercepted) {
            intercepted = true
            await target
              .prepare("UPDATE operators SET state='revoked',revision=revision+1 WHERE id=?")
              .bind(s.operatorId)
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
    { now: () => now, emit: () => {} },
  )
  const actor = {
    operatorId: s.operatorId,
    issuer: s.issuer.issuer,
    subject: 'synthetic-owner',
    role: 'owner' as const,
    membershipRevision: 1,
    adminSessionId: s.session.sessionId,
    tokenExpiresAt: now + 3600000,
  }
  await expect(executeAdminCommand(actor, AdminCommandSchema.parse(s.input), context)).rejects.toMatchObject({
    code: 'HEAD_CONFLICT',
  })
  expect(intercepted).toBe(true)
  expect(
    await s.f.db.prepare('SELECT access FROM accounts WHERE id=?').bind(s.accountId).first('access'),
  ).toBe('active')
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM admin_actions').first('n')).toBe(0)
})
it('resendTargetsOnlyExistingPendingAuthorityAndRevocationStopsUnstartedMail', async () => {
  const s = await setup(),
    id = randomId(),
    pending = randomId()
  await s.f.db
    .prepare(
      "INSERT INTO pending_registrations(id,account_id,normalized_email,delivery_email,username,registration_record,account_envelope,verification_revision,expires_at,created_at) VALUES (?,?,'pending@example.org','pending@example.org','pending_user','opaque-synthetic','PRIVATE-ENVELOPE-SENTINEL',1,?,?)",
    )
    .bind(pending, id, now + 86400000, now)
    .run()
  const input = {
    ...s.input,
    target: { kind: 'account', id },
    command: { type: 'accounts.verification.resend' },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  const response = await s.post('actions', input)
  expect(response.status).toBe(200)
  const receipt = (await response.json()) as { jobId: string }
  expect(await (await s.post('actions', input)).json()).toEqual(receipt)
  expect(
    await s.f.db
      .prepare('SELECT verification_revision FROM pending_registrations WHERE id=?')
      .bind(pending)
      .first('verification_revision'),
  ).toBe(2)
  const detail = await s.f.request('/api/admin/v1/accounts/' + id, {
    headers: s.headers,
  })
  expect(detail.status).toBe(200)
  expect(await detail.text()).not.toContain('PRIVATE-ENVELOPE-SENTINEL')
  await s.f.db
    .prepare("UPDATE operators SET state='revoked',revision=revision+1 WHERE id=?")
    .bind(s.operatorId)
    .run()
  expect(
    await s.f.db.prepare('SELECT eligible FROM email_jobs WHERE id=?').bind(receipt.jobId).first('eligible'),
  ).toBe(0)
  await s.f.runJobs()
  expect(await s.f.emails()).toHaveLength(0)
})
it('ownerRemovalIsForbiddenAndAdministratorRemovalInvalidatesSessions', async () => {
  const s = await setup(),
    input = {
      ...s.input,
      target: { kind: 'operator', id: s.operatorId },
      command: { type: 'operators.remove' },
    }
  await confirm(s, input)
  expect((await s.post('actions', input)).status).toBe(403)
  const id = randomId(),
    session = randomId()
  await s.f.db
    .prepare(
      "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'another','admin@example.org','administrator','active',1,?)",
    )
    .bind(id, s.issuer.issuer, now)
    .run()
  await s.f.db
    .prepare(
      'INSERT INTO admin_sessions(id,token_hash,operator_id,membership_revision,created_at,expires_at) VALUES (?,?,?,1,?,?)',
    )
    .bind(session, randomId(), id, now, now + 3600000)
    .run()
  const remove = {
    ...input,
    actionId: randomId(),
    target: { kind: 'operator', id },
  }
  await confirm(s, remove)
  expect((await s.post('actions', remove)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT revoked_at FROM admin_sessions WHERE id=?')
      .bind(session)
      .first('revoked_at'),
  ).not.toBeNull()
})
it('auditRetentionKeepsReceiptsAndRejectsAuditUpdates', async () => {
  const s = await setup(),
    { cleanupAdminCommands } = await import('./audit'),
    { createServiceContext } = await import('../context')
  expect((await s.post('actions/preview', s.input)).status).toBe(200)
  expect((await s.post('actions', s.input)).status).toBe(200)
  await expect(s.f.db.prepare("UPDATE admin_audit SET reason='maintenance'").run()).rejects.toThrow(
    'audit_immutable',
  )
  const context = createServiceContext(
    new Request('http://127.0.0.1'),
    s.f.env as unknown as import('../context').ServiceEnv,
    { now: () => now + 90 * 86400000 + 1, emit: () => {} },
  )
  await cleanupAdminCommands(context)
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM admin_audit').first('n')).toBe(0)
  expect(await s.f.db.prepare('SELECT count(*) AS n FROM admin_actions').first('n')).toBe(1)
})
it('operatorRevocationAfterSendStartPreservesAcceptedAttemptAndUnrelatedMail', async () => {
  const s = await setup(),
    id = randomId(),
    pending = randomId(),
    { createServiceContext } = await import('../context'),
    { dispatchEmailJobs, enqueueServiceEmail } = await import('../email/jobs')
  await s.f.db
    .prepare(
      "INSERT INTO pending_registrations(id,account_id,normalized_email,delivery_email,username,registration_record,account_envelope,verification_revision,expires_at,created_at) VALUES (?,?,'inflight@example.org','inflight@example.org','inflight_user','opaque-synthetic','PRIVATE-ENVELOPE-SENTINEL',1,?,?)",
    )
    .bind(pending, id, now + 86400000, now)
    .run()
  const input = {
    ...s.input,
    target: { kind: 'account', id },
    command: { type: 'accounts.verification.resend' },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  const receipt = (await (await s.post('actions', input)).json()) as {
    jobId: string
  }
  let sends = 0
  const context = createServiceContext(
    new Request('http://127.0.0.1'),
    s.f.env as unknown as import('../context').ServiceEnv,
    {
      now: () => now,
      emit: () => {},
      emailTransport: {
        send: async () => {
          sends++
          expect(
            await s.f.db
              .prepare('SELECT delivery FROM email_attempts WHERE job_id=?')
              .bind(receipt.jobId)
              .first('delivery'),
          ).toBe('sending')
          await s.f.db
            .prepare("UPDATE operators SET state='revoked',revision=revision+1 WHERE id=?")
            .bind(s.operatorId)
            .run()
          return { messageId: 'synthetic-accepted' }
        },
      },
    },
  )
  const unrelated = randomId()
  await enqueueServiceEmail(
    {
      kind: 'security-notice',
      recipient: 'unrelated@example.org',
      correlationId: 'unrelated',
    },
    unrelated,
    { ...context, now: () => now + 1 },
  )
  await dispatchEmailJobs(context, 1)
  expect(sends).toBe(1)
  expect(
    await s.f.db
      .prepare('SELECT eligible,delivery,attempts FROM email_jobs WHERE id=?')
      .bind(receipt.jobId)
      .first(),
  ).toEqual({ eligible: 0, delivery: 'accepted', attempts: 1 })
  expect(
    await s.f.db.prepare('SELECT eligible FROM email_jobs WHERE id=?').bind(unrelated).first('eligible'),
  ).toBe(1)
})
it('sharingPauseAndUploadPauseStayIndependentAndNewAccountsRespectOwnerCeiling', async () => {
  const s = await setup(),
    { customer, post } = await import('../sync/testing')
  const settings = {
    ...s.input,
    target: { kind: 'service', id: 'service' },
    command: { type: 'service.settings', patch: { uploadsPaused: true, maxAccountBytes: 100000 } },
  }
  await confirm(s, settings)
  expect((await s.post('actions', settings)).status).toBe(200)
  const signed = await customer(s.f, 'ceiling')
  expect(
    await s.f.db
      .prepare('SELECT capacity_bytes FROM accounts WHERE id=?')
      .bind(signed.accountId)
      .first('capacity_bytes'),
  ).toBe(100000)
  const snapshot = {
    version: 5,
    kind: 'build',
    title: 'Public synthetic build',
    setup: {
      catalogLock: { 'exact-public-baseline': 'historical-source-v1' },
      baseline: null,
      layers: [],
      mode: { state: 'unknown' },
      ppCostsNonNegative: { state: 'unknown' },
      slots: [],
    },
    slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }],
    receipts: [],
  }
  const input = { mutationId: randomId(), snapshot, includeAttribution: false }
  const published = await post(s.f, 'shares', input, signed.headers)
  expect(published.status).toBe(200)
  const receipt = await published.json()
  expect(await (await post(s.f, 'shares', input, signed.headers)).json()).toEqual(receipt)
  const paused = {
    ...settings,
    actionId: randomId(),
    expectedRevision: 2,
    command: { type: 'service.settings', patch: { sharingPaused: true } },
  }
  await confirm(s, paused)
  expect((await s.post('actions', paused)).status).toBe(200)
  expect((await post(s.f, 'shares', { ...input, mutationId: randomId() }, signed.headers)).status).toBe(403)
})
it('maximumSessionSelectionFitsActualGuardedStatementBindings', async () => {
  const s = await setup('administrator'),
    device = randomId(),
    ids = Array.from({ length: 100 }, () => randomId())
  await s.f.db
    .prepare('INSERT INTO devices(id,account_id,created_at) VALUES (?,?,?)')
    .bind(device, s.accountId, now)
    .run()
  await s.f.db
    .prepare(
      'INSERT INTO customer_sessions(id,token_hash,account_id,device_id,authenticated_at,idle_expires_at,absolute_expires_at,remembered) SELECT value,value,?,?,?,?,?,0 FROM json_each(?)',
    )
    .bind(s.accountId, device, now, now + 10000, now + 10000, JSON.stringify(ids))
    .run()
  const input = {
    ...s.input,
    command: { type: 'accounts.sessions.revoke', all: false, sessionIds: ids, revokePendingApprovals: false },
  }
  expect((await s.post('actions/preview', input)).status).toBe(200)
  expect((await s.post('actions', input)).status).toBe(200)
  expect(
    await s.f.db
      .prepare('SELECT count(*) AS n FROM customer_sessions WHERE account_id=? AND revoked_at=?')
      .bind(s.accountId, now)
      .first('n'),
  ).toBe(100)
})

it.each([false, true])(
  'concurrentStopPreparationReconcilesReceiptWithChangedParameters=%s',
  async (changed) => {
    const s = await setup(),
      shareId = randomId()
    const { executeAdminCommand } = await import('./commands')
    const { AdminCommandSchema } = await import('../../src/account/admin-protocol')
    const { createServiceContext } = await import('../context')
    await s.f.db
      .prepare(
        "INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',0,?,?)",
      )
      .bind(shareId, s.accountId, now, now)
      .run()
    const input = AdminCommandSchema.parse({
      ...s.input,
      target: { kind: 'share', id: shareId },
      command: { type: 'shares.revoke' },
    })
    await confirm(s, input)
    const actor = {
      operatorId: s.operatorId,
      issuer: s.issuer.issuer,
      subject: 'synthetic-owner',
      role: 'owner' as const,
      membershipRevision: 1,
      adminSessionId: s.session.sessionId,
      tokenExpiresAt: now + 3600000,
    }
    const context = createServiceContext(
      new Request('http://127.0.0.1'),
      {
        ...s.f.env,
        ADMIN_ACCESS_CONFIG: JSON.stringify(s.config),
      } as unknown as import('../context').ServiceEnv,
      { now: () => now, emit: () => {} },
    )
    let intercepted = false,
      committed: unknown
    const db = new Proxy(s.f.db, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.startsWith('SELECT actor_id,digest,receipt FROM admin_actions')) return statement
            return {
              bind(...args: Parameters<typeof statement.bind>) {
                const bound = statement.bind(...args)
                return {
                  async first() {
                    const value = await bound.first()
                    if (!intercepted) {
                      intercepted = true
                      expect(value).toBeNull()
                      committed = await executeAdminCommand(actor, input, context)
                    }
                    return value
                  },
                }
              },
            }
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const pending = executeAdminCommand(actor, changed ? { ...input, reason: 'security' } : input, {
      ...context,
      env: { ...context.env, DB: db },
    })
    if (changed) await expect(pending).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    else expect(await pending).toEqual(committed)
    expect(intercepted).toBe(true)
    await expect(executeAdminCommand(actor, { ...input, reason: 'security' }, context)).rejects.toMatchObject(
      {
        code: 'IDEMPOTENCY_MISMATCH',
      },
    )
    expect(
      await s.f.db
        .prepare('SELECT count(*) AS n FROM share_mutations WHERE share_id=?')
        .bind(shareId)
        .first('n'),
    ).toBe(1)
  },
)
