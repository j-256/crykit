// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement, useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { CryKitDatabase, setDatabaseForTests } from '../../persistence/database'
import { createBlankLocalData } from '../../domain/local-data'
import '../../workspace/guest-managed-monitor.test-helpers'
import { getInspectorStorage, type InspectorStorage } from '../../mod-inspector/storage'
import { createGuestRepository } from '../../workspace/guest-repository'
import { createEditorRepository } from '../../workspace/editor-repository'
import * as editorDocument from '../../workspace/editor-document'
import * as receipts from '../../workspace/owned-file-command'
import { WorkspaceProvider, useWorkspace } from '../WorkspaceProvider'
import * as workspaceHooks from '../WorkspaceProvider'
import { installProfile, invalidateProfile } from '../../account/profile'
import { ModInspectorView } from '../ModInspectorView'
import type { DraftActions } from '../drafts'
import type { ModEditorView } from '../mod-workspace'
import { newMapProject } from '../../mod-inspector/map-editor'
import * as worldMap from '../../catalog/world-map'
import type MapPlacementEditor from './MapPlacementEditor'
import type { InspectorDraft } from '../../mod-inspector/types'

const childActions = vi.hoisted(() => [] as DraftActions[])
const mapChildren = vi.hoisted(() => [] as Parameters<typeof MapPlacementEditor>[0][])
const { FixtureTextEncoder } = vi.hoisted(() => {
  class FixtureTextEncoder extends TextEncoder {
    override encode(value?: string): Uint8Array<ArrayBuffer> { return new Uint8Array(super.encode(value)) }
  }
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  return { FixtureTextEncoder }
})
// Field and ownership cases use a closed planner; complete native migration has browser coverage
vi.mock('../../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))
vi.mock('../../catalog/world-map', async importOriginal => ({ ...await importOriginal<typeof import('../../catalog/world-map')>(), loadWorldMap: async () => ({ schemaVersion: 1, source: { platform: 'synthetic', gameVersion: 'synthetic', lastVanillaEntityId: 100, voxelNames: { 9: 'Synthetic voxel' } }, bounds: { x: 0, z: 0, width: 100, height: 100 }, layers: [{ id: 0, label: 'Synthetic layer', image: '' }], regions: [], markers: [] }) }))
vi.mock('./MapPlacementEditor', async importOriginal => {
  const actual = await importOriginal<typeof import('./MapPlacementEditor')>()
  return { default: function ObservedMapPlacementEditor(props: Parameters<typeof MapPlacementEditor>[0]) {
    mapChildren.push(props)
    const onDraftChange = useCallback<typeof props.onDraftChange>((dirty, actions) => { if (actions) childActions.push(actions); props.onDraftChange(dirty, actions) }, [props.onDraftChange])
    return createElement(actual.default, { ...props, onDraftChange })
  } }
})
let mapView = false
let forcedView: ModEditorView | undefined
let remoteListeners: Set<() => void> | undefined
const subscribed = new WeakSet<object>()
vi.mock('../../workspace/device-selection', () => ({ readDeviceSelection: async () => ({ key: 'selected', version: 1, kind: 'guest' }) }))
let db: CryKitDatabase, storage: InspectorStorage, saved: InspectorDraft, container: HTMLDivElement, root: ReturnType<typeof createRoot>
let workspace: ReturnType<typeof useWorkspace>, actions: DraftActions | undefined, reportedDirty: boolean | undefined
const saveToLibrary = vi.fn(async (_text: string, _filename: string) => ({ title: 'Synthetic revision', unchanged: false, warnings: [] as string[] }))
const LOCAL_EDITOR_COMMAND_MS = 15_000
const originalWorkspaceHook = useWorkspace
const originalText = '{"Count":1,"Values":[1]}'
function Owner() {
  workspace = useWorkspace()
  if (remoteListeners && !subscribed.has(workspace.repository)) {
    subscribed.add(workspace.repository)
    vi.spyOn(workspace.repository, 'subscribe').mockImplementation(listener => {
      const callback = () => listener({ localDataId: 'synthetic' as import('../../domain/types').LocalDataId, revision: 99, reason: 'save' })
      remoteListeners!.add(callback); return () => remoteListeners?.delete(callback)
    })
  }
  return <main className="main-shell"><ModInspectorView view={forcedView ?? (mapView ? 'map' : undefined)} onSaveToLibrary={saveToLibrary} onDraftChange={(dirty, next) => { reportedDirty = dirty; if (next) actions = next }}/></main>
}
beforeEach(async () => {
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const nativeClone = globalThis.structuredClone
  function rehome(value: unknown): unknown {
    if (ArrayBuffer.isView(value)) return new Uint8Array(Array.from(value as Uint8Array))
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(Array.from(new Uint8Array(value as ArrayBuffer))).buffer
    if (Array.isArray(value)) return value.map(rehome)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rehome(child)]))
    return value
  }
  // Node's IndexedDB fixture clones into its realm; normalize fixture values without changing production codecs
  vi.stubGlobal('structuredClone', (value: unknown) => rehome(nativeClone(value)))
  // These DOM cases exercise fields and owner callbacks; browser journeys cover actual canvas rendering
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  sessionStorage.clear(); saveToLibrary.mockClear(); mapView = false; forcedView = undefined; remoteListeners = undefined; mapChildren.length = 0; childActions.length = 0
  db = new CryKitDatabase(`editor-dom-${crypto.randomUUID()}`); setDatabaseForTests(db)
  // A normal guest planner exists before its first Inspector import; partial old storage must not be reseeded
  const localData = createBlankLocalData()
  await db.localDatas.add({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  storage = getInspectorStorage(`${db.name}-inspector`)
  saved = await storage.import('synthetic.json', originalText, 'synthetic')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); actions = undefined; reportedDirty = undefined
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile(); storage.close(); setDatabaseForTests(undefined); await db.delete(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function wait(assertion: () => void | Promise<void>) { await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); await assertion() }, { timeout: LOCAL_EDITOR_COMMAND_MS }) }
async function render() {
  await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
  await wait(() => expect(container.querySelector(`option[value="${saved.id}"]`)).not.toBeNull())
}
async function open() {
  await render()
  await act(async () => { const select = container.querySelector('select')!; select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await wait(() => expect(container.querySelector('textarea')).not.toBeNull())
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
}
async function edit(text: string) {
  await act(async () => { const field = container.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function flush() {
  await act(async () => { await actions!.save() })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
}
async function stored() { return createEditorRepository(createGuestRepository(db)).read(saved.id) }

it('keeps sibling branches expanded through an owned field-selection save', async () => {
  await open()
  const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand $.Values"]')!
  await act(async () => expand.click())
  expect(container.querySelector('[aria-label="Select $.Values[0]"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select $.Count"]')!.click())
  await flush()
  expect(container.querySelector('.inspector-path')?.textContent).toBe('$.Count')
  expect(container.querySelector('[aria-label="Select $.Values[0]"]')).not.toBeNull()
  expect((await stored())!.content.lastAppliedText).toBe(originalText)
})

it('keeps a later explorer search focused through an owned field-selection save', async () => {
  await open()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select $.Count"]')!.click())
  const search = container.querySelector<HTMLInputElement>('.inspector-tree-panel input[type="search"]')!
  await act(async () => {
    search.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Values')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  const reopened = container.querySelector<HTMLInputElement>('.inspector-tree-panel input[type="search"]')!
  expect(reopened.value).toBe('Values')
  expect(document.activeElement).toBe(reopened)
  await wait(() => expect(container.querySelector('.inspector-search-result code')?.textContent).toBe('$.Values'))
  expect((await stored())!.content.lastAppliedText).toBe(originalText)
})

it.each(['selection', 'branch expansion'] as const)('keeps a JSON %s click alive while an earlier quiet save reopens its owner', async kind => {
  await open()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select $.Count"]')!.click())
  const view = workspace.editorSession.transferView
  const target = container.querySelector<HTMLButtonElement>(`[aria-label="${kind === 'selection' ? 'Select' : 'Expand'} $.Values"]`)!
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reached = false, returned = false
  const resolve = receipts.resolveOwnedFileReceipt
  vi.spyOn(receipts, 'resolveOwnedFileReceipt').mockImplementation(async receipt => {
    const completion = await resolve(receipt)
    return { ...completion, assertCurrent: async () => {
      await completion.assertCurrent()
      if (!reached) { reached = true; await gate; returned = true }
    } }
  })
  let saving: Promise<boolean> | undefined
  try {
    await act(async () => { saving = actions!.save() })
    await wait(() => expect(reached).toBe(true))
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      release()
    })
    await wait(() => expect(returned).toBe(true))
    expect(workspace.editorSession.controller.canTransfer()).toBe(false)
    expect(workspace.editorSession.transferView).toBe(view)
    expect(target.isConnected).toBe(true)
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      expect(workspace.editorSession.controller.canTransfer()).toBe(false)
      target.click()
      await saving
    })
    await wait(() => expect(workspace.fileCommandPending()).toBe(false))
    const selected = kind === 'selection' ? 'Values' : 'Count'
    expect(container.querySelector('.inspector-path')?.textContent).toBe(`$.${selected}`)
    if (kind === 'branch expansion') expect(container.querySelector('[aria-label="Select $.Values[0]"]')).not.toBeNull()
    await flush()
    const document = (await stored())!
    expect(document.file.unfinished.editedPath).toEqual([selected])
    expect(document.content.originalText).toBe(originalText)
    expect(document.content.lastAppliedText).toBe(originalText)
  } finally {
    release()
    await act(async () => { window.dispatchEvent(new Event('pointercancel')); await saving })
  }
})

it('clears navigation draft presence when typing returns to the exact saved unfinished text', async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"broken":'); await flush()
  const revision = workspace.editorSession.controller.snapshot().revision
  await edit('{"broken": ')
  expect(reportedDirty).toBe(true)
  await edit('{"broken":')
  expect(reportedDirty).toBe(false)
  expect(workspace.editorSession.controller.snapshot()).toMatchObject({ dirty: false, revision })
  expect((await stored())!.file.revision).toBe(revision)
})

it('retires old branch controls before returning a transferred receipt', async () => {
  await open()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select $.Count"]')!.click())
  const view = workspace.editorSession.transferView
  const target = container.querySelector<HTMLButtonElement>('[aria-label="Expand $.Values"]')!
  await act(async () => {
    await actions!.save()
    expect(workspace.editorSession.transferView).not.toBe(view)
    // Observe the receipt continuation before act can flush a deferred replacement
    // A still-mounted retired control can accept a click whose expansion is then lost
    expect(target.isConnected).toBe(false)
  })
  await wait(() => expect(workspace.fileCommandPending()).toBe(false))
  await act(async () => {
    const next = container.querySelector<HTMLButtonElement>('[aria-label="Expand $.Values"]')!
    expect(next).not.toBeNull()
    expect(next).not.toBe(target)
    next.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    next.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    next.click()
  })
  expect(container.querySelector('[aria-label="Select $.Values[0]"]')).not.toBeNull()
  const document = (await stored())!
  expect(document.content.originalText).toBe(originalText)
  expect(document.content.lastAppliedText).toBe(originalText)
})

it('saves a quiet descendant without restarting its delay after an owned view transfer', async () => {
  await open(); await click('Edit whole document JSON'); await flush()
  const realTimeout = setTimeout
  const nativeSettlementMilliseconds = 1000
  const nativePollMilliseconds = 5
  const waitForNative = async (ready: () => boolean) => {
    const deadline = Date.now() + nativeSettlementMilliseconds
    while (!ready() && Date.now() < deadline) await act(async () => { await new Promise(resolve => realTimeout(resolve, nativePollMilliseconds)) })
    expect(ready()).toBe(true)
  }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reached = false
  const resolve = receipts.resolveOwnedFileReceipt
  vi.spyOn(receipts, 'resolveOwnedFileReceipt').mockImplementation(async receipt => {
    const completion = await resolve(receipt)
    return { ...completion, assertCurrent: async () => {
      await completion.assertCurrent()
      if (!reached) { reached = true; await gate }
    } }
  })
  let saving: Promise<boolean> | undefined
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    await edit('{"first":')
    await act(async () => { saving = actions!.save() })
    await waitForNative(() => reached)
    await edit('{"later":')
    // Let the later input become quiet while the first receipt still owns the view
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    await act(async () => { release(); await saving })
    await waitForNative(() => !workspace.fileCommandPending())
    expect(workspace.editorSession.controller.snapshot().dirty).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await waitForNative(() => !workspace.fileCommandPending() && !workspace.editorSession.controller.snapshot().dirty)
    expect(container.querySelector('textarea')?.value).toBe('{"later":')
    const document = (await stored())!
    expect(document.content.unfinishedText).toBe('{"later":')
    expect(document.content.originalText).toBe(originalText)
    expect(document.content.lastAppliedText).toBe(originalText)
  } finally {
    release()
    vi.useRealTimers()
    await act(async () => { await saving })
  }
})

it('a settled Editor remount honors the requested route while owned New map hydration restores Map', async () => {
  function RoutedOwner() {
    workspace = useWorkspace()
    const [visible, setVisible] = useState(true)
    const [view, setView] = useState<ModEditorView>('document')
    return <>
      <button onClick={() => setVisible(false)}>Library fixture</button>
      <button onClick={() => { setView('document'); setVisible(true) }}>JSON fixture</button>
      <output data-testid="route">{view}</output>
      {visible && <ModInspectorView embedded view={view} onViewChange={setView}/>}
    </>
  }
  await act(async () => root.render(<WorkspaceProvider><RoutedOwner/></WorkspaceProvider>))
  await wait(() => expect(container.querySelector('select')).not.toBeNull())
  await click('New map mod')
  await wait(() => expect(container.querySelector('[data-testid="route"]')?.textContent).toBe('map'))
  await wait(() => expect(workspace.editorSession.hydration).toBeUndefined())
  const selected = workspace.editorSession.document!
  expect(selected.file.unfinished.fieldState).toMatchObject({ tab: 'map' })
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  await click('Library fixture')
  await click('JSON fixture')
  await wait(() => expect(container.querySelector('.inspector-tree')).not.toBeNull())
  expect(container.querySelector('[data-testid="route"]')?.textContent).toBe('document')
  expect(workspace.editorSession.document).toBe(selected)
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  expect(workspace.fileCommandPending()).toBe(false)
})

it('explicit reselection retries a rejected complete read without losing the saved option or starting a command', async () => {
  await render()
  const read = vi.spyOn(workspace.repository, 'readWorkspace').mockRejectedValueOnce(new Error('The workspace changed during capture. Retry the complete read.'))
  const commit = vi.spyOn(workspace.repository, 'commitWorkspace')
  const begin = vi.spyOn(workspace, 'beginEditorCommand')
  const select = container.querySelector('select')!
  const choose = () => act(async () => { select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await choose()
  await wait(() => expect(container.textContent).toContain('Draft could not be opened: The workspace changed during capture. Retry the complete read.'))
  expect(select.value).toBe('')
  expect(select.disabled).toBe(false)
  expect(container.querySelector(`option[value="${saved.id}"]`)).not.toBeNull()
  expect(container.querySelector('.inspector-tree')).toBeNull()
  expect(workspace.isCurrent()).toBe(true)
  expect(workspace.fileCommandPending()).toBe(false)
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  expect(read).toHaveBeenCalledTimes(1)
  await choose()
  await wait(() => expect(container.querySelector('.inspector-tree')).not.toBeNull())
  expect(select.value).toBe(saved.id)
  expect(read).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('Draft could not be opened:')
  expect(workspace.editorSession.document?.content).toMatchObject({ originalText, lastAppliedText: originalText, unfinishedText: originalText })
  expect(workspace.fileCommandPending()).toBe(false)
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  expect(commit).not.toHaveBeenCalled()
  expect(begin).not.toHaveBeenCalled()
})

it('flushes invalid input without applying and restores its parse error from durable state', async () => {
  await open(); await click('Edit whole document JSON')
  let announced = false
  const observe = () => { announced = workspace.editorSession.controller.snapshot().dirty }
  document.addEventListener('input', observe)
  try { await edit('{"broken":'); expect(announced).toBe(true) }
  finally { document.removeEventListener('input', observe) }
  expect(container.querySelector('.inspector-save-state')?.textContent).toBe('Unsaved draft')
  await flush()
  expect((await stored())!.content).toMatchObject({ unfinishedText: '{"broken":', lastAppliedText: originalText, originalText })
  expect(container.querySelector('textarea')?.value).toBe('{"broken":')
  expect(container.querySelector('.inspector-error')).not.toBeNull()
  expect((await storage.get(saved.id))?.originalText).toBe(originalText)
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Save to CryKit')?.disabled).toBe(true)
  await click('Save to CryKit'); expect(saveToLibrary).not.toHaveBeenCalled()
})
it('explicit Apply preserves exact large-number text and original content', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"Count":900719925474099312345,"Values":[2,3]}')
  await click('Apply JSON edit')
  await wait(async () => expect((await stored())!.content.lastAppliedText).toBe('{"Count":900719925474099312345,"Values":[2,3]}'))
  expect((await stored())!.content.originalText).toBe(originalText)
  await wait(() => expect(container.querySelector('select')?.disabled).toBe(false))
  await click('Save to CryKit')
  expect(saveToLibrary).toHaveBeenCalledWith('{"Count":900719925474099312345,"Values":[2,3]}', 'synthetic.json', undefined, false, false, workspace.editorSession.controller.owner)
})
it('a quota failure keeps input and Retry saves its latest correction', async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"broken":')
  const put = IDBObjectStore.prototype.put
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'active') throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); return put.apply(this, args) })
  await act(async () => { await actions!.save() })
  expect(container.textContent).toContain('Draft is not saved')
  expect(container.querySelector('textarea')?.value).toBe('{"broken":')
  expect((await storage.get(saved.id))?.draftText).toBe(originalText)
  fault.mockRestore(); await edit('{"corrected":'); await click('Retry save')
  await wait(async () => expect((await stored())!.content.unfinishedText).toBe('{"corrected":'))
  expect((await stored())!.content.lastAppliedText).toBe(originalText)
})
it('downloads recovery text as exact UTF-16 code units after failure', async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"text":"\ud800')
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'active') throw new Error('Synthetic save failure'); return put.apply(this, args) })
  await act(async () => { await actions!.save() })
  let exported: Blob | undefined
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (body: Blob) => { exported = body; return 'blob:synthetic' }, revokeObjectURL: () => {} }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await click('Download unsaved draft for recovery')
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(exported!) })
  expect(Array.from(new Uint16Array(buffer))).toEqual(Array.from({ length: '{"text":"\ud800'.length }, (_, index) => '{"text":"\ud800'.charCodeAt(index)))
})
it('removal requires confirmation and retains a complete recoverable history', async () => {
  await open(); await click('Remove from recent files'); await click('Keep saved draft')
  expect(container.querySelector('select')?.value).toBe(saved.id)
  await click('Remove from recent files'); await click('Remove from editor')
  await wait(() => expect(container.querySelector(`option[value="${saved.id}"]`)).toBeNull())
  const state = await createGuestRepository(db).readWorkspace()
  expect(state.editorDocuments).toEqual([])
  expect(state.retainedContent.some(item => item.kind === 'file-history' && item.documentId === saved.id)).toBe(true)
  expect((await storage.get(saved.id))?.originalText).toBe(originalText)
})
it('discard invalidates an in-flight save instead of overwriting its original', async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"pending":')
  const prior = actions!
  let completion!: Promise<boolean>
  await act(async () => { completion = prior.save(); await prior.discard(); await completion })
  expect((await storage.get(saved.id))?.originalText).toBe(originalText)
  expect(workspace.editorSession.controller.snapshot().input?.text).toBe(originalText)
})

it('locks another file load and ignores edits until its exact row arrives', async () => {
  const second = await storage.import('second.json', '{"Count":2}', 'synthetic')
  await open(); await click('Edit whole document JSON'); await flush()
  await wait(() => expect(container.querySelector(`option[value="${second.id}"]`)).not.toBeNull())
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // Startup has migrated both files, so gate the actual captured repository read
  const readWorkspace = workspace.repository.readWorkspace.bind(workspace.repository)
  vi.spyOn(workspace.repository, 'readWorkspace').mockImplementation(async () => { await gate; return readWorkspace() })
  await act(async () => { const select = container.querySelector('select')!; select.value = second.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
  await edit('{"intruder":1}')
  expect(container.querySelector('textarea')?.value).toBe(originalText)
  await act(async () => { release() })
  await wait(() => expect(container.querySelector('select')?.value).toBe(second.id))
  expect(container.querySelector('.inspector-tree')?.textContent).toContain('2')
})
it('locks editing while imported bytes are pending and opens only the validated import', async () => {
  await open()
  const text = '{"Imported":true}', bytes = new TextEncoder().encode(text)
  let release!: (value: ArrayBuffer) => void
  const file = new File([], 'imported.json', { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { release = resolve })).mockResolvedValue(bytes.buffer) })
  await act(async () => { const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, 'files', { value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
  await edit('{"intruder":1}')
  await act(async () => { release(bytes.buffer) })
  await wait(() => expect(container.querySelector('.inspector-tree')?.textContent).toContain('Imported'))
  const state = await workspace.repository.readWorkspace(), imported = state.editorDocuments.find(row => row.filename === 'imported.json')!
  expect(Array.from((await createEditorRepository(workspace.repository).read(imported.id))!.content.originalBytes)).toEqual(Array.from(bytes))
  expect((await storage.get(saved.id))?.originalText).toBe(originalText)
})
it('failed removal keeps selection and ignores edits while the command is pending', async () => {
  await open()
  const put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'active') throw new Error('Synthetic removal failure'); return put.apply(this, args) })
  await click('Remove from recent files'); await click('Remove from editor')
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
  await edit('{"intruder":1}')
  await wait(() => expect(container.textContent).toContain('Synthetic removal failure'))
  expect(container.querySelector('select')?.value).toBe(saved.id)
  expect((await stored())!.content.originalText).toBe(originalText)
})
it('recovery reopening locks controls and retains the old draft until the saved row arrives', async () => {
  await open(); await click('Edit whole document JSON'); await edit('{"broken":')
  const put = IDBObjectStore.prototype.put
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'active') throw new Error('Synthetic save failure'); return put.apply(this, args) })
  await act(async () => { await actions!.save() }); fault.mockRestore()
  const read = workspace.repository.readWorkspace.bind(workspace.repository)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(workspace.repository, 'readWorkspace').mockImplementation(async () => { await gate; return read() })
  const reopen = [...container.querySelectorAll('button')].find(button => button.textContent === 'Reopen saved version')!
  await act(async () => {
    reopen.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    reopen.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    reopen.click()
  })
  expect(container.querySelector('fieldset')?.disabled).toBe(true)
  expect(container.querySelector('textarea')?.value).toBe('{"broken":')
  await edit('{"intruder":1}')
  await act(async () => { release() })
  await wait(() => expect(workspace.editorSession.controller.snapshot().input?.text).toBe(originalText))
  expect(container.textContent).not.toContain('Synthetic save failure')
})

let downloadSequence = 0
function downloads() {
  const exported: { blob: Blob; url: string; filename?: string }[] = []
  const revoke = vi.fn()
  // Browser URLs are unique across downloads, including delayed cleanup from a preceding case
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) { const url = `blob:editor-${downloadSequence++}`; exported.push({ blob, url }); return url }
    static revokeObjectURL = revoke
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { exported.at(-1)!.filename = this.download })
  return { exported, revoke }
}
async function blobBytes(blob: Blob) {
  return new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob) }))
}
function accountDownloadToken() {
  const token = installProfile('synthetic-download-profile', new Uint8Array(32).fill(7))
  // Exercise the actual profile lifetime with a captured token; guest fixture storage only supplies synthetic file bytes
  vi.spyOn(workspaceHooks, 'useWorkspace').mockImplementation(() => ({ ...originalWorkspaceHook(), token }))
  return token
}
it.each(['original', 'reviewed', 'recovery'] as const)('revokes the %s Editor download when its captured account profile changes', async kind => {
  const file = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'exact.json', bytes: new TextEncoder().encode(originalText), text: originalText, referenceId: 'synthetic' })
  saved = { ...saved, id: file.id }
  accountDownloadToken(); await open()
  if (kind === 'reviewed') { await click('Review export'); await wait(() => expect(container.querySelector('[aria-label="Export review"]')).not.toBeNull()) }
  if (kind === 'recovery') {
    await click('Edit whole document JSON'); await edit('{"broken":')
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'active') throw new Error('Synthetic save failure'); return put.apply(this, args) })
    await act(async () => { await actions!.save() })
  }
  const { exported, revoke } = downloads()
  // Prove profile revocation before the independent expiry timer, regardless of host load
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await click(kind === 'original' ? 'Download original' : kind === 'reviewed' ? 'Download mod' : 'Download unsaved draft for recovery')
    expect(exported).toHaveLength(1)
    expect(revoke).not.toHaveBeenCalledWith(exported[0].url)
    await act(async () => invalidateProfile())
    expect(revoke).toHaveBeenCalledWith(exported[0].url)
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
  } finally { vi.useRealTimers() }
})
it('cleans up an Editor URL immediately when download initiation throws', async () => {
  const file = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'exact.json', bytes: new TextEncoder().encode(originalText), text: originalText, referenceId: 'synthetic' })
  saved = { ...saved, id: file.id }
  await open(); const { exported, revoke } = downloads()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Synthetic anchor failure') })
  await click('Download original')
  expect(exported).toHaveLength(1)
  expect(revoke).toHaveBeenCalledWith(exported[0].url)
  expect(container.textContent).toContain('Synthetic anchor failure')
})
it('identifies legacy original text and downloads every saved UTF-16 code unit', async () => {
  const text = '{"raw":"\ud800","pair":"😀","replacement":"�"}'
  saved = await storage.import('legacy.json', text, 'synthetic')
  await open(); const { exported } = downloads()
  expect(container.textContent).toContain('Original bytes were not retained')
  await click('Download original text')
  expect(exported[0].filename).toBe('original-legacy.json.utf16le')
  expect(Array.from(new Uint16Array((await blobBytes(exported[0].blob)).buffer))).toEqual(Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)))
})
it.each(['\ud800', '\udfff'])('rejects lossy reviewed JSON download and retains exact applied text for recovery (%#)', async raw => {
  const text = `{"raw":"${raw}","pair":"😀","replacement":"�"}`
  saved = await storage.import('legacy.json', text, 'synthetic')
  await open(); await click('Review export'); await wait(() => expect(container.querySelector('[aria-label="Export review"]')).not.toBeNull())
  const { exported } = downloads()
  await click('Download mod')
  expect(exported).toHaveLength(0)
  expect(container.textContent).toContain('unpaired UTF-16 surrogate')
  await click('Download reviewed text for recovery')
  expect(exported[0].filename).toBe('legacy.json.utf16le')
  expect(Array.from(new Uint16Array((await blobBytes(exported[0].blob)).buffer))).toEqual(Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)))
  expect((await stored())!.content).toMatchObject({ originalText: text, lastAppliedText: text, unfinishedText: text })
})
it('downloads paired surrogates and genuine replacement characters as valid UTF-8', async () => {
  const text = '{"pair":"😀","replacement":"�","Count":900719925474099312345}'
  saved = await storage.import('valid.json', text, 'synthetic')
  await open(); await click('Review export'); await wait(() => expect(container.querySelector('[aria-label="Export review"]')).not.toBeNull())
  const { exported } = downloads(); await click('Download mod')
  expect(Array.from(await blobBytes(exported[0].blob))).toEqual(Array.from(new TextEncoder().encode(text)))
  expect(exported[0].filename).toBe('valid.json')
})

it('revokes the newly created URL when its captured profile expires before tracking', async () => {
  const file = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'exact.json', bytes: new TextEncoder().encode(originalText), text: originalText, referenceId: 'synthetic' })
  saved = { ...saved, id: file.id }
  accountDownloadToken(); await open()
  const revoke = vi.fn(), initiate = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => { invalidateProfile(); return 'blob:expired-before-track' }, revokeObjectURL: revoke }))
  await click('Download original')
  expect(initiate).not.toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledWith('blob:expired-before-track')
})

it('reopens clean same-file remote map input and fences obsolete child callbacks', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  const imported = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'map.json', text: newMapProject('synthetic-map', '2026-01-01T00:00:00.000Z'), referenceId: 'synthetic' })
  saved = { ...saved, id: imported.id }
  mapView = true; remoteListeners = new Set()
  await open()
  await wait(() => expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('0'))
  const obsolete = mapChildren.at(-1)!, obsoleteActions = childActions.at(-1)!
  const before = await workspace.repository.readWorkspace()
  const file = before.editorDocuments.find(row => row.id === saved.id)!
  const map = { tool: 'platform', values: { X: '-', Y: '', Z: '0' }, validationAttempted: true }
  const remote = { ...before, editorDocuments: before.editorDocuments.map(row => row.id === file.id ? { ...row, revision: row.revision + 1, unfinished: { ...row.unfinished, fieldState: { tab: 'map', map }, validation: 'invalid' as const } } : row) }
  vi.spyOn(workspace.repository, 'readWorkspace').mockResolvedValue(remote)
  await act(async () => { for (const emit of remoteListeners!) emit() })
  await wait(() => expect(workspace.editorSession.controller.snapshot().revision).toBe(file.revision + 1))
  await wait(() => expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('-'))
  const captured = workspace.editorSession.controller.snapshot()
  expect(captured.dirty).toBe(false)
  await act(async () => {
    obsolete.onInput!('values', { X: '999', Y: '0', Z: '0' })
    obsolete.onGesture!(true)
    obsolete.onDraftChange(true, { save: async () => true, discard: () => {} })
    obsolete.onInspect(0)
    expect(obsolete.onChange('{"obsolete":true}', obsolete.document.text)).toBe(false)
    await obsoleteActions.save(); await obsoleteActions.discard()
  })
  expect(workspace.editorSession.controller.snapshot()).toEqual(captured)
  expect(workspace.editorSession.controller.canTransfer()).toBe(true)
  const current = mapChildren.at(-1)!
  await act(async () => { current.onGesture!(true); obsolete.onGesture!(false) })
  expect(workspace.editorSession.controller.canTransfer()).toBe(false)
  await act(async () => current.onGesture!(false))
  expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('-')
})

it.each([false, true])('defers a remote map read during a real gesture and preserves new dirty input=%s', { timeout: LOCAL_EDITOR_COMMAND_MS }, async dirty => {
  const imported = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'map.json', text: newMapProject('synthetic-map', '2026-01-01T00:00:00.000Z'), referenceId: 'synthetic' })
  saved = { ...saved, id: imported.id }; mapView = true; remoteListeners = new Set()
  await open()
  await wait(() => expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('0'))
  const child = mapChildren.at(-1)!, before = await workspace.repository.readWorkspace(), file = before.editorDocuments.find(row => row.id === saved.id)!
  const remote = { ...before, editorDocuments: before.editorDocuments.map(row => row.id === file.id ? { ...row, revision: row.revision + 1, unfinished: { ...row.unfinished, fieldState: { tab: 'map', map: { values: { X: '42', Y: '', Z: '0' } } } } } : row) }
  let resolveRead!: (state: typeof remote) => void
  const reading = new Promise<typeof remote>(resolve => { resolveRead = resolve })
  const read = vi.spyOn(workspace.repository, 'readWorkspace').mockReturnValue(reading)
  const readContent = editorDocument.readEditorContent
  let contentRead = false
  vi.spyOn(editorDocument, 'readEditorContent').mockImplementation(async (...args) => { const content = await readContent(...args); contentRead = true; return content })
  await act(async () => { for (const emit of remoteListeners!) emit() })
  await wait(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2))
  await act(async () => { child.onGesture!(true); resolveRead(remote) })
  await wait(() => expect(contentRead).toBe(true))
  expect(workspace.editorSession.controller.snapshot().revision).toBe(file.revision)
  expect(workspace.editorSession.controller.canTransfer()).toBe(false)
  if (dirty) await act(async () => child.onInput!('values', { X: 'local', Y: '', Z: '0' }))
  await act(async () => child.onGesture!(false))
  if (dirty) {
    expect(workspace.editorSession.controller.snapshot()).toMatchObject({ revision: file.revision, dirty: true, input: { fieldState: { map: { values: { X: 'local' } } } } })
  } else {
    await wait(() => expect(workspace.editorSession.controller.snapshot().revision).toBe(file.revision + 1))
    expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('42')
  }
})

const selectedMapSource = () => newMapProject('selected-map', '2026-01-01T00:00:00.000Z').replace('"Entities": []', '"Entities": [{"ID":1,"Coord":{"X":10,"Y":20,"Z":30},"BiomeID":1,"EntityType":5,"TreasureData":{"LootType":2,"LootValue":18}}]')
async function openSelectedMap() {
  const imported = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'selected-map.json', text: selectedMapSource(), referenceId: 'synthetic' })
  saved = { ...saved, id: imported.id }; mapView = true
  await open()
  await wait(() => expect([...container.querySelectorAll('.map-editor-placement-list button')].some(button => button.textContent?.includes('Treasure #1'))).toBe(true))
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.map-editor-placement-list button')].find(button => button.textContent?.includes('Treasure #1'))!.click())
}
async function fillMap(key: string, value: string) {
  await act(async () => { const field = container.querySelector<HTMLInputElement>(`[data-editor-focus="${key}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
it('returns focus to the construction height after its saved map owner reopens', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  await openSelectedMap()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Construction plane"]')!.click())
  const field = container.querySelector<HTMLInputElement>('.iso-plane-controls input')!
  await act(async () => {
    field.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '141')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  await wait(() => expect(container.querySelector('.iso-plane-controls input')).not.toBe(field))
  const reopened = container.querySelector<HTMLInputElement>('.iso-plane-controls input')!
  expect(reopened).not.toBeNull()
  expect(reopened.value).toBe('141')
  expect(document.activeElement).toBe(reopened)
  expect((await stored())!.file.unfinished.fieldState).toMatchObject({ map: { camera: { planeHeight: '141' } } })
})
it('keeps orientation keyboard navigation focused after an owned map save reopens', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  await openSelectedMap()
  const navigator = container.querySelector<HTMLElement>('.map-orientation-control')!
  const center = () => container.querySelector('.map-orientation-canvas')?.getAttribute('data-center')
  const [x, z] = center()!.split(',').map(Number)
  await act(async () => navigator.focus())
  await flush()
  await wait(() => expect(container.querySelector('.map-orientation-control')).not.toBe(navigator))
  const reopened = container.querySelector<HTMLElement>('.map-orientation-control')!
  expect(reopened).not.toBeNull()
  expect(document.activeElement).toBe(reopened)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(center()).toBe(`${x! + 8},${z}`)
  expect((await stored())!.content.lastAppliedText).toBe(selectedMapSource())
})
it('retains the map scroll position through an owned quiet-save handoff', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  await openSelectedMap()
  const manifest = await worldMap.loadWorldMap()
  let release!: (value: typeof manifest) => void
  vi.spyOn(worldMap, 'loadWorldMap').mockReturnValue(new Promise(resolve => { release = resolve }))
  const before = workspace.editorSession.controller.snapshot().revision!
  container.querySelector<HTMLElement>('.main-shell')!.scrollTop = 942
  await fillMap('map-coordinate-X', '42')
  forcedView = 'document'
  try {
    await flush()
    expect(workspace.editorSession.controller.snapshot().revision).toBeGreaterThan(before)
    // Browsers clamp scroll while the asynchronously reopened map is shorter than the editing view
    container.querySelector<HTMLElement>('.main-shell')!.scrollTop = 0
    forcedView = undefined
    await act(async () => root.render(<WorkspaceProvider><Owner/></WorkspaceProvider>))
    await wait(() => expect(container.textContent).toContain('Opening bundled map...'))
    await act(async () => { release(manifest) })
    await wait(() => expect(container.querySelector('.iso-canvas')).not.toBeNull())
    expect(container.querySelector<HTMLElement>('.main-shell')!.scrollTop).toBe(942)
    expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe('42')
  } finally { await act(async () => { release(manifest) }) }
})
it.each(['isometric', 'overview'] as const)('keeps an %s gesture started during saved-receipt verification until its release', { timeout: LOCAL_EDITOR_COMMAND_MS }, async kind => {
  await openSelectedMap()
  if (kind === 'overview') await click('World map overview')
  const child = mapChildren.at(-1)!, view = workspace.editorSession.transferView
  const viewport = container.querySelector<HTMLDivElement>('.world-map-viewport')!
  viewport.setPointerCapture = () => {}
  const gesture = (active: boolean) => {
    if (kind === 'isometric') child.onGesture!(active)
    else {
      const event = new MouseEvent(active ? 'pointerdown' : 'pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      viewport.dispatchEvent(event)
    }
  }
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reached = false, returned = false
  const resolve = receipts.resolveOwnedFileReceipt
  vi.spyOn(receipts, 'resolveOwnedFileReceipt').mockImplementation(async receipt => {
    const completion = await resolve(receipt)
    return { ...completion, assertCurrent: async () => {
      await completion.assertCurrent()
      if (!reached) { reached = true; await gate; returned = true }
    } }
  })
  await fillMap('map-coordinate-X', '42')
  let saving: Promise<boolean> | undefined
  try {
    await act(async () => { saving = actions!.save() })
    await wait(() => expect(reached).toBe(true))
    await act(async () => { gesture(true); release() })
    await wait(() => expect(returned).toBe(true))
    expect(workspace.editorSession.phase).toBe('reconciling')
    expect(workspace.editorSession.transferView).toBe(view)
    expect(workspace.editorSession.controller.canTransfer()).toBe(false)
  } finally {
    release()
    await act(async () => { gesture(false); await saving })
  }
  await wait(() => expect(workspace.editorSession.phase).toBe('idle'))
  expect((await stored())!.file.unfinished.fieldState).toMatchObject({ map: { values: { X: '42' } } })
})
it.each(['42', '-'])('quiet persistence keeps selected-entity platform coordinates exactly: X=%s', { timeout: LOCAL_EDITOR_COMMAND_MS }, async x => {
  await openSelectedMap(); await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Voxel platform"]')!.click())
  const revision = workspace.editorSession.controller.snapshot().revision!
  await fillMap('map-coordinate-X', x); await fillMap('map-coordinate-Y', '50'); await fillMap('map-coordinate-Z', '60')
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(true)
  await wait(() => { expect(workspace.editorSession.phase).toBe('idle'); expect(workspace.editorSession.controller.snapshot().revision).toBeGreaterThan(revision) })
  for (const [axis, expected] of Object.entries({ X: x, Y: '50', Z: '60' })) expect(container.querySelector<HTMLInputElement>(`[data-editor-focus="map-coordinate-${axis}"]`)?.value).toBe(expected)
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  const reopened = (await stored())!
  expect(reopened.file.unfinished.fieldState).toMatchObject({ map: { selectedId: 1, tool: 'platform', values: { X: x, Y: '50', Z: '60' } } })
  expect(reopened.content).toMatchObject({ originalText: selectedMapSource(), lastAppliedText: selectedMapSource(), unfinishedText: selectedMapSource() })
})

it.each(['dimensions', 'bounds'])('quiet persistence reopens complete attempted map validation: %s', { timeout: LOCAL_EDITOR_COMMAND_MS }, async failure => {
  await openSelectedMap()
  if (failure === 'dimensions') {
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Voxel platform"]')!.click())
    await fillMap('map-width', '0')
  } else await fillMap('map-coordinate-X', '2147483648')
  const revision = workspace.editorSession.controller.snapshot().revision!
  const error = failure === 'dimensions' ? 'Platform width and depth must be between' : 'Placement coordinates must be signed 32-bit integers.'
  await click(failure === 'dimensions' ? 'Add voxel platform' : 'Move selected placement')
  expect(container.textContent).toContain(error)
  await wait(() => { expect(workspace.editorSession.phase).toBe('idle'); expect(workspace.editorSession.controller.snapshot().revision).toBeGreaterThan(revision) })
  expect(container.textContent).toContain(error)
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  const reopened = (await stored())!
  expect(reopened.file.unfinished.fieldState).toMatchObject({ map: { validationAttempted: true } })
  expect(reopened.content).toMatchObject({ originalText: selectedMapSource(), lastAppliedText: selectedMapSource(), unfinishedText: selectedMapSource() })
})

const recoveryCases = (['import', 'apply', 'remove'] as const).flatMap(operation => (['saved', 'uncertain'] as const).map(outcome => ({ operation, outcome })))
it.each(recoveryCases)('offers exact receipt Retry after $outcome $operation without requiring an active file', { timeout: LOCAL_EDITOR_COMMAND_MS }, async ({ operation, outcome }) => {
  if (operation === 'import') await render()
  else {
    await open()
    if (operation === 'apply') { await click('Edit whole document JSON'); await edit('{"Count":2}'); await flush() }
  }
  const commit = receipts.commitOwnedFile, resolve = receipts.resolveOwnedFileReceipt
  const commands: receipts.OwnedFileCommand[] = []
  let actual: receipts.OwnedFileOutcome | undefined
  const reconciled = vi.fn(async () => actual!)
  vi.spyOn(receipts, 'commitOwnedFile').mockImplementation(async (...args) => {
    const result = await commit(...args)
    if (args[3].operation !== operation) return result
    commands.push(args[3]); actual = result
    return outcome === 'uncertain' ? receipts.reconcilableFileOutcome({ status: 'uncertain', error: new Error('Synthetic acknowledgement lost') }, reconciled) : result
  })
  const resolutions: receipts.OwnedFileReceipt[] = []
  let failRead = true
  vi.spyOn(receipts, 'resolveOwnedFileReceipt').mockImplementation(async receipt => {
    resolutions.push(receipt)
    if (failRead) throw new Error('Synthetic receipt reader unavailable')
    return resolve(receipt)
  })
  if (operation === 'import') {
    const file = new File([], 'recovery-import.json', { type: 'application/json' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('{"Imported":true}').buffer })
    await act(async () => { const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, 'files', { value: [file] }); input.dispatchEvent(new Event('change', { bubbles: true })) })
  } else if (operation === 'apply') await click('Apply JSON edit')
  else { await click('Remove from recent files'); await click('Remove from editor') }
  await wait(() => expect(workspace.editorSession.phase).toBe('recovery'))
  expect(workspace.fileCommandPending()).toBe(true)
  if (operation === 'import') expect(container.querySelector('select')?.value).toBe('')
  const recovery = workspace.editorSession.recovery!
  expect(recovery.outcome.status).toBe(outcome)
  expect(container.textContent).toContain(outcome === 'saved' ? 'Operation saved; reopening pending' : 'Operation outcome needs recovery')
  // Retry stays visible even if the first reconciliation still cannot reopen its exact receipt
  await click('Retry operation')
  await wait(() => expect(workspace.editorSession.phase).toBe('recovery'))
  expect(commands).toHaveLength(1)
  failRead = false
  await click('Retry operation')
  await wait(() => { expect(workspace.fileCommandPending()).toBe(false); expect(workspace.editorSession.phase).toBe('idle') })
  expect(commands).toHaveLength(1)
  expect(resolutions.length).toBeGreaterThanOrEqual(2)
  expect(resolutions.every(receipt => receipt === actual!.receipt)).toBe(true)
  if (outcome === 'uncertain') expect(reconciled).toHaveBeenCalled()
  if (operation === 'import') expect(container.querySelector('.inspector-tree')?.textContent).toContain('Imported')
  else if (operation === 'apply') expect((await stored())!.content).toMatchObject({ originalText, lastAppliedText: '{"Count":2}', unfinishedText: '{"Count":2}' })
  else { expect(container.querySelector('select')?.value).toBe(''); expect((await workspace.repository.readWorkspace()).editorDocuments).toEqual([]) }
})

it('keeps an exact saved removal recoverable when its owner changes before Retry', { timeout: LOCAL_EDITOR_COMMAND_MS }, async () => {
  await open()
  const commit = vi.spyOn(receipts, 'commitOwnedFile')
  const resolve = vi.spyOn(receipts, 'resolveOwnedFileReceipt').mockRejectedValueOnce(new Error('Synthetic receipt read failure'))
  await click('Remove from recent files'); await click('Remove from editor')
  await wait(() => expect(workspace.editorSession.phase).toBe('recovery'))
  const recovery = workspace.editorSession.recovery!
  // A real discard invalidates captured ancestry even though this command already became durable
  await act(async () => { await actions!.discard() })
  await click('Retry operation')
  await wait(() => expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry operation')?.disabled).toBe(false))
  expect(workspace.editorSession.recovery?.ticket).toBe(recovery.ticket)
  expect(workspace.editorSession.recovery?.outcome).toBe(recovery.outcome)
  expect(workspace.fileCommandPending()).toBe(true)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(resolve).toHaveBeenCalledTimes(1)
  expect((await createGuestRepository(db).readWorkspace()).editorDocuments).toEqual([])
})

it.each(['unattempted', 'unattempted-move', 'legacy', 'missing-reference'])('shows explicit validation provenance for restored %s input without making it dirty', { timeout: LOCAL_EDITOR_COMMAND_MS }, async mode => {
  const imported = await createEditorRepository(createGuestRepository(db)).importFile({ filename: 'validation-map.json', text: selectedMapSource(), referenceId: 'synthetic' })
  saved = { ...saved, id: imported.id }; mapView = true
  const repository = createEditorRepository(createGuestRepository(db))
  await repository.saveUnfinished(imported.id, { text: selectedMapSource(), editedPath: [], fieldState: { tab: 'map', map: { tool: mode === 'unattempted-move' ? 'move' : 'platform', selectedId: 1, values: { X: mode === 'unattempted-move' ? '-' : '42', Y: '50', Z: '60' }, dirty: mode === 'unattempted-move', width: '0', validationAttempted: !mode.startsWith('unattempted'), ...(mode === 'missing-reference' ? { validationAction: 'platform' } : {}) } }, validation: 'valid' }, imported.revision)
  if (mode === 'missing-reference') vi.spyOn(await import('../../catalog/world-map'), 'loadWorldMap').mockRejectedValue(new Error('Synthetic unavailable reference'))
  await open()
  if (mode === 'missing-reference') await wait(() => expect(container.querySelector('.map-editor')?.textContent).toContain('Synthetic unavailable reference'))
  else await wait(() => expect(container.querySelector<HTMLInputElement>('[data-editor-focus="map-coordinate-X"]')?.value).toBe(mode === 'unattempted-move' ? '-' : '42'))
  if (mode.startsWith('unattempted')) expect(container.querySelector('.map-editor')?.textContent).not.toContain('Map edit was not applied')
  else expect(container.querySelector('.map-editor')?.textContent).toContain(mode === 'legacy' ? 'no action recorded' : 'reference is unavailable')
  expect(workspace.editorSession.controller.snapshot().dirty).toBe(false)
  expect((await stored())!.content).toMatchObject({ originalText: selectedMapSource(), lastAppliedText: selectedMapSource(), unfinishedText: selectedMapSource() })
})
