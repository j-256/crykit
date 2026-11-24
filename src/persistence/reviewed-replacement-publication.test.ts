import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import type { conflictService } from './sync-conflict-fixture'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { runSyncIteration } from '../account/sync/outbox'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { createReviewedReplacementFixture } from './reviewed-replacement.test-helpers'

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const snapshots: WorkspaceSnapshot[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const snapshot of snapshots.splice(0)) await disposeWorkspaceSnapshot(snapshot); await service?.dispose(); service = undefined })
const { start, appendLocalOriginal } = createReviewedReplacementFixture(snapshots, fixture => { service = fixture })

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

it('retains the publication base on an idle poll with the same completed replacement and rejects a changed authority', async () => {
  const { api, device } = await start()
  expect((await device.settle()).state).toBe('synced')
  const terminal = (await api.readReviewedReplacement(device.db, device.token))!
  expect(terminal.value.state).toBe('accepted')
  const base = (await device.db.syncState.get('projection'))!.ref
  expect((await device.settle()).state).toBe('synced')
  expect((await device.db.syncState.get('projection'))?.ref).toEqual(base)
  expect(await device.db.syncState.get(api.REVIEWED_REPLACEMENT_KEY)).toEqual(terminal.row)

  const pull = await import('../account/sync/pull')
  const { writeSyncState } = await import('../account/sync/outbox')
  const activate = pull.activatePulledState
  const gate = vi.spyOn(pull, 'activatePulledState').mockImplementationOnce(async (...args) => {
    const record = (await device.db.encryptedRevisions.get(terminal.row.ref.revisionId))!
    await writeSyncState(device.db, device.token, terminal.row.id, terminal.value, terminal.row, record.descriptor.dependencies)
    return activate(...args)
  })
  try {
    await expect(runSyncIteration(device.token, new AbortController().signal)).rejects.toThrow('LOCAL_REVISION_CONFLICT')
    expect((await device.db.syncState.get('remote'))?.ref).toEqual(base)
    expect(await device.db.syncState.get('scan')).toBeDefined()
  } finally { gate.mockRestore() }
})
