// Cross-runtime proof keeps browser and Worker ambient globals separate
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from '../../src/persistence/account-database'
import { accountLocalId } from '../../src/workspace/account-cache'
import { installProfile, invalidateProfile } from '../../src/account/profile'
import { seedNativePublicationWorkspace } from '../../src/persistence/native-publication.test-helpers'
import { openAccountWorkspace, prepareAccountWorkspace } from '../../src/workspace/account-graph'
import { mappedChanges } from '../../src/workspace/account-intents'
import { preparePublicationAttempt } from '../../src/account/sync/publication'
import { openRemoteProjection } from '../../src/account/sync/projection'
import { EncryptedOutbox, transferBudget } from '../../src/account/sync/outbox'
import { SyncClient } from '../../src/account/sync/client'
import { scanCleanupCandidates } from '../../src/account/cleanup'
import { fixture, customer, direct } from '../../worker/sync/testing'
import { previewCleanup, executeCleanup } from '../../worker/sync/cleanup'
let database
afterEach(async () => {
  vi.unstubAllGlobals()
  invalidateProfile()
  await database?.delete()
})
it('real native publication producer and decrypted discovery reclaim only unused transport envelopes', async () => {
  const f = await fixture(), signed = await customer(f), { context, principal } = await direct(f, signed)
  const token = installProfile(signed.accountId, crypto.getRandomValues(new Uint8Array(32)), {
    ...principal,
    csrf: signed.csrf,
    username: 'synthetic'
  })
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  vi.stubGlobal('fetch', async (path, init) => {
    const headers = new Headers(init.headers)
    headers.set('cookie', signed.headers.cookie)
    headers.set('origin', 'http://127.0.0.1')
    return f.request(path, {
      ...init,
      headers
    })
  })
  const outbox = new EncryptedOutbox(database, token), client = new SyncClient(token, new AbortController().signal)
  async function publish(attempt) {
    for (const command of [
      ...attempt.registrations,
      attempt.final
    ]) {
      await outbox.prepare(command)
      let accepted = false
      for (let step = 0; step < 200; step++) {
        try {
          if (await outbox.advance(command.mutationId, client, transferBudget())) {
            accepted = true
            break
          }
        } catch (error) {
          if (!(error instanceof Error && [
            'SERVICE_UNAVAILABLE',
            'COMMIT_CONTINUING'
          ].includes(error.message))) throw error
        }
      }
      expect(accepted).toBe(true)
    }
  }
  let local = await openAccountWorkspace(database, token, (await database.profileMeta.get('active')).head)
  const initial = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  await publish(initial)
  const heads = new Map(initial.final.heads.map((ref) => [
      ref.documentId,
      ref.revisionId
    ]))
  let remote = await openRemoteProjection(database, token, heads, local.head, 0)
  const seed = remote.units.get('["library-defaults"]').ref, protectedOriginals = await database.encryptedRevisions.filter((row) => row.descriptor.protected).toArray()
  let candidate
  for (let n = 0; n < 21; n++) {
    const catalog = local.state.planner.catalogs[0]
    const prepared = await prepareAccountWorkspace(database, token, {
      ...local.state,
      libraryDefaults: {
        version: 1,
        layers: n % 2 === 0 ? [
          {
            catalogId: catalog.id,
            catalogRevisionId: catalog.revisionId,
            enabled: true
          }
        ] : []
      }
    }, local)
    await database.encryptedRevisions.bulkAdd(prepared.records)
    const captured = {
      lineageId: remote.lineageId,
      parents: new Map([
        ...remote.units.values()
      ].map((unit) => [
          unit.body.ref.revisionId,
          unit.ref
        ]))
    }
    const attempt = await preparePublicationAttempt(database, token, prepared.opened, remote, heads, n + 1, mappedChanges(local, prepared.opened), 'additive', captured)
    const envelope = attempt.bindings.find((binding) => binding.body.revisionId === prepared.entries.find((entry) => entry.kind === 'library-defaults').ref.revisionId).publication
    candidate ??= envelope
    await publish(attempt)
    for (const head of attempt.final.heads) heads.set(head.documentId, head.revisionId)
    local = prepared.opened
    remote = await openRemoteProjection(database, token, heads, local.head, n + 1)
  }
  let cursor, found = false
  do {
    const page = await scanCleanupCandidates(token, cursor)
    found ||= page.candidates.some((value) => value.ref.revisionId === candidate.revisionId)
    cursor = page.cursor
  } while (cursor)
  expect(found).toBe(true)
  const record = await database.encryptedRevisions.get(candidate.revisionId)
  await f.db.prepare('UPDATE storage_generations SET expires_at=? WHERE upload_id=?').bind(context.now() - 31 * 86400000, record.descriptor.uploadId).run()
  const { stageAccountBytes } = await import('../../src/workspace/account-cache')
  const waiting = await stageAccountBytes(database, token, new TextEncoder().encode('Pending file remains private'), [])
  await database.encryptedRevisions.add(waiting)
  const pending = {
    version: 1,
    mutationId: accountLocalId(),
    revisions: [
      waiting.descriptor
    ],
    heads: [],
    expected: []
  }
  await outbox.prepare(pending)
  const originalCapacity = await f.db.prepare('SELECT capacity_bytes FROM accounts WHERE id=?').bind(signed.accountId).first('capacity_bytes')
  await f.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(signed.accountId).run()
  await expect(outbox.advance(pending.mutationId, client, transferBudget())).rejects.toThrow('QUOTA_EXCEEDED')
  expect((await outbox.read(pending.mutationId)).request).toBe(JSON.stringify(pending))
  expect(await database.encryptedRevisions.get(waiting.revisionId)).toEqual(waiting)
  for (const original of protectedOriginals) expect(await database.encryptedRevisions.get(original.revisionId)).toEqual(original)
  await f.db.prepare('UPDATE accounts SET capacity_bytes=? WHERE id=?').bind(originalCapacity, signed.accountId).run()
  const preview = await previewCleanup(principal, candidate, context)
  expect(preview.eligible).toBe(true)
  expect((await executeCleanup(principal, preview, context)).releasedBytes).toBeGreaterThan(0)
  expect((await previewCleanup(principal, seed, context)).reasons).toContain('protected')
  for (const original of protectedOriginals) expect(await database.encryptedRevisions.get(original.revisionId)).toEqual(original)
  expect(await client.revision(candidate.revisionId)).toEqual(record.descriptor)
  await expect(client.chunk(record.revisionId, 0)).rejects.toThrow('NOT_FOUND')
}, 30_000)
it('resumes the original unaccepted command after real expired staging cleanup', async () => {
  const { stageAccountBytes } = await import('../../src/workspace/account-cache')
  const { SyncError } = await import('../../src/account/sync/client')
  const f = await fixture(), signed = await customer(f, 'interrupted'), { principal } = await direct(f, signed)
  const token = installProfile(signed.accountId, crypto.getRandomValues(new Uint8Array(32)), {
    ...principal,
    csrf: signed.csrf,
    username: 'synthetic'
  })
  database = new AccountDatabase(token.accountId)
  const record = await stageAccountBytes(database, token, new TextEncoder().encode('Immutable interrupted bytes'), [])
  await database.encryptedRevisions.add(record)
  const outbox = new EncryptedOutbox(database, token), client = new SyncClient(token, new AbortController().signal)
  const request = {
    version: 1,
    mutationId: accountLocalId(),
    revisions: [
      record.descriptor
    ],
    heads: [
      {
        documentId: record.descriptor.documentId,
        revisionId: record.revisionId
      }
    ],
    expected: [
      {
        documentId: record.descriptor.documentId,
        revisionId: null
      }
    ]
  }
  const starts = [], chunks = [], commands = []
  let interrupt = true
  vi.stubGlobal('fetch', async (path, init) => {
    if (path.endsWith('/uploads')) starts.push(init.body)
    if (path.includes('/chunks/') && init.method === 'PUT') chunks.push(init.body.slice())
    if (path.endsWith('/commits')) {
      commands.push(init.body)
      if (interrupt) {
        interrupt = false
        throw new SyncError('SERVICE_UNAVAILABLE')
      }
    }
    const headers = new Headers(init.headers)
    headers.set('cookie', signed.headers.cookie)
    headers.set('origin', 'http://127.0.0.1')
    return f.request(path, {
      ...init,
      headers
    })
  })
  await outbox.prepare(request)
  await expect(outbox.advance(request.mutationId, client, transferBudget())).rejects.toThrow('SERVICE_UNAVAILABLE')
  const generation = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id=?').bind(record.descriptor.uploadId).first('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at=0 WHERE id=?').bind(generation).run()
  await f.runJobs()
  expect(await f.db.prepare('SELECT state FROM storage_generations WHERE id=?').bind(generation).first('state')).toBe('closed')
  let receipt
  for (let step = 0; step < 4 && !receipt; step++) receipt = await outbox.advance(request.mutationId, client, transferBudget())
  expect(receipt?.mutationId).toBe(request.mutationId)
  expect(new Set(commands).size).toBe(1)
  expect(starts).toEqual([
    starts[0],
    starts[0]
  ])
  expect(chunks).toEqual([
    chunks[0],
    chunks[0]
  ])
})
