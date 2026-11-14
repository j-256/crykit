import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { runSyncIteration } from '../account/sync/outbox'
import { createBlankLocalData } from '../domain/local-data'
import { workspace, progress, now } from '../workspace/signin-merge.test-helpers'
import { ownWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import * as reconciliation from '../workspace/signin-reconciliation'

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const controllers: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); await service?.dispose(); service = undefined; vi.restoreAllMocks() })
async function setup(guest = progress('guest'), initial = workspace(createBlankLocalData({ now }))) {
  service = await conflictService()
  const device = await service.device(0, initial)
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true })
  let captures = 0, opens = 0, locals = 0, failOpen = false
  const options: { -readonly [K in keyof reconciliation.SigninReconciliationOptions]: reconciliation.SigninReconciliationOptions[K] } = {
    captureGuest: async () => ({ snapshot: ownWorkspaceSnapshot({ version: 1 as const, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: `capture-${++captures}`, capturedAt: String(captures), revisionVector: { guest: 'instance-one', managedRevision: '1' }, state: guest }, { async check() {}, async dispose() {} }) }),
    run: async (token: typeof device.token, signal: AbortSignal) => { await prepareManagedSync(device.db, token); return runSyncIteration(token, signal) },
    openAccount: async () => { if (failOpen) throw new Error('selection failure'); opens++ },
    continueLocal: async () => { locals++ },
  }
  const create = () => { const controller = reconciliation.createSigninReconciliation(options); controllers.push(controller); return controller }
  return { device, options, create, guest, get opens() { return opens }, get locals() { return locals }, set failOpen(value: boolean) { failOpen = value } }
}
it('fresh remote projection precedes choices and account-only receipt skips unchanged recapture envelopes', async () => {
  expect(typeof reconciliation.createSigninReconciliation).toBe('function')
  const fixture = await setup(), controller = fixture.create()
  const guestBefore = JSON.stringify(fixture.guest)
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().phase).toBe('choosing')
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
it('merge activation survives failed UI selection and exact reload without importing twice', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('confirming')
  fixture.failOpen = true
  await controller.confirm()
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'opening-failed' })
  const fence = await fixture.device.db.profileMeta.get('active')
  const intents = await fixture.device.db.outbox.count()
  await controller.dispose(); fixture.failOpen = false
  const reopened = fixture.create(); await reopened.begin(fixture.device.token)
  expect(reopened.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(fence)
  expect(await fixture.device.db.outbox.count()).toBe(intents)
  expect(fixture.opens).toBe(1)
})

it.each(['absent', 'untouched'] as const)('opens %s local data only after remote preparation', async kind => {
  const fixture = await setup(workspace(createBlankLocalData({ now })))
  if (kind === 'absent') fixture.options.captureGuest = async () => undefined
  const controller = fixture.create()
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.syncState.get('projection')).toBeDefined()
  expect(fixture.opens).toBe(1)
  expect(await fixture.device.db.outbox.count()).toBe(0)
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
it('double confirmation installs only one exact merge and cancellation after activation cannot roll it back', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('merge')
  const one = controller.confirm(), two = controller.confirm()
  expect(two).toBe(one)
  await Promise.all([one, two])
  const fence = await fixture.device.db.profileMeta.get('active')
  expect(await fixture.device.db.outbox.count()).toBe(1)
  await controller.cancel()
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(fixture.locals).toBe(0)
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(fence)
})
it('cancel drains a delayed preparation before returning through the provider local-selection effect', async () => {
  const fixture = await setup()
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const running = new Promise<void>(resolve => { started = resolve })
  fixture.options.run = async () => { started(); await held; return { state: 'synced', moreWork: false } }
  const controller = fixture.create(), beginning = controller.begin(fixture.device.token)
  await running
  const cancelled = controller.cancel()
  await Promise.resolve(); expect(fixture.locals).toBe(0)
  release(); await Promise.all([beginning, cancelled])
  expect(controller.getSnapshot().phase).toBe('cancelled')
  expect(fixture.locals).toBe(1); expect(fixture.opens).toBe(0)
  expect(await fixture.device.db.outbox.count()).toBe(0)
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
it('new empty remote account uses reviewed replacement for device-wins and retains its exact recovery identity', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('device')
  expect(controller.getSnapshot().phase).toBe('confirming')
  await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('complete')
  const { createReviewedReplacementService } = await import('../workspace/reviewed-replacement')
  const authority = await createReviewedReplacementService(fixture.device.db, fixture.device.token).status()
  expect(authority?.state).toBe('active')
  const { createAccountRecoveryService } = await import('../workspace/account-recovery')
  const points = await createAccountRecoveryService(fixture.device.token).list()
  expect(points).toHaveLength(1)
  expect(points[0].operationId).toBe(authority?.recoveryOperationId)
  expect((await (await fixture.device.open()).readWorkspace()).planner.localData.playthroughs).toEqual(fixture.guest.planner.localData.playthroughs)
})

it('paused replacement survives reload and exposes exact private backup and reviewed Use latest', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('device'); await first.confirm(); await first.dispose()
  const other = await service!.device(1, workspace(createBlankLocalData({ now })))
  await other.settle()
  const remote = await (await other.open()).readWorkspace()
  await (await other.open()).commitWorkspace({ ...remote, planner: { ...remote.planner, localData: { ...remote.planner.localData, modSetup: { version: 1, state: 'completed' } } } }, remote.planner.localData.revision)
  await other.settle()
  const resumed = await service!.device(0)
  expect((await resumed.settle()).state).toBe('paused')
  const controller = fixture.create(); await controller.begin(resumed.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'choosing', replacement: { state: 'paused' } })
  const before = await resumed.db.profileMeta.get('active')
  await controller.choose('account')
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'replacement-review-required' })
  expect(await resumed.db.profileMeta.get('active')).toEqual(before)
  await controller.withPrivateBackup(async snapshot => { expect(snapshot.state.planner.localData.playthroughs).toEqual(fixture.guest.planner.localData.playthroughs) })
  expect(await resumed.db.profileMeta.get('active')).toEqual(before)
  await controller.reviewReplacement('latest'); await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('complete')
  expect((await (await resumed.open()).readWorkspace()).planner.localData.modSetup?.state).toBe('completed')
  expect(await resumed.db.outbox.count()).toBe(0)
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

it('exact saved Merge resumes after activation failure with the same copy identity', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('merge')
  const copyId = first.getSnapshot().preview!.copyId
  const activation = await import('./account-database')
  const failure = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'))
  const before = await fixture.device.db.profileMeta.get('active')
  await first.confirm(); failure.mockRestore()
  expect(first.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'quota' })
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  expect(await fixture.device.db.outbox.count()).toBe(0)
  await first.dispose()
  const resumed = fixture.create(); await resumed.begin(fixture.device.token)
  expect(resumed.getSnapshot()).toMatchObject({ phase: 'confirming', preview: { copyId } })
  await resumed.confirm()
  expect(resumed.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.outbox.count()).toBe(1)
  expect(await fixture.device.db.migrationJournal.get(copyId)).toBeDefined()
})
it('device preparation restarts with envelope-only recapture and reuses the sealed recovery after lost response', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('device')
  const fetch = globalThis.fetch
  let lost = false
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await fetch(path, init)
    if (path.endsWith('/seal') && response.ok && !lost) { lost = true; throw new TypeError('lost sealing response') }
    return response
  })
  await first.confirm(); expect(first.getSnapshot().phase).toBe('failed')
  vi.stubGlobal('fetch', fetch)
  const { createReviewedReplacementService } = await import('../workspace/reviewed-replacement')
  const replacements = createReviewedReplacementService(fixture.device.db, fixture.device.token)
  const [preparation] = await replacements.preparations()
  expect(preparation).toBeDefined()
  await first.dispose()
  const resumed = fixture.create(); await resumed.begin(fixture.device.token)
  expect(resumed.getSnapshot().phase).toBe('confirming')
  await resumed.confirm()
  expect(resumed.getSnapshot().phase).toBe('complete')
  expect((await replacements.status())?.recoveryOperationId).toBe(preparation.operationId)
  const { createAccountRecoveryService } = await import('../workspace/account-recovery')
  expect(await createAccountRecoveryService(fixture.device.token).list()).toHaveLength(1)
})
it('completed Merge reopening fails closed when its original activation proof is missing', async () => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('merge')
  const copyId = first.getSnapshot().preview!.copyId
  await first.confirm(); await first.dispose()
  await fixture.device.db.migrationJournal.delete(copyId)
  const before = await fixture.device.db.profileMeta.get('active')
  const controller = fixture.create(); await controller.begin(fixture.device.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'receipt-mismatch' })
  expect(fixture.opens).toBe(1)
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  expect(await fixture.device.db.outbox.count()).toBe(1)
})

it('cancellation preserves uncertain sealed recovery cleanup and records that uncertainty durably', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('device')
  const fetch = globalThis.fetch
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await fetch(path, init)
    if (path.endsWith('/seal') && response.ok) throw new TypeError('lost seal acknowledgment')
    return response
  })
  const before = await fixture.device.db.profileMeta.get('active')
  await controller.confirm(); vi.stubGlobal('fetch', fetch)
  await controller.cancel()
  expect(controller.getSnapshot()).toMatchObject({ phase: 'cancelled', cleanupPending: true, reason: 'cleanup-pending' })
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  const { openAccountJson } = await import('../workspace/account-cache')
  const row = (await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
  expect(await openAccountJson(fixture.device.db, fixture.device.token, row.ref, reconciliation.SigninDecisionSchema)).toMatchObject({ status: 'cancelled', cleanupPending: true })
  expect(fixture.locals).toBe(1); expect(fixture.opens).toBe(0)
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

it.each(['returns', 'throws'] as const)('cancel releases source and review before provider handoff when committed activation %s late', async completion => {
  const fixture = await setup()
  const snapshots = await import('../workspace/snapshot')
  const replacements = await import('../workspace/reviewed-replacement')
  const createReplacement = replacements.createReviewedReplacementService
  let review: Awaited<ReturnType<ReturnType<typeof createReplacement>['refresh']>> | undefined
  vi.spyOn(replacements, 'createReviewedReplacementService').mockImplementation((database, token) => {
    const service = createReplacement(database, token)
    return { ...service, async refresh() { const current = await service.refresh(); review ??= current; return current } }
  })
  const capture = fixture.options.captureGuest!
  let source: WorkspaceSnapshot | undefined, released = false
  fixture.options.captureGuest = async () => {
    const original = (await capture())!
    source = ownWorkspaceSnapshot(original.snapshot, {
      async check() { if (released) throw new Error('source released'); await snapshots.assertOwnedWorkspaceSnapshot(original.snapshot) },
      async dispose() { await snapshots.disposeWorkspaceSnapshot(original.snapshot); released = true },
    })
    return { snapshot: source }
  }
  const observed: { source: string; review: string }[] = []
  fixture.options.openAccount = async () => {
    const status = (snapshot: WorkspaceSnapshot) => snapshots.assertOwnedWorkspaceSnapshot(snapshot).then(() => 'live', error => (error as Error).message)
    observed.push({ source: await status(source!), review: await status(review!.snapshot) })
  }
  const controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  const activation = await import('./account-database')
  const activate = activation.activateLocalAccountCommit
  let release!: () => void, committed!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const durable = new Promise<void>(resolve => { committed = resolve })
  vi.spyOn(activation, 'activateLocalAccountCommit').mockImplementationOnce(async (...args) => {
    const result = await activate(...args)
    committed(); await held
    if (completion === 'throws') throw new Error('interrupted after durable activation')
    return result
  })
  const confirming = controller.confirm()
  try {
    await durable
    const fence = await fixture.device.db.profileMeta.get('active')
    const intent = await fixture.device.db.outbox.toArray()
    const journal = await fixture.device.db.migrationJournal.get(copyId)
    expect(intent).toHaveLength(1); expect(journal).toBeDefined()
    expect(observed).toEqual([])
    const cancelling = controller.cancel()
    await Promise.resolve(); expect(observed).toEqual([])
    release(); await Promise.all([confirming, cancelling])
    expect(observed).toEqual([{ source: 'source released', review: 'Backup snapshot was released' }])
    expect(controller.getSnapshot().phase).toBe('complete')
    expect(fixture.locals).toBe(0)
    expect(await fixture.device.db.profileMeta.get('active')).toEqual(fence)
    expect(await fixture.device.db.outbox.toArray()).toEqual(intent)
    expect(await fixture.device.db.migrationJournal.get(copyId)).toEqual(journal)
  } finally { release(); await confirming }
})
