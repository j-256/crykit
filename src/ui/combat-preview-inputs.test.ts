import { describe, expect, it } from 'vitest'
import { defaultBattleCalculation } from '../domain/battle-plan'
import { personalRef } from '../domain/test-helpers'
import { combatPreviewInputAction } from './combat-preview-inputs'

const monster = { ...defaultBattleCalculation(), target: personalRef('synthetic-monster') }
const self = { ...defaultBattleCalculation(), target: 'self' as const }

describe('combat preview input actions', () => {
  it.each(['HP', 'MP', 'AP'] as const)('routes current %s failures to the correct resource input', resource => {
    const unknown = `is unknown or outside the native integer range`
    expect(combatPreviewInputAction([`User current ${resource} ${unknown}`], monster)).toEqual({ label: `Set actor ${resource}`, field: `actor.${resource.toLowerCase()}` })
    expect(combatPreviewInputAction([`Target current ${resource} ${unknown}`], monster)).toEqual({ label: `Set target ${resource}`, field: `target.${resource.toLowerCase()}` })
    expect(combatPreviewInputAction([`Target current ${resource} ${unknown}`], self)).toEqual({ label: `Set actor ${resource}`, field: `actor.${resource.toLowerCase()}` })
    expect(combatPreviewInputAction([`Target current ${resource} exceeds its calculated maximum`], monster)).toEqual({ label: `Review target ${resource}`, field: `target.${resource.toLowerCase()}` })
    expect(combatPreviewInputAction([`Target current ${resource} exceeds its calculated maximum`], self)).toEqual({ label: `Review actor ${resource}`, field: `actor.${resource.toLowerCase()}` })
  })

  it('requires the status recipient to route unnamed recipient HP failures', () => {
    const reasons = ['Recipient current HP is unknown']
    expect(combatPreviewInputAction(reasons, monster, 'user')).toEqual({ label: 'Set actor HP', field: 'actor.hp' })
    expect(combatPreviewInputAction(reasons, monster, 'target')).toEqual({ label: 'Set target HP', field: 'target.hp' })
    expect(combatPreviewInputAction(reasons, self, 'target')).toEqual({ label: 'Set actor HP', field: 'actor.hp' })
    expect(combatPreviewInputAction(reasons, monster)).toBeUndefined()
    expect(combatPreviewInputAction(reasons, self)).toBeUndefined()
  })

  it('routes conditional failures without confusing highest and lowest threat', () => {
    expect(combatPreviewInputAction(['bottomThreat is unknown'], monster)).toEqual({ label: 'Set lowest-threat condition', field: 'bottomThreat' })
    expect(combatPreviewInputAction(['topThreat is unknown'], monster)).toEqual({ label: 'Set highest-threat condition', field: 'topThreat' })
    expect(combatPreviewInputAction(['targetIsThreatTarget is unknown'], monster)).toEqual({ label: 'Set threat-target relationship', field: 'targetIsThreatTarget' })
    expect(combatPreviewInputAction(['targetCharging is unknown'], self)).toEqual({ label: 'Set charging condition', field: 'targetCharging' })
    expect(combatPreviewInputAction(['repeatCount is unknown'], monster)).toEqual({ label: 'Set repeated action count', field: 'repeatCount' })
    expect(combatPreviewInputAction(['targetTurnCount is unknown'], monster)).toEqual({ label: 'Set target turns', field: 'targetTurnCount' })
    expect(combatPreviewInputAction(['targetTurnCount is unknown'], self)).toEqual({ label: 'Set actor turns', field: 'turnCount' })
  })

  it('routes active status count uncertainty to the applicable status section', () => {
    expect(combatPreviewInputAction(['User Synthetic combo count is unknown'], monster)).toEqual({ label: 'Review actor statuses', field: 'actor-statuses' })
    expect(combatPreviewInputAction(['Target Synthetic combo count is unknown'], monster)).toEqual({ label: 'Review target statuses', field: 'target-statuses' })
    expect(combatPreviewInputAction(['Target Synthetic combo count is unknown'], self)).toEqual({ label: 'Review actor statuses', field: 'actor-statuses' })
    expect(combatPreviewInputAction(['Actor active buff count is unknown'], monster)?.field).toBe('actor-statuses')
    expect(combatPreviewInputAction(['Target active debuff count is unknown'], monster)?.field).toBe('target-statuses')
  })

  it('does not guess a control from missing catalog data, derived stats, or arbitrary numeric failures', () => {
    for (const reason of ['User HP is unknown', 'User maximum HP is unknown', 'Target modifier HP is unknown', 'Status count is unknown or outside the native integer range', 'Calculated result is unknown or outside the native integer range', 'Choose a supported Game Setup difficulty for monster stats', 'Previously applied status identity is unresolved', 'toString']) {
      expect(combatPreviewInputAction([reason], monster), reason).toBeUndefined()
    }
    expect(combatPreviewInputAction(undefined, monster)).toBeUndefined()
    expect(combatPreviewInputAction([], monster)).toBeUndefined()
    expect(combatPreviewInputAction(['User HP is unknown', 'User current HP is unknown or outside the native integer range'], monster)).toEqual({ label: 'Set actor HP', field: 'actor.hp' })
  })
})
