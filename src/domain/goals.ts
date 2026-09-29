import {
  asTimestamp,
  assertExpectedRevision,
  assertPersonalDefinitionRef,
  createId,
  DomainError,
  nowTimestamp,
  requirePlaythrough,
  updatePlaythrough,
} from './core'
import type { Goal, GoalId, GoalRequirement, GoalStatus, LocalData, PlaythroughId, Timestamp } from './types'

export interface CreateGoalInput {
  readonly playthroughId?: PlaythroughId
  readonly id?: GoalId
  readonly title: string
  readonly status?: GoalStatus
  readonly priority?: number
  readonly requirements?: readonly GoalRequirement[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createGoal(localData: LocalData, input: CreateGoalInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
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
    if (requirement.target) assertPersonalDefinitionRef(localData, requirement.target)
    const quantity = requirement.quantity
    if (quantity && quantity.kind !== 'unknown') {
      const valid = Number.isSafeInteger(quantity.value) &&
        (quantity.kind === 'exact' ? quantity.value >= 0 : quantity.value > 0)
      if (!valid) throw new DomainError('INVALID_INPUT', 'Goal requirement quantity is invalid')
    }
  }
  const id = input.id ?? createId<GoalId>('goal')
  if (playthrough.goals[id]) {
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { goals: { ...playthrough.goals, [id]: goal } },
    'goal.create',
    [`goals.${id}`],
    at,
  )
}
