import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invalidateProfile, installProfile, type ProfileToken } from '../account/profile'
import { AccountDatabase } from './account-database'
import { openAccountRepository, removeEncryptedAccountData } from '../workspace/account-repository'
import { createStorageService } from '../account/storage'
import { createPersonalDefinition } from '../domain'
// Removal guards need a closed synthetic workspace, not repeated bundled catalog admissions
// Full bundled startup and exact native migration are exercised by the browser acceptance producer
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))
let token: ProfileToken, database: AccountDatabase
beforeEach(() => { token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32))); database = new AccountDatabase(token.accountId) })
afterEach(async () => { invalidateProfile(); await database.delete() })
it('refuses removal when a local edit wins after the explicit review', async () => {
  const repo = await openAccountRepository(token), first = await repo.load(), fence = (await database.profileMeta.get('active'))!
  await repo.save(createPersonalDefinition(first.localData, { kind: 'item', name: 'Private retained test' }), first.revision)
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  await expect(removeEncryptedAccountData(token, fence)).rejects.toThrow('Saved data changed')
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
})
it('rechecks the draft guard inside the removal transaction and rolls back', async () => {
  const repo = await openAccountRepository(token); await repo.load()
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  let reads = 0
  await expect(removeEncryptedAccountData(token, (await database.profileMeta.get('active'))!, () => { if (++reads === 2) throw new Error('Draft opened') })).rejects.toThrow('Draft opened')
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
})
it('computes private categories only from the decrypted account and refuses stale profile reads', async () => {
  const repo = await openAccountRepository(token); await repo.load()
  const service = createStorageService(token, repo, async () => {}, () => {})
  const observed = await service.local()
  expect(observed.categories.some(value => value.label === 'Source originals')).toBe(true)
  expect(observed.observedAt).toBeGreaterThan(0)
  invalidateProfile()
  await expect(service.local()).rejects.toThrow()
})
