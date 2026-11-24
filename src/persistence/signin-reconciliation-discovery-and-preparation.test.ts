import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { runSyncIteration } from '../account/sync/outbox'
import { createBlankLocalData } from '../domain/local-data'
import { workspace, progress, now } from '../workspace/signin-merge.test-helpers'
import { ownWorkspaceSnapshot } from '../workspace/snapshot'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import * as reconciliation from '../workspace/signin-reconciliation'
import { createSigninReconciliationSetup, interruptMergeActivation } from './signin-reconciliation.test-helpers'

vi.mock('../workspace/signin-merge-client', () => import('./signin-merge-client.test-mock'))

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const controllers: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); await service?.dispose(); service = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const setup = createSigninReconciliationSetup(fixture => { service = fixture }, controllers)

it('fresh remote projection precedes choices and account-only receipt skips unchanged recapture envelopes', async () => {
  expect(typeof reconciliation.createSigninReconciliation).toBe('function')
  const fixture = await setup(), controller = fixture.create()
  const guestBefore = JSON.stringify(fixture.guest)
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().phase).toBe('choosing')
  expect(controller.getSnapshot().local?.recordNames).toMatchObject({ '["progress","play","guest"]': 'Run / Class', '["inventory","play"]': 'Run', '["playthrough","play"]': 'Run' })
  expect(await fixture.device.db.syncState.get('projection')).toBeDefined()
  expect((await (await fixture.device.open()).readWorkspace()).planner.localData.playthroughs).toEqual({})
  const before = await fixture.device.db.profileMeta.get('active')
  await controller.choose('account')
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(fixture.opens).toBe(1)
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  expect(await fixture.device.db.outbox.count()).toBe(0)
  expect(JSON.stringify(fixture.guest)).toBe(guestBefore)
  await controller.dispose()
  const reopened = fixture.create(); await reopened.begin(fixture.device.token)
  expect(reopened.getSnapshot().phase).toBe('complete')
  expect(fixture.opens).toBe(2)
})

it('publishes actual preparation boundaries and clears feedback when review is ready', async () => {
  const fixture = await setup(), controller = fixture.create()
  const observed: reconciliation.SigninReconciliationState[] = []
  controller.subscribe(() => observed.push(controller.getSnapshot()))
  await controller.begin(fixture.device.token)
  expect(observed.map(value => value.stage)).toEqual(expect.arrayContaining(['reading-source', 'syncing-account', 'checking-account']))
  expect(controller.getSnapshot().stage).toBeUndefined()
  observed.length = 0
  await controller.choose('merge')
  expect(observed.map(value => value.stage).filter((stage, index, stages) => stage && stage !== stages[index - 1])).toEqual(['checking-source', 'checking-account', 'comparing-records'])
  expect(controller.getSnapshot()).toMatchObject({ phase: 'confirming', action: 'merge' })
  expect(controller.getSnapshot().stage).toBeUndefined()
  expect(await fixture.device.db.outbox.count()).toBe(0)
})

it.each(['absent', 'untouched'] as const)('opens %s local data only after remote preparation', async kind => {
  const fixture = await setup(workspace(createBlankLocalData({ now })))
  if (kind === 'absent') fixture.options.captureGuest = async () => undefined
  const capture = vi.spyOn(await import('../workspace/account-snapshot'), 'captureAccountSnapshot')
  const admit = vi.spyOn(await import('../workspace/snapshot-admission'), 'admitWorkspaceMetadata')
  const { openAccountJson } = await import('../workspace/account-cache')
  const controller = fixture.create(), { db, token } = fixture.device
  await controller.begin(token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'complete', fresh: false })
  expect(controller.getSnapshot().account).toBeUndefined()
  expect(fixture.opens).toBe(1)
  expect(await db.outbox.count()).toBe(0)
  const selected = (await db.syncState.get('projection'))!
  expect((await db.syncState.get('remote'))?.ref).toEqual(selected.ref)
  const row = (await db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
  expect(await openAccountJson(db, token, row.ref, reconciliation.SigninDecisionSchema)).toMatchObject({ action: 'account', status: 'complete' })
  expect((await db.encryptedRevisions.get(row.ref.revisionId))?.descriptor.dependencies).toEqual([(await db.profileMeta.get('active'))!.head])
  expect(capture).toHaveBeenCalled()
  const accountSnapshot = await capture.mock.results.at(-1)!.value
  expect(admit.mock.calls.some(([snapshot]) => snapshot === accountSnapshot)).toBe(false)
  await controller.dispose()
  capture.mockClear()
  await fixture.create().begin(token)
  expect(fixture.opens).toBe(2)
  expect(await db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toEqual(row)
  expect(capture).not.toHaveBeenCalled()
})

it.each(['projection', 'remote', 'fence', 'reviewed-replacement', 'publication', 'guest-copy:pending', 'outbox', 'decision'] as const)('refuses an automatic receipt if %s changes during receipt staging', async change => {
  const fixture = await setup()
  fixture.options.captureGuest = async () => undefined
  const receipts = await import('./account-activation-attachments')
  const prepare = receipts.prepareAccountReceiptAttachment
  vi.spyOn(receipts, 'prepareAccountReceiptAttachment').mockImplementationOnce(async (...args) => {
    const attachment = await prepare(...args)
    const { db } = fixture.device
    const fence = (await db.profileMeta.get('active'))!
    if (change === 'projection' || change === 'remote') await db.syncState.delete(change)
    else if (change === 'fence') await db.profileMeta.put({ ...fence, headRevision: fence.headRevision + 1 })
    else if (change === 'outbox') await db.outbox.add({ id: 'concurrent-intent', ref: fence.head, status: 'unmapped-local' })
    else await db.syncState.put({ id: change === 'decision' ? reconciliation.SIGNIN_DECISION_KEY : change, ref: fence.head })
    return attachment
  })
  const controller = fixture.create()
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'review-stale' })
  expect(fixture.opens).toBe(0)
  const row = await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)
  if (change === 'decision') expect(row?.ref).toEqual((await fixture.device.db.profileMeta.get('active'))!.head)
  else expect(row).toBeUndefined()
})

it('refuses an automatic receipt after a known empty guest capture loses its source', async () => {
  const fixture = await setup(workspace(createBlankLocalData({ now })))
  let changed = false, releases = 0
  fixture.options.captureGuest = async () => ({
    snapshot: ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'empty', capturedAt: now, revisionVector: { guest: 'original' }, state: fixture.guest }, {
      async check() { if (changed) throw new Error('SIGNIN_SOURCE_CHANGED') },
      async dispose() { releases++ },
    }),
  })
  const receipts = await import('./account-activation-attachments')
  const prepare = receipts.prepareAccountReceiptAttachment
  vi.spyOn(receipts, 'prepareAccountReceiptAttachment').mockImplementationOnce(async (...args) => {
    const attachment = await prepare(...args)
    changed = true
    return attachment
  })
  const controller = fixture.create()
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', source: 'available', reason: 'source-changed' })
  expect(fixture.opens).toBe(0)
  expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  await controller.dispose()
  expect(releases).toBe(1)
})

it('fresh discovery refuses an automatic receipt when a second device publishes after the settled iteration', async () => {
  const fixture = await setup()
  fixture.options.captureGuest = async () => undefined
  await fixture.device.settle()
  const other = await service!.device(1, workspace(createBlankLocalData({ now })))
  await other.settle()
  const repository = await other.open(), remote = await repository.readWorkspace()
  await repository.commitWorkspace({ ...remote, planner: { ...remote.planner, localData: { ...remote.planner.localData, modSetup: { version: 1, state: 'completed' } } } }, remote.planner.localData.revision)

  const { SyncClient } = await import('../account/sync/client')
  const commit = SyncClient.prototype.commit, held = new Error('Hold the second device publication')
  let publication: Parameters<typeof commit>[0] | undefined
  // All mapping, uploads, and registration run normally; only the final head publication waits for the first device
  const stop = vi.spyOn(SyncClient.prototype, 'commit').mockImplementation(function (this: InstanceType<typeof SyncClient>, input) {
    if (!input.heads.length) return commit.call(this, input)
    publication = input
    return Promise.reject(held)
  })
  try { await expect(other.settle()).rejects.toBe(held) } finally { stop.mockRestore() }
  if (!publication) throw new Error('Second device did not stage a publication')
  const ready = publication
  const first = await service!.device(0)
  const { readRemoteState } = await import('../account/sync/pull')
  let epochs: { selected: number; published: number } | undefined
  const { EncryptedOutbox, transferBudget } = await import('../account/sync/outbox')
  const sender = new EncryptedOutbox(other.db, first.token)
  fixture.options.run = async (token, signal) => {
    await prepareManagedSync(first.db, token)
    const outcome = await runSyncIteration(token, signal)
    if (outcome.state === 'synced' && !epochs) {
      const selected = (await readRemoteState(first.db, token))!.value.publicationEpoch
      // Resume the original durable command and its real server continuation using the same account session
      const receipt = await sender.advance(ready.mutationId, new SyncClient(token, signal), transferBudget())
      if (!receipt) return { state: 'syncing', moreWork: true }
      epochs = { selected, published: receipt.publicationEpoch }
    }
    return outcome
  }
  const controller = fixture.create()
  await controller.begin(first.token)
  expect(epochs, controller.getSnapshot().reason).toBeDefined()
  expect(epochs!.published).toBe(epochs!.selected + 1)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', fresh: false, reason: 'review-stale' })
  expect(fixture.opens).toBe(0)
  expect(await first.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
})

it('changed content and restored source instance do not inherit a prior account-only approval', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('account'); await first.dispose()
  const capture = fixture.options.captureGuest!
  fixture.options.captureGuest = async () => {
    const value = (await capture())!
    return { snapshot: ownWorkspaceSnapshot({ ...value.snapshot, revisionVector: { guest: 'restored-instance', managedRevision: '1' } }, { async check() {}, async dispose() {} }) }
  }
  const restored = fixture.create(); await restored.begin(fixture.device.token)
  expect(restored.getSnapshot().phase).toBe('choosing'); expect(fixture.opens).toBe(1)
  await restored.dispose(); fixture.options.captureGuest = capture
  Object.assign(fixture.guest.planner.localData, { modSetup: { version: 1, state: 'completed' } })
  const edited = fixture.create(); await edited.begin(fixture.device.token)
  expect(edited.getSnapshot().phase).toBe('choosing'); expect(fixture.opens).toBe(1)
})

it('fresh offline cache is not admission while an exact completed decision can open offline', async () => {
  const fixture = await setup(), first = fixture.create()
  vi.stubGlobal('navigator', { onLine: false })
  await first.begin(fixture.device.token)
  expect(first.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'offline', fresh: false })
  await first.choose('account'); expect(fixture.opens).toBe(0)
  vi.stubGlobal('navigator', { onLine: true })
  await first.retry(); await first.choose('account'); await first.dispose()
  vi.stubGlobal('navigator', { onLine: false })
  const offline = fixture.create(); await offline.begin(fixture.device.token)
  expect(offline.getSnapshot().phase).toBe('complete'); expect(fixture.opens).toBe(2)
})

it('an unrelated pending saved copy blocks fresh Merge but keeps account-only opening available', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const activation = await import('./account-database')
  const manual = createGuestCopyService(async () => (await fixture.options.captureGuest!())!)
  const preview = await manual.previewSigninMerge(fixture.device.token)
  const failure = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('interrupted manual operation'))
  await expect(manual.commitGuestCopy(fixture.device.token, preview)).rejects.toThrow('interrupted manual operation')
  failure.mockRestore(); await manual.dispose()
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('failed')
  expect(await fixture.device.db.outbox.count()).toBe(0)
  await controller.choose('account')
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeDefined()
})

it('cancelled prepared choices do not silently reopen as confirmation after reload', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('device'); await first.cancel(); await first.dispose()
  const controller = fixture.create(); await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().phase).toBe('choosing')
  expect(fixture.locals).toBe(1); expect(fixture.opens).toBe(0)
})

it('prompt groups Progress by exact Playthrough identity and keeps unavailable source counts unknown', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().local?.progressByPlaythrough).toEqual([{ playthroughId: 'play', label: 'Run', count: 1 }])
  await controller.dispose()
  fixture.options.captureGuest = async () => { throw new Error('unsupported private source content') }
  const unreadable = fixture.create(); await unreadable.begin(fixture.device.token)
  expect(unreadable.getSnapshot()).toMatchObject({ phase: 'choosing', source: 'unavailable' })
  expect(unreadable.getSnapshot().local).toBeUndefined()
  await unreadable.choose('account'); expect(unreadable.getSnapshot().phase).toBe('complete')
})

it('a profile switch during source capture cannot open or write for the old account', async () => {
  const fixture = await setup()
  const capture = fixture.options.captureGuest!
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  fixture.options.captureGuest = async () => { entered(); await held; return capture() }
  const controller = fixture.create(), pending = controller.begin(fixture.device.token)
  await started
  const { invalidateProfile, installProfile, currentProfileToken } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  invalidateProfile()
  const next = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  release(); await pending
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'profile-changed' })
  expect(controller.getSnapshot().stage).toBeUndefined()
  expect(currentProfileToken()).toBe(next)
  expect(fixture.opens).toBe(0); expect(fixture.locals).toBe(0)
  expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
})

it('the same guest source still prompts for a different authenticated account', async () => {
  const first = await setup(), controller = first.create()
  await controller.begin(first.device.token); await controller.choose('account'); await controller.dispose()
  const originalAccount = first.device.token.accountId
  await service!.dispose(); service = undefined
  const second = await setup(first.guest), next = second.create()
  expect(second.device.token.accountId).not.toBe(originalAccount)
  await next.begin(second.device.token)
  expect(next.getSnapshot().phase).toBe('choosing')
  expect(second.opens).toBe(0)
})

it('cancel also waits for an owner retired before the coordinator database opens', async () => {
  const fixture = await setup()
  const { attachSyncScheduler } = await import('../account/sync/scheduler')
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  attachSyncScheduler(fixture.device.token, async () => { entered(); await held; return { state: 'synced', moreWork: false } })
  await started
  const controller = fixture.create(), beginning = controller.begin(fixture.device.token)
  await Promise.resolve()
  const cancelled = controller.cancel()
  await Promise.resolve(); expect(fixture.locals).toBe(0)
  release(); await Promise.all([beginning, cancelled])
  expect(controller.getSnapshot().phase).toBe('cancelled')
  expect(fixture.locals).toBe(1); expect(fixture.opens).toBe(0)
})

it('fresh remote discovery cannot authorize Merge against an older retained account projection', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('merge')
  const activation = await import('./account-database')
  const interruption = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'))
  await first.confirm(); interruption.mockRestore(); await first.dispose()
  const other = await service!.device(1, workspace(createBlankLocalData({ now })))
  await other.settle()
  const remote = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...remote, planner: { ...remote.planner, localData: { ...remote.planner.localData, modSetup: { version: 1, state: 'completed' } } } }, remote.planner.localData.revision)
  await other.settle()
  const resumed = await service!.device(0)
  const before = await resumed.db.profileMeta.get('active')
  const pending = await resumed.db.syncState.get('guest-copy:pending')
  const controller = fixture.create(); await controller.begin(resumed.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', fresh: false, canOpenAccount: true, reason: 'review-stale' })
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('failed')
  expect(await resumed.db.profileMeta.get('active')).toEqual(before)
  expect(await resumed.db.syncState.get('guest-copy:pending')).toEqual(pending)
  await controller.choose('account')
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(await resumed.db.profileMeta.get('active')).toEqual(before)
})

it('automatically prepares a missing mapping once with visible feedback before retrying worker review', async () => {
  const f = await setup(), controller = f.create(), client = await import('../workspace/signin-merge-client'), mapping = await import('../workspace/account-local-mapping-client')
  await controller.begin(f.device.token)
  const start = vi.spyOn(client, 'createSigninMergeClient').mockRejectedValueOnce(new Error('SIGNIN_MAPPING_REQUIRED'))
  const prepare = vi.spyOn(mapping, 'mapIncrementalAccountBaseline')
  const stages: unknown[] = []; controller.subscribe(() => stages.push(controller.getSnapshot().stage))
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('confirming')
  expect(stages).toContain('preparing-mapping')
  expect(start).toHaveBeenCalledTimes(2)
  expect(prepare).toHaveBeenCalledOnce()
})

it('does not fall back to caller preparation when the guest worker fails', async () => {
  const f = await setup(), client = await import('../workspace/signin-merge-client')
  vi.spyOn(client, 'createSigninMergeClient').mockRejectedValueOnce(new Error('SIGNIN_PREPARATION_FAILED'))
  const controller = f.create(); await controller.begin(f.device.token)
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('failed')
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
})

function locateSource(fixture: Awaited<ReturnType<typeof setup>>) {
  const capture = fixture.options.captureGuest!
  fixture.options.captureGuest = async () => {
    const source = await capture()
    return source && { ...source, locator: { databaseName: 'synthetic-coordinator-source', manifest: { version: 3, id: 'synthetic', revision: 1, root: { documentId: 'root', revisionId: 'revision' } } } }
  }
  const workers: Worker[] = []
  const create = vi.fn(function () {
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onerror: null, onmessageerror: null, onmessage: null } as unknown as Worker
    workers.push(worker)
    return worker
  })
  vi.stubGlobal('Worker', create)
  return { create, workers }
}

it.each(['account', 'device', 'cancel', 'dispose'] as const)('loads before account discovery without merge writes and retires on %s', async action => {
  const f = await setup(), { create, workers } = locateSource(f)
  const run = f.options.run!
  f.options.run = async (...args) => {
    expect(create).toHaveBeenCalledOnce()
    expect(workers[0].postMessage).not.toHaveBeenCalled()
    expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
    expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
    expect(await f.device.db.outbox.count()).toBe(0)
    return run(...args)
  }
  const controller = f.create(); await controller.begin(f.device.token)
  expect(controller.getSnapshot().phase).toBe('choosing')
  expect(create).toHaveBeenCalledOnce()
  expect(workers[0].postMessage).not.toHaveBeenCalled()
  if (action === 'cancel' || action === 'dispose') await controller[action]()
  else await controller.choose(action)
  expect(workers[0].terminate).toHaveBeenCalledOnce()
})

it('surfaces an asynchronous prewarm load failure and retries with one fresh uninitialized module', async () => {
  const f = await setup(), { create, workers } = locateSource(f), controller = f.create()
  await controller.begin(f.device.token)
  workers[0].onerror?.call(workers[0], new Event('error') as ErrorEvent)
  await controller.choose('merge')
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'preparation-failed' })
  expect(create).toHaveBeenCalledOnce()
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
  await controller.retry()
  expect(controller.getSnapshot().phase).toBe('choosing')
  expect(create).toHaveBeenCalledTimes(2)
  expect(workers[1].postMessage).not.toHaveBeenCalled()
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('confirming')
  expect(create).toHaveBeenCalledTimes(2)
  await controller.cancel()
  expect(workers[1].terminate).toHaveBeenCalledOnce()
})

it.each(['absent', 'empty', 'recovery', 'completed', 'saved'] as const)('does not prewarm an ineligible %s journey', async mode => {
  const f = await setup(mode === 'empty' ? workspace(createBlankLocalData({ now })) : progress('guest'))
  if (mode === 'completed' || mode === 'saved') {
    const first = f.create(); await first.begin(f.device.token)
    if (mode === 'completed') await first.choose('account')
    else { await first.choose('merge'); await interruptMergeActivation(first) }
    await first.dispose()
  }
  if (mode === 'absent') f.options.captureGuest = async () => undefined
  if (mode === 'recovery') f.options.entry = { kind: 'recovery', pointId: 'AAAAAAAAAAAAAAAAAAAAAA' }
  const { create } = locateSource(f), controller = f.create()
  await controller.begin(f.device.token)
  expect(controller.getSnapshot().phase).toBe(mode === 'saved' ? 'confirming' : mode === 'recovery' ? 'choosing' : 'complete')
  expect(create).not.toHaveBeenCalled()
})

it('releases a warm module when account inspection fails', async () => {
  const f = await setup(), { workers } = locateSource(f)
  vi.stubGlobal('navigator', { onLine: false })
  const controller = f.create(); await controller.begin(f.device.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'offline' })
  expect(workers).toHaveLength(1)
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  expect(workers[0].postMessage).not.toHaveBeenCalled()
})

it('cancels real account capture between catalog digest slices without changing durable selection', async () => {
  const { SYNTHETIC_RETAINED_CATALOG } = await import('../domain/retained-catalog.test-helpers')
  const initial = workspace(createBlankLocalData({ now }))
  const f = await setup(progress('guest'), { ...initial, planner: { ...initial.planner, catalogs: [SYNTHETIC_RETAINED_CATALOG] } })
  const snapshots = await import('../workspace/snapshot'), original = snapshots.backupWorkspaceDocumentDigest
  const controller = f.create()
  let cancellation: Promise<void> | undefined, selected: unknown, intents: unknown, journals: unknown
  vi.spyOn(snapshots, 'backupWorkspaceDocumentDigest').mockImplementation(async (document, checkpoint) => {
    if (document.kind !== 'catalog' || !checkpoint || cancellation) return original(document, checkpoint)
    selected = await f.device.db.profileMeta.get('active')
    intents = await f.device.db.outbox.toArray()
    journals = await f.device.db.migrationJournal.toArray()
    let checks = 0
    return original(document, async () => {
      await checkpoint()
      // The second check precedes the first task yield, so cancellation runs before traversal resumes
      if (++checks === 2) setTimeout(() => { cancellation = controller.cancel() }, 0)
    })
  })
  await controller.begin(f.device.token)
  expect(cancellation).toBeDefined()
  await cancellation
  expect(controller.getSnapshot().phase).toBe('cancelled')
  expect(f.locals).toBe(1)
  expect(await f.device.db.profileMeta.get('active')).toEqual(selected)
  expect(await f.device.db.outbox.toArray()).toEqual(intents)
  expect(await f.device.db.migrationJournal.toArray()).toEqual(journals)
  expect(await f.device.db.syncState.get('signin-receipt:decision')).toBeUndefined()
  expect(await f.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
})

it('cancels fresh account preflight through the real coordinator without selecting an account head', async () => {
  const fixture = await setup(), database = fixture.device.db
  await database.transaction('rw', database.tables, async () => { for (const table of database.tables) await table.clear() })
  const payload = await import('../domain/source-fulfillment'), prepare = payload.prepareSourcePayloadValidation
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(payload, 'prepareSourcePayloadValidation').mockImplementation(async (catalog, check) => { entered(); await held; return prepare(catalog, check) })
  const controller = fixture.create(), beginning = controller.begin(fixture.device.token)
  await waiting
  const cancelling = controller.cancel()
  release()
  await Promise.all([beginning, cancelling])
  expect(fixture.locals).toBe(1)
  expect(await database.profileMeta.get('active')).toBeUndefined()
  expect(await database.outbox.count()).toBe(0)
  expect(await database.migrationJournal.count()).toBe(0)
  expect(await database.encryptedRevisions.count()).toBe(0)
  expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
})
