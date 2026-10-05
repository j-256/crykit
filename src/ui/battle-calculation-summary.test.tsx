import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { defaultBattleCalculation, PERMANENT_STATUS_COUNT } from '../domain/battle-plan'
import { defaultCalculation } from '../domain/calculation-plan'
import { createTestLocalData } from '../domain/test-helpers'
import type { BattleCalculationPlan, CatalogRef, EntityRef } from '../domain/types'
import { battleCalculationSummary } from './battle-calculation-summary'
import { CalculationInputs } from './CalculationInputs'
import { SnapshotValueView } from './CharacterSheet'
import { entityName } from './model'

const localData = createTestLocalData()
const catalogs = [DEFAULT_CATALOG]
const [first, second] = Object.values(DEFAULT_CATALOG.entities).filter(entity => entity.kind === 'status' && entity.id.startsWith('base:')).slice(0, 2).map(entity => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id } as CatalogRef))
const monster: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: Object.values(DEFAULT_CATALOG.entities).find(entity => entity.kind === 'monster')!.id }
const name = (ref: EntityRef) => entityName(localData, catalogs, ref)
const battle: BattleCalculationPlan = { ...defaultBattleCalculation(), statuses: [{ ref: first!, count: 1 }], targetStatuses: [{ ref: second!, count: 2 }] }

const changes: readonly { readonly label: string; readonly patch: Partial<BattleCalculationPlan>; readonly expected: string }[] = [
  { label: 'Elapsed actor turns', patch: { turnCount: 3 }, expected: '3' },
  { label: 'Elapsed target turns', patch: { targetTurnCount: 4 }, expected: '4' },
  { label: 'Automatic statuses', patch: { automaticStatuses: false }, expected: 'Excluded' },
  { label: 'Actor resources', patch: { user: { hp: 0, mp: 12, ap: 7 } }, expected: 'HP 0, MP 12, AP 7' },
  { label: 'Actor active statuses', patch: { statuses: [{ ref: first!, count: 2 }] }, expected: `${name(first!)} (2 remaining)` },
  { label: 'Actor active statuses', patch: { statuses: [{ ref: second!, count: 1 }] }, expected: `${name(second!)} (1 remaining)` },
  { label: 'Statuses previously applied to actor', patch: { userPreviouslyAppliedStatuses: [first!] }, expected: name(first!) },
  { label: 'Battle target', patch: { target: monster }, expected: name(monster) },
  { label: 'Target resources', patch: { targetResources: { hp: 10, mp: 0, ap: 9 } }, expected: 'HP 10, MP 0, AP 9' },
  { label: 'Target active statuses', patch: { targetStatuses: [{ ref: second!, count: 3 }] }, expected: `${name(second!)} (3 remaining)` },
  { label: 'Target active statuses', patch: { targetStatuses: [{ ref: first!, count: 2 }] }, expected: `${name(first!)} (2 remaining)` },
  { label: 'Statuses previously applied to target', patch: { previouslyAppliedStatuses: [second!] }, expected: name(second!) },
  { label: 'Repeated action count', patch: { repeatCount: 2 }, expected: '2' },
  { label: 'Actor has lowest threat', patch: { bottomThreat: true }, expected: 'Yes' },
  { label: 'Actor has highest threat', patch: { topThreat: false }, expected: 'No' },
  { label: "Target is the actor's threat target", patch: { targetIsThreatTarget: true }, expected: 'Yes' },
  { label: 'Target is charging', patch: { targetCharging: null }, expected: 'Unknown' },
]

it.each(changes)('keeps a saved $label change visible in scenario summaries', ({ label, patch, expected }) => {
  const original = battleCalculationSummary(battle, name)
  const changed = battleCalculationSummary({ ...battle, ...patch }, name)
  expect(changed).toContainEqual([label, expected])
  expect(changed).not.toEqual(original)
})

it('distinguishes unknown and permanent durations and retains target assumptions for self targets', () => {
  const rows = Object.fromEntries(battleCalculationSummary({ ...battle, target: 'self', targetTurnCount: 4, statuses: [{ ref: first!, count: null }], targetStatuses: [{ ref: second!, count: PERMANENT_STATUS_COUNT }], targetResources: { hp: 0, mp: null, ap: 0 }, previouslyAppliedStatuses: [first!] }, name))
  expect(rows['Battle target']).toBe('Self')
  expect(rows['Elapsed target turns (retained for other targets)']).toBe('4')
  expect(rows['Actor active statuses']).toBe(`${name(first!)} (unknown duration)`)
  expect(rows['Target active statuses (retained for other targets)']).toBe(`${name(second!)} (permanent)`)
  expect(rows['Target resources (retained for other targets)']).toBe('HP 0, MP Unknown, AP 0')
  expect(rows['Statuses previously applied to target (retained for other targets)']).toBe(name(first!))
})

it('shows resource, duration, history, and condition assumptions in read-only inputs and recorded snapshots', () => {
  const plan = { ...defaultCalculation(null), battle: { ...battle, user: { hp: 0, mp: 12, ap: null }, statuses: [{ ref: first!, count: 5 }], userPreviouslyAppliedStatuses: [second!], targetCharging: true } }
  const summaries = [
    renderToStaticMarkup(<CalculationInputs plan={plan} localData={localData} catalogs={catalogs}/>),
    renderToStaticMarkup(<SnapshotValueView value={{ kind: 'calculation', value: plan }} localData={localData} catalogs={catalogs}/>),
  ]
  for (const summary of summaries) {
    expect(summary).toContain('<dt>Actor resources</dt><dd>HP 0, MP 12, AP Unknown</dd>')
    expect(summary).toContain('(5 remaining)')
    expect(summary).toContain(renderToStaticMarkup(<><dt>Statuses previously applied to actor</dt><dd>{name(second!)}</dd></>))
    expect(summary).toContain('<dt>Target is charging</dt><dd>Yes</dd>')
  }
})
