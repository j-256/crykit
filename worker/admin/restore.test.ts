import { customer, prepared, post, command } from '../sync/testing'
import { captureServiceSnapshot } from '../jobs/service-backup'
import {
  restoreServiceSnapshot,
  closeServiceForRecovery,
  promoteServiceRestore,
} from '../jobs/service-restore'
import { recoverySecretNames } from '../jobs/recovery-codec'
import { afterEach, expect, it, vi } from 'vitest'
import { adminFixture, adminCommand, adminTestNow } from '../testing/admin-fixture'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { randomId } from '../auth/identity'
import { createServiceContext, type ServiceContext } from '../context'
import {
  initializeRevocationLedger,
  readRevocationHead,
  RevocationEventSchema,
  appendRevocation,
} from '../jobs/ledger'
import { recoveryProjection } from '../jobs/recovery-projection'

const fixtures: ServiceFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})

it('capturesExactAdminTuplesAndSeparateJobRevisionCharges', async () => {
  const admin = await adminFixture()
  fixtures.push(admin.f)
  const command = adminCommand(
    { type: 'service.settings', patch: { registrationPaused: true } },
    { kind: 'service', id: 'service' },
  )
  await admin.confirm(command)
  expect((await admin.post('actions', command)).status).toBe(200)
  await admin.f.runJobs()
  const job = randomId()
  await admin.f.db
    .prepare(
      "INSERT INTO email_jobs(id,request_digest,request_id,state,delivery,next_attempt_at,expires_at,created_at,updated_at) VALUES (?,'digest','request','queued','pending',1,2,1,1)",
    )
    .bind(job)
    .run()
  for (const table of ['email_jobs', 'service_jobs']) {
    const before = await admin.f.db
      .prepare("SELECT metadata_bytes FROM quota_counters WHERE scope='global'")
      .first<number>('metadata_bytes')
    const rows = await admin.f.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n')
    await admin.f.db.prepare(`UPDATE ${table} SET admin_revision=100`).run()
    const after = await admin.f.db
      .prepare("SELECT metadata_bytes FROM quota_counters WHERE scope='global'")
      .first<number>('metadata_bytes')
    expect(after! - before!).toBe(rows! * 2)
  }
  const tables = [
    'operators',
    'admin_access_sessions',
    'admin_sessions',
    'admin_confirmations',
    'admin_bootstrap_intents',
    'admin_security_audit',
    'admin_actions',
    'admin_previews',
    'admin_audit',
    'admin_invitations',
    'service_settings',
    'admin_revocations',
    'email_jobs',
    'service_jobs',
  ]
  for (const table of tables) {
    const columns = recoveryProjection[table as keyof typeof recoveryProjection]
    expect(columns, table).toBeDefined()
    const actual = await admin.f.db
      .prepare(
        `SELECT count(*) AS rows,coalesce(sum(length(CAST(json_array(${columns.join(',')}) AS BLOB))),0) AS bytes FROM ${table}`,
      )
      .first()
    expect(
      await admin.f.db
        .prepare('SELECT rows,bytes FROM recovery_source_stats WHERE name=?')
        .bind(table)
        .first(),
      table,
    ).toEqual(actual)
  }
  expect(recoveryProjection.email_jobs).toContain('admin_revision')
  expect(recoveryProjection.service_jobs).toContain('admin_revision')
})

it('revocationsCommitBeforeIndependentAcknowledgmentAndRetryExactIntent', async () => {
  const admin = await adminFixture()
  fixtures.push(admin.f)
  const removed = randomId()
  await admin.f.db
    .prepare(
      "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'removed','removed@example.org','administrator','active',1,?)",
    )
    .bind(removed, admin.issuer.issuer, adminTestNow)
    .run()
  const input = adminCommand({ type: 'operators.remove' }, { kind: 'operator', id: removed })
  await admin.confirm(input)
  await admin.f.db
    .prepare(
      "CREATE TRIGGER reject_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;",
    )
    .run()
  expect((await admin.post('actions', input)).status).toBe(503)
  expect(
    await admin.f.db.prepare('SELECT state FROM operators WHERE id=?').bind(removed).first('state'),
  ).toBe('active')
  await admin.f.db.prepare('DROP TRIGGER reject_admin_audit').run()
  const response = await admin.post('actions', input)
  expect(response.status).toBe(200)
  const receipt = (await response.json()) as { jobId: string; state: string }
  expect(receipt.state).toBe('queued')
  expect(
    (
      await admin.f.request('/api/admin/v1/session', {
        headers: {
          'cf-access-jwt-assertion': admin.issuer.token(adminTestNow, {
            sub: 'removed',
            email: 'removed@example.org',
          }),
        },
      })
    ).status,
  ).toBe(403)
  await admin.f.runJobs()
  expect(
    await (await admin.f.request(`/api/admin/v1/jobs/${receipt.jobId}`, { headers: admin.headers })).json(),
  ).toMatchObject({ outcome: 'pending', code: 'LEDGER_NOT_READY' })
  const c = context(admin.f)
  await initializeRevocationLedger(c)
  const frozen = await admin.f.db
    .prepare('SELECT event FROM admin_revocations WHERE id=?')
    .bind(receipt.jobId)
    .first('event')
  admin.f.failNext('admin.revocation.acknowledged')
  await admin.f.runJobs()
  expect(await readRevocationHead(c)).toMatchObject({ sequence: 1 })
  expect(
    await (await admin.f.request(`/api/admin/v1/jobs/${receipt.jobId}`, { headers: admin.headers })).json(),
  ).toMatchObject({ outcome: 'pending', code: 'RETRY_PENDING' })
  await admin.f.runJobs()
  expect(
    await admin.f.db
      .prepare('SELECT event FROM admin_revocations WHERE id=?')
      .bind(receipt.jobId)
      .first('event'),
  ).toBe(frozen)
  expect(
    await (await admin.f.request(`/api/admin/v1/jobs/${receipt.jobId}`, { headers: admin.headers })).json(),
  ).toMatchObject({ outcome: 'complete' })
  expect(await readRevocationHead(c)).toMatchObject({ sequence: 1 })
  expect(await (await admin.post('actions', input)).json()).toEqual(receipt)
  await admin.f.runJobs()
  expect(await readRevocationHead(c)).toMatchObject({ sequence: 1 })
})

const context = (f: ServiceFixture): ServiceContext =>
  createServiceContext(new Request('http://127.0.0.1'), f.env as unknown as ServiceContext['env'], {
    now: () => adminTestNow,
    emit() {},
  })

const policy = JSON.stringify({
  version: 1,
  maxRows: 10000,
  maxBytes: 8 * 1024 * 1024,
  maxEdges: 10000,
  maxWork: 20000,
  maxTemporaryBytes: 64 * 1024 * 1024,
  maxStatements: 100,
  maxRowBytes: 1900000,
})
async function capture(c: ServiceContext) {
  const snapshot = randomId()
  for (let step = 0; step < 1500; step++) {
    const receipt = await captureServiceSnapshot(c, snapshot)
    if (receipt.state === 'complete') return snapshot
    if (receipt.state === 'waiting') throw new Error('Capture paused')
  }
  throw new Error('Capture incomplete')
}
async function restore(c: ServiceContext, snapshot: string) {
  for (let step = 0; step < 2000; step++) {
    await restoreServiceSnapshot(c, snapshot)
    if ((await c.env.DB!.prepare('SELECT state FROM recovery_control').first('state')) === 'verified') return
  }
  throw new Error('Restore incomplete')
}
it('restoreCannotResurrectRevokedAccess', async () => {
  const admin = await adminFixture({ recoveryPolicy: policy })
  fixtures.push(admin.f)
  const c = context(admin.f),
    removed = randomId()
  await initializeRevocationLedger(c)
  const customerOwner = await customer(admin.f, 'restore')
  const publicSnapshot = {
    version: 5,
    kind: 'build',
    title: 'Public recovery snapshot',
    setup: {
      catalogLock: {},
      baseline: null,
      layers: [],
      mode: { state: 'unknown' },
      ppCostsNonNegative: { state: 'unknown' },
      slots: [],
    },
    slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }],
    receipts: [],
  }
  const published = await post(
    admin.f,
    'shares',
    { mutationId: randomId(), snapshot: publicSnapshot, includeAttribution: false },
    customerOwner.headers,
  )
  expect(published.status).toBe(200)
  const { shareId } = (await published.json()) as { shareId: string }
  await admin.f.db
    .prepare('INSERT INTO admin_bootstrap_intents(id,operator_id,issuer,subject) VALUES (?,?,?,?)')
    .bind(randomId(), admin.operatorId, admin.issuer.issuer, 'synthetic-owner')
    .run()
  await admin.f.db
    .prepare(
      "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'removed','removed@example.org','administrator','active',1,?)",
    )
    .bind(removed, admin.issuer.issuer, adminTestNow)
    .run()
  const invite = adminCommand(
    { type: 'operators.invite', email: 'invitee@example.org', role: 'administrator' },
    { kind: 'invitation', id: randomId() },
    0,
  )
  await admin.confirm(invite)
  expect((await admin.post('actions', invite)).status).toBe(200)
  await admin.f.runJobs()
  const mail = (await admin.f.emails()).find((mail) => mail.kind === 'admin-invite')!
  const remove = adminCommand({ type: 'operators.remove' }, { kind: 'operator', id: removed })
  await admin.confirm(remove)
  expect((await admin.f.request('/api/admin/v1/access-session', { headers: admin.headers })).status).toBe(200)
  const snapshot = await capture(c)
  const stop = adminCommand({ type: 'shares.revoke' }, { kind: 'share', id: shareId })
  await admin.confirm(stop)
  expect((await admin.post('actions', stop)).status).toBe(200)
  expect((await admin.post('actions', remove)).status).toBe(200)
  const cancel = adminCommand(
    { type: 'operators.invitation.cancel' },
    { kind: 'invitation', id: invite.target.id },
  )
  await admin.confirm(cancel)
  expect((await admin.post('actions', cancel)).status).toBe(200)
  expect((await captureServiceSnapshot(c, randomId())).state).toBe('waiting')
  await admin.f.runJobs()
  await admin.f.runJobs()
  const target = await createServiceFixture({
    now: adminTestNow,
    recoveryPolicy: policy,
    recoverySecrets: Object.fromEntries(recoverySecretNames.map((key) => [key, admin.f.env[key]])),
    adminConfig: JSON.stringify(admin.config),
    accessKeys: async () => Response.json(admin.issuer.jwks),
  })
  fixtures.push(target)
  const staged = {
    ...context(target),
    env: {
      ...context(target).env,
      LEDGER_BACKUPS: context(admin.f).env.LEDGER_BACKUPS,
      REVOCATION_LEDGER: context(admin.f).env.REVOCATION_LEDGER,
    },
  }
  await closeServiceForRecovery(staged)
  await restore(staged, snapshot)
  expect(await target.db.prepare('SELECT state FROM operators WHERE id=?').bind(removed).first('state')).toBe(
    'revoked',
  )
  expect(
    await target.db
      .prepare('SELECT state FROM admin_invitations WHERE id=?')
      .bind(invite.target.id)
      .first('state'),
  ).toBe('cancelled')
  for (const table of ['admin_sessions', 'admin_access_sessions', 'admin_confirmations', 'admin_previews'])
    expect(await target.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0)
  await closeServiceForRecovery(c)
  await expect(
    promoteServiceRestore({ ...staged, env: { ...staged.env, REVOCATION_LEDGER: undefined } }, c),
  ).rejects.toThrow()
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
  await promoteServiceRestore(staged, c)
  expect((await target.request(`/api/public/v1/shares/${shareId}`)).status).toBe(404)
  expect((await target.request('/api/v1/auth/session', { headers: customerOwner.headers })).status).toBe(401)
  expect(
    await target.db.prepare('SELECT operator_id FROM admin_bootstrap_intents').first('operator_id'),
  ).toBe(admin.operatorId)
  expect((await target.request('/api/admin/v1/overview', { headers: admin.headers })).status).toBe(403)
  expect(
    (
      await target.request('/api/admin/v1/session', {
        headers: {
          'cf-access-jwt-assertion': admin.issuer.token(adminTestNow, {
            sub: 'removed',
            email: 'removed@example.org',
          }),
        },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await target.request('/api/admin/v1/session', {
        headers: { 'cf-access-jwt-assertion': admin.issuer.token(adminTestNow) },
      })
    ).status,
  ).toBe(200)
  const access = await target.request('/api/admin/v1/access-session', {
    headers: {
      'cf-access-jwt-assertion': admin.issuer.token(adminTestNow, {
        sub: 'invitee',
        email: 'invitee@example.org',
      }),
    },
  })
  const body = (await access.json()) as { csrf: string }
  expect(
    (
      await target.request('/api/admin/v1/invitations/accept', {
        method: 'POST',
        headers: {
          'cf-access-jwt-assertion': admin.issuer.token(adminTestNow, {
            sub: 'invitee',
            email: 'invitee@example.org',
          }),
          cookie: access.headers.get('set-cookie')!.split(';')[0],
          origin: 'http://127.0.0.1',
          'x-csrf-token': body.csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ capability: mail.capability }),
      })
    ).status,
  ).toBe(400)
}, 90000)

it('migrationQueuesExistingRevocationsWithoutInventingAcknowledgment', async () => {
  const f = await createServiceFixture({ migrationThrough: '0013-admin-commands.sql' })
  fixtures.push(f)
  for (let i = 0; i < 2; i++)
    await f.db
      .prepare(
        "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,'https://synthetic.cloudflareaccess.com',?,'removed@example.org','administrator','revoked',2,1)",
      )
      .bind(randomId(), String(i))
      .run()
  const cancelled = randomId(),
    creator = randomId()
  await f.db
    .prepare(
      "INSERT INTO admin_invitations(id,normalized_email,delivery_email,role,state,revision,token_hash,root_job_id,created_by,created_at,expires_at) VALUES (?,'cancelled@example.org','cancelled@example.org','administrator','cancelled',2,'cancelled-token',?,?,1,2)",
    )
    .bind(cancelled, randomId(), creator)
    .run()
  const { readFile } = await import('node:fs/promises'),
    { unstable_splitSqlQuery: split } = await import('wrangler')
  await f.db.batch(
    split(await readFile('worker/migrations/0014-admin-recovery.sql', 'utf8')).map((sql) =>
      f.db.prepare(sql),
    ),
  )
  const rows = await f.db
    .prepare('SELECT id,event,acknowledged FROM admin_revocations')
    .all<{ id: string; event: string; acknowledged: number }>()
  expect(rows.results).toHaveLength(3)
  for (const row of rows.results)
    expect(RevocationEventSchema.parse(JSON.parse(row.event))).toMatchObject({
      intentId: row.id,
      kind: JSON.parse(row.event).invitationId ? 'invitation-revoked' : 'operator-revoked',
    })
  expect(rows.results.map((row) => JSON.parse(row.event))).toContainEqual(
    expect.objectContaining({ kind: 'invitation-revoked', invitationId: cancelled, operatorId: creator }),
  )
  expect(new Set(rows.results.map((row) => row.id)).size).toBe(3)
  expect(rows.results.every((row) => row.acknowledged === 0)).toBe(true)
})

it('rejectsUnsupportedRecoveryTupleWidthsAndTypes', async () => {
  const { normalizeRecoveryTuple } = await import('../jobs/recovery-projection')
  const legacy = [
    'job',
    'digest',
    'request',
    null,
    'queued',
    'pending',
    0,
    1,
    1,
    2,
    1,
    1,
    null,
    null,
    null,
    null,
    null,
  ]
  expect(normalizeRecoveryTuple('email_jobs', legacy)).toEqual([...legacy, 1])
  expect(normalizeRecoveryTuple('email_jobs', [...legacy, 9])).toEqual([...legacy, 9])
  for (const tuple of [
    legacy.slice(1),
    [...legacy, 1, 2],
    [...legacy, '1'],
    legacy.map((value, index) => (index === 6 ? '0' : value)),
  ])
    expect(() => normalizeRecoveryTuple('email_jobs', tuple)).toThrow()
})

it('restoresExactLegacyJobTuplesAndOriginalCiphertextWithoutRewritingTheSnapshot', async () => {
  const f = await createServiceFixture({ now: adminTestNow, recoveryPolicy: policy })
  fixtures.push(f)
  await f.runJobs()
  const owner = await customer(f),
    upload = await prepared(f, owner),
    c = context(f)
  expect((await post(f, 'sync/commits', command([upload.descriptor]), owner.headers)).status).toBe(200)
  await initializeRevocationLedger(c)
  // Supply the frozen pre-admin table/column projection to the unchanged snapshot codec
  // This fixture emits genuine version 1 encrypted pages, not rewritten modern backup bodies
  const legacy = { ...recoveryProjection } as Record<string, readonly string[]>
  for (const table of Object.keys(legacy))
    if (table.startsWith('admin_') || table === 'operators' || table === 'service_settings')
      delete legacy[table]
  legacy.email_jobs = legacy.email_jobs.slice(0, 17)
  legacy.service_jobs = legacy.service_jobs.slice(0, 15)
  for (const table of Object.keys(recoveryProjection)) {
    if (!legacy[table]) await f.db.prepare('DELETE FROM recovery_source_stats WHERE name=?').bind(table).run()
    else
      await f.db
        .prepare(
          `UPDATE recovery_source_stats SET bytes=(SELECT coalesce(sum(length(CAST(json_array(${legacy[table].join(',')}) AS BLOB))),0) FROM ${table}) WHERE name=?`,
        )
        .bind(table)
        .run()
  }
  vi.resetModules()
  vi.doMock('../jobs/recovery-projection', () => ({
    recoveryProjection: legacy,
    recoveryTables: Object.keys(legacy),
  }))
  let snapshot: string
  try {
    const { captureServiceSnapshot: legacyCapture } = await import('../jobs/service-backup')
    snapshot = randomId()
    let completed = false
    for (let step = 0; step < 1500; step++)
      if ((await legacyCapture(c, snapshot)).state === 'complete') {
        completed = true
        break
      }
    expect(completed).toBe(true)
  } finally {
    vi.doUnmock('../jobs/recovery-projection')
    vi.resetModules()
  }
  const locator = `service-snapshots/v1/${snapshot!}`,
    before = await (await f.backups.get(locator))!.text()
  const target = await createServiceFixture({
    now: adminTestNow,
    recoveryPolicy: policy,
    recoverySecrets: Object.fromEntries(recoverySecretNames.map((key) => [key, f.env[key]])),
  })
  fixtures.push(target)
  const staged = {
    ...context(target),
    env: {
      ...context(target).env,
      LEDGER_BACKUPS: context(f).env.LEDGER_BACKUPS,
      REVOCATION_LEDGER: context(f).env.REVOCATION_LEDGER,
    },
  }
  await closeServiceForRecovery(staged)
  await restore(staged, snapshot!)
  const key = await target.db
    .prepare("SELECT object_key FROM upload_chunks WHERE state='ready'")
    .first<string>('object_key')
  expect(Buffer.from(await (await target.objects.get(key!))!.arrayBuffer())).toEqual(upload.bytes)
  expect(await target.db.prepare('SELECT revision_id FROM sync_revisions').first('revision_id')).toBe(
    upload.descriptor.revisionId,
  )
  expect(
    await target.db.prepare('SELECT account_envelope FROM credentials ORDER BY role').all(),
  ).toMatchObject(
    await f.db
      .prepare('SELECT account_envelope FROM credentials ORDER BY role')
      .all()
      .then((result) => ({ results: result.results })),
  )
  expect(
    await target.db.prepare('SELECT admin_revision FROM email_jobs LIMIT 1').first('admin_revision'),
  ).toBe(1)
  expect(
    await target.db.prepare('SELECT admin_revision FROM service_jobs LIMIT 1').first('admin_revision'),
  ).toBe(1)
  expect(await (await f.backups.get(locator))!.text()).toBe(before)
}, 90000)

it('qualifiesRestoredOwnerCeilingBeforeReopening', async () => {
  const f = await createServiceFixture({ now: adminTestNow, recoveryPolicy: policy })
  fixtures.push(f)
  const c = context(f)
  await initializeRevocationLedger(c)
  const snapshot = await capture(c),
    target = await createServiceFixture({
      now: adminTestNow,
      recoveryPolicy: policy,
      recoverySecrets: Object.fromEntries(recoverySecretNames.map((key) => [key, f.env[key]])),
    })
  fixtures.push(target)
  const staged = {
    ...context(target),
    env: {
      ...context(target).env,
      LEDGER_BACKUPS: context(f).env.LEDGER_BACKUPS,
      REVOCATION_LEDGER: context(f).env.REVOCATION_LEDGER,
    },
  }
  await closeServiceForRecovery(staged)
  await restore(staged, snapshot)
  await closeServiceForRecovery(c)
  // A restrictive owner ceiling must govern reopening even though staging used deployment capacity
  await target.db.batch([
    target.db.prepare("UPDATE recovery_control SET state='restoring'"),
    target.db.prepare("UPDATE service_settings SET project_capacity_bytes=1 WHERE id='service'"),
    target.db.prepare("UPDATE recovery_control SET state='verified'"),
  ])
  const before = await target.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first()
  await expect(promoteServiceRestore(staged, c)).rejects.toThrow('transaction_guard_passed')
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
  expect(await target.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first()).toEqual(before)
  expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
  await target.db.batch([
    target.db.prepare("UPDATE recovery_control SET state='restoring'"),
    target.db.prepare("UPDATE service_settings SET project_capacity_bytes=NULL WHERE id='service'"),
    target.db.prepare("UPDATE recovery_control SET state='verified'"),
  ])
  await appendRevocation(
    {
      version: 1,
      kind: 'operator-revoked',
      intentId: randomId(),
      operatorId: randomId(),
      sessionEpoch: 2,
      timestamp: adminTestNow,
    },
    c,
  )
  await expect(promoteServiceRestore(staged, c)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
}, 90000)

it('rejectsAStagingTargetWithPreexistingDisposableAdminAuthority', async () => {
  const source = await createServiceFixture({ now: adminTestNow, recoveryPolicy: policy })
  fixtures.push(source)
  const c = context(source)
  await initializeRevocationLedger(c)
  const snapshot = await capture(c)
  const target = await createServiceFixture({
    now: adminTestNow,
    recoveryPolicy: policy,
    recoverySecrets: Object.fromEntries(recoverySecretNames.map((key) => [key, source.env[key]])),
  })
  fixtures.push(target)
  await target.db
    .prepare(
      "INSERT INTO admin_access_sessions(id,token_hash,issuer,subject,created_at,expires_at) VALUES (?,'old-token','https://synthetic.cloudflareaccess.com','old-principal',1,9999999999999)",
    )
    .bind(randomId())
    .run()
  const staged = {
    ...context(target),
    env: {
      ...context(target).env,
      LEDGER_BACKUPS: c.env.LEDGER_BACKUPS,
      REVOCATION_LEDGER: c.env.REVOCATION_LEDGER,
    },
  }
  await closeServiceForRecovery(staged)
  await expect(restoreServiceSnapshot(staged, snapshot)).rejects.toThrow('transaction_guard_passed')
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('closed')
}, 90000)
