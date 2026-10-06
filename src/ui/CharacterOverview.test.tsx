// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asId, captureCharacter, createCharacter, upsertCharacterClassProgress } from '../domain'
import { addTestDefinition, createTestLocalData, known, personalRef, TEST_NOW } from '../domain/test-helpers'
import type { CharacterId, Knowledge, LocalData, ObservedStat } from '../domain/types'
import { CharacterOverview } from './CharacterOverview'
import { NavigationProvider, useNavigationController, type NavigationController } from './navigation'

const CHARACTER_ID = asId<CharacterId>('synthetic-character')
const CLASS_REF = personalRef('Synthetic class')
let container: HTMLDivElement
let root: Root
let navigation: NavigationController

function Harness({ localData }: { readonly localData: LocalData }) {
  navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><CharacterOverview catalogs={[]} localData={localData}/></NavigationProvider>
}

function characterData(displayedStats: Readonly<Record<string, ObservedStat>> = {}, observedLp: Knowledge<number> = { state: 'unknown' }, mastered: Knowledge<boolean> = { state: 'unknown' }) {
  let localData = addTestDefinition(createTestLocalData(), 'Synthetic class', { kind: 'class' })
  localData = createCharacter(localData, { id: CHARACTER_ID, name: 'Synthetic character', now: TEST_NOW })
  localData = captureCharacter(localData, { characterId: CHARACTER_ID, primaryClass: known(CLASS_REF), displayedStats, sources: [{ sourceId: 'synthetic-observation' }], now: TEST_NOW })
  return upsertCharacterClassProgress(localData, { characterId: CHARACTER_ID, classRef: CLASS_REF, observedLp, mastered, now: TEST_NOW })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '#/characters')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(localData: LocalData) {
  await act(async () => root.render(<Harness localData={localData}/>))
}

describe('Character overview recording actions', () => {
  it('keeps recording links outside closed unknown lists and navigates without changing observations', async () => {
    const localData = characterData({ HP: { value: { state: 'unknown' }, unit: 'displayed' } })
    const before = JSON.stringify(localData)
    await render(localData)
    const groups = [...container.querySelectorAll<HTMLDetailsElement>('.roster-unrecorded')]
    expect(groups.map(group => group.querySelector('summary')?.textContent)).toEqual(['Stats not recorded', 'Learning not recorded'])
    expect(groups.every(group => !group.open)).toBe(true)
    expect(groups[0]?.querySelector('[aria-label="Synthetic character: recorded stats"]')?.textContent).toContain('HPUnknown')
    expect(groups[1]?.querySelector('[aria-label="Synthetic character: character learning"]')?.textContent).toContain('Primary class LPUnknown')
    for (const [label, page] of [
      ['Capture stats', { page: 'characters', view: 'snapshot-new', characterId: CHARACTER_ID }],
      ['Record learning', { page: 'characters', view: 'character', characterId: CHARACTER_ID, tab: 'current' }],
    ] as const) {
      const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(candidate => candidate.textContent === label)!
      expect(link.closest('details')).toBeNull()
      expect(link.getAttribute('href')).toBe(navigation.href({ page, overlays: [], query: {} }))
      link.focus()
      expect(document.activeElement).toBe(link)
      await act(async () => link.click())
      expect(navigation.route.page).toEqual(page)
      expect(groups.every(group => !group.open)).toBe(true)
      expect(JSON.stringify(localData)).toBe(before)
    }
  })

  it('keeps known zero stats, zero LP and recorded false mastery visible', async () => {
    const localData = characterData({ HP: { value: known(0), unit: 'displayed' } }, known(0), known(false))
    const before = JSON.stringify(localData)
    await render(localData)
    expect(container.querySelectorAll('.roster-unrecorded')).toHaveLength(0)
    const stats = container.querySelector('[aria-label="Synthetic character: recorded stats"]')!
    expect(stats.closest('details')).toBeNull()
    expect(stats.querySelector('[title="HP: 0"] dd')?.textContent).toBe('0')
    const learning = container.querySelector('[aria-label="Synthetic character: character learning"]')!
    expect(learning.closest('details')).toBeNull()
    expect(learning.textContent).toContain('Primary class LP0')
    expect(learning.textContent).toContain('Primary class masteredNo')
    expect(JSON.stringify(localData)).toBe(before)
  })

  it('keeps conflicting observations visible instead of treating them as unrecorded groups', async () => {
    const conflictingNumber: Knowledge<number> = { state: 'conflicting', claims: [{ value: 0, sources: [{ sourceId: 'synthetic-a' }] }, { value: 10, sources: [{ sourceId: 'synthetic-b' }] }] }
    const conflictingMastery: Knowledge<boolean> = { state: 'conflicting', claims: [{ value: true, sources: [{ sourceId: 'synthetic-a' }] }, { value: false, sources: [{ sourceId: 'synthetic-b' }] }] }
    const localData = characterData({ HP: { value: conflictingNumber, unit: 'displayed' } }, conflictingNumber, conflictingMastery)
    const before = JSON.stringify(localData)
    await render(localData)
    expect(container.querySelectorAll('.roster-unrecorded')).toHaveLength(0)
    const stats = container.querySelector('[aria-label="Synthetic character: recorded stats"]')!
    const learning = container.querySelector('[aria-label="Synthetic character: character learning"]')!
    expect(stats.closest('details')).toBeNull()
    expect(learning.closest('details')).toBeNull()
    expect(stats.querySelector('[data-state="conflicting"]')?.textContent).toBe('Conflicting claims')
    expect(learning.querySelectorAll('[data-state="conflicting"]')).toHaveLength(2)
    expect(JSON.stringify(localData)).toBe(before)
  })
})
