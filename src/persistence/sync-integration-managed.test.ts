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
