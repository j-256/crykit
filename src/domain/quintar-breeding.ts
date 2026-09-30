import { QUINTAR_BREEDING_STEP_IDS, type QuintarBreedingStepId } from '../catalog/quintar-breeding'
import { asTimestamp, assertExpectedRevision, DomainError, nowTimestamp, requirePlaythrough, updatePlaythrough } from './core'
import type { LocalData, PlaythroughId, Timestamp } from './types'

export interface ToggleQuintarStepInput {
  readonly stepId: QuintarBreedingStepId
  readonly playthroughId: PlaythroughId
  readonly expectedRevision?: number
  readonly now?: Timestamp | string
}

export function toggleQuintarStep(localData: LocalData, input: ToggleQuintarStepInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (!QUINTAR_BREEDING_STEP_IDS.has(input.stepId)) throw new DomainError('INVALID_INPUT', 'The quintar guide step does not exist')
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const quintarBreeding = { ...playthrough.quintarBreeding }
  if (Object.hasOwn(quintarBreeding, input.stepId)) delete quintarBreeding[input.stepId]
  else quintarBreeding[input.stepId] = at
  return updatePlaythrough(localData, playthrough.id, { quintarBreeding }, 'quintarBreeding.toggleStep', [`quintarBreeding.${input.stepId}`], at)
}
