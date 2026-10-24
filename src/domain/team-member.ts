import { entityDefinitionKey, assertExpectedRevision, createId, DomainError, nowTimestamp } from './core'
import { saveSharedTeam, teamSlotForViewId } from './team-checkpoints'
import { saveBuildBehavior, sameBuildBehavior, type BuildBehavior } from './build-behavior'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import { type SaveTeamInput } from './teams'
import { buildContentForModSetup, buildModReferences, mapBuildModReferences } from './build-mods'
import type { BuildId, BuildRevisionContent, BuildRevisionId, CatalogSnapshot, GameSetupRevisionId, LocalData, TeamSlotCheckpointId } from './types'

export interface SaveTeamMemberInput {
  readonly team: SaveTeamInput
  readonly slotIndex: number
  readonly build?: { readonly id: BuildId; readonly revisionId: BuildRevisionId; readonly title: string; readonly tags: readonly string[] }
  readonly buildTitle?: string
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
  const owned = input.sourceRevisionId ? teamSlotForViewId(localData, input.sourceRevisionId) : undefined
  if (!input.build && !source && !owned) throw new DomainError('MISSING_BUILD_REVISION', 'The member checkpoint is unavailable')
  if (input.build && input.sourceRevisionId) throw new DomainError('INVALID_INPUT', 'Choose either a new member or an existing checkpoint')
  const { behavior, behaviorRevisionId, note, ...content } = input.revision
  const chosen = input.team.gameSetupRevisionId ? localData.gameSetups[input.team.gameSetupRevisionId] : undefined
  if (input.team.gameSetupRevisionId && !chosen) throw new DomainError('MISSING_GAME_SETUP', 'Choose an available shared Game Setup')
  const configured = chosen && sameBuildBehavior(behavior, chosen) ? { localData, setup: chosen } : saveBuildBehavior(localData, behavior, input.team.now, behaviorRevisionId)
  const previous = input.team.id ? localData.teams[input.team.id] : undefined
  if (previous?.kind === 'legacy-mixed' && !chosen) throw new DomainError('INVALID_INPUT', 'Choose a shared Game Setup before editing this historical Team')
  const revision = previous?.kind === 'shared' ? localData.teamRevisions[previous.latestRevisionId] : undefined
  // Member enable-and-select submits the explicitly confirmed shared setup with the whole Team candidate
  const at = input.team.now ?? nowTimestamp()
  const preserved = new Map(buildModReferences(owned?.content ?? source?.content ?? { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }).map(ref => [entityDefinitionKey(ref), ref]))
  // Rebind newly selected draft entries only; editing notes cannot reinterpret copied source selections
  const converted = buildContentForModSetup(content, configured.setup, catalogs, behavior)
  const conversions = new Map(buildModReferences(content).map((ref, index) => [entityDefinitionKey(ref), buildModReferences(converted)[index]!]))
  const memberContent = mapBuildModReferences(content, ref => ref && !preserved.has(entityDefinitionKey(ref)) ? conversions.get(entityDefinitionKey(ref)) ?? ref : ref)
  const name = (input.buildTitle ?? owned?.name ?? (source ? localData.builds[source.buildId]?.title : undefined) ?? input.build?.title ?? 'Team member').trim()
  if (!name || name.length > MAX_SHORT_TEXT_LENGTH) throw new DomainError('INVALID_INPUT', 'A member needs a bounded, nonempty name')
  // A name belongs to this immutable Team checkpoint, never to its source Build metadata
  const checkpoint = { id: createId<TeamSlotCheckpointId>('teamSlot'), name, content: memberContent, ...(source || owned?.sourceBuildRevisionId ? { sourceBuildRevisionId: source?.id ?? owned!.sourceBuildRevisionId } : {}), createdAt: typeof at === 'string' ? at as import('./types').Timestamp : at }
  const slots = input.team.slots.map((id, index) => index === input.slotIndex ? checkpoint : id ? teamSlotForViewId(localData, id) ?? id : null)
  return saveSharedTeam(configured.localData, { ...input.team, slots, gameSetupRevisionId: configured.setup.id, catalogLock: revision?.gameSetupRevisionId === configured.setup.id ? revision.catalogLock : configured.setup.catalogLock, note, expectedRevision: configured.localData.revision })
}
