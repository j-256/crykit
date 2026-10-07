// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import type { BuildRevisionContent, EntityId } from '../domain/types'
import { buildDefinitionOptions, type DefinitionOption } from './definitions'
import { LoadoutSheet } from './LoadoutSheet'

const localData = createBlankLocalData()
const catalogs = [CURRENT_CATALOG]
const options = buildDefinitionOptions(localData, catalogs)
const warrior = options.find(option => option.kind === 'class' && option.name === 'Warrior')!
const cleric = options.find(option => option.kind === 'class' && option.name === 'Cleric')!
const wizard = options.find(option => option.kind === 'class' && option.name === 'Wizard')!
const content: BuildRevisionContent = { primaryClass: warrior.ref, secondaryClass: cleric.ref, equipment: {}, passives: [], contextAssumptions: [] }
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(draft = content, selection: DefinitionOption | undefined = cleric, showClassPermissions = false, snapshots = catalogs) {
  await act(async () => root.render(<LoadoutSheet catalogs={snapshots} content={draft} equipmentFields={null} localData={localData} onViewChange={() => undefined} passiveFields={null} primaryClassField={<p>Primary class selection</p>} selection={selection} showChecks={false} showClassPermissions={showClassPermissions} showStats={false} slots={[]} subCommandField={<p>Sub-command selection</p>} view="loadout" viewLabel="Loadout view"/>))
}

const growth = () => container.querySelector<HTMLElement>('.primary-class-growth')!
const ratings = () => [...growth().querySelectorAll('.rating-stars')].map(element => element.getAttribute('aria-label'))

describe('primary class growth in loadout sheets', () => {
  it('keeps the chart mounted and unchanged while inspecting or changing the sub-command', async () => {
    await render()
    const chart = growth().querySelector('.stat-ratings')
    const values = ratings()
    expect(growth().querySelector('h4')?.textContent).toBe('Warrior growth')
    expect(container.querySelectorAll('.stat-ratings')).toHaveLength(1)
    expect(growth().closest('details')).toBeNull()
    expect(container.querySelector('aside')?.textContent).toContain('White Magic')
    expect(container.querySelector('aside')?.textContent).not.toMatch(/growth|Innate|Armor|Weapons|equipment permissions/)
    await render(content, wizard)
    expect(growth().querySelector('.stat-ratings')).toBe(chart)
    expect(ratings()).toEqual(values)
    await render({ ...content, secondaryClass: wizard.ref }, wizard)
    expect(growth().querySelector('.stat-ratings')).toBe(chart)
    expect(ratings()).toEqual(values)
    await render({ ...content, secondaryClass: null }, undefined)
    expect(growth().querySelector('.stat-ratings')).toBe(chart)
    expect(ratings()).toEqual(values)
    await render(content, cleric, true)
    expect(growth().querySelector('.stat-ratings')).toBe(chart)
    expect(ratings()).toEqual(values)
    await render({ ...content, primaryClass: cleric.ref, secondaryClass: wizard.ref }, wizard)
    expect(growth().querySelector('h4')?.textContent).toBe('Cleric growth')
    expect(ratings()).not.toEqual(values)
  })

  it('preserves unknown growth and missing primary records without using the sub-command', async () => {
    if (warrior.ref.kind !== 'catalog') throw new Error('The Warrior fixture must be a catalog reference')
    const entity = CURRENT_CATALOG.entities[warrior.ref.entityId]!
    const unknown = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [entity.id]: { ...entity, fields: { ...entity.fields, [CLASS_FIELDS.ratings]: { state: 'unknown' as const, reason: 'Synthetic unavailable growth' } } } } }
    await render(content, cleric, false, [unknown])
    expect(growth().textContent).toContain('Warrior growth')
    expect(growth().textContent).toContain('Synthetic unavailable growth')
    expect(ratings()).toHaveLength(0)
    await render({ ...content, primaryClass: { ...warrior.ref, entityId: 'synthetic:missing-class' as EntityId } })
    expect(growth().textContent).toContain('Primary class growth')
    expect(growth().textContent).toContain('Unknown')
    expect(ratings()).toHaveLength(0)
    await render({ ...content, primaryClass: null })
    expect(container.querySelector('.primary-class-growth')).toBeNull()
    expect(container.querySelectorAll('.stat-ratings')).toHaveLength(0)
  })

  it('retains attribution when growth differs from the verified catalog', async () => {
    await render()
    expect(growth().querySelector('[aria-label="Sources for Warrior growth"]')).toBeNull()
    if (warrior.ref.kind !== 'catalog') throw new Error('The Warrior fixture must be a catalog reference')
    const entity = CURRENT_CATALOG.entities[warrior.ref.entityId]!
    const ratings = entity.fields[CLASS_FIELDS.ratings]!
    const changed = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [entity.id]: { ...entity, fields: { ...entity.fields, [CLASS_FIELDS.ratings]: { ...ratings, state: 'known' as const, value: { HP: 1 } } } } } }
    await render(content, cleric, false, [changed])
    expect(growth().querySelector('[aria-label="Sources for Warrior growth"]')).not.toBeNull()
    await render(content, cleric, false, [{ ...CURRENT_CATALOG, checksum: 'synthetic-import-checksum' }])
    expect(growth().querySelector('[aria-label="Sources for Warrior growth"]')).not.toBeNull()
  })
})
