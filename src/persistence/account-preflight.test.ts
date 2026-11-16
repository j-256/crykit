import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, type ProfileToken } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { AccountDatabase } from './account-database'
import { openAccountRepository } from '../workspace/account-repository'
import { initializeAccountWorkspace } from '../workspace/account-initialization'
import * as stores from '../workspace/account-local-store'
import * as payload from '../domain/source-fulfillment'
import * as codec from '../workspace/catalog-codec'
import { workspace } from '../workspace/signin-merge.test-helpers'
import { createBlankLocalData } from '../domain/local-data'

let token: ProfileToken, database: AccountDatabase
beforeEach(() => { token = installProfile(accountLocalId(), new Uint8Array(32)); database = new AccountDatabase(token.accountId) })
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database.delete() })
const dump = async () => Object.fromEntries(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()])))

it.each(['cancel', 'profile'] as const)('rejects %s retirement during fresh preflight before creating durable account state', async mode => {
  const signal = new AbortController(), prepare = payload.prepareSourcePayloadValidation
  vi.spyOn(payload, 'prepareSourcePayloadValidation').mockImplementation(async (catalog, check) => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (mode === 'cancel') signal.abort(new Error('synthetic cancellation'))
    else invalidateProfile()
    return prepare(catalog, check)
  })
  const before = await dump()
  await expect(openAccountRepository(token, signal.signal)).rejects.toThrow()
  expect(await dump()).toEqual(before)
})

it.each(['staging', 'activation'] as const)('cancels during %s and disposes private staging without selecting or publishing a head', async phase => {
  const signal = new AbortController(), create = stores.createAccountLocalStore, disposed = vi.fn()
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args), stage = store.adapter.stage, activate = store.prepareActivation
    if (phase === 'staging') store.adapter.stage = async (...input) => { const result = await stage(...input); signal.abort(new Error('synthetic cancellation')); return result }
    else store.prepareActivation = async (...input) => { const result = await activate(...input); signal.abort(new Error('synthetic cancellation')); return result }
    return { ...store, async dispose() { disposed(); await store.dispose() } }
  })
  const before = await dump()
  await expect(openAccountRepository(token, signal.signal)).rejects.toThrow('synthetic cancellation')
  expect(disposed).toHaveBeenCalledOnce()
  expect(await dump()).toEqual(before)
})

it.each(['preflight', 'staging'] as const)('retains a concurrent winner selected during %s', async phase => {
  let winner: Awaited<ReturnType<typeof initializeAccountWorkspace>> | undefined, before: Awaited<ReturnType<typeof dump>> | undefined, installing = false
  const installWinner = async () => {
    if (winner || installing) return
    installing = true
    winner = await initializeAccountWorkspace(database, token, workspace(createBlankLocalData()))
    before = await dump()
  }
  if (phase === 'preflight') {
    const prepare = codec.prepareCatalogPayload
    vi.spyOn(codec, 'prepareCatalogPayload').mockImplementation(async (...args) => { await installWinner(); return prepare(...args) })
  } else {
    const create = stores.createAccountLocalStore
    vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
      const store = create(...args), stage = store.adapter.stage
      store.adapter.stage = async (...input) => { await installWinner(); return stage(...input) }
      return store
    })
  }
  const repository = await openAccountRepository(token)
  expect(repository).toBeDefined()
  expect(await database.profileMeta.get('active')).toEqual(winner)
  expect(await dump()).toEqual(before)
})
