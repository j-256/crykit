import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { createGuestLocalStore } from '../workspace/guest-local-store'
import { GuestCoordinatorDatabase } from '../workspace/guest-coordinator'
import { prepareLocalWorkspace } from '../workspace/local-root'
import { progress } from '../workspace/signin-merge.test-helpers'
import { createSigninMergePreparation } from '../workspace/signin-merge-preparation'
import { captureManagedGuestSnapshot } from '../workspace/guest-managed-snapshot'
import { createReviewedReplacementService, stableWorkspaceSnapshotIdentity } from '../workspace/reviewed-replacement'
import { createSigninMergeClient, nativeMergeInstallationCheck } from '../workspace/signin-merge-client'
import { admitInstalledMerge } from '../workspace/account-local-store'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import type { SigninMergeFence, SigninMergeLocator, SigninMergeManifest, SigninMergeTicket } from '../workspace/signin-merge-protocol'

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await service?.dispose(); service = undefined; vi.unstubAllGlobals() })
function locks() {
  const held = new Map<string, number>()
  return { async request(name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) {
    options.signal?.throwIfAborted()
    if (options.mode === 'exclusive' && held.has(name)) return callback(null)
    held.set(name, (held.get(name) ?? 0) + 1)
    try { return await callback({ name, mode: options.mode } as Lock) }
    finally { const count = held.get(name)! - 1; if (count) held.set(name, count); else held.delete(name) }
  } }
}
async function fixture(conflict = false, native = false, locator = true, retained = false) {
  service = await conflictService()
  const device = await service.device(0, progress('account'))
  await device.settle()
  if (retained) {
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { ownWorkspaceSnapshot } = await import('../workspace/snapshot')
    const { createGuestCopyService } = await import('../workspace/guest-copy')
    const { LAUNCH_DATA_GENERATION } = await import('../domain/data-generation')
    const source = await editorClosureFixture()
    const state = { ...source.state, retainedContent: [], editorDocuments: [source.file], blobs: [source.blobs[0]] }
    const snapshot = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'installed-worker-original', capturedAt: '2026-11-16T00:00:00.000Z', revisionVector: {}, state }, { async check() {}, async dispose() {} })
    const copy = createGuestCopyService(async () => snapshot)
    try { await copy.commitGuestCopy(device.token, await copy.previewGuestCopy(device.token, ['["editor","editor-1"]'])) }
    finally { await copy.dispose() }
    await device.settle()
  }
  if (native) {
    const { prepareAccountWorkspace } = await import('../workspace/account-graph')
    const prepared = await prepareAccountWorkspace(device.db, device.token, progress('account'))
    await activateLocalAccountCommit(device.db, device.token, { version: 1, id: accountLocalId(), expected: await device.db.profileMeta.get('active'), head: prepared.head, records: prepared.records })
  }
  vi.stubGlobal('navigator', { locks: locks(), onLine: true })
  const guest = new GuestCoordinatorDatabase(`merge-worker-source-${crypto.randomUUID()}`)
  await guest.open()
  const store = createGuestLocalStore(guest, () => {}), id = crypto.randomUUID()
  const prepared = await prepareLocalWorkspace(store.adapter, id, progress('local', !conflict), { check() {}, async assertCurrent() {} })
  const { target: manifest } = await store.activate(id, prepared.head, undefined, () => {})
  const snapshot = await captureManagedGuestSnapshot(guest, manifest, () => {})
  cleanups.push(async () => { await disposeWorkspaceSnapshot(snapshot); await guest.delete() })
  const replacements = createReviewedReplacementService(device.db, device.token), review = await replacements.refresh()
  cleanups.push(() => review.dispose())
  let loseAcknowledgment = false
  let afterTicket: ((ticket: SigninMergeTicket) => Promise<void>) | undefined
  let beforePrepare: ((emit: (value: unknown) => void) => Promise<void>) | undefined
  const messages: unknown[] = []
  // This transport exercises the production worker preparation and main installer in one Node realm
  // Native worker scheduling, key transfer, locks, and termination are covered separately in browsers
  class WorkerFixture {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onmessageerror: (() => void) | null = null
    operation?: Awaited<ReturnType<typeof createSigninMergePreparation>>
    database = new AccountDatabase(device.token.accountId, { existingOnly: true })
    terminated = false
    postMessage(input: { kind: string; incarnation: string; id?: string; operationId: string; locator: SigninMergeLocator; fence: SigninMergeFence; handle: string; key?: Uint8Array }) {
      messages.push(structuredClone({ ...input, key: undefined }))
      void (async () => {
        if (input.kind === 'initialize') { input.key?.fill(0); await this.database.open(); this.onmessage?.({ data: { incarnation: input.incarnation, status: 'ready' } } as MessageEvent); return }
        if (input.kind === 'foreground' || input.kind === 'cancel') return
        let value: unknown
        try {
          if (input.kind === 'review') { this.operation = await createSigninMergePreparation(this.database, device.token, input.operationId, input.locator, input.fence, () => {}); value = { handle: this.operation.handle, preview: this.operation.preview } }
          else if (input.kind === 'prepare') { await beforePrepare?.(value => this.onmessage?.({ data: { incarnation: input.incarnation, id: input.id, operationId: input.operationId, status: 'progress', value } } as MessageEvent)); const ticket = await this.operation!.prepare(input.handle); await afterTicket?.(ticket); value = ticket }
          else { await this.operation?.dispose(); if (loseAcknowledgment) { this.onerror?.(); return }; value = null }
          if (!this.terminated) this.onmessage?.({ data: { incarnation: input.incarnation, id: input.id, operationId: input.operationId, status: 'complete', value: structuredClone(value) } } as MessageEvent)
        } catch (error) { if (!this.terminated) this.onmessage?.({ data: { incarnation: input.incarnation, id: input.id, operationId: input.operationId, status: 'failed', code: error instanceof Error ? error.message : '' } } as MessageEvent) }
      })()
    }
    terminate() { this.terminated = true; void this.operation?.dispose().finally(() => this.database.close()); if (!this.operation) this.database.close() }
  }
  vi.stubGlobal('Worker', WorkerFixture)
  const operationId = accountLocalId(), identity = await stableWorkspaceSnapshotIdentity(snapshot)
  const client = await createSigninMergeClient(device.db, device.token, operationId, { snapshot, ...(locator ? { locator: { databaseName: guest.name, manifest } } : {}) }, identity, review, async () => {}, () => {}, new AbortController().signal, () => new Worker('synthetic-merge-worker'))
  cleanups.push(client.dispose)
  const value = { version: 1, kind: 'signin-decision', accountId: device.token.accountId, action: 'merge', status: 'preparing', copyId: client.preview.copyId, operationId, source: identity }
  return { device, guest, client, value, messages, loseAcknowledgment() { loseAcknowledgment = true }, set afterTicket(callback: typeof afterTicket) { afterTicket = callback }, set beforePrepare(callback: typeof beforePrepare) { beforePrepare = callback } }
}

it.each([false, true])('installs and activates a privately admitted merge with conflict=%s', async conflict => {
  const f = await fixture(conflict), before = await f.device.db.profileMeta.get('active')
  const stage = await f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
  expect(await f.device.db.preparationPayloads.count()).toBe(0)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeDefined()
  const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
  await stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })
  expect((await f.device.db.profileMeta.get('active'))!.headRevision).toBe(before!.headRevision + 1)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.outbox.count()).toBe(1)
  const prepared = { version: 1 as const, id: stage.copyId, expected: before!, head: before!.head, records: [] }
  expect(() => admitInstalledMerge(f.device.db, f.device.token, prepared, {})).toThrow()
  expect(() => nativeMergeInstallationCheck(f.device.db, f.device.token, { ...prepared, preparationAdmission: {} })).toThrow()
  await expect(activateLocalAccountCommit(f.device.db, f.device.token, { ...prepared, managedAdmission: {}, preparationAdmission: {} })).rejects.toThrow()
  expect(f.messages.every(message => !('snapshot' in (message as object)) && !('workspace' in (message as object)))).toBe(true)
}, 30_000)

it('refuses changed worker ciphertext before any descriptor or journal installation', async () => {
  const f = await fixture(), before = await f.device.db.encryptedRevisions.toArray()
  f.afterTicket = async ticket => {
    const chunk = (await f.device.db.stagedCipherChunks.get([ticket.manifest.payloadId, 0]))!
    const bytes = chunk.bytes.slice(); bytes[0] ^= 1
    await f.device.db.stagedCipherChunks.put({ ...chunk, bytes })
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow()
  expect(await f.device.db.encryptedRevisions.toArray()).toEqual(before)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
}, 30_000)

it('activates a genuine native predecessor through the distinct private native receipt', async () => {
  const f = await fixture(true, true), before = await f.device.db.profileMeta.get('active')
  const stage = await f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
  const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
  await stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })
  const selected = (await f.device.db.profileMeta.get('active'))!
  const { openAccountJson } = await import('../workspace/account-cache')
  const { AccountWorkspaceRootV2Schema } = await import('../workspace/account-graph')
  expect((await openAccountJson(f.device.db, f.device.token, selected.head, AccountWorkspaceRootV2Schema)).kind).toBe('local-workspace-graph')
  expect(selected.headRevision).toBe(before!.headRevision + 1)
  await expect(stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })).rejects.toThrow()
}, 30_000)

it.each([false, true])('rejects late actual source ciphertext changes before activation, native=%s', async native => {
  const f = await fixture(true, native), before = (await f.device.db.profileMeta.get('active'))!
  const stage = await f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
  const record = (await f.device.db.encryptedRevisions.get(before.head.revisionId))!, chunk = (await f.device.db.stagedCipherChunks.get([record.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await f.device.db.stagedCipherChunks.put({ ...chunk, bytes })
  const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
  await expect(stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })).rejects.toThrow()
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
  expect(await f.device.db.outbox.count()).toBe(0)
  await f.device.db.stagedCipherChunks.put(chunk)
}, 30_000)

it.each(['extra-reservation', 'orphan-output', 'foreign-source-root'] as const)('rejects %s in an authenticated ticket and preserves the selected destination', async mode => {
  const f = await fixture(), before = await f.device.db.profileMeta.get('active')
  f.afterTicket = async ticket => {
    const { readAccountRecordBytes, cipherRef, stageAccountJson } = await import('../workspace/account-cache')
    const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
    const owner = createAccountPreparationOwner(f.device.db, f.device.token, { operationId: ticket.operationId, check() {} })
    cleanups.push(() => owner.abandon())
    const extra = await stageAccountJson(f.device.db, f.device.token, { kind: 'synthetic-unrelated' }, [], undefined, owner)
    if (mode === 'extra-reservation') return
    const bytes = await readAccountRecordBytes(f.device.db, f.device.token, cipherRef(ticket.manifest), ticket.manifest)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)); bytes.fill(0)
    if (mode === 'orphan-output') manifest.output.push(extra)
    else { manifest.output.push(extra); manifest.sourceRoots.push(cipherRef(extra)) }
    const replacement = await stageAccountJson(f.device.db, f.device.token, manifest, [], undefined, owner)
    await f.device.db.preparationPayloads.delete([ticket.operationId, ticket.manifest.payloadId])
    await f.device.db.stagedCipherChunks.where('payloadId').equals(ticket.manifest.payloadId).delete()
    Object.assign(ticket, { manifest: replacement })
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow()
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
}, 30_000)

it.each(['output', 'consumed'] as const)('rejects an authenticated %s self-dependency before installing merge state', async inventory => {
  const f = await fixture()
  const selected = await f.device.db.profileMeta.get('active')
  const state = await f.device.db.syncState.toArray()
  let records = await f.device.db.encryptedRevisions.toArray()
  let outputIds: string[] = []
  f.afterTicket = async ticket => {
    const { readAccountRecordBytes, cipherRef, stageAccountJson } = await import('../workspace/account-cache')
    const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
    const owner = createAccountPreparationOwner(f.device.db, f.device.token, { operationId: ticket.operationId, check() {} })
    cleanups.push(() => owner.abandon())
    const bytes = await readAccountRecordBytes(f.device.db, f.device.token, cipherRef(ticket.manifest), ticket.manifest)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as SigninMergeManifest
    bytes.fill(0)
    const leaf = manifest[inventory].find(record => record.descriptor.dependencies.length === 0)!
    expect(leaf).toBeDefined()
    const malformed = { ...leaf, descriptor: { ...leaf.descriptor, dependencies: [cipherRef(leaf)] } }
    manifest[inventory][manifest[inventory].indexOf(leaf)] = malformed
    // Match the stored source descriptor so equality checks cannot mask a missing graph check
    // Ciphertext stays unchanged, just as in the authenticated output mutation
    if (inventory === 'consumed') {
      await f.device.db.encryptedRevisions.put(malformed)
      records = await f.device.db.encryptedRevisions.toArray()
    }
    outputIds = manifest.output.map(record => record.revisionId)
    const replacement = await stageAccountJson(f.device.db, f.device.token, manifest, [], undefined, owner)
    await f.device.db.preparationPayloads.delete([ticket.operationId, ticket.manifest.payloadId])
    await f.device.db.stagedCipherChunks.where('payloadId').equals(ticket.manifest.payloadId).delete()
    Object.assign(ticket, { manifest: replacement })
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
  expect(outputIds.length).toBeGreaterThan(0)
  for (const id of outputIds) expect(await f.device.db.encryptedRevisions.get(id)).toBeUndefined()
  expect(await f.device.db.encryptedRevisions.toArray()).toEqual(records)
  expect(await f.device.db.profileMeta.get('active')).toEqual(selected)
  expect(await f.device.db.syncState.toArray()).toEqual(state)
  expect(await f.device.db.syncState.get(`guest-copy:${f.client.preview.copyId}`)).toBeUndefined()
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
  expect(await f.device.db.outbox.count()).toBe(0)
}, 30_000)

it('rolls back descriptor installation, reservations, and transient deletion together', async () => {
  const f = await fixture(), before = await f.device.db.encryptedRevisions.toArray()
  const { IDBObjectStore } = await import('fake-indexeddb')
  const original = IDBObjectStore.prototype.put
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    if (this.name === 'syncState' && (args[0] as { id?: string }).id === 'signin-receipt:decision') throw new Error('synthetic receipt write failure')
    return original.apply(this, args)
  })
  try { await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow() }
  finally { fault.mockRestore() }
  expect(await f.device.db.encryptedRevisions.toArray()).toEqual(before)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
}, 30_000)

it('refuses a source association appearing after installation before activation', async () => {
  const f = await fixture(true, true), before = (await f.device.db.profileMeta.get('active'))!
  const stage = await f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
  await f.device.db.syncState.add({ id: `source-context:${before.head.revisionId}`, ref: before.head })
  const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
  await expect(stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })).rejects.toThrow()
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
}, 30_000)

it('retains committed worker output across a lost release acknowledgment and cold native-journal resume', async () => {
  const f = await fixture(true), before = await f.device.db.profileMeta.get('active')
  f.loseAcknowledgment()
  const stage = await f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
  const installed = await f.device.db.encryptedRevisions.toArray()
  expect(await f.device.db.preparationPayloads.count()).toBe(0)
  await stage.dispose()
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const cold = createGuestCopyService(async () => { throw new Error('Cold resume must use its saved source') })
  try {
    const preview = await cold.previewSigninMerge(f.device.token, stage.copyId)
    const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
    await cold.commitGuestCopy(f.device.token, preview, { id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })
    expect((await f.device.db.profileMeta.get('active'))!.headRevision).toBe(before!.headRevision + 1)
    for (const record of installed) expect(await f.device.db.encryptedRevisions.get(record.revisionId)).toEqual(record)
  } finally { await cold.dispose() }
}, 30_000)

it('cannot install a main receipt whose private staging failed', async () => {
  const f = await fixture(), before = await f.device.db.encryptedRevisions.toArray()
  f.afterTicket = async () => {
    const cache = await import('../workspace/account-cache')
    vi.spyOn(cache, 'stageAccountJson').mockRejectedValueOnce(new Error('synthetic receipt staging failure'))
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow('synthetic receipt staging failure')
  expect(await f.device.db.encryptedRevisions.toArray()).toEqual(before)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
}, 30_000)

it('refuses an ordinary guest without a locator instead of preparing in the caller realm', async () => {
  await expect(fixture(false, false, false)).rejects.toThrow('SIGNIN_SOURCE_CHANGED')
}, 30_000)

it.each(['extra', 'foreign'] as const)('refuses %s reservation changes during private main receipt staging', async mode => {
  const f = await fixture(), before = await f.device.db.profileMeta.get('active')
  f.afterTicket = async () => {
    const cache = await import('../workspace/account-cache'), stage = cache.stageAccountJson
    vi.spyOn(cache, 'stageAccountJson').mockImplementationOnce(async (...args) => {
      const receipt = await stage(...args)
      if (mode === 'extra') await stage(args[0], args[1], { synthetic: 'extra main reservation' }, [], undefined, args[5])
      else {
        const row = (await f.device.db.preparationPayloads.where('payloadId').equals(receipt.payloadId).first())!
        await f.device.db.preparationPayloads.delete([row.operationId, row.payloadId])
        await f.device.db.preparationPayloads.add({ ...row, operationId: accountLocalId() })
      }
      return receipt
    })
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
}, 30_000)

it.each(['none', 'before-install', 'late-activation'] as const)('keeps installed original rows in the worker consumed proof with mutation=%s', async mutation => {
  const f = await fixture(false, false, true, true)
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { admitLocalRoot } = await import('../workspace/local-root')
  const { readLocalEvidence } = await import('../workspace/local-evidence')
  const { readLocalIndex } = await import('../workspace/local-index')
  const { INDEX_PAGE_BYTES } = await import('../workspace/directory')
  const { readBlob } = await import('../workspace/blobs')
  const { readAccountRecordBytes, cipherRef } = await import('../workspace/account-cache')
  const store = createAccountLocalStore(f.device.db, f.device.token)
  cleanups.push(() => store.dispose())
  const before = (await f.device.db.profileMeta.get('active'))!
  const original = await admitLocalRoot(store.adapter, before.head, store.lifetime)
  await readLocalEvidence(store.adapter, original.root.inheritedEvidence, async () => store.lifetime.check())
  const json = async (ref: import('../workspace/local-root').LocalRecordRef) => JSON.parse(new TextDecoder().decode(await readBlob(await store.adapter.read(ref), INDEX_PAGE_BYTES)))
  type Row = { table: string; key: string | [string, number]; ref: import('../workspace/local-root').LocalRecordRef }
  const rows = async (root: import('../workspace/local-root').LocalRecordRef) => (await readLocalIndex<Row>((await json(root)).roots[0].index, json)).entries
  const originals = (await rows(original.root.inheritedEvidence)).filter(row => ['evidenceSegments', 'evidenceBlobs', 'evidenceChunks'].includes(row.table))
  expect(originals.some(row => row.table === 'evidenceChunks')).toBe(true)
  const record = (await f.device.db.encryptedRevisions.get(originals.find(row => row.table === 'evidenceChunks')!.ref.revisionId))!
  const chunk = (await f.device.db.stagedCipherChunks.get([record.payloadId, 0]))!
  const mutate = async () => { const bytes = chunk.bytes.slice(); bytes[0] ^= 1; await f.device.db.stagedCipherChunks.put({ ...chunk, bytes }) }
  let checked = false
  f.afterTicket = async ticket => {
    const bytes = await readAccountRecordBytes(f.device.db, f.device.token, cipherRef(ticket.manifest), ticket.manifest)
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as SigninMergeManifest; bytes.fill(0)
    for (const row of originals) {
      expect(manifest.consumed.some(record => record.revisionId === row.ref.revisionId && record.descriptor.documentId === row.ref.documentId)).toBe(true)
      expect(manifest.output.some(record => record.revisionId === row.ref.revisionId)).toBe(false)
    }
    checked = true
    if (mutation === 'before-install') await mutate()
  }
  try {
    const prepare = () => f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })
    if (mutation === 'before-install') {
      const descriptors = await f.device.db.encryptedRevisions.toArray()
      await expect(prepare()).rejects.toThrow()
      expect(checked).toBe(true)
      expect(await f.device.db.encryptedRevisions.toArray()).toEqual(descriptors)
      expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
      expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
    } else {
      const stage = await prepare()
      expect(checked).toBe(true)
      const receipt = (await f.device.db.syncState.get('signin-receipt:decision'))!
      if (mutation === 'late-activation') await mutate()
      const activate = () => stage.activate({ id: receipt.id, expected: receipt, value: { ...f.value, status: 'complete' } })
      if (mutation === 'late-activation') await expect(activate()).rejects.toThrow()
      else {
        await activate()
        const selected = (await f.device.db.profileMeta.get('active'))!
        const after = await admitLocalRoot(store.adapter, selected.head, store.lifetime)
        const retained = await rows(after.root.inheritedEvidence)
        for (const row of originals) expect(retained.find(value => value.table === row.table && JSON.stringify(value.key) === JSON.stringify(row.key))?.ref).toEqual(row.ref)
        await readLocalEvidence(store.adapter, after.root.inheritedEvidence, async () => store.lifetime.check())
      }
    }
    if (mutation !== 'none') { expect(await f.device.db.profileMeta.get('active')).toEqual(before); expect(await f.device.db.outbox.count()).toBe(0) }
  } finally { await f.device.db.stagedCipherChunks.put(chunk) }
}, 30_000)

it.each(['valid', 'malformed', 'throwing-observer'] as const)('preserves the resource terminal code with optional diagnostic=%s', async mode => {
  const api = await import('../workspace/signin-merge-diagnostics')
  const { assertSigninMergeBudget, signinMergeResourceFailure, SIGNIN_MERGE_LIMITS } = await import('../workspace/signin-merge-protocol')
  api.enableSigninMergeDiagnostics()
  const diagnostics = api.beginSigninMergeDiagnostics()!
  cleanups.push(async () => api.stopSigninMergeDiagnostics())
  if (mode === 'throwing-observer') {
    const original = diagnostics.workerObserver
    vi.spyOn(diagnostics, 'workerObserver').mockImplementation(() => ({ ...original(), resourceFailure() { throw new Error('synthetic diagnostic consumer failure') } }))
  }
  const f = await fixture(), before = await f.device.db.profileMeta.get('active')
  f.beforePrepare = async emit => {
    let error: unknown
    try { assertSigninMergeBudget(0, 2, SIGNIN_MERGE_LIMITS.observationBytes + 17) } catch (caught) { error = caught }
    const resourceFailure = signinMergeResourceFailure(error)!
    emit({ stage: 'preparing-merge', resourceFailure: mode === 'malformed' ? { ...resourceFailure, privateId: 'secret' } : resourceFailure })
    emit({ stage: 'preparing-merge', codec: { encodedOutputBytes: 7 } })
    throw error
  }
  await expect(f.client.prepare({ id: 'signin-receipt:decision', expected: undefined, value: f.value })).rejects.toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
  diagnostics.record({ stage: 'confirm', outcome: 'failed', elapsedMs: 1, errorCode: 'resource-limit' })
  const last = diagnostics.snapshot().at(-1)!
  if (mode === 'valid') expect(last.resourceFailure).toMatchObject({ dimension: 'observationBytes', records: 2 })
  else expect(last.resourceFailure).toBeUndefined()
  expect(last.workerMetadata?.encodedOutputBytes).toBe(7)
  expect(last.workerAccounting?.reportedRequests).toBe(1)
  expect(JSON.stringify(last)).not.toMatch(/secret|privateId|consumer failure/)
  expect(await f.device.db.profileMeta.get('active')).toEqual(before)
  expect(await f.device.db.outbox.count()).toBe(0)
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
}, 30_000)
