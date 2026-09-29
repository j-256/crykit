import { createId } from './core'
import { createBuild, saveBuildRevision, type CreateBuildInput } from './builds'
import { createGameSetupRevision, updateGameSetupRevision } from './local-data'
import { equipmentRole } from './mechanics-facts'
import type { BuildId, BuildRevisionContent, BuildRevisionId, LocalData, GameSetupRevision, SlotDefinition, SlotId } from './types'

const EQUIPMENT_LABELS = ['Main hand', 'Off hand', 'Head', 'Body', 'Accessory 1', 'Accessory 2'] as const
export const SUGGESTED_BUILD_SLOTS: readonly SlotDefinition[] = [
  ...EQUIPMENT_LABELS.map((label, order): SlotDefinition => ({
    id: `plan-${label.toLowerCase().replaceAll(' ', '-')}` as SlotId,
    label, order, kind: 'equipment', provenance: 'suggested', sources: [],
    acceptedEntityKinds: { state: 'known', value: ['item'] },
    equipmentRole: equipmentRole({ id: `plan-${label.toLowerCase().replaceAll(' ', '-')}` as SlotId, kind: 'equipment' }),
  })),
]

export function ensureBuildPlanningGameSetup(localData: LocalData, catalogLock: GameSetupRevision['catalogLock']): LocalData {
  const current = localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined
  if (current?.slots.length) return localData
  const values = { slots: SUGGESTED_BUILD_SLOTS, catalogLock: { ...catalogLock, ...current?.catalogLock }, activate: true, expectedRevision: localData.revision }
  return current
    ? updateGameSetupRevision(localData, { ...values, sourceRevisionId: current.id })
    : createGameSetupRevision(localData, { ...values, label: 'Build planning' })
}

export function createBuildPlan(localData: LocalData, input: Omit<CreateBuildInput, 'gameSetupId'> & { readonly content: BuildRevisionContent; readonly catalogLock: GameSetupRevision['catalogLock']; readonly revisionId?: BuildRevisionId; readonly note?: string }): LocalData {
  const buildId = input.id ?? createId<BuildId>('build')
  const configured = ensureBuildPlanningGameSetup(localData, input.catalogLock)
  const setupRevision = configured.gameSetups[configured.planningGameSetupRevisionId!]!
  const created = createBuild(configured, { ...input, id: buildId, gameSetupId: setupRevision.gameSetupId, expectedRevision: configured.revision })
  return saveBuildRevision(created, {
    buildId, id: input.revisionId, content: input.content, note: input.note,
    gameSetupRevisionId: setupRevision.id,
    expectedRevision: created.revision,
  })
}
