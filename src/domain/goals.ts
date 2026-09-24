import {
  asTimestamp,
  assertExpectedRevision,
  assertPersonalDefinitionRef,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import type { Goal, GoalId, GoalRequirement, GoalStatus, Profile, Timestamp } from './types'

export interface CreateGoalInput {
  readonly id?: GoalId
  readonly title: string
  readonly status?: GoalStatus
  readonly priority?: number
  readonly requirements?: readonly GoalRequirement[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createGoal(profile: Profile, input: CreateGoalInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const title = input.title.trim()
  if (!title) {
    throw new DomainError('INVALID_INPUT', 'Goal title must not be empty')
  }
  const priority = input.priority ?? 0
  if (!Number.isFinite(priority)) {
    throw new DomainError('INVALID_INPUT', 'Goal priority must be finite')
  }
  for (const requirement of input.requirements ?? []) {
    if (!requirement.id.trim()) throw new DomainError('INVALID_INPUT', 'Goal requirement ID must not be empty')
    if (requirement.target) assertPersonalDefinitionRef(profile, requirement.target)
    const quantity = requirement.quantity
    if (quantity && quantity.kind !== 'unknown') {
      const valid = Number.isSafeInteger(quantity.value) &&
        (quantity.kind === 'exact' ? quantity.value >= 0 : quantity.value > 0)
      if (!valid) throw new DomainError('INVALID_INPUT', 'Goal requirement quantity is invalid')
    }
  }
  const id = input.id ?? createId<GoalId>('goal')
  if (profile.goals[id]) {
    throw new DomainError('DUPLICATE_ID', `Goal already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const goal: Goal = {
    id,
    revision: 0,
    title,
    status: input.status ?? 'open',
    priority,
    requirements: input.requirements ?? [],
    createdAt: at,
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { goals: { ...profile.goals, [id]: goal } },
    'goal.create',
    [`goals.${id}`],
    at,
  )
}
