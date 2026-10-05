import { BATTLE_RESOURCES, PERMANENT_STATUS_COUNT } from '../domain/battle-plan'
import type { BattleCalculationPlan, BattleResourceInputs, BattleStatusInput, EntityRef } from '../domain/types'

export type BattleSummaryRow = readonly [label: string, value: string]

const quantity = (value: number | null) => value === null ? 'Unknown' : String(value)
const condition = (value: boolean | null) => value === null ? 'Unknown' : value ? 'Yes' : 'No'

export function battleCalculationSummary(battle: BattleCalculationPlan, name: (ref: EntityRef) => string): readonly BattleSummaryRow[] {
  const resources = (value: BattleResourceInputs) => BATTLE_RESOURCES.map(resource => `${resource.toUpperCase()} ${quantity(value[resource])}`).join(', ')
  const statuses = (rows: readonly BattleStatusInput[]) => rows.map(row => `${name(row.ref)} (${row.count === PERMANENT_STATUS_COUNT ? 'permanent' : row.count === null ? 'unknown duration' : `${row.count} remaining`})`).join(', ') || 'None selected'
  const history = (refs: readonly EntityRef[]) => refs.map(name).join(', ') || 'None recorded'
  const retained = battle.target === 'self' ? ' (retained for other targets)' : ''
  return [
    ['Calculation scope', 'Battle scenario'],
    ['Elapsed actor turns', quantity(battle.turnCount)],
    ['Automatic statuses', battle.automaticStatuses ? 'Included when guaranteed' : 'Excluded'],
    ['Actor resources', resources(battle.user)],
    ['Actor active statuses', statuses(battle.statuses)],
    ['Statuses previously applied to actor', history(battle.userPreviouslyAppliedStatuses)],
    ['Battle target', battle.target === 'self' ? 'Self' : battle.target ? name(battle.target) : 'Unknown'],
    [`Elapsed target turns${retained}`, quantity(battle.targetTurnCount)],
    [`Target resources${retained}`, resources(battle.targetResources)],
    [`Target active statuses${retained}`, statuses(battle.targetStatuses)],
    [`Statuses previously applied to target${retained}`, history(battle.previouslyAppliedStatuses)],
    ['Repeated action count', quantity(battle.repeatCount)],
    ['Actor has lowest threat', condition(battle.bottomThreat)],
    ['Actor has highest threat', condition(battle.topThreat)],
    ["Target is the actor's threat target", condition(battle.targetIsThreatTarget)],
    ['Target is charging', condition(battle.targetCharging)],
  ]
}
