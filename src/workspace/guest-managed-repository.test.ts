import { managedMonitorComparisonCount } from './guest-managed-monitor.test-helpers'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openGuestManagedRepository, observeManagedGuestRecovery } from './guest-managed-repository'
import { createSaveRepository } from './save-repository'
import { resolveOwnedFileReceipt } from './owned-file-command'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createSaveEditorFixture } from '../domain/save-editor.fixture'
import { encodeCrystalSave } from '../interchange/crystal-save'
import { editorBlob } from './editor-document'
import type { SaveWorkspaceDocument, WorkspaceState } from './documents'
import { readSaveContent } from './save-repository'
import { createTestLocalData } from '../domain/test-helpers'
import { AppDataError } from '../interchange/errors'
import { WorkspaceError } from './repository'

it('durably applies a native Save edit and resolves its exact owned successor', async () => {
  let transactions = 0
  const nativeTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) { transactions++; return Reflect.apply(nativeTransaction, this, args) }
  const database = new GuestCoordinatorDatabase(`synthetic-save-slice-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const native = createSaveEditorFixture(), original = await editorBlob(encodeCrystalSave(native), 'bytes')
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0]), timestamp = new Date().toISOString()
  const file: SaveWorkspaceDocument = { version: 1, id: 'synthetic-save', revision: 1, filename: 'synthetic.sav', original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: 'supported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [original], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  let repository = await openGuestManagedRepository(database, receipt.target)
  const old = repository
  const initialComparisons = managedMonitorComparisonCount()
  let stopObserving = await observeManagedGuestRecovery(repository, () => {})
  const values = []
  let recordsWritten = 0, bytesWritten = 0, recordsRead = 0, bytesRead = 0
  database.table('managedRecords').hook('creating', (_key, row) => { recordsWritten++; bytesWritten += row.byteLength })
  database.table('managedRecords').hook('reading', row => { if (row) recordsRead++; return row })
  database.table('managedChunks').hook('reading', row => { if (row) bytesRead += row.bytes.byteLength; return row })


  for (let revision = 1; revision <= 3; revision++) {
    native.header.currencyAmount = 123 + revision
    const currency = native.party.value.Currency
    if (currency.type !== 'document') throw new Error('Synthetic currency shape')
    currency.value.Val = { type: 'int32', value: 123 + revision }
    const bytes = encodeCrystalSave(native)
    recordsWritten = 0; bytesWritten = 0; recordsRead = 0; bytesRead = 0; transactions = 0
    const started = performance.now()
    const saved = await createSaveRepository(repository, { intent: 'saveApply', onOutcome: async outcome => {
      expect(outcome.status).toBe('saved')
      const completion = await resolveOwnedFileReceipt(outcome.receipt!)
      stopObserving?.()
      repository = completion.repository
      stopObserving = await observeManagedGuestRecovery(repository, () => {})
      expect(managedMonitorComparisonCount()).toBe(initialComparisons)
    } }).saveWorking(file.id, bytes, null, revision)
    const command = { elapsedMs: performance.now() - started, recordsWritten, bytesWritten, recordsRead, bytesRead, transactions }
    const selected = await repository.readWorkspace()
    const content = await readSaveContent(selected, saved)
    expect(content.workingBytes).toEqual(bytes)
    expect(content.originalBytes).toEqual(encodeCrystalSave(createSaveEditorFixture()))
    values.push({ revision, command, elapsedMs: performance.now() - started, history: selected.planner.history.length, retained: selected.retainedContent.length, recordsWritten, bytesWritten, recordsRead, bytesRead, transactions })
  }
  if (process.env.R16_RECEIPT_PATH) writeFileSync(process.env.R16_RECEIPT_PATH, JSON.stringify({ runtime: process.version, platform: process.platform, architecture: process.arch, fixtureOriginalBytes: original.content.byteLength, values }, null, 2))
  stopObserving?.()
  await expect(old.readWorkspace()).rejects.toThrow()
  const selected = await repository.readWorkspace()
  const manifest = (await database.active.get('active'))!.manifest
  const reopened = await openGuestManagedRepository(database, manifest as unknown as import('./guest-local-store').GuestManagedManifest)
  expect((await reopened.readWorkspace()).planner).toEqual(selected.planner)
  expect(values.every(value => value.elapsedMs <= 1000)).toBe(true)
  IDBDatabase.prototype.transaction = nativeTransaction
  database.close()
}, 30_000)

it('captures planner edits before awaiting and keeps ordinary queues on the exact committed head', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-planner-slice-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  try {
    const repository = await openGuestManagedRepository(database, receipt.target)
    const competing = await openGuestManagedRepository(database, receipt.target)
    const current = (await repository.load()).localData, id = Object.keys(current.builds)[0]
    const proposed = { ...current, builds: { ...current.builds, [id]: { ...current.builds[id], title: 'Captured title' } } }
    const pending = repository.save(proposed, current.revision)
    Object.assign(proposed.builds[id], { title: 'Late caller mutation' })
    const saved = await pending
    expect(saved.localData.builds[id].title).toBe('Captured title')
    expect((await repository.load()).localData).toEqual(saved.localData)
    await expect(competing.save(current, current.revision)).rejects.toThrow()
    await expect(repository.save(current, current.revision)).rejects.toThrow()
    const second = await repository.save({ ...saved.localData, builds: { ...saved.localData.builds, [id]: { ...saved.localData.builds[id], title: 'Second title' } } }, saved.localData.revision)
    expect(second.localData.builds[id].title).toBe('Second title')
    const history = await repository.readHistory()
    expect(history.map(entry => entry.after.builds[id].title)).toEqual(['Captured title', 'Second title'])
    const undone = await repository.undo(second.localData.revision)
    expect(undone.localData.builds[id].title).toBe('Captured title')
    expect((await repository.readHistory()).slice(0, 2)).toEqual(history)
    expect((await repository.readHistory()).at(-1)?.command).toBe('undo:save-localData')
    const active = (await database.active.get('active'))!.manifest as unknown as import('./guest-local-store').GuestManagedManifest
    const reopened = await openGuestManagedRepository(database, active)
    expect((await reopened.readWorkspace()).planner).toEqual((await repository.readWorkspace()).planner)
  } finally { database.close() }
}, 15_000)

it.each(['planner', 'file'] as const)('keeps the admitted monitor when an old read finishes after an owned %s save', async mode => {
  const database = new GuestCoordinatorDatabase(`synthetic-late-owned-read-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const native = createSaveEditorFixture(), originalBytes = encodeCrystalSave(native)
  const original = await editorBlob(originalBytes, 'bytes')
  const localData = createTestLocalData(), timestamp = new Date().toISOString()
  const file: SaveWorkspaceDocument = { version: 1, id: 'synthetic-save', revision: 1, filename: 'synthetic.sav', original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: 'supported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [original], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  let repository = await openGuestManagedRepository(database, receipt.target)
  const predecessor = repository, comparisons = managedMonitorComparisonCount()
  const nativeGet = database.Table.prototype.get
  let holdRead = true
  let releaseRead!: () => void, markReadStarted!: () => void
  const held = new Dexie.Promise<void>(resolve => { releaseRead = resolve })
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve })
  // Dexie creates a separate table wrapper for each lookup; intercept only this database's first active read
  const get = vi.spyOn(database.Table.prototype, 'get').mockImplementation(function (this: typeof database.active, key) {
    if (this.name !== 'active' || !holdRead) return Reflect.apply(nativeGet, this, [key])
    holdRead = false
    markReadStarted()
    return held.then(() => Reflect.apply(nativeGet, this, [key]))
  })
  try {
    const read = predecessor.load().then(value => ({ status: 'loaded', value }), (error: unknown) => ({ status: 'failed', error }))
    await readStarted
    if (mode === 'planner') await repository.save(localData, localData.revision)
    else {
      native.header.currencyAmount = 987
      const currency = native.party.value.Currency
      if (currency.type !== 'document') throw new Error('Synthetic currency shape')
      currency.value.Val = { type: 'int32', value: 987 }
      await createSaveRepository(repository, { intent: 'saveApply', onOutcome: async outcome => {
        expect(outcome.status).toBe('saved')
        repository = (await resolveOwnedFileReceipt(outcome.receipt!)).repository
      } }).saveWorking(file.id, encodeCrystalSave(native), null, file.revision)
    }
    // The owning receipt is fully adopted before the predecessor check reads the new native pointer
    releaseRead()
    expect(await read).toMatchObject({ status: 'failed', error: { message: 'The managed workspace changed' } })
    const current = await repository.load()
    const saved = await repository.save(current.localData, current.revision)
    expect(saved.localData.revision).toBe(current.revision + 1)
    const selected = await repository.readWorkspace()
    expect((await readSaveContent(selected, selected.saveDocuments[0]!)).originalBytes).toEqual(originalBytes)
    expect(managedMonitorComparisonCount()).toBe(comparisons)
  } finally { releaseRead(); get.mockRestore(); database.close() }
})

it('edits a managed Mod document without reopening retired Inspector storage', async () => {
  const { createEditorRepository } = await import('./editor-repository')
  const database = new GuestCoordinatorDatabase(`synthetic-managed-editor-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  let repository = await openGuestManagedRepository(database, receipt.target)
  const original = '\ufeff{\r\n"Unknown":900719925474099312345\r\n}'
  const editor = () => createEditorRepository(repository, { onOutcome: async outcome => { expect(outcome.status).toBe('saved'); repository = (await resolveOwnedFileReceipt(outcome.receipt!)).repository } })
  try {
    const file = await editor().importFile({ filename: 'synthetic.crystalmod', text: original, bytes: new TextEncoder().encode(original), referenceId: 'synthetic' })
    const old = repository
    const invalid = await editor().saveUnfinished(file.id, { text: '{ invalid', editedPath: ['Unknown'], fieldState: { raw: 'invalid' }, validation: 'invalid' }, file.revision)
    await expect(old.readWorkspace()).rejects.toThrow()
    const opened = await editor().read(file.id)
    expect(opened?.content.originalBytes).toEqual(new TextEncoder().encode(original))
    expect(opened?.content.unfinishedText).toBe('{ invalid')
    expect(opened?.file.unfinished.fieldState).toEqual({ raw: 'invalid' })
    const nextText = original.replace('900719925474099312345', '900719925474099312346')
    const valid = await editor().saveUnfinished(file.id, { text: nextText, editedPath: ['Unknown'], fieldState: null, validation: 'valid' }, invalid.revision)
    await editor().applyDraft(file.id, valid.revision)
    const applied = await editor().read(file.id)
    expect(applied?.content.lastAppliedText).toBe(nextText)
    expect(applied?.content.originalBytes).toEqual(new TextEncoder().encode(original))
  } finally { database.close() }
}, 30_000)

it('retains one structured storage diagnostic through failed planner publication and safe retry', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-planner-diagnostic-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createTestLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  const repository = await openGuestManagedRepository(database, receipt.target)
  const before = await repository.load()
  const native = new DOMException('Synthetic planner publication failure', 'QuotaExceededError')
  let injected = false
  const fail = () => { if (!injected) { injected = true; throw native } }
  database.active.hook('updating', fail)
  try {
    const error = await repository.save(before.localData, before.revision).catch((reason: unknown) => reason)
    expect(injected).toBe(true)
    expect(error).toBeInstanceOf(AppDataError)
    expect(error).toMatchObject({ code: 'storage-failure', recoverable: true, cause: { name: 'QuotaExceededError', inner: native } })
    expect((error as AppDataError).diagnosticId).toMatch(/^[\w-]+$/)
    expect((await database.active.get('active'))?.manifest).toEqual(receipt.target)
    expect(await repository.load()).toEqual(before)
    expect(await repository.readHistory()).toEqual([])
    const saved = await repository.save(before.localData, before.revision)
    expect(saved.localData.revision).toBe(before.revision + 1)
    expect((await repository.readHistory()).at(-1)?.after).toEqual(saved.localData)
    await expect(repository.save(before.localData, before.revision)).rejects.toBeInstanceOf(WorkspaceError)
  } finally { database.active.hook('updating').unsubscribe(fail); database.close() }
})

it('ordinary managed saves notify another captured reader without source scans or writer adoption', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-hints-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createTestLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  const writer = await openGuestManagedRepository(database, receipt.target)
  const other = await openGuestManagedRepository(database, receipt.target)
  const notices: unknown[] = []
  const stop = other.subscribe(value => notices.push(value))
  const comparisons = managedMonitorComparisonCount()
  try {
    const saved = await writer.save(localData, localData.revision)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(managedMonitorComparisonCount()).toBe(comparisons)
    await expect(other.load()).rejects.toThrow()
    await expect(other.save(localData, localData.revision)).rejects.toThrow()
    const active = (await database.active.get('active'))!.manifest as unknown as import('./guest-local-store').GuestManagedManifest
    const reopened = await openGuestManagedRepository(database, active)
    expect((await reopened.load()).localData).toEqual(saved.localData)
    stop()
    await writer.save(saved.localData, saved.localData.revision)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(notices).toHaveLength(1)
  } finally { stop(); database.close() }
})
