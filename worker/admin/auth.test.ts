import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createServiceContext, type ServiceEnv } from '../context'
import { verifyAccessIdentity } from './auth'
import { actionConfirmationGuard, cleanupAdminSessions, requireActionConfirmation, requireOperator } from './session'
import { afterEach, expect, it, vi } from 'vitest'
import { createAccessIssuer } from '../testing/access-issuer'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'

const fixtures: ServiceFixture[] = []
const now = 1_800_000_000_000
async function fixture() {
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
    accessKeys: async (url) => {
      if (url !== config.jwksUrl) return new Response(null, { status: 503 })
      return Response.json(issuer.jwks)
    },
  })
  fixtures.push(f)
  return { f, issuer, config }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})

it('deniesCustomerHeadersWrongAudienceAndUnknownOperator', async () => {
  const { f, issuer } = await fixture()
  for (const headers of [
    { cookie: '__Host-crykit-session=customer' },
    { 'cf-access-authenticated-user-email': 'owner@example.org' },
  ] as Record<string, string>[]) {
    expect((await f.request('/api/admin/v1/session', { headers })).status).toBe(401)
  }
  const request = (token: string) =>
    f.request('/api/admin/v1/session', { headers: { 'cf-access-jwt-assertion': token } })
  expect((await request(issuer.token(now))).status).toBe(403)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM operators').first('n')).toBe(0)
  for (const claims of [
    { aud: ['customer'] },
    { iss: 'https://foreign.cloudflareaccess.com' },
    { exp: now / 1000 },
    { sub: '' },
  ]) {
    expect((await request(issuer.token(now, claims))).status).toBe(401)
  }
  expect(
    (await f.request('/api/v1/account', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } })).status,
  ).toBe(401)
  expect((await f.request('/api/admin/v1/bootstrap', { method: 'POST' })).status).toBe(404)
})

async function owner(f: ServiceFixture, issuer: ReturnType<typeof createAccessIssuer>) {
  await f.db
    .prepare(
      "INSERT INTO operators (id,issuer,subject,email,role,state,revision,created_at) VALUES ('owner',?,'synthetic-owner','owner@example.org','owner','active',1,?)",
    )
    .bind(issuer.issuer, now)
    .run()
  const token = issuer.token(now)
  const response = await f.request('/api/admin/v1/session', { headers: { 'cf-access-jwt-assertion': token } })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toContain('__Host-crykit-admin-session=')
  expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax; Path=/')
  expect(response.headers.get('set-cookie')).not.toContain('Domain')
  const session = (await response.json()) as { csrf: string; expiresAt: number; sessionId: string; role: string }
  expect(session.expiresAt).toBe(now + 3_600_000)
  expect(session.role).toBe('owner')
  return {
    ...session,
    headers: {
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      'cf-access-jwt-assertion': token,
      'x-csrf-token': session.csrf,
      origin: 'http://127.0.0.1',
    },
  }
}
function post(f: ServiceFixture, path: string, body: unknown, headers: Record<string, string>) {
  return f.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
const digest = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
it('membershipRevocationAppliesOnNextRequest', async () => {
  const { f, issuer } = await fixture()
  const signed = await owner(f, issuer)
  expect((await f.request('/api/admin/v1/session', { headers: signed.headers })).status).toBe(200)
  await f.db
    .prepare(
      "INSERT INTO operators (id,issuer,subject,email,role,state,revision,created_at) VALUES ('another',?,'another-subject','another@example.org','administrator','active',1,?)",
    )
    .bind(issuer.issuer, now)
    .run()
  const changedSubject = { ...signed.headers, 'cf-access-jwt-assertion': issuer.token(now, { sub: 'another-subject' }) }
  expect((await f.request('/api/admin/v1/session', { headers: changedSubject })).status).toBe(403)
  await f.db.prepare("UPDATE operators SET state='revoked',revision=2 WHERE id='owner'").run()
  expect((await f.request('/api/admin/v1/session', { headers: signed.headers })).status).toBe(403)
  expect((await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, signed.headers)).status).toBe(403)
})
it('ordinaryJwtCannotConfirmHighImpactAction', async () => {
  const { f, issuer } = await fixture()
  const signed = await owner(f, issuer)
  const challenge = await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, signed.headers)
  expect(challenge.status).toBe(200)
  const { challengeId } = (await challenge.json()) as { challengeId: string }
  const complete = (token: string) =>
    post(f, '/admin/confirm/api/v1/complete', { challengeId }, { ...signed.headers, 'cf-access-jwt-assertion': token })
  f.advance(1000)
  expect((await complete(issuer.token(now + 1000))).status).toBe(403)
  expect((await complete(issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 }))).status).toBe(403)
  expect(
    (await complete(issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 + 900, sub: 'another-subject' })))
      .status,
  ).toBe(403)
  const token = issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 + 900 })
  const completed = await complete(token)
  expect(completed.status).toBe(200)
  expect(await completed.json()).toMatchObject({ confirmedUntil: now + 900_000 })
  expect((await complete(token)).status).toBe(200)
  f.advance(900_000)
  expect((await complete(token)).status).toBe(403)
})
it('preMembershipSessionGrantsNoOperatorAuthorityAndMutationsRequireOriginAndCsrf', async () => {
  const { f, issuer } = await fixture()
  const headers = { 'cf-access-jwt-assertion': issuer.token(now) }
  const response = await f.request('/api/admin/v1/access-session', { headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toContain('__Host-crykit-admin-access=')
  const access = (await response.json()) as { csrf: string }
  const unauthorized = {
    ...headers,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    'x-csrf-token': access.csrf,
    origin: 'http://127.0.0.1',
  }
  expect((await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, unauthorized)).status).toBe(403)
  const signed = await owner(f, issuer)
  for (const overrides of [
    { origin: 'https://foreign.example.org' },
    { 'x-csrf-token': 'forged' },
    { cookie: unauthorized.cookie },
  ]) {
    expect(
      (await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, { ...signed.headers, ...overrides }))
        .status,
    ).toBe(403)
  }
})

function nodeContext(f: ServiceFixture, config: unknown, clock = now) {
  return createServiceContext(
    new Request('http://127.0.0.1'),
    { ...f.env, ADMIN_ACCESS_CONFIG: JSON.stringify(config) } as unknown as ServiceEnv,
    { now: () => clock, emit: () => {} },
  )
}
function keysInNode(issuer: ReturnType<typeof createAccessIssuer>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== `${issuer.issuer}/cdn-cgi/access/certs`) throw new Error('Unexpected issuer endpoint')
    return Response.json(issuer.jwks)
  })
}
it('bootstrapsOnlyVerifiedIdentityPrivatelyAndRollsBackAuditFailure', async () => {
  const { bootstrapOwner } = await import('./bootstrap')
  const { f, issuer, config } = await fixture()
  const context = nodeContext(f, config)
  keysInNode(issuer)
  const identity = await verifyAccessIdentity(
    new Request('http://127.0.0.1', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } }),
    context,
    'admin',
  )
  await expect(bootstrapOwner({ ...identity }, 'AAAAAAAAAAAAAAAAAAAAAA', context)).rejects.toThrow('FORBIDDEN')
  await f.db.exec(
    "CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_security_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  )
  await expect(bootstrapOwner(identity, 'AAAAAAAAAAAAAAAAAAAAAA', context)).rejects.toThrow()
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM operators').first('n')).toBe(0)
  await f.db.exec('DROP TRIGGER fail_admin_audit')
  await bootstrapOwner(identity, 'AAAAAAAAAAAAAAAAAAAAAA', context)
  await bootstrapOwner(identity, 'AAAAAAAAAAAAAAAAAAAAAA', context)
  expect(await f.db.prepare("SELECT COUNT(*) AS n FROM operators WHERE role='owner'").first('n')).toBe(1)
  expect(
    await f.db.prepare("SELECT COUNT(*) AS n FROM admin_security_audit WHERE action='owner-bootstrap'").first('n'),
  ).toBe(1)
  await expect(bootstrapOwner(identity, 'BBBBBBBBBBBBBBBBBBBBBA', context)).rejects.toThrow('FORBIDDEN')
})
it('confirmationIsBoundToExactCommandAndSessionAndAuditIsAtomic', async () => {
  const { f, issuer, config } = await fixture()
  const signed = await owner(f, issuer)
  const response = await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, signed.headers)
  const { challengeId } = (await response.json()) as { challengeId: string }
  const second = await f.request('/api/admin/v1/session', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } })
  const otherSession = (await second.json()) as { csrf: string }
  const token = issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 + 900 })
  expect(
    (
      await post(
        f,
        '/admin/confirm/api/v1/complete',
        { challengeId },
        {
          ...signed.headers,
          cookie: second.headers.get('set-cookie')!.split(';')[0],
          'x-csrf-token': otherSession.csrf,
          'cf-access-jwt-assertion': token,
        },
      )
    ).status,
  ).toBe(403)
  const complete = () =>
    post(f, '/admin/confirm/api/v1/complete', { challengeId }, { ...signed.headers, 'cf-access-jwt-assertion': token })
  await f.db.exec(
    "CREATE TRIGGER fail_confirmation_audit BEFORE INSERT ON admin_security_audit BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  )
  expect((await complete()).status).toBe(503)
  expect(
    await f.db
      .prepare('SELECT confirmed_until FROM admin_confirmations WHERE id=?')
      .bind(challengeId)
      .first('confirmed_until'),
  ).toBeNull()
  await f.db.exec('DROP TRIGGER fail_confirmation_audit')
  expect((await complete()).status).toBe(200)
  keysInNode(issuer)
  const context = nodeContext(f, config)
  const actor = await requireOperator(
    new Request('http://127.0.0.1/api/admin/v1/session', { headers: signed.headers }),
    context,
  )
  expect(() =>
    actionConfirmationGuard(actor, digest, nodeContext(f, { ...config, confirmationEnabled: false })),
  ).toThrow('FORBIDDEN')
  await requireActionConfirmation(actor, digest, context)
  await requireActionConfirmation(actor, digest, context)
  await expect(
    requireActionConfirmation(actor, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA', context),
  ).rejects.toThrow('FORBIDDEN')
  await f.db.prepare("UPDATE operators SET revision=revision+1 WHERE id='owner'").run()
  await expect(requireActionConfirmation(actor, digest, context)).rejects.toThrow('FORBIDDEN')
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM admin_confirmations').first('n')).toBe(0)
})
it('rejectsUnsupportedAlgorithmsTamperingAndOverlongTokenLifetimes', async () => {
  const { f, issuer } = await fixture()
  const tokens = [
    issuer.token(now, {}, { alg: 'HS256' }),
    issuer.token(now, {}, { alg: 'none' }),
    issuer.token(now, {}, { jku: 'https://attacker.example.org/jwks' }),
    issuer.token(now, { exp: now / 1000 + 3601 }),
    issuer.token(now, { aud: ['ordinary-admin', 'action-confirmation'] }),
    issuer.token(now, { email: 'invalid' }),
    `${issuer.token(now).slice(0, -8)}AAAAAAAA`,
  ]
  for (const token of tokens)
    expect(
      (await f.request('/api/admin/v1/access-session', { headers: { 'cf-access-jwt-assertion': token } })).status,
    ).toBe(401)
})
it('failsClosedForMissingConfigAndIgnoresFixtureHeaders', async () => {
  const f = await createServiceFixture({ now })
  fixtures.push(f)
  expect(
    (
      await f.request('/api/admin/v1/session', {
        headers: { 'x-local-identity': 'owner', 'cf-access-authenticated-user-email': 'owner@example.org' },
      })
    ).status,
  ).toBe(503)
  const signed = await fixture()
  expect(
    (
      await signed.f.request('/api/admin/v1/access-session', {
        headers: { 'x-local-identity': 'owner', 'cf-access-authenticated-user-email': 'owner@example.org' },
      })
    ).status,
  ).toBe(401)
})
it('refreshesRotatedKeysAndFailsClosedDuringOutageWithoutTrustingTokenUrls', async () => {
  const { f, issuer, config } = await fixture()
  let clock = now
  const context = { ...nodeContext(f, config), now: () => clock }
  let keys = issuer.jwks
  let unavailable = false
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    expect(String(url)).toBe(config.jwksUrl)
    return unavailable ? new Response(null, { status: 503 }) : Response.json(keys)
  })
  const verify = (token: string) =>
    verifyAccessIdentity(
      new Request('http://127.0.0.1', { headers: { 'cf-access-jwt-assertion': token } }),
      context,
      'admin',
    )
  await verify(issuer.token(now))
  const rotated = createAccessIssuer()
  keys = rotated.jwks
  await expect(verify(rotated.token(clock, { iss: issuer.issuer }))).rejects.toThrow('AUTH_FAILED')
  clock += 30_000
  await verify(rotated.token(clock, { iss: issuer.issuer }))
  unavailable = true
  clock += 300_000
  await expect(verify(rotated.token(clock, { iss: issuer.issuer }))).rejects.toThrow('AUTH_FAILED')
  unavailable = false
  await expect(verify(rotated.token(clock, { iss: issuer.issuer }))).rejects.toThrow('AUTH_FAILED')
  clock += 30_000
  await verify(rotated.token(clock, { iss: issuer.issuer }))
  expect(fetcher.mock.calls.length).toBe(4)
})

it('guardsAdminAssetsAndKeepsCustomerAndGuestPathsIndependent', async () => {
  const { f, issuer } = await fixture()
  const signed = await owner(f, issuer)
  for (const path of ['/admin', '/admin/', '/admin/assets/panel.js']) {
    expect((await f.request(path)).status).toBe(401)
    const allowed = await f.request(path, { headers: signed.headers })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(await allowed.text()).toContain('Synthetic admin asset')
  }
  expect((await f.request('/admin', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } })).status).toBe(200)
  expect((await f.request('/')).status).toBe(200)
  expect((await f.request('/api/v1/account', { headers: signed.headers })).status).toBe(401)
  expect((await f.request('/admin/confirm/', { headers: signed.headers })).status).toBe(401)
})
it('chargesAdminMetadataAndRejectsWritesAfterRecoveryClosure', async () => {
  const { f, issuer } = await fixture()
  const before = await f.db
    .prepare("SELECT metadata_bytes AS bytes,metadata_rows AS rows FROM quota_counters WHERE scope='global'")
    .first<{ bytes: number; rows: number }>()
  await owner(f, issuer)
  const after = await f.db
    .prepare("SELECT metadata_bytes AS bytes,metadata_rows AS rows FROM quota_counters WHERE scope='global'")
    .first<{ bytes: number; rows: number }>()
  expect(after!.bytes).toBeGreaterThan(before!.bytes)
  expect(after!.rows).toBeGreaterThan(before!.rows)
  await f.db.prepare("UPDATE recovery_control SET state='closed' WHERE id=1").run()
  await expect(f.db.prepare("UPDATE operators SET revision=2 WHERE id='owner'").run()).rejects.toThrow()
  expect(
    (await f.request('/api/admin/v1/session', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } })).status,
  ).toBe(503)
})

it('productionEntryAcceptsOnlySignedAssertionsAndHasNoFixtureBootstrap', async () => {
  const issuer = createAccessIssuer(),
    clock = Date.now()
  const config = {
    version: 1,
    issuer: issuer.issuer,
    jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
    adminAudience: 'ordinary-admin',
    confirmationAudience: 'action-confirmation',
    confirmationEnabled: false,
  }
  const f = await createServiceFixture({
    production: true,
    adminConfig: JSON.stringify(config),
    accessKeys: async () => Response.json(issuer.jwks),
  })
  fixtures.push(f)
  expect((await f.request('/api/admin/v1/access-session', { headers: { 'x-local-identity': 'owner' } })).status).toBe(
    401,
  )
  expect(
    (await f.request('/api/admin/v1/access-session', { headers: { 'cf-access-jwt-assertion': issuer.token(clock) } }))
      .status,
  ).toBe(200)
  expect((await f.request('/api/admin/v1/bootstrap', { method: 'POST' })).status).toBe(404)
  expect((await f.request('/__accounts/identity', { method: 'POST' })).status).toBe(404)
  expect((await f.request('/admin/assets/panel.js')).status).toBe(401)
})
it('sessionNeverOutlivesItsOriginalTokenAndConfirmationCanStayDisabled', async () => {
  const { f, issuer, config } = await fixture()
  await owner(f, issuer)
  const response = await f.request('/api/admin/v1/session', {
    headers: { 'cf-access-jwt-assertion': issuer.token(now, { exp: now / 1000 + 60 }) },
  })
  const session = (await response.json()) as { expiresAt: number }
  expect(session.expiresAt).toBe(now + 60_000)
  const headers = {
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    'cf-access-jwt-assertion': issuer.token(now),
  }
  expect(await (await f.request('/api/admin/v1/session', { headers })).json()).toMatchObject({
    expiresAt: now + 60_000,
  })
  f.advance(60_000)
  expect((await f.request('/api/admin/v1/session', { headers })).status).toBe(403)
  keysInNode(issuer)
  await expect(
    verifyAccessIdentity(
      new Request('http://127.0.0.1', {
        headers: {
          'cf-access-jwt-assertion': issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 + 900 }),
        },
      }),
      nodeContext(f, { ...config, confirmationEnabled: false }),
      'confirmation',
    ),
  ).rejects.toThrow('FORBIDDEN')
})
it('rejectsMissingAmbiguousAndUntrustedConfigurationBeforeFetching', async () => {
  const { f, config, issuer } = await fixture()
  const fetcher = keysInNode(issuer)
  for (const invalid of [
    null,
    { ...config, extra: true },
    { ...config, issuer: 'http://issuer.example.org' },
    { ...config, jwksUrl: 'https://attacker.example.org/keys' },
    { ...config, confirmationAudience: config.adminAudience },
  ]) {
    await expect(
      verifyAccessIdentity(
        new Request('http://127.0.0.1', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } }),
        nodeContext(f, invalid),
        'admin',
      ),
    ).rejects.toThrow('SERVICE_UNAVAILABLE')
  }
  expect(fetcher).not.toHaveBeenCalled()
})
it.each(['redirect', 'oversize', 'malformed', 'timeout'])('rejectsUnusableJwksWithoutFallback: %s', async (kind) => {
  const { f, issuer, config } = await fixture()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (kind === 'redirect')
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example.org/keys' } })
    if (kind === 'oversize') return new Response('x'.repeat(65_537))
    if (kind === 'malformed') return Response.json({ keys: [{}] })
    return new Promise((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }),
    )
  })
  await expect(
    verifyAccessIdentity(
      new Request('http://127.0.0.1', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } }),
      nodeContext(f, config),
      'admin',
    ),
  ).rejects.toThrow('AUTH_FAILED')
})

it('actualProductionAssetsRoutingGuardsEncodedPathsBeforeServingFiles', async () => {
  const directory = await mkdtemp('/tmp/crykit-admin-assets-')
  let f: ServiceFixture | undefined
  try {
    await mkdir(`${directory}/admin/assets`, { recursive: true })
    await writeFile(`${directory}/admin/assets/panel.js`, 'Synthetic protected application asset')
    await writeFile(`${directory}/index.html`, 'Synthetic public guest asset')
    const deployment = JSON.parse(await readFile('wrangler.admin.example.jsonc', 'utf8')) as {
      assets: { run_worker_first: string[] }
    }
    const issuer = createAccessIssuer(),
      clock = Date.now()
    const config = {
      version: 1,
      issuer: issuer.issuer,
      jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
      adminAudience: 'ordinary-admin',
      confirmationAudience: 'action-confirmation',
      confirmationEnabled: false,
    }
    f = await createServiceFixture({
      production: true,
      assets: { directory, run_worker_first: deployment.assets.run_worker_first },
      adminConfig: JSON.stringify(config),
      accessKeys: async () => Response.json(issuer.jwks),
    })
    await f.db
      .prepare(
        "INSERT INTO operators (id,issuer,subject,email,role,state,revision,created_at) VALUES ('owner',?,'synthetic-owner','owner@example.org','owner','active',1,?)",
      )
      .bind(issuer.issuer, clock)
      .run()
    for (const path of [
      '/admin/assets/panel.js',
      '/adm%69n/assets/panel.js',
      '/admin%2fassets/panel.js',
      '/admin/assets/%70anel.js',
    ]) {
      expect((await f.request(path)).status).toBe(401)
      const allowed = await f.request(path, { headers: { 'cf-access-jwt-assertion': issuer.token(clock) } })
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toBe('Synthetic protected application asset')
      expect(allowed.headers.get('cache-control')).toBe('no-store')
    }
    const publicAsset = await f.request('/')
    expect(publicAsset.status).toBe(200)
    expect(await publicAsset.text()).toBe('Synthetic public guest asset')
  } finally {
    await f?.dispose()
    await rm(directory, { recursive: true })
  }
})
it('retainsAuditForNinetyDaysAndCleansExpiredSessionsWithoutSecrets', async () => {
  const { f, issuer, config } = await fixture()
  const signed = await owner(f, issuer)
  const response = await post(f, '/api/admin/v1/confirmations', { commandDigest: digest }, signed.headers)
  const { challengeId } = (await response.json()) as { challengeId: string }
  const token = issuer.token(now, { aud: ['action-confirmation'], exp: now / 1000 + 900 })
  expect(
    (
      await post(
        f,
        '/admin/confirm/api/v1/complete',
        { challengeId },
        { ...signed.headers, 'cf-access-jwt-assertion': token },
      )
    ).status,
  ).toBe(200)
  const serialized =
    JSON.stringify(await f.db.prepare('SELECT * FROM admin_sessions').all()) +
    JSON.stringify(await f.db.prepare('SELECT * FROM admin_security_audit').all()) +
    JSON.stringify(await f.events())
  for (const secret of [token, signed.headers.cookie.split('=')[1], signed.csrf])
    expect(serialized).not.toContain(secret)
  await cleanupAdminSessions(nodeContext(f, config, now + 90 * 24 * 60 * 60 * 1000))
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM admin_confirmations').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM admin_security_audit').first('n')).toBe(1)
  await cleanupAdminSessions(nodeContext(f, config, now + 90 * 24 * 60 * 60 * 1000 + 1))
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM admin_security_audit').first('n')).toBe(0)
})

it('allHostnamesRequireVerifiedMembership', async () => {
  const issuer = createAccessIssuer(),
    clock = Date.now()
  const config = {
    version: 1,
    issuer: issuer.issuer,
    jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
    adminAudience: 'ordinary-admin',
    confirmationAudience: 'action-confirmation',
    confirmationEnabled: true,
  }
  const f = await createServiceFixture({
    production: true,
    adminConfig: JSON.stringify(config),
    accessKeys: async () => Response.json(issuer.jwks),
  })
  fixtures.push(f)
  for (const path of [
    '/admin/',
    '/admin/accept-invitation/',
    '/admin/confirm/',
    '/api/admin/v1/session',
    '/api/admin/v1/overview',
  ]) {
    expect(
      (
        await f.request(path, {
          headers: { 'cf-access-authenticated-user-email': 'owner@example.org', 'x-local-identity': 'owner' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await f.request(`https://unconfigured.example.org${path}`, {
          headers: { 'cf-access-jwt-assertion': issuer.token(clock) },
        })
      ).status,
    ).toBe(403)
  }
  expect(
    (
      await f.request('/api/admin/v1/session', {
        headers: { 'cf-access-jwt-assertion': issuer.token(clock) },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await f.request('/api/admin/v1/session', {
        headers: { 'cf-access-jwt-assertion': issuer.token(clock, { exp: Math.floor(clock / 1000) - 1 }) },
      })
    ).status,
  ).toBe(401)
  for (const path of [
    '/__accounts/identity',
    '/__accounts/fault',
    '/__accounts/jobs',
    '/__accounts/opaque',
    '/api/admin/v1/bootstrap',
  ])
    expect((await f.request(path, { method: 'POST' })).status).toBe(404)
  expect((await f.request('/')).status).toBe(200)
  const unavailable = await createServiceFixture({
    production: true,
    adminConfig: JSON.stringify(config),
    accessKeys: async () => new Response(null, { status: 503 }),
  })
  fixtures.push(unavailable)
  expect(
    (
      await unavailable.request('/api/admin/v1/session', {
        headers: { 'cf-access-jwt-assertion': issuer.token(clock) },
      })
    ).status,
  ).toBe(401)
  expect(await (await unavailable.request('/api/v1/service')).json()).toMatchObject({
    accountsAvailable: true,
  })
})

it('newMemberLoginCommitsAuditAtomicallyWithoutAuditingRefreshes', async () => {
  const { f, issuer } = await fixture()
  const session = await owner(f, issuer)
  expect(
    await f.db
      .prepare("SELECT actor_id,target_id,outcome FROM admin_audit WHERE action='session.login'")
      .all(),
  ).toMatchObject({ results: [{ actor_id: 'owner', target_id: 'owner', outcome: 'complete' }] })
  expect((await f.request('/api/admin/v1/session', { headers: session.headers })).status).toBe(200)
  expect(
    await f.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='session.login'").first('n'),
  ).toBe(1)
  await f.db
    .prepare(
      "CREATE TRIGGER reject_login_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;",
    )
    .run()
  expect(
    (await f.request('/api/admin/v1/session', { headers: { 'cf-access-jwt-assertion': issuer.token(now) } }))
      .status,
  ).toBe(503)
  expect(await f.db.prepare('SELECT count(*) n FROM admin_sessions').first('n')).toBe(1)
  expect(await f.events()).toContainEqual(
    expect.objectContaining({ operation: 'admin', code: 'AUDIT_TRANSACTION_UNAVAILABLE' }),
  )
})
