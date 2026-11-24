import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createServiceFixture } from '../../worker/testing/service-fixture'
import { accountLocalId } from '../workspace/account-cache'
import type { ServiceFixture } from '../../worker/testing/service-fixture'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { openAccountRepository } from '../workspace/account-repository'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncError } from '../account/sync/client'
import type { OwnedFileOutcome } from '../workspace/owned-file-command'

import { prepareManagedSync } from './managed-sync.test-helpers'

import { customer } from './sync-customer.test-helpers'

// Each file owns its profile and database lifetime; the shared sign-in helper retains no state
let database: AccountDatabase | undefined
let service: ServiceFixture | undefined
afterEach(async () => { vi.unstubAllGlobals(); invalidateProfile(); await database?.delete(); await service?.dispose() })
async function initialEditorOverlap(negative?: string) {
  const { createEditorRepository } = await import('../workspace/editor-repository')
  const { readEditorContent } = await import('../workspace/editor-document')
  const { resolveOwnedFileReceipt } = await import('../workspace/owned-file-command')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'editor_overlap')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  let repository = await openAccountRepository(token)
  const hooks = { async onOutcome(outcome: OwnedFileOutcome) {
    if (outcome.status === 'saved' && outcome.receipt) {
      repository = (await resolveOwnedFileReceipt(outcome.receipt)).repository
      editor = createEditorRepository(repository, hooks)
    }
  } }
  let editor = createEditorRepository(repository, hooks)
  registerSyncProjectionGuard(token, () => true)
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const original = new TextEncoder().encode('{"original":1}\r\n')
  const file = await editor.importFile({ filename: 'overlap.json', text: new TextDecoder().decode(original), bytes: original, referenceId: 'native' })
  await editor.saveUnfinished(file.id, { text: '{"unfinished":', editedPath: [], fieldState: null, validation: 'invalid' }, file.revision)
  expect(await database.outbox.count()).toBe(2)
  expect((await database.outbox.toArray()).every(row => !row.publicationBase)).toBe(true)
  let synced = false, negativesChecked = false
  const checkUnprovenChains = async () => {
    const { z } = await import('zod')
    const { openAccountJson, stageAccountJson, cipherRef } = await import('../workspace/account-cache')
    const { readSyncState, writeSyncState, TransportCommandSchema } = await import('../account/sync/outbox')
    const { MappedWorkspaceIntentSchema } = await import('../workspace/account-intents')
    const operationSchema = z.object({ accepted: z.boolean(), intentRef: z.object({ documentId: z.string(), revisionId: z.string() }).optional(), target: z.object({ documentId: z.string(), revisionId: z.string() }), finalMutationId: z.string(), lineageId: z.string().optional(), newLineageId: z.string() }).passthrough()
    const accepted = await Promise.all((await database!.syncState.toArray()).filter(row => row.id.startsWith('accepted:')).map(async row => ({ row, value: await openAccountJson(database!, token, row.ref, operationSchema) })))
    if (accepted.length !== 2) return false
    const initial = accepted.find(item => !item.value.intentRef)!, intervening = accepted.find(item => item.value.intentRef)!
    const intent = await openAccountJson(database!, token, intervening.value.intentRef!, MappedWorkspaceIntentSchema)
    const pendingRow = (await database!.outbox.toArray())[0]
    const pending = await openAccountJson(database!, token, pendingRow.ref, MappedWorkspaceIntentSchema)
    expect(initial.value.target).toEqual(intent.base)
    expect(intervening.value.target).toEqual(pending.base)
    expect(intent.localRevision).toBeLessThan(pending.localRevision)
    const before = await database!.profileMeta.get('active')
    const reject = async (label: string, row: import('./account-database').EncryptedSyncState, value: unknown, dependencies?: import('./account-database').CipherRef[]) => {
      if (negative !== label) return
      const original = row
      await writeSyncState(database!, token, row.id, value, row, dependencies ?? (await database!.encryptedRevisions.get(row.ref.revisionId))!.descriptor.dependencies)
      try {
        await expect(runSyncIteration(token, new AbortController().signal), label).rejects.toThrow('HEAD_CONFLICT')
        expect(await database!.profileMeta.get('active'), label).toEqual(before)
        expect(await database!.outbox.count(), label).toBe(1)
      } finally { await database!.syncState.put(original) }
    }
    const raw = z.record(z.string(), z.unknown())
    const initialRoot = await openAccountJson(database!, token, initial.value.target, raw)
    const initialRecord = (await database!.encryptedRevisions.get(initial.value.target.revisionId))!
    const equalRoot = await stageAccountJson(database!, token, initialRoot, initialRecord.descriptor.dependencies)
    await database!.encryptedRevisions.add(equalRoot)
    expect(await openAccountJson(database!, token, cipherRef(equalRoot), raw)).toEqual(initialRoot)
    await reject('content-equivalent initial full ref is insufficient', initial.row, { ...initial.value, target: cipherRef(equalRoot) })
    await reject('unaccepted initial evidence is insufficient', initial.row, { ...initial.value, accepted: false })
    await reject('foreign initial lineage is insufficient', initial.row, { ...initial.value, lineageId: accountLocalId() })
    await reject('broken lineage link is insufficient', intervening.row, { ...intervening.value, lineageId: accountLocalId() })
    const command = (await readSyncState(database!, token, `command:${initial.value.finalMutationId}`, TransportCommandSchema))!
    await reject('missing initial receipt is insufficient', command.row, { ...command.value, receipt: undefined })
    const changedIntent = async (label: string, changed: typeof intent) => {
      const record = (await database!.encryptedRevisions.get(intervening.value.intentRef!.revisionId))!
      const prepared = await stageAccountJson(database!, token, changed, record.descriptor.dependencies)
      await database!.encryptedRevisions.add(prepared)
      await reject(label, intervening.row, { ...intervening.value, intentRef: cipherRef(prepared), target: changed.target })
    }
    await changedIntent('broken full initial-to-intent base is insufficient', { ...intent, base: cipherRef(equalRoot) })
    await changedIntent('non-increasing local revisions are insufficient', { ...intent, localRevision: pending.localRevision })
    await changedIntent('terminal target mismatch is insufficient', { ...intent, target: initial.value.target })
    return true
  }
  await prepareManagedSync(database, token)
  for (let iteration = 0; iteration < 180; iteration++) {
    try {
      if (negative && !negativesChecked && await database.outbox.count() === 1) {
        negativesChecked = await checkUnprovenChains()
        if (negativesChecked) return
      }
      const result = await runSyncIteration(token, new AbortController().signal)
      if (result.state === 'synced') { synced = true; break }
    } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
  }
  expect(synced).toBe(true)
  expect(negative).toBeUndefined()
  expect(await database.outbox.count()).toBe(0)
  repository = await openAccountRepository(token)
  const state = await repository.readWorkspace(), content = await readEditorContent(state, state.editorDocuments[0])
  expect(content.originalBytes).toEqual(original)
  expect(content.lastAppliedText).toBe(new TextDecoder().decode(original))
  expect(content.unfinishedText).toBe('{"unfinished":')
  expect(state.conflicts).toEqual([])
}
it('publishes consecutive encrypted Editor intents captured before initial cloud acceptance', () => initialEditorOverlap())
it.each([
  'content-equivalent initial full ref is insufficient',
  'unaccepted initial evidence is insufficient',
  'foreign initial lineage is insufficient',
  'broken lineage link is insufficient',
  'missing initial receipt is insufficient',
  'broken full initial-to-intent base is insufficient',
  'non-increasing local revisions are insufficient',
  'terminal target mismatch is insufficient',
])('rejects an unproven encrypted initial chain: %s', negative => initialEditorOverlap(negative))

it.each(['fresh', 'migrated'] as const)('publishes %s managed encrypted commands through actual Worker routes while retaining the operative journal and native backup', async origin => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { prepareLocalWorkspace } = await import('../workspace/local-root')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { openAccountManagedRepository } = await import('../workspace/account-managed-repository')
  const { prepareIncrementalBaseline, activateIncrementalBaseline, prepareIncrementalMapping, activateIncrementalMapping } = await import('../workspace/account-local-mapping')
  const { createPersonalDefinition } = await import('../domain')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'managed_dispatch')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  const store = createAccountLocalStore(database, token), fixture = await editorClosureFixture(), operation = accountLocalId()
  const pull = await import('../account/sync/pull'), activate = pull.activatePulledState
  const activation = vi.spyOn(pull, 'activatePulledState').mockImplementation(async (...args) => {
    await activate(...args)
    if (args[9]) expect((await database!.outbox.get(args[9].id))?.publicationBase).toEqual((await database!.syncState.get('projection'))?.ref)
  })
  try {
    let fence
    if (origin === 'migrated') {
      const { prepareAccountWorkspace } = await import('../workspace/account-graph')
      const { prepareAccountManagedMigration } = await import('../workspace/account-managed-migration')
      const native = await prepareAccountWorkspace(database, token, fixture.state)
      const before = await activateLocalAccountCommit(database, token, { version: 1, id: operation, expected: undefined, head: native.head, records: native.records })
      const migration = await prepareAccountManagedMigration(database, token, before)
      try { fence = await activateLocalAccountCommit(database, token, migration.prepared) }
      finally { await migration.dispose() }
    } else {
      const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
      fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    }
    // Worker lifetime and transport are covered by the browser producer; this composition uses its exact durable tickets
    if (origin === 'fresh') await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
    registerSyncProjectionGuard(token, () => true)
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
      return service!.request(path, { ...init, headers })
    })
    const settle = async () => {
      for (let turn = 0; turn < 160; turn++) {
        try {
          const callsBefore = activation.mock.calls.length
          const outcome = await runSyncIteration(token, new AbortController().signal)
          if (origin === 'migrated' && activation.mock.calls.slice(callsBefore).some(call => !!call[6] || !!call[9])) expect(outcome).toEqual({ state: 'syncing', moreWork: true })
          if (outcome.state === 'synced') return
        } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Managed account publication did not settle')
    }
    await settle()
    if (origin === 'migrated') {
      const accepted = activation.mock.calls.findIndex(call => !!call[6])
      const followup = activation.mock.calls.findIndex((call, index) => index > accepted && !!call[9])
      expect(accepted).toBeGreaterThanOrEqual(0)
      expect(followup).toBeGreaterThan(accepted)
      expect(activation.mock.calls[accepted][9]).toBeUndefined()
      expect(activation.mock.calls[followup][5]).toBeUndefined()
      expect(activation.mock.calls[followup][6]).toBeUndefined()
    }
    let repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const before = await repository.load()
    const saved = await repository.save(createPersonalDefinition(before.localData, { kind: 'item', name: 'Managed published item' }), before.revision)
    const exact = await repository.readWorkspace()
    const row = (await database.outbox.toArray())[0]!
    expect(row.status).toBe('unmapped-local')
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, row))
    await settle()
    expect(await database.outbox.count()).toBe(0)
    repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    expect((await repository.readWorkspace()).planner).toEqual(exact.planner)
    expect((await repository.readWorkspace()).editorDocuments).toEqual(fixture.state.editorDocuments)
    expect((await repository.load()).canUndo).toBe(true)
    expect((await repository.previewImport(await repository.exportPlannerBackup(), 'managed.zip')).proposed.localData).toEqual(saved.localData)
    const undone = await repository.undo(saved.localData.revision)
    expect(undone.localData.personalDefinitions).toEqual(before.localData.personalDefinitions)
  } finally { activation.mockRestore(); await store.dispose() }
}, 60_000)

it.each(['fresh poll', 'completed scan'])('keeps an in-flight managed planner save bound to its publication base across an unchanged %s', async path => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const { createPersonalDefinition } = await import('../domain')
  const { openAccountJson } = await import('../workspace/account-cache')
  const { IncrementalWorkspaceIntentSchema } = await import('../workspace/account-mapping-origin')
  const { createReviewedReplacementService } = await import('../workspace/reviewed-replacement')
  const activation = await import('./account-database')
  const fixture = await conflictService()
  try {
    const device = await fixture.device(0)
    expect((await device.settle()).state).toBe('synced')
    if (path === 'completed scan') {
      const review = await createReviewedReplacementService(device.db, device.token).refresh()
      await review.dispose()
      expect(await device.db.syncState.get('scan')).toBeDefined()
    } else expect(await device.db.syncState.get('scan')).toBeUndefined()
    const repository = await device.open(), before = await repository.load()
    const base = (await device.db.syncState.get('projection'))!.ref
    const fence = (await device.db.profileMeta.get('active'))!, journal = await device.db.migrationJournal.count()
    const draft = createPersonalDefinition(before.localData, { kind: 'item', name: 'Foreground draft' })
    const activate = activation.activateLocalAccountCommit
    // Run the actual poll after the intent captures its base, before the save transaction checks it
    const gate = vi.spyOn(activation, 'activateLocalAccountCommit').mockImplementationOnce(async (...args) => {
      expect(await runSyncIteration(device.token, new AbortController().signal)).toEqual({ state: 'synced', moreWork: false })
      return activate(...args)
    })
    const saved = await repository.save(draft, before.revision).finally(() => gate.mockRestore())
    expect(saved.localData.personalDefinitions).toEqual(draft.personalDefinitions)
    expect(saved.canUndo).toBe(true)
    expect(await device.db.syncState.get('scan')).toBeUndefined()
    expect((await device.db.syncState.get('projection'))?.ref).toEqual(base)
    expect((await device.db.syncState.get('remote'))?.ref).toEqual(base)
    const target = (await device.db.profileMeta.get('active'))!
    expect(target.headRevision).toBe(fence.headRevision + 1)
    expect(await device.db.migrationJournal.count()).toBe(journal + 1)
    const intents = await device.db.outbox.toArray()
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ status: 'unmapped-local', publicationBase: base })
    expect(await openAccountJson(device.db, device.token, intents[0].ref, IncrementalWorkspaceIntentSchema)).toMatchObject({ operation: 'save', before: fence.head, after: target.head, publicationBase: base, sequence: target.headRevision })
    expect((await device.settle()).state).toBe('synced')
    expect(await device.db.outbox.count()).toBe(0)
    const reopened = await device.open()
    expect((await reopened.load()).localData).toEqual(saved.localData)
    expect((await reopened.undo(saved.localData.revision)).localData.personalDefinitions).toEqual(before.localData.personalDefinitions)
  } finally { await fixture.dispose() }
})

it('refuses an in-flight managed save when a second device advances the selected account', async () => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const { createPersonalDefinition } = await import('../domain')
  const { readRemoteState } = await import('../account/sync/pull')
  const activation = await import('./account-database')
  const fixture = await conflictService()
  try {
    await (await fixture.device(0)).settle()
    const second = await fixture.device(1)
    await second.settle()
    const other = await second.open(), remote = await other.load()
    await other.save(createPersonalDefinition(remote.localData, { kind: 'item', name: 'Published elsewhere' }), remote.revision)
    expect((await second.settle()).state).toBe('synced')

    const first = await fixture.device(0), stale = await first.open(), before = await stale.load()
    const previous = (await readRemoteState(first.db, first.token))!
    const draft = createPersonalDefinition(before.localData, { kind: 'item', name: 'Uncommitted foreground draft' })
    const activate = activation.activateLocalAccountCommit
    const gate = vi.spyOn(activation, 'activateLocalAccountCommit').mockImplementationOnce(async (...args) => {
      expect((await first.settle()).state).toBe('synced')
      return activate(...args)
    })
    await expect(stale.save(draft, before.revision)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' }).finally(() => gate.mockRestore())
    const advanced = (await readRemoteState(first.db, first.token))!
    expect(advanced.row.ref).not.toEqual(previous.row.ref)
    expect(advanced.value.publicationEpoch).toBeGreaterThan(previous.value.publicationEpoch)
    expect((await first.db.syncState.get('projection'))?.ref).toEqual(advanced.row.ref)
    expect(await first.db.outbox.count()).toBe(0)
    const after = await (await first.open()).load()
    expect(Object.values(after.localData.personalDefinitions).map(definition => definition.name)).toContain('Published elsewhere')
    expect(after.localData.personalDefinitions).not.toEqual(draft.personalDefinitions)
  } finally { await fixture.dispose() }
})

it('selects a renewed server cursor even when the authenticated heads and watermarks stay equal', async () => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const { readRemoteHeads, readRemoteState } = await import('../account/sync/pull')
  const fixture = await conflictService()
  try {
    const device = await fixture.device(0)
    await device.settle()
    const previous = (await readRemoteState(device.db, device.token))!
    const hour = 60 * 60 * 1000
    fixture.fixture.advance(hour)
    expect((await device.settle()).state).toBe('synced')
    const next = (await readRemoteState(device.db, device.token))!
    expect(next.value.cursor).not.toEqual(previous.value.cursor)
    expect(next.value.watermark).toBe(previous.value.watermark)
    expect(next.value.publicationEpoch).toBe(previous.value.publicationEpoch)
    expect(await readRemoteHeads(device.db, device.token, next.value.heads)).toEqual(await readRemoteHeads(device.db, device.token, previous.value.heads))
    expect(next.row.ref).not.toEqual(previous.row.ref)
    expect((await device.db.syncState.get('projection'))?.ref).toEqual(next.row.ref)
  } finally { await fixture.dispose() }
})

it('keeps an unchanged scan retryable if pending work, selection, or iteration ownership changes before retirement', async () => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const pull = await import('../account/sync/pull')
  const fixture = await conflictService()
  try {
    const device = await fixture.device(0)
    await device.settle()
    const priorSelection = (await device.db.syncState.get('projection'))!
    const repository = await device.open(), initial = await repository.load()
    await repository.save({ ...initial.localData, modSetup: { version: 1, state: 'skipped' } }, initial.revision)
    await prepareManagedSync(device.db, device.token)
    const intent = (await device.db.outbox.toArray())[0]!
    expect((await runSyncIteration(device.token, new AbortController().signal)).moreWork).toBe(true)
    const publication = (await device.db.syncState.get('publication'))!
    expect(publication).toBeDefined()
    expect((await device.settle()).state).toBe('synced')
    const remote = (await device.db.syncState.get('remote'))!
    const activate = pull.activatePulledState
    for (const row of ['outbox', 'publication', 'selection', 'retirement'] as const) {
      const controller = new AbortController(), retired = new Error('Retired idle poll')
      // Reuse actual encrypted records so the race guard sees the same rows as a real writer
      const gate = vi.spyOn(pull, 'activatePulledState').mockImplementationOnce(async (...args) => {
        if (row === 'outbox') await device.db.outbox.add(intent)
        else if (row === 'publication') await device.db.syncState.add(publication)
        else if (row === 'selection') await device.db.syncState.put(priorSelection)
        else controller.abort(retired)
        return activate(...args)
      })
      try {
        const poll = runSyncIteration(device.token, controller.signal)
        if (row === 'retirement') await expect(poll).rejects.toBe(retired)
        else await expect(poll, row).rejects.toThrow('LOCAL_REVISION_CONFLICT')
        expect(await device.db.syncState.get('remote')).toEqual(remote)
        expect((await device.db.syncState.get('projection'))?.ref).toEqual(row === 'selection' ? priorSelection.ref : remote.ref)
        expect(await device.db.syncState.get('scan')).toBeDefined()
      } finally {
        gate.mockRestore()
        if (row === 'outbox') await device.db.outbox.delete(intent.id)
        else if (row === 'publication') await device.db.syncState.delete('publication')
        else if (row === 'selection') await device.db.syncState.put({ id: 'projection', ref: remote.ref })
      }
    }
    expect((await device.settle()).state).toBe('synced')
    expect(await device.db.syncState.get('scan')).toBeUndefined()
    expect(await device.db.syncState.get('remote')).toEqual(remote)
  } finally { await fixture.dispose() }
})

it('advances an authenticated lower floor or stale body/publication binding even when server heads stay unchanged', async () => {
  const { z } = await import('zod')
  const { conflictService } = await import('./sync-conflict-fixture')
  const { CipherRefSchema } = await import('../workspace/account-cache')
  const { readRemoteState } = await import('../account/sync/pull')
  const { writeSyncState } = await import('../account/sync/outbox')
  const { readPublicationPages } = await import('../account/sync/projection')
  const { publicationPageSchema, stagePublicationPages } = await import('../account/sync/publication')
  const fixture = await conflictService()
  try {
    const device = await fixture.device(0)
    await device.settle()
    const pages = publicationPageSchema(z.strictObject({ key: z.string(), body: CipherRefSchema, publication: CipherRefSchema }), 'local-effective-units')
    const entries = (root: import('./account-database').CipherRef) => readPublicationPages(device.db, device.token, root, pages, entry => [entry.body, entry.publication])
    const earlier = await entries((await readRemoteState(device.db, device.token))!.value.effective!.units)
    const repository = await device.open(), initial = await repository.load()
    await repository.save({ ...initial.localData, modSetup: { version: 1, state: 'skipped' } }, initial.revision)
    expect((await device.settle()).state).toBe('synced')
    const current = (await readRemoteState(device.db, device.token))!.value
    const newer = await entries(current.effective!.units)
    const predecessor = earlier.find(prior => newer.some(next => next.key === prior.key && prior.body.revisionId !== next.body.revisionId && prior.publication.revisionId !== next.publication.revisionId))
    if (!predecessor) throw new Error('The published planner edit has no advancing effective unit')
    for (const field of ['watermark', 'publicationEpoch', 'body', 'publication'] as const) {
      const value = structuredClone(current)
      if (field === 'watermark' || field === 'publicationEpoch') value[field]--
      else {
        const stale = newer.map(entry => entry.key === predecessor.key ? { ...entry, [field]: predecessor[field] } : entry)
        value.effective!.units = await stagePublicationPages(device.db, device.token, 'local-effective-units', stale, entry => [entry.body, entry.publication])
      }
      // Each selected floor retains actual authenticated refs, including the old same-unit publication ancestor
      const row = await writeSyncState(device.db, device.token, 'remote', value, await device.db.syncState.get('remote'), [value.heads, value.effective!.control, value.effective!.units])
      await device.db.syncState.put({ id: 'projection', ref: row.ref })
      expect((await runSyncIteration(device.token, new AbortController().signal)).state, field).toBe('synced')
      const refreshed = (await readRemoteState(device.db, device.token))!
      expect(refreshed.row.ref, field).not.toEqual(row.ref)
      expect((await device.db.syncState.get('projection'))?.ref, field).toEqual(refreshed.row.ref)
      expect(refreshed.value.watermark).toBe(current.watermark)
      expect(refreshed.value.publicationEpoch).toBe(current.publicationEpoch)
      expect(await entries(refreshed.value.effective!.units)).toEqual(newer)
    }
  } finally { await fixture.dispose() }
})
