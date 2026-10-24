import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { afterEach, expect, it } from 'vitest'
import { createGuestRepository } from '../workspace/guest-repository'
import { CryKitDatabase } from './database'
import { createSaveRepository, validateSaveImport, readSaveContent, saveExportStatus } from '../workspace/save-repository'
import { resolveOwnedFileReceipt, type OwnedFileOutcome } from '../workspace/owned-file-command'
import type { WorkspaceRepository } from '../workspace/repository'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { createSaveEditorFixture, createModdedSaveEditorFixture } from '../domain/save-editor.fixture'
import { encodeCrystalSave, CRYSTAL_SAVE_LIMITS } from '../interchange/crystal-save'

const databases: CryKitDatabase[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
async function fixture() {
  const database = new CryKitDatabase(`save-test-${crypto.randomUUID()}`)
  databases.push(database)
  let repository: WorkspaceRepository = createGuestRepository(database)
  let outcome: OwnedFileOutcome | undefined
  const saves = (hooks: import('../workspace/save-repository').SaveCommandHooks = {}) => createSaveRepository(repository, { ...hooks, onOutcome: value => { outcome = value } })
  const advance = async () => { expect(outcome?.status).toBe('saved'); repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository }
  return { saves, advance, repository: () => repository }
}
it('openingSecondSaveKeepsFirstOriginalAndDraft', async () => {
  const f = await fixture(), bytes = encodeCrystalSave(createSaveEditorFixture())
  const first = await f.saves().importFile('first.sav', bytes)
  await f.advance()
  const pending = { version: 1, fields: { currency: 'not a number' } }
  const saved = await f.saves().saveWorking(first.id, bytes, pending, first.revision)
  await f.advance()
  await f.saves().importFile('second.sav', bytes)
  await f.advance()
  expect(await f.saves().list()).toHaveLength(2)
  const reopened = await f.saves().get(first.id)
  expect(reopened).toEqual(saved)
  expect(reopened?.pendingForm).toEqual(pending)
  expect(await readSaveContent(await f.repository().readWorkspace(), saved)).toEqual({ originalBytes: bytes, workingBytes: bytes })
  const state = await f.repository().readWorkspace(), history = state.retainedContent.find(row => row.kind === 'file-history')!
  expect((await inspectWorkspaceClosure(state, history.content)).value).toEqual(first)
})
it('unsupportedSaveRoundTripsWithoutEditing', async () => {
  const f = await fixture(), bytes = new Uint8Array([99, 0, 255, 8, 9])
  const row = await f.saves().importFile('future.sav', bytes)
  await f.advance()
  expect(row.coverage.status).toBe('unsupported')
  expect((await readSaveContent(await f.repository().readWorkspace(), row)).workingBytes).toEqual(bytes)
  await expect(f.saves().saveWorking(row.id, new Uint8Array([99, 2]), null, row.revision)).rejects.toThrow(/unsupported|read.only/i)
})
it('protects exact export target through pending-only revisions', async () => {
  const f = await fixture(), bytes = encodeCrystalSave(createSaveEditorFixture())
  const row = await f.saves().importFile('first.sav', bytes)
  await f.advance()
  const marked = await f.saves().markExported(row.id, row.revision)
  await f.advance()
  expect(marked.exportedRevision).toBe(row.revision)
  const saved = await f.saves().saveWorking(marked.id, bytes, { fields: { currency: '-' } }, marked.revision)
  await f.advance()
  const state = await f.repository().readWorkspace()
  expect(await saveExportStatus(state, saved)).toBe('requested')
  expect(await saveExportStatus({ ...state, retainedContent: [] }, saved)).toBe('unknown')
  const history = state.retainedContent.find(value => value.kind === 'file-history' && value.retention === 'protected')!
  if (history.kind === 'file-history') expect((await inspectWorkspaceClosure(state, history.content)).value).toEqual(row)
})
it('accepts exact 64 MiB opaque saves and rejects oversized input before publication', async () => {
  const f = await fixture(), bytes = new Uint8Array(CRYSTAL_SAVE_LIMITS.maxFileBytes)
  bytes[0] = 99
  // Boundary validation is independent from codec framing and transport envelope capacity
  expect(validateSaveImport(bytes)).toBeUndefined()
  await expect(f.saves().importFile('oversize.sav', new Uint8Array(CRYSTAL_SAVE_LIMITS.maxFileBytes + 1))).rejects.toThrow(/64 MiB/)
  expect(await f.saves().list()).toEqual([])
})
it('rejects a history request whose exact container differs from the captured workspace', async () => {
  const { retainFileRevision } = await import('../workspace/file-history')
  const f = await fixture(), row = await f.saves().importFile('first.sav', new Uint8Array([99, 1]))
  await f.advance()
  await expect(retainFileRevision(await f.repository().readWorkspace(), { ...row, filename: 'different.sav' }, 'protected')).rejects.toThrow(/captured|container/)
})
it('account persistence keeps invalid pending input encrypted and preserves exact originals after reopening', async () => {
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), db = new AccountDatabase(token.accountId)
  try {
    let repository = await openAccountRepository(token)
    let outcome: OwnedFileOutcome | undefined
    const saves = () => createSaveRepository(repository, { onOutcome: value => { outcome = value } })
    const advance = async () => { repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository }
    const bytes = encodeCrystalSave(createSaveEditorFixture()), row = await saves().importFile('private.sav', bytes)
    await advance()
    const saved = await saves().saveWorking(row.id, bytes, { fields: { currency: 'private invalid currency' } }, row.revision)
    await advance()
    const reopened = await openAccountRepository(token), state = await reopened.readWorkspace()
    expect(state.saveDocuments).toEqual([saved])
    expect(await readSaveContent(state, saved)).toEqual({ originalBytes: bytes, workingBytes: bytes })
    const persisted = await Promise.all(db.tables.map(async table => [table.name, await table.toArray()]))
    expect(JSON.stringify(persisted)).not.toContain('private invalid currency')
    expect(JSON.stringify(persisted)).not.toContain('private.sav')
  } finally { invalidateProfile(); await db.delete() }
})

it('explicit vanilla conversion validates the native preview while reset retains exact original mod bytes', async () => {
  const { previewVanillaConversion } = await import('../domain/save-editor')
  const { SAVE_EDITOR_CATALOG } = await import('../catalog/save-editor')
  const save = createModdedSaveEditorFixture({ equipped: true })
  const bytes = encodeCrystalSave(save), preview = previewVanillaConversion(save, SAVE_EDITOR_CATALOG)
  expect(preview.convertible).toBe(true)
  const f = await fixture(), row = await f.saves().importFile('modded.sav', bytes)
  await f.advance()
  const converted = await f.saves({ intent: 'saveApply', nativeIntent: 'vanilla' }).saveWorking(row.id, encodeCrystalSave(preview.draft!), null, row.revision)
  await f.advance()
  const reset = await f.saves({ intent: 'saveApply', nativeIntent: 'reset-original' }).saveWorking(row.id, bytes, null, converted.revision)
  await f.advance()
  expect(await readSaveContent(await f.repository().readWorkspace(), reset)).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
it('same-number divergent marker targets stay unknown even when only one shares working bytes', async () => {
  const { retainFileRevision } = await import('../workspace/file-history')
  const f = await fixture(), row = await f.saves().importFile('first.sav', new Uint8Array([99, 1]))
  await f.advance()
  const marked = await f.saves().markExported(row.id, row.revision)
  await f.advance()
  const state = await f.repository().readWorkspace()
  const identical = await retainFileRevision({ ...state, saveDocuments: [row] }, row, 'protected')
  expect(await saveExportStatus(identical, marked)).toBe('requested')
  const body = await (await import('../workspace/editor-document')).editorBlob(new Uint8Array([99, 2]), 'bytes')
  const fork = { ...row, working: body.ref, filename: 'independent branch.sav', pendingForm: { preserved: 'other exact container' } }
  const ambiguous = await retainFileRevision({ ...identical, blobs: [...identical.blobs, body], saveDocuments: [fork] }, fork, 'protected')
  expect(await saveExportStatus(ambiguous, marked)).toBe('unknown')
})
it('unknown pending payloads remain exact inert content across metadata marking', async () => {
  const { parseSavePending } = await import('../workspace/save-pending')
  const f = await fixture(), bytes = new Uint8Array([99, 1]), row = await f.saves().importFile('future.sav', bytes)
  await f.advance()
  const pending = { version: 99, fields: ['unknown shape'], newCapability: { documentId: 'inert' } }
  const saved = await f.saves().saveWorking(row.id, bytes, pending, row.revision)
  await f.advance()
  const marked = await f.saves().markExported(row.id, saved.revision)
  await f.advance()
  expect(marked.pendingForm).toEqual(pending)
  expect(parseSavePending(marked.pendingForm)).toEqual({ kind: 'unsupported', value: pending })
  expect((await readSaveContent(await f.repository().readWorkspace(), marked)).workingBytes).toEqual(bytes)
})
it('removal retains the full exact container and byte dependencies as protected history', async () => {
  const f = await fixture(), bytes = new Uint8Array([99, 14, 0]), row = await f.saves().importFile('removed.sav', bytes)
  await f.advance()
  await f.saves().remove(row.id, row.revision)
  await f.advance()
  const state = await f.repository().readWorkspace()
  expect(state.saveDocuments).toEqual([])
  const history = state.retainedContent.find(value => value.kind === 'file-history')!
  expect(history.retention).toBe('protected')
  expect((await inspectWorkspaceClosure(state, history.content)).value).toEqual(row)
  expect(await readSaveContent(state, row)).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
it('persists and reopens an opaque exact 64 MiB original without inventing codec support', async () => {
  const f = await fixture(), bytes = new Uint8Array(CRYSTAL_SAVE_LIMITS.maxFileBytes)
  bytes[0] = 99; bytes[bytes.length - 1] = 217
  const started = performance.now(), row = await f.saves().importFile('boundary.sav', bytes)
  console.info('save-64mib-imported', { elapsedMilliseconds: performance.now() - started })
  await f.advance()
  const content = await readSaveContent(await f.repository().readWorkspace(), row)
  expect(row.coverage.status).toBe('unsupported')
  console.info('save-64mib-read', { elapsedMilliseconds: performance.now() - started })
  expect(Buffer.from(content.originalBytes).equals(bytes)).toBe(true)
  expect(Buffer.from(content.workingBytes).equals(bytes)).toBe(true)
  console.info('save-64mib-guest', { elapsedMilliseconds: performance.now() - started, byteLength: bytes.length })
})
it('strict no-op Apply resets unsupported unfinished input without decoding or changing its marker target', async () => {
  const f = await fixture(), bytes = new Uint8Array([99, 0, 255, 8])
  const imported = await f.saves().importFile('future.sav', bytes)
  await f.advance()
  const recorded = await f.saves().saveWorking(imported.id, bytes, { version: 99, unknownChoice: ['preserve', 7] }, imported.revision)
  await f.advance()
  const marked = await f.saves().markExported(recorded.id, recorded.revision)
  await f.advance()
  const reset = await f.saves({ intent: 'saveApply' }).saveWorking(marked.id, bytes, { version: 1, member: 0, fields: {}, presentation: {} }, marked.revision)
  await f.advance()
  const state = await f.repository().readWorkspace()
  expect(reset.working).toEqual(marked.working)
  expect(reset.original).toEqual(marked.original)
  expect(reset.requirements).toEqual(marked.requirements)
  expect(reset.exportedRevision).toBe(marked.exportedRevision)
  expect(await saveExportStatus(state, reset)).toBe('requested')
  expect((await readSaveContent(state, reset)).workingBytes).toEqual(bytes)
  const retained = await Promise.all(state.retainedContent.filter(value => value.kind === 'file-history').map(async value => (await inspectWorkspaceClosure(state, value.content)).value))
  expect(retained).toContainEqual(marked)
})
it('modded Apply requires exact native context and retains full source receipts without publishing temporary catalogs', async () => {
  const { createSaveEditorModProjectFixture } = await import('../domain/save-editor.fixture')
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  const { createSaveEditorModSource } = await import('../domain/save-editor-mods')
  const { editSave } = await import('../domain/save-editor')
  const { SAVE_EDITOR_CATALOG } = await import('../catalog/save-editor')
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(createSaveEditorModProjectFixture())), 'synthetic.json')
  const catalog = preview.proposed.catalogs[0], source = createSaveEditorModSource(catalog, preview.warnings, 'file')
  const f = await fixture(), original = createModdedSaveEditorFixture(), bytes = encodeCrystalSave(original)
  const imported = await f.saves().importFile('modded.sav', bytes)
  await f.advance()
  const edited = encodeCrystalSave(editSave(original, SAVE_EDITOR_CATALOG, { type: 'currency', value: 7654 }, new Date(0), [source]))
  await expect(f.saves().saveWorking(imported.id, edited, null, imported.revision)).rejects.toThrow('Exact native editing context')
  expect((await f.saves().get(imported.id))!.working).toEqual(imported.working)
  const applied = await f.saves({ sources: [source], intent: 'saveApply' }).saveWorking(imported.id, edited, null, imported.revision)
  await f.advance()
  expect(applied.requirements).toEqual([expect.objectContaining({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: source.title })])
  const marked = await f.saves().markExported(applied.id, applied.revision)
  await f.advance()
  const state = await f.repository().readWorkspace()
  expect(state.planner.catalogs.some(value => value.id === catalog.id)).toBe(false)
  expect((await readSaveContent(state, marked)).workingBytes).toEqual(edited)
  const histories = await Promise.all(state.retainedContent.filter(value => value.kind === 'file-history').map(async value => (await inspectWorkspaceClosure(state, value.content)).value))
  expect(histories).toContainEqual(applied)
  expect(await saveExportStatus(state, marked)).toBe('requested')
})
it.each(['quota', 'other owner'] as const)('account Save activation rolls back %s failure without changing original, pending input or marker', async failure => {
  const { vi } = await import('vitest')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { newOwnedFileCommand } = await import('../workspace/owned-file-command')
  const { AccountDatabase } = await import('./account-database')
  const { default: Dexie } = await import('dexie')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    let outcome: OwnedFileOutcome | undefined
    let repository = await openAccountRepository(token)
    const row = await createSaveRepository(repository, { onOutcome: value => { outcome = value } }).importFile('private rollback.sav', new Uint8Array([99, 1]))
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const before = await repository.readWorkspace(), fence = await database.profileMeta.get('active')
    const put = IDBObjectStore.prototype.put
    if (failure === 'quota') vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'profileMeta') throw new DOMException('Synthetic Save quota failure', 'QuotaExceededError'); return put.apply(this, args) })
    let guarded = false
    const saves = createSaveRepository(repository, { begin: operation => newOwnedFileCommand(operation, () => { if (failure === 'other owner' && Dexie.currentTransaction?.storeNames.includes('profileMeta')) { guarded = true; throw new Error('Synthetic Save other owner') } }), onOutcome: value => { outcome = value } })
    await expect(saves.markExported(row.id, row.revision)).rejects.toThrow(failure === 'quota' ? 'quota' : 'other owner')
    vi.restoreAllMocks()
    expect(failure === 'quota' || guarded).toBe(true)
    expect(outcome!.status).toBe('not-saved')
    expect(await database.profileMeta.get('active')).toEqual(fence)
    const after = await repository.readWorkspace()
    expect(after.saveDocuments).toEqual(before.saveDocuments)
    expect(after.retainedContent).toEqual(before.retainedContent)
    expect(after.planner.localData).toEqual(before.planner.localData)
    expect(await readSaveContent(after, row)).toEqual({ originalBytes: new Uint8Array([99, 1]), workingBytes: new Uint8Array([99, 1]) })
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})
it('moddedRandomizedCoverageIsNotGuessed', async () => {
  const { setSaveEditorFixtureRandomizer, createSaveEditorModProjectFixture } = await import('../domain/save-editor.fixture')
  const { createSaveEditorModSource } = await import('../domain/save-editor-mods')
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  const { inspectSave } = await import('../domain/save-editor')
  const { SAVE_EDITOR_CATALOG } = await import('../catalog/save-editor')
  const project = createSaveEditorModProjectFixture(), preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ...project, Version: 'different' })), 'different.json')
  const source = createSaveEditorModSource(preview.proposed.catalogs[0], preview.warnings, 'file')
  expect(inspectSave(createModdedSaveEditorFixture(), SAVE_EDITOR_CATALOG, [source]).editable).toBe(false)
  const unknown = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { Equipment: true } })
  delete unknown.party.value.RandomizerMapping
  expect(inspectSave(unknown, SAVE_EDITOR_CATALOG).editable).toBe(false)
  const bytes = encodeCrystalSave(unknown), f = await fixture(), row = await f.saves().importFile('unknown-randomizer.sav', bytes)
  await f.advance()
  expect(row.coverage.status).toBe('supported')
  expect(row.coverage.diagnostics).toContain('Exact editing context is unavailable. Working bytes remain read-only until native coverage is verified.')
  const changed = createSaveEditorFixture(); changed.header.currencyAmount = 5
  await expect(f.saves().saveWorking(row.id, encodeCrystalSave(changed), null, row.revision)).rejects.toThrow('Exact native editing context')
  expect((await readSaveContent(await f.repository().readWorkspace(), row))).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
