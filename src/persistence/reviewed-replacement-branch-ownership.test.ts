import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import type { conflictService } from './sync-conflict-fixture'
import { accountLocalId } from '../workspace/account-cache'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { createReviewedReplacementFixture } from './reviewed-replacement.test-helpers'

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const snapshots: WorkspaceSnapshot[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const snapshot of snapshots.splice(0)) await disposeWorkspaceSnapshot(snapshot); await service?.dispose(); service = undefined })
const { start, appendLocalOriginal } = createReviewedReplacementFixture(snapshots, fixture => { service = fixture })

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
