import { assertExpectedRevision, DomainError } from './core'
import { createBuild, saveBuildRevision } from './builds'
import { saveBuildBehavior, type BuildBehavior } from './build-behavior'
import { saveTeam, type SaveTeamInput } from './teams'
import { buildContentForModSetup } from './build-mods'
import type { BuildId, BuildRevisionContent, BuildRevisionId, CatalogSnapshot, GameSetupRevisionId, LocalData } from './types'

export interface SaveTeamMemberInput {
  readonly team: SaveTeamInput
  readonly slotIndex: number
  readonly build?: { readonly id: BuildId; readonly revisionId: BuildRevisionId; readonly title: string; readonly tags: readonly string[] }
  readonly revision: BuildRevisionContent & { readonly behavior: BuildBehavior; readonly behaviorRevisionId?: GameSetupRevisionId; readonly note?: string }
  readonly sourceRevisionId?: BuildRevisionId
  readonly revisionId: BuildRevisionId
  readonly expectedRevision?: number
}

// Return one immutable candidate so persistence can commit or roll back the whole member edit
export function saveTeamMember(localData: LocalData, input: SaveTeamMemberInput, catalogs: readonly CatalogSnapshot[]): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (!Number.isInteger(input.slotIndex) || input.slotIndex < 0 || input.slotIndex >= input.team.slots.length) throw new DomainError('INVALID_INPUT', 'Choose an available Team slot')
  const source = input.sourceRevisionId ? localData.buildRevisions[input.sourceRevisionId] : undefined
  if (!input.build && !source) throw new DomainError('MISSING_BUILD_REVISION', 'The member checkpoint is unavailable')
  if (input.build && input.sourceRevisionId) throw new DomainError('INVALID_INPUT', 'Choose either a new member or an existing checkpoint')
  const { behavior, behaviorRevisionId, note, ...content } = input.revision
  const configured = saveBuildBehavior(localData, behavior, input.team.now, behaviorRevisionId)
  const buildId = input.build?.id ?? source!.buildId
  const created = input.build ? createBuild(configured.localData, { ...input.build, gameSetupId: configured.setup.gameSetupId, now: input.team.now, expectedRevision: configured.localData.revision }) : configured.localData
  const revised = saveBuildRevision(created, { buildId, id: input.revisionId, parentRevisionId: source?.id, gameSetupRevisionId: configured.setup.id, content: buildContentForModSetup(content, configured.setup, catalogs, behavior), note, now: input.team.now, expectedRevision: created.revision })
  const slots = input.team.slots.map((id, index) => index === input.slotIndex ? input.revisionId : id)
  return saveTeam(revised, { ...input.team, slots, expectedRevision: revised.revision })
}
