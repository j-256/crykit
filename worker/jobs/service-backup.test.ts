import { afterEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { plainChunkBytes, streamOverheadBytes } from '../../src/account/protocol'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { customer, prepared, post, command, id } from '../sync/testing'
import { createServiceContext, type ServiceContext } from '../context'
import { initializeRevocationLedger } from './ledger'
import {
  serviceRecoveryStatus,
  captureServiceSnapshot,
  readSnapshotManifest,
  verifyServiceSnapshot,
  expireServiceSnapshot,
} from './service-backup'
import { closeServiceForRecovery, promoteServiceRestore, restoreServiceSnapshot } from './service-restore'
import { recoverySecretNames } from './recovery-codec'

const fixtures: ServiceFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
const policy = JSON.stringify({
  version: 1,
  maxRows: 10000,
  maxBytes: 8 * 1024 * 1024,
  maxEdges: 10000,
  maxWork: 20000,
  maxTemporaryBytes: 64 * 1024 * 1024,
  maxStatements: 100,
  maxRowBytes: 1_900_000,
})
async function fixture(secrets?: ServiceFixture['env']) {
  const f = await createServiceFixture({
    now: 1_800_000_000_000,
    recoveryPolicy: policy,
    recoverySecrets: secrets ? Object.fromEntries(recoverySecretNames.map((key) => [key, secrets[key]])) : undefined,
  })
  fixtures.push(f)
  return f
}
const context = (f: ServiceFixture): ServiceContext =>
  createServiceContext(new Request('http://127.0.0.1'), f.env as unknown as ServiceContext['env'], {
    now: () => 1_800_000_000_000,
    emit() {},
  })
// Native steps use the fixture clock and bindings; custom contexts below retain direct Node calls
async function capture(f: ServiceFixture, snapshot = id()) {
  for (let i = 0; i < 1500; i++) {
    const { receipt: r } = await f.captureStep(snapshot)
    if (r.state === 'complete') return snapshot
    if (r.state === 'waiting') throw new Error('Capture paused')
  }
  throw new Error('Capture did not finish')
}
async function restore(c: ServiceContext, snapshot: string) {
  for (let i = 0; i < 2000; i++) {
    await restoreServiceSnapshot(c, snapshot)
    if ((await c.env.DB!.prepare('SELECT state FROM recovery_control').first('state')) === 'verified') return
  }
  throw new Error('Restore did not finish')
}
async function staged(f: ServiceFixture) {
  const target = await fixture(f.env),
    c = {
      ...context(target),
      env: {
        ...target.env,
        LEDGER_BACKUPS: f.env.LEDGER_BACKUPS,
        REVOCATION_LEDGER: f.env.REVOCATION_LEDGER,
      } as unknown as ServiceContext['env'],
    }
  await closeServiceForRecovery(c)
  return { target, c }
}
it('localCaptureStepsKeepNativeFaultsAndRejectNonSnapshotCommands', async () => {
  const f = await fixture(), c = context(f), snapshot = id()
  await initializeRevocationLedger(c)
  // Keep this literal independent of the helper so a shared route mistake cannot satisfy the contract
  const path = '/__accounts/probe/capture-step'
  const invoke = (body: object) => f.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const first = await invoke({ snapshot })
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ ok: true, receipt: { jobId: snapshot, state: 'running' } })
  expect(await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state')).toBe('pages')
  for (const body of [{ snapshot: 'invalid' }, { snapshot, sql: 'DELETE FROM service_snapshots' }]) expect((await invoke(body)).status).toBe(400)
  expect((await f.request(path)).status).toBe(404)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshots').first('n')).toBe(1)
  const interrupted = id()
  f.failNext('backup.capture.before')
  expect(await (await invoke({ snapshot: interrupted })).json()).toMatchObject({ ok: false, error: { code: 'SERVICE_UNAVAILABLE' } })
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshots WHERE id=?').bind(interrupted).first('n')).toBe(0)
  const production = await createServiceFixture({ now: c.now(), recoveryPolicy: policy, production: true })
  fixtures.push(production)
  expect((await production.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot }) })).status).toBe(404)
}, 90_000)
it('capturesConsistentMetadataAndReferencedCipherObjects', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f),
    upload = await prepared(f, owner)
  expect((await post(f, 'sync/commits', command([upload.descriptor]), owner.headers)).status).toBe(200)
  await initializeRevocationLedger(c)
  const snapshot = id()
  await f.captureStep(snapshot)
  const newer = await prepared(f, owner)
  expect((await post(f, 'sync/commits', command([newer.descriptor]), owner.headers)).status).toBe(200)
  await capture(f, snapshot)
  for (let i = 0; i < 1000; i++) {
    try {
      await verifyServiceSnapshot(c, snapshot)
      break
    } catch (error) {
      if ((error as { code: string }).code !== 'SERVICE_UNAVAILABLE') throw error
    }
  }
  const { target, c: targetContext } = await staged(f)
  await restore(targetContext, snapshot)
  expect(await target.db.prepare('SELECT sequence,publication_epoch FROM account_sequences').first()).toEqual({
    sequence: 1,
    publication_epoch: 1,
  })
  expect(await target.db.prepare('SELECT revision_id FROM sync_revisions').all()).toMatchObject({
    results: [{ revision_id: upload.descriptor.revisionId }],
  })
  const key = await target.db
    .prepare("SELECT object_key FROM upload_chunks WHERE state='ready'")
    .first<string>('object_key')
  expect(new Uint8Array(await (await target.objects.get(key!))!.arrayBuffer())).toEqual(new Uint8Array(upload.bytes))
  expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
  await closeServiceForRecovery(c)
  const { runServiceJobs } = await import('./runner')
  await expect(runServiceJobs(c, 1)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  await expect(
    f.db.prepare("UPDATE accounts SET username='late_writer' WHERE id=?").bind(owner.accountId).run(),
  ).rejects.toThrow('service_closed')
  await promoteServiceRestore(targetContext, c)
  expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: true })
  expect((await target.request('/api/v1/auth/session', { headers: owner.headers })).status).toBe(401)
}, 90_000)
it('captures verifies and restores a full supported ciphertext chunk', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f),
    upload = await prepared(
      f,
      owner,
      { plainBytes: plainChunkBytes },
      randomBytes(plainChunkBytes + streamOverheadBytes),
    )
  expect((await post(f, 'sync/commits', command([upload.descriptor]), owner.headers)).status).toBe(200)
  await initializeRevocationLedger(c)
  const snapshot = await capture(f)
  let verified = false
  for (let step = 0; step < 1000; step++) {
    try {
      await verifyServiceSnapshot(c, snapshot)
      verified = true
      break
    } catch (error) {
      if ((error as { code: string }).code !== 'SERVICE_UNAVAILABLE') throw error
    }
  }
  expect(verified).toBe(true)
  const { target, c: targetContext } = await staged(f)
  await restore(targetContext, snapshot)
  const key = await target.db
    .prepare("SELECT object_key FROM upload_chunks WHERE state='ready'")
    .first<string>('object_key')
  const recovered = await target.objects.get(key!)
  expect(recovered!.size).toBe(plainChunkBytes + streamOverheadBytes)
  expect(Buffer.from(await recovered!.arrayBuffer()).equals(upload.bytes)).toBe(true)
  expect(await target.db.prepare('SELECT revision_id FROM sync_revisions').first('revision_id')).toBe(
    upload.descriptor.revisionId,
  )
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
  expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
}, 90_000)
it.each([
  'missing-locator',
  'corrupt-locator',
  'missing-root',
  'corrupt-root',
  'unavailable-locator',
  'secret-mismatch',
])(
  'persists paused health and original recovery point after manifest verification failure: %s',
  async (fault) => {
    const f = await fixture(),
      c = context(f)
    await initializeRevocationLedger(c)
    const snapshot = await capture(f)
    const locatorKey = `service-snapshots/v1/${snapshot}`
    const root = JSON.parse(await (await f.backups.get(locatorKey))!.text()) as { key: string; size: number }
    const faultKey = fault.endsWith('root') ? root.key : locatorKey
    if (fault.startsWith('corrupt')) await f.backups.put(faultKey, randomBytes(fault.endsWith('root') ? root.size : 33))
    const bucket = c.env.LEDGER_BACKUPS!
    const brokenBucket = new Proxy(bucket, {
      get(original, property) {
        if (property === 'get')
          return async (key: string) => {
            if (key === faultKey && fault.startsWith('missing')) return null
            if (key === faultKey && fault === 'unavailable-locator')
              throw new Error('Synthetic bucket read unavailable')
            return original.get(key)
          }
        const value = Reflect.get(original, property)
        return typeof value === 'function' ? value.bind(original) : value
      },
    })
    const later = { ...c, now: () => c.now() + 1000 }
    expect(await serviceRecoveryStatus(later)).toMatchObject({
      state: 'verified',
      lastVerifiedAt: c.now(),
      ageMs: 1000,
      code: null,
    })
    await expect(
      verifyServiceSnapshot(
        {
          ...later,
          env: {
            ...c.env,
            LEDGER_BACKUPS: brokenBucket,
            ...(fault === 'secret-mismatch' ? { DUMMY_IDENTITY_SECRET: randomBytes(32).toString('base64url') } : {}),
          },
        },
        snapshot,
      ),
    ).rejects.toThrow()
    // Read health through the original context to prove the failure survives the injected read fault
    expect(await serviceRecoveryStatus(later)).toMatchObject({
      state: 'paused',
      lastVerifiedAt: c.now(),
      ageMs: 1000,
      code: fault === 'unavailable-locator' ? 'CAPTURE_RETRY_REQUIRED' : 'INTEGRITY_FAILED',
    })
  },
  90_000,
)
it.each(['missing', 'corrupt'])(
  'missingObjectsCannotBecomeSuccessfulRestore: %s',
  async (fault) => {
    const f = await fixture(),
      c = context(f),
      owner = await customer(f)
    await prepared(f, owner)
    await initializeRevocationLedger(c)
    const snapshot = await capture(f),
      key = await f.db
        .prepare("SELECT object_key FROM service_backup_objects WHERE identity LIKE 'cipher:%'")
        .first<string>('object_key')
    if (fault === 'corrupt') await f.backups.put(key!, randomBytes(33))
    const { c: targetContext, target } = await staged(f)
    const bucket = targetContext.env.LEDGER_BACKUPS!
    const missing = new Proxy(bucket, {
      get(original, property) {
        if (property === 'get') return async (objectKey: string) => (objectKey === key ? null : original.get(objectKey))
        const value = Reflect.get(original, property)
        return typeof value === 'function' ? value.bind(original) : value
      },
    })
    const broken =
      fault === 'missing' ? { ...targetContext, env: { ...targetContext.env, LEDGER_BACKUPS: missing } } : targetContext
    await expect(restore(broken, snapshot)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
  },
  90_000,
)
it('rejects syntactically valid original secret mismatches before installing metadata', async () => {
  const f = await fixture(),
    c = context(f)
  await initializeRevocationLedger(c)
  const snapshot = await capture(f)
  const { c: targetContext, target } = await staged(f)
  await expect(
    restoreServiceSnapshot(
      { ...targetContext, env: { ...targetContext.env, DUMMY_IDENTITY_SECRET: randomBytes(32).toString('base64url') } },
      snapshot,
    ),
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  await expect(
    restoreServiceSnapshot(
      { ...targetContext, env: { ...targetContext.env, OPAQUE_SERVER_SETUP: undefined } },
      snapshot,
    ),
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  const different = await fixture()
  await expect(
    restoreServiceSnapshot(
      { ...targetContext, env: { ...targetContext.env, OPAQUE_SERVER_SETUP: different.env.OPAQUE_SERVER_SETUP } },
      snapshot,
    ),
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(await target.db.prepare('SELECT COUNT(*) n FROM accounts').first('n')).toBe(0)
}, 90_000)
it.each(['unavailable', 'corrupt', 'regressed'])(
  'keeps restore closed when the independent ledger is %s',
  async (fault) => {
    const { appendRevocation } = await import('./ledger')
    const f = await fixture(),
      c = context(f)
    await initializeRevocationLedger(c)
    await appendRevocation(
      {
        version: 1,
        kind: 'share-stopped',
        intentId: id(),
        accountId: id(),
        shareId: id(),
        sessionEpoch: 1,
        timestamp: c.now(),
      },
      c,
    )
    const snapshot = await capture(f),
      { target, c: targetContext } = await staged(f)
    await restoreServiceSnapshot(targetContext, snapshot)
    let broken = targetContext
    if (fault === 'unavailable')
      broken = {
        ...targetContext,
        env: {
          ...targetContext.env,
          REVOCATION_LEDGER: new Proxy(targetContext.env.REVOCATION_LEDGER!, {
            get() {
              return async () => {
                throw new Error('synthetic outage')
              }
            },
          }),
        },
      }
    else
      await f.revocations.put(
        'revocations/v1/head',
        fault === 'corrupt' ? 'invalid' : JSON.stringify({ version: 1, sequence: 0, digest: null }),
      )
    await expect(restoreServiceSnapshot(broken, snapshot)).rejects.toThrow()
    expect(await target.db.prepare('SELECT COUNT(*) n FROM accounts').first('n')).toBe(0)
    expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
  },
  90_000,
)
it('cancels unfinished snapshot copies before completing account deletion', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  const snapshot = id()
  for (let i = 0; i < 1000; i++) {
    await f.captureStep(snapshot)
    if (
      (await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state')) === 'cipher'
    )
      break
  }
  const capability = randomBytes(32).toString('base64url'),
    headers = { 'x-deletion-status': capability }
  expect(
    (await post(f, 'account/deletion', { confirmation: 'DELETE MY ACCOUNT' }, { ...owner.headers, ...headers })).status,
  ).toBe(202)
  for (let step = 0; step < 120; step++) {
    await f.runJobs()
    f.advance(60_000)
    if (
      ((await (await f.request('/api/v1/account/deletion', { headers })).json()) as { state: string }).state ===
      'complete'
    )
      break
  }
  expect(await (await f.request('/api/v1/account/deletion', { headers })).json()).toMatchObject({ state: 'complete' })
  expect(await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state')).toBe(
    'expired',
  )
  expect(await f.db.prepare("SELECT COUNT(*) n FROM service_backup_objects WHERE state<>'closed'").first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshot_pins').first('n')).toBe(0)
}, 90_000)
it('deduplicates retained immutable ciphertext and preserves references across expiration', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  const a = await capture(f),
    b = await capture(f)
  expect(
    await f.db.prepare("SELECT COUNT(*) n FROM service_backup_objects WHERE identity LIKE 'cipher:%'").first('n'),
  ).toBe(1)
  for (let i = 0; i < 1000; i++) if (await expireServiceSnapshot(c, a)) break
  expect(await readSnapshotManifest(c, b)).toMatchObject({ snapshotId: b })
  expect(
    await f.db.prepare("SELECT state FROM service_backup_objects WHERE identity LIKE 'cipher:%'").first('state'),
  ).toBe('ready')
}, 90_000)
it('rolls guarded metadata capture and pins back on a real SQL failure', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  await f.db
    .prepare(
      "CREATE TRIGGER reject_capture BEFORE INSERT ON service_snapshot_pins BEGIN SELECT RAISE(ABORT,'injected_capture_failure'); END",
    )
    .run()
  const snapshot = id(),
    before = await f.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first()
  await expect(f.captureStep(snapshot)).rejects.toThrow('injected_capture_failure')
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshot_rows').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshot_pins').first('n')).toBe(0)
  expect(await f.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first()).toEqual(before)
  await f.db.prepare('DROP TRIGGER reject_capture').run()
  await capture(f, snapshot)
}, 90_000)
it('uses complete authoritative row and byte accounting and visibly pauses oversized capture', async () => {
  const { recoveryTables, recoveryProjection } = await import('./recovery-projection')
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  for (const table of recoveryTables) {
    const expected = await f.db
      .prepare(
        `SELECT COUNT(*) rows,COALESCE(SUM(length(CAST(json_array(${recoveryProjection[table].join(',')}) AS BLOB))),0) bytes FROM ${table}`,
      )
      .first()
    expect(await f.db.prepare('SELECT rows,bytes FROM recovery_source_stats WHERE name=?').bind(table).first()).toEqual(
      expected,
    )
  }
  const prior = await capture(f),
    snapshot = id(),
    limited = { ...c, env: { ...c.env, SERVICE_BACKUP_POLICY: JSON.stringify({ ...JSON.parse(policy), maxRows: 1 }) } }
  expect(await captureServiceSnapshot(limited, snapshot)).toMatchObject({ state: 'waiting' })
  expect(
    await f.db.prepare('SELECT COUNT(*) n FROM service_snapshot_rows WHERE snapshot_id=?').bind(snapshot).first('n'),
  ).toBe(0)
  expect(await readSnapshotManifest(c, prior)).toMatchObject({ snapshotId: prior })
  expect((await f.request('/api/v1/service')).status).toBe(200)
  expect(await (await f.request('/api/v1/account/recovery', { headers: owner.headers })).json()).toMatchObject({
    state: 'paused',
    code: 'CAPTURE_NOT_ADMITTED',
    lastVerifiedAt: c.now(),
  })
}, 90_000)
it('charges paused capture records and keeps admission failure bounded when capacity is exhausted', async () => {
  const f = await fixture(),
    c = context(f)
  const before = await f.db
    .prepare("SELECT reserved_metadata FROM quota_counters WHERE scope='global'")
    .first<number>('reserved_metadata')
  const paused = { ...c, env: { ...c.env, SERVICE_BACKUP_POLICY: undefined } }
  expect(await captureServiceSnapshot(paused, id())).toMatchObject({ state: 'waiting' })
  expect(
    await f.db
      .prepare("SELECT reserved_metadata FROM quota_counters WHERE scope='global'")
      .first<number>('reserved_metadata'),
  ).toBe(before! + 8192)
  const full = { ...paused, env: { ...paused.env, STORAGE_CAP_BYTES: '1' } },
    next = id()
  expect(await captureServiceSnapshot(full, next)).toMatchObject({ state: 'waiting' })
  expect(await f.db.prepare('SELECT COUNT(*) n FROM service_snapshots WHERE id=?').bind(next).first('n')).toBe(0)
})
it('rolls back a ledger import that would exceed staged capacity and remains closed', async () => {
  const { appendRevocation } = await import('./ledger')
  const f = await fixture(),
    c = context(f)
  await initializeRevocationLedger(c)
  const snapshot = await capture(f)
  await appendRevocation(
    {
      version: 1,
      kind: 'share-stopped',
      intentId: id(),
      accountId: id(),
      shareId: id(),
      sessionEpoch: 1,
      timestamp: c.now(),
    },
    c,
  )
  const { target, c: targetContext } = await staged(f)
  await restoreServiceSnapshot(targetContext, snapshot)
  const charged = await target.db
    .prepare("SELECT payload_bytes+reserved_metadata+metadata_bytes n FROM quota_counters WHERE scope='global'")
    .first<number>('n')
  await expect(
    restoreServiceSnapshot(
      { ...targetContext, env: { ...targetContext.env, STORAGE_CAP_BYTES: String(charged) } },
      snapshot,
    ),
  ).rejects.toThrow('transaction_guard_passed')
  expect(await target.db.prepare('SELECT COUNT(*) n FROM recovery_ledger_events').first('n')).toBe(0)
  expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
}, 90_000)
it('snapshot admission and ordinary cleanup consult the same exact generation pin', async () => {
  const { claimGenerationCleanup } = await import('../sync/storage')
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  const generation = await f.db.prepare('SELECT id FROM storage_generations').first<string>('id'),
    snapshot = id()
  await f.captureStep(snapshot)
  const expired = { ...c, now: () => c.now() + 25 * 60 * 60 * 1000 }
  expect(await claimGenerationCleanup(owner.accountId, generation!, expired)).toBe(false)
  for (let i = 0; i < 1000; i++) if (await expireServiceSnapshot(c, snapshot)) break
  expect(await claimGenerationCleanup(owner.accountId, generation!, expired)).toBe(true)
  const blocked = id()
  expect((await f.captureStep(blocked)).receipt).toMatchObject({ state: 'waiting' })
}, 90_000)
it.each(['payload', 'initializer'])(
  'a delayed actual backup %s cannot overwrite the expiration marker or release twice',
  async (kind) => {
    const f = await fixture(),
      c = context(f),
      owner = await customer(f)
    await prepared(f, owner)
    await initializeRevocationLedger(c)
    const snapshot = id()
    for (let i = 0; i < 1000; i++) {
      await f.captureStep(snapshot)
      if (
        (await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state')) ===
        'cipher'
      )
        break
    }
    let resume!: () => void, entered!: () => void
    const held = new Promise<void>((r) => {
        resume = r
      }),
      authorized = new Promise<void>((r) => {
        entered = r
      }),
      bucket = c.env.LEDGER_BACKUPS!
    const delayed = new Proxy(bucket, {
      get(target, key) {
        if (key === 'put')
          return async (...args: Parameters<typeof bucket.put>) => {
            if (
              (args[2] as R2PutOptions | undefined)?.onlyIf &&
              (kind === 'payload' ? 'etagMatches' : 'etagDoesNotMatch') in ((args[2] as R2PutOptions).onlyIf as object)
            ) {
              entered()
              await held
            }
            return target.put(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const copying = captureServiceSnapshot({ ...c, env: { ...c.env, LEDGER_BACKUPS: delayed } }, snapshot)
    await authorized
    // Expiration drains earlier metadata references before claiming this exact in-flight copy
    for (let i = 0; i < 1000; i++) {
      await expireServiceSnapshot(c, snapshot)
      if (
        (await f.db
          .prepare("SELECT state FROM service_backup_objects WHERE identity LIKE 'cipher:%'")
          .first('state')) === 'closed'
      )
        break
    }
    const before = await f.db
      .prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'")
      .first('payload_bytes')
    resume()
    await expect(copying).rejects.toMatchObject({
      code: kind === 'payload' ? 'INTEGRITY_FAILED' : 'SERVICE_UNAVAILABLE',
    })
    const row = await f.db
      .prepare("SELECT object_key,marker,state FROM service_backup_objects WHERE identity LIKE 'cipher:%'")
      .first<{ object_key: string; marker: string; state: string }>()
    expect(row!.state).toBe('closed')
    expect(Buffer.from(await (await f.backups.get(row!.object_key))!.arrayBuffer()).toString('base64url')).toBe(
      row!.marker,
    )
    expect(
      await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'").first('payload_bytes'),
    ).toBe(before)
  },
  90_000,
)
it('reapplies every independently acknowledged deletion liability and stopped share after older restore', async () => {
  const { appendRevocation, prepareRevocationLiabilities } = await import('./ledger'),
    { controlBody, decode, digest } = await import('../sync/storage')
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  const snapshot = await capture(f),
    markers = []
  for (let index = 0; index < 3; index++) {
    const intent = id(),
      marker = controlBody(1),
      key = `sync/${id()}`
    markers.push(key)
    await prepareRevocationLiabilities(
      intent,
      [
        {
          version: 1,
          intentId: intent,
          page: 0,
          entries: [
            {
              managedKey: key,
              markerIdentity: marker,
              markerDigest: await digest(decode(marker)),
              retainedBytes: 32,
              closed: true,
              payloadReleased: true,
            },
          ],
        },
      ],
      c,
    )
    await appendRevocation(
      {
        version: 1,
        kind: 'account-deleted',
        intentId: intent,
        accountId: owner.accountId,
        sessionEpoch: 1,
        timestamp: c.now(),
      },
      c,
    )
  }
  const { target, c: targetContext } = await staged(f)
  await restore(targetContext, snapshot)
  expect(await target.db.prepare('SELECT COUNT(*) n FROM accounts').first('n')).toBe(0)
  expect(
    await target.db.prepare('SELECT object_key FROM recovery_liabilities ORDER BY object_key').all(),
  ).toMatchObject({ results: markers.sort().map((object_key) => ({ object_key })) })
  expect(await target.db.prepare("SELECT COUNT(*) n FROM upload_chunks WHERE state='ready'").first('n')).toBe(0)
}, 90_000)
it.each([
  'restore.download.before',
  'restore.item.verified',
  'restore.assemble.before',
  'restore.install.before',
  'restore.ledger.before',
  'restore.ledger.verified',
])(
  'keeps interrupted restore closed and resumes exact identity at %s',
  async (stage) => {
    const f = await fixture(),
      c = context(f),
      owner = await customer(f)
    await prepared(f, owner)
    await initializeRevocationLedger(c)
    const snapshot = await capture(f),
      { target, c: targetContext } = await staged(f)
    let failed = false
    const interrupted = {
      ...targetContext,
      checkpoint(value: string) {
        if (!failed && value === stage) {
          failed = true
          throw new Error('interrupted')
        }
      },
    }
    await expect(restore(interrupted, snapshot)).rejects.toThrow('interrupted')
    expect(failed).toBe(true)
    expect(await (await target.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: false })
    await restore(targetContext, snapshot)
    expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
  },
  90_000,
)
it('keeps a stopped public pointer unavailable after an older snapshot restore', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await initializeRevocationLedger(c)
  const publicSnapshot = {
    version: 5,
    kind: 'build',
    title: 'Recovery share',
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
    f,
    'shares',
    { mutationId: id(), snapshot: publicSnapshot, includeAttribution: false },
    owner.headers,
  )
  expect(published.status).toBe(200)
  const { shareId } = (await published.json()) as { shareId: string },
    snapshot = await capture(f)
  expect(
    (
      await f.request(`/api/v1/shares/${shareId}`, {
        method: 'DELETE',
        headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...owner.headers },
        body: JSON.stringify({ mutationId: id(), expectedRevision: 1 }),
      })
    ).status,
  ).toBe(200)
  const { target, c: targetContext } = await staged(f)
  await restore(targetContext, snapshot)
  await closeServiceForRecovery(c)
  await promoteServiceRestore(targetContext, c)
  expect((await target.request(`/api/public/v1/shares/${shareId}`)).status).toBe(404)
}, 90_000)
it('records complete local capture and independent-resource measurements', async () => {
  const { measurement, measuredDatabase } = await import('../sync/testing')
  const f = await fixture(),
    base = context(f),
    owner = await customer(f)
  const upload = await prepared(f, owner)
  expect((await post(f, 'sync/commits', command([upload.descriptor]), owner.headers)).status).toBe(200)
  await initializeRevocationLedger(base)
  const measured = measuredDatabase(f.db),
    atomic: unknown[] = []
  const started = performance.now(),
    snapshot = id(),
    capturePeak = { queries: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 }
  async function step(meter: typeof measured, peak: typeof capturePeak, action: () => Promise<unknown>) {
    const before = { ...meter.values },
      start = performance.now()
    const result = await action()
    for (const name of ['queries', 'rowsRead', 'rowsWritten'] as const)
      peak[name] = Math.max(peak[name], meter.values[name] - before[name])
    peak.durationMs = Math.max(peak.durationMs, performance.now() - start)
    return result
  }
  for (let i = 0; i < 1500; i++)
    if (
      ((await step(measured, capturePeak, async () => {
        const result = await f.captureStep(snapshot)
        // Totals accumulate, while per-step bounds must retain their maximum rather than their sum
        for (const name of ['queries', 'rowsRead', 'rowsWritten'] as const) measured.values[name] += result.measurements[name]
        for (const name of ['maxBatchStatements', 'maxBindings', 'maxSqlBytes'] as const) measured.values[name] = Math.max(measured.values[name], result.measurements[name])
        atomic.push(...result.events)
        return result.receipt
      })) as { state: string }).state ===
      'complete'
    )
      break
  expect(await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(snapshot).first('state')).toBe(
    'complete',
  )
  const backups = await f.backups.list({ limit: 1000 }),
    ledger = await f.revocations.list({ limit: 1000 })
  await measurement('o03-local-recovery', {
    durationMs: performance.now() - started,
    queries: measured.values,
    capturePeak,
    atomic,
    sourceStats: await f.db
      .prepare('SELECT SUM(rows) rows,SUM(bytes) bytes,MAX(max_row_bytes) maximumRowBytes FROM recovery_source_stats')
      .first(),
    snapshot: await f.db
      .prepare('SELECT rows,bytes,reserve,page,state FROM service_snapshots WHERE id=?')
      .bind(snapshot)
      .first(),
    global: await f.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first(),
    backupObjects: backups.objects.length,
    backupBytes: backups.objects.reduce((n, row) => n + row.size, 0),
    ledgerObjects: ledger.objects.length,
    ledgerBytes: ledger.objects.reduce((n, row) => n + row.size, 0),
  })
  const { target, c: targetBase } = await staged(f),
    restoreMeter = measuredDatabase(target.db)
  const targetContext = { ...targetBase, env: { ...targetBase.env, DB: restoreMeter.db } },
    restoreStarted = performance.now(),
    restorePeak = { queries: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 }
  for (let i = 0; i < 2000; i++) {
    await step(restoreMeter, restorePeak, () => restoreServiceSnapshot(targetContext, snapshot))
    if ((await target.db.prepare('SELECT state FROM recovery_control').first('state')) === 'verified') break
  }
  expect(await target.db.prepare('SELECT state FROM recovery_control').first('state')).toBe('verified')
  const objects = await target.objects.list({ limit: 1000 })
  await measurement('o03-local-restore', {
    durationMs: performance.now() - restoreStarted,
    queries: restoreMeter.values,
    restorePeak,
    global: await target.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first(),
    objectCount: objects.objects.length,
    objectBytes: objects.objects.reduce((sum, object) => sum + object.size, 0),
  })
}, 90_000)

it('reports invalid admission as paused and clears older failure after a verified capture', async () => {
  const f = await fixture(),
    c = context(f)
  await initializeRevocationLedger(c)
  const invalid = { ...c, env: { ...c.env, SERVICE_BACKUP_POLICY: 'invalid' } }
  expect(await captureServiceSnapshot(invalid, id())).toMatchObject({ state: 'waiting' })
  expect(await serviceRecoveryStatus(invalid)).toMatchObject({ state: 'paused', code: 'MEASURED_POLICY_REQUIRED' })
  await capture(f)
  expect(await serviceRecoveryStatus(c)).toMatchObject({ state: 'verified', code: null, lastVerifiedAt: c.now() })
}, 90_000)

it('simultaneous final dedup reference removals still claim and fence the object', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f)
  await prepared(f, owner)
  await initializeRevocationLedger(c)
  const a = await capture(f),
    b = await capture(f)
  for (const snapshot of [a, b])
    for (let i = 0; i < 1000; i++) {
      if (
        (await f.db
          .prepare('SELECT kind FROM service_snapshot_objects WHERE snapshot_id=? ORDER BY ordinal LIMIT 1')
          .bind(snapshot)
          .first('kind')) === 'cipher'
      )
        break
      await expireServiceSnapshot(c, snapshot)
    }
  let arrived = 0,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    db = c.env.DB!
  const overlapping = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (sql !== 'SELECT * FROM service_backup_objects WHERE id=?') return statement
          return new Proxy(statement, {
            get(inner, method) {
              if (method === 'bind')
                return (...args: Parameters<typeof statement.bind>) => {
                  const bound = inner.bind(...args)
                  return new Proxy(bound, {
                    get(value, operation) {
                      if (operation === 'first')
                        return async () => {
                          const result = await value.first()
                          if (++arrived === 2) release()
                          await gate
                          return result
                        }
                      const member = Reflect.get(value, operation)
                      return typeof member === 'function' ? member.bind(value) : member
                    },
                  })
                }
              const member = Reflect.get(inner, method)
              return typeof member === 'function' ? member.bind(inner) : member
            },
          })
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await Promise.all(
    [a, b].map((snapshot) => expireServiceSnapshot({ ...c, env: { ...c.env, DB: overlapping } }, snapshot)),
  )
  for (const snapshot of [a, b]) for (let i = 0; i < 1000; i++) if (await expireServiceSnapshot(c, snapshot)) break
  const cipher = await f.db
    .prepare("SELECT object_key,state,marker FROM service_backup_objects WHERE identity LIKE 'cipher:%'")
    .first<{ object_key: string; state: string; marker: string }>()
  expect(cipher!.state).toBe('closed')
  expect(Buffer.from(await (await f.backups.get(cipher!.object_key))!.arrayBuffer()).toString('base64url')).toBe(
    cipher!.marker,
  )
}, 90_000)

it('ownerProjectCeilingRejectsLiveCaptureAndGrowthWithoutLosingProtectedData', async () => {
  const f = await fixture(),
    c = context(f),
    owner = await customer(f),
    upload = await prepared(f, owner)
  expect((await post(f, 'sync/commits', command([upload.descriptor]), owner.headers)).status).toBe(200)
  await initializeRevocationLedger(c)
  const retained = await capture(f),
    growing = id()
  await f.captureStep(growing)
  expect(
    await f.db.prepare('SELECT state FROM service_snapshots WHERE id=?').bind(growing).first('state'),
  ).toBe('pages')
  await f.db
    .prepare("UPDATE service_settings SET project_capacity_bytes=1,revision=revision+1 WHERE id='service'")
    .run()
  const before = await f.db.prepare('SELECT * FROM service_backup_objects ORDER BY id').all()
  const rejected = id()
  expect((await f.captureStep(rejected)).receipt).toMatchObject({ state: 'waiting' })
  expect(
    await f.db.prepare('SELECT count(*) AS n FROM service_snapshots WHERE id=?').bind(rejected).first('n'),
  ).toBe(0)
  await expect(f.captureStep(growing)).rejects.toThrow('transaction_guard_passed')
  expect((await f.db.prepare('SELECT * FROM service_backup_objects ORDER BY id').all()).results).toEqual(
    before.results,
  )
  expect(
    await f.db
      .prepare('SELECT count(*) AS n FROM service_snapshot_objects WHERE snapshot_id=?')
      .bind(growing)
      .first('n'),
  ).toBe(0)
  expect(await readSnapshotManifest(c, retained)).toMatchObject({ snapshotId: retained })
  const key = await f.db
    .prepare("SELECT object_key FROM upload_chunks WHERE state='ready'")
    .first<string>('object_key')
  expect(new Uint8Array(await (await f.objects.get(key!))!.arrayBuffer())).toEqual(
    new Uint8Array(upload.bytes),
  )
  let expired = false
  for (let step = 0; step < 100 && !expired; step++) expired = await expireServiceSnapshot(c, growing)
  expect(expired).toBe(true)
  expect(await readSnapshotManifest(c, retained)).toMatchObject({ snapshotId: retained })
}, 90000)
