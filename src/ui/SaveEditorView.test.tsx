// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import * as bundledLibrary from '../catalog/mod-library'
import * as crystalEdit from '../interchange/crystal-edit'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { inspectSave } from '../domain/save-editor'
import { createModdedSaveEditorFixture, createSaveEditorFixture, createSaveEditorModProjectFixture, setSaveEditorFixtureMode, setSaveEditorFixtureRandomizer } from '../domain/save-editor.fixture'
import { saveEditorModProjectId } from '../domain/save-editor-mods'
import { createSampleLocalData } from '../domain/sample-data'
import { CRYSTAL_SAVE_LIMITS, decodeCrystalSave, encodeCrystalSave } from '../interchange/crystal-save'
import type { DraftActions } from './drafts'
import { downloadBytes } from './model'
import { SaveEditorView } from './SaveEditorView'
import { DefinitionProvider } from './definitions'

vi.mock('./model', () => ({ downloadBytes: vi.fn() }))

let container: HTMLDivElement
let root: Root
let onDraftChange: ReturnType<typeof vi.fn<(dirty: boolean, actions?: DraftActions) => void>>
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const scrollIntoView = vi.fn()
const CHEAT_PASSIVES = BUNDLED_MOD_LIBRARY.find(mod => mod.title === 'Cheat Passives')!
const CHEAT_PASSIVES_FIXTURE = {
  id: saveEditorModProjectId(CHEAT_PASSIVES.id),
  title: CHEAT_PASSIVES.title,
  version: CHEAT_PASSIVES.declaredVersion!,
  steamWorkshopFileId: CHEAT_PASSIVES.steamWorkshopFileId,
  jobId: CHEAT_PASSIVES.models.Jobs[0],
  passiveIds: CHEAT_PASSIVES.models.Passives,
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onDraftChange = vi.fn<(dirty: boolean, actions?: DraftActions) => void>()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  scrollIntoView.mockClear()
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.mocked(downloadBytes).mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
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

async function chooseMods(...selected: File[]) {
  const field = input('Add Crystal Edit mod definitions')
  Object.defineProperty(field, 'files', { configurable: true, value: selected })
  await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })))
}

async function waitForText(value: string) {
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(container.textContent).toContain(value)
  })
}

async function open(bytes = encodeCrystalSave(createSaveEditorFixture())) {
  await act(async () => root.render(<SaveEditorView onDraftChange={onDraftChange}/>))
  await choose(file(bytes))
  return bytes
}

async function openBundledSave(bytes: Uint8Array) {
  const sourceSpy = vi.spyOn(bundledLibrary, 'bundledModEditableSource')
  const previewSpy = vi.spyOn(crystalEdit, 'previewCrystalEdit')
  try {
    await open(bytes)
    // Both stages hash asynchronously after the module import, so await their real work before checking the UI
    await act(async () => {
      expect(sourceSpy).toHaveBeenCalledTimes(1)
      expect(sourceSpy).toHaveBeenCalledWith(CHEAT_PASSIVES)
      expect(sourceSpy.mock.results[0]?.type).toBe('return')
      await sourceSpy.mock.results[0]!.value
      expect(previewSpy).toHaveBeenCalledTimes(1)
      expect(previewSpy.mock.results[0]?.type).toBe('return')
      await previewSpy.mock.results[0]!.value
    })
  } finally {
    previewSpy.mockRestore()
    sourceSpy.mockRestore()
  }
}

function draftActions() {
  return onDraftChange.mock.calls.at(-1)![1]!
}

describe('save editor session', () => {
  it('uses the shared loadout editor and keeps draft review ahead of the inventory', async () => {
    const localData = createSampleLocalData(DEFAULT_CATALOG, '2026-01-01T00:00:00.000Z')
    await act(async () => root.render(<DefinitionProvider catalogs={[DEFAULT_CATALOG]} localData={localData} onSaveDefinition={async () => { throw new Error('Not used') }}><SaveEditorView localData={localData} onDraftChange={onDraftChange}/></DefinitionProvider>))
    await choose(file(encodeCrystalSave(createSaveEditorFixture())))
    expect(container.textContent).toContain('Party & loadouts')
    expect(container.textContent).toContain('Load a compatible Build')
    expect(container.querySelector('[aria-label="Open save details"] button')?.closest('details')).toBeNull()
    expect(container.querySelector('[aria-label="Open save details"] dl')?.closest('details')).toBeNull()
    expect(container.querySelector('.save-editor__review')).toBeNull()
    expect(button('Export edited save').closest('header')).not.toBeNull()
    expect([...container.querySelectorAll('button')].filter(element => element.textContent === 'Export edited save')).toHaveLength(1)
    expect(container.querySelector('nav[aria-label="Save Editor sections"]')?.textContent).toContain('PartyInventoryMoneyUnlocks & presets')
    const review = container.querySelector('[aria-label="Draft and export"]')!
    const inventory = container.querySelector('[aria-label="Inventory editor"]')!
    expect(review.compareDocumentPosition(inventory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => button('Clear Main hand').click())
    expect(button('Review loadout changes').disabled).toBe(false)
    expect(button('Export edited save').disabled).toBe(true)
    await act(async () => button('Review loadout changes').click())
    expect(container.textContent).toContain("Review: Alex's loadout")
    expect(container.textContent).toContain('equipped loadout updated and inventory reconciled')
    await act(async () => button('Apply reviewed changes').click())
    expect(container.querySelector<HTMLDetailsElement>('.save-editor__review')!.open).toBe(true)
    expect(container.querySelector('.save-editor__review')!.textContent).toContain('equipped loadout updated and inventory reconciled')
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array)
    expect(edited.members[0]!.value.Equipment).toMatchObject({ type: 'array' })
    expect(edited.members[0]!.value.Equipment.type === 'array' && edited.members[0]!.value.Equipment.value[0]).toEqual({ type: 'null' })
    expect(inspectSave(edited, SAVE_EDITOR_CATALOG).inventory.find(row => row.kind === 'equipment' && row.id === 0)).toMatchObject({ count: 2, equipped: 3 })
  })

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

  it.each([[1, 'Vanilla'], [2, 'Chaos']] as const)('shows and edits nonrandomized %s mode saves', async (patchMode, name) => {
    await open(encodeCrystalSave(setSaveEditorFixtureMode(createSaveEditorFixture(), patchMode)))
    expect(container.querySelector('[aria-label="Open save details"]')?.textContent).toContain(`Game mode${name}`)
    expect(container.textContent).not.toContain('Read-only save')
    expect(input('Copper').disabled).toBe(false)
    await type('Copper', '456')
    await act(async () => button('Apply currency').click())
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array)
    expect(edited.header).toMatchObject({ patchMode, currencyAmount: 456 })
    expect(inspectSave(edited, SAVE_EDITOR_CATALOG)).toMatchObject({ editable: true, mode: { name } })
  })

  it('shows, edits, and preserves a randomized Chaos save', async () => {
    const save = setSaveEditorFixtureRandomizer(setSaveEditorFixtureMode(createSaveEditorFixture(), 2), { flags: { Equipment: true } })
    const mapping = structuredClone(save.party.value.RandomizerMapping)
    const flags = structuredClone(save.party.value.RandomizerFlags)
    if (mapping?.type !== 'document' || flags?.type !== 'document') throw new Error('Expected synthetic randomizer state')
    await open(encodeCrystalSave(save))
    const details = container.querySelector('[aria-label="Open save details"]')?.textContent
    expect(details).toContain('Game modeChaos')
    expect(details).toContain('RandomizerEnabled')
    expect(details).not.toContain('Stored maps')
    expect(container.textContent).not.toContain('Read-only save')
    await type('Copper', '456')
    await act(async () => button('Apply currency').click())
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array)
    expect(edited.header).toMatchObject({ patchMode: 2, randomizerFlags: 8, currencyAmount: 456 })
    expect(edited.party.value.RandomizerFlags).toMatchObject({ type: 'document', value: flags.value })
    expect(edited.party.value.RandomizerMapping).toMatchObject({ type: 'document', value: mapping.value })
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

  it('previews pending copper without applying it and restores the preview on discard', async () => {
    const bytes = await open()
    const preview = container.querySelector<HTMLOutputElement>('output[aria-label="In-game money preview"]')!
    expect(preview).not.toBeNull()
    expect(input('Copper').id).toBe('save-editor-copper')
    expect(preview.getAttribute('for')).toBe(input('Copper').id)
    expect(preview.textContent).toBe('0 gold · 1 silver · 23 copper')

    await type('Copper', '12345')
    expect(preview.textContent).toBe('1 gold · 23 silver · 45 copper')
    expect(button('Export edited save').disabled).toBe(true)
    expect(container.querySelector('.save-editor__review')).toBeNull()
    expect(container.textContent).toContain('The draft matches the original save.')
    await act(async () => button('Download original').click())
    expect(vi.mocked(downloadBytes).mock.calls[0]).toEqual([bytes, 'original-synthetic.sav'])
    expect(input('Copper').value).toBe('12345')
    expect(button('Export edited save').disabled).toBe(true)

    await act(async () => button('Discard pending input').click())
    expect(input('Copper').value).toBe('123')
    expect(preview.textContent).toBe('0 gold · 1 silver · 23 copper')
    expect(button('Export edited save').disabled).toBe(false)
    expect(onDraftChange.mock.calls.at(-1)![0]).toBe(false)

    await type('Copper', '12345')
    await act(async () => button('Apply currency').click())
    expect(preview.textContent).toBe('1 gold · 23 silver · 45 copper')
    expect(button('Export edited save').disabled).toBe(false)
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[1]![0] as Uint8Array)
    expect(inspectSave(edited, SAVE_EDITOR_CATALOG).currency).toBe(12345)
    expect(edited.header.currencyAmount).toBe(12345)
  })

  it('replaces stale money previews with guidance for invalid pending amounts and accepts the range boundaries', async () => {
    await open()
    const preview = () => container.querySelector<HTMLOutputElement>('output[aria-label="In-game money preview"]')!
    for (const invalid of ['', '-1', '1.5', '1000000000', 'not a number']) {
      await type('Copper', '12345')
      expect(preview().textContent).toBe('1 gold · 23 silver · 45 copper')
      await type('Copper', invalid)
      expect(preview().textContent).toBe('Enter a whole number from 0 to 999,999,999 copper.')
      expect(input('Copper').value).toBe(invalid)
      expect(button('Export edited save').disabled).toBe(true)
      expect(container.querySelector('.save-editor__review')).toBeNull()
    }
    await type('Copper', '0')
    expect(preview().textContent).toBe('0 gold · 0 silver · 0 copper')
    expect(button('Export edited save').disabled).toBe(true)
    await type('Copper', '999999999')
    expect(preview().textContent).toBe('99,999 gold · 99 silver · 99 copper')
    expect(button('Export edited save').disabled).toBe(true)
    expect(vi.mocked(downloadBytes)).not.toHaveBeenCalled()
  })

  it.each([{ path: 'fallback party editor', shared: false }, { path: 'shared party editor', shared: true }])('reveals repeated challenge errors and preserves pending fields through $path', async ({ shared }) => {
    const fixture = createSaveEditorFixture()
    const flags = fixture.party.value.GameplayFlags
    if (flags?.type !== 'document') throw new Error('Expected synthetic gameplay flags')
    flags.value.MaxLevelDown = { type: 'boolean', value: true }
    flags.value.MaxLevelDownVal = { type: 'int32', value: 59 }
    flags.value.NoAssistOptions = { type: 'boolean', value: true }
    const bytes = encodeCrystalSave(fixture)
    const originalFlags = decodeCrystalSave(bytes).party.value.GameplayFlags
    if (shared) {
      const localData = createSampleLocalData(DEFAULT_CATALOG, '2026-01-01T00:00:00.000Z')
      await act(async () => root.render(<DefinitionProvider catalogs={[DEFAULT_CATALOG]} localData={localData} onSaveDefinition={async () => { throw new Error('Not used') }}><SaveEditorView localData={localData} onDraftChange={onDraftChange}/></DefinitionProvider>))
      await choose(file(bytes))
    } else await open(bytes)

    expect(container.textContent).not.toContain('Read-only save')
    if (shared) {
      const hintId = input('Member 1 level').getAttribute('aria-describedby')
      expect(hintId).toBe('save-party-level-hint')
      expect(document.getElementById(hintId!)?.textContent).toBe('Level: 1 to 59')
    } else expect(input('Member 1 level').closest('label')?.querySelector('.field__hint')?.textContent).toBe('1 to 59')
    const applyLabel = shared ? 'Apply name & level' : 'Apply member 1'
    await type('Member 1 name', 'Synthetic challenge hero')
    await type('Member 1 level', '60')
    const levelInput = input('Member 1 level')
    levelInput.focus()
    expect(document.activeElement).toBe(levelInput)
    await act(async () => button(applyLabel).click())
    const alert = container.querySelector('[role="alert"]')!
    const notice = alert.closest<HTMLElement>('[tabindex="-1"]')!
    expect(alert.textContent).toContain("This save's maximum-level challenge limits characters to level 59. Level 60 is not allowed.")
    expect(notice).not.toBeNull()
    expect(document.activeElement).toBe(notice)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenNthCalledWith(1, { block: 'center', inline: 'nearest', behavior: 'instant' })
    expect(scrollIntoView.mock.contexts[0]).toBe(notice)
    expect(input('Member 1 name').value).toBe('Synthetic challenge hero')
    expect(input('Member 1 level').value).toBe('60')
    expect(button('Export edited save').disabled).toBe(true)
    // A rejected compound edit must leave both fields pending and the working save untouched
    expect(container.querySelector('.save-editor__review')).toBeNull()
    expect(container.textContent).toContain('The draft matches the original save.')

    // Retrying an unchanged error must reveal it again after focus returns to the pending field
    levelInput.focus()
    expect(document.activeElement).toBe(levelInput)
    await act(async () => button(applyLabel).click())
    expect(document.activeElement).toBe(notice)
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(scrollIntoView).toHaveBeenNthCalledWith(2, { block: 'center', inline: 'nearest', behavior: 'instant' })
    expect(scrollIntoView.mock.contexts[1]).toBe(notice)
    expect(notice.textContent).toContain("This save's maximum-level challenge limits characters to level 59. Level 60 is not allowed.")
    expect(input('Member 1 name').value).toBe('Synthetic challenge hero')
    expect(input('Member 1 level').value).toBe('60')
    expect(input('Member 1 level')).toBe(levelInput)
    expect(button('Export edited save').disabled).toBe(true)
    await act(async () => button('Download original').click())
    expect(vi.mocked(downloadBytes).mock.calls[0]).toEqual([bytes, 'original-synthetic.sav'])

    await type('Member 1 level', '59')
    await act(async () => button(applyLabel).click())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(input('Member 1 name').value).toBe('Synthetic challenge hero')
    expect(input('Member 1 level').value).toBe('59')
    expect(button('Export edited save').disabled).toBe(false)
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[1]![0] as Uint8Array)
    const summary = inspectSave(edited, SAVE_EDITOR_CATALOG)
    expect(summary).toMatchObject({ editable: true, levelCap: 59 })
    expect(summary.members[0]).toMatchObject({ name: 'Synthetic challenge hero', level: 59 })
    expect(edited.party.value.GameplayFlags).toEqual(originalFlags)
    expect(edited.header).toMatchObject({ challengeFlags: fixture.header.challengeFlags, assistFlags: fixture.header.assistFlags })
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

  it('enables editing after an exact active mod definition is loaded for the tab', async () => {
    await open(encodeCrystalSave(createModdedSaveEditorFixture()))
    expect(container.textContent).toContain('Definition required')
    expect(input('Synthetic Save Mod definition unavailable').checked).toBe(false)
    expect(input('Copper').disabled).toBe(true)
    const bytes = new TextEncoder().encode(JSON.stringify(createSaveEditorModProjectFixture()))
    await chooseMods(file(bytes, 'synthetic-save-mod.json'))
    await waitForText('Imported definition matched')
    expect(input('Synthetic Save Mod definition available').checked).toBe(true)
    expect(container.textContent).toContain('Synthetic mod class')
    expect(input('Copper').disabled).toBe(false)
    await type('Copper', '456')
    await act(async () => button('Apply currency').click())
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array)
    expect(edited.header.currencyAmount).toBe(456)
    expect(edited.header.isModded).toBe(true)
    expect(edited.header.mods).toHaveLength(1)
  })

  it('loads an exact bundled active mod definition without a manual import', async () => {
    await openBundledSave(encodeCrystalSave(createModdedSaveEditorFixture({ mod: CHEAT_PASSIVES_FIXTURE })))
    expect(container.textContent).toContain('Bundled definition matched')
    expect(input('Cheat Passives definition available').checked).toBe(true)
    expect(container.textContent).toContain('Cheat Passives 2.0 (bundled)')
    expect(input('Copper').disabled).toBe(false)
  })

  it('identifies a bundled disabled mod while disclosing that its saved revision is unavailable', async () => {
    await openBundledSave(encodeCrystalSave(createModdedSaveEditorFixture({ active: false, equipped: true, mod: CHEAT_PASSIVES_FIXTURE })))
    expect(container.textContent).toContain('Bundled project identified')
    expect(input('Cheat Passives definition available').checked).toBe(true)
    expect(container.textContent).toContain('Saved revision unavailable')
    expect(input('Copper').disabled).toBe(true)
    await act(async () => button('Review mod-state removal').click())
    const review = container.querySelector('[aria-label="Review bulk changes"]')!
    expect(review.textContent).toContain('ID redirects cleared')
    expect(review.textContent).toContain('equipped mod-only passives removed')
    await act(async () => button('Apply reviewed changes').click())
    expect(input('Copper').disabled).toBe(false)
    await act(async () => button('Export edited save').click())
    const edited = decodeCrystalSave(vi.mocked(downloadBytes).mock.calls[0]![0] as Uint8Array)
    expect(edited.header.isModded).toBe(false)
    expect(edited.header.mods).toEqual([])
    expect(edited.header.modIdMaps).toEqual([])
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
