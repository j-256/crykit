import rules from '../calculations/combat-v1.json' with { type: 'json' }
import {
  evaluateCombatFormula,
  traceCombatFormula,
  type CombatRules,
  type CombatValue,
} from './combat-expression'

export const COMBAT_RULES = rules as unknown as CombatRules

export function calculateCombat(name: string, inputs: readonly CombatValue[]): CombatValue {
  return evaluateCombatFormula(COMBAT_RULES, name, inputs)
}

export function traceCombat(name: string, inputs: readonly CombatValue[]) {
  return traceCombatFormula(COMBAT_RULES, name, inputs)
}
