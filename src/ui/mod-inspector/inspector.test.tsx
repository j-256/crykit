import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InspectorDraft } from '../../mod-inspector/types'
import { summarizeInspectorDraft } from '../../mod-inspector/storage'
import type { DraftActions } from '../drafts'
import { ModInspectorView } from '../ModInspectorView'

const storage = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), import: vi.fn(), save: vi.fn(), remove: vi.fn() }))
vi.mock('../../mod-inspector/storage', async importOriginal => ({ ...await importOriginal<typeof import('../../mod-inspector/storage')>(), getInspectorStorage: () => storage }))
const originalText = '{"Count":1,"Values":[1]}'
const saved: InspectorDraft = { schemaVersion: 1, id: 'synthetic', filename: 'synthetic.json', originalText, draftText: originalText, referenceId: 'synthetic', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: (PropertyDescriptor | undefined)[]

beforeEach(() => {
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

async function open(onDraftChange?: (dirty: boolean, actions?: DraftActions) => void) {
  await act(async () => root.render(<ModInspectorView onDraftChange={onDraftChange}/>))
  const select = container.querySelector('select')!
  await act(async () => { select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
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
async function edit(value: string) {
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('inspector exact edits and navigation', () => {
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
    expect(reference.textContent).toContain('different version of CryKit\'s reference data')
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
    await act(async () => root.render(<ModInspectorView/>))
    const select = container.querySelector('select')!
    const firstOption = select.querySelector<HTMLOptionElement>(`option[value="${saved.id}"]`)!
    const secondOption = select.querySelector<HTMLOptionElement>(`option[value="${second.id}"]`)!
    expect(firstOption.textContent).toContain(saved.filename)
    expect(secondOption.textContent).toContain(saved.filename)
    expect(firstOption.textContent).not.toBe(secondOption.textContent)
    expect(storage.get).not.toHaveBeenCalled()
    storage.get.mockResolvedValueOnce(second)
    await act(async () => { select.value = second.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(storage.get).toHaveBeenCalledWith(second.id)
    expect(select.value).toBe(second.id)
  })
  it('searches exact enum codes and names without matching shared provenance', async () => {
    await act(async () => root.render(<ModInspectorView/>))
    await click('Enum dictionary')
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
    await act(async () => root.render(<ModInspectorView/>))
    expect(storage.get).not.toHaveBeenCalled()
    const select = container.querySelector('select')!
    await act(async () => { select.value = saved.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(storage.get).toHaveBeenCalledWith(saved.id)
    expect(select.disabled).toBe(true)
    expect(container.textContent).toContain('Opening saved mod JSON')
    await act(async () => complete(saved))
    expect(select.disabled).toBe(false)
    expect(select.value).toBe(saved.id)
    expect(container.querySelector('.inspector-tree')).not.toBeNull()
  })

  it('reports missing rows and failed selection loads without opening a document', async () => {
    storage.get.mockResolvedValueOnce(undefined)
    await open()
    expect(container.textContent).toContain('removed in another tab')
    expect(container.querySelector('select')?.value).toBe('')
    expect(container.querySelector(`option[value="${saved.id}"]`)).toBeNull()
    await act(async () => root.unmount())
    root = createRoot(container)
    storage.get.mockRejectedValueOnce(new Error('Synthetic storage unavailable'))
    await open()
    expect(container.textContent).toContain('Draft could not be opened: Synthetic storage unavailable')
    expect(container.querySelector('select')?.disabled).toBe(false)
    expect(container.querySelector('.inspector-tree')).toBeNull()
  })

  it('locks editing while another saved draft is loading', async () => {
    const second = { ...saved, id: 'synthetic-second', filename: 'second.json' }
    storage.list.mockResolvedValue([summarizeInspectorDraft(saved), summarizeInspectorDraft(second)])
    await open()
    let complete: (row: InspectorDraft) => void = () => undefined
    storage.get.mockImplementationOnce(() => new Promise<InspectorDraft>(resolve => { complete = resolve }))
    await selectField('Count')
    const select = container.querySelector('select')!
    await act(async () => { select.value = second.id; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await edit('234')
    await click('Apply JSON edit')
    await act(async () => complete(second))
    expect(select.value).toBe(second.id)
    expect(storage.save).not.toHaveBeenCalled()
    expect(container.querySelector('fieldset')?.disabled).toBe(false)
  })

  it('locks edits while imported bytes are pending and opens the imported draft safely', async () => {
    await open()
    await selectField('Count')
    let complete: (bytes: ArrayBuffer) => void = () => undefined
    const importedText = '{"Count":9}'
    const file = { name: 'imported.json', size: importedText.length, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { complete = resolve }) }
    const imported = { ...saved, id: 'imported', filename: file.name, originalText: importedText, draftText: importedText }
    storage.import.mockResolvedValueOnce(imported)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    await act(async () => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(container.textContent).toContain('Importing and validating mod JSON')
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await edit('234')
    await click('Apply JSON edit')
    await act(async () => complete(new TextEncoder().encode(importedText).buffer))
    expect(storage.save).not.toHaveBeenCalled()
    expect(container.querySelector('select')?.value).toBe(imported.id)
  })

  it('retains the selected draft when removal fails after attempted concurrent editing', async () => {
    await open()
    await selectField('Count')
    let reject: (error: Error) => void = () => undefined
    storage.remove.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    await click('Remove from recent files')
    await click('Remove original and draft')
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    await edit('234')
    await click('Apply JSON edit')
    await act(async () => reject(new Error('Synthetic remove failure')))
    expect(container.querySelector('textarea')?.value).toBe('1')
    expect(container.querySelector('select')?.value).toBe(saved.id)
    expect(container.textContent).toContain('Synthetic remove failure')
    expect(storage.save).not.toHaveBeenCalled()
  })

  it('locks failed-draft recovery until the saved version arrives', async () => {
    await open()
    await selectField('Count')
    storage.save.mockRejectedValueOnce(new Error('Synthetic save failure'))
    await edit('2')
    await click('Apply JSON edit')
    let complete: (row: InspectorDraft) => void = () => undefined
    storage.get.mockImplementationOnce(() => new Promise<InspectorDraft>(resolve => { complete = resolve }))
    await click('Reopen saved version')
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    expect(container.querySelector('select')?.disabled).toBe(true)
    await edit('234')
    await click('Apply JSON edit')
    await act(async () => complete(saved))
    expect(storage.save).toHaveBeenCalledTimes(1)
    expect(container.querySelector('select')?.value).toBe(saved.id)
    expect(container.textContent).not.toContain('Synthetic save failure')
    expect(container.querySelector('fieldset')?.disabled).toBe(false)
  })

  it('saves a corrected pending edit on the first navigation retry after a storage failure', async () => {
    let actions: DraftActions | undefined
    await open((dirty, value) => { if (dirty) actions = value })
    await selectField('Count')
    storage.save.mockRejectedValueOnce(new Error('Synthetic save failure'))
    await edit('2')
    await click('Apply JSON edit')
    expect(storage.save).toHaveBeenCalledTimes(1)
    await edit('invalid JSON')
    await act(async () => { expect(await actions!.save()).toBe(false) })
    expect(storage.save).toHaveBeenCalledTimes(1)
    expect(container.querySelector('textarea')?.value).toBe('invalid JSON')
    await edit('3')
    await act(async () => { expect(await actions!.save()).toBe(true) })
    expect(storage.save).toHaveBeenCalledTimes(2)
    expect(storage.save).toHaveBeenLastCalledWith(saved.id, '{"Count":3,"Values":[1]}', 1)
    expect(container.textContent).toContain('Saved in this browser')
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
  it('applies scalar and array replacements while retaining the original', async () => {
    await open()
    await selectField('Count')
    await edit('900719925474099312345')
    await click('Apply JSON edit')
    expect(storage.save).toHaveBeenLastCalledWith(saved.id, '{"Count":900719925474099312345,"Values":[1]}', 1)
    await selectField('Values')
    await edit('[2,3]')
    await click('Apply JSON edit')
    expect(storage.save).toHaveBeenLastCalledWith(saved.id, '{"Count":900719925474099312345,"Values":[2,3]}', 2)
    expect(saved.originalText).toBe(originalText)
  })
  it('registered navigation actions save the latest keystrokes and retain invalid edits', async () => {
    let actions: DraftActions | undefined
    await open((dirty, value) => { if (dirty) actions = value })
    await selectField('Count')
    await edit('2')
    const registered = actions!
    await edit('234')
    await act(async () => { expect(await registered.save()).toBe(true) })
    expect(storage.save).toHaveBeenLastCalledWith(saved.id, '{"Count":234,"Values":[1]}', 1)
    await edit('invalid JSON')
    await act(async () => { expect(await registered.save()).toBe(false) })
    expect(container.querySelector('textarea')?.value).toBe('invalid JSON')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(storage.save).toHaveBeenCalledTimes(1)
  })
  it('removes a browser draft only after inline confirmation and retains it on failure', async () => {
    await open()
    await click('Remove from recent files')
    expect(storage.remove).not.toHaveBeenCalled()
    await click('Keep saved draft')
    expect(storage.remove).not.toHaveBeenCalled()
    storage.remove.mockRejectedValueOnce(new Error('Draft revision conflict'))
    await click('Remove from recent files')
    await click('Remove original and draft')
    expect(container.querySelector('select')?.value).toBe(saved.id)
    expect(container.textContent).toContain('Draft revision conflict')
    await click('Remove original and draft')
    expect(storage.remove).toHaveBeenLastCalledWith(saved.id, saved.revision)
    expect(container.querySelector('select')?.value).toBe('')
    expect(container.textContent).toContain('Exact enum names')
  })
  it('waits for an in-flight save and restores the persisted draft before discard navigation', async () => {
    let complete: (row: InspectorDraft) => void = () => undefined
    storage.save.mockImplementationOnce(() => new Promise<InspectorDraft>(resolve => { complete = resolve }))
    let actions: DraftActions | undefined
    const onDraftChange = vi.fn((dirty: boolean, value?: DraftActions) => { if (dirty) actions = value })
    await open(onDraftChange)
    await selectField('Count')
    await edit('2')
    await click('Apply JSON edit')
    await act(async () => {
      const discarded = actions!.discard()
      expect(onDraftChange.mock.lastCall?.[0]).toBe(true)
      complete({ ...saved, draftText: '{"Count":2,"Values":[1]}', revision: 2 })
      expect(await discarded).toBe(true)
    })
    expect(storage.save).toHaveBeenLastCalledWith(saved.id, originalText, 2)
    expect(onDraftChange.mock.lastCall?.[0]).toBe(false)
  })
  it('keeps navigation blocked when an in-flight discard rollback fails', async () => {
    let complete: (row: InspectorDraft) => void = () => undefined
    storage.save.mockImplementationOnce(() => new Promise<InspectorDraft>(resolve => { complete = resolve }))
    storage.save.mockRejectedValueOnce(new Error('Rollback storage failure'))
    let actions: DraftActions | undefined
    const onDraftChange = vi.fn((dirty: boolean, value?: DraftActions) => { if (dirty) actions = value })
    await open(onDraftChange)
    await selectField('Count')
    await edit('2')
    await click('Apply JSON edit')
    await act(async () => {
      const discarded = actions!.discard()
      complete({ ...saved, draftText: '{"Count":2,"Values":[1]}', revision: 2 })
      expect(await discarded).toBe(false)
    })
    expect(onDraftChange.mock.lastCall?.[0]).toBe(true)
    expect(container.textContent).toContain('Rollback storage failure')
    expect(container.textContent).toContain('Draft is not saved')
  })
})
