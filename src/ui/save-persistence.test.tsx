// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { act, StrictMode, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { CryKitDatabase, setDatabaseForTests } from '../persistence/database'
import { createGuestRepository } from '../workspace/guest-repository'
import { createSaveRepository, readSaveContent } from '../workspace/save-repository'
import { resolveOwnedFileReceipt } from '../workspace/owned-file-command'
import * as ownedFiles from '../workspace/owned-file-command'
import * as blobs from '../workspace/blobs'
import { DefinitionProvider } from './definitions'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import type { LocalData } from '../domain/types'
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider'
import { SaveEditorWorkspaceView } from './SaveEditorView'
import { createSaveEditorFixture } from '../domain/save-editor.fixture'
import { encodeCrystalSave } from '../interchange/crystal-save'
import type { DraftActions } from './drafts'
const { FixtureTextEncoder } = vi.hoisted(() => {
  // Keep encoded bytes in the schema's original realm rather than replacing its constructor after import
  class FixtureTextEncoder extends TextEncoder {
    override encode(value?: string): Uint8Array<ArrayBuffer> { return new Uint8Array(super.encode(value)) }
  }
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  return { FixtureTextEncoder }
})
vi.mock('../workspace/device-selection', () => ({ readDeviceSelection: async () => ({ key: 'selected', version: 1, kind: 'guest' }), writeDeviceSelection: async () => {} }))
let db: CryKitDatabase, root: ReturnType<typeof createRoot>, container: HTMLDivElement, savedId: string
let childEnabled = false, strictEnabled = false, strictChildOnly = false, localData: LocalData
let workspace: ReturnType<typeof useWorkspace>, actions: DraftActions | undefined
// Two complete guest transactions retain their original assertions and one continuous deadline
const SAVE_SUCCESSOR_TRANSACTIONS_MS = 15_000
const SAVE_STRICT_RECOVERY_COPY_MS = 10_000
const bytes = encodeCrystalSave(createSaveEditorFixture())
function Owner({ shown = true }: { readonly shown?: boolean }) {
  workspace = useWorkspace()
  const dirty = useRef(false)
  useLayoutEffect(() => workspace.registerDraftPresence(owner => dirty.current && owner !== workspace.saveSession.controller.owner), [workspace.registerDraftPresence])
  const editor = <SaveEditorWorkspaceView onDraftChange={(value, next) => { dirty.current = value; if (next) actions = next }}/>
  if (!shown) return <p>Other tool</p>
  const content = childEnabled ? <DefinitionProvider localData={localData} catalogs={[DEFAULT_CATALOG]} onSaveDefinition={async () => { throw new Error('Definition writes are outside this fixture') }}>{editor}</DefinitionProvider> : editor
  return strictChildOnly ? <StrictMode>{content}</StrictMode> : content
}
beforeEach(async () => {
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  childEnabled = false; strictEnabled = false; strictChildOnly = false
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const nativeClone = structuredClone
  const rehome = (value: unknown): unknown => ArrayBuffer.isView(value) ? new Uint8Array(Array.from(value as Uint8Array)) : Object.prototype.toString.call(value) === '[object ArrayBuffer]' ? new Uint8Array(Array.from(new Uint8Array(value as ArrayBuffer))).buffer : Array.isArray(value) ? value.map(rehome) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rehome(child)])) : value
  vi.stubGlobal('structuredClone', (value: unknown) => rehome(nativeClone(value)))
  vi.spyOn(blobs, 'hashBlob').mockImplementation(async source => createHash('sha256').update(await blobs.readBlob(source, source.byteLength)).digest('hex'))
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  sessionStorage.clear(); db = new CryKitDatabase(`save-ui-${crypto.randomUUID()}`); setDatabaseForTests(db)
  let outcome: import('../workspace/owned-file-command').OwnedFileOutcome | undefined
  const row = await createSaveRepository(createGuestRepository(db), { onOutcome: value => { outcome = value } }).importFile('saved.sav', bytes)
  savedId = row.id
  localData = (await (await resolveOwnedFileReceipt(outcome!.receipt!)).repository.load()).localData
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setDatabaseForTests(undefined); db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'showPopover'); Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover') })
async function wait(assertion: () => void) { await vi.waitFor(async () => { await act(async () => {}); assertion() }) }
async function open() {
  await act(async () => root.render(strictEnabled ? <StrictMode><WorkspaceProvider><Owner/></WorkspaceProvider></StrictMode> : <WorkspaceProvider><Owner/></WorkspaceProvider>))
  await wait(() => expect(container.querySelector(`option[value="${savedId}"]`)).not.toBeNull())
  await act(async () => { const select = container.querySelector('select')!; select.value = savedId; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(() => expect(container.querySelector('[aria-label="Copper"]')).not.toBeNull())
}
// Observe the actual durable pointer boundary rather than an optional bulk-activation hint
function afterNextGuestPublication(callback: () => void): void {
  const put = IDBObjectStore.prototype.put
  const watch = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    if (this.name === 'active' && this.transaction.db.name === `${db.name}-coordinator` && args[0]?.manifest?.version === 3) {
      watch.mockRestore()
      this.transaction.addEventListener('complete', callback, { once: true })
    }
    return put.apply(this, args)
  })
}
async function type(value: string) { await act(async () => { const input = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!; input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
it('real provider preserves invalid input and exact bytes during navigation save without a download', async () => {
  await open(); await type('not a number')
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const old = workspace
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace).not.toBe(old)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('not a number')
  const state = await workspace.repository.readWorkspace(), row = state.saveDocuments.find(value => value.id === savedId)!
  expect(row.pendingForm).toMatchObject({ version: 1, fields: { currency: 'not a number' } })
  expect(await readSaveContent(state, row)).toEqual({ originalBytes: bytes, workingBytes: bytes })
  expect(row.exportedRevision).toBeNull()
  expect(click).not.toHaveBeenCalled()
})
it('actual dirty Save view refuses marker initiation without discarding its form', async () => {
  await open(); await type('not a number')
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Export edited save')!
  expect(button.disabled).toBe(true)
  expect(() => workspace.beginSaveCommand(workspace.saveSession.transferView!, 'saveExport')).toThrow(/unfinished/)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('not a number')
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(true)
})
it('pending-only V is durable while pointer-gap V+1 survives and saves on the verified successor', { timeout: SAVE_SUCCESSOR_TRANSACTIONS_MS }, async () => {
  await open(); await type('captured V')
  const old = workspace, view = old.saveSession.transferView!
  const gap = () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'later V+1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.setSelectionRange(2, 5)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  }
  afterNextGuestPublication(gap)
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(true)
  const field = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
  expect(field.value).toBe('later V+1')
  expect(document.activeElement).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 5])
  expect(() => old.beginSaveCommand(view, 'savePending')).toThrow()
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'captured V' } })
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect((await workspace.repository.readWorkspace()).saveDocuments[0].pendingForm).toMatchObject({ fields: { currency: 'later V+1' } })
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
})
it('automatically saves later input after the pending command hydrates its successor', { timeout: SAVE_SUCCESSOR_TRANSACTIONS_MS }, async () => {
  await open(); await type('captured V')
  afterNextGuestPublication(() => {
    const field = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'later V+1')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'captured V' } })
  // The remounted owner must resume quiet saving without another edit or explicit save action
  await wait(() => expect(workspace.saveSession.controller.snapshot().dirty).toBe(false))
  const state = await workspace.repository.readWorkspace(), file = state.saveDocuments.find(value => value.id === savedId)!
  expect(file.pendingForm).toMatchObject({ fields: { currency: 'later V+1' } })
  expect(await readSaveContent(state, file)).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
it('flushes an inventory filter selection without waiting for the typing debounce', async () => {
  await open()
  const begin = vi.spyOn(workspace, 'beginSaveCommand')
  afterNextGuestPublication(() => {
    const stock = container.querySelectorAll<HTMLSelectElement>('.save-editor__inventory-tools select')[1]
    stock.value = 'carried'; stock.dispatchEvent(new Event('change', { bubbles: true }))
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await act(async () => {
      const category = container.querySelector<HTMLSelectElement>('.save-editor__inventory-tools select')!
      category.value = 'item'; category.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(begin).toHaveBeenCalledWith(expect.anything(), 'savePending')
  } finally { vi.useRealTimers() }
  await wait(() => {
    expect(workspace.fileCommandPending()).toBe(false)
    expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
  })
  const state = await workspace.repository.readWorkspace(), file = state.saveDocuments.find(value => value.id === savedId)!
  expect(file.pendingForm).toMatchObject({ presentation: { inventoryKind: 'item', stockFilter: 'carried' } })
  expect(await readSaveContent(state, file)).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
it.each(['composition', 'pointer'] as const)('actual Save %s input remains live through publication and transfers its final value', async interaction => {
  await open(); await type('captured V')
  const old = workspace, oldView = old.saveSession.transferView!
  let published!: () => void
  const publication = new Promise<void>(resolve => { published = resolve })
  afterNextGuestPublication(() => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
    input.dispatchEvent(new Event(interaction === 'composition' ? 'compositionstart' : 'pointerdown', { bubbles: true }))
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'live V+1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    published()
  })
  let pending!: Promise<boolean>
  await act(async () => { pending = actions!.save(); await publication })
  expect(workspace.fileCommandPending()).toBe(true)
  expect(() => old.saveSession.controller.assertView(oldView)).not.toThrow()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.disabled).toBe(false)
  await type('released V+1')
  await act(async () => {
    const target = interaction === 'composition' ? container.querySelector('[aria-label="Copper"]')! : window
    target.dispatchEvent(new Event(interaction === 'composition' ? 'compositionend' : 'pointerup', { bubbles: true }))
    await pending
  })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'captured V' } })
  expect(workspace.saveSession.controller.snapshot()).toMatchObject({ dirty: true, input: { fields: { currency: 'released V+1' } } })
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('released V+1')
  expect(() => old.saveSession.controller.assertView(oldView)).toThrow(/retired/)
})

it('actual child picker and member selection survive the owned Save remount with exact unchanged bytes', async () => {
  childEnabled = true
  const popovers = new WeakSet<HTMLElement>()
  Object.defineProperties(HTMLElement.prototype, { showPopover: { configurable: true, value: function (this: HTMLElement) { popovers.add(this) } }, hidePopover: { configurable: true, value: function (this: HTMLElement) { popovers.delete(this) } } })
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? popovers.has(this) : matches.call(this, selector) })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(performance.now()); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  await open()
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click())
  const mainHand = () => [...container.querySelectorAll<HTMLInputElement>('input')].find(input => input.labels?.[0]?.textContent === 'Main hand')!
  await act(async () => mainHand().focus())
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(mainHand(), 'unresolved sword query'); mainHand().dispatchEvent(new Event('input', { bubbles: true })) })
  expect(workspace.saveSession.controller.snapshot().input?.presentation.picker).toMatchObject({ query: 'unresolved sword query' })
  const old = workspace, oldView = old.saveSession.transferView!
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(container.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected')).toBe('true')
  expect(mainHand().value).toBe('unresolved sword query')
  expect(mainHand().getAttribute('aria-expanded')).toBe('true')
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ member: 1, presentation: { picker: { fieldKey: 'equipment:plan-main-hand', query: 'unresolved sword query' } } })
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
  expect(workspace.saveSession.document!.file.exportedRevision).toBeNull()
  expect(() => old.saveSession.controller.assertView(oldView)).toThrow(/retired/)
})

it('actual download recovery reuses its exact saved marker receipt without another browser request', async () => {
  await open()
  const createUrl = vi.fn(() => 'blob:synthetic-save-download')
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  let reached!: () => void
  const failedResolution = new Promise<void>(resolve => { reached = resolve })
  const resolver = vi.spyOn(ownedFiles, 'resolveOwnedFileReceipt').mockImplementationOnce(async () => { reached(); throw new Error('Synthetic receipt read unavailable') })
  await act(async () => {
    ;[...container.querySelectorAll('button')].find(value => value.textContent === 'Export edited save')!.click()
    await failedResolution
  })
  expect(workspace.saveSession.phase).toBe('recovery')
  const receipt = workspace.saveSession.recovery!.outcome.receipt
  expect(receipt).toBeDefined()
  expect(click).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Retry operation')
  await act(async () => workspace.retrySaveCommand(workspace.saveSession.transferView!))
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(resolver.mock.calls[1][0]).toBe(receipt)
  expect(workspace.saveSession.document!.exportStatus).toBe('requested')
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
  expect(click).toHaveBeenCalledTimes(1)
  expect(createUrl).toHaveBeenCalledTimes(1)
})

describe('unknown pending-form recovery', () => {
  const unknown = { version: 999, futureLoadout: { invisibleChoice: ['exact', 8] } }
  beforeEach(async () => {
    let outcome: ownedFiles.OwnedFileOutcome | undefined
    const repository = createGuestRepository(db), state = await repository.readWorkspace(), row = state.saveDocuments.find(value => value.id === savedId)!
    await createSaveRepository(repository, { onOutcome: value => { outcome = value } }).saveWorking(savedId, bytes, unknown, row.revision)
    await resolveOwnedFileReceipt(outcome!.receipt!)
  })
  it('blocks child changes and ordinary Save from replacing an unsupported form', async () => {
    childEnabled = true
    await open()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs.every(value => value.disabled)).toBe(true)
    await act(async () => { expect(await actions!.save()).toBe(false) })
    expect(workspace.saveSession.document!.file.pendingForm).toEqual(unknown)
    expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
    expect((await workspace.repository.readWorkspace()).saveDocuments.find(value => value.id === savedId)!.pendingForm).toEqual(unknown)
  })
  it('keeps the unsupported payload inert until deliberate reset preserves both byte streams', async () => {
    await open()
    expect(container.textContent).toContain('Unfinished input unavailable')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.disabled).toBe(true)
    expect(workspace.saveSession.document!.file.pendingForm).toEqual(unknown)
    expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
    vi.stubGlobal('confirm', vi.fn(() => false))
    await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === 'Reset unfinished input')!.click())
    expect(workspace.saveSession.document!.file.pendingForm).toEqual(unknown)
    vi.mocked(window.confirm).mockReturnValue(true)
    const complete = workspace.completeSaveCommand
    let completed!: () => void
    const completion = new Promise<void>(resolve => { completed = resolve })
    vi.spyOn(workspace, 'completeSaveCommand').mockImplementation(async (...args) => { try { await complete(...args) } finally { completed() } })
    await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Reset unfinished input')!.click(); await completion })
    await wait(() => expect(workspace.fileCommandPending()).toBe(false))
    expect(container.textContent).not.toContain('Unfinished input unavailable')
    expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ version: 1, fields: {} })
    expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
    expect(workspace.saveSession.document!.file.exportedRevision).toBeNull()
  })
})
it('actual immutable Build and review intent reopen inertly without changing working bytes', async () => {
  childEnabled = true
  await open()
  const choices = container.querySelector<HTMLSelectElement>('.save-party__build-import select')!
  const revisionId = [...choices.options].find(option => option.value)?.value
  expect(revisionId).toBeDefined()
  await act(async () => { choices.value = revisionId!; choices.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === 'Review Build')!.click())
  const recorded = workspace.saveSession.controller.snapshot().input!
  expect(recorded.selectedBuild!.revision).toEqual(localData.buildRevisions[revisionId!])
  expect(recorded.review!.command.type).toBe('loadout')
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ selectedBuild: recorded.selectedBuild, review: recorded.review })
  await act(async () => root.render(null))
  await open()
  expect(container.textContent).toContain('Recorded review needs validation')
  expect(container.querySelector('.save-editor__preview')).toBeNull()
  expect(workspace.saveSession.controller.snapshot().input!.selectedBuild!.revision).toEqual(recorded.selectedBuild!.revision)
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
  expect(workspace.saveSession.document!.file.exportedRevision).toBeNull()
  await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === 'Review again')!.click())
  expect(container.querySelector('.save-editor__preview')).not.toBeNull()
  const exact = localData.buildRevisions[revisionId!]
  localData = { ...localData, buildRevisions: { ...localData.buildRevisions, [revisionId!]: { ...exact, content: { ...exact.content, contextAssumptions: [...exact.content.contextAssumptions, 'Changed exact context'] } } } }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === 'Apply reviewed changes')!.click())
  expect(container.textContent).toContain('exact recorded review context is unavailable')
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
})
it('another owner appearing after Save publication blocks adoption and preserves later input for exact receipt retry', async () => {
  await open(); await type('captured V')
  let blocked = false
  const unregister = workspace.registerDraftPresence(() => blocked)
  const old = workspace, oldView = old.saveSession.transferView!
  afterNextGuestPublication(() => {
    blocked = true
    const input = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'later V+1')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  try {
    await act(async () => { expect(await actions!.save()).toBe(false) })
    expect(workspace.saveSession.phase).toBe('recovery')
    expect(workspace.saveSession.controller.snapshot().input!.fields.currency).toBe('later V+1')
    const receipt = workspace.saveSession.recovery!.outcome.receipt
    expect(workspace.saveSession.recovery!.outcome.status).toBe('saved')
    expect(() => old.saveSession.controller.assertView(oldView)).not.toThrow()
    blocked = false
    const resolve = vi.spyOn(ownedFiles, 'resolveOwnedFileReceipt')
    await act(async () => workspace.retrySaveCommand(oldView))
    await wait(() => expect(workspace.fileCommandPending()).toBe(false))
    expect(resolve.mock.calls[0][0]).toBe(receipt)
    expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'captured V' } })
    expect(workspace.saveSession.controller.snapshot()).toMatchObject({ dirty: true, input: { fields: { currency: 'later V+1' } } })
    expect(() => old.saveSession.controller.assertView(oldView)).toThrow(/retired/)
  } finally { unregister() }
})

it('a clean Save can leave and return within the same provider without reviving its retired view', async () => {
  await open()
  const controller = workspace.saveSession.controller, previousView = workspace.saveSession.transferView!
  await act(async () => root.render(<WorkspaceProvider><Owner shown={false}/></WorkspaceProvider>))
  expect(() => controller.assertView(previousView)).toThrow(/retired/)
  await open()
  expect(workspace.saveSession.transferView).not.toBe(previousView)
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('123')
  await type('fresh owner input')
  expect(controller.snapshot().input!.fields.currency).toBe('fresh owner input')
})

it('StrictMode retains one actual parent and child owner through a pending Save remount', async () => {
  childEnabled = true; strictEnabled = true
  await open()
  expect(container.textContent).not.toContain('Legacy check cancelled')
  expect(container.querySelector('[aria-label="Older local workspace needs recovery"]')).toBeNull()
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click())
  await type('strict input')
  const old = workspace.saveSession.transferView!
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.controller.snapshot().input).toMatchObject({ member: 1, fields: { currency: 'strict input' } })
  expect(container.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected')).toBe('true')
  expect(() => workspace.saveSession.controller.assertView(old)).toThrow(/retired/)
})

it('Save subtree StrictMode retains one actual parent and child owner through a pending Save remount', async () => {
  childEnabled = true; strictChildOnly = true
  await open()
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click())
  await type('strict input')
  const old = workspace.saveSession.transferView!
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.controller.snapshot().input).toMatchObject({ member: 1, fields: { currency: 'strict input' } })
  expect(container.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected')).toBe('true')
  expect(() => workspace.saveSession.controller.assertView(old)).toThrow(/retired/)
})
it('discard restores the durable child member and form without retiring the parent Save view', async () => {
  childEnabled = true
  await open()
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click())
  await type('discard this')
  const parent = workspace.saveSession.transferView!
  await act(async () => actions!.discard())
  expect(container.querySelectorAll('[role="tab"]')[0].getAttribute('aria-selected')).toBe('true')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('123')
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
  expect(() => workspace.saveSession.controller.assertView(parent)).not.toThrow()
})

describe('switching saved documents', () => {
  let otherId: string
  beforeEach(async () => { otherId = (await createSaveRepository(createGuestRepository(db)).importFile('other.sav', bytes)).id })
  it('opens the chosen document with its own live child and presentation', async () => {
    childEnabled = true
    await open()
    const parent = workspace.saveSession.transferView!
    await act(async () => {
      const select = [...container.querySelectorAll('select')].find(value => value.querySelector(`option[value="${otherId}"]`))!
      select.value = otherId; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await wait(() => expect(workspace.saveSession.document?.file.id).toBe(otherId))
    expect(container.querySelectorAll('[role="tab"]')[0].getAttribute('aria-selected')).toBe('true')
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click())
    expect(workspace.saveSession.controller.snapshot().input!.member).toBe(1)
    expect(() => workspace.saveSession.controller.assertView(parent)).not.toThrow()
  })
  it('keeps the captured document selected while exact source reads are unresolved', async () => {
    await open()
    const sourceRead = Symbol('delayed source read')
    workspace.saveSession.sourceReads.add(sourceRead)
    await act(async () => {
      const select = [...container.querySelectorAll('select')].find(value => value.querySelector(`option[value="${otherId}"]`))!
      select.value = otherId; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await wait(() => expect(container.textContent).toContain('Finish reading Save definitions'))
    expect(workspace.saveSession.document!.file.id).toBe(savedId)
    workspace.saveSession.sourceReads.delete(sourceRead)
  })
})

it('strict download keeps presentation input locked while its exact marker receipt is reconciled', async () => {
  await open()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:strict-save-download'), revokeObjectURL: vi.fn() }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  let reached!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let finished!: () => void
  const completion = new Promise<void>(resolve => { finished = resolve }), complete = workspace.completeSaveCommand
  vi.spyOn(workspace, 'completeSaveCommand').mockImplementation(async (...args) => { try { await complete(...args) } finally { finished() } })
  const resolveReceipt = ownedFiles.resolveOwnedFileReceipt
  vi.spyOn(ownedFiles, 'resolveOwnedFileReceipt').mockImplementationOnce(async receipt => { reached(); await gate; return resolveReceipt(receipt) })
  try {
    await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Export edited save')!.click(); await entered })
    const query = container.querySelector<HTMLInputElement>('input[type="search"]')!
    expect(query.disabled).toBe(true)
    expect([...container.querySelectorAll<HTMLSelectElement>('.save-editor__inventory-tools select')].every(value => value.disabled)).toBe(true)
    const original = [...container.querySelectorAll('button')].find(value => value.textContent === 'Download original')!
    expect(original.disabled).toBe(true)
    await act(async () => original.click())
    expect(click).toHaveBeenCalledTimes(1)
  } finally { await act(async () => { release(); await completion }) }
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.document!.exportStatus).toBe('requested')
  expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
  const committed = workspace.saveSession.document!.file
  await type('not a number')
  const original = [...container.querySelectorAll('button')].find(value => value.textContent === 'Download original')!
  expect(original.disabled).toBe(false)
  await act(async () => original.click())
  expect(click).toHaveBeenCalledTimes(2)
  expect(workspace.saveSession.document!.file).toEqual(committed)
  expect(workspace.saveSession.controller.snapshot().input?.fields.currency).toBe('not a number')
})

it('unknown marker outcome retries its original command and initiates the working download only once', async () => {
  await open()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:uncertain-save-download'), revokeObjectURL: vi.fn() }))
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const commit = ownedFiles.commitOwnedFile
  let actual: ownedFiles.OwnedFileOutcome | undefined, finished!: () => void
  const completion = new Promise<void>(resolve => { finished = resolve }), complete = workspace.completeSaveCommand
  vi.spyOn(workspace, 'completeSaveCommand').mockImplementation(async (...args) => { try { await complete(...args) } finally { finished() } })
  const reconciled = vi.fn(async () => actual!)
  const commands: ownedFiles.OwnedFileCommand[] = []
  vi.spyOn(ownedFiles, 'commitOwnedFile').mockImplementation(async (...args) => {
    actual = await commit(...args); commands.push(args[3])
    return ownedFiles.reconcilableFileOutcome({ status: 'uncertain', error: new Error('Synthetic acknowledgement lost') }, reconciled)
  })
  await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Export edited save')!.click(); await completion })
  expect(workspace.saveSession.phase).toBe('recovery')
  expect(workspace.saveSession.recovery!.outcome.status).toBe('uncertain')
  expect(workspace.saveSession.document!.exportStatus).toBe('never')
  expect(click).toHaveBeenCalledTimes(1)
  await act(async () => workspace.retrySaveCommand(workspace.saveSession.transferView!))
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(commands).toHaveLength(1)
  expect(reconciled).toHaveBeenCalledTimes(1)
  expect(workspace.saveSession.document!.exportStatus).toBe('requested')
  expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
  expect(click).toHaveBeenCalledTimes(1)
})

it('delayed download cleanup uses the URL allocator that owns the download', async () => {
  await open()
  const revoke = vi.fn(), replacementRevoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => 'blob:owned-save-download'), revokeObjectURL: revoke }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const schedule = globalThis.setTimeout
  let cleanup: (() => void) | undefined
  vi.spyOn(window, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    const timer = schedule(handler, delay, ...args)
    if (delay === 1_000 && typeof handler === 'function') { window.clearTimeout(timer); cleanup = () => handler(...args) }
    return timer
  })
  await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Download original')!.click() })
  expect(cleanup).toBeDefined()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { revokeObjectURL: replacementRevoke }))
  cleanup!()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-save-download')
  expect(replacementRevoke).not.toHaveBeenCalled()
})

it.each(['create', 'click'] as const)('failed working download %s preserves the exact marker and bytes without a file commit', async failure => {
  await open()
  const create = vi.fn(() => { if (failure === 'create') throw new Error('Synthetic URL unavailable'); return 'blob:failed-save-download' })
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Synthetic initiation rejected') })
  const commit = vi.spyOn(ownedFiles, 'commitOwnedFile'), before = workspace.saveSession.document
  await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Export edited save')!.click() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(container.textContent).toContain('Download could not start')
  expect(workspace.saveSession.document).toBe(before)
  expect(workspace.saveSession.document!.file.exportedRevision).toBeNull()
  expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
  expect(commit).not.toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledTimes(failure === 'click' ? 1 : 0)
})

it('refreshes only Save list metadata on a captured repository notification and fences a retired callback', async () => {
  await open()
  const repository = workspace.repository, subscribe = repository.subscribe
  await act(async () => root.render(<WorkspaceProvider><Owner shown={false}/></WorkspaceProvider>))
  let notify: Parameters<typeof repository.subscribe>[0] | undefined
  vi.spyOn(repository, 'subscribe').mockImplementation(listener => { notify = listener; return subscribe(listener) })
  const previousDocument = workspace.saveSession.document
  await open()
  await wait(() => expect(workspace.saveSession.document).not.toBe(previousDocument))
  expect(notify).toBeTypeOf('function')
  const row = workspace.saveSession.document!.file, state = await repository.readWorkspace()
  // This metadata subscription unit supplies a remote projection at the captured repository boundary
  const read = vi.spyOn(repository, 'readWorkspace').mockResolvedValue({ ...state, saveDocuments: state.saveDocuments.map(value => value.id === row.id ? { ...value, filename: 'remote-label.sav' } : value) })
  await act(async () => notify!({ localDataId: localData.id, revision: localData.revision + 1, reason: 'save' }))
  await wait(() => expect(container.querySelector(`option[value="${savedId}"]`)!.textContent).toBe('remote-label.sav'))
  expect(workspace.saveSession.document!.file).toEqual(row)
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(false)
  await act(async () => root.render(<WorkspaceProvider><Owner shown={false}/></WorkspaceProvider>))
  read.mockClear()
  await act(async () => notify!({ localDataId: localData.id, revision: localData.revision + 2, reason: 'save' }))
  expect(read).not.toHaveBeenCalled()
})

it.each(['saveExport', 'saveApply'] as const)('saved strict changed %s input retains its rejected ticket and offers a separate exact recovery copy', { timeout: SAVE_STRICT_RECOVERY_COPY_MS }, async operation => {
  await open()
  if (operation === 'saveApply') await type('4321')
  const expectedDownloads = operation === 'saveExport' ? 2 : 1
  const blobs: Blob[] = []
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return `blob:save-recovery-${blobs.length}` }), revokeObjectURL: vi.fn() }))
  const downloads: string[] = []
  let copyInitiated!: () => void
  const copied = new Promise<void>(resolve => { copyInitiated = resolve })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); if (downloads.length === expectedDownloads) copyInitiated() })
  let finished!: () => void
  const completion = new Promise<void>(resolve => { finished = resolve }), complete = workspace.completeSaveCommand, controller = workspace.saveSession.controller, view = workspace.saveSession.transferView!
  vi.spyOn(workspace, 'completeSaveCommand').mockImplementation(async (...args) => { try { await complete(...args) } finally { finished() } })
  afterNextGuestPublication(() => controller.present(view, 'query', 'later strict query'))
  await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === (operation === 'saveExport' ? 'Export edited save' : 'Apply currency'))!.click(); await completion })
  expect(workspace.saveSession.phase).toBe('recovery')
  const recovery = workspace.saveSession.recovery!
  expect(recovery.outcome.status).toBe('saved')
  expect(() => recovery.ticket.command.assertMayActivate()).toThrow(/changed/)
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Download recovery copy')
  expect(button).toBeDefined()
  expect([...container.querySelectorAll('button')].some(value => value.textContent === 'Retry operation')).toBe(false)
  await act(async () => { button!.click(); await copied })
  expect(downloads).toHaveLength(expectedDownloads)
  expect(downloads.at(-1)).toBe('saved.sav-recovery.jsonl')
  const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blobs.at(-1)!) })
  const records = text.trim().split('\n').map(line => JSON.parse(line))
  const recoverBytes = (kind: string) => Buffer.concat(records.filter(record => record.kind === kind).map(record => Buffer.from(record.base64, 'base64')))
  expect(recoverBytes('original')).toEqual(Buffer.from(bytes))
  const { decodeCrystalSave } = await import('../interchange/crystal-save')
  expect(decodeCrystalSave(recoverBytes('working')).header.currencyAmount).toBe(operation === 'saveApply' ? 4321 : 123)
  expect(records[0].livePending.presentation.query).toBe('later strict query')
  expect(records[0].storedPending).toEqual(recovery.file!.pendingForm)
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
  expect(workspace.saveSession.recovery).toBe(recovery)
  expect(controller.snapshot().input!.presentation.query).toBe('later strict query')
  expect(() => recovery.ticket.command.assertMayActivate()).toThrow(/changed/)
  expect(container.textContent).toContain('not an automatic restore')
})

it('coalesces StrictMode Save hydration checks without retiring the committed input owner', async () => {
  strictEnabled = true
  await open(); await type('strict pending input')
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(container.textContent).not.toContain('Workspace changed during save hydration')
  expect(workspace.saveSession.phase).toBe('idle')
  await type('next input')
  expect(workspace.saveSession.controller.snapshot().input!.fields.currency).toBe('next input')
  expect(workspace.saveSession.controller.snapshot().dirty).toBe(true)
})

it.each(['final receipt', 'hydration'] as const)('rechecks another queued owner after the Save %s await before completing adoption', async stage => {
  await open(); await type('guarded pending input')
  let blocked = false, checks = 0
  const unregister = workspace.registerDraftPresence(owner => blocked && owner !== Symbol.for('unrelated-queue'))
  const resolve = ownedFiles.resolveOwnedFileReceipt
  vi.spyOn(ownedFiles, 'resolveOwnedFileReceipt').mockImplementation(async receipt => {
    const completion = await resolve(receipt)
    return { ...completion, assertCurrent: async () => { await completion.assertCurrent(); if (++checks === (stage === 'final receipt' ? 1 : 2)) blocked = true } }
  })
  try {
    await act(async () => { await actions!.save() })
    await wait(() => expect(workspace.saveSession.phase).toBe('recovery'))
    expect(workspace.fileCommandPending()).toBe(true)
    expect(workspace.saveSession.controller.snapshot().input!.fields.currency).toBe('guarded pending input')
    expect(workspace.saveSession.controller.snapshot().dirty).toBe(stage === 'final receipt')
    blocked = false
    await act(async () => workspace.retrySaveCommand(workspace.saveSession.transferView!))
    await wait(() => expect(workspace.fileCommandPending()).toBe(false))
    expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'guarded pending input' } })
    expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
  } finally { unregister() }
})

describe('actual encrypted account Save owner', () => {
  let account: import('../persistence/account-database').AccountDatabase
  beforeEach(async () => {
    childEnabled = true
    const { installProfile } = await import('../account/profile')
    const { AccountDatabase } = await import('../persistence/account-database')
    const { openAccountRepository } = await import('../workspace/account-repository')
    await open()
    const token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32)))
    account = new AccountDatabase(token.accountId)
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { prepareAccountWorkspace } = await import('../workspace/account-graph')
    const { activateLocalAccountCommit } = await import('../persistence/account-database')
    const { accountLocalId } = await import('../workspace/account-cache')
    const fixture = await editorClosureFixture()
    // This owner-race baseline has no catalog imports; all Save bytes still use real encrypted storage
    const prepared = await prepareAccountWorkspace(account, token, { ...fixture.state, retainedContent: [], blobs: [] })
    await activateLocalAccountCommit(account, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const repository = await openAccountRepository(token)
    savedId = (await createSaveRepository(repository).importFile('account.sav', Uint8Array.from(bytes))).id
    await act(async () => workspace.openAccount(token))
    await wait(() => expect(container.querySelector(`option[value="${savedId}"]`)).not.toBeNull())
    await act(async () => { const select = container.querySelector('select')!; select.value = savedId; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await wait(() => expect(workspace.saveSession.document?.file.id).toBe(savedId))
  })
  afterEach(async () => { const { invalidateProfile } = await import('../account/profile'); await act(async () => invalidateProfile()); await account.delete() })
  it.each([
    ['released', 'lock'], ['released', 'sign-out'], ['released', 'switch'],
    ['mounted', 'lock'], ['mounted', 'sign-out'], ['mounted', 'switch'],
  ] as const)('scrubs actual account Save plaintext after %s view and %s transition', async (viewState, transition) => {
    const selector = container.querySelector<HTMLSelectElement>('.save-party__build-import select')!
    const revisionId = [...selector.options].find(option => option.value)!.value
    await act(async () => { selector.value = revisionId; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await type('private profile input')
    const previous = workspace, controller = previous.saveSession.controller, view = previous.saveSession.transferView!
    const captured = controller.snapshot(), ownedBytes = Reflect.get(controller, 'bytes') as Uint8Array
    expect(captured.input?.selectedBuild?.revision).toEqual(localData.buildRevisions[revisionId])
    expect(captured.input?.context).toBeDefined()
    expect(Reflect.get(controller, 'choices').builds.length).toBeGreaterThan(0)
    const ticket = controller.capture(view, 'savePending', () => {})
    if (viewState === 'released') {
      await act(async () => root.render(<WorkspaceProvider><Owner shown={false}/></WorkspaceProvider>))
      expect(previous.saveSession.transferView).toBeUndefined()
      expect(controller.snapshot()).toEqual(captured)
      expect(Array.from(ownedBytes)).toEqual(Array.from(bytes))
    }
    const { lockProfile, signOutProfile } = await import('../account/lifecycle')
    const { invalidateProfile, installProfile } = await import('../account/profile')
    await act(async () => {
      if (transition === 'lock') await lockProfile(previous.token!)
      else if (transition === 'sign-out') expect(await signOutProfile(previous.token!)).toEqual({ revocationPending: false })
      else invalidateProfile()
    })
    expect(controller.snapshot()).toEqual({ dirty: false })
    for (const key of ['saved', 'base', 'bytes', 'choices', 'child', 'view']) expect(Reflect.get(controller, key), key).toBeUndefined()
    expect(ownedBytes.every(byte => byte === 0)).toBe(true)
    expect(previous.saveSession.document).toBeUndefined()
    expect(() => ticket.command.assertMayActivate()).toThrow()
    expect(() => previous.beginSaveCommand(view, 'savePending')).toThrow()
    let other: import('../persistence/account-database').AccountDatabase | undefined
    try {
      if (transition === 'switch') {
        const { AccountDatabase, activateLocalAccountCommit } = await import('../persistence/account-database')
        const { prepareAccountWorkspace } = await import('../workspace/account-graph')
        const { editorClosureFixture } = await import('../workspace/test-helpers')
        const { accountLocalId } = await import('../workspace/account-cache')
        const token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32)))
        other = new AccountDatabase(token.accountId)
        const fixture = await editorClosureFixture(), prepared = await prepareAccountWorkspace(other, token, { ...fixture.state, retainedContent: [], blobs: [] })
        await activateLocalAccountCommit(other, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
        await act(async () => previous.openAccount(token))
      } else {
        // The account panel releases its pending access before the actual Continue action opens a guest epoch
        await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Continue using this device')!.click() })
        await wait(() => expect(workspace.repository.kind).toBe('guest'))
      }
      await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
      await act(async () => { await workspace.repository.load() })
      expect(workspace.saveSession.controller.snapshot()).toEqual({ dirty: false })
      expect(container.querySelector('[aria-label="Copper"]')).toBeNull()
      expect(container.textContent).not.toContain('private profile input')
      expect(Reflect.get(controller, 'choices')).toBeUndefined()
      expect(() => ticket.command.assertMayActivate()).toThrow()
    } finally { if (other) { await act(async () => invalidateProfile()); await other.delete() } }
  })
  it('keeps a staging-gap V+1 private and dirty while only captured V becomes encrypted durable input', async () => {
    await type('private captured V')
    const previous = workspace, view = workspace.saveSession.transferView!
    const add = IDBObjectStore.prototype.add
    let changed = false
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (!changed && this.name === 'stagedCipherChunks') {
        changed = true
        const input = container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'private later V+1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return add.apply(this, args)
    })
    await act(async () => { await actions!.save() })
    await wait(() => expect(workspace.fileCommandPending()).toBe(false))
    expect(changed).toBe(true)
    expect(workspace.saveSession.controller.snapshot()).toMatchObject({ dirty: true, input: { fields: { currency: 'private later V+1' } } })
    expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: { currency: 'private captured V' } })
    expect(Array.from(workspace.saveSession.document!.content.originalBytes)).toEqual(Array.from(bytes))
    expect(Array.from(workspace.saveSession.document!.content.workingBytes)).toEqual(Array.from(bytes))
    expect(() => previous.beginSaveCommand(view, 'savePending')).toThrow()
    const encrypted = JSON.stringify(await Promise.all(account.tables.map(table => table.toArray())))
    const guest = JSON.stringify(await Promise.all(db.tables.map(table => table.toArray())))
    expect(encrypted).not.toContain('private captured V'); expect(encrypted).not.toContain('private later V+1')
    expect(guest).not.toContain('private captured V'); expect(guest).not.toContain('private later V+1')
  })
  it.each(['staging', 'acknowledgement'] as const)('rejects a profile transition during actual account %s without adopting into a new owner', async stage => {
    const { invalidateProfile } = await import('../account/profile')
    await type('private delayed input')
    const before = (await account.profileMeta.get('active'))!, previous = workspace, view = workspace.saveSession.transferView!
    let transitioned = false
    if (stage === 'staging') {
      const add = IDBObjectStore.prototype.add
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
        if (!transitioned && this.name === 'stagedCipherChunks') { transitioned = true; invalidateProfile() }
        return add.apply(this, args)
      })
    } else {
      const resolve = ownedFiles.resolveOwnedFileReceipt
      vi.spyOn(ownedFiles, 'resolveOwnedFileReceipt').mockImplementation(async receipt => { const result = await resolve(receipt); transitioned = true; invalidateProfile(); return result })
    }
    await act(async () => { try { await actions!.save() } catch { /* The retiring owner cannot display completion */ } })
    expect(transitioned).toBe(true)
    expect(container.textContent).toContain('Account workspace locked')
    expect(container.querySelector('[aria-label="Copper"]')).toBeNull()
    expect(() => previous.beginSaveCommand(view, 'savePending')).toThrow()
    const after = (await account.profileMeta.get('active'))!
    if (stage === 'staging') expect(after).toEqual(before)
    else expect(after.head).not.toEqual(before.head)
    expect(JSON.stringify(await Promise.all(account.tables.map(table => table.toArray())))).not.toContain('private delayed input')
  })

})

it('recovery reload cancellation and unrelated owner guards preserve the rejected live form', async () => {
  await open()
  const controller = workspace.saveSession.controller, view = workspace.saveSession.transferView!
  afterNextGuestPublication(() => controller.present(view, 'query', 'live recovery query'))
  const ticket = workspace.beginSaveCommand(view, 'saveExport')
  let outcome: import('../workspace/owned-file-command').OwnedFileOutcome | undefined
  const file = await createSaveRepository(workspace.repository, { begin: () => ticket.command, onOutcome: value => { outcome = value } }).markExported(savedId, workspace.saveSession.document!.file.revision)
  await act(async () => { await expect(workspace.completeSaveCommand(outcome!, ticket, file)).rejects.toThrow(/captured draft was saved/) })
  expect(workspace.saveSession.phase).toBe('recovery')
  const recovery = workspace.saveSession.recovery!
  const cancel = vi.fn(() => false)
  await workspace.reloadSaveRecovery(view, cancel)
  expect(cancel).toHaveBeenCalledOnce()
  const confirm = vi.fn(() => true)
  const unregister = workspace.registerDraftPresence(owner => owner !== Symbol.for('queued other owner'))
  try {
    await expect(workspace.reloadSaveRecovery(view, confirm)).rejects.toThrow(/draft/)
    await expect(workspace.prepareSaveRecovery(view)).rejects.toThrow(/owner|draft/)
    expect(confirm).not.toHaveBeenCalled()
  } finally { unregister() }
  workspace.saveSession.sourceReads.add(Symbol('recovery-source'))
  try { await expect(workspace.reloadSaveRecovery(view, confirm)).rejects.toThrow(/owner|draft/) } finally { workspace.saveSession.sourceReads.clear() }
  expect(workspace.saveSession.recovery).toBe(recovery)
  expect(controller.snapshot()).toMatchObject({ dirty: true, input: { presentation: { query: 'live recovery query' } } })
  expect(() => ticket.command.assertMayActivate()).toThrow(/changed/)
})

it('explicit no-op Apply durably clears a pending spelling without changing bytes or marker on reopen', async () => {
  await open(); await type(' 123 ')
  const before = workspace.saveSession.document!.file
  let finished!: () => void
  const completion = new Promise<void>(resolve => { finished = resolve }), complete = workspace.completeSaveCommand
  vi.spyOn(workspace, 'completeSaveCommand').mockImplementation(async (...args) => { try { await complete(...args) } finally { finished() } })
  await act(async () => { [...container.querySelectorAll('button')].find(value => value.textContent === 'Apply currency')!.click(); await completion })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  expect(workspace.saveSession.document!.file.working).toEqual(before.working)
  expect(workspace.saveSession.document!.file.exportedRevision).toBe(before.exportedRevision)
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ fields: {} })
  await act(async () => root.render(null)); await open()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Copper"]')!.value).toBe('123')
  expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
})

it.each(['missing', 'newer', 'archived'] as const)('actual persisted Build choice handles %s context without substituting a current revision', async situation => {
  childEnabled = true
  await open()
  const choices = container.querySelector<HTMLSelectElement>('.save-party__build-import select')!
  const selected = [...choices.options].find(option => option.value)!
  await act(async () => { choices.value = selected.value; choices.dispatchEvent(new Event('change', { bubbles: true })) })
  const recorded = workspace.saveSession.controller.snapshot().input!.selectedBuild!
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  const before = workspace.saveSession.document!
  if (situation === 'archived') localData = { ...localData, builds: { ...localData.builds, [recorded.revision.buildId]: { ...localData.builds[recorded.revision.buildId], archived: true } } }
  else {
    const revisions = { ...localData.buildRevisions }; delete revisions[recorded.revision.id]
    const newerId = `${recorded.revision.id}-newer` as typeof recorded.revision.id
    if (situation === 'newer') revisions[newerId] = { ...recorded.revision, id: newerId, revision: recorded.revision.revision + 1 }
    localData = { ...localData, buildRevisions: revisions, builds: { ...localData.builds, [recorded.revision.buildId]: { ...localData.builds[recorded.revision.buildId], latestRevisionId: situation === 'newer' ? newerId : undefined } } }
  }
  await act(async () => root.render(null)); await open()
  const review = [...container.querySelectorAll('button')].find(value => value.textContent === 'Review Build')!
  expect(review.disabled).toBe(situation !== 'archived')
  if (situation !== 'archived') expect(container.textContent).toContain('Recorded context unavailable')
  expect(workspace.saveSession.controller.snapshot().input!.selectedBuild).toEqual(recorded)
  expect(workspace.saveSession.document).toEqual(before)
  expect(workspace.saveSession.document!.content.workingBytes).toEqual(bytes)
})

it('actual restored personal Build choice requires the exact recorded definition chain', async () => {
  const revision = Object.values(localData.buildRevisions).find(value => value.content.primaryClass?.kind === 'catalog')!
  const id = 'personal-context-class' as import('../domain/types').PersonalDefinitionId
  const definition: import('../domain/types').PersonalDefinition = { id, name: 'Synthetic personal class', baseRef: revision.content.primaryClass!, revision: 1, kind: 'class', aliases: [], fields: {}, sources: [], createdAt: localData.createdAt, updatedAt: localData.createdAt }
  localData = { ...localData, personalDefinitions: { ...localData.personalDefinitions, [id]: definition }, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, primaryClass: { kind: 'personal', definitionId: id } } } } }
  childEnabled = true; await open()
  const choices = container.querySelector<HTMLSelectElement>('.save-party__build-import select')!
  expect([...choices.options].some(value => value.value === revision.id)).toBe(true)
  await act(async () => { choices.value = revision.id; choices.dispatchEvent(new Event('change', { bubbles: true })) })
  const recorded = workspace.saveSession.controller.snapshot().input!.selectedBuild!
  await act(async () => { expect(await actions!.save()).toBe(true) })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  await act(async () => root.render(null)); await open()
  const review = () => [...container.querySelectorAll('button')].find(value => value.textContent === 'Review Build')!
  expect(review().disabled).toBe(false)
  localData = { ...localData, personalDefinitions: { ...localData.personalDefinitions, [id]: { ...definition, name: 'Changed exact personal definition' } } }
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  expect(review().disabled).toBe(true)
  expect(container.textContent).toContain('Recorded context unavailable')
  expect(workspace.saveSession.controller.snapshot().input!.selectedBuild).toEqual(recorded)
  expect(workspace.saveSession.document!.file.pendingForm).toMatchObject({ selectedBuild: recorded })
  expect(workspace.saveSession.document!.content).toEqual({ originalBytes: bytes, workingBytes: bytes })
})
