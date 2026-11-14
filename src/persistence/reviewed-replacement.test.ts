import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { editorClosureFixture } from '../workspace/test-helpers'
import { accountLocalId } from '../workspace/account-cache'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { runSyncIteration } from '../account/sync/outbox'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { createAccountRecoveryService } from '../workspace/account-recovery'

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const snapshots: WorkspaceSnapshot[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const snapshot of snapshots.splice(0)) await disposeWorkspaceSnapshot(snapshot); await service?.dispose(); service = undefined })
async function source(name: string) {
  const fixture = await editorClosureFixture()
  const snapshot = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: name, capturedAt: '2026-11-14', revisionVector: {}, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, filename: name }] } }))
  snapshots.push(snapshot)
  return snapshot
}
async function start() {
  const api = await import('../workspace/reviewed-replacement')
  service = await conflictService()
  const original = await source('original'), replacement = await source('replacement')
  const device = await service.device(0, original.state)
  await device.settle()
  const controller = api.createReviewedReplacementService(device.db, device.token)
  const review = await controller.refresh()
  const stage = await controller.prepare(review, replacement, accountLocalId())
  await controller.activate(stage)
  await stage.dispose(); await review.dispose()
  return { api, device, original, replacement, controller }
}
it('remote advancement pauses the entire reviewed branch before publication and ordinary Retry cannot renew it', async () => {
  const { api, device } = await start()
  const oldFence = await device.db.profileMeta.get('active')
  const other = await service!.device(1)
  await other.settle()
  const competing = await source('competing')
  const restore = await import('../workspace/account-restore')
  const preview = await restore.previewAccountWorkspaceRestore(other.db, other.token, competing)
  const stage = await restore.stageAccountWorkspaceRestore(preview)
  await restore.activateAccountWorkspaceRestore(stage)
  await restore.releaseAccountWorkspaceRestoreStage(stage); restore.releaseAccountWorkspaceRestorePreview(preview)
  await other.settle()
  const resumed = await service!.device(0)
  const commits = service!.commits.length
  expect(await resumed.settle()).toEqual({ state: 'paused', moreWork: false })
  expect(await resumed.db.profileMeta.get('active')).toEqual(oldFence)
  expect((await api.readReviewedReplacement(resumed.db, resumed.token))?.value.state).toBe('paused')
  expect(await resumed.settle()).toEqual({ state: 'paused', moreWork: false })
  expect(service!.commits.length).toBe(commits)
  expect(await resumed.db.outbox.count()).toBe(1)
})
it('acceptance lost on the wire completes only the exact original recovery despite later remote movement', async () => {
  const { device, controller } = await start()
  const originalFetch = globalThis.fetch
  let lost = false
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await originalFetch(path, init)
    if (path.endsWith('/commits') && JSON.parse(init.body as string).recoveryOperationId && response.ok && !lost) { lost = true; throw new TypeError('lost acceptance') }
    return response
  })
  await expect(device.settle()).rejects.toThrow('lost acceptance')
  const authority = (await controller.status())!
  expect(authority.state).toBe('active')
  const uncertainFence = await device.db.profileMeta.get('active'), uncertainRows = await device.db.outbox.toArray()
  const uncertainReview = await controller.refresh()
  try { await expect(controller.prepareLatest(uncertainReview, accountLocalId())).rejects.toThrow('REPLACEMENT_REVIEW_REQUIRED') } finally { await uncertainReview.dispose() }
  expect(await device.db.profileMeta.get('active')).toEqual(uncertainFence)
  expect(await device.db.outbox.toArray()).toEqual(uncertainRows)
  expect((await createAccountRecoveryService(device.token).list())[0].state).toBe('pending')
  const other = await service!.device(1)
  await other.settle()
  const changed = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...changed, editorDocuments: changed.editorDocuments.map(file => ({ ...file, filename: 'later remote acceptance' })) }, changed.planner.localData.revision)
  await other.settle()
  const resumed = await service!.device(0)
  const resumedController = (await import('../workspace/reviewed-replacement')).createReviewedReplacementService(resumed.db, resumed.token)
  expect((await resumed.settle()).state).toBe('synced')
  expect((await resumedController.status())?.state).toBe('accepted')
  const point = (await createAccountRecoveryService(resumed.token).list())[0]
  expect(point.state).toBe('completed')
  expect(point.mutationId).toBe(authority.final!.mutationId)
})
it('a definitive conflict preserves later edits and Use latest seals the complete branch before retiring its intents', async () => {
  const { api, device } = await start()
  await prepareManagedSync(device.db, device.token)
  expect((await runSyncIteration(device.token, new AbortController().signal)).moreWork).toBe(true)
  const other = await service!.device(1)
  await other.settle()
  const current = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...current, editorDocuments: current.editorDocuments.map(file => ({ ...file, filename: 'remote winner' })) }, current.planner.localData.revision)
  await other.settle()
  const resumed = await service!.device(0)
  const local = await (await resumed.open()).readWorkspace()
  await (await resumed.open()).commitWorkspace({ ...local, editorDocuments: local.editorDocuments.map(file => ({ ...file, filename: 'later local edit' })) }, local.planner.localData.revision)
  expect((await resumed.settle()).state).toBe('paused')
  const active = await resumed.db.profileMeta.get('active')
  const next = api.createReviewedReplacementService(resumed.db, resumed.token)
  const review = await next.refresh()
  try {
    const operationId = accountLocalId(), before = await resumed.db.outbox.toArray()
    const originalFetch = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const response = await originalFetch(path, init)
      if (path.endsWith('/seal') && response.ok && !lost) { lost = true; throw new TypeError('lost branch backup') }
      return response
    })
    await expect(next.prepareLatest(review, operationId)).rejects.toThrow('lost branch backup')
    expect(await resumed.db.profileMeta.get('active')).toEqual(active)
    expect(await resumed.db.outbox.toArray()).toEqual(before)
    const stage = await next.prepareLatest(review, operationId)
    const { prepareAccountReceiptAttachment, releaseAccountActivationAttachment } = await import('./account-activation-attachments')
    const receipt = await prepareAccountReceiptAttachment(resumed.db, resumed.token, stage, { id: 'signin-receipt:latest', expected: undefined, value: { version: 1, choice: 'latest' } })
    const snapshotTables = () => Promise.all(resumed.db.tables.map(async table => ({ name: table.name, rows: await table.toArray() })))
    let transactionBefore: Awaited<ReturnType<typeof snapshotTables>> | undefined
    const deleteIntents = resumed.db.outbox.bulkDelete.bind(resumed.db.outbox)
    // Capture after freshness discovery, immediately before the transaction's first destructive write
    const retirement = vi.spyOn(resumed.db.outbox, 'bulkDelete').mockImplementationOnce(keys => Dexie.Promise.resolve().then(async () => {
      expect(Dexie.currentTransaction?.active).toBe(true)
      transactionBefore = await snapshotTables()
      expect(keys).toEqual(before.map(row => row.id))
      expect(keys.length).toBeGreaterThan(1)
      return deleteIntents(keys)
    }))
    const putFence = resumed.db.profileMeta.put.bind(resumed.db.profileMeta)
    const oldAuthority = await resumed.db.syncState.get('reviewed-replacement')
    const oldPreparation = await resumed.db.syncState.get(`reviewed-preparation:${operationId}`)
    const oldPublication = (await resumed.db.syncState.get('publication'))!
    // Abort after all attachment writes and the new selected fence, not at a preflight guard
    const interruption = vi.spyOn(resumed.db.profileMeta, 'put').mockImplementationOnce(fence => Dexie.Promise.resolve().then(async () => {
      await putFence(fence)
      expect(Dexie.currentTransaction?.active).toBe(true)
      expect(await resumed.db.profileMeta.get('active')).toEqual(fence)
      expect(fence.head).toEqual(stage.head)
      expect(await resumed.db.documentHeads.get(stage.head.documentId)).toEqual(stage.head)
      expect(await resumed.db.outbox.count()).toBe(0)
      expect(await resumed.db.syncState.get('publication')).toBeUndefined()
      expect(await resumed.db.syncState.get(`rejected:${oldPublication.ref.revisionId}`)).toBeDefined()
      expect(await resumed.db.syncState.get(`retired-reviewed-branch:${oldAuthority!.ref.revisionId}`)).toBeDefined()
      expect(await resumed.db.syncState.get('reviewed-replacement')).not.toEqual(oldAuthority)
      expect(await resumed.db.syncState.get(`reviewed-preparation:${operationId}`)).not.toEqual(oldPreparation)
      expect(await resumed.db.syncState.get('signin-receipt:latest')).toBeDefined()
      expect(await resumed.db.migrationJournal.get(stage.id)).toBeDefined()
      throw new Error('interrupted after reviewed selection writes')
    }))
    try {
      await expect(next.activate(stage, receipt)).rejects.toThrow('interrupted after reviewed selection writes')
      expect(retirement).toHaveBeenCalledTimes(1)
      expect(interruption).toHaveBeenCalledTimes(1)
      expect(transactionBefore).toBeDefined()
      // Exact rows include ciphertext descriptors, dependency ownership, and every staged byte
      expect(await snapshotTables()).toEqual(transactionBefore)
      retirement.mockRestore(); interruption.mockRestore()
      await next.activate(stage, receipt)
    } finally { retirement.mockRestore(); interruption.mockRestore(); await releaseAccountActivationAttachment(receipt); await stage.dispose() }
    expect(await resumed.db.syncState.get('signin-receipt:latest')).toBeDefined()
    expect(await resumed.db.profileMeta.get('active')).not.toEqual(active)
    expect(await resumed.db.outbox.count()).toBe(0)
    expect(await resumed.db.syncState.get('publication')).toBeUndefined()
    expect((await (await resumed.open()).readWorkspace()).editorDocuments[0].filename).toBe('remote winner')
    const authority = (await next.status())!
    expect(authority.state).toBe('selected-latest')
    const recovered = await createAccountRecoveryService(resumed.token).capture(authority.recoveryOperationId)
    snapshots.push(recovered)
    expect(recovered.state.editorDocuments[0].filename).toBe('later local edit')
    expect((await createAccountRecoveryService(resumed.token).list()).find(point => point.operationId === authority.recoveryOperationId)?.state).toBe('pending')
  } finally { await review.dispose() }
})
it('reopens the same pre-activation recovery after a lost seal response and rejects a changed source', async () => {
  const api = await import('../workspace/reviewed-replacement')
  service = await conflictService()
  const original = await source('preserved'), replacement = await source('source identity')
  let device = await service.device(0, original.state)
  await device.settle()
  let controller = api.createReviewedReplacementService(device.db, device.token)
  const review = await controller.refresh(), operationId = accountLocalId()
  const originalFetch = globalThis.fetch
  let lost = false
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await originalFetch(path, init)
    if (path.endsWith('/seal') && response.ok && !lost) { lost = true; throw new TypeError('lost seal') }
    return response
  })
  const events: import('../workspace/reviewed-replacement').ReviewedReplacementDiagnostic[] = []
  const unsubscribe = api.subscribeReviewedReplacementDiagnostics(value => events.push(value))
  try { await expect(controller.prepare(review, replacement, operationId)).rejects.toThrow('lost seal') } finally { unsubscribe() }
  expect(events).toEqual([expect.objectContaining({ operationId, phase: 'preserve', outcome: 'failed', code: 'FAILED' })])
  expect(events[0].elapsedMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(events)).not.toContain('source identity')
  await review.dispose()
  expect((await controller.preparations()).map(value => value.operationId)).toEqual([operationId])
  device = await service.device(0)
  controller = api.createReviewedReplacementService(device.db, device.token)
  const reopened = await controller.refresh()
  try {
    await expect(controller.prepare(reopened, await source('changed source'), operationId)).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    const changedVector = await readWorkspaceBackup(exportWorkspaceBackup({ ...replacement, revisionVector: { ...replacement.revisionVector, changed: 'new source revision' } }))
    snapshots.push(changedVector)
    await expect(controller.prepare(reopened, changedVector, operationId)).rejects.toThrow('IDEMPOTENCY_MISMATCH')
    const freshEnvelope = await readWorkspaceBackup(exportWorkspaceBackup({ ...replacement, snapshotId: 'fresh capture envelope', capturedAt: '2026-11-15T00:00:00.000Z' }))
    snapshots.push(freshEnvelope)
    const stage = await controller.prepare(reopened, freshEnvelope, operationId)
    try { await controller.activate(stage) } finally { await stage.dispose() }
    expect((await createAccountRecoveryService(device.token).list()).map(point => point.operationId)).toEqual([operationId])
    expect((await controller.status())?.operationId).toBe(operationId)
  } finally { await reopened.dispose() }
})
it.each(['bind', 'supersede'] as const)('renewed approval resumes the exact successor after a lost %s acknowledgment', async phase => {
  const { api } = await start()
  const other = await service!.device(1)
  await other.settle()
  const competing = await source('newly displaced remote')
  const restore = await import('../workspace/account-restore')
  const preview = await restore.previewAccountWorkspaceRestore(other.db, other.token, competing)
  const remoteStage = await restore.stageAccountWorkspaceRestore(preview)
  await restore.activateAccountWorkspaceRestore(remoteStage)
  await restore.releaseAccountWorkspaceRestoreStage(remoteStage); restore.releaseAccountWorkspaceRestorePreview(preview)
  await other.settle()
  let resumed = await service!.device(0)
  expect((await resumed.settle()).state).toBe('paused')
  let controller = api.createReviewedReplacementService(resumed.db, resumed.token)
  const old = (await controller.status())!, review = await controller.refresh()
  const operationId = accountLocalId(), stage = await controller.approve(review, operationId)
  try { await controller.activate(stage) } finally { await stage.dispose(); await review.dispose() }
  expect((await controller.status())?.predecessorRecoveryId).toBe(old.recoveryOperationId)
  const originalFetch = globalThis.fetch
  let lost = false
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await originalFetch(path, init)
    if (path.endsWith(`/${phase}`) && response.ok && !lost) { lost = true; throw new TypeError(`lost ${phase}`) }
    return response
  })
  await expect(resumed.settle()).rejects.toThrow(`lost ${phase}`)
  const exact = (await controller.status())!.final!
  expect(service!.commits.some(command => command.mutationId === exact.mutationId)).toBe(false)
  resumed = await service!.device(0)
  controller = api.createReviewedReplacementService(resumed.db, resumed.token)
  expect((await resumed.settle()).state).toBe('synced')
  expect((await controller.status())!.final).toEqual(exact)
  expect((await createAccountRecoveryService(resumed.token).list()).map(point => point.operationId)).toEqual([operationId])
  const recovered = await createAccountRecoveryService(resumed.token).capture(operationId)
  snapshots.push(recovered)
  expect(recovered.state.editorDocuments[0].filename).toBe('newly displaced remote')
  expect(recovered.version === 2 && recovered.historicalEvidence.snapshots.length > 0).toBe(true)
})
it('a local edit after branch preservation keeps the complete paused branch instead of selecting stale latest data', async () => {
  const { api } = await start()
  const other = await service!.device(1)
  await other.settle()
  const remote = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...remote, editorDocuments: remote.editorDocuments.map(file => ({ ...file, filename: 'remote change' })) }, remote.planner.localData.revision)
  await other.settle()
  const resumed = await service!.device(0)
  expect((await resumed.settle()).state).toBe('paused')
  const controller = api.createReviewedReplacementService(resumed.db, resumed.token), review = await controller.refresh()
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { prepareManagedAccountProjection } = await import('../workspace/account-managed-projection')
  const remoteCandidate = await prepareAccountWorkspace(resumed.db, resumed.token, review.snapshot.state)
  const expected = (await resumed.db.profileMeta.get('active'))!
  await expect(prepareManagedAccountProjection(resumed.db, resumed.token, expected, remoteCandidate)).rejects.toThrow('cannot discard managed historical originals')
  await expect(prepareManagedAccountProjection(resumed.db, resumed.token, expected, remoteCandidate, undefined, true, {})).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
  const stage = await controller.prepareLatest(review, accountLocalId())
  try {
    const branch = await (await resumed.open()).readWorkspace()
    await (await resumed.open()).commitWorkspace({ ...branch, editorDocuments: branch.editorDocuments.map(file => ({ ...file, filename: 'edit after preservation' })) }, branch.planner.localData.revision)
    const fence = await resumed.db.profileMeta.get('active'), pending = await resumed.db.outbox.toArray()
    await expect(controller.activate(stage)).rejects.toThrow('LOCAL_REVISION_CONFLICT')
    expect(await resumed.db.profileMeta.get('active')).toEqual(fence)
    expect(await resumed.db.outbox.toArray()).toEqual(pending)
    expect((await controller.status())?.state).toBe('paused')
    expect((await (await resumed.open()).readWorkspace()).editorDocuments[0].filename).toBe('edit after preservation')
  } finally { await stage.dispose(); await review.dispose() }
})
it('reviews a new account only after its own baseline settles and then replaces it without publishing guest data early', async () => {
  const api = await import('../workspace/reviewed-replacement')
  service = await conflictService()
  const { createBlankLocalData } = await import('../domain/local-data')
  const localData = createBlankLocalData()
  // A minimal synthetic baseline isolates initial publication from bundled catalog startup cost
  const baseline = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1 as const, layers: [] } }
  const device = await service.device(0, baseline), controller = api.createReviewedReplacementService(device.db, device.token)
  await prepareManagedSync(device.db, device.token)
  await expect(controller.refresh()).rejects.toThrow('ACCOUNT_PROJECTION_UNAVAILABLE')
  expect(service.commits).toHaveLength(0)
  expect((await device.settle()).state).toBe('synced')
  const review = await controller.refresh()
  expect(review.snapshot.state.editorDocuments).toEqual([])
  const sourceSnapshot = await source('new account device source')
  const stage = await controller.prepare(review, sourceSnapshot, accountLocalId())
  try { await controller.activate(stage) } finally { await stage.dispose(); await review.dispose() }
  expect((await device.settle()).state).toBe('synced')
  expect((await (await device.open()).readWorkspace()).editorDocuments[0].filename).toBe('new account device source')
  expect((await controller.status())?.state).toBe('accepted')
})
