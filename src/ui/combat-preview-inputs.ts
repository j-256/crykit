import type { BattleCalculationPlan } from '../domain/types'

export type CombatPreviewInputField =
  | `actor.${'hp' | 'mp' | 'ap'}`
  | `target.${'hp' | 'mp' | 'ap'}`
  | 'repeatCount'
  | 'bottomThreat'
  | 'topThreat'
  | 'targetIsThreatTarget'
  | 'targetCharging'
  | 'turnCount'
  | 'targetTurnCount'
  | 'actor-statuses'
  | 'target-statuses'

export interface CombatPreviewInputAction {
  readonly label: string
  readonly field: CombatPreviewInputField
}

const CONTEXT_ACTIONS: Readonly<Record<string, CombatPreviewInputAction>> = Object.freeze({
  'repeatCount is unknown': { label: 'Set repeated action count', field: 'repeatCount' },
  'bottomThreat is unknown': { label: 'Set lowest-threat condition', field: 'bottomThreat' },
  'topThreat is unknown': { label: 'Set highest-threat condition', field: 'topThreat' },
  'targetIsThreatTarget is unknown': { label: 'Set threat-target relationship', field: 'targetIsThreatTarget' },
  'targetCharging is unknown': { label: 'Set charging condition', field: 'targetCharging' },
  'turnCount is unknown': { label: 'Set actor turns', field: 'turnCount' },
  'targetTurnCount is unknown': { label: 'Set target turns', field: 'targetTurnCount' },
})

export function combatPreviewInputAction(reasons: readonly string[] | undefined, battle: BattleCalculationPlan, recipient?: 'user' | 'target'): CombatPreviewInputAction | undefined {
  const actorFor = (name: string): 'actor' | 'target' | undefined => {
    if (name === 'Recipient') return recipient ? actorFor(recipient === 'user' ? 'User' : 'Target') : undefined
    return name === 'Target' && battle.target !== 'self' ? 'target' : 'actor'
  }
  for (const reason of reasons ?? []) {
    const resource = /^(User|Actor|Target|Recipient) current (HP|MP|AP) (is unknown(?: or outside the native integer range)?|exceeds its calculated maximum)$/.exec(reason)
    if (resource) {
      const actor = actorFor(resource[1]!)
      if (!actor) continue
      const attribute = resource[2]!.toLowerCase() as 'hp' | 'mp' | 'ap'
      return { label: `${resource[3]!.startsWith('exceeds') ? 'Review' : 'Set'} ${actor} ${resource[2]}`, field: `${actor}.${attribute}` }
    }
    const status = /^(User|Actor|Target) .+ count is unknown$/.exec(reason)
    if (status) {
      const actor = actorFor(status[1]!)!
      return { label: `Review ${actor} statuses`, field: `${actor}-statuses` }
    }
    if (Object.hasOwn(CONTEXT_ACTIONS, reason)) {
      const action = CONTEXT_ACTIONS[reason]!
      return action.field === 'targetTurnCount' && battle.target === 'self' ? CONTEXT_ACTIONS['turnCount is unknown'] : action
    }
  }
  return undefined
}
