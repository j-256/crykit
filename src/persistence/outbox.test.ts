import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { stageAccountBytes } from '../workspace/account-cache'
import { EncryptedOutbox, transferBudget } from '../account/sync/outbox'
import type { SyncClient } from '../account/sync/client'
import type { CommitRequest, UploadStart } from '../account/protocol'

const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined })
it('persistsExactContinuationBeforeSchedulingAndDoesNotResetItsIncarnationOnRestart', async () => {
  const { commitRequestDigest } = await import('../account/sync/commit-progress')
  const { SyncError } = await import('../account/sync/client')
  const token = installProfile(accountId, new Uint8Array(32).fill(7))
  database = new AccountDatabase(accountId)
  const record = await stageAccountBytes(database, token, new Uint8Array([7]), [])
  await database.encryptedRevisions.add(record)
  const input: CommitRequest = { version: 1, mutationId: 'BBBBBBBBBBBBBBBBBBBBBA', revisions: [record.descriptor], heads: [], expected: [] }
  const initial = { mutationId: input.mutationId, requestDigest: await commitRequestDigest(JSON.stringify(input)), workId: 'CCCCCCCCCCCCCCCCCCCCCA', expiresAt: Date.now() + 60_000, processed: 48 }
  let continuation = initial, accepted = false, calls = 0
  const receipt = { version: 1 as const, mutationId: input.mutationId, sequence: 1, publicationEpoch: 0, heads: [] }
  const client = {
    receipt: async () => accepted ? receipt : null,
    startUpload: async (value: UploadStart) => ({ uploadId: value.uploadId }), putChunk: async () => {}, finishUpload: async (uploadId: string) => ({ uploadId }),
    commit: async (request: CommitRequest) => { expect(request).toEqual(input); calls++; throw Object.assign(new SyncError('SERVICE_UNAVAILABLE', 1000), { continuation }) },
  } as unknown as SyncClient
  let outbox = new EncryptedOutbox(database, token)
  await outbox.prepare(input)
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toMatchObject({ message: 'COMMIT_CONTINUING', retryAfterMs: 1000 })
  expect((await outbox.read(input.mutationId))!.continuation).toEqual(initial)
  database.close(); database = new AccountDatabase(accountId); outbox = new EncryptedOutbox(database, token)
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('SERVICE_UNAVAILABLE')
  continuation = { ...initial, processed: 96 }
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('COMMIT_CONTINUING')
  continuation = { ...continuation, workId: 'DDDDDDDDDDDDDDDDDDDDDA', processed: 144 }
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect((await outbox.read(input.mutationId))!.continuation).toEqual({ ...initial, processed: 96 })
  accepted = true
  expect(await outbox.advance(input.mutationId, client, transferBudget())).toEqual(receipt)
  expect(calls).toBe(4)
})
it('restartRetriesSavedCiphertextAndMutationIdentity', async () => {
  const token = installProfile(accountId, new Uint8Array(32).fill(7))
  database = new AccountDatabase(accountId)
  const record = await stageAccountBytes(database, token, new TextEncoder().encode('private durable original'), [])
  await database.encryptedRevisions.add(record)
  const input: CommitRequest = { version: 1, mutationId: 'BBBBBBBBBBBBBBBBBBBBBA', revisions: [record.descriptor], heads: [], expected: [] }
  const outbox = new EncryptedOutbox(database, token)
  await outbox.prepare(input)
  const starts: UploadStart[] = [], chunks: Uint8Array[] = [], mutations: CommitRequest[] = []
  const receipt = { version: 1 as const, mutationId: input.mutationId, sequence: 1, publicationEpoch: 0, heads: [] }
  let committed = false
  const client = {
    receipt: async () => committed ? receipt : null,
    startUpload: async (value: UploadStart) => { starts.push(value); return { version: 1 as const, uploadId: value.uploadId, expiresAt: 100 } },
    putChunk: async (_id: string, _index: number, bytes: Uint8Array) => { chunks.push(bytes.slice()) },
    finishUpload: async (id: string) => ({ version: 1 as const, uploadId: id, expiresAt: 100 }),
    commit: async (value: CommitRequest) => { mutations.push(value); committed = true; throw new TypeError('lost response') },
  } as unknown as SyncClient
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('lost response')
  database.close()
  database = new AccountDatabase(accountId)
  const reopened = new EncryptedOutbox(database, token)
  expect(await reopened.advance(input.mutationId, client, transferBudget())).toEqual(receipt)
  expect(mutations).toEqual([input])
  expect(chunks).toEqual([(await database.stagedCipherChunks.get([record.payloadId, 0]))!.bytes])
  expect(starts).toHaveLength(1)
  expect((await reopened.read(input.mutationId))!.request).toBe(JSON.stringify(input))
  expect((await reopened.read(input.mutationId))!.receipt).toEqual(receipt)
  const raw = JSON.stringify(await database.syncState.toArray())
  expect(raw).not.toContain('private durable original')
  expect(raw).not.toContain('metadataBytes')
})
it('neverTreatsUnmappedLocalPreparationAsTransport', async () => {
  const token = installProfile(accountId, new Uint8Array(32))
  database = new AccountDatabase(accountId)
  await database.outbox.add({ id: accountId, ref: { documentId: accountId, revisionId: accountId }, status: 'unmapped-local' })
  await expect(new EncryptedOutbox(database, token).assertMapped()).rejects.toThrow('UNMAPPED_LOCAL_INTENT')
})
it('yieldsAtSixteenChunksWithAtMostTwoConcurrentUploads', async () => {
  const token = installProfile(accountId, new Uint8Array(32).fill(9))
  database = new AccountDatabase(accountId)
  const records = []
  for (let index = 0; index < 17; index++) {
    const record = await stageAccountBytes(database, token, new Uint8Array([index]), [])
    await database.encryptedRevisions.add(record); records.push(record)
  }
  const input: CommitRequest = { version: 1, mutationId: 'CCCCCCCCCCCCCCCCCCCCCA', revisions: records.map(value => value.descriptor), heads: [], expected: [] }
  const outbox = new EncryptedOutbox(database, token)
  await outbox.prepare(input)
  let active = 0, maximum = 0, count = 0
  const client = {
    receipt: async () => null,
    startUpload: async (value: UploadStart) => { active++; maximum = Math.max(maximum, active); return { uploadId: value.uploadId } },
    putChunk: async () => { count++; await new Promise(resolve => setTimeout(resolve, 1)) },
    finishUpload: async (uploadId: string) => { active--; return { uploadId } },
    commit: async () => { throw new Error('The incomplete command must not commit') },
  } as unknown as SyncClient
  expect(await outbox.advance(input.mutationId, client, transferBudget())).toBeNull()
  expect(count).toBe(16)
  expect(maximum).toBe(2)
  expect((await outbox.read(input.mutationId))!.uploads.filter(value => value.ready)).toHaveLength(16)
})
it('profileSwitchDuringChunkUploadCannotPublishOutboxProgress', async () => {
  const token = installProfile(accountId, new Uint8Array(32).fill(9))
  database = new AccountDatabase(accountId)
  const record = await stageAccountBytes(database, token, new Uint8Array([1]), [])
  await database.encryptedRevisions.add(record)
  const input: CommitRequest = { version: 1, mutationId: 'DDDDDDDDDDDDDDDDDDDDDA', revisions: [record.descriptor], heads: [], expected: [] }
  const outbox = new EncryptedOutbox(database, token)
  await outbox.prepare(input)
  const before = await database.syncState.toArray()
  const client = {
    receipt: async () => null,
    startUpload: async (value: UploadStart) => ({ uploadId: value.uploadId }),
    putChunk: async () => { invalidateProfile(); installProfile('EEEEEEEEEEEEEEEEEEEEEA', new Uint8Array(32)) },
  } as unknown as SyncClient
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('PROFILE_CHANGED')
  expect(await database.syncState.toArray()).toEqual(before)
})
it('capturesProjectionAuthorityAtomicallyWhileRemoteCacheAdvancesAndRollsBackRacingLocalCommits', async () => {
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { stageAccountJson, cipherRef, accountLocalId } = await import('../workspace/account-cache')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const token = installProfile(accountId, new Uint8Array(32).fill(3))
  const repository = await openAccountRepository(token)
  database = new AccountDatabase(accountId)
  const first = await stageAccountJson(database, token, { captured: 'projection A' }, [])
  const later = await stageAccountJson(database, token, { captured: 'remote B' }, [])
  await database.encryptedRevisions.bulkAdd([first, later])
  await database.syncState.bulkPut([{ id: 'projection', ref: cipherRef(first) }, { id: 'remote', ref: cipherRef(later) }])
  const oldFence = (await database.profileMeta.get('active'))!
  // A valid native candidate reaches the stale-fence check instead of failing format admission
  const staleCandidate = await prepareAccountWorkspace(database, token, await repository.readWorkspace())
  const loaded = await repository.load()
  await repository.save({ ...loaded.localData, modSetup: { version: 1, state: 'skipped' } }, loaded.revision)
  const intent = (await database.outbox.toArray())[0]
  expect(intent.publicationBase).toEqual(cipherRef(first))
  await database.syncState.put({ id: 'projection', ref: cipherRef(later) })
  expect((await database.outbox.get(intent.id))!.publicationBase).toEqual(cipherRef(first))
  const before = await database.outbox.toArray()
  await expect(activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: oldFence, head: staleCandidate.head, intent: intent.ref, records: staleCandidate.records, intentStatus: 'mapped-local' })).rejects.toThrow('another tab')
  expect(await database.outbox.toArray()).toEqual(before)
  // Persisted pre-extension rows remain readable and never acquire a guessed publication parent
  await database.outbox.put({ id: intent.id, ref: intent.ref, status: intent.status })
  expect((await database.outbox.get(intent.id))!.publicationBase).toBeUndefined()
})

it.each(['auth', 'transport', 'malformed', 'mismatched'] as const)('preserves saved readiness when the revival probe is %s', async failure => {
  const { SyncError } = await import('../account/sync/client')
  const token = installProfile(accountId, new Uint8Array(32).fill(7))
  database = new AccountDatabase(accountId)
  const record = await stageAccountBytes(database, token, new TextEncoder().encode('Retained exact bytes'), [])
  await database.encryptedRevisions.add(record)
  const input: CommitRequest = { version: 1, mutationId: 'BBBBBBBBBBBBBBBBBBBBBA', revisions: [record.descriptor], heads: [], expected: [] }
  let probing = false
  const client = {
    receipt: async () => null, startUpload: async (value: UploadStart) => ({ uploadId: value.uploadId }), putChunk: async () => {},
    finishUpload: async (uploadId: string) => {
      if (!probing) return { uploadId }
      if (failure === 'auth') throw new SyncError('AUTH_REQUIRED', 0, undefined, true)
      if (failure === 'transport') throw new TypeError('offline')
      if (failure === 'malformed') throw new SyncError('INTEGRITY_FAILED')
      return { uploadId: 'wrong' }
    },
    commit: async () => { throw probing ? new SyncError('INTEGRITY_FAILED', 0, undefined, true) : new SyncError('SERVICE_UNAVAILABLE') },
  } as unknown as SyncClient
  const outbox = new EncryptedOutbox(database, token)
  await outbox.prepare(input)
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('SERVICE_UNAVAILABLE')
  const before = await outbox.read(input.mutationId)
  expect(before!.uploads[0].ready).toBe(true)
  probing = true
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow()
  expect(await outbox.read(input.mutationId)).toEqual(before)
})
