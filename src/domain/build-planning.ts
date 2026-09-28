import { createId } from './core'
import { createBuild, saveBuildRevision, type CreateBuildInput } from './builds'
import { createRulesetRevision, updateRulesetRevision } from './profile'
import { equipmentRole } from './mechanics-facts'
import type { BuildId, BuildRevisionContent, BuildRevisionId, Profile, RulesetRevision, SlotDefinition, SlotId } from './types'

const EQUIPMENT_LABELS = ['Main hand', 'Off hand', 'Head', 'Body', 'Accessory 1', 'Accessory 2'] as const
export const SUGGESTED_BUILD_SLOTS: readonly SlotDefinition[] = [
  ...EQUIPMENT_LABELS.map((label, order): SlotDefinition => ({
    id: `plan-${label.toLowerCase().replaceAll(' ', '-')}` as SlotId,
    label, order, kind: 'equipment', provenance: 'suggested', sources: [],
    acceptedEntityKinds: { state: 'known', value: ['item'] },
    equipmentRole: equipmentRole({ id: `plan-${label.toLowerCase().replaceAll(' ', '-')}` as SlotId, kind: 'equipment' }),
  })),
]

export function ensureBuildPlanningRuleset(profile: Profile, catalogLock: RulesetRevision['catalogLock']): Profile {
  const current = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
  if (current?.slots.length) return profile
  const values = { slots: SUGGESTED_BUILD_SLOTS, catalogLock: { ...catalogLock, ...current?.catalogLock }, activate: true, expectedRevision: profile.revision }
  return current
    ? updateRulesetRevision(profile, { ...values, sourceRevisionId: current.id })
    : createRulesetRevision(profile, { ...values, label: 'Build planning' })
}

export function createBuildPlan(profile: Profile, input: CreateBuildInput & { readonly content: BuildRevisionContent; readonly catalogLock: RulesetRevision['catalogLock']; readonly revisionId?: BuildRevisionId; readonly note?: string }): Profile {
  const buildId = input.id ?? createId<BuildId>('build')
  const created = createBuild(profile, { ...input, id: buildId })
  const configured = ensureBuildPlanningRuleset(created, input.catalogLock)
  return saveBuildRevision(configured, {
    buildId, id: input.revisionId, content: input.content, note: input.note,
    rulesetRevisionId: configured.activeRulesetRevisionId!,
    expectedRevision: configured.revision,
  })
}
