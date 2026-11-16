import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, stageAccountBytes } from '../workspace/account-cache'
import { createAccountPreparationOwner } from '../workspace/account-prepared-records'
import { cleanupAccountPreparations, holdAccountPreparation } from '../workspace/account-preparation-registry'

let database: AccountDatabase | undefined
// Deterministic lock scheduler models only the two requested modes; native realm release is a browser test
function lockManager() {
  const held = new Map<string, number>()
  return { request: vi.fn(async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    if (options.mode === 'exclusive' && held.has(name)) return callback(null)
    held.set(name, (held.get(name) ?? 0) + 1)
    try { return await callback({ name, mode: options.mode } as Lock) }
    finally { const next = held.get(name)! - 1; if (next) held.set(name, next); else held.delete(name) }
  }) } as unknown as LockManager
}
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined; vi.unstubAllGlobals() })

it('cleans only exact abandoned reservations after both shared owners release', async () => {
  vi.stubGlobal('navigator', { locks: lockManager() })
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  const operationId = accountLocalId()
  const main = await holdAccountPreparation(token, operationId)
  const worker = await holdAccountPreparation(token, operationId)
  const owner = createAccountPreparationOwner(database, token, worker)
  const record = await stageAccountBytes(database, token, new Uint8Array([1]), [], undefined, owner)
  const legacy = await stageAccountBytes(database, token, new Uint8Array([2]), [])
  await owner.abandon()
  expect(() => owner.check()).toThrow()
  expect(await database.preparationPayloads.count()).toBe(1)
  expect(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()).toBe(1)
  expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 0, active: 1, pending: 0 })
  await worker.release()
  expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 0, active: 1, pending: 0 })
  await main.release()
  expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 1, active: 0, pending: 0 })
  expect(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()).toBe(0)
  expect(await database.stagedCipherChunks.where('payloadId').equals(legacy.payloadId).count()).toBe(1)
  expect(await database.preparationPayloads.count()).toBe(0)
})

it('preserves installed ciphertext after a lost acknowledgment and retries cleanup rollback', async () => {
  vi.stubGlobal('navigator', { locks: lockManager() })
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  const lease = await holdAccountPreparation(token, accountLocalId())
  const owner = createAccountPreparationOwner(database, token, lease)
  const record = await stageAccountBytes(database, token, new Uint8Array([3]), [], undefined, owner)
  await database.encryptedRevisions.add(record)
  await lease.release()
  const { IDBObjectStore } = await import('fake-indexeddb')
  const remove = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => { throw new Error('synthetic storage failure') })
  try { expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 0, active: 0, pending: 1 }) }
  finally { remove.mockRestore() }
  expect(await database.preparationPayloads.count()).toBe(1)
  expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 0, active: 0, pending: 0 })
  expect(await database.encryptedRevisions.get(record.revisionId)).toEqual(record)
  expect(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()).toBe(1)
})

it('preserves every old table and row through the additive v2 upgrade', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  const old = new Dexie(`crykit-account-v1-${token.accountId}`)
  old.version(1).stores({ stagedCipherChunks: '[payloadId+index], payloadId', encryptedRevisions: 'revisionId, payloadId', documentHeads: 'documentId', outbox: 'id', conflicts: 'id', profileMeta: 'key', migrationJournal: 'id' })
  old.version(2).stores({ syncState: 'id' })
  await old.open()
  const reference = { documentId: accountLocalId(), revisionId: accountLocalId() }
  const fixtures: Record<string, unknown> = {
    stagedCipherChunks: { payloadId: accountLocalId(), index: 0, bytes: new Uint8Array([13, 27]) },
    encryptedRevisions: { revisionId: reference.revisionId, payloadId: accountLocalId(), descriptor: { retainedUnknown: 'legacy synthetic shape' } },
    documentHeads: reference, outbox: { id: accountLocalId(), ref: reference, status: 'unmapped-local' },
    conflicts: { id: accountLocalId(), retainedUnknown: null }, profileMeta: { key: 'active', headRevision: 9, head: reference },
    migrationJournal: { id: accountLocalId(), localStatus: 'active', retainedUnknown: 'preserve' }, syncState: { id: 'synthetic-old-row', ref: reference },
  }
  for (const [table, row] of Object.entries(fixtures)) await old.table(table).add(row)
  const before = await Promise.all(old.tables.map(async table => [table.name, await table.toArray()] as const))
  old.close()
  database = new AccountDatabase(token.accountId)
  await database.open()
  for (const [name, rows] of before) expect(await database.table(name).toArray()).toEqual(rows)
  expect(await database.preparationPayloads.count()).toBe(0)
  await database.preparationPayloads.add({ operationId: accountLocalId(), payloadId: 'A'.repeat(22) })
  await expect(database.preparationPayloads.add({ operationId: accountLocalId(), payloadId: 'A'.repeat(22) })).rejects.toThrow()
})

it('admits only existing exact v3 worker storage without creating, upgrading, or silently reopening newer layouts', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId, { existingOnly: true })
  await expect(database.open()).rejects.toThrow()
  expect(await Dexie.exists(database.name)).toBe(false)
  const old = new Dexie(database.name)
  old.version(2).stores({ syncState: 'id' })
  await old.open(); old.close()
  await expect(database.open()).rejects.toThrow(/unsupported/)
  const inspect = new Dexie(database.name)
  await inspect.open()
  expect(inspect.verno).toBe(2)
  expect(inspect.tables.map(table => table.name)).toEqual(['syncState'])
  inspect.close()
  await database.delete()
  database = new AccountDatabase(token.accountId)
  await database.open(); database.close()
  const worker = new AccountDatabase(token.accountId, { existingOnly: true })
  await worker.open()
  expect(await worker.preparationPayloads.count()).toBe(0)
  worker.close()
  await expect(worker.preparationPayloads.count()).rejects.toThrow()
  const newer = new Dexie(database.name)
  newer.version(4).stores({ unknownFormat: 'id' })
  await newer.open(); newer.close()
  await expect(worker.open()).rejects.toThrow(/unsupported/)
})

it('fails closed without Web Locks and never reserves before the shared grant', async () => {
  vi.stubGlobal('navigator', {})
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  await expect(holdAccountPreparation(token, accountLocalId())).rejects.toThrow('SIGNIN_COORDINATION_UNAVAILABLE')
  expect(await database.preparationPayloads.count()).toBe(0)
  vi.stubGlobal('navigator', { locks: lockManager() })
  const lease = await holdAccountPreparation(token, accountLocalId())
  lease.check()
  await lease.release()
  expect(() => lease.check()).toThrow('SIGNIN_PREPARATION_RELEASED')
  expect(await database.preparationPayloads.count()).toBe(0)
})

it('allows one cleaner to reclaim abandoned payloads while a competing cleaner skips ownership', async () => {
  vi.stubGlobal('navigator', { locks: lockManager() })
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  const lease = await holdAccountPreparation(token, accountLocalId())
  const owner = createAccountPreparationOwner(database, token, lease)
  await stageAccountBytes(database, token, new Uint8Array([9]), [], undefined, owner)
  await lease.release()
  const results = await Promise.all([cleanupAccountPreparations(database, token), cleanupAccountPreparations(database, token)])
  expect(results.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1)
  expect(results.every(result => result.pending === 0)).toBe(true)
  expect(await database.preparationPayloads.count()).toBe(0)
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('reports malformed reservation identities as pending without deleting their chunks', async () => {
  vi.stubGlobal('navigator', { locks: lockManager() })
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  const payloadId = accountLocalId()
  await database.preparationPayloads.add({ operationId: 'malformed', payloadId })
  await database.stagedCipherChunks.add({ payloadId, index: 0, bytes: new Uint8Array([1]) })
  expect(await cleanupAccountPreparations(database, token)).toEqual({ cleaned: 0, active: 0, pending: 1 })
  expect(await database.preparationPayloads.count()).toBe(1)
  expect(await database.stagedCipherChunks.count()).toBe(1)
})

it('rolls back a failed additive upgrade without replacing old recovery rows', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  database = new AccountDatabase(token.accountId)
  const old = new Dexie(database.name)
  old.version(1).stores({ stagedCipherChunks: '[payloadId+index], payloadId', encryptedRevisions: 'revisionId, payloadId', documentHeads: 'documentId', outbox: 'id', conflicts: 'id', profileMeta: 'key', migrationJournal: 'id' })
  old.version(2).stores({ syncState: 'id' })
  await old.table('syncState').add({ id: 'old-pending-copy', ref: { documentId: accountLocalId(), revisionId: accountLocalId() } })
  const row = await old.table('syncState').get('old-pending-copy')
  old.close()
  database.version(3).upgrade(() => { throw new Error('synthetic upgrade interruption') })
  await expect(database.open()).rejects.toThrow('synthetic upgrade interruption')
  const inspect = new Dexie(database.name)
  try {
    await inspect.open()
    expect(inspect.verno).toBe(2)
    expect(inspect.tables.some(table => table.name === 'preparationPayloads')).toBe(false)
    expect(await inspect.table('syncState').get('old-pending-copy')).toEqual(row)
  } finally { inspect.close() }
})

it('refuses a malformed same-version layout without modifying its existing rows', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), malformed = new Dexie(`crykit-account-v1-${token.accountId}`)
  malformed.version(3).stores({ syncState: 'id', preparationPayloads: '[operationId+payloadId], operationId, payloadId' })
  await malformed.table('syncState').add({ id: 'keep', unknown: [1, 2, 3] }); malformed.close()
  database = new AccountDatabase(token.accountId, { existingOnly: true })
  await expect(database.open()).rejects.toThrow(/unsupported/)
  const inspect = new Dexie(database.name); await inspect.open()
  expect(await inspect.table('syncState').toArray()).toEqual([{ id: 'keep', unknown: [1, 2, 3] }]); inspect.close()
})

it('cancels a pending lock acquisition without granting or reserving ownership', async () => {
  vi.stubGlobal('navigator', { locks: { request: (_name: string, options: LockOptions) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })) } })
  const token = installProfile(accountLocalId(), new Uint8Array(32)); database = new AccountDatabase(token.accountId)
  const controller = new AbortController(), pending = holdAccountPreparation(token, accountLocalId(), controller.signal)
  const rejected = expect(pending).rejects.toThrow(); controller.abort(); await rejected
  expect(await database.preparationPayloads.count()).toBe(0)
})
