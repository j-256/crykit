import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { afterEach, expect, it, vi } from 'vitest'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { CryKitDatabase } from './database'
import { createEditorRepository } from '../workspace/editor-repository'
import { readEditorContent, validateEditorContainer } from '../workspace/editor-document'
import { resolveOwnedFileReceipt, verifyOwnedFileReceipt, type OwnedFileOutcome } from '../workspace/owned-file-command'
import type { WorkspaceRepository } from '../workspace/repository'
import { inspectWorkspaceClosure } from '../workspace/closure'

// Named participant and native receipt tests retain their actual pre-managed storage subject
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => original.name.startsWith('native-editor-test-') ? { kind: 'legacy-recovery', binding: await openGuestBindings(original) } : actual.prepareGuestStartup(original) }
})

const databases: CryKitDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) database.close() })
async function fixture(native = false) {
  const database = new CryKitDatabase(`${native ? 'native-' : ''}editor-test-${crypto.randomUUID()}`)
  databases.push(database)
  let repository: WorkspaceRepository = createGuestRepository(database)
  let outcome: OwnedFileOutcome | undefined
  const editor = () => createEditorRepository(repository, { onOutcome: value => { outcome = value } })
  const advance = async () => {
    expect(outcome?.status).toBe('saved')
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    outcome = undefined
  }
  return { editor, advance, repository: () => repository, outcome: () => outcome }
}
it('invalidUnfinishedTextReopensWithoutPromotion', async () => {
  const f = await fixture(), bytes = new TextEncoder().encode('{"Name":"original"}')
  const imported = await f.editor().importFile({ filename: 'mod.json', text: new TextDecoder().decode(bytes), bytes, referenceId: 'native' })
  await f.advance()
  const before = await f.repository().readWorkspace()
  const saved = await f.editor().saveUnfinished(imported.id, { text: '{"broken":', editedPath: [], fieldState: { value: '{"broken":' }, validation: 'invalid' }, imported.revision)
  await f.advance()
  const after = await f.repository().readWorkspace(), reopened = await readEditorContent(after, saved)
  expect(reopened.unfinishedText).toBe('{"broken":')
  expect(reopened.originalBytes).toEqual(bytes)
  expect(reopened.lastAppliedText).toBe('{"Name":"original"}')
  expect(after.planner.catalogs).toEqual(before.planner.catalogs)
  expect(validateEditorContainer(saved)).toEqual(saved)
  await expect(f.editor().applyDraft(saved.id, saved.revision)).rejects.toThrow()
  expect((await f.repository().readWorkspace()).editorDocuments).toEqual(after.editorDocuments)
  expect(after.retainedContent.filter(row => row.kind === 'file-history')).toHaveLength(1)
  const history = after.retainedContent.find(row => row.kind === 'file-history')!
  if (history.kind === 'file-history') expect((await inspectWorkspaceClosure(after, history.content)).value).toEqual(imported)
})
it('retainsMapAndFieldEditsAcrossDevice', async () => {
  const f = await fixture()
  const row = await f.editor().importFile({ filename: 'map.json', text: '{"Entities":[]}', referenceId: 'native' })
  await f.advance()
  const pendingMapAndFieldState = { field: '"unfinished', map: { X: '-', Y: '12', Z: '', tool: 'move' } }
  const saved = await f.editor().saveUnfinished(row.id, { text: '{"Entities":[]}', editedPath: ['Entities'], fieldState: pendingMapAndFieldState, validation: 'invalid' }, row.revision)
  await f.advance()
  expect((await f.editor().get(saved.id))?.unfinished.fieldState).toEqual(pendingMapAndFieldState)
  await expect(f.editor().saveUnfinished(saved.id, { text: '{}', editedPath: [], fieldState: null, validation: 'valid' }, row.revision)).rejects.toThrow(/revision|changed/i)
})
it('legacyTextOnlyOriginalPreservesCodeUnits', async () => {
  const f = await fixture(true)
  const binding = await guestRepositoryBindings(f.repository())
  const legacy = await binding.inspector.import('legacy.json', '{"Name":"\ud800"}', 'old-reference')
  const rows = await f.editor().list()
  expect(rows.find(row => row.id === legacy.id)?.originalByteIdentity).toBe('text-only')
  const row = rows.find(row => row.id === legacy.id)!
  const loneSurrogateDraft = '{"broken":"\ud800'
  const saved = await f.editor().saveUnfinished(row.id, { text: loneSurrogateDraft, editedPath: [], fieldState: { value: '\ud800' }, validation: 'invalid' }, row.revision)
  await f.advance()
  const content = await readEditorContent(await f.repository().readWorkspace(), saved)
  expect(content.unfinishedText).toBe(loneSurrogateDraft)
  expect(content.originalText).toBe(legacy.originalText)
  expect((await binding.inspector.get(legacy.id))?.originalText).toBe(legacy.originalText)
})

it('account commands keep invalid text encrypted and apply only explicitly', async () => {
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    let repository = await openAccountRepository(token)
    let outcome: OwnedFileOutcome | undefined
    const editor = () => createEditorRepository(repository, { onOutcome: value => { outcome = value } })
    const row = await editor().importFile({ filename: 'private-marker.json', text: '{"secret-marker":"original"}', referenceId: 'native' })
    expect(outcome?.status).toBe('saved')
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const saved = await editor().saveUnfinished(row.id, { text: '{"secret-marker":"draft"}', editedPath: [], fieldState: { secret: 'not applied' }, validation: 'valid' }, row.revision)
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    expect((await readEditorContent(await repository.readWorkspace(), saved)).lastAppliedText).toContain('original')
    const applied = await editor().applyDraft(saved.id, saved.revision)
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    expect((await readEditorContent(await repository.readWorkspace(), applied)).lastAppliedText).toContain('draft')
    for (const table of database.tables) await table.each(value => {
      const encoded = table.name === 'stagedCipherChunks' ? new TextDecoder().decode(value.bytes) : JSON.stringify(value)
      expect(encoded).not.toContain('secret-marker')
      expect(encoded).not.toContain('private-marker')
    })
  } finally { invalidateProfile(); await database.delete() }
})

it('rejects changed owner authority in the real final guest pointer transaction', async () => {
  const { newOwnedFileCommand } = await import('../workspace/owned-file-command')
  const f = await fixture(), before = await f.repository().readWorkspace()
  const { default: Dexie } = await import('dexie')
  let reachedFinalTransaction = false, outcome: OwnedFileOutcome | undefined
  const editor = createEditorRepository(f.repository(), { begin: operation => newOwnedFileCommand(operation, () => {
    if (Dexie.currentTransaction?.storeNames.includes('active')) { reachedFinalTransaction = true; throw new Error('another owner became dirty') }
  }), onOutcome: value => { outcome = value } })
  await expect(editor.importFile({ filename: 'blocked.json', text: '{}', referenceId: 'native' })).rejects.toThrow('another owner')
  expect(reachedFinalTransaction).toBe(true)
  expect(outcome?.status).toBe('not-saved')
  expect((await f.repository().readWorkspace()).editorDocuments).toEqual(before.editorDocuments)
  expect((await f.repository().readWorkspace()).planner.localData.revision).toBe(before.planner.localData.revision)
})
it('distinguishes post-pointer rejection from rollback and rechecks actual successor on repeated receipts', async () => {
  const { vi } = await import('vitest')
  const f = await fixture(true)
  vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('synthetic post-pointer notification failure') } })
  try {
    const row = await f.editor().importFile({ filename: 'saved.json', text: '{}', referenceId: 'native' })
    const outcome = f.outcome()!
    expect(outcome.status).toBe('saved')
    expect(String(outcome.error)).toContain('post-pointer')
    const a = await resolveOwnedFileReceipt(outcome.receipt!), b = await resolveOwnedFileReceipt(outcome.receipt!)
    expect(a.state.editorDocuments).toEqual([row])
    expect(b.state.editorDocuments).toEqual([row])
    expect(a.state.planner.localData.revision).toBe(b.state.planner.localData.revision)
    await expect(f.repository().readWorkspace()).rejects.toThrow(/retired/i)
  } finally { vi.unstubAllGlobals() }
})
it('quota failure preserves the account fence, original bytes and pending draft for retry', async () => {
  const { vi } = await import('vitest')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const db = new AccountDatabase(token.accountId)
  try {
    let repository = await openAccountRepository(token), outcome: OwnedFileOutcome | undefined
    const editor = () => createEditorRepository(repository, { onOutcome: value => { outcome = value } })
    const row = await editor().importFile({ filename: 'quota.json', text: '{}', referenceId: 'native' })
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const fence = await db.profileMeta.get('active'), before = await repository.readWorkspace()
    const originalPut = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'profileMeta') throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      return originalPut.apply(this, args)
    })
    const input = { text: '{"broken":', editedPath: [], fieldState: { field: '-' }, validation: 'invalid' as const }
    await expect(editor().saveUnfinished(row.id, input, row.revision)).rejects.toThrow('quota')
    fault.mockRestore()
    expect(await db.profileMeta.get('active')).toEqual(fence)
    expect((await repository.readWorkspace()).editorDocuments).toEqual(before.editorDocuments)
    const retried = await editor().saveUnfinished(row.id, input, row.revision)
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    expect((await readEditorContent(await repository.readWorkspace(), retried)).unfinishedText).toBe(input.text)
  } finally { vi.restoreAllMocks(); invalidateProfile(); await db.delete() }
})

it('rejects legacy edits made after translation and before the coordinator capture', async () => {
  const { newOwnedFileCommand } = await import('../workspace/owned-file-command')
  const f = await fixture(true), binding = await guestRepositoryBindings(f.repository())
  const legacy = await binding.inspector.import('legacy-race.json', '{"Count":1}', 'native')
  let changed = false
  const editor = createEditorRepository(f.repository(), { begin: operation => newOwnedFileCommand(operation, () => {
    if (!changed) {
      changed = true
      // The asynchronous old-writer completes while the new command translates and prepares its body
      void binding.inspector.save(legacy.id, '{"Count":2}', legacy.revision)
    }
  }) })
  await expect(editor.saveUnfinished(legacy.id, { text: '{"unfinished":', editedPath: [], fieldState: null, validation: 'unchecked' }, legacy.revision)).rejects.toThrow()
  expect((await binding.coordinator.active.get('active'))?.manifest.id).toBe(binding.manifest.id)
})

it('reconciles an uncertain published command without a second activation', async () => {
  const { reconcileOwnedFileOutcome } = await import('../workspace/owned-file-command')
  const f = await fixture(true), binding = await guestRepositoryBindings(f.repository())
  const originalPut = IDBObjectStore.prototype.put, originalGet = IDBObjectStore.prototype.get
  let published = false, lostRead = false, outcome: OwnedFileOutcome | undefined
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'active' && (args[0] as { manifest?: { id?: string } }).manifest?.id !== binding.manifest.id) published = true
    return originalPut.apply(this, args)
  }
  IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
    if (this.name === 'journal' && published && !lostRead) { lostRead = true; throw new Error('Synthetic lost journal read') }
    return originalGet.call(this, key)
  }
  try {
    const editor = createEditorRepository(f.repository(), { onOutcome: value => { outcome = value } })
    await expect(editor.importFile({ filename: 'uncertain.json', text: '{}', referenceId: 'native' })).rejects.toThrow()
    expect(outcome?.status).toBe('uncertain')
  } finally { IDBObjectStore.prototype.put = originalPut; IDBObjectStore.prototype.get = originalGet }
  const count = await binding.coordinator.journal.count(), active = await binding.coordinator.active.get('active')
  const resolved = await reconcileOwnedFileOutcome(outcome!)
  expect(resolved.status).toBe('saved')
  expect((await resolveOwnedFileReceipt(resolved.receipt!)).state.editorDocuments.map(file => file.filename)).toEqual(['uncertain.json'])
  expect((await reconcileOwnedFileOutcome(outcome!)).receipt?.id).toBe(resolved.receipt?.id)
  expect(await binding.coordinator.journal.count()).toBe(count)
  expect(await binding.coordinator.active.get('active')).toEqual(active)
})

it('encrypted staging admits only inert descendants and acknowledges the captured version before a successor save', async () => {
  const { vi } = await import('vitest')
  const { EditorInputController } = await import('../workspace/editor-input-controller')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    let repository = await openAccountRepository(token), outcome: OwnedFileOutcome | undefined
    const row = await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'descendant.json', text: '{"base":1}', bytes: new TextEncoder().encode('{"base":1}'), referenceId: 'native' })
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const controller = new EditorInputController(), oldView = controller.attach()
    controller.open(oldView, row.id, row.revision, { original: JSON.stringify(row.original), applied: JSON.stringify(row.lastApplied), reference: row.referenceId }, { text: '{"V":', editedPath: [], fieldState: null, validation: 'unchecked' })
    controller.editText(oldView, '{"V":')
    const ticket = controller.capture(oldView, 'saveUnfinished', () => {})
    let descendant = false
    const originalAdd = IDBObjectStore.prototype.add
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'stagedCipherChunks' && !descendant) { descendant = true; controller.editText(oldView, '{"V+1":') }
      return originalAdd.apply(this, args)
    })
    const saved = await createEditorRepository(repository, { begin: () => ticket.command, onOutcome: value => { outcome = value } }).saveUnfinished(row.id, ticket.input!, row.revision)
    fault.mockRestore()
    expect(descendant).toBe(true)
    const completion = await resolveOwnedFileReceipt(outcome!.receipt!)
    expect((await readEditorContent(completion.state, saved)).unfinishedText).toBe('{"V":')
    controller.acknowledge(ticket, saved.revision)
    expect(controller.snapshot()).toMatchObject({ dirty: true, input: { text: '{"V+1":' } })
    const nextView = controller.transfer(oldView)
    expect(() => controller.editText(oldView, 'late callback')).toThrow('retired')
    controller.hydrated(nextView)
    repository = completion.repository
    const nextTicket = controller.capture(nextView, 'saveUnfinished', () => {})
    const next = await createEditorRepository(repository, { begin: () => nextTicket.command, onOutcome: value => { outcome = value } }).saveUnfinished(saved.id, nextTicket.input!, saved.revision)
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const state = await repository.readWorkspace(), content = await readEditorContent(state, next)
    expect(content.unfinishedText).toBe('{"V+1":')
    expect(content.originalBytes).toEqual(new TextEncoder().encode('{"base":1}'))
    expect(content.lastAppliedText).toBe('{"base":1}')
    const previous = state.retainedContent.filter(item => item.kind === 'file-history')
    expect(previous).toHaveLength(2)
    expect((await inspectWorkspaceClosure(state, previous[1].content)).value).toEqual(saved)
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('encrypted final activation rejects a new owner and preserves the exact preceding fence and workspace', async () => {
  const { newOwnedFileCommand } = await import('../workspace/owned-file-command')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const { default: Dexie } = await import('dexie')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const repository = await openAccountRepository(token), before = await repository.readWorkspace(), fence = await database.profileMeta.get('active')
    let finalGuard = false, outcome: OwnedFileOutcome | undefined
    const editor = createEditorRepository(repository, { begin: operation => newOwnedFileCommand(operation, () => {
      if (Dexie.currentTransaction?.storeNames.includes('profileMeta')) { finalGuard = true; throw new Error('A new queue owns this workspace') }
    }), onOutcome: value => { outcome = value } })
    await expect(editor.importFile({ filename: 'blocked.json', text: '{}', referenceId: 'native' })).rejects.toThrow('new queue')
    expect(finalGuard).toBe(true)
    expect(outcome?.status).toBe('not-saved')
    expect(await database.profileMeta.get('active')).toEqual(fence)
    expect((await repository.readWorkspace()).editorDocuments).toEqual(before.editorDocuments)
    expect((await repository.readWorkspace()).planner.localData).toEqual(before.planner.localData)
  } finally { invalidateProfile(); await database.delete() }
})

it('retires old encrypted repository reads and queued callbacks independently of the unchanged profile token', async () => {
  const { installProfile, invalidateProfile, currentProfileToken } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let release!: () => void
  try {
    const repository = await openAccountRepository(token), before = await repository.load()
    const gate = new Promise<void>(resolve => { release = resolve })
    const queued = gate.then(() => repository.save(before.localData, before.revision)).then(() => 'saved', error => String(error))
    let outcome: OwnedFileOutcome | undefined
    await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'incarnation.json', text: '{}', referenceId: 'native' })
    await expect(repository.readWorkspace()).rejects.toThrow('changed')
    const completion = await resolveOwnedFileReceipt(outcome!.receipt!)
    expect(currentProfileToken()).toBe(token)
    release()
    expect(await queued).toContain('retired')
    await expect(repository.load()).rejects.toThrow('retired')
    await expect(repository.readWorkspace()).rejects.toThrow('retired')
    expect((await completion.repository.readWorkspace()).editorDocuments[0].filename).toBe('incarnation.json')
  } finally { release?.(); vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('rechecks encrypted repository incarnation after the final complete-read fence await', async () => {
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { openAccountManagedRepository } = await import('../workspace/account-managed-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let release!: () => void
  try {
    await openAccountRepository(token)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    let outcome: OwnedFileOutcome | undefined, entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const get = database.profileMeta.get.bind(database.profileMeta) as (key: string) => Promise<import('./account-database').AccountFence | undefined>
    vi.spyOn(database.profileMeta, 'get').mockImplementationOnce((async (key: string) => {
      const result = await get(key)
      entered = true
      await gate
      return result
    }) as typeof database.profileMeta.get)
    const read = repository.readWorkspace().then(() => 'resolved', error => String(error))
    await vi.waitFor(() => expect(entered).toBe(true))
    await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'final-fence.json', text: '{}', referenceId: 'native' })
    await resolveOwnedFileReceipt(outcome!.receipt!)
    release()
    expect(await read).toContain('retired')
  } finally { release?.(); vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('bounds owned account repository connections and cleanup registrations across repeated receipts and saves', async () => {
  const { vi } = await import('vitest')
  const profile = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = profile.installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let registrations = 0
  const register = profile.registerProfileCleanup
  vi.spyOn(profile, 'registerProfileCleanup').mockImplementation((captured, cleanup) => {
    registrations++
    let live = true
    const release = () => { if (live) { live = false; registrations-- } }
    const unregister = register(captured, () => { release(); cleanup() })
    return () => { release(); unregister() }
  })
  const connections = new Set<IDBDatabase>(), open = indexedDB.open.bind(indexedDB), close = IDBDatabase.prototype.close
  vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
    const request = open(...args)
    request.addEventListener('success', () => { if (request.result.name === database.name) connections.add(request.result) })
    return request
  })
  vi.spyOn(IDBDatabase.prototype, 'close').mockImplementation(function (this: IDBDatabase) { connections.delete(this); close.call(this) })
  try {
    let repository = await openAccountRepository(token), outcome: OwnedFileOutcome | undefined
    // The first command initializes one profile-wide foreground scheduler, independent of repository wrappers
    const { withAccountForeground } = await import('../account/background-work')
    await withAccountForeground(token, async () => {})
    const ownedRegistrations = registrations
    expect(ownedRegistrations).toBeGreaterThan(0)
    let file = await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'bounded.json', text: '{}', referenceId: 'native' })
    const [first, concurrent] = await Promise.all([resolveOwnedFileReceipt(outcome!.receipt!), resolveOwnedFileReceipt(outcome!.receipt!)])
    expect(concurrent.repository).toBe(first.repository)
    expect(registrations).toBe(ownedRegistrations)
    expect(connections.size).toBe(1)
    const freshRead = vi.spyOn(first.repository, 'readWorkspace')
    const repeated = await resolveOwnedFileReceipt(outcome!.receipt!)
    // Repeated continuation uses the admitted result plus its exact durable receipt, not a full unrelated-body scan
    expect(freshRead).not.toHaveBeenCalled()
    expect(repeated.repository).toBe(first.repository)
    expect(registrations).toBe(ownedRegistrations)
    expect(connections.size).toBe(1)
    repository = first.repository
    file = await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).saveUnfinished(file.id, { text: '{"later":', editedPath: [], fieldState: null, validation: 'invalid' }, file.revision)
    const second = await resolveOwnedFileReceipt(outcome!.receipt!)
    expect((await second.repository.readWorkspace()).editorDocuments[0]).toEqual(file)
    expect(registrations).toBe(ownedRegistrations)
    expect(connections.size).toBe(1)
    profile.invalidateProfile()
    expect(registrations).toBe(0)
    await vi.waitFor(() => expect(connections.size).toBe(0))
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow()
  } finally { vi.restoreAllMocks(); profile.invalidateProfile(); await database.delete() }
})


it('rejects changed encrypted completion metadata and authenticates stored bytes on verification and reopen', async () => {
  const { vi } = await import('vitest')
  const profile = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = profile.installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let registrations = 0
  const register = profile.registerProfileCleanup
  vi.spyOn(profile, 'registerProfileCleanup').mockImplementation((captured, cleanup) => {
    registrations++
    let live = true
    const release = () => { if (live) { live = false; registrations-- } }
    const unregister = register(captured, () => { release(); cleanup() })
    return () => { release(); unregister() }
  })
  try {
    const repository = await openAccountRepository(token)
    let outcome: OwnedFileOutcome | undefined
    await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'candidate.json', text: '{}', referenceId: 'native' })
    const ownedRegistrations = registrations, receipt = outcome!.receipt!
    const journal = (await database.migrationJournal.get(receipt.id))!
    expect(journal).toBeDefined()
    await database.migrationJournal.put({ ...journal, headRevision: journal.headRevision + 1 })
    await expect(resolveOwnedFileReceipt(receipt)).rejects.toThrow('receipt changed')
    expect(registrations).toBe(ownedRegistrations)
    await database.migrationJournal.put(journal)
    const completion = await resolveOwnedFileReceipt(receipt)
    expect((await completion.repository.readWorkspace()).editorDocuments[0].filename).toBe('candidate.json')
    expect(registrations).toBe(ownedRegistrations)
    // Continuation checks its exact published receipt; read-only recovery and a fresh opener authenticate actual bodies
    const record = (await database.encryptedRevisions.get(journal.head.revisionId))!
    const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    const corrupt = chunk.bytes.slice(); corrupt[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes: corrupt })
    await expect(verifyOwnedFileReceipt(receipt)).rejects.toThrow()
    await expect(openAccountRepository(token)).rejects.toThrow()
    expect(registrations).toBe(ownedRegistrations)
    await database.stagedCipherChunks.put(chunk)
    await verifyOwnedFileReceipt(receipt)
    expect((await resolveOwnedFileReceipt(receipt)).repository).toBe(completion.repository)
    expect(registrations).toBe(ownedRegistrations)
    await expect(resolveOwnedFileReceipt({ id: outcome!.receipt!.id })).rejects.toThrow('Unknown file command receipt')
  } finally { profile.invalidateProfile(); vi.restoreAllMocks(); await database.delete() }
})

it('keeps durable encrypted V recoverable when another legitimate command wins before reconciliation', async () => {
  const profile = await import('../account/profile')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { AccountDatabase } = await import('./account-database')
  const token = profile.installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const repository = await openAccountRepository(token)
    let outcome: OwnedFileOutcome | undefined
    const file = await createEditorRepository(repository, { onOutcome: value => { outcome = value } }).importFile({ filename: 'durable-v.json', bytes: new Uint8Array([123, 125]), text: '{}', referenceId: 'native' })
    const savedFence = await database.profileMeta.get('active'), other = await openAccountRepository(token), before = await other.readWorkspace()
    await other.commitWorkspace(before, before.planner.localData.revision)
    expect(await database.profileMeta.get('active')).not.toEqual(savedFence)
    expect(outcome!.status).toBe('saved')
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('changed')
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow('changed')
    // A new operation opens the actual selected successor; an old receipt cannot grant its authority
    await expect(repository.readWorkspace()).rejects.toThrow('changed')
    const state = await (await openAccountRepository(token)).readWorkspace()
    expect(state.editorDocuments).toEqual([file])
    expect((await readEditorContent(state, file)).originalBytes).toEqual(new Uint8Array([123, 125]))
    profile.invalidateProfile()
    await expect(resolveOwnedFileReceipt(outcome!.receipt!)).rejects.toThrow()
  } finally { profile.invalidateProfile(); await database.delete() }
})


it('reuses one guest successor for concurrent receipts and keeps exact shared handles alive after candidate failure', async () => {
  const { vi } = await import('vitest')
  const guest = await import('../workspace/guest-workspace')
  const f = await fixture(true), binding = await guestRepositoryBindings(f.repository())
  await binding.planner.open(); const inspector = await binding.inspector.openDatabase(); await inspector.open()
  const row = await f.editor().importFile({ filename: 'guest-lifetime.json', text: '{}', referenceId: 'native' })
  const close = vi.spyOn((await import('dexie')).default.prototype, 'close')
  const read = guest.readGuestWorkspace
  let candidate: Awaited<ReturnType<typeof guestRepositoryBindings>> | undefined
  const fault = vi.spyOn(guest, 'readGuestWorkspace').mockImplementationOnce(async (...args) => {
    candidate = args[0]
    const state = await read(...args)
    return { ...state, planner: { ...state.planner, localData: { ...state.planner.localData, revision: state.planner.localData.revision + 1 } } }
  })
  try {
    await expect(resolveOwnedFileReceipt(f.outcome()!.receipt!)).rejects.toThrow()
    expect(candidate!.planner.isOpen()).toBe(false)
    expect(candidate!.files.isOpen()).toBe(false)
    expect(close.mock.contexts).toContain(candidate!.planner)
    expect(close.mock.contexts).toContain(candidate!.files)
    expect(binding.planner.isOpen()).toBe(true)
    expect(inspector.isOpen()).toBe(true)
    expect(binding.coordinator.isOpen()).toBe(true)
    expect(await binding.planner.localDatas.count()).toBeGreaterThan(0)
    fault.mockRestore()
    const [first, concurrent] = await Promise.all([resolveOwnedFileReceipt(f.outcome()!.receipt!), resolveOwnedFileReceipt(f.outcome()!.receipt!)])
    expect(concurrent.repository).toBe(first.repository)
    const freshRead = vi.spyOn(first.repository, 'readWorkspace')
    expect((await resolveOwnedFileReceipt(f.outcome()!.receipt!)).repository).toBe(first.repository)
    expect(freshRead).toHaveBeenCalledTimes(1)
    const next = createEditorRepository(first.repository)
    await next.saveUnfinished(row.id, { text: '{"later":', editedPath: [], fieldState: null, validation: 'invalid' }, row.revision)
    await expect(resolveOwnedFileReceipt(f.outcome()!.receipt!)).rejects.toThrow('no longer selected')
    await expect(f.repository().readWorkspace()).rejects.toThrow('retired')
    expect(binding.planner.isOpen()).toBe(true)
    expect(inspector.isOpen()).toBe(true)
  } finally { vi.restoreAllMocks() }
})

it('revalidates untouched guest file bodies before granting owned completion', async () => {
  const { vi } = await import('vitest')
  const guest = await import('../workspace/guest-workspace')
  const { memoryBlob, blobIdentity } = await import('../workspace/blobs')
  const f = await fixture(true)
  const first = await f.editor().importFile({ filename: 'unaffected.json', text: '{}', referenceId: 'native' })
  await f.advance()
  await f.editor().importFile({ filename: 'new.json', text: '{}', referenceId: 'native' })
  const read = guest.readGuestWorkspace
  vi.spyOn(guest, 'readGuestWorkspace').mockImplementationOnce(async (...args) => {
    const state = await read(...args)
    return { ...state, blobs: state.blobs.map(blob => blobIdentity(blob.ref) === blobIdentity(first.original) ? { ...blob, content: memoryBlob(new Uint8Array(blob.ref.byteLength)) } : blob) }
  })
  try { await expect(resolveOwnedFileReceipt(f.outcome()!.receipt!)).rejects.toThrow() }
  finally { vi.restoreAllMocks() }
})
