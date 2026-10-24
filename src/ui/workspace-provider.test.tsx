import 'fake-indexeddb/auto'
import { createPersonalDefinition } from '../domain'
import { createTestLocalData } from '../domain/test-helpers'
import { act, useState, useLayoutEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, type ProfileToken } from '../account/profile'
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider'
import * as account from '../workspace/account-repository'
import * as lifecycle from '../account/lifecycle'
import * as selection from '../workspace/device-selection'
import * as device from '../account/device-store'
import { markWorkspaceAccess } from '../workspace/profile-selection'
import { createGuestRepository } from '../workspace/guest-repository'
import * as guest from '../workspace/guest-repository'
import '../workspace/guest-managed-monitor.test-helpers'
import { GUEST_ACTIVATED_EVENT } from '../workspace/guest-workspace'
import { CryKitDatabase, setDatabaseForTests } from '../persistence/database'
import * as guestStartup from '../workspace/guest-managed-startup'

const { FixtureTextEncoder } = vi.hoisted(() => {
  // jsdom supplies Node's encoder, which returns foreign arrays rejected by the actual crypto wrapper
  class FixtureTextEncoder extends TextEncoder {
    override encode(value?: string): Uint8Array<ArrayBuffer> { return new Uint8Array(super.encode(value)) }
  }
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  return { FixtureTextEncoder }
})

// Ownership fixtures keep their closed synthetic planner; catalog admission is covered by native browser journeys
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

vi.mock('../workspace/device-selection', () => ({ readDeviceSelection: vi.fn(async () => undefined), writeDeviceSelection: vi.fn(async () => {}) }))
vi.mock('../account/device-store', () => ({ listCachedProfiles: vi.fn(async () => []) }))
let root: Root
let container: HTMLDivElement
let db: CryKitDatabase
let token: ProfileToken
let open: (token: ProfileToken) => Promise<void>
let selectedSyncState: ReturnType<typeof useWorkspace>['syncState']
let selectedRepository: ReturnType<typeof createGuestRepository>
let reopenGuest: () => Promise<void>
let reopenAccount: () => Promise<void>

it('opens a fresh account entry without preparing guest data, then explicitly continues locally', async () => {
  const previous = window.location.hash
  const prepare = vi.spyOn(guestStartup, 'prepareGuestStartup')
  window.history.replaceState(null, '', '#/settings/account')
  invalidateProfile()
  try {
    await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
    expect(container.querySelector('input[type="email"]')).not.toBeNull()
    expect(container.textContent).not.toContain('guest:clean')
    expect(prepare).not.toHaveBeenCalled()
    const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Continue using this device')!
    await act(async () => button.click())
    expect(container.textContent).toContain('guest:clean')
    await selectedRepository.load()
    expect(prepare).toHaveBeenCalled()
  } finally { window.history.replaceState(null, '', previous || '#/builds') }
})

function Probe() {
  const workspace = useWorkspace()
  open = workspace.openAccount
  selectedRepository = workspace.repository
  reopenGuest = workspace.reopenGuest
  reopenAccount = workspace.reopenAccount
  selectedSyncState = workspace.syncState
  const [draft, setDraft] = useState('clean')
  const currentDraft = useRef(draft); currentDraft.current = draft
  useLayoutEffect(() => workspace.registerDraftPresence(() => currentDraft.current !== 'clean'), [workspace.registerDraftPresence])
  return <button onClick={() => setDraft('private draft')}>{workspace.repository.kind}:{draft}</button>
}
beforeEach(async () => {
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  await sameRealmIndexedDb(false)
  vi.mocked(selection.readDeviceSelection).mockResolvedValue(undefined)
  vi.mocked(device.listCachedProfiles).mockResolvedValue([])
  sessionStorage.clear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  db = new CryKitDatabase(`provider-${crypto.randomUUID()}`); setDatabaseForTests(db)
  // Provider ownership tests need a real closed planner, not unrelated first-run starter Build archives
  const localData = { ...createTestLocalData(), revision: 0, changes: [] }
  await db.localDatas.add({ id: 'local-data-record', revision: 0, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setDatabaseForTests(undefined); await db.delete() })
it('remounts drafts on account activation and locks without opening guest data', async () => {
  const repository = { ...createGuestRepository(), kind: 'account' as const }
  vi.spyOn(account, 'openAccountRepository').mockResolvedValue(repository)
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toBe('guest:private draft')
  await act(async () => open(token))
  expect(container.textContent).toContain('account:clean')
  await act(async () => invalidateProfile())
  expect(container.textContent).toContain('Account workspace locked')
  expect(container.textContent).not.toContain('guest:')
})
it('a delayed old account opening cannot install after a profile transition', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof account.openAccountRepository>>) => void
  vi.spyOn(account, 'openAccountRepository').mockReturnValue(new Promise(finish => { resolve = finish }))
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const pending = open(token)
  invalidateProfile()
  resolve({ ...createGuestRepository(), kind: 'account' })
  await expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(container.textContent).toBe('guest:clean')
})

it.each(['password-only', 'missing-envelope', 'bad-envelope', 'locked-tab', 'invalid-selection', 'missing-selection'])('startup keeps %s account access closed without guest fallback', async mode => {
  markWorkspaceAccess(mode === 'locked-tab' ? 'account-locked' : 'account-open')
  vi.mocked(selection.readDeviceSelection).mockResolvedValue(mode === 'missing-selection' ? undefined : { key: 'selected', version: 1, kind: 'account', accountId: token.accountId })
  if (mode === 'invalid-selection') vi.mocked(selection.readDeviceSelection).mockRejectedValue(new Error('invalid'))
  vi.mocked(device.listCachedProfiles).mockResolvedValue(mode === 'missing-envelope' ? [] : [{ accountId: token.accountId, remembered: mode !== 'password-only', passwordAvailable: true, revocationPending: false }])
  const unlock = vi.spyOn(lifecycle, 'unlockRememberedProfile').mockRejectedValue(new Error('invalid envelope'))
  invalidateProfile()
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  expect(container.textContent).toContain('Account workspace locked')
  expect(container.textContent).not.toContain('guest:')
  if (mode === 'locked-tab') expect(unlock).not.toHaveBeenCalled()
})
it('remembered startup opens exactly the selected account through verified lifecycle access', async () => {
  const selectedId = token.accountId
  invalidateProfile()
  vi.mocked(selection.readDeviceSelection).mockResolvedValue({ key: 'selected', version: 1, kind: 'account', accountId: selectedId })
  vi.mocked(device.listCachedProfiles).mockResolvedValue([{ accountId: selectedId, remembered: true, passwordAvailable: true, revocationPending: false }, { accountId: 'YmJiYmJiYmJiYmJiYmJiYg', remembered: true, passwordAvailable: true, revocationPending: false }])
  const unlock = vi.spyOn(lifecycle, 'unlockRememberedProfile').mockImplementation(async accountId => installProfile(accountId, new Uint8Array(32)))
  const repository = { ...createGuestRepository(), kind: 'account' as const }
  const opened = vi.spyOn(account, 'openAccountRepository').mockResolvedValue(repository)
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  expect(unlock).toHaveBeenCalledWith(selectedId)
  expect(opened).toHaveBeenCalledWith(expect.objectContaining({ accountId: selectedId }))
  expect(container.querySelector('button')!.textContent).toBe('account:clean')
  expect(selectedSyncState).toBe('signin-required')
})
it('explicit local continuation from a locked account records guest selection', async () => {
  markWorkspaceAccess('account-locked')
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Continue using this device')!
  await act(async () => button.click())
  expect(container.textContent).toBe('guest:clean')
  expect(selection.writeDeviceSelection).toHaveBeenCalledWith({ key: 'selected', version: 1, kind: 'guest' }, expect.any(Function))
})
it('explicit local continuation creates a fresh guest export lifetime without reviving the old guest', async () => {
  vi.spyOn(account, 'openAccountRepository').mockResolvedValue({ ...createGuestRepository(), kind: 'account' })
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const old = selectedRepository
  const initial = (await observe(() => old.load())).localData
  await act(async () => open(token))
  await act(async () => invalidateProfile())
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Continue using this device')!
  await act(async () => button.click())
  const fresh = selectedRepository
  expect(fresh).not.toBe(old)
  const bytes = await observe(() => fresh.exportPlannerBackup())
  const preview = await observe(() => fresh.previewImport(bytes, 'local-workspace.zip'))
  expect(preview.proposed.localData).toEqual(initial)
  const draft = createPersonalDefinition(initial, { name: 'Unsaved local continuation', kind: 'item' })
  const draftBytes = await observe(() => fresh.exportPlannerBackup(draft))
  const draftPreview = await observe(() => fresh.previewImport(draftBytes, 'local-draft.zip'))
  const exported = draftPreview.proposed.localData
  // Native recovery export appends its own inert checkpoint without saving the draft
  expect(exported).toEqual({ ...draft, updatedAt: exported.updatedAt, changes: exported.changes })
  expect(exported.changes).toEqual([...initial.changes, { id: expect.stringMatching(/^change:/), command: 'recovery-draft-export', previousRevision: initial.revision, nextRevision: initial.revision + 1, recordedAt: exported.updatedAt, changedPaths: ['$'] }])
  expect(draftPreview.proposed.history.at(-1)).toMatchObject({ command: 'recovery-draft-export', before: initial, after: exported })
  expect((await observe(() => fresh.load())).localData).toEqual(initial)
  await expect(old.exportPlannerBackup(draft)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  await act(async () => invalidateProfile())
  await expect(fresh.exportPlannerBackup(draft)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
})

it('pagehide clears access without converting remembered reopening into an explicit lock', async () => {
  vi.spyOn(account, 'openAccountRepository').mockResolvedValue({ ...createGuestRepository(), kind: 'account' })
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  await act(async () => open(token))
  expect(sessionStorage.getItem('crykit-workspace-access-v1')).toBe('account-open')
  await act(async () => { invalidateProfile('pagehide') })
  await act(async () => window.dispatchEvent(new Event('pageshow')))
  expect(container.textContent).toContain('Account workspace locked')
  expect(sessionStorage.getItem('crykit-workspace-access-v1')).toBe('account-open')
})

it('missing device selection with cached accounts presents access choices in a new tab', async () => {
  invalidateProfile()
  vi.mocked(device.listCachedProfiles).mockResolvedValue([{ accountId: token.accountId, remembered: true, passwordAvailable: true, revocationPending: false }])
  const unlock = vi.spyOn(lifecycle, 'unlockRememberedProfile')
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  expect(container.textContent).toContain('Account workspace locked')
  expect(container.textContent).not.toContain('guest:')
  expect(unlock).not.toHaveBeenCalled()
})

it('opens a successor guest repository only after rereading the actual active pointer', async () => {
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const original = selectedRepository
  const state = await observe(() => original.readWorkspace())
  await act(async () => { await original.commitWorkspace(state, state.planner.localData.revision) })
  await vi.waitFor(async () => { await act(async () => {}); expect(selectedRepository).not.toBe(original) })
  expect(container.textContent).toBe('guest:clean')
  await expect(original.save(state.planner.localData, state.planner.localData.revision)).rejects.toThrow('retired')
})
it('awaits one pointer-confirmed guest handoff before a bulk caller can resume editing', async () => {
  const stopHint = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener(GUEST_ACTIVATED_EVENT, stopHint, { once: true })
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const original = selectedRepository
  const state = await observe(() => original.readWorkspace())
  const readSelection = guest.guestRepositorySelection
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let waiting = false
  const selections = vi.spyOn(guest, 'guestRepositorySelection').mockImplementation(async repository => {
    const selected = await readSelection(repository)
    if (repository !== original) { waiting = true; await gate }
    return selected
  })
  const committed = await observe(() => original.commitWorkspace(state, state.planner.localData.revision))
  let settled = false
  const pending = reopenGuest().then(() => { settled = true })
  await vi.waitFor(() => expect(waiting).toBe(true))
  window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
  const repeated = reopenGuest()
  expect(settled).toBe(false)
  expect(selectedRepository).toBe(original)
  await act(async () => { release(); await Promise.all([pending, repeated]) })
  expect(settled).toBe(true)
  expect(selectedRepository).not.toBe(original)
  // The successor's subscription rereads its pointer without opening another repository
  expect(new Set(selections.mock.calls.filter(([repository]) => repository !== original).map(([repository]) => repository))).toEqual(new Set([selectedRepository]))
  expect((await observe(() => selectedRepository.load())).localData).toEqual(committed.localData)
  expect(committed.localData.revision).toBe(state.planner.localData.revision + 1)
  await expect(original.save(state.planner.localData, state.planner.localData.revision)).rejects.toThrow('retired')
}, 30_000)
it('late actual guest activation cannot replace an account-selected workspace or its draft', async () => {
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const original = selectedRepository, state = await observe(() => original.readWorkspace())
  vi.spyOn(account, 'openAccountRepository').mockResolvedValue({ ...createGuestRepository(), kind: 'account' })
  await act(async () => {
    const pending = original.commitWorkspace(state, state.planner.localData.revision)
    await open(token)
    await pending
  })
  await act(async () => container.querySelector('button')!.click())
  expect(container.querySelector('button')!.textContent).toBe('account:private draft')
})

it('retains a dirty captured guest form when an activation hint arrives and permits readonly draft export', async () => {
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  const original = selectedRepository, state = await observe(() => original.readWorkspace())
  await act(async () => container.querySelector('button')!.click())
  await act(async () => { await original.commitWorkspace(state, state.planner.localData.revision) })
  await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('A newer local workspace is ready') })
  expect(selectedRepository).toBe(original)
  expect(container.textContent).toContain('guest:private draft')
  await act(async () => { await expect(reopenGuest()).rejects.toThrow('Finish or recover open drafts') })
  await expect(original.save(state.planner.localData, state.planner.localData.revision)).rejects.toThrow('retired')
  const backup = await observe(() => original.exportPlannerBackup(state.planner.localData))
  expect(backup.length).toBeGreaterThan(0)
})

it('keeps every independent draft registration active when another registration is replaced', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function Owners() { selected = useWorkspace(); return <span>owners</span> }
  await act(async () => root.render(<WorkspaceProvider><Owners/></WorkspaceProvider>))
  const first = selected.registerDraftPresence(() => true)
  const second = selected.registerDraftPresence(() => false)
  const view = selected.editorSession.controller.attach()
  expect(() => selected.beginEditorCommand(view, 'import')).toThrow(/another open draft/)
  second()
  expect(() => selected.beginEditorCommand(view, 'import')).toThrow(/another open draft/)
  first()
  expect(selected.beginEditorCommand(view, 'import').command.operation).toBe('import')
})

async function observe<T>(read: () => Promise<T>): Promise<T> {
  let value!: T
  await act(async () => { value = await read() })
  return value
}

// Observe the actual selected-head transaction, independently of optional window hints
function afterNextGuestPublication(callback: () => void): void {
  const coordinatorName = `${db.name}-coordinator`
  const put = IDBObjectStore.prototype.put
  const watch = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    if (this.name === 'active' && this.transaction.db.name === coordinatorName && args[0]?.manifest?.version === 3) {
      watch.mockRestore()
      this.transaction.addEventListener('complete', callback, { once: true })
    }
    return put.apply(this, args)
  })
}

async function sameRealmIndexedDb(mockHash = true) {
  const nativeClone = globalThis.structuredClone
  const rehome = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value)) return new Uint8Array(Array.from(value as Uint8Array))
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(Array.from(new Uint8Array(value as ArrayBuffer))).buffer
    if (Array.isArray(value)) return value.map(rehome)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rehome(child)]))
    return value
  }
  // fake-indexeddb uses Node's clone, while this DOM fixture's codecs correctly require same-realm values
  vi.stubGlobal('structuredClone', (value: unknown) => rehome(nativeClone(value)))
  if (mockHash) {
    const { createHash } = await import('node:crypto')
    const blobs = await import('../workspace/blobs')
    // Retain the accepted owner-fixture's exact SHA implementation; browser coverage uses real libsodium
    vi.spyOn(blobs, 'hashBlob').mockImplementation(async source => createHash('sha256').update(await blobs.readBlob(source, source.byteLength)).digest('hex'))
  }
}

it('preserves a pointer-gap descendant through owned remount and fences old callbacks and hydration', async () => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  const { readEditorContent } = await import('../workspace/editor-document')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  let hydrated = false
  function EditorOwner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => {
      if (session.hydration) { session.controller.editText(captured, '{"during-hydration":'); void selected.confirmEditorHydration(captured).then(() => { hydrated = true }) }
      return () => { /* The provider transfers the incarnation before retiring this subtree */ }
    }, [])
    return <span>{session.controller.snapshot().input?.text ?? 'empty'}</span>
  }
  await act(async () => root.render(<WorkspaceProvider><EditorOwner/></WorkspaceProvider>))
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  const editor = () => createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) })
  await act(async () => { await editor().importFile({ filename: 'owned.json', text: '{}', referenceId: 'native' }) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  expect(hydrated).toBe(true)
  const old = selected, oldView = view
  selected.editorSession.controller.editText(view, '{"captured-V":')
  const snapshot = selected.editorSession.controller.snapshot()
  let gapApplied = false
  afterNextGuestPublication(() => { gapApplied = true; selected.editorSession.controller.editText(oldView, '{"pointer-gap":') })
  await act(async () => { await editor().saveUnfinished(snapshot.documentId!, snapshot.input!, snapshot.revision!) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  expect(gapApplied).toBe(true)
  expect(selected.editorSession.controller.snapshot().input?.text).toBe('{"during-hydration":')
  expect(selected.editorSession.controller.snapshot().dirty).toBe(true)
  expect(() => old.beginEditorCommand(oldView, 'saveUnfinished')).toThrow()
  await expect(old.confirmEditorHydration(oldView)).rejects.toThrow()
  const state = await observe(() => selected.repository.readWorkspace()), file = state.editorDocuments[0]
  expect((await readEditorContent(state, file)).unfinishedText).toBe('{"captured-V":')
})

it('reports durable V with recovery when an unrelated owner appears after publication and retries the same receipt', async () => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  let otherDirty = false
  function Owner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => otherDirty || session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => { if (session.hydration) void selected.confirmEditorHydration(captured) }, [])
    return <span>owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  const editor = () => createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) })
  await act(async () => { await editor().importFile({ filename: 'owned.json', text: '{}', referenceId: 'native' }) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  selected.editorSession.controller.editText(view, '{"durable-V":')
  const snapshot = selected.editorSession.controller.snapshot(), originalView = view
  afterNextGuestPublication(() => {
    selected.editorSession.controller.editText(view, '{"latest-V+1":')
    otherDirty = true
  })
  await act(async () => { await expect(editor().saveUnfinished(snapshot.documentId!, snapshot.input!, snapshot.revision!)).rejects.toThrow('captured draft was saved') })
  expect(selected.editorSession.phase).toBe('recovery')
  expect(selected.editorSession.controller.snapshot().input?.text).toBe('{"latest-V+1":')
  expect(() => selected.beginEditorCommand(view, 'saveUnfinished')).toThrow()
  const actual = createEditorRepository(createGuestRepository(db))
  expect((await observe(() => actual.read(snapshot.documentId!)))!.content.unfinishedText).toBe('{"durable-V":')
  otherDirty = false
  await act(async () => { await selected.retryEditorCommand(originalView) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  expect(selected.editorSession.controller.snapshot().input?.text).toBe('{"latest-V+1":')
  expect(selected.editorSession.controller.snapshot().dirty).toBe(true)
  expect(selected.fileCommandPending()).toBe(false)
  expect((await observe(() => actual.read(snapshot.documentId!)))!.file.revision).toBe(snapshot.revision! + 1)
})

it('profile selection clears file ownership and a retired completion cannot replace successor recovery state', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function Owner() { selected = useWorkspace(); return <span>owner</span> }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  const old = selected, oldView = old.editorSession.controller.attach()
  old.editorSession.transferView = oldView
  const ticket = old.beginEditorCommand(oldView, 'import')
  vi.spyOn(account, 'openAccountRepository').mockResolvedValue({ ...createGuestRepository(), kind: 'account' })
  await act(async () => selected.openAccount(token))
  expect(selected.fileCommandPending()).toBe(false)
  expect(selected.editorSession.transferView).toBeUndefined()
  expect(selected.editorSession.phase).toBe('idle')
  const successorView = selected.editorSession.controller.attach()
  selected.beginEditorCommand(successorView, 'import')
  await expect(old.completeEditorCommand({ status: 'not-saved', error: new Error('old failure') }, ticket)).rejects.toThrow(/retired/)
  expect(selected.fileCommandPending()).toBe(true)
  expect(selected.editorSession.phase).toBe('staging')
  expect(selected.editorSession.recovery).toBeUndefined()
})

it('holds the exact saved receipt after hydration is blocked and releases it only after a verified retry', async () => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  let blocked = false
  function Owner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    useLayoutEffect(() => selected.registerDraftPresence(() => blocked), [selected.registerDraftPresence])
    return <span>owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  await act(async () => {
    await createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) }).importFile({ filename: 'hydration.json', text: '{}', referenceId: 'native' })
  })
  const receipt = selected.editorSession.recovery!.outcome.receipt
  blocked = true
  await expect(selected.confirmEditorHydration(view)).rejects.toThrow('explicit reopening')
  expect(selected.editorSession.phase).toBe('recovery')
  expect(selected.editorSession.recovery!.outcome.receipt).toBe(receipt)
  expect(selected.fileCommandPending()).toBe(true)
  expect(() => selected.beginEditorCommand(view, 'saveUnfinished')).toThrow()
  blocked = false
  await act(async () => selected.retryEditorCommand(view))
  expect(selected.fileCommandPending()).toBe(false)
  expect(selected.editorSession.recovery).toBeUndefined()
  expect(selected.editorSession.phase).toBe('idle')
})

it('shares repeated editor readiness for one exact transferred view and receipt', async () => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  function Owner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    return <span>owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  const retired = selected, retiredView = view
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  await act(async () => {
    await createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) }).importFile({ filename: 'map.json', text: '{}', referenceId: 'native' })
  })
  const original = selected.editorSession.hydration!, completion = original.completion
  let release!: () => void, checks = 0
  const held = new Promise<void>(resolve => { release = resolve })
  selected.editorSession.hydration = { ...original, completion: { ...completion, assertCurrent: async () => { checks++; await held; await completion.assertCurrent() } } }
  const first = selected.confirmEditorHydration(view), second = selected.confirmEditorHydration(view)
  const outcomes = Promise.allSettled([first, second])
  release()
  await act(async () => { expect((await outcomes).map(value => value.status)).toEqual(['fulfilled', 'fulfilled']) })
  expect(checks).toBe(1)
  expect(selected.fileCommandPending()).toBe(false)
  expect(selected.editorSession.phase).toBe('idle')
  expect(selected.editorSession.hydration).toBeUndefined()
  expect(selected.editorSession.document?.file.filename).toBe('map.json')
  await expect(retired.confirmEditorHydration(retiredView)).rejects.toThrow()
})

it.each(['composition', 'gesture'] as const)('keeps the live %s owner after publication until its final input can transfer', async interaction => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  function Owner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => { if (session.hydration) void selected.confirmEditorHydration(captured) }, [])
    return <span>owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  const editor = () => createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) })
  await act(async () => { await editor().importFile({ filename: 'interaction.json', text: '{}', referenceId: 'native' }) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  const controller = selected.editorSession.controller, oldView = view
  controller.editText(view, '{"captured":')
  const snapshot = controller.snapshot()
  let published!: () => void
  const publication = new Promise<void>(resolve => { published = resolve })
  afterNextGuestPublication(() => { controller.setInteraction(oldView, interaction, true); controller.editText(oldView, '{"live":'); published() })
  let pending!: ReturnType<ReturnType<typeof editor>['saveUnfinished']>
  await act(async () => { pending = editor().saveUnfinished(snapshot.documentId!, snapshot.input!, snapshot.revision!); await publication })
  expect(() => controller.assertView(oldView)).not.toThrow()
  expect(selected.fileCommandPending()).toBe(true)
  const durable = await createEditorRepository(createGuestRepository(db)).read(snapshot.documentId!)
  expect(durable!.content.unfinishedText).toBe('{"captured":')
  controller.editText(oldView, '{"released":')
  await act(async () => { controller.setInteraction(oldView, interaction, false); await pending })
  expect(controller.snapshot()).toMatchObject({ dirty: true, input: { text: '{"released":' } })
  expect(() => controller.assertView(oldView)).toThrow('retired')
})
it('Save marker capture cannot acknowledge unsaved pending input as durable', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function SaveOwner() { selected = useWorkspace(); return <span>Save owner</span> }
  await act(async () => root.render(<WorkspaceProvider><SaveOwner/></WorkspaceProvider>))
  const controller = selected.saveSession.controller, view = controller.attach()
  controller.open(view, 'save', 1, { original: 'original', working: 'working', requirements: '[]', coverage: 'supported', marker: 'null', context: 'native' }, new Uint8Array([1]), { version: 1, fields: {}, member: 0, presentation: {} })
  controller.editField(view, 'currency', 'not a number')
  expect(() => selected.beginSaveCommand(view, 'saveExport')).toThrow(/unfinished|pending|saved/i)
  expect(selected.fileCommandPending()).toBe(false)
  expect(controller.snapshot().input?.fields.currency).toBe('not a number')
  expect(controller.snapshot().dirty).toBe(true)
})

it.each([1, 2])('owned Build import remounts exact dirty input with %s hydration confirmations and leaves unrelated owners as blockers', async confirmations => {
  await sameRealmIndexedDb()
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/build-input-controller').BuildInputView
  let hydrationResults: PromiseSettledResult<void>[] | undefined
  function BuildOwner() {
    selected = useWorkspace()
    const session = selected.buildInputSession
    view = session.view ?? session.controller.attach(); session.view = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => { if (session.hydration) void Promise.allSettled(Array.from({ length: confirmations }, () => selected.confirmBuildHydration(captured))).then(results => { hydrationResults = results }) }, [])
    return <span>{session.controller.read(view, 'title', () => 'clean')}</span>
  }
  await act(async () => root.render(<WorkspaceProvider><BuildOwner/></WorkspaceProvider>))
  const old = selected, oldView = view
  selected.buildInputSession.controller.edit(view, 'title', 'Exact unsaved title')
  selected.buildInputSession.controller.dirty(view, true)
  const before = await observe(() => selected.repository.load())
  const preview = await previewCrystalEdit(new TextEncoder().encode('{"ID":"provider-picker","Title":"Provider picker","EditorVersion":34,"Items":[]}'), 'picker.json')
  const blocker = selected.registerDraftPresence(() => true)
  await expect(selected.importBuildSource(preview, { id: before.localData.id, revision: before.revision })).rejects.toThrow('another open draft')
  blocker()
  await act(async () => { await selected.importBuildSource(preview, { id: before.localData.id, revision: before.revision }) })
  await act(async () => { await vi.waitFor(() => expect(hydrationResults).toBeDefined()) })
  expect(hydrationResults).toEqual(Array.from({ length: confirmations }, () => ({ status: 'fulfilled', value: undefined })))
  expect(selected.repository).not.toBe(old.repository)
  expect(container.textContent).toContain('Exact unsaved title')
  expect(selected.buildInputSession.controller.snapshot().dirty).toBe(true)
  expect(() => selected.buildInputSession.controller.edit(oldView, 'title', 'stale')).toThrow('retired')
  await expect(old.repository.load()).rejects.toThrow('retired')
  expect(selected.fileCommandPending()).toBe(false)
})

it.each(['other-owner', 'edited-input'] as const)('owned Build import keeps recovery after post-publication %s', async cause => {
  await sameRealmIndexedDb()
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/build-input-controller').BuildInputView
  let otherDirty = false
  function BuildOwner() {
    selected = useWorkspace()
    const session = selected.buildInputSession
    view = session.view ?? session.controller.attach(); session.view = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => otherDirty || session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => { if (session.hydration) void selected.confirmBuildHydration(captured) }, [])
    return <span>Build owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><BuildOwner/></WorkspaceProvider>))
  const original = selected.repository
  selected.buildInputSession.controller.edit(view, 'title', 'Captured title')
  selected.buildInputSession.controller.dirty(view, true)
  const before = await observe(() => original.load())
  const preview = await previewCrystalEdit(new TextEncoder().encode('{"ID":"late-picker","Title":"Late picker","EditorVersion":34,"Items":[]}'), 'late.json')
  afterNextGuestPublication(() => {
    if (cause === 'other-owner') otherDirty = true
    else selected.buildInputSession.controller.edit(view, 'title', 'Later input')
  })
  await act(async () => { await expect(selected.importBuildSource(preview, { id: before.localData.id, revision: before.revision })).rejects.toThrow('mod was saved') })
  expect(selected.repository).toBe(original)
  expect(selected.buildInputSession.phase).toBe('recovery')
  expect(selected.buildInputSession.controller.recoveryInput(view).title).toBe(cause === 'other-owner' ? 'Captured title' : 'Later input')
  expect(selected.fileCommandPending()).toBe(true)
  const durable = await createGuestRepository(db).readWorkspace()
  expect(durable.planner.sources.some(source => source.filename === 'late.json')).toBe(true)
  expect(durable.planner.localData.buildRevisions).toEqual(before.localData.buildRevisions)
  if (cause === 'other-owner') {
    otherDirty = false
    await act(async () => { await selected.retryBuildImport() })
    expect(selected.repository).not.toBe(original)
    expect(selected.buildInputSession.controller.snapshot().dirty).toBe(true)
    expect(selected.fileCommandPending()).toBe(false)
  } else {
    await act(async () => { await expect(selected.retryBuildImport()).rejects.toThrow('mod was saved') })
    expect(selected.repository).toBe(original)
    expect(selected.buildInputSession.controller.recoveryInput(view).title).toBe('Later input')
  }
}, 30_000)

it('explicit account reopening preserves the route and fences drafts, old callbacks and delayed profile results', async () => {
  const original = { ...createGuestRepository(), kind: 'account' as const }, successor = { ...createGuestRepository(), kind: 'account' as const }
  const opened = vi.spyOn(account, 'openAccountRepository').mockResolvedValue(original)
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  await act(async () => open(token))
  const staleReopen = reopenAccount
  window.location.hash = '#/inventory'
  opened.mockResolvedValue(successor)
  await act(async () => reopenAccount())
  expect(selectedRepository).toBe(successor)
  expect(window.location.hash).toBe('#/inventory')
  await expect(staleReopen()).rejects.toThrow(/captured account/)
  await act(async () => container.querySelector('button')!.click())
  await expect(reopenAccount()).rejects.toThrow(/drafts/)
  expect(selectedRepository).toBe(successor)
})

it('a profile change during explicit account reopening cannot install its delayed repository', async () => {
  const original = { ...createGuestRepository(), kind: 'account' as const }
  const opened = vi.spyOn(account, 'openAccountRepository').mockResolvedValue(original)
  await act(async () => root.render(<WorkspaceProvider><Probe/></WorkspaceProvider>))
  await act(async () => open(token))
  let finish!: (value: typeof original) => void
  opened.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let pending!: Promise<void>
  await act(async () => { pending = reopenAccount(); await Promise.resolve() })
  await act(async () => invalidateProfile())
  finish(original)
  await expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(container.textContent).toContain('Account workspace locked')
})

it('keeps the exact Editor file and completion result through its owned library import', async () => {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  function EditorOwner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    useLayoutEffect(() => { if (session.hydration) void selected.confirmEditorHydration(view) }, [])
    return <span>{session.controller.snapshot().input?.text ?? 'empty'}</span>
  }
  await act(async () => root.render(<WorkspaceProvider><EditorOwner/></WorkspaceProvider>))
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  const text = '{"ID":"owned-editor-library","Title":"Owned library","EditorVersion":34,"Equipment":[]}'
  const editor = createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) })
  await act(async () => { await editor.importFile({ filename: 'owned.json', text, bytes: new TextEncoder().encode(text), referenceId: 'native' }) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  const original = selected.editorSession.document!, old = selected, oldView = view
  const loaded = await observe(() => selected.repository.load())
  const preview = await previewCrystalEdit(new TextEncoder().encode(text), 'owned.json')
  const result = { title: 'Owned library', unchanged: false, warnings: [] }
  await act(async () => { await selected.importEditorSource(preview, { id: loaded.localData.id, revision: loaded.revision }, selected.editorSession.controller.owner, result) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  expect(selected).not.toBe(old)
  expect(selected.editorSession.document).toEqual(original)
  expect(selected.editorSession.controller.snapshot()).toMatchObject({ documentId: original.file.id, revision: original.file.revision, dirty: false, input: { text } })
  expect(selected.editorSession.libraryResult).toEqual({ documentId: original.file.id, revision: original.file.revision, result })
  const state = await observe(() => selected.repository.readWorkspace())
  expect(state.editorDocuments).toEqual([original.file])
  expect(state.planner.sources[0]?.original.sha256).toBe(preview.sourceDigest)
  expect(await selected.repository.readModSource({ catalogId: preview.proposed.catalogs[0].id, catalogRevisionId: preview.proposed.catalogs[0].revisionId })).toEqual({ filename: 'owned.json', text })
  await expect(old.importEditorSource(preview, { id: loaded.localData.id, revision: loaded.revision }, old.editorSession.controller.owner, result)).rejects.toThrow()
  expect(() => old.beginEditorCommand(oldView, 'libraryImport')).toThrow()
  const before = await selected.repository.readWorkspace(), sameOwner = selected
  await act(async () => { await selected.importEditorSource(preview, { id: before.planner.localData.id, revision: before.planner.localData.revision }, selected.editorSession.controller.owner, { ...result, unchanged: true }) })
  expect(selected).toBe(sameOwner)
  expect(selected.fileCommandPending()).toBe(false)
  expect(await selected.repository.readWorkspace()).toEqual(before)
  selected.editorSession.controller.editText(view, '{"changed":')
  await expect(selected.importEditorSource(preview, { id: before.planner.localData.id, revision: before.planner.localData.revision }, selected.editorSession.controller.owner, result)).rejects.toThrow(/applied|input/)
  expect(await selected.repository.readWorkspace()).toEqual(before)
})

it('carries only the requested Reference retry through explicit guest update reopening', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function Owner() { selected = useWorkspace(); return <span>Ready</span> }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  const old = selected, retry = { cardId: 'synthetic-reference', included: false, message: 'Synthetic saved failure' }
  selected.rememberReferenceRetry(retry)
  const other = createGuestRepository(db), before = await observe(() => other.load())
  await act(async () => { await other.save(before.localData, before.revision) })
  expect(selected.repository).toBe(old.repository)
  await act(async () => { await selected.reopenGuest(true) })
  expect(selected.repository).not.toBe(old.repository)
  expect(selected.readReferenceRetry()).toEqual(retry)
  expect(() => old.rememberReferenceRetry(retry)).toThrow()
  await act(async () => { await selected.continueLocal() })
  expect(selected.readReferenceRetry()).toBeUndefined()
})

it('carries completed mod import feedback through its explicit guest successor and clears it on workspace selection', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function Owner() { selected = useWorkspace(); return <span>Ready</span> }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  const old = selected
  const other = createGuestRepository(db), before = await observe(() => other.load())
  await act(async () => { await other.save(before.localData, before.revision) })
  const result = { saved: { title: 'Synthetic saved mod', unchanged: false, warnings: ['Synthetic import note'] }, futureDefault: false }
  await act(async () => { await selected.reopenGuest(false, result) })
  expect(selected.repository).not.toBe(old.repository)
  expect(selected.readModLibraryResult()).toEqual(result)
  result.saved.warnings.push('Unowned later mutation')
  expect(selected.readModLibraryResult()?.saved.warnings).toEqual(['Synthetic import note'])
  expect(() => old.readModLibraryResult()).toThrow()
  await expect(old.reopenGuest(false, result)).rejects.toThrow()
  await act(async () => { await selected.continueLocal() })
  expect(selected.readModLibraryResult()).toBeUndefined()
})

it('carries shared import feedback only for its exact snapshot through guest reopening', async () => {
  let selected!: ReturnType<typeof useWorkspace>
  function Owner() { selected = useWorkspace(); return <span>Ready</span> }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  const old = selected
  // The real import UI is available only after initial admission, before another writer publishes its successor
  await observe(() => old.repository.load())
  const other = createGuestRepository(db), before = await observe(() => other.load())
  await act(async () => { await other.save(before.localData, before.revision) })
  const result = { sharedSnapshot: 'synthetic-exact-share', source: { catalogId: 'synthetic-mod' as import('../domain/types').CatalogId, catalogRevisionId: 'synthetic-revision' as import('../domain/types').CatalogRevisionId, title: 'Synthetic imported mod' } }
  await act(async () => { await selected.reopenGuest(false, result) })
  expect(selected.repository).not.toBe(old.repository)
  expect(selected.readSharedModResult(result.sharedSnapshot)).toEqual(result.source)
  expect(selected.readSharedModResult('another-snapshot')).toBeUndefined()
  expect(selected.readModLibraryResult()).toBeUndefined()
  result.source.title = 'Unowned later mutation'
  expect(selected.readSharedModResult(result.sharedSnapshot)?.title).toBe('Synthetic imported mod')
  expect(() => old.readSharedModResult(result.sharedSnapshot)).toThrow()
  await act(async () => { await selected.continueLocal() })
  expect(selected.readSharedModResult(result.sharedSnapshot)).toBeUndefined()
})


async function openedEditorOwner(kind: 'guest' | 'account' = 'guest') {
  await sameRealmIndexedDb()
  const { createEditorRepository } = await import('../workspace/editor-repository')
  let selected!: ReturnType<typeof useWorkspace>, view!: import('../workspace/editor-input-controller').EditorViewIncarnation
  let otherDirty = false
  function Owner() {
    selected = useWorkspace()
    const session = selected.editorSession
    view = session.transferView ?? session.controller.attach(); session.transferView = view
    const captured = view
    useLayoutEffect(() => selected.registerDraftPresence(owner => otherDirty || session.controller.snapshot().dirty && owner !== session.controller.owner), [selected.registerDraftPresence])
    useLayoutEffect(() => { if (session.hydration) void selected.confirmEditorHydration(captured) }, [])
    return <span>Editor owner</span>
  }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  if (kind === 'account') await act(async () => { await selected.openAccount(token) })
  let ticket!: import('../workspace/editor-input-controller').EditorInputTicket
  const editor = () => createEditorRepository(selected.repository, { begin: operation => { ticket = selected.beginEditorCommand(view, operation); return ticket.command }, onOutcome: (outcome, file) => selected.completeEditorCommand(outcome, ticket, file) })
  await act(async () => { await editor().importFile({ filename: 'reopen.json', text: '{}', bytes: new TextEncoder().encode('{}'), referenceId: 'native' }) })
  await act(async () => { await vi.waitFor(() => expect(selected.fileCommandPending()).toBe(false)) })
  return { selected: () => selected, view: () => view, editor, otherDirty: (value: boolean) => { otherDirty = value } }
}

it.each(['guest', 'account'] as const)('explicit %s Editor reopening admits the winner before discarding this owner and enables further saves', async kind => {
  const f = await openedEditorOwner(kind), old = f.selected(), oldView = f.view(), id = old.editorSession.document!.file.id
  old.editorSession.controller.editText(oldView, '{"losing":true}')
  const { createEditorRepository } = await import('../workspace/editor-repository')
  const current = async () => kind === 'account' ? account.openAccountRepository(token) : createGuestRepository(db)
  const winner = createEditorRepository(await current())
  const row = await winner.saveUnfinished(id, { text: '{"winner":true}', editedPath: [], fieldState: null, validation: 'valid' }, old.editorSession.document!.file.revision)
  await createEditorRepository(await current()).applyDraft(id, row.revision)
  f.otherDirty(true)
  await expect(old.reopenEditorSavedVersion(oldView, id)).rejects.toThrow()
  expect(old.editorSession.controller.snapshot().input?.text).toBe('{"losing":true}')
  f.otherDirty(false)
  await act(async () => { await old.reopenEditorSavedVersion(oldView, id) })
  expect(f.selected()).not.toBe(old)
  expect(f.selected().editorSession.document!.content).toMatchObject({ originalText: '{}', lastAppliedText: '{"winner":true}', unfinishedText: '{"winner":true}' })
  expect(f.selected().editorSession.controller.snapshot()).toMatchObject({ documentId: id, dirty: false, input: { text: '{"winner":true}' } })
  await expect(old.reopenEditorSavedVersion(oldView, id)).rejects.toThrow()
  expect(() => old.beginEditorCommand(oldView, 'saveUnfinished')).toThrow()
  f.selected().editorSession.controller.editText(f.view(), '{"after-reopen":true}')
  const input = f.selected().editorSession.controller.snapshot()
  await act(async () => { await f.editor().saveUnfinished(id, input.input!, input.revision!) })
  await act(async () => { await vi.waitFor(() => expect(f.selected().fileCommandPending()).toBe(false)) })
  expect(f.selected().editorSession.document!.content).toMatchObject({ originalText: '{}', lastAppliedText: '{"winner":true}', unfinishedText: '{"after-reopen":true}' })
})

it.each(['input', 'profile', 'workspace'] as const)('held Editor reopening cannot replace newer %s authority', async change => {
  const f = await openedEditorOwner(), old = f.selected(), view = f.view(), id = old.editorSession.document!.file.id
  old.editorSession.controller.editText(view, '{"losing":true}')
  const independent = createGuestRepository(db)
  const fresh = createGuestRepository(db), read = fresh.readWorkspace.bind(fresh)
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(fresh, 'readWorkspace').mockImplementation(async () => { const state = await read(); entered = true; await gate; return state })
  vi.spyOn(guest, 'createGuestRepository').mockReturnValue(fresh)
  const pending = old.reopenEditorSavedVersion(view, id)
  void pending.catch(() => {})
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    if (change === 'input') old.editorSession.controller.editText(view, '{"newer-input":')
    else if (change === 'profile') await act(async () => invalidateProfile())
    else {
      const { createEditorRepository } = await import('../workspace/editor-repository')
      await createEditorRepository(independent).saveUnfinished(id, { text: '{"newer-winner":true}', editedPath: [], fieldState: null, validation: 'valid' }, old.editorSession.document!.file.revision)
    }
  } finally { release() }
  await act(async () => { await expect(pending).rejects.toThrow() })
  if (change !== 'profile') {
    expect(f.selected()).toBe(old)
    expect(old.editorSession.controller.snapshot()).toMatchObject({ dirty: true, input: { text: change === 'input' ? '{"newer-input":' : '{"losing":true}' } })
  } else expect(old.editorSession.controller.snapshot().input).toBeUndefined()
})
