import './guest-managed-monitor.test-helpers'
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { encodeCrystalSave } from '../interchange/crystal-save'
import { createSaveEditorFixture } from '../domain/save-editor.fixture'
import { setStock } from '../domain/save-editor/inventory'
import { quantity } from '../domain/save-editor/values'
import { full, openAppliedSaveOracle, selected } from '../../worker/testing/local-save-oracle'
import { localSaveWorkload, PERFORMANCE_SAVE_ID } from '../../worker/testing/local-save-workload'
import { accountLocalId } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { openAccountManagedRepository } from './account-managed-repository'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { openGuestManagedRepository } from './guest-managed-repository'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'
import { newOwnedFileCommand, resolveOwnedFileReceipt } from './owned-file-command'
import type { WorkspaceRepository } from './repository'
import { createSaveRepository, readSaveContent } from './save-repository'
import { emptySavePending, savePendingJson } from './save-input-controller'

const applyForm = savePendingJson(emptySavePending())
const successorForm = savePendingJson({ ...emptySavePending(), fields: { 'item:0': '4' } })
const unguarded = { check() {}, async assertCurrent() {} }

async function applyInventory(repository: WorkspaceRepository) {
  let active = repository
  const saves = (intent: 'saveApply' | 'savePending') => createSaveRepository(active, {
    begin(operation) {
      expect(operation).toBe(intent)
      return newOwnedFileCommand(operation)
    },
    async onOutcome(outcome) {
      expect(outcome.status).toBe('saved')
      active = (await resolveOwnedFileReceipt(outcome.receipt!)).repository
    },
  })
  const original = (await repository.readWorkspace()).saveDocuments.find(file => file.id === PERFORMANCE_SAVE_ID)!
  const native = createSaveEditorFixture()
  setStock(native, 'item', 0, 3)
  const bytes = encodeCrystalSave(native)
  const saved = await saves('saveApply').saveWorking(original.id, bytes, applyForm, original.revision)
  return {
    original, saved,
    async pendingSuccessor() {
      const successor = await saves('savePending').saveWorking(original.id, bytes, successorForm, saved.revision)
      expect(successor.revision).toBe(saved.revision + 1)
      expect(successor.working).toEqual(saved.working)
      const state = await active.readWorkspace()
      expect((await readSaveContent(state, successor)).workingBytes).toEqual(bytes)
      expect(state.retainedContent.some(entry => entry.kind === 'file-history' && entry.retention === 'protected')).toBe(true)
      return successor
    },
  }
}

async function accountFixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  const operation = accountLocalId()
  try {
    const prepared = await prepareLocalWorkspace(store.adapter, operation, await localSaveWorkload(false), store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined))
    store.committed(operation)
  } finally { await store.dispose() }
  const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
  return { database, token, repository }
}

async function seedGuest(database: GuestCoordinatorDatabase) {
  const store = createGuestLocalStore(database, unguarded.check)
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', await localSaveWorkload(false), unguarded)
  const receipt = await store.activate('initial', prepared.head, undefined, unguarded.check)
  return openGuestManagedRepository(database, receipt.target)
}

async function assertApply(oracle: Awaited<ReturnType<typeof openAppliedSaveOracle>>, attempt: number, apply: Awaited<ReturnType<typeof applyInventory>>) {
  const { file, native } = await oracle.read(attempt)
  expect(file).toMatchObject({ revision: apply.original.revision + 1, pendingForm: applyForm, original: apply.original.original, working: apply.saved.working })
  expect(quantity(native!, 'item', 0)).toBe(3)
}

for (const mode of ['account', 'guest'] as const) it(`authenticates the captured ${mode} Apply while the old current-head read rejects a real pending successor`, async () => {
  const guest = mode === 'guest' ? new GuestCoordinatorDatabase() : undefined
  const account = mode === 'account' ? await accountFixture() : undefined
  let oracle: Awaited<ReturnType<typeof openAppliedSaveOracle>> | undefined
  try {
    const repository = guest ? await seedGuest(guest) : account!.repository
    oracle = await openAppliedSaveOracle(account?.token)
    const attempt = oracle.begin()
    const apply = await applyInventory(repository)
    oracle.capture(attempt)
    let entered!: () => void, release!: () => void
    const enteredBarrier = new Promise<void>(resolve => { entered = resolve })
    const releaseBarrier = new Promise<void>(resolve => { release = resolve })
    const oldRead = selected(account?.token, async (adapter, head) => {
      entered()
      await releaseBarrier
      const admitted = await admitLocalRoot(adapter, head, unguarded)
      expect(admitted.state.saveDocuments[0]).toEqual(apply.saved)
    })
    let successor
    try {
      await enteredBarrier
      successor = await apply.pendingSuccessor()
    } finally { release() }
    await expect(oldRead).rejects.toThrow(mode === 'account' ? 'Account head changed during oracle' : 'Guest head changed during oracle')
    expect((await full(account?.token)).saveDocuments).toContainEqual(successor)
    await assertApply(oracle, attempt, apply)
  } finally {
    oracle?.close()
    account?.database.close()
    guest?.close()
    invalidateProfile()
    if (guest) await guest.delete()
  }
}, 30_000)

for (const target of ['Apply', 'successor'] as const) it(`fails only the oracle whose encrypted ${target} root is corrupt`, async () => {
  const { database, token, repository } = await accountFixture()
  const oracle = await openAppliedSaveOracle(token)
  try {
    const attempt = oracle.begin()
    const apply = await applyInventory(repository)
    oracle.capture(attempt)
    const applied = (await database.profileMeta.get('active'))!
    const successor = await apply.pendingSuccessor()
    const current = (await database.profileMeta.get('active'))!
    expect(current.head).not.toEqual(applied.head)
    const { payloadId } = (await database.encryptedRevisions.get((target === 'Apply' ? applied : current).head.revisionId))!
    const chunk = (await database.stagedCipherChunks.get([payloadId, 0]))!
    chunk.bytes[chunk.bytes.length - 1] ^= 1
    await database.stagedCipherChunks.put(chunk)
    if (target === 'Apply') {
      expect((await full(token)).saveDocuments).toContainEqual(successor)
      await expect(oracle.read(attempt)).rejects.toMatchObject({ code: 'LOCAL_INTEGRITY_FAILED' })
    } else {
      await expect(full(token)).rejects.toMatchObject({ code: 'LOCAL_INTEGRITY_FAILED' })
      await assertApply(oracle, attempt, apply)
    }
  } finally { oracle.close(); database.close(); invalidateProfile() }
}, 30_000)

it('rejects a malformed captured guest manifest even after the valid manifest returns', async () => {
  const database = new GuestCoordinatorDatabase()
  let oracle: Awaited<ReturnType<typeof openAppliedSaveOracle>> | undefined
  try {
    const repository = await seedGuest(database)
    oracle = await openAppliedSaveOracle(undefined)
    const attempt = oracle.begin()
    const apply = await applyInventory(repository)
    const active = (await database.active.get('active'))!
    const unchecked = database.table<{ key: 'active'; manifest: unknown }, string>('active')
    await unchecked.put({ ...active, manifest: { ...active.manifest, version: 0 } })
    oracle.capture(attempt)
    await database.active.put(active)
    expect((await full(undefined)).saveDocuments).toContainEqual(apply.saved)
    await expect(oracle.read(attempt)).rejects.toBeInstanceOf(ZodError)
  } finally {
    oracle?.close()
    invalidateProfile()
    database.close()
    await database.delete()
  }
}, 30_000)

it('rejects a captured encrypted Apply after its profile retires', async () => {
  const { database, token, repository } = await accountFixture()
  const oracle = await openAppliedSaveOracle(token)
  try {
    const attempt = oracle.begin()
    await applyInventory(repository)
    oracle.capture(attempt)
    invalidateProfile()
    await expect(oracle.read(attempt)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { oracle.close(); database.close(); invalidateProfile() }
}, 30_000)

it('enqueues one native fence read immediately and rejects missing, stale, aborted and consumed attempts', async () => {
  const { database, token, repository } = await accountFixture()
  const oracle = await openAppliedSaveOracle(token)
  try {
    const missing = oracle.begin()
    await expect(oracle.read(missing)).rejects.toThrow('Missing Save Apply fence capture')
    const first = oracle.begin()
    const apply = await applyInventory(repository)
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
    const get = vi.spyOn(IDBObjectStore.prototype, 'get')
    try {
      oracle.capture(first)
      oracle.capture(first)
      expect(transaction.mock.calls).toEqual([['profileMeta', 'readonly']])
      expect(get.mock.calls).toEqual([['active']])
    } finally { get.mockRestore(); transaction.mockRestore() }

    const second = oracle.begin()
    expect(second).not.toBe(first)
    await expect(oracle.read(first)).rejects.toThrow('Stale Save Apply attempt')
    oracle.capture(second)
    await assertApply(oracle, second, apply)
    await expect(oracle.read(second)).rejects.toThrow('Missing Save Apply fence capture')

    const aborted = oracle.begin()
    const nativeTransaction = IDBDatabase.prototype.transaction
    const abort = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args) {
      const transaction = nativeTransaction.apply(this, args)
      queueMicrotask(() => transaction.abort())
      return transaction
    })
    try { oracle.capture(aborted) } finally { abort.mockRestore() }
    await expect(oracle.read(aborted)).rejects.toThrow('Save Apply fence read aborted')
    oracle.close()
    await expect(oracle.read(aborted)).rejects.toThrow('Save Apply oracle is closed')
  } finally { oracle.close(); database.close(); invalidateProfile() }
}, 30_000)
