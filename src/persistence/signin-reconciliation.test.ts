import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { prepareManagedSync } from './managed-sync.test-helpers'
import { runSyncIteration, registerSyncProjectionGuard } from '../account/sync/outbox'
import { createBlankLocalData } from '../domain/local-data'
import { workspace, progress, now } from '../workspace/signin-merge.test-helpers'
import { ownWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { createAccountRecoveryService } from '../workspace/account-recovery'
import { createReviewedReplacementService } from '../workspace/reviewed-replacement'
import * as reconciliation from '../workspace/signin-reconciliation'

// Coordinator state-machine tests keep their deterministic captured-source fixture
// The separate client tests exercise reserved preparation, manifests, and private installation
vi.mock('../workspace/signin-merge-client', () => ({
  createSigninMergeClient: async (_database: unknown, token: Parameters<typeof import('../workspace/signin-merge-client').createSigninMergeClient>[1], _operationId: string, source: import('../workspace/guest-repository').GuestCopySource, _identity: unknown, account: import('../workspace/reviewed-replacement').ReviewedAccountData, check: () => Promise<void>, _progress: unknown, signal: AbortSignal, createWorker: () => Worker) => {
    const worker = source.locator ? createWorker() : undefined
    const { createGuestCopyService } = await import('../workspace/guest-copy')
    const copy = createGuestCopyService(async () => { await check(); return source }, () => signal.throwIfAborted())
    const review = await copy.previewSigninMergeReview(token, account)
    return { preview: review.preview, prepare: (receipt: import('./account-activation-attachments').AccountSyncAttachmentValue) => copy.prepareReviewedSigninMerge(token, review, receipt), async dispose() { worker?.terminate(); await review.dispose(); await copy.dispose() } }
  },
}))

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const controllers: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); await service?.dispose(); service = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
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
async function interruptMergeActivation(controller: ReturnType<typeof reconciliation.createSigninReconciliation>) {
  const activation = await import('./account-database')
  const failure = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('QUOTA_EXCEEDED'))
  try { await controller.confirm(); expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'quota' }) }
  finally { failure.mockRestore() }
}
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

it('merge review stays ephemeral across cancellation and reload until explicit confirmation', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const database = fixture.device.db
  const before = await database.profileMeta.get('active')
  // Fresh remote discovery replaces its authenticated scan, but grants no merge ownership
  const retainedRows = async () => (await database.syncState.toArray()).filter(row => row.id !== 'scan')
  const rows = await retainedRows()
  const migrations = await database.migrationJournal.toArray()
  const recoveries = await createAccountRecoveryService(fixture.device.token).list()
  await controller.choose('merge')
  expect(controller.getSnapshot()).toMatchObject({ phase: 'confirming', action: 'merge' })
  expect(await retainedRows()).toEqual(rows)
  expect(await database.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await database.syncState.where('id').startsWith('guest-copy:').count()).toBe(0)
  expect(await database.migrationJournal.toArray()).toEqual(migrations)
  expect(await createAccountRecoveryService(fixture.device.token).list()).toEqual(recoveries)
  expect(await database.outbox.count()).toBe(0)
  expect(await database.profileMeta.get('active')).toEqual(before)
  await controller.dispose()
  const reopened = fixture.create(); await reopened.begin(fixture.device.token)
  expect(reopened.getSnapshot().phase).toBe('choosing')
  await reopened.choose('merge'); await reopened.cancel()
  expect(await database.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await database.migrationJournal.toArray()).toEqual(migrations)
  expect(fixture.locals).toBe(1)
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
  const copyId = controller.getSnapshot().preview!.copyId
  const migrations = await fixture.device.db.migrationJournal.count()
  const one = controller.confirm(), two = controller.confirm()
  expect(two).toBe(one)
  await Promise.all([one, two])
  const fence = await fixture.device.db.profileMeta.get('active')
  expect(await fixture.device.db.outbox.count()).toBe(1)
  expect(await fixture.device.db.migrationJournal.count()).toBe(migrations + 1)
  expect(await fixture.device.db.migrationJournal.get(copyId)).toBeDefined()
  expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  const { openAccountJson } = await import('../workspace/account-cache')
  const row = (await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
  expect(await openAccountJson(fixture.device.db, fixture.device.token, row.ref, reconciliation.SigninDecisionSchema)).toMatchObject({ copyId, action: 'merge', status: 'complete' })
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
  expect(controller.getSnapshot().stage).toBe('syncing-account')
  const cancelled = controller.cancel()
  await Promise.resolve(); expect(fixture.locals).toBe(0)
  release(); await Promise.all([beginning, cancelled])
  expect(controller.getSnapshot().phase).toBe('cancelled')
  expect(controller.getSnapshot().stage).toBeUndefined()
  expect(fixture.locals).toBe(1); expect(fixture.opens).toBe(0)
  expect(await fixture.device.db.outbox.count()).toBe(0)
})
it('cancellation after confirmed staging cannot publish a late activation', async () => {
  const fixture = await setup(), copies = await import('../workspace/guest-copy')
  const createCopy = copies.createGuestCopyService
  let release!: () => void, prepared!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const durable = new Promise<void>(resolve => { prepared = resolve })
  vi.spyOn(copies, 'createGuestCopyService').mockImplementation((...args) => {
    const copy = createCopy(...args)
    return { ...copy, async prepareReviewedSigninMerge(...input) { const staged = await copy.prepareReviewedSigninMerge(...input); prepared(); await held; return staged } }
  })
  const controller = fixture.create(), observed: reconciliation.SigninReconciliationState[] = []
  controller.subscribe(() => observed.push(controller.getSnapshot()))
  await controller.begin(fixture.device.token)
  await controller.choose('merge')
  observed.length = 0
  const choosing = controller.confirm()
  await durable
  expect(controller.getSnapshot().stage).toBe('preparing-merge')
  const cancelled = controller.cancel()
  release(); await Promise.all([choosing, cancelled])
  expect(observed.some(value => value.phase === 'committing')).toBe(false)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'cancelled', stage: undefined })
  const { openAccountJson } = await import('../workspace/account-cache')
  const row = (await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
  expect(await openAccountJson(fixture.device.db, fixture.device.token, row.ref, reconciliation.SigninDecisionSchema)).toMatchObject({ status: 'cancelled' })
  expect(await fixture.device.db.outbox.count()).toBe(0)
  expect(fixture.locals).toBe(1)
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
  const replacements = await import('../workspace/reviewed-replacement')
  const create = replacements.createReviewedReplacementService
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(replacements, 'createReviewedReplacementService').mockImplementation((...args) => {
    const service = create(...args)
    return { ...service, async refresh() { entered(); await held; return service.refresh() } }
  })
  const reviewing = controller.reviewReplacement('latest')
  try {
    await started
    expect(controller.getSnapshot()).toMatchObject({ phase: 'preparing', action: 'latest' })
  } finally { release(); await reviewing; spy.mockRestore() }
  await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('complete')
  expect((await (await resumed.open()).readWorkspace()).planner.localData.modSetup?.state).toBe('completed')
  expect(await resumed.db.outbox.count()).toBe(0)
})
it.each([
  ['latest', false], ['device', false], ['latest', true], ['device', true],
] as const)('paused replacement %s after two pre-review groups checks post-review movement=%s', async (action, changed) => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('device'); await first.confirm(); await first.dispose()
  const other = await service!.device(1, workspace(createBlankLocalData({ now })))
  await other.settle()
  async function updateRemote(completed: boolean) {
    const repo = await other.open(), remote = await repo.readWorkspace()
    const localData = { ...remote.planner.localData }
    if (completed) localData.modSetup = { version: 1, state: 'completed' }
    else delete localData.modSetup
    await repo.commitWorkspace({ ...remote, planner: { ...remote.planner, localData } }, remote.planner.localData.revision)
  }
  await updateRemote(true); await other.settle()
  await updateRemote(false); await other.settle()
  let publishAfterReview: (() => Promise<Response>) | undefined
  if (changed) {
    await updateRemote(true)
    const fetch = globalThis.fetch
    // Upload the real remote revision now, but admit its commit only after the paused review
    // Replaying its request avoids switching the installed profile away from the live review owner
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      if (path.endsWith('/commits') && JSON.parse(init.body as string).heads.length > 0) {
        publishAfterReview = () => fetch(path, { ...init, signal: undefined })
        throw new Error('deferred remote commit')
      }
      return fetch(path, init)
    })
    try { await expect(other.settle()).rejects.toThrow('deferred remote commit') }
    finally { vi.stubGlobal('fetch', fetch) }
  }
  const resumed = await service!.device(0)
  expect((await resumed.settle()).state).toBe('paused')
  const controller = fixture.create(); await controller.begin(resumed.token)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'choosing', replacement: { state: 'paused' } })
  await controller.reviewReplacement(action)
  expect(controller.getSnapshot()).toMatchObject({ phase: 'confirming', action })
  const before = await resumed.db.profileMeta.get('active'), outbox = await resumed.db.outbox.toArray()
  const decision = await resumed.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)
  if (changed) {
    expect(publishAfterReview).toBeDefined()
    const maxPublicationTurns = 240
    let response = await publishAfterReview!()
    // Publication closure may span service continuations; only its head receipt establishes movement
    for (let turn = 1; response.status === 503 && turn < maxPublicationTurns; turn++) {
      expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE', continuation: expect.any(Object) } })
      response = await publishAfterReview!()
    }
    expect(response.status).toBe(200)
    expect((await response.json()).heads.length).toBeGreaterThan(0)
  }
  await controller.confirm()
  if (changed) {
    expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'review-stale' })
    expect(await resumed.db.profileMeta.get('active')).toEqual(before)
    expect(await resumed.db.outbox.toArray()).toEqual(outbox)
    expect(await resumed.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toEqual(decision)
    expect(fixture.opens).toBe(1)
  } else {
    expect(controller.getSnapshot().phase).toBe('complete')
    expect((await (await resumed.open()).readWorkspace()).planner.localData.playthroughs).toEqual(action === 'device' ? fixture.guest.planner.localData.playthroughs : {})
    expect((await createReviewedReplacementService(resumed.db, resumed.token).status())?.state).toBe(action === 'device' ? 'active' : 'selected-latest')
    expect(await resumed.db.outbox.count()).toBe(action === 'device' ? 1 : 0)
    expect(fixture.opens).toBe(2)
  }
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

it('explicit recovery review never consumes a completed sign-in or recovery receipt, even for empty data', async () => {
  const fixture = await setup(workspace(createBlankLocalData({ now })))
  const ordinary = fixture.create(); await ordinary.begin(fixture.device.token); await ordinary.dispose()
  const signin = await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)
  fixture.options.entry = { kind: 'recovery', pointId: 'AAAAAAAAAAAAAAAAAAAAAA' }
  const first = fixture.create(); await first.begin(fixture.device.token)
  expect(first.getSnapshot().phase).toBe('choosing')
  await first.choose('account'); await first.dispose()
  const receipt = await fixture.device.db.syncState.get('signin-receipt:recovery:AAAAAAAAAAAAAAAAAAAAAA')
  const second = fixture.create(); await second.begin(fixture.device.token)
  expect(second.getSnapshot().phase).toBe('choosing')
  expect(await fixture.device.db.syncState.get('signin-receipt:recovery:AAAAAAAAAAAAAAAAAAAAAA')).toEqual(receipt)
  expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toEqual(signin)
})
it('recovery preparing decision resumes exactly and opening retry does not reactivate it', async () => {
  const fixture = await setup()
  fixture.options.entry = { kind: 'recovery', pointId: 'AAAAAAAAAAAAAAAAAAAAAA' }
  const first = fixture.create(); await first.begin(fixture.device.token); await first.choose('merge')
  const preview = first.getSnapshot().preview!
  await interruptMergeActivation(first)
  await first.dispose()
  const resumed = fixture.create(); await resumed.begin(fixture.device.token)
  expect(resumed.getSnapshot()).toMatchObject({ phase: 'confirming', preview: { copyId: preview.copyId } })
  fixture.failOpen = true; await resumed.confirm()
  expect(resumed.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'opening-failed' })
  const fence = await fixture.device.db.profileMeta.get('active')
  fixture.failOpen = false; await resumed.retry()
  expect(resumed.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(fence)
})

it.each(['choose', 'confirm'] as const)('shows preparation while %s refreshes its reviewed remote authority', async action => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  if (action === 'confirm') await controller.choose('device')
  const replacements = await import('../workspace/reviewed-replacement')
  const create = replacements.createReviewedReplacementService
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(replacements, 'createReviewedReplacementService').mockImplementation((...args) => {
    const service = create(...args)
    return { ...service, async assertUnchangedReview(handle) { entered(); await held; return service.assertUnchangedReview(handle) } }
  })
  const running = action === 'choose' ? controller.choose('device') : controller.confirm()
  try {
    await started
    expect(controller.getSnapshot()).toMatchObject({ phase: 'preparing', action: 'device' })
    expect(fixture.opens).toBe(0)
    expect(await fixture.device.db.outbox.count()).toBe(0)
  } finally { release(); await running; spy.mockRestore() }
})

it.each(['pending', 'complete', 'cancelled', 'mismatched', 'ambiguous', 'manual', 'foreign', 'profile-change'] as const)('startup discovery treats %s recovery ownership explicitly', async mode => {
  const fixture = await setup()
  const pointId = 'AAAAAAAAAAAAAAAAAAAAAA', receiptKey = `signin-receipt:recovery:${pointId}`
  fixture.options.entry = { kind: 'recovery', pointId }
  const first = fixture.create(); await first.begin(fixture.device.token); await first.choose('merge')
  const copyId = first.getSnapshot().preview!.copyId
  await interruptMergeActivation(first)
  await first.dispose()
  const { openAccountJson } = await import('../workspace/account-cache')
  const { writeSyncState } = await import('../account/sync/outbox')
  const database = fixture.device.db, token = fixture.device.token
  const row = (await database.syncState.get(receiptKey))!
  const decision = await openAccountJson(database, token, row.ref, reconciliation.SigninDecisionSchema)
  if (mode === 'complete' || mode === 'cancelled') await writeSyncState(database, token, receiptKey, { ...decision, status: mode }, row)
  if (mode === 'mismatched') await writeSyncState(database, token, receiptKey, { ...decision, copyId: 'AAAAAAAAAAAAAAAAAAAAAQ' }, row)
  if (mode === 'ambiguous') await database.syncState.add({ id: 'signin-receipt:recovery:AAAAAAAAAAAAAAAAAAAAAQ', ref: row.ref })
  if (mode === 'manual') await database.syncState.delete(receiptKey)
  if (mode === 'foreign') await writeSyncState(database, token, receiptKey, { ...decision, accountId: 'AAAAAAAAAAAAAAAAAAAAAQ' }, row)
  if (mode === 'profile-change') {
    const cache = await import('../workspace/account-cache'), read = cache.openAccountJson
    const { invalidateProfile } = await import('../account/profile')
    vi.spyOn(cache, 'openAccountJson').mockImplementation(async (...args) => { const value = await read(...args); invalidateProfile(); return value })
  }
  const before = await database.profileMeta.get('active')
  if (mode === 'profile-change') await expect(reconciliation.readPendingRecoveryEntry(token)).rejects.toThrow('PROFILE_CHANGED')
  else if (mode === 'mismatched' || mode === 'ambiguous' || mode === 'foreign') await expect(reconciliation.readPendingRecoveryEntry(token)).rejects.toThrow('SIGNIN_RECEIPT_MISMATCH')
  else expect(await reconciliation.readPendingRecoveryEntry(token)).toEqual(mode === 'pending' ? { kind: 'recovery', pointId } : undefined)
  expect(await database.profileMeta.get('active')).toEqual(before)
  expect(await database.outbox.count()).toBe(0)
  expect(await database.syncState.get(`guest-copy:${copyId}`)).toBeDefined()
  if (mode === 'pending') {
    const resumed = fixture.create(); await resumed.begin(token)
    expect(resumed.getSnapshot()).toMatchObject({ phase: 'confirming', preview: { copyId } })
    await resumed.confirm()
    const activated = await database.profileMeta.get('active'), intent = await database.outbox.toArray()
    expect(resumed.getSnapshot().phase).toBe('complete')
    await resumed.confirm()
    expect(await database.profileMeta.get('active')).toEqual(activated)
    expect(await database.outbox.toArray()).toEqual(intent)
    expect(await reconciliation.readPendingRecoveryEntry(token)).toBeUndefined()
  }
})

it('opens the unchanged guest decision after a separate recovery replacement', async () => {
  const service = await conflictService()
  const owners: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
  let unregister: (() => void) | undefined
  try {
    const device = await service.device(0, workspace(createBlankLocalData({ now })))
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true })
    const guest = progress('guest')
    const create = (pointId?: string) => {
      const owner = reconciliation.createSigninReconciliation({
        ...(pointId ? {entry: {kind: 'recovery' as const, pointId}, admittedOffline: true} : {}),
        captureGuest: async () => ({ snapshot: pointId ? await createAccountRecoveryService(device.token).capture(pointId) : ownWorkspaceSnapshot({version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: crypto.randomUUID(), capturedAt: now, revisionVector: { guest: 'same-instance', managedRevision: '1' }, state: guest}, {async check() {}, async dispose() {}})}),
        run: async (token, signal) => { await prepareManagedSync(device.db, token); return runSyncIteration(token, signal) },
        openAccount: async () => {}, continueLocal: async () => {},
      })
      owners.push(owner); return owner
    }
    const first = create(); await first.begin(device.token); await first.choose('device'); await first.confirm()
    expect(first.getSnapshot().phase).toBe('complete'); await first.dispose()
    const originalReceipt = await device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)
    unregister = registerSyncProjectionGuard(device.token, () => true)
    await device.settle(); unregister(); unregister = undefined
    const original = await createReviewedReplacementService(device.db, device.token).status()
    expect(original?.state).toBe('accepted')
    const recovery = create(original!.recoveryOperationId)
    await recovery.begin(device.token); expect(recovery.getSnapshot().phase).toBe('choosing')
    await recovery.choose('device'); await recovery.confirm()
    expect(recovery.getSnapshot().phase).toBe('complete'); await recovery.dispose()
    expect(await device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toEqual(originalReceipt)
    const replacement = await createReviewedReplacementService(device.db, device.token).status()
    expect(replacement!.operationId).not.toBe(original!.operationId)
    const again = create(); await again.begin(device.token)
    expect(again.getSnapshot().phase).toBe('complete')
    await again.dispose()
    const fence = await device.db.profileMeta.get('active'), intents = await device.db.outbox.toArray()
    vi.stubGlobal('navigator', { onLine: false })
    const offline = create(); await offline.begin(device.token)
    expect(offline.getSnapshot().phase).toBe('complete')
    expect(await device.db.profileMeta.get('active')).toEqual(fence)
    expect(await device.db.outbox.toArray()).toEqual(intents)
    expect(await device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toEqual(originalReceipt)
  } finally { unregister?.(); for (const owner of owners) await owner.dispose(); await service.dispose(); vi.restoreAllMocks() }
})

it('settles a lost completion acknowledgment after eligible recovery retirement', async () => {
  const service = await conflictService()
  const owners: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
  let unregister: (() => void) | undefined
  try {
    const device = await service.device(0, workspace(createBlankLocalData({ now })))
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true })
    const owner = reconciliation.createSigninReconciliation({
      captureGuest: async () => ({snapshot: ownWorkspaceSnapshot({version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'replacement', capturedAt: now, revisionVector: {guest: 'source'}, state: progress('guest')}, {async check() {}, async dispose() {}})}),
      run: async (token, signal) => { await prepareManagedSync(device.db, token); return runSyncIteration(token, signal) },
      openAccount: async () => {}, continueLocal: async () => {},
    })
    owners.push(owner)
    await owner.begin(device.token); await owner.choose('device'); await owner.confirm()
    expect(owner.getSnapshot().phase).toBe('complete'); await owner.dispose()
    unregister = registerSyncProjectionGuard(device.token, () => true)
    const originalFetch = globalThis.fetch
    let lost = false
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const response = await originalFetch(path, init)
      if (path.endsWith('/complete') && response.ok && !lost) { lost = true; throw new TypeError('lost completion acknowledgment') }
      return response
    })
    await expect(device.settle()).rejects.toThrow('lost completion acknowledgment')
    vi.stubGlobal('fetch', originalFetch)
    const authority = (await createReviewedReplacementService(device.db, device.token).status())!
    expect(authority.state).toBe('active')
    const { SyncClient } = await import('../account/sync/client')
    const client = new SyncClient(device.token, new AbortController().signal)
    const point = (await client.listRecoveries()).points.find(point => point.operationId === authority.recoveryOperationId)!
    expect(point.state).toBe('completed')
    expect(await client.receipt(authority.final!.mutationId)).toBeTruthy()
    expect((await client.removeRecovery(point.operationId)).state).not.toBe('blocked')
    expect((await client.recoveryOperationStatus(point.operationId)).status).toBe('retired')
    let error: unknown
    try { await device.settle() } catch (caught) { error = caught }
    expect(error).toBeUndefined()
    expect((await createReviewedReplacementService(device.db, device.token).status())?.state).toBe('accepted')
    expect(await device.db.outbox.count()).toBe(0)
    expect((await client.listRecoveries()).points).toEqual([])
    expect((await client.recoveryOperationStatus(point.operationId)).status).toBe('retired')
  } finally { unregister?.(); for (const owner of owners) await owner.dispose(); await service.dispose(); vi.restoreAllMocks() }
})

it.each(['missing-preparation', 'missing-journal', 'ambiguous-journal', 'journal-revision', 'operation', 'source', 'head', 'receipt-head', 'unactivated', 'foreign-account', 'altered-ciphertext'] as const)('completed device decision rejects %s proof without reopening or reimporting', async mode => {
  const fixture = await setup(), first = fixture.create()
  await first.begin(fixture.device.token); await first.choose('device'); await first.confirm(); await first.dispose()
  const { device } = fixture, authority = (await createReviewedReplacementService(device.db, device.token).status())!
  const { openAccountJson, accountLocalId } = await import('../workspace/account-cache')
  const { writeSyncState } = await import('../account/sync/outbox')
  const { z } = await import('zod')
  const key = `reviewed-preparation:${authority.operationId}`, row = (await device.db.syncState.get(key))!
  const preparation = await openAccountJson(device.db, device.token, row.ref, z.record(z.string(), z.unknown()))
  const record = (await device.db.encryptedRevisions.get(row.ref.revisionId))!
  const receipt = (await device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
  const decision = await openAccountJson(device.db, device.token, receipt.ref, reconciliation.SigninDecisionSchema)
  if (mode === 'missing-preparation') await device.db.syncState.delete(key)
  if (mode === 'missing-journal') await device.db.migrationJournal.delete(authority.intentId)
  if (mode === 'ambiguous-journal') await device.db.migrationJournal.add({ ...(await device.db.migrationJournal.get(authority.intentId))!, id: accountLocalId() })
  if (mode === 'journal-revision') await device.db.migrationJournal.update(authority.intentId, { headRevision: 0 })
  if (mode === 'operation') await writeSyncState(device.db, device.token, key, { ...preparation, operationId: accountLocalId() }, row, record.descriptor.dependencies)
  if (mode === 'source') await writeSyncState(device.db, device.token, key, { ...preparation, sourceIdentity: 'changed' }, row, record.descriptor.dependencies)
  if (mode === 'unactivated') await writeSyncState(device.db, device.token, key, { ...preparation, state: 'sealed' }, row, record.descriptor.dependencies)
  if (mode === 'head') await writeSyncState(device.db, device.token, key, preparation, row, [authority.reviewedHeadRoot])
  if (mode === 'receipt-head') await writeSyncState(device.db, device.token, receipt.id, decision, receipt, [authority.reviewedHeadRoot])
  if (mode === 'foreign-account') await writeSyncState(device.db, device.token, receipt.id, { ...decision, accountId: accountLocalId() }, receipt, record.descriptor.dependencies)
  if (mode === 'altered-ciphertext') {
    const chunk = (await device.db.stagedCipherChunks.get([record.payloadId, 0]))!
    chunk.bytes[0] ^= 1; await device.db.stagedCipherChunks.put(chunk)
  }
  const fence = await device.db.profileMeta.get('active'), intents = await device.db.outbox.toArray(), opens = fixture.opens
  const next = fixture.create(); await next.begin(device.token)
  expect(next.getSnapshot().phase).toBe('failed')
  expect(fixture.opens).toBe(opens)
  expect(await device.db.profileMeta.get('active')).toEqual(fence)
  expect(await device.db.outbox.toArray()).toEqual(intents)
})

it.each(['point-count', 'account-bytes'] as const)('renders honest capacity guidance after real %s exhaustion', async limit => {
  const fixture = await setup(), controller = fixture.create(), token = fixture.device.token
  await controller.begin(token); await controller.choose('device')
  const recovery = createAccountRecoveryService(token)
  if (limit === 'point-count') {
    const { accountLocalId } = await import('../workspace/account-cache')
    const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
    for (let index = 0; index < 3; index++) {
      const source = (await fixture.options.captureGuest!())!.snapshot
      try { await recovery.prepare(accountLocalId(), source) } finally { await disposeWorkspaceSnapshot(source) }
    }
    const points = await recovery.list()
    expect(points).toHaveLength(3)
    expect(points.every(point => point.state === 'pending')).toBe(true)
    const capacity = await service!.fixture.db.prepare('SELECT capacity_bytes FROM accounts WHERE id=?').bind(token.accountId).first<number>('capacity_bytes')
    expect(capacity).toBeGreaterThan(128 * 1024 * 1024)
    expect(points.reduce((sum, point) => sum + point.admittedBytes, 0)).toBeLessThan(128 * 1024 * 1024)
  } else await service!.fixture.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(token.accountId).run()
  const before = await fixture.device.db.profileMeta.get('active')
  await controller.confirm()
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'quota' })
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  const { createElement } = await import('react'), { renderToStaticMarkup } = await import('react-dom/server')
  const { SigninReconciliation } = await import('../ui/account/SigninReconciliation')
  const rendered = renderToStaticMarkup(createElement(SigninReconciliation, { state: controller.getSnapshot(), actions: { ...controller, backup: async () => {} } }))
  expect(rendered).toContain('recovery point limit or a storage limit')
  expect(rendered).toContain('Pending recovery points stay protected')
  expect(rendered).toContain('does not free capacity')
  expect(rendered).not.toContain('Storage is full')
  expect(await fixture.device.db.outbox.count()).toBe(0)
})

it.each(['quota', 'lost-response'] as const)('confirmed merge resolves %s staging without copying twice', async failure => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const copies = await import('../workspace/guest-copy'), create = copies.createGuestCopyService
  let failed = false
  vi.spyOn(copies, 'createGuestCopyService').mockImplementation((...args) => {
    const copy = create(...args)
    return { ...copy, async prepareReviewedSigninMerge(...input) {
      if (failed) return copy.prepareReviewedSigninMerge(...input)
      failed = true
      if (failure === 'quota') throw new Error('QUOTA_EXCEEDED')
      await copy.prepareReviewedSigninMerge(...input)
      throw new Error('lost successful stage response')
    } }
  })
  await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  const before = await fixture.device.db.profileMeta.get('active')
  const migrations = await fixture.device.db.migrationJournal.count()
  await controller.confirm()
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: failure === 'quota' ? 'quota' : 'preparation-failed' })
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  expect(await fixture.device.db.outbox.count()).toBe(0)
  expect(!!await fixture.device.db.syncState.get('guest-copy:pending')).toBe(failure === 'lost-response')
  expect(!!await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBe(failure === 'lost-response')
  const { openAccountJson } = await import('../workspace/account-cache')
  const row = await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)
  const savedDecision = row ? await openAccountJson(fixture.device.db, fixture.device.token, row.ref, reconciliation.SigninDecisionSchema) : undefined
  await controller.retry()
  if (failure === 'quota') {
    expect(controller.getSnapshot().phase).toBe('choosing')
    await controller.choose('merge')
  } else expect(controller.getSnapshot()).toMatchObject({ phase: 'confirming', preview: { copyId } })
  const confirmedId = controller.getSnapshot().preview!.copyId
  await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(await fixture.device.db.migrationJournal.count()).toBe(migrations + 1)
  expect(await fixture.device.db.migrationJournal.get(confirmedId)).toBeDefined()
  expect(await fixture.device.db.outbox.count()).toBe(1)
  if (savedDecision) {
    const complete = (await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
    expect(await openAccountJson(fixture.device.db, fixture.device.token, complete.ref, reconciliation.SigninDecisionSchema)).toEqual({ ...savedDecision, status: 'complete' })
  }
})

it('cancel before confirmed staging retires the live review without a saved decision', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const copies = await import('../workspace/guest-copy'), create = copies.createGuestCopyService
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(copies, 'createGuestCopyService').mockImplementation((...args) => {
    const copy = create(...args)
    return { ...copy, async prepareReviewedSigninMerge(...input) { entered(); await held; return copy.prepareReviewedSigninMerge(...input) } }
  })
  await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  const confirming = controller.confirm()
  await started
  const cancelled = controller.cancel()
  release(); await Promise.all([confirming, cancelled])
  expect(controller.getSnapshot().phase).toBe('cancelled')
  expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await fixture.device.db.migrationJournal.get(copyId)).toBeUndefined()
  expect(await fixture.device.db.outbox.count()).toBe(0)
  expect(fixture.locals).toBe(1)
})

it.each(['source', 'account', 'profile'] as const)('Confirm rejects a stale %s owner before staging a merge', async changed => {
  const fixture = await setup()
  let sourceCurrent = true
  const capture = fixture.options.captureGuest!
  fixture.options.captureGuest = async () => {
    const source = (await capture())!
    return { snapshot: ownWorkspaceSnapshot(source.snapshot, { async check() { if (!sourceCurrent) throw new Error('SIGNIN_SOURCE_CHANGED') }, async dispose() {} }) }
  }
  const controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  if (changed === 'source') sourceCurrent = false
  else if (changed === 'account') {
    const repo = await fixture.device.open(), current = await repo.readWorkspace()
    await repo.commitWorkspace({ ...current, planner: { ...current.planner, localData: { ...current.planner.localData, modSetup: { version: 1, state: 'completed' } } } }, current.planner.localData.revision)
  } else (await import('../account/profile')).invalidateProfile()
  await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('failed')
  expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  expect(await fixture.device.db.migrationJournal.get(copyId)).toBeUndefined()
  expect(fixture.opens).toBe(0)
})

it.each(['cloned', 'foreign-service', 'disposed', 'disposed-account'] as const)('sign-in preparation refuses a %s review handle', async invalid => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const token = fixture.device.token, account = await createReviewedReplacementService(fixture.device.db, token).refresh()
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const copy = createGuestCopyService(async () => (await fixture.options.captureGuest!())!)
  const other = createGuestCopyService(async () => (await fixture.options.captureGuest!())!)
  const handle = await copy.previewSigninMergeReview(token, account)
  const receipt = { id: reconciliation.SIGNIN_DECISION_KEY, expected: undefined, value: {} }
  try {
    if (invalid === 'disposed') await handle.dispose()
    if (invalid === 'disposed-account') await account.dispose()
    const operation = invalid === 'foreign-service' ? other : copy
    await expect(operation.prepareReviewedSigninMerge(token, invalid === 'cloned' ? { ...handle } : handle, receipt)).rejects.toThrow('SIGNIN_REVIEW_REQUIRED')
    expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
    expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  } finally { await copy.dispose(); await other.dispose(); await account.dispose() }
})

it('cancel during confirmed payload staging removes uninstalled data before returning locally', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token); await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  const before = await fixture.device.db.profileMeta.get('active')
  const previousPayloads = new Set((await fixture.device.db.stagedCipherChunks.toArray()).map(chunk => chunk.payloadId))
  const stores = await import('../workspace/account-local-store'), create = stores.createAccountLocalStore
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    return { ...store, async persistOperation(...input) { entered(); await held; return store.persistOperation(...input) } }
  })
  const confirming = controller.confirm()
  try {
    await started
    expect(controller.getSnapshot().stage).toBe('preparing-merge')
    expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
    const cancelled = controller.cancel()
    await Promise.resolve(); expect(fixture.locals).toBe(0)
    release(); await Promise.all([confirming, cancelled])
    expect(controller.getSnapshot().phase).toBe('cancelled')
    expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
    expect(await fixture.device.db.syncState.get(`guest-copy:${copyId}`)).toBeUndefined()
    expect(await fixture.device.db.migrationJournal.get(copyId)).toBeUndefined()
    expect(await fixture.device.db.outbox.count()).toBe(0)
    expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
    // Fresh discovery may install scan records; only uninstalled staging payloads must disappear
    const installed = new Set((await fixture.device.db.encryptedRevisions.toArray()).map(record => record.payloadId))
    const abandoned = (await fixture.device.db.stagedCipherChunks.toArray()).filter(chunk => !previousPayloads.has(chunk.payloadId) && !installed.has(chunk.payloadId)).map(chunk => chunk.payloadId)
    expect(abandoned).toEqual([])
    expect(fixture.locals).toBe(1)
  } finally { release(); await confirming }
})

it('disposing the exact merge review during staging cannot install its saved copy', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const token = fixture.device.token, account = await createReviewedReplacementService(fixture.device.db, token).refresh()
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const copy = createGuestCopyService(async () => (await fixture.options.captureGuest!())!)
  const review = await copy.previewSigninMergeReview(token, account)
  const stores = await import('../workspace/account-local-store'), create = stores.createAccountLocalStore
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    return { ...store, async persistOperation(...input) { entered(); await held; return store.persistOperation(...input) } }
  })
  const preparing = copy.prepareReviewedSigninMerge(token, review, { id: reconciliation.SIGNIN_DECISION_KEY, expected: undefined, value: {} })
  try {
    await started
    await review.dispose()
    const refused = expect(preparing).rejects.toThrow('SIGNIN_REVIEW_REQUIRED')
    release(); await refused
    expect(await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
    expect(await fixture.device.db.syncState.get(`guest-copy:${review.preview.copyId}`)).toBeUndefined()
    expect(await fixture.device.db.syncState.get('guest-copy:pending')).toBeUndefined()
  } finally { release(); await preparing.catch(() => {}); await copy.dispose(); await account.dispose() }
})

it('Confirm refuses a preparing receipt changed after staging even when operation and copy IDs match', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const copies = await import('../workspace/guest-copy'), create = copies.createGuestCopyService
  const { writeSyncState } = await import('../account/sync/outbox')
  const { openAccountJson } = await import('../workspace/account-cache')
  vi.spyOn(copies, 'createGuestCopyService').mockImplementation((...args) => {
    const copy = create(...args)
    return { ...copy, async prepareReviewedSigninMerge(...input) {
      const prepared = await copy.prepareReviewedSigninMerge(...input)
      const row = (await fixture.device.db.syncState.get(reconciliation.SIGNIN_DECISION_KEY))!
      const value = await openAccountJson(fixture.device.db, fixture.device.token, row.ref, reconciliation.SigninDecisionSchema)
      await writeSyncState(fixture.device.db, fixture.device.token, row.id, { ...value, source: { ...value.source!, metadataDigest: 'different-source' } }, row)
      return prepared
    } }
  })
  await controller.choose('merge')
  const copyId = controller.getSnapshot().preview!.copyId
  const before = await fixture.device.db.profileMeta.get('active')
  await controller.confirm()
  expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', reason: 'receipt-mismatch' })
  expect(await fixture.device.db.profileMeta.get('active')).toEqual(before)
  expect(await fixture.device.db.migrationJournal.get(copyId)).toBeUndefined()
  expect(await fixture.device.db.outbox.count()).toBe(0)
})

it('unchanged Merge review reuses the admitted account snapshot through Confirm', async () => {
  const managed = await import('../workspace/managed-guest-copy')
  const stage = vi.spyOn(managed, 'stageManagedGuestCopy'), reopen = vi.spyOn(managed, 'activateManagedGuestCopy')
  const snapshots = await import('../workspace/account-snapshot')
  const capture = vi.spyOn(snapshots, 'captureAccountSnapshot')
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  expect(controller.getSnapshot().phase).toBe('choosing')
  const captures = capture.mock.calls.length
  await controller.choose('merge')
  expect(controller.getSnapshot().phase).toBe('confirming')
  expect(capture.mock.calls.length).toBe(captures)
  await controller.confirm()
  expect(controller.getSnapshot().phase).toBe('complete')
  expect(capture.mock.calls.length).toBe(captures)
  expect(stage).toHaveBeenCalledTimes(1)
  expect(reopen).not.toHaveBeenCalled()
})

it('reuses one selected source across live reviews while rechecking bodies before preparation', async () => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const token = fixture.device.token, account = await createReviewedReplacementService(fixture.device.db, token).refresh()
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const snapshots = await import('../workspace/snapshot'), owned = vi.spyOn(snapshots, 'ownWorkspaceSnapshot')
  const copy = createGuestCopyService(async () => (await fixture.options.captureGuest!())!)
  try {
    const first = await copy.previewSigninMergeReview(token, account)
    const second = await copy.previewSigninMergeReview(token, account)
    expect(second.preview.selectedKeys).toEqual(first.preview.selectedKeys)
    expect(owned.mock.calls.filter(([snapshot]) => snapshot.snapshotId.endsWith(':selection'))).toHaveLength(1)
    await first.dispose(); await second.dispose()
  } finally { await copy.dispose(); await account.dispose() }
})

it.each(['foreign', 'disposed', 'fence', 'body', 'epoch', 'high-water', 'intermediate'] as const)('unchanged account review rejects %s without selecting or preparing anything', async mode => {
  const fixture = await setup(), controller = fixture.create()
  await controller.begin(fixture.device.token)
  const database = fixture.device.db, token = fixture.device.token
  const replacements = createReviewedReplacementService(database, token), review = await replacements.refresh()
  const before = await database.profileMeta.get('active'), outbox = await database.outbox.toArray()
  try {
    let handle = review
    if (mode === 'foreign') handle = { ...review }
    if (mode === 'disposed') await review.dispose()
    if (mode === 'fence') await database.profileMeta.put({ ...before!, headRevision: before!.headRevision + 1 })
    if (mode === 'body') {
      const unit = review.snapshot.sourceEvidence!.units[0]
      const record = (await database.encryptedRevisions.get(unit.source.revisionId))!
      const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
      const bytes = chunk.bytes.slice(); bytes[0] ^= 1
      await database.stagedCipherChunks.put({ ...chunk, bytes })
    }
    if (mode === 'epoch' || mode === 'high-water') {
      const { SyncClient } = await import('../account/sync/client'), changes = SyncClient.prototype.changes
      vi.spyOn(SyncClient.prototype, 'changes').mockImplementation(async function(this: InstanceType<typeof SyncClient>, cursor) {
        const page = await changes.call(this, cursor)
        return { ...page, ...(mode === 'epoch' ? { publicationEpoch: page.publicationEpoch + 1 } : { watermark: 0, publicationEpoch: 0 }) }
      })
    }
    if (mode === 'intermediate') {
      const pull = await import('../account/sync/pull'), stage = pull.stagePull
      vi.spyOn(pull, 'stagePull').mockImplementation(async (db, profile, client, validate, budget) => stage(db, profile, client, async heads => {
        // Exercise the guarded complete-group consumer with a transient extra head followed by the original map
        // If the first callback were skipped, the final heads and epoch would still appear unchanged
        const changed = new Map(heads); changed.set('transient-head', 'transient-revision')
        await validate(changed)
        await validate(heads)
      }, budget))
    }
    await expect(replacements.assertUnchangedReview(handle)).rejects.toThrow()
    if (mode === 'epoch' || mode === 'intermediate') {
      vi.restoreAllMocks()
      await expect(replacements.assertUnchangedReview(review)).rejects.toThrow('REPLACEMENT_REVIEW_REQUIRED')
    }
    expect(await database.profileMeta.get('active')).toEqual(mode === 'fence' ? { ...before!, headRevision: before!.headRevision + 1 } : before)
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect(await database.syncState.get('guest-copy:pending')).toBeUndefined()
    expect(await database.syncState.get(reconciliation.SIGNIN_DECISION_KEY)).toBeUndefined()
  } finally { await review.dispose() }
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
