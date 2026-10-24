import { crystalEditPlanningRecord } from './crystal-edit-compatibility'
import { nativeSourceRecord } from './native-game'
import type { MechanicsDefinition } from './mechanics-facts'
import type { TruthValue } from './types'

const role = (value: unknown): TruthValue => value === true ? 'true' : value === false ? 'false' : 'unknown'

export function passiveRoles(definition: MechanicsDefinition): { automatic: TruthValue; learnable: TruthValue } {
  // Kind and historical learning annotations are display facts; only the effective source record grants either role
  const record = crystalEditPlanningRecord(definition) ?? nativeSourceRecord(definition)
  return { automatic: role(record?.IsInnate), learnable: role(record?.IsLearnable) }
}
