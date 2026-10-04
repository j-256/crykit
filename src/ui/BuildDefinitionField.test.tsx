// @vitest-environment jsdom
import { act, useState, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain'
import { entityDefinitionKey } from '../domain/core'
import { TEST_NOW } from '../domain/test-helpers'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { buildEquipmentPermissions } from '../domain/build-mechanics'
import { CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import type { EntityRef, PersonalDefinition, PersonalDefinitionId } from '../domain/types'
import { DefinitionLibraryContext, type DefinitionOption } from './definitions'
import { BuildDefinitionField } from './BuildDefinitionField'

vi.mock('./Dropdown', () => ({ Dropdown: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null }))
vi.mock('./GameIcon', () => ({ DefinitionArtwork: () => null, FieldIconSources: () => null, GameIcon: () => null }))

function passive(name: string, pp: number, requiredMod?: string): DefinitionOption {
  const record: PersonalDefinition = { id: name as PersonalDefinitionId, kind: 'passive', name, aliases: [], revision: 1, createdAt: TEST_NOW, updatedAt: TEST_NOW, fields: { Description: { state: 'known', value: `${name} effect summary` }, ...(requiredMod ? { 'Source mod': { state: 'known' as const, value: requiredMod } } : {}) }, sources: [], ppCost: { state: 'known', value: pp } }
  const ref: EntityRef = { kind: 'personal', definitionId: record.id }
  return { key: entityDefinitionKey(ref), ref, kind: record.kind, name, aliases: [], record, ppCost: record.ppCost, sourceLabel: 'Synthetic source', stockLabel: 'Unknown', preferred: true }
}
const first = passive('First passive', 2)
const second = passive('Second passive', 7)
const unavailable = passive('Unconfirmed mod passive', 3, 'Synthetic mod')
const options = [first, second, unavailable]
const localData = { ...createBlankLocalData(), personalDefinitions: Object.fromEntries(options.map(option => [option.record.id, option.record])) as Record<string, PersonalDefinition> }
const library = { localData, catalogs: [], options, planningOptions: options, availableOptions: options, availablePlanningOptions: options, onSaveDefinition: async () => first.ref }
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(overrides: Partial<Parameters<typeof BuildDefinitionField>[0]> = {}, choiceOptions = options) {
  const props = { allowedKinds: ['passive'] as const, label: 'Equipped passive 1', value: null, open: true, query: '', resultLimit: 100, onOpen: vi.fn(), onClose: vi.fn(), onDismiss: vi.fn(), onQueryChange: vi.fn(), onResultLimitChange: vi.fn(), onChange: vi.fn(), onInspect: vi.fn(), ...overrides }
  const providedLibrary = { ...library, options: choiceOptions, planningOptions: choiceOptions, availableOptions: choiceOptions, availablePlanningOptions: choiceOptions, localData: { ...localData, personalDefinitions: Object.fromEntries(choiceOptions.map(option => [option.record.id, option.record])) as Record<string, PersonalDefinition> } }
  await act(async () => root.render(<DefinitionLibraryContext.Provider value={providedLibrary}><BuildDefinitionField {...props}/></DefinitionLibraryContext.Provider>))
  return props
}
const results = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].filter(button => button.id)
function checkbox(label: string) {
  return [...container.querySelectorAll('label')].find(element => element.textContent?.includes(label))!.querySelector<HTMLInputElement>('input')!
}

describe('Build picker interaction', () => {
  it('keeps advanced controls collapsed and selects a sole search result with Enter', async () => {
    const props = await render({ query: first.name })
    expect(container.querySelector('details.build-picker-filters')?.hasAttribute('open')).toBe(false)
    expect(container.textContent).toContain('1 result · Enter to select')
    await act(async () => container.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(props.onChange).toHaveBeenCalledWith(first.ref)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('does not choose an ambiguous result until keyboard or pointer navigation selects it', async () => {
    const props = await render()
    await act(async () => container.querySelector('[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('explains hidden off-hand prerequisites and reveals conflicts without changing the build', async () => {
    const job = passive('Synthetic class', 0)
    const dagger = passive('Synthetic dagger', 0)
    const classOption: DefinitionOption = { ...job, kind: 'class', record: { ...job.record, kind: 'class', fields: { [CRYSTAL_EDIT_FIELDS.equipment]: { state: 'known', value: ['Dagger'] }, 'Innate passive(s)': { state: 'known', value: 'Max HP +20%' } } } }
    const daggerOption: DefinitionOption = { ...dagger, kind: 'item', record: { ...dagger.record, kind: 'item', fields: { Category: { state: 'known', value: ['Daggers'] }, Hands: { state: 'known', value: 1 } } } }
    const choiceOptions = [classOption, daggerOption]
    const resolve = (ref: EntityRef) => choiceOptions.find(option => entityDefinitionKey(ref) === option.key)?.record
    const buildContent = { primaryClass: classOption.ref, secondaryClass: null, equipment: { 'plan-main-hand': { ref: daggerOption.ref } }, passives: [], contextAssumptions: [] }
    const props = await render({ allowedKinds: ['item'], label: 'Off hand', query: 'dagger', buildContent, equipmentPermissions: buildEquipmentPermissions(buildContent, resolve), equipmentSlot: SUGGESTED_BUILD_SLOTS.find(slot => slot.equipmentRole === 'offHand')!, equipmentSlots: SUGGESTED_BUILD_SLOTS }, choiceOptions)
    expect(results()).toHaveLength(0)
    expect(container.textContent).toContain('1 matching choice is hidden by equipment conflicts')
    expect(container.textContent).toContain('requires Dual Wield')
    expect(container.textContent).toContain('Choose a class that grants Dual Wield')
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Show 1 conflict')!.click())
    expect(results()).toHaveLength(1)
    expect(results()[0]!.getAttribute('data-permission-state')).toBe('invalid')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('shows effect summaries before selection and provides identical pointer and keyboard previews', async () => {
    const props = await render()
    expect(results().map(result => result.textContent)).toEqual([expect.stringContaining('First passive effect summary'), expect.stringContaining('Second passive effect summary')])
    await act(async () => results()[1]!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    expect(props.onInspect).toHaveBeenLastCalledWith(expect.objectContaining({ key: second.key }))
    await act(async () => container.querySelector('input[role="combobox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(props.onInspect).toHaveBeenLastCalledWith(expect.objectContaining({ key: first.key }))
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('requires explicit expansion for unconfirmed mods and preserves an existing unavailable choice', async () => {
    await render()
    expect(results().some(result => result.textContent?.includes(unavailable.name))).toBe(false)
    await act(async () => checkbox('Include disabled or unconfirmed mods').click())
    expect(results().some(result => result.textContent?.includes(unavailable.name))).toBe(true)
    await act(async () => checkbox('Include disabled or unconfirmed mods').click())
    await render({ value: unavailable.ref })
    expect(results().some(result => result.textContent?.includes(unavailable.name))).toBe(true)
    expect(container.textContent).toContain('This existing selection is retained')
  })

  it('filters by the remaining replacement budget without changing the build', async () => {
    const props = await render({ passiveIndex: 1, buildContent: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [{ ref: second.ref }], contextAssumptions: [] } })
    expect(container.textContent).toContain('3 PP for this selection')
    await act(async () => checkbox('Within remaining PP').click())
    expect(results().map(result => result.textContent)).toEqual([expect.stringContaining(first.name)])
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('returns focus from a filter before closing a selected result', async () => {
    const onOpen = vi.fn()
    function Picker() {
      const [open, setOpen] = useState(true)
      const [value, setValue] = useState<EntityRef | null>(null)
      return <DefinitionLibraryContext.Provider value={library}><BuildDefinitionField allowedKinds={['passive']} label="Passive" onChange={setValue} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} onInspect={() => undefined} onOpen={() => { onOpen(); setOpen(true) }} onQueryChange={() => undefined} onResultLimitChange={() => undefined} open={open} query="" resultLimit={100} value={value}/></DefinitionLibraryContext.Provider>
    }
    await act(async () => root.render(<Picker/>))
    await act(async () => checkbox('Include disabled or unconfirmed mods').focus())
    expect(document.activeElement).not.toBe(container.querySelector('[role="combobox"]'))
    await act(async () => results()[0]!.click())
    const input = container.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe(first.name)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(onOpen).not.toHaveBeenCalled()
  })
})
