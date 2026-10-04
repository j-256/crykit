import { describe, expect, it } from 'vitest'
import { NATIVE_DATA } from '../domain/calculation-rules'
import type { GameRuleChange } from '../domain/game-rules'
import { gameRuleLabel, gameRuleScope, gameRuleValue } from './game-rule-labels'

const change = (field: string, calculated = false): GameRuleChange => ({ field, value: 50, baseline: 100, source: 'Synthetic source', calculated })

describe('source-backed game rule explanations', () => {
  it('explains each native field and keeps learning separate from battle simulation', () => {
    for (const field of Object.keys(NATIVE_DATA.battleConfig)) {
      expect(gameRuleLabel(change(field)).label).not.toBe(field)
      expect(gameRuleLabel(change(field)).description).not.toContain('has not been described')
    }
    expect(gameRuleLabel(change('LearnAllJobZeroJPAbilities')).description).toContain('including classes they have not unlocked')
    expect(gameRuleLabel(change('LearnAllJobZeroJPAbilities')).description).toContain('locked by default are excluded')
    expect(gameRuleScope(change('LearnAllJobZeroJPAbilities'))).toBe('Learning rule; recorded learning remains separate')
    expect(gameRuleScope(change('PerfectHitAtChanceOrHigher'))).toContain('outside the resting stat preview')
    expect(gameRuleValue(false)).toBe('Disabled')
    expect(gameRuleValue(50, gameRuleLabel(change('DualWieldPAtkRate')).unit)).toBe('50%')
    expect(gameRuleValue(12, gameRuleLabel(change('TwoHandedPAtkFlat')).unit)).toBe('12 ATK')
  })

  it('keeps unfamiliar fields readable without inventing their effect or units', () => {
    const unknown = change('UnknownHPSetting')
    expect(gameRuleLabel(unknown).label).toBe('Unknown HP Setting')
    expect(gameRuleLabel(unknown).description).toContain('has not been described')
    expect(gameRuleValue(unknown.value, gameRuleLabel(unknown).unit)).toBe('50')
    expect(gameRuleScope(unknown)).toBe('Recorded setting; outside the resting stat preview')
    expect(gameRuleLabel(change('constructor')).label).toBe('constructor')
  })
})
