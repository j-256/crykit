import { DomainError, entityDefinitionKey } from './core'
import { MAX_COLLECTION_LENGTH } from './limits'
import { nativeInteger } from './native-number'
import type { BattleCalculationPlan, BattleResourceInputs, EntityRef } from './types'

export const BATTLE_CALCULATION_VERSION = 1
export const BATTLE_RESOURCES = ['hp', 'mp', 'ap'] as const
export const BATTLE_CONDITIONS = ['bottomThreat', 'topThreat', 'targetIsThreatTarget', 'targetCharging'] as const
export const PERMANENT_STATUS_COUNT = 255

export function unknownBattleResources(): BattleResourceInputs {
  return { hp: null, mp: null, ap: null }
}

export function defaultBattleCalculation(): BattleCalculationPlan {
  return { version: BATTLE_CALCULATION_VERSION, turnCount: 0, targetTurnCount: 0, automaticStatuses: true, statuses: [], user: unknownBattleResources(), target: null, targetResources: unknownBattleResources(), targetStatuses: [], repeatCount: 0, bottomThreat: null, topThreat: null, targetIsThreatTarget: null, targetCharging: false, previouslyAppliedStatuses: [], userPreviouslyAppliedStatuses: [] }
}

export function battleCalculationReferences(battle: BattleCalculationPlan | undefined): readonly { readonly ref: EntityRef; readonly path: string }[] {
  if (!battle) return []
  return [
    ...(battle.target && battle.target !== 'self' ? [{ ref: battle.target, path: 'target' }] : []),
    ...battle.statuses.map((row, index) => ({ ref: row.ref, path: `statuses.${index}.ref` })),
    ...battle.targetStatuses.map((row, index) => ({ ref: row.ref, path: `targetStatuses.${index}.ref` })),
    ...battle.previouslyAppliedStatuses.map((ref, index) => ({ ref, path: `previouslyAppliedStatuses.${index}` })),
    ...battle.userPreviouslyAppliedStatuses.map((ref, index) => ({ ref, path: `userPreviouslyAppliedStatuses.${index}` })),
  ]
}

export function mapBattleCalculationReferences(battle: BattleCalculationPlan, rebind: (ref: EntityRef) => EntityRef): BattleCalculationPlan {
  return { ...battle, target: battle.target && battle.target !== 'self' ? rebind(battle.target) : battle.target, statuses: battle.statuses.map(row => ({ ...row, ref: rebind(row.ref) })), targetStatuses: battle.targetStatuses.map(row => ({ ...row, ref: rebind(row.ref) })), previouslyAppliedStatuses: battle.previouslyAppliedStatuses.map(rebind), userPreviouslyAppliedStatuses: battle.userPreviouslyAppliedStatuses.map(rebind) }
}

export function validateBattleCalculation(battle: BattleCalculationPlan, assertRef: (ref: EntityRef, label: string) => void): void {
  if (battle.version !== BATTLE_CALCULATION_VERSION) throw new DomainError('INVALID_INPUT', 'Unsupported battle calculation version')
  const quantity = (value: number | null, label: string, minimum = 0) => {
    if (value !== null && (!nativeInteger(value) || value < minimum)) throw new DomainError('INVALID_INPUT', `${label} must be a supported whole number or unknown`)
  }
  quantity(battle.turnCount, 'Battle turn count')
  quantity(battle.targetTurnCount, 'Target turn count')
  quantity(battle.repeatCount, 'Repeated action count')
  if (typeof battle.automaticStatuses !== 'boolean') throw new DomainError('INVALID_INPUT', 'Choose whether to include automatic statuses')
  for (const key of BATTLE_CONDITIONS) if (battle[key] !== null && typeof battle[key] !== 'boolean') throw new DomainError('INVALID_INPUT', 'Battle conditions must be known or explicitly unknown')
  for (const resources of [battle.user, battle.targetResources]) for (const key of BATTLE_RESOURCES) quantity(resources[key], `Current ${key.toUpperCase()}`)
  for (const rows of [battle.statuses, battle.targetStatuses]) {
    if (rows.length > MAX_COLLECTION_LENGTH || new Set(rows.map(row => entityDefinitionKey(row.ref))).size !== rows.length) throw new DomainError('INVALID_INPUT', 'Battle statuses require unique definitions')
    for (const row of rows) quantity(row.count, 'Status duration', 1)
  }
  for (const refs of [battle.previouslyAppliedStatuses, battle.userPreviouslyAppliedStatuses]) if (refs.length > MAX_COLLECTION_LENGTH || new Set(refs.map(entityDefinitionKey)).size !== refs.length) throw new DomainError('INVALID_INPUT', 'Previously applied statuses require unique definitions')
  for (const { ref, path } of battleCalculationReferences(battle)) assertRef(ref, `Battle calculation ${path}`)
}
