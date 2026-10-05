// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { inspectSave } from '../domain/save-editor'
import { createSaveEditorFixture } from '../domain/save-editor.fixture'
import { CRYSTAL_SAVE_LIMITS, decodeCrystalSave, encodeCrystalSave } from '../interchange/crystal-save'
import type { DraftActions } from './drafts'
import { downloadBytes } from './model'
import { SaveEditorView } from './SaveEditorView'

vi.mock('./model', () => ({ downloadBytes: vi.fn() }))

let container: HTMLDivElement
let root: Root
let onDraftChange: ReturnType<typeof vi.fn<(dirty: boolean, actions?: DraftActions) => void>>

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onDraftChange = vi.fn<(dirty: boolean, actions?: DraftActions) => void>()
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.mocked(downloadBytes).mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function button(label: string) {
  const result = [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent === label)
  if (!result) throw new Error(`Missing button ${label}`)
  return result
}

function input(label: string) {
  const direct = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  const field = [...container.querySelectorAll('label')].find(element => element.querySelector('.field__label')?.textContent === label)
  const result = direct ?? field?.querySelector<HTMLInputElement>('input')
  if (!result) throw new Error(`Missing input ${label}`)
  return result
}

async function type(label: string, value: string) {
  const field = input(label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function file(bytes: Uint8Array, name = 'synthetic.sav', buffer?: () => Promise<ArrayBuffer>): File {
  return { name, size: bytes.length, arrayBuffer: buffer ?? (() => Promise.resolve(bytes.slice().buffer)) } as File
}

async function choose(selected: File) {
  const field = input('Open Crystal Project save')
  Object.defineProperty(field, 'files', { configurable: true, value: [selected] })
  await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })))
}

async function open(bytes = encodeCrystalSave(createSaveEditorFixture())) {
  await act(async () => root.render(<SaveEditorView onDraftChange={onDraftChange}/>))
  await choose(file(bytes))
  return bytes
}

function draftActions() {
  return onDraftChange.mock.calls.at(-1)![1]!
}

describe('save editor session', () => {
  it.each([0, 3, 12, 20, 27])('opens and exports legacy format %i without inventing a saved date', async version => {
    const fixture = createSaveEditorFixture(version)
    fixture.header.invertedVersion = version === 3
    await open(encodeCrystalSave(fixture))
    expect(container.textContent).not.toContain('Read-only save')
    expect(container.textContent).toContain('Not stored in this format')
    await type('Copper', '777')
    await act(async () => button('Apply currency').click())
    await act(async () => button('Export edited save').click())
    const bytes = vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array
    expect(decodeCrystalSave(bytes).header).toMatchObject({ version, lastUpdated: null, currencyAmount: 777 })
    expect(bytes[0]).toBe(version === 3 ? 252 : version)
  })

  it('exports a no-op save byte exactly and retains the untouched original after editing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-05-06T07:08:09.000Z'))
    const bytes = await open()
    await act(async () => button('Export edited save').click())
    expect(vi.mocked(downloadBytes).mock.calls[0]).toEqual([bytes, 'synthetic-edited.sav'])
    await type('Copper', '321')
    await act(async () => button('Apply currency').click())
    expect(container.textContent).toContain('123 → 321 copper')
    await act(async () => button('Download original').click())
    expect(vi.mocked(downloadBytes).mock.calls[1]).toEqual([bytes, 'original-synthetic.sav'])
    await act(async () => button('Export edited save').click())
    const edited = vi.mocked(downloadBytes).mock.calls[2]![0]
    expect(decodeCrystalSave(edited).header.currencyAmount).toBe(321)
    expect(decodeCrystalSave(edited).header.lastUpdated).toEqual({ year: 2031, month: 5, day: 6, hour: 7, minute: 8, second: 9 })
    expect(decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[1]![0]).header.lastUpdated).toEqual({ year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 })
    expect(container.querySelector('[aria-label="Open save details"]')!.textContent).toContain('2026-01-02 03:04:05')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)
  })

  it('protects pending invalid input from export and navigation save', async () => {
    await open()
    await type('Copper', '1.5')
    expect(button('Export edited save').disabled).toBe(true)
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
    let saved = true
    await act(async () => { saved = await draftActions().save() })
    expect(saved).toBe(false)
    expect(vi.mocked(downloadBytes)).not.toHaveBeenCalled()
    expect(input('Copper').value).toBe('1.5')
    await act(async () => button('Apply currency').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('whole number')
    await type('Copper', '-1')
    await act(async () => button('Apply currency').click())
    expect(input('Copper').value).toBe('-1')
    expect(container.textContent).toContain('The draft matches the original save.')
    await act(async () => button('Discard pending input').click())
    expect(input('Copper').value).toBe('123')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)
  })

  it('keeps a draft and pending form after a malformed or oversized replacement', async () => {
    await open()
    await type('Copper', '987')
    await choose(file(new Uint8Array([28, 0, 0]), 'broken.sav'))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('open draft has not changed')
    expect(input('Copper').value).toBe('987')
    expect(container.textContent).toContain('synthetic.sav')
    const read = vi.fn<() => Promise<ArrayBuffer>>()
    await choose({ name: 'huge.sav', size: CRYSTAL_SAVE_LIMITS.maxFileBytes + 1, arrayBuffer: read } as unknown as File)
    expect(read).not.toHaveBeenCalled()
    expect(input('Copper').value).toBe('987')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
  })

  it('ignores a stale file read after a newer save has opened', async () => {
    await act(async () => root.render(<SaveEditorView onDraftChange={onDraftChange}/>))
    const bytes = encodeCrystalSave(createSaveEditorFixture())
    let complete!: (buffer: ArrayBuffer) => void
    const delayed = new Promise<ArrayBuffer>(resolve => { complete = resolve })
    await choose(file(bytes, 'old.sav', () => delayed))
    await choose(file(bytes, 'new.sav'))
    await act(async () => complete(bytes.slice().buffer))
    expect(container.textContent).toContain('new.sav')
    expect(container.textContent).not.toContain('old.sav')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)
  })

  it('offers unsupported formats unchanged without enabling editing', async () => {
    const bytes = new Uint8Array([29, 0, 0, 1, 2, 3])
    await open(bytes)
    expect(container.textContent).toContain('Read-only save')
    expect(container.textContent).toContain('Save format 29')
    expect(container.querySelector('input[inputmode="numeric"]')).toBeNull()
    await act(async () => button('Download original').click())
    expect(vi.mocked(downloadBytes).mock.calls[0]![0]).toEqual(bytes)
  })

  it('makes modded saves read-only while preserving original download', async () => {
    const fixture = createSaveEditorFixture()
    fixture.header.isModded = true
    await open(encodeCrystalSave(fixture))
    expect(container.textContent).toContain('Read-only save')
    expect(input('Copper').disabled).toBe(true)
    expect(button('Export edited save').disabled).toBe(true)
    expect(button('Download original').disabled).toBe(false)
  })

  it('keeps an unsupported document shape readable without crashing the change review', async () => {
    const fixture = createSaveEditorFixture()
    fixture.party = { type: 'document', value: {} }
    await open(encodeCrystalSave(fixture))
    expect(container.textContent).toContain('Read-only save')
    expect(button('Export edited save').disabled).toBe(true)
    await act(async () => button('Download original').click())
    expect(vi.mocked(downloadBytes)).toHaveBeenCalledTimes(1)
  })

  it('labels unknown class IDs explicitly in a read-only save', async () => {
    const fixture = createSaveEditorFixture()
    fixture.members[0]!.value.Job = { type: 'int32', value: 999 }
    fixture.members[0]!.value.SubJob = { type: 'int32', value: 998 }
    fixture.header.members[0]!.jobId = 999
    await open(encodeCrystalSave(fixture))
    expect(container.textContent).toContain('Read-only save')
    const mainClass = container.querySelector<HTMLSelectElement>('[aria-label="Member 1 class"]')!
    const subClass = container.querySelector<HTMLSelectElement>('[aria-label="Member 1 subclass"]')!
    expect(mainClass.selectedOptions[0]!.textContent).toBe('Unknown class #999')
    expect(subClass.selectedOptions[0]!.textContent).toBe('Unknown class #998')
    expect(mainClass.disabled).toBe(true)
    expect(subClass.disabled).toBe(true)
  })

  it('reviews bulk changes without applying until confirmed and can reset to original', async () => {
    await open()
    await act(async () => button('Review overpowered preset').click())
    expect(container.querySelector('[aria-label="Review bulk changes"]')?.textContent).toContain('999,999,999 copper')
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Review bulk changes"] h2'))
    expect(input('Copper').value).toBe('123')
    expect(input('Copper').disabled).toBe(true)
    await act(async () => button('Cancel review').click())
    expect(input('Copper').value).toBe('123')
    expect(document.activeElement).toBe(button('Review overpowered preset'))
    await act(async () => button('Review overpowered preset').click())
    await act(async () => button('Apply reviewed changes').click())
    expect(document.activeElement).toBe(button('Review overpowered preset'))
    expect(input('Copper').value).toBe('999999999')
    expect(input('Member 1 level').value).toBe('99')
    await act(async () => button('Reset to original').click())
    expect(window.confirm).toHaveBeenCalled()
    expect(input('Member 1 level').value).toBe('5')
    expect(input('Copper').value).toBe('123')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)
  })

  it('can add absent stock through search and rejects a quantity above capacity', async () => {
    const fixture = createSaveEditorFixture()
    const row = inspectSave(fixture, SAVE_EDITOR_CATALOG).inventory.find(entry => entry.kind === 'item' && entry.count === 0 && entry.capacity > 0)!
    await open(encodeCrystalSave(fixture))
    await type('Search inventory', row.name)
    await type(`${row.name} stock`, String(row.capacity + 1))
    await act(async () => button(`Apply ${row.name} stock`).click())
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(input(`${row.name} stock`).value).toBe(String(row.capacity + 1))
    await type(`${row.name} stock`, '1')
    await act(async () => button(`Apply ${row.name} stock`).click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('.save-editor__review')?.textContent).toContain(row.name)
    expect(button('Export edited save').disabled).toBe(false)
  })

  it('edits a name without changing an absent subclass and clears navigation guard synchronously on discard', async () => {
    const fixture = createSaveEditorFixture()
    fixture.members[0]!.value.SubJob = { type: 'null' }
    await open(encodeCrystalSave(fixture))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Member 1 subclass"]')!.value).toBe('')
    await type('Member 1 name', 'New name')
    await act(async () => button('Apply member 1').click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Member 1 subclass"]')!.value).toBe('')
    await act(async () => {
      draftActions().discard()
      expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)
    })
    expect(input('Member 1 name').value).toBe('Alex')
  })

  it('retains a draft when replacement or reset is cancelled', async () => {
    await open()
    await type('Copper', '444')
    await act(async () => button('Apply currency').click())
    vi.mocked(window.confirm).mockReturnValue(false)
    const read = vi.fn<() => Promise<ArrayBuffer>>()
    await choose(file(new Uint8Array([27]), 'other.sav', read))
    expect(read).not.toHaveBeenCalled()
    await act(async () => button('Reset to original').click())
    expect(input('Copper').value).toBe('444')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
  })

  it('retains dirty state and draft when a download cannot be started', async () => {
    await open()
    await type('Copper', '444')
    await act(async () => button('Apply currency').click())
    vi.mocked(downloadBytes).mockImplementationOnce(() => { throw new Error('Synthetic browser download failure') })
    let exported = true
    await act(async () => { exported = await draftActions().save() })
    expect(exported).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Export failed')
    expect(input('Copper').value).toBe('444')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
  })

  it('keeps pending input and allows retry when the original download fails', async () => {
    const bytes = await open()
    await type('Copper', '444')
    vi.mocked(downloadBytes).mockImplementationOnce(() => { throw new Error('Synthetic browser download failure') })
    await act(async () => button('Download original').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Original download failed')
    expect(input('Copper').value).toBe('444')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
    await act(async () => button('Download original').click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(vi.mocked(downloadBytes).mock.calls.at(-1)).toEqual([bytes, 'original-synthetic.sav'])
    expect(input('Copper').value).toBe('444')
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(true)
  })
})
