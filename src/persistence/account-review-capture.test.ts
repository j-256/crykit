import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi, type MockInstance } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import * as capture from '../workspace/account-sync-capture'
import * as mapping from '../workspace/account-local-mapping'
import * as stores from '../workspace/account-local-store'
import { editorClosureFixture } from '../workspace/test-helpers'
import { seedManagedWorkspace, prepareManagedSync } from './managed-sync.test-helpers'

let database: AccountDatabase | undefined
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); invalidateProfile(); await database?.delete() })
async function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const { state } = await editorClosureFixture()
  await seedManagedWorkspace(database, token, state)
  await prepareManagedSync(database, token)
  return { token, database, fence: (await database.profileMeta.get('active'))! }
}

it('review capture omits publication authority and conversion while eager sync still resolves it', async () => {
  const input = await fixture()
  const association = vi.spyOn(mapping, 'readIncrementalAccountEvidence')
  const conversion = vi.spyOn(mapping, 'ensureIncrementalAccountEvidence')
  const review = await capture.captureAccountReviewWorkspace(input.database, input.token, input.fence)
  cleanup.push(() => review.dispose())
  expect(association).not.toHaveBeenCalled()
  expect(conversion).not.toHaveBeenCalled()
  expect(Object.hasOwn(review, 'inheritedEvidence')).toBe(false)
  expect(Object.hasOwn(review, 'publicationValidatedEvidence')).toBe(false)
  // The review API cannot be mistaken for the complete local publication archive
  // @ts-expect-error Review capture deliberately omits publication archive authority
  expect(review.inheritedEvidence).toBeUndefined()
  // @ts-expect-error Review capture deliberately omits publication proof authority
  expect(review.publicationValidatedEvidence).toBeUndefined()
  const eager = await capture.captureAccountSyncWorkspace(input.database, input.token, input.fence)
  cleanup.push(() => eager.dispose())
  expect(association).toHaveBeenCalled()
  expect(conversion).toHaveBeenCalledExactlyOnceWith(input.database, input.token, expect.anything(), expect.anything(), expect.any(Function), expect.any(Function))
  expect(Object.hasOwn(eager, 'inheritedEvidence')).toBe(true)
  expect(review.workspace.head).toEqual(eager.workspace.head)
  expect(review.operativePlanner).toEqual(eager.operativePlanner)
})

it.each(['before', 'during'] as const)('review admission rejects a changed fence %s capture and releases its store', async when => {
  const input = await fixture()
  const create = stores.createAccountLocalStore, disposals: MockInstance<() => Promise<void>>[] = []
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    disposals.push(vi.spyOn(store, 'dispose'))
    return store
  })
  const change = () => input.database.profileMeta.put({ ...input.fence, headRevision: input.fence.headRevision + 1 })
  if (when === 'before') await change()
  else {
    const read = mapping.readIncrementalMappedRoot
    vi.spyOn(mapping, 'readIncrementalMappedRoot').mockImplementationOnce(async (...args) => { const root = await read(...args); await change(); return root })
  }
  await expect(capture.captureAccountReviewWorkspace(input.database, input.token, input.fence)).rejects.toThrow('LOCAL_REVISION_CONFLICT')
  expect(disposals).toHaveLength(1)
  expect(disposals[0]).toHaveBeenCalledOnce()
})

it('eager conversion failure still releases the captured local owner', async () => {
  const input = await fixture(), create = stores.createAccountLocalStore
  const disposed = vi.fn()
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    const dispose = store.dispose
    vi.spyOn(store, 'dispose').mockImplementation(async () => { disposed(); await dispose() })
    return store
  })
  vi.spyOn(mapping, 'ensureIncrementalAccountEvidence').mockRejectedValueOnce(new Error('conversion interrupted'))
  await expect(capture.captureAccountSyncWorkspace(input.database, input.token, input.fence)).rejects.toThrow('conversion interrupted')
  expect(disposed).toHaveBeenCalledOnce()
})

it('eager capture retries a failed store release before cleanup has occurred', async () => {
  const input = await fixture(), create = stores.createAccountLocalStore
  const attempts = vi.fn(), completed = vi.fn()
  let fail = true
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    const dispose = store.dispose
    // Eager conversion requires the issued store object before this cleanup can run
    vi.spyOn(store, 'dispose').mockImplementation(async () => {
      attempts()
      if (fail) { fail = false; throw new Error('store cleanup unavailable') }
      await dispose()
      completed()
    })
    return store
  })
  const captured = await capture.captureAccountSyncWorkspace(input.database, input.token, input.fence)
  cleanup.push(() => captured.dispose())
  await expect(captured.dispose()).rejects.toThrow('store cleanup unavailable')
  expect(completed).not.toHaveBeenCalled()
  await expect(captured.dispose()).resolves.toBeUndefined()
  expect(attempts).toHaveBeenCalledTimes(2)
  expect(completed).toHaveBeenCalledOnce()
})
