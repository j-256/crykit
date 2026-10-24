import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InspectorDraft } from '../../mod-inspector/types'
import { INSPECTOR_REFERENCE_ID } from '../../mod-inspector/reference'
import { InspectorStorage, summarizeInspectorDraft } from '../../mod-inspector/storage'
import type { DraftActions } from '../drafts'
import { ModInspectorView as CapturedModInspectorView } from '../ModInspectorView'
import { WorkspaceProvider } from '../WorkspaceProvider'
const ModInspectorView = (props: Parameters<typeof CapturedModInspectorView>[0]) => <WorkspaceProvider><CapturedModInspectorView {...props}/></WorkspaceProvider>

const { FixtureTextEncoder } = vi.hoisted(() => {
  // jsdom's Node encoder returns foreign arrays rejected by the actual crypto wrapper
  class FixtureTextEncoder extends TextEncoder {
    override encode(value?: string): Uint8Array<ArrayBuffer> { return new Uint8Array(super.encode(value)) }
  }
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  return { FixtureTextEncoder }
})

vi.mock('../../workspace/device-selection', () => ({ readDeviceSelection: async () => ({ key: 'selected', version: 1, kind: 'guest' }) }))
const storage = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), import: vi.fn(), save: vi.fn(), remove: vi.fn() }))
// These presentation cases control legacy summary/body arrival while keeping the real native Editor lifecycle
vi.mock('../../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: import('../../persistence/database').CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})
const originalText = '{"Count":1,"Values":[1]}'
const saved: InspectorDraft = { schemaVersion: 1, id: 'synthetic', filename: 'synthetic.json', originalText, draftText: originalText, referenceId: 'synthetic', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: (PropertyDescriptor | undefined)[]

beforeEach(() => {
  vi.stubGlobal('TextEncoder', FixtureTextEncoder)
  const nativeClone = structuredClone
  // Preserve the native clone while rehoming Node IndexedDB fixture bytes into the schema's realm
  const rehome = (value: unknown): unknown => ArrayBuffer.isView(value) ? new Uint8Array(Array.from(value as Uint8Array)) : Object.prototype.toString.call(value) === '[object ArrayBuffer]' ? new Uint8Array(Array.from(new Uint8Array(value as ArrayBuffer))).buffer : Array.isArray(value) ? value.map(rehome) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rehome(child)])) : value
  vi.stubGlobal('structuredClone', (value: unknown) => rehome(nativeClone(value)))
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const open = new WeakSet<HTMLElement>()
  originalMethods = prototypeMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) { open.add(this) } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { open.delete(this) } },
    scrollIntoView: { configurable: true, value: vi.fn() },
  })
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? open.has(this) : matches.call(this, selector) })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(performance.now()); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  storage.list.mockResolvedValue([summarizeInspectorDraft(saved)])
  storage.get.mockResolvedValue(saved)
  vi.spyOn(InspectorStorage.prototype, 'list').mockImplementation(() => storage.list())
  vi.spyOn(InspectorStorage.prototype, 'get').mockImplementation(id => storage.get(id))
  storage.remove.mockResolvedValue(undefined)
  storage.save.mockImplementation(async (_id: string, draftText: string, revision: number) => ({ ...saved, draftText, revision: revision + 1 }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [index, name] of prototypeMethods.entries()) {
    const descriptor = originalMethods[index]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

async function renderInspector(onDraftChange?: (dirty: boolean, actions?: DraftActions) => void) {
  await act(async () => root.render(<ModInspectorView onDraftChange={onDraftChange}/>))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector(`option[value="${saved.id}"]`), container.querySelector('[role="alert"]')?.textContent ?? '').not.toBeNull()
  })
}
async function open(onDraftChange?: (dirty: boolean, actions?: DraftActions) => void, expectDocument = true) {
  await renderInspector(onDraftChange)
  const select = container.querySelector('select')!
  await act(async () => { select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  if (expectDocument) await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); expect(container.querySelector('textarea'), container.textContent ?? '').not.toBeNull() })
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === text)!
  expect(button, text).toBeDefined()
  await act(async () => button.click())
}
async function selectField(name: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.inspector-node-button')].find(button => button.querySelector('strong')?.textContent === name)!
  await act(async () => button.click())
}
describe('inspector exact edits and navigation', () => {
  it('keeps matched native lookup labels quiet without changing imported JSON', async () => {
    const text = '{"EditorVersion":34,"Count":1}'
    const row = { ...saved, originalText: text, draftText: text, referenceId: INSPECTOR_REFERENCE_ID }
    storage.get.mockResolvedValue(row)
    await renderInspector()
    expect(container.textContent).toContain('Exact enum names')
    expect(container.querySelector('button[aria-label="Sources for enum names"]')).toBeNull()
    await open()
    expect(container.textContent).toContain('JSON explorer')
    expect(container.querySelector<HTMLDetailsElement>('.inspector-format')!.open).toBe(false)
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Review export')?.classList.contains('button--primary')).toBe(true)
    expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Download original text')?.classList.contains('button--quiet')).toBe(true)
    expect(container.querySelector('button[aria-label="Sources for inspector labels"]')).toBeNull()
    await selectField('Count')
    expect(container.querySelector('textarea')?.value).toBe('1')
    expect(storage.save).not.toHaveBeenCalled()
    expect(row).toMatchObject({ originalText: text, draftText: text, referenceId: INSPECTOR_REFERENCE_ID, revision: saved.revision })
  })

  it('keeps changed lookup history separate from the mod format without rewriting the saved copy', async () => {
    const text = '{"EditorVersion":34,"Title":"Synthetic mod"}'
    const row = { ...saved, originalText: text, draftText: text, referenceId: 'synthetic-earlier-lookup' }
    storage.get.mockResolvedValue(row)
    await open()
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Sources for inspector labels"]')!
    const format = container.querySelector<HTMLDetailsElement>('.inspector-format')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => trigger.click())
    const reference = container.querySelector('[role="dialog"][aria-label="Sources for inspector labels"]')!
    expect(reference.textContent).toContain("different CryKit reference data")
    expect(format.open).toBe(false)
    expect(format.querySelector('summary')?.textContent).toBe('Editor format: Crystal Edit format 34')
    expect([...container.querySelectorAll('[role="status"], [role="alert"]')].map(element => element.textContent)).toEqual(['Saved in this browser'])
    await act(async () => reference.querySelector<HTMLButtonElement>('button[aria-label="Close sources"]')!.click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(storage.save).not.toHaveBeenCalled()
    expect(row).toMatchObject({ originalText: text, draftText: text, referenceId: 'synthetic-earlier-lookup', revision: saved.revision })
  })
  it('expands and collapses whole branches while keeping siblings and original JSON intact', async () => {
    const document = '{"Left":{"Nested":{"Value":1}},"Right":{"Nested":{"Value":2}}}'
    storage.get.mockResolvedValue({ ...saved, originalText: document, draftText: document })
    await open()
    await selectField('Left')
    await click('Expand branch')
    expect(container.querySelector('button[aria-label="Collapse $.Left.Nested"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Expand $.Right"]')).not.toBeNull()
    await click('Collapse branch')
    expect(container.querySelector('button[aria-label="Expand $.Left"]')).not.toBeNull()
    const left = container.querySelector<HTMLButtonElement>('button[aria-label="Expand $.Left"]')!
    await act(async () => left.click())
    expect(container.querySelector('button[aria-label="Expand $.Left.Nested"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Collapse $.Left.Nested"]')).toBeNull()
    const nested = container.querySelector<HTMLButtonElement>('button[aria-label="Expand $.Left.Nested"]')!
    await act(async () => nested.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })))
    expect(container.querySelector('button[aria-label="Select $.Left.Nested.Value"]')).not.toBeNull()
    expect(storage.save).not.toHaveBeenCalled()
    await selectField('Value')
    expect(container.querySelector('.inspector-branch-actions')?.textContent).toContain('$.Left.Nested')
    await click('Collapse branch')
    expect(container.querySelector('button[aria-label="Select $.Left.Nested.Value"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Expand $.Right"]')).not.toBeNull()
  })
  it('distinguishes duplicate filenames from metadata without loading document text', async () => {
    const second = { ...saved, id: 'synthetic-second', createdAt: '2026-02-02' }
    storage.list.mockResolvedValue([summarizeInspectorDraft(saved), summarizeInspectorDraft(second)])
    await renderInspector()
    const select = container.querySelector('select')!
    const firstOption = select.querySelector<HTMLOptionElement>(`option[value="${saved.id}"]`)!
    const secondOption = select.querySelector<HTMLOptionElement>(`option[value="${second.id}"]`)!
    expect(firstOption.textContent).toContain(saved.filename)
    expect(secondOption.textContent).toContain(saved.filename)
    expect(firstOption.textContent).not.toBe(secondOption.textContent)
    expect(storage.get).not.toHaveBeenCalled()
    storage.get.mockResolvedValueOnce(second)
    await act(async () => { select.value = second.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalledWith(second.id))
    await vi.waitFor(() => expect(select.value).toBe(second.id))
  })
  it('searches exact enum codes and names without matching shared provenance', async () => {
    await renderInspector()
    await click('Enum Dictionary')
    const search = container.querySelector<HTMLInputElement>('.inspector-dictionary input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '34')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('.inspector-enum-groups')?.textContent).not.toContain('RevealStatsAuto')
    expect([...container.querySelectorAll('.inspector-enum-groups dt code')].some(code => code.textContent === '34')).toBe(true)
    expect(container.querySelector('.inspector-enum-groups')?.textContent).toContain('OneEnemyAPPercent')
  })
  it('loads full text only on selection and blocks switching until the selected row arrives', async () => {
    let complete: (row: InspectorDraft) => void = () => undefined
    storage.get.mockImplementationOnce(() => new Promise<InspectorDraft>(resolve => { complete = resolve }))
    await renderInspector()
    expect(storage.get).not.toHaveBeenCalled()
    const select = container.querySelector('select')!
    await act(async () => { select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalledWith(saved.id))
    expect(select.disabled).toBe(true)
    expect(container.textContent).toContain('Opening saved mod JSON')
    await act(async () => complete(saved))
    await vi.waitFor(() => expect(select.disabled).toBe(false))
    expect(select.value).toBe(saved.id)
    expect(container.querySelector('.inspector-tree')).not.toBeNull()
  })

  it('reports missing rows and failed selection loads without opening a document', async () => {
    storage.get.mockResolvedValueOnce(undefined)
    await open(undefined, false)
    await vi.waitFor(() => expect(container.textContent).toContain('removed in another tab'))
    expect(container.querySelector('select')?.value).toBe('')
    expect(container.querySelector(`option[value="${saved.id}"]`)).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    storage.get.mockRejectedValueOnce(new Error('Synthetic storage unavailable'))
    await open(undefined, false)
    await vi.waitFor(() => expect(container.textContent).toContain('Draft could not be opened: Synthetic storage unavailable'))
    expect(container.querySelector('select')?.disabled).toBe(false)
    expect(container.querySelector('.inspector-tree')).toBeNull()
  })

  it('reveals named record targets beyond the first child page when selecting a search match', async () => {
    const records = Array.from({ length: 100 }, (_, index) => ({ ID: index, Name: index === 90 ? 'Target record' : `Synthetic ${index}` }))
    const document = JSON.stringify({ Items: records })
    storage.get.mockResolvedValue({ ...saved, originalText: document, draftText: document })
    await open()
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Target record')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
    const result = [...container.querySelectorAll<HTMLButtonElement>('.inspector-search-result')].find(button => button.querySelector('code')?.textContent === '$.Items[90].Name')!
    expect(result).toBeDefined()
    await act(async () => result.click())
    expect(search.value).toBe('')
    const record = [...container.querySelectorAll('.inspector-node-button')].find(button => button.getAttribute('aria-label') === 'Select $.Items[90]: Target record, ID 90')
    expect(record).toBeDefined()
    expect(container.querySelector('.inspector-tree-row.is-selected')?.textContent).toContain('Target record')
    expect(container.querySelector('textarea')?.value).toBe('"Target record"')
  })
})
