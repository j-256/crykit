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

async function appendLocalOriginal(device: Awaited<ReturnType<Awaited<ReturnType<typeof conflictService>>['device']>>) {
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { admitLocalRoot, prepareLocalWorkspace } = await import('../workspace/local-root')
  const { readLocalEvidence, prepareLocalEvidence } = await import('../workspace/local-evidence')
  const { guestEvidenceFromSnapshot, mergeGuestEvidence, emptyPlannerEvidence } = await import('../workspace/guest-evidence')
  const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup')
  const { captureAccountReviewWorkspace } = await import('../workspace/account-sync-capture')
  const { activateLocalAccountCommit } = await import('./account-database')
  const fence = (await device.db.profileMeta.get('active'))!, store = createAccountLocalStore(device.db, device.token)
  const mapped = await captureAccountReviewWorkspace(device.db, device.token, fence)
  try {
    const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    const existing = (await readLocalEvidence(store.adapter, previous.root.inheritedEvidence, async () => {}))!
    const extra = await source('additional local original')
    const inherited = await inheritWorkspaceSnapshot(extra, [extra]); snapshots.push(inherited)
    const evidence = await mergeGuestEvidence(existing, await guestEvidenceFromSnapshot(inherited, emptyPlannerEvidence()), existing.planner)
    const operationId = accountLocalId(), evidenceRef = await prepareLocalEvidence(store.adapter, operationId, evidence)
    const result = await prepareLocalWorkspace(store.adapter, operationId, previous.state, store.lifetime, undefined, evidenceRef)
    // This valid mapped selection deliberately retains a local original absent from its native publication
    const native = { head: mapped.workspace.head, records: [], entries: mapped.workspace.entries, opened: mapped.workspace, validatedEvidence: mapped.validatedEvidence }
    await activateLocalAccountCommit(device.db, device.token, await store.prepareMappedActivation(operationId, result, fence, previous, native))
    store.committed(operationId)
  } finally { await mapped.dispose(); await store.dispose() }
}

async function pausedCaptureReview(addLocalOriginal = false) {
  const { api } = await start()
  const other = await service!.device(1)
  await other.settle()
  const remote = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...remote, editorDocuments: remote.editorDocuments.map(file => ({ ...file, filename: 'review capture remote' })) }, remote.planner.localData.revision)
  await other.settle()
  const device = await service!.device(0)
  expect((await device.settle()).state).toBe('paused')
  if (addLocalOriginal) await appendLocalOriginal(device)
  const controller = api.createReviewedReplacementService(device.db, device.token)
  return { device, controller, review: await controller.refresh(), fence: (await device.db.profileMeta.get('active'))! }
}

it.each(['approve', 'prepareLatest'] as const)('branch action %s recaptures complete local originals and owns capture through stage disposal', async action => {
  const { device, controller, review, fence } = await pausedCaptureReview(true)
  const captures = await import('../workspace/account-sync-capture'), snapshotsApi = await import('../workspace/account-snapshot')
  const original = captures.captureAccountSyncWorkspace
  const disposed = vi.fn()
  let captured: Awaited<ReturnType<typeof original>> | undefined
  const recapture = vi.spyOn(captures, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const value = await original(...args)
    if (!args[3]) return value
    captured = value
    return { ...value, async dispose() { disposed(); await value.dispose() } }
  })
  const captureSnapshot = vi.spyOn(snapshotsApi, 'captureAccountSnapshot')
  try {
    const stage = await controller[action](review, accountLocalId())
    try {
      expect(recapture.mock.calls.filter(args => args[3])).toEqual([[device.db, device.token, fence, expect.any(AbortSignal)]])
      expect(captured?.inheritedEvidence).toBeDefined()
      expect(captured?.inheritedEvidence).not.toEqual(captured?.workspace.inheritedEvidence)
      const call = captureSnapshot.mock.calls.find(([workspace]) => JSON.stringify(workspace.inheritedEvidence) === JSON.stringify(captured!.inheritedEvidence))!
      expect(call).toBeDefined()
      expect(call[3]?.validatedEvidence).toBe(captured!.publicationValidatedEvidence)
      const snapshot = await captureSnapshot.mock.results[captureSnapshot.mock.calls.indexOf(call)].value
      expect(snapshot.version).toBe(2)
      const evidence = await import('../workspace/account-evidence-snapshots')
      const mappedIds = new Set(captured!.validatedEvidence ? (await evidence.accountInheritedSources(captured!.validatedEvidence)).members.map(member => member.id) : [])
      expect(snapshot.historicalEvidence.snapshots.some((member: { id: string }) => !mappedIds.has(member.id))).toBe(true)
      expect(disposed).not.toHaveBeenCalled()
    } finally { await stage.dispose(); await stage.dispose() }
    expect(disposed).toHaveBeenCalledOnce()
  } finally { await review.dispose() }
})

it.each(['before', 'during', 'snapshot', 'attachment-dispose', 'snapshot-dispose', 'capture-dispose'] as const)('branch recapture retains exact authority and cleans ownership on %s failure', async mode => {
  const { device, controller, review, fence } = await pausedCaptureReview()
  const captures = await import('../workspace/account-sync-capture'), snapshotsApi = await import('../workspace/account-snapshot')
  const original = captures.captureAccountSyncWorkspace, disposed = vi.fn(), completed = vi.fn()
  let failCapture = true
  const change = () => device.db.profileMeta.put({ ...fence, headRevision: fence.headRevision + 1 })
  const recapture = vi.spyOn(captures, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const value = await original(...args)
    if (mode === 'during') await change()
    return { ...value, async dispose() {
      disposed()
      if (mode === 'capture-dispose' && failCapture) { failCapture = false; throw new Error('capture disposal interrupted') }
      await value.dispose(); completed()
    } }
  })
  const pending = await device.db.outbox.toArray(), commits = service!.commits.length
  try {
    if (mode === 'before') await change()
    if (mode === 'snapshot') vi.spyOn(snapshotsApi, 'captureAccountSnapshot').mockRejectedValueOnce(new Error('snapshot interrupted'))
    if (mode.endsWith('-dispose')) {
      const stage = await controller.prepareLatest(review, accountLocalId())
      const attachments = await import('./account-activation-attachments')
      const snapshotOwners = await import('../workspace/snapshot')
      const interrupted = mode === 'attachment-dispose'
        ? vi.spyOn(attachments, 'releaseAccountActivationAttachment').mockRejectedValueOnce(new Error('attachment disposal interrupted'))
        : mode === 'snapshot-dispose' ? vi.spyOn(snapshotOwners, 'disposeWorkspaceSnapshot').mockRejectedValueOnce(new Error('snapshot disposal interrupted')) : undefined
      const message = mode.replace('-dispose', ' disposal interrupted')
      await expect(stage.dispose()).rejects.toThrow(message)
      expect(completed).toHaveBeenCalledTimes(mode === 'capture-dispose' ? 0 : 1)
      await expect(stage.dispose()).resolves.toBeUndefined()
      await expect(stage.dispose()).resolves.toBeUndefined()
      if (interrupted) expect(interrupted.mock.calls.filter(args => args[0] === interrupted.mock.calls[0][0])).toHaveLength(2)
      interrupted?.mockRestore()
      expect(disposed).toHaveBeenCalledTimes(mode === 'capture-dispose' ? 2 : 1)
      expect(completed).toHaveBeenCalledOnce()
    } else {
      await expect(controller.approve(review, accountLocalId())).rejects.toThrow(mode === 'snapshot' ? 'snapshot interrupted' : 'LOCAL_REVISION_CONFLICT')
      expect(disposed).toHaveBeenCalledTimes(mode === 'before' ? 0 : 1)
      expect(recapture).toHaveBeenCalledTimes(mode === 'before' ? 0 : 1)
    }
    expect(service!.commits.length).toBe(commits)
    expect(await device.db.outbox.toArray()).toEqual(pending)
  } finally { await review.dispose() }
})

it.each(['approve', 'prepareLatest'] as const)('branch disposal %s revokes authority immediately and retains failed capture for concurrent retry', async action => {
  const { device, controller, review } = await pausedCaptureReview()
  const captures = await import('../workspace/account-sync-capture'), original = captures.captureAccountSyncWorkspace
  const attempts = vi.fn(), completed = vi.fn()
  let fail = true
  vi.spyOn(captures, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const captured = await original(...args)
    if (!args[3]) return captured
    return { ...captured, async dispose() {
      attempts()
      if (fail) { fail = false; throw new Error('branch cleanup unavailable') }
      await captured.dispose(); completed()
    } }
  })
  try {
    const stage = await controller[action](review, accountLocalId())
    const outcomesPending = Promise.allSettled([stage.dispose(), stage.dispose()])
    const activeReads = vi.spyOn(device.db.profileMeta, 'get')
    const activation = controller.activate(stage).then(() => undefined, error => error)
    const readsBeforeAwait = activeReads.mock.calls.length
    activeReads.mockRestore()
    const activationError = await activation
    const outcomes = await outcomesPending
    expect(readsBeforeAwait).toBe(0)
    expect(activationError).toMatchObject({ message: expect.stringContaining('LOCAL_INTEGRITY_FAILED') })
    expect(outcomes.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(attempts).toHaveBeenCalledOnce()
    expect(completed).not.toHaveBeenCalled()
    await expect(controller.activate(stage)).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
    await expect(stage.dispose()).resolves.toBeUndefined()
    await expect(stage.dispose()).resolves.toBeUndefined()
    expect(attempts).toHaveBeenCalledTimes(2)
    expect(completed).toHaveBeenCalledOnce()
  } finally { await review.dispose() }
})

it.each(['snapshot', 'fence', 'approve-preparation', 'latest-preparation'] as const)('review retains a pre-stage branch owner after %s and failed cleanup', async mode => {
  const { device, controller, review, fence } = await pausedCaptureReview()
  const captures = await import('../workspace/account-sync-capture'), original = captures.captureAccountSyncWorkspace
  const snapshotCapture = await import('../workspace/account-snapshot'), snapshotOwners = await import('../workspace/snapshot')
  const attempts = vi.fn(), completed = vi.fn()
  let fail = true, branchSnapshot: WorkspaceSnapshot | undefined
  vi.spyOn(captures, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const captured = await original(...args)
    if (!args[3]) return captured
    if (mode === 'fence') await device.db.profileMeta.put({ ...fence, headRevision: fence.headRevision + 1 })
    return { ...captured, async dispose() {
      attempts()
      if (fail) { fail = false; throw new Error('pre-stage cleanup unavailable') }
      await captured.dispose(); completed()
    } }
  })
  if (mode === 'snapshot') vi.spyOn(snapshotCapture, 'captureAccountSnapshot').mockRejectedValueOnce(new Error('snapshot failed'))
  if (mode.endsWith('-preparation')) {
    const capture = snapshotCapture.captureAccountSnapshot, assertOwned = snapshotOwners.assertOwnedWorkspaceSnapshot
    vi.spyOn(snapshotCapture, 'captureAccountSnapshot').mockImplementationOnce(async (...args) => { branchSnapshot = await capture(...args); return branchSnapshot })
    vi.spyOn(snapshotOwners, 'assertOwnedWorkspaceSnapshot').mockImplementation(async snapshot => {
      if (snapshot === branchSnapshot) throw new Error('branch preparation failed')
      return assertOwned(snapshot)
    })
  }
  const pending = await device.db.outbox.toArray(), commits = service!.commits.length
  const action = mode === 'latest-preparation' ? 'prepareLatest' : 'approve'
  await expect(controller[action](review, accountLocalId())).rejects.toThrow('pre-stage cleanup unavailable')
  expect(attempts).toHaveBeenCalledOnce()
  expect(completed).not.toHaveBeenCalled()
  await review.dispose()
  await review.dispose()
  expect(attempts).toHaveBeenCalledTimes(2)
  expect(completed).toHaveBeenCalledOnce()
  expect(service!.commits.length).toBe(commits)
  expect(await device.db.outbox.toArray()).toEqual(pending)
  await expect(controller.approve(review, accountLocalId())).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
})

it.each([false, true])('review disposal waits for a late branch owner and can retry cleanup (failure=%s)', async failCleanup => {
  const { device, controller, review, fence } = await pausedCaptureReview()
  const captures = await import('../workspace/account-sync-capture'), original = captures.captureAccountSyncWorkspace
  let unblock!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const completed = vi.fn(), attempts = vi.fn()
  let fail = failCleanup
  vi.spyOn(captures, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const captured = await original(...args)
    if (!args[3]) return captured
    entered(); await gate
    return { ...captured, async dispose() {
      attempts()
      if (fail) { fail = false; throw new Error('late owner cleanup unavailable') }
      await captured.dispose(); completed()
    } }
  })
  const commits = service!.commits.length, pending = await device.db.outbox.toArray()
  const action = controller.approve(review, accountLocalId()).then(() => undefined, error => error)
  await ready
  let disposed = false
  const disposal = review.dispose().then(() => { disposed = true; return undefined }, error => { disposed = true; return error })
  await new Promise(resolve => setTimeout(resolve, 0))
  const disposedBeforeCapture = disposed, releasesBeforeCapture = completed.mock.calls.length
  unblock()
  const actionError = await action
  const disposalError = await disposal
  expect(disposedBeforeCapture).toBe(false)
  expect(releasesBeforeCapture).toBe(0)
  expect(actionError).toMatchObject({ message: expect.stringContaining(failCleanup ? 'late owner cleanup unavailable' : 'LOCAL_INTEGRITY_FAILED') })
  if (failCleanup) {
    expect(disposalError).toBeInstanceOf(AggregateError)
    expect(completed).not.toHaveBeenCalled()
    await expect(review.dispose()).resolves.toBeUndefined()
  } else expect(disposalError).toBeUndefined()
  expect(attempts).toHaveBeenCalledTimes(failCleanup ? 2 : 1)
  expect(completed).toHaveBeenCalledOnce()
  expect(await device.db.profileMeta.get('active')).toEqual(fence)
  expect(await device.db.outbox.toArray()).toEqual(pending)
  expect(service!.commits.length).toBe(commits)
})

it.each(['pending-publication', 'selected-workspace'] as const)('passes exact operation proofs through the %s outbox branch', async mode => {
  const { device } = await start()
  if (mode === 'selected-workspace') expect((await device.settle()).state).toBe('synced')
  await prepareManagedSync(device.db, device.token)
  await appendLocalOriginal(device)
  const captures = await import('../workspace/account-sync-capture')
  const graph = await import('../workspace/account-graph')
  const projections = await import('../account/sync/projection')
  const recapture = vi.spyOn(captures, 'captureAccountSyncWorkspace')
  const prepare = vi.spyOn(graph, 'prepareAccountWorkspaceWithExistingEvidence')
  const readback = vi.spyOn(graph, 'openAccountWorkspace')
  const project = vi.spyOn(projections, 'captureRemoteProjection')
  const result = await runSyncIteration(device.token, new AbortController().signal)
  expect(result.moreWork).toBe(true)
  expect(recapture).toHaveBeenCalledOnce()
  const captured = await recapture.mock.results[0].value
  expect(captured.inheritedEvidence).not.toEqual(captured.workspace.inheritedEvidence)
  const matching = prepare.mock.calls.find(args => args[3] === captured.publicationValidatedEvidence && args[7] === captured.validatedEvidence)
  expect(matching).toBeDefined()
  const prepared = await prepare.mock.results[prepare.mock.calls.indexOf(matching!)].value
  expect(prepared.validatedEvidence).toBe(captured.publicationValidatedEvidence)
  if (mode === 'pending-publication') expect(readback.mock.calls.some(args => args[2].revisionId === prepared.head.revisionId && args[3] === captured.publicationValidatedEvidence)).toBe(true)
  expect(project.mock.calls.some(args => args[5] === captured.validatedEvidence && args[6] === captured.publicationValidatedEvidence)).toBe(true)
  await expect(captured.validatedEvidence!.check()).rejects.toThrow()
  await expect(captured.publicationValidatedEvidence!.check()).rejects.toThrow()
})

async function unpulledHistoryDevice() {
  const { device } = await start()
  expect((await device.settle()).state).toBe('synced')
  return service!.device(1)
}

it('passes freshly admitted remote evidence through real initial managed adoption without reopening it', async () => {
  const device = await unpulledHistoryDevice()
  const evidence = await import('../workspace/account-evidence-snapshots')
  const managed = await import('../workspace/account-managed-projection')
  const projections = await import('../account/sync/projection')
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence'), prepare = managed.prepareManagedAccountProjection
  const captures = vi.spyOn(projections, 'captureRemoteProjection')
  const adoption = vi.spyOn(managed, 'prepareManagedAccountProjection').mockImplementation(async (...args) => {
    const proof = args[3].validatedEvidence
    expect(proof).toBeDefined()
    expect(proof!.root).toEqual(args[3].opened.inheritedEvidence)
    await evidence.assertAccountInheritedEvidenceOwner(proof!, args[0], args[1])
    const admitted = open.mock.calls.length
    const result = await prepare(...args)
    expect(open).toHaveBeenCalledTimes(admitted)
    await proof!.check()
    return result
  })
  expect((await device.settle()).state).toBe('synced')
  expect(adoption).toHaveBeenCalledOnce()
  expect((await (await device.open()).readWorkspace()).editorDocuments[0].filename).toBe('replacement')
  const owned = await Promise.all(captures.mock.results.map(result => result.value))
  expect(owned.some(value => value.validatedEvidence === adoption.mock.calls[0][3].validatedEvidence)).toBe(true)
  for (const value of owned) if (value.validatedEvidence) await expect(value.validatedEvidence.check()).rejects.toThrow('released')
})

it.each(['different-remote-proof', 'existing-native-proof'] as const)('preserves managed adoption ownership with %s', async mode => {
  const device = await unpulledHistoryDevice()
  const evidence = await import('../workspace/account-evidence-snapshots'), projections = await import('../account/sync/projection')
  const graph = await import('../workspace/account-graph'), managed = await import('../workspace/account-managed-projection')
  const capture = projections.captureRemoteProjection, prepare = graph.prepareAccountWorkspace, adopt = managed.prepareManagedAccountProjection
  let supplied: import('../workspace/account-evidence-snapshots').AccountInheritedEvidence | undefined
  let dispose: (() => Promise<void>) | undefined
  if (mode === 'different-remote-proof') vi.spyOn(projections, 'captureRemoteProjection').mockImplementation(async (...args) => {
    const value = await capture(...args)
    const different = await evidence.createAccountInheritedEvidencePreparation(args[0], args[1]).prepare({})
    supplied = different.handle; dispose = () => different.dispose()
    return { ...value, validatedEvidence: different.handle, async dispose() { try { await value.dispose() } finally { await different.dispose() } } }
  })
  else vi.spyOn(graph, 'prepareAccountWorkspace').mockImplementation(async (...args) => {
    const value = await prepare(...args)
    if (!value.opened.inheritedEvidence) return value
    supplied = await evidence.openAccountInheritedEvidence(args[0], args[1], value.opened.inheritedEvidence)
    dispose = () => supplied!.dispose()
    return { ...value, validatedEvidence: supplied }
  })
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  const adoption = vi.spyOn(managed, 'prepareManagedAccountProjection').mockImplementation(async (...args) => {
    if (mode === 'different-remote-proof') expect(args[3].validatedEvidence).toBeUndefined()
    else expect(args[3].validatedEvidence).toBe(supplied)
    const before = open.mock.calls.length
    const value = await adopt(...args)
    expect(open.mock.calls.length - before).toBe(mode === 'different-remote-proof' ? 1 : 0)
    return value
  })
  try {
    expect((await device.settle()).state).toBe('synced')
    expect(adoption).toHaveBeenCalledOnce()
    if (mode === 'existing-native-proof') await supplied!.check()
  } finally { await dispose?.() }
})

it.each(['superseded', 'failed-successor', 'null-successor', 'partial-page', 'activation-error'] as const)('releases real remote projection captures after %s', async mode => {
  const device = await unpulledHistoryDevice()
  const projections = await import('../account/sync/projection'), pull = await import('../account/sync/pull')
  const capture = projections.captureRemoteProjection, stage = pull.stagePull, successor = projections.assertProjectionSuccessor
  const owned: Awaited<ReturnType<typeof capture>>[] = []
  vi.spyOn(projections, 'captureRemoteProjection').mockImplementation(async (...args) => {
    const value = await capture(...args); owned.push(value); return value
  })
  vi.spyOn(projections, 'assertProjectionSuccessor').mockImplementation(async (...args) => {
    if (args[3]) {
      await owned.at(-1)!.validatedEvidence?.check()
      await owned.at(-2)!.validatedEvidence!.check()
      if (mode === 'failed-successor') throw new Error('rejected successor')
    }
    return successor(...args)
  })
  vi.spyOn(pull, 'stagePull').mockImplementation(async (database, token, client, validate, budget) => {
    const result = await stage(database, token, client, async heads => {
      await validate(heads)
      // Exercise repeated real admission while the group validator still owns its predecessor
      if (mode === 'superseded' || mode === 'failed-successor') await validate(heads)
      if (mode === 'null-successor') await validate(new Map())
    }, budget)
    return mode === 'partial-page' && owned.length ? null : result
  })
  if (mode === 'activation-error') vi.spyOn(pull, 'activatePulledState').mockRejectedValue(new Error('activation unavailable'))
  const run = async () => {
    for (let turn = 0; turn < 240; turn++) {
      await prepareManagedSync(device.db, device.token)
      const result = await runSyncIteration(device.token, new AbortController().signal)
      if (owned.length || !result.moreWork) return result
    }
    throw new Error('Initial projection was not admitted')
  }
  if (mode === 'failed-successor' || mode === 'activation-error' || mode === 'null-successor') await expect(run()).rejects.toThrow(mode === 'failed-successor' ? 'rejected successor' : mode === 'null-successor' ? 'INTEGRITY_FAILED' : 'activation unavailable')
  else expect((await run())!.state).toBe(mode === 'partial-page' ? 'syncing' : 'synced')
  expect(owned).toHaveLength(mode === 'superseded' || mode === 'failed-successor' || mode === 'null-successor' ? 2 : 1)
  for (const value of owned) if (value.validatedEvidence) await expect(value.validatedEvidence.check()).rejects.toThrow('released')
})

it.each([false, true])('finishes remote proof retirement before local capture and database cleanup, failing release %s', async failing => {
  const device = await unpulledHistoryDevice()
  const projections = await import('../account/sync/projection'), local = await import('../workspace/account-sync-capture')
  const capture = projections.captureRemoteProjection, captureLocal = local.captureAccountSyncWorkspace
  let release!: () => void, entered!: () => void, localReleased = false, attempts = 0
  const gate = new Promise<void>(resolve => { release = resolve }), retiring = new Promise<void>(resolve => { entered = resolve })
  let observed: Awaited<ReturnType<typeof capture>> | undefined
  let database: Parameters<typeof capture>[0] | undefined
  vi.spyOn(local, 'captureAccountSyncWorkspace').mockImplementation(async (...args) => {
    const value = await captureLocal(...args)
    return { ...value, async dispose() { localReleased = true; await value.dispose() } }
  })
  vi.spyOn(projections, 'captureRemoteProjection').mockImplementation(async (...args) => {
    const value = await capture(...args); database = args[0]
    observed = { ...value, async dispose() {
      if (++attempts === 1) { entered(); await gate; if (failing) throw new Error('retirement unavailable') }
      await value.dispose()
    } }
    return observed
  })
  const pending = device.settle()
  try {
    await retiring
    expect(localReleased).toBe(false)
    expect(database!.isOpen()).toBe(true)
    await observed!.validatedEvidence!.check()
  } finally { release(); await pending.catch(() => {}) }
  if (failing) await expect(pending).rejects.toThrow('Account sync capture cleanup failed')
  else await expect(pending).resolves.toEqual({ state: 'synced', moreWork: false })
  expect(localReleased).toBe(true)
  expect(database!.isOpen()).toBe(false)
  await observed!.dispose()
  await expect(observed!.validatedEvidence!.check()).rejects.toThrow('released')
})
