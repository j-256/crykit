import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import type { conflictService } from './sync-conflict-fixture'
import { ownWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'
import { createAccountRecoveryService } from '../workspace/account-recovery'
import { createReviewedReplacementService } from '../workspace/reviewed-replacement'
import * as reconciliation from '../workspace/signin-reconciliation'
import { createSigninReconciliationSetup } from './signin-reconciliation.test-helpers'

vi.mock('../workspace/signin-merge-client', () => import('./signin-merge-client.test-mock'))

let service: Awaited<ReturnType<typeof conflictService>> | undefined
const controllers: ReturnType<typeof reconciliation.createSigninReconciliation>[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); await service?.dispose(); service = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const setup = createSigninReconciliationSetup(fixture => { service = fixture }, controllers)

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
