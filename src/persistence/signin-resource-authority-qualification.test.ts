import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase, type CipherRef } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, cipherRef } from '../workspace/account-cache'
import { stagePublicationJson, stagePublicationPages } from '../account/sync/publication'
import { writeSyncState } from '../account/sync/outbox'
import * as outbox from '../account/sync/outbox'
import type { RemoteState } from '../account/sync/pull'
import { resourceProjectionAuthority } from '../../worker/testing/signin-resource-qualification'

let database: AccountDatabase
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete() })
async function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const body = cipherRef(await stagePublicationJson(database, token, { synthetic: true }, []))
  await database.profileMeta.put({ key: 'active', headRevision: 1, head: body })
  const entries = [{ key: 'synthetic-unit', body, publication: body }]
  const write = async (overrides: Partial<RemoteState> = {}, units = entries, dependencies?: readonly CipherRef[]) => {
    const heads = await stagePublicationPages(database, token, 'local-remote-heads', [body], () => [])
    const index = await stagePublicationPages(database, token, 'local-effective-units', units, entry => [entry.body, entry.publication])
    const value: RemoteState = { version: 1, kind: 'remote-state', cursor: 'synthetic-cursor', watermark: 2, publicationEpoch: 3, heads, initialComplete: true, effective: { lineageId: 'synthetic-lineage', control: body, units: index }, ...overrides }
    for (const id of ['remote', 'projection']) await writeSyncState(database, token, id, value, await database.syncState.get(id), dependencies ?? [value.heads, ...(value.effective ? [value.effective.control, value.effective.units] : [])])
    return value
  }
  const value = await write()
  return { token, body, value, entries, write }
}

it('authenticates complete authority while permitting only cache page relocation', async () => {
  const { write } = await fixture()
  const before = await resourceProjectionAuthority()
  await write()
  const after = await resourceProjectionAuthority()
  expect(after.rows).not.toEqual(before.rows)
  expect(after.authority).toEqual(before.authority)
  expect(after.selected).toEqual(before.selected)
  const rows = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
  await resourceProjectionAuthority()
  expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(rows)
})

it('retains every nonlocator field and exact effective associations', async () => {
  const { write, value, body } = await fixture()
  const before = (await resourceProjectionAuthority()).authority
  for (const override of [
    { cursor: null }, { watermark: 4 }, { publicationEpoch: 5 }, { initialComplete: false }, { projectionPending: false },
    { effective: undefined }, { effective: { ...value.effective!, lineageId: 'other' } },
    { effective: { ...value.effective!, control: { ...body, revisionId: accountLocalId() } } },
  ]) {
    await write(override)
    expect((await resourceProjectionAuthority()).authority).not.toEqual(before)
  }
  await write({}, [{ key: 'changed-key', body, publication: { ...body, revisionId: accountLocalId() } }])
  expect((await resourceProjectionAuthority()).authority).not.toEqual(before)
})

it('rejects duplicate effective keys and header dependency mismatches', async () => {
  const { write, entries, token, body } = await fixture()
  await write({}, [...entries, ...entries])
  await expect(resourceProjectionAuthority()).rejects.toThrow('Duplicate resource effective unit')
  await write({}, entries, [])
  await expect(resourceProjectionAuthority()).rejects.toThrow('Resource sync header association changed')
  const heads = await stagePublicationPages(database, token, 'local-remote-heads', [body, body], () => [])
  await write({ heads })
  await expect(resourceProjectionAuthority()).rejects.toThrow('INTEGRITY_FAILED')
})

it('rejects absent rows and missing or corrupted authenticated pages', async () => {
  const { write, value } = await fixture()
  await database.encryptedRevisions.delete(value.heads.revisionId)
  await expect(resourceProjectionAuthority()).rejects.toThrow()
  const next = await write()
  const record = (await database.encryptedRevisions.get(next.effective!.units.revisionId))!
  const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await database.stagedCipherChunks.put({ ...chunk, bytes })
  await expect(resourceProjectionAuthority()).rejects.toThrow()
  await write()
  await database.syncState.delete('projection')
  await expect(resourceProjectionAuthority()).rejects.toThrow('Missing resource sync authority')
})

it.each(['row', 'fence', 'profile'] as const)('rejects a %s change during authenticated traversal', async change => {
  await fixture()
  const original = outbox.readSyncState
  let injected = false
  vi.spyOn(outbox, 'readSyncState').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (!injected) {
      injected = true
      if (change === 'profile') invalidateProfile()
      else if (change === 'fence') await database.profileMeta.update('active', { headRevision: 2 })
      else await database.syncState.put({ ...result!.row, ref: { ...result!.row.ref, revisionId: accountLocalId() } })
    }
    return result
  })
  await expect(resourceProjectionAuthority()).rejects.toThrow()
})
