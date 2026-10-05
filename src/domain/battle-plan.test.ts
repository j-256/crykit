import { describe, expect, it } from 'vitest'
import { battleCalculationReferences, defaultBattleCalculation, mapBattleCalculationReferences, validateBattleCalculation } from './battle-plan'
import { validateCalculationPlan, defaultCalculation } from './calculation-plan'
import { MAX_NATIVE_INTEGER } from './native-number'
import { personalRef } from './test-helpers'
import type { BattleCalculationPlan } from './types'

describe('versioned battle assumptions', () => {
  it('retains unknown resources and threat relationships in an explicit opening scenario', () => {
    const battle = defaultBattleCalculation()
    expect(battle.turnCount).toBe(0)
    expect(battle.targetTurnCount).toBe(0)
    expect(battle.user).toEqual({ hp: null, mp: null, ap: null })
    expect(battle.target).toBeNull()
    expect(battle.bottomThreat).toBeNull()
    expect(battle.topThreat).toBeNull()
    expect(battle.targetIsThreatTarget).toBeNull()
    expect(defaultCalculation(null)).not.toHaveProperty('battle')
  })

  it('validates and rebinds every target, active status, and application-history reference', () => {
    const refs = ['target', 'user-status', 'target-status', 'target-history', 'user-history'].map(personalRef)
    const battle: BattleCalculationPlan = { ...defaultBattleCalculation(), target: refs[0]!, statuses: [{ ref: refs[1]!, count: null }], targetStatuses: [{ ref: refs[2]!, count: 255 }], previouslyAppliedStatuses: [refs[3]!], userPreviouslyAppliedStatuses: [refs[4]!] }
    const visited: unknown[] = []
    validateCalculationPlan({ ...defaultCalculation(null), battle }, ref => visited.push(ref))
    expect(visited).toEqual(refs)
    const mapped = mapBattleCalculationReferences(battle, ref => ref.kind === 'personal' ? personalRef(`${ref.definitionId}-copy`) : ref)
    expect(battleCalculationReferences(mapped).map(({ ref }) => ref)).toEqual(refs.map(ref => personalRef(`${ref.definitionId}-copy`)))
    expect(battle.statuses[0]!.count).toBeNull()
    expect(mapped.targetStatuses[0]!.count).toBe(255)
  })

  it('rejects invalid arithmetic inputs and duplicate statuses before saving', () => {
    for (const value of [-1, 0.5, MAX_NATIVE_INTEGER + 1, Infinity, NaN]) {
      expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), turnCount: value }, () => undefined)).toThrow('whole number')
      expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), targetTurnCount: value }, () => undefined)).toThrow('Target turn count')
    }
    expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), targetTurnCount: null }, () => undefined)).not.toThrow()
    const row = { ref: personalRef('status'), count: 1 }
    expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), statuses: [row, row] }, () => undefined)).toThrow('unique')
    expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), statuses: [{ ...row, count: 0 }] }, () => undefined)).toThrow('Status duration')
    expect(() => validateBattleCalculation({ ...defaultBattleCalculation(), version: 99 } as unknown as BattleCalculationPlan, () => undefined)).toThrow('version')
  })
})
