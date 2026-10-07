import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { defaultBattleCalculation } from '../domain/battle-plan'
import { defaultCalculation, validateCalculationPlan } from '../domain/calculation-plan'
import { createTestLocalData } from '../domain/test-helpers'
import type { BattleCalculationPlan, BuildCalculationPlan, CatalogRef } from '../domain/types'
import { BattleCalculationControls } from './BattleCalculationControls'
import { CombatPreview } from './CombatPreview'

vi.mock('./CalculationPicker', () => ({ CalculationPicker: () => null }))

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

it('imports duplicate historical status assumptions once while preserving active duration and saved history', async () => {
  const localData = createTestLocalData()
  const [first, second] = Object.values(DEFAULT_CATALOG.entities).filter(entity => entity.kind === 'status' && entity.id.startsWith('base:')).slice(0, 2).map(entity => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id } as CatalogRef))
  const plan: BuildCalculationPlan = { ...defaultCalculation(null), statuses: [first!, second!, second!], battle: { ...defaultBattleCalculation(), statuses: [{ ref: first!, count: 3 }], previouslyAppliedStatuses: [second!], userPreviouslyAppliedStatuses: [first!] } }
  const onChange = vi.fn<(value: BuildCalculationPlan | undefined) => void>()
  const content = { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: plan }
  await act(async () => root.render(<CombatPreview content={content} localData={localData} catalogs={[DEFAULT_CATALOG]} slots={[]} onChange={onChange}/>))
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use saved statuses in scenario')!
  await act(async () => button.click())
  const changed = onChange.mock.calls[0]![0]!
  expect(changed.battle!.statuses).toEqual([{ ref: first, count: 3 }, { ref: second, count: null }])
  expect(changed.statuses).toEqual(plan.statuses)
  expect(changed.battle!.previouslyAppliedStatuses).toEqual([second])
  expect(changed.battle!.userPreviouslyAppliedStatuses).toEqual([first])
  expect(() => validateCalculationPlan(changed, () => undefined)).not.toThrow()
  expect(container.textContent).toContain('Statuses previously applied to actor')
  expect(container.textContent).toContain('Statuses previously applied to target')
  expect(plan.battle!.statuses).toEqual([{ ref: first, count: 3 }])
})

it('fills known resource maxima without clearing entered resources whose maxima are unknown', async () => {
  const battle: BattleCalculationPlan = { ...defaultBattleCalculation(), user: { hp: 1, mp: 2, ap: null }, targetResources: { hp: 7, mp: 8, ap: 9 } }
  const onChange = vi.fn<(value: BattleCalculationPlan) => void>()
  const maxima = { user: { hp: null, mp: 30, ap: 0 }, target: { hp: 100, mp: null, ap: null } }
  await act(async () => root.render(<BattleCalculationControls battle={battle} maxima={maxima} localData={createTestLocalData()} catalogs={[DEFAULT_CATALOG]} onChange={onChange}/>))
  const buttons = [...container.querySelectorAll('button')]
  await act(async () => buttons.find(button => button.textContent === 'Use full actor resources')!.click())
  expect(onChange.mock.calls[0]![0].user).toEqual({ hp: 1, mp: 30, ap: 0 })
  await act(async () => buttons.find(button => button.textContent === 'Use full target resources')!.click())
  expect(onChange.mock.calls[1]![0].targetResources).toEqual({ hp: 100, mp: 8, ap: 9 })
  expect(battle.user).toEqual({ hp: 1, mp: 2, ap: null })
  expect(battle.targetResources).toEqual({ hp: 7, mp: 8, ap: 9 })
})
