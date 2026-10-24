import { asTimestamp, assertExpectedRevision, DomainError, nowTimestamp, requirePlaythrough, updateLocalData } from './core'
import { equivalentTeamSetup, saveSharedTeam, teamSlotForViewId, teamSlots, checkpointBuildView } from './team-checkpoints'
import { captureCharacter } from './characters'
import { saveBuildBehavior, sameBuildBehavior, type BuildBehavior } from './build-behavior'
import { createScenario, replaceScenarioBuild, TEAM_SIZE, updateScenario } from './scenarios'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import type { BuildRevisionId, CharacterId, LocalData, PlaythroughId, TeamId, Timestamp, GameSetupRevisionId, CheckpointRef } from './types'

export interface SaveTeamInput {
  readonly id?: TeamId
  readonly title: string
  readonly gameSetupRevisionId?: GameSetupRevisionId
  readonly behavior?: BuildBehavior
  readonly slots: readonly (BuildRevisionId | null)[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function saveTeam(localData: LocalData, input: SaveTeamInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const title = input.title.trim()
  if (!title || title.length > MAX_SHORT_TEXT_LENGTH) throw new DomainError('INVALID_INPUT', 'A Team needs a bounded, nonempty name')
  if (input.slots.length !== TEAM_SIZE) throw new DomainError('INVALID_INPUT', 'A Team has exactly four build slots')
  for (const id of input.slots) if (id && !localData.buildRevisions[id] && !teamSlotForViewId(localData, id)) throw new DomainError('MISSING_BUILD_REVISION', 'The source Build checkpoint is unavailable')
  const requested = input.gameSetupRevisionId ? localData.gameSetups[input.gameSetupRevisionId] : undefined
  const configured = input.behavior ? requested && sameBuildBehavior(requested, input.behavior) ? { localData, setup: requested } : saveBuildBehavior(localData, input.behavior, input.now) : undefined
  const base = configured?.localData ?? localData
  const previous = input.id ? localData.teams[input.id] : undefined
  if (previous?.kind === 'legacy-mixed' && !input.gameSetupRevisionId) throw new DomainError('INVALID_INPUT', 'Choose a shared Game Setup before editing this historical Team')
  const previousRevision = previous?.kind === 'shared' ? localData.teamRevisions[previous.latestRevisionId] : undefined
  const equivalent = equivalentTeamSetup(localData, input.slots)
  const setupId = configured?.setup.id ?? input.gameSetupRevisionId ?? previousRevision?.gameSetupRevisionId ?? equivalent?.gameSetupRevisionId
  if (!setupId) throw new DomainError('INVALID_INPUT', 'Choose a shared Game Setup before saving this Team')
  const slots = input.slots.map(id => id ? teamSlotForViewId(localData, id) ?? id : null)
  return saveSharedTeam(base, { ...input, expectedRevision: base.revision, gameSetupRevisionId: setupId, catalogLock: (previousRevision?.gameSetupRevisionId === setupId ? previousRevision.catalogLock : undefined) ?? (equivalent?.gameSetupRevisionId === setupId ? equivalent.catalogLock : undefined), slots })
}

export function deleteTeam(localData: LocalData, input: { readonly teamId: TeamId; readonly expectedRevision?: number; readonly now?: Timestamp | string }): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (!localData.teams[input.teamId]) throw new DomainError('INVALID_INPUT', 'The Team is unavailable')
  const teams = { ...localData.teams }
  delete teams[input.teamId]
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  // Team pins are independent of saved Builds and Playthrough records
  return updateLocalData(localData, { teams }, 'team.delete', [`teams.${input.teamId}`], at)
}

export interface RecordBuildInput {
  readonly playthroughId?: PlaythroughId
  readonly characterId: CharacterId
  readonly buildRevisionId: BuildRevisionId
  readonly checkpoint?: CheckpointRef
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function recordBuildForCharacter(localData: LocalData, input: RecordBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const character = playthrough.characters[input.characterId]
  const revision = input.checkpoint ? checkpointBuildView(localData, input.checkpoint) : localData.buildRevisions[input.buildRevisionId]
  if (!character) throw new DomainError('MISSING_CHARACTER', 'Choose a tracked character from this Playthrough')
  if (!revision) throw new DomainError('MISSING_BUILD_REVISION', 'The build checkpoint is unavailable')
  const setup = localData.gameSetups[revision.gameSetupRevisionId]
  if (!setup) throw new DomainError('MISSING_GAME_SETUP', 'The build Game Setup is unavailable')
  let next = localData
  const recorded = input.checkpoint ? undefined : Object.values(playthrough.scenarios).find(scenario => scenario.kind === 'recordedCurrent' && scenario.memberIds.includes(character.id))
  if (recorded) {
    next = sameBuildBehavior(localData.gameSetups[recorded.gameSetupRevisionId], setup)
      ? replaceScenarioBuild(next, { playthroughId: playthrough.id, scenarioId: recorded.id, characterId: character.id, buildRevisionId: revision.id, now: input.now, expectedRevision: next.revision })
      : updateScenario(next, { playthroughId: playthrough.id, scenarioId: recorded.id, kind: 'draft', now: input.now, expectedRevision: next.revision })
  }
  const snapshot = character.currentSnapshotId ? character.snapshots[character.currentSnapshotId] : undefined
  const equipment = Object.fromEntries([...setup.slots.map(slot => [slot.id, null] as const), ...Object.entries(revision.content.equipment).map(([id, selection]) => [id, selection?.ref ?? null] as const)])
  return captureCharacter(next, { playthroughId: playthrough.id, characterId: character.id, gameSetupRevisionId: setup.id, level: snapshot?.level ?? { state: 'unknown' }, primaryClass: revision.content.primaryClass ? { state: 'known', value: revision.content.primaryClass } : { state: 'unknown' }, secondaryClass: revision.content.secondaryClass ? { state: 'known', value: revision.content.secondaryClass } : { state: 'notApplicable' }, equipment, passives: { state: 'known', value: revision.content.passives.map(selection => selection.ref) }, calculation: revision.content.calculation, note: `Recorded build checkpoint: ${localData.builds[revision.buildId]?.title ?? 'Build'} r${revision.revision}. Displayed stats need recapture.`, now: input.now, expectedRevision: next.revision })
}

export function adoptTeam(localData: LocalData, input: { readonly teamId: TeamId; readonly playthroughId?: PlaythroughId; readonly characterIds: readonly CharacterId[]; readonly expectedRevision?: number; readonly now?: Timestamp | string }): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const team = localData.teams[input.teamId]
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  if (!team || team.kind !== 'shared') throw new DomainError('INVALID_INPUT', 'Choose a shared Game Setup before adopting this historical Team')
  const slots = teamSlots(localData, team)
  if (slots.some(id => !id)) throw new DomainError('INVALID_INPUT', 'Choose a saved build for every Team slot before adopting it')
  if (input.characterIds.length !== TEAM_SIZE || new Set(input.characterIds).size !== TEAM_SIZE || input.characterIds.some(id => !playthrough.characters[id])) throw new DomainError('INVALID_INPUT', 'Match each Team slot to a different tracked character')
  const refs: CheckpointRef[] = slots.map((_, index) => ({ kind: 'team-slot', teamRevisionId: team.latestRevisionId, slot: index as 0 | 1 | 2 | 3 }))
  const revisions = refs.map(ref => checkpointBuildView(localData, ref)!)
  const first = revisions[0]!
  let next = localData
  for (const previous of Object.values(playthrough.scenarios).filter(scenario => scenario.kind === 'recordedCurrent')) next = updateScenario(next, { playthroughId: playthrough.id, scenarioId: previous.id, kind: 'draft', now: input.now, expectedRevision: next.revision })
  for (const [index, characterId] of input.characterIds.entries()) next = recordBuildForCharacter(next, { playthroughId: playthrough.id, characterId, buildRevisionId: revisions[index]!.id, checkpoint: refs[index], now: input.now, expectedRevision: next.revision })
  return createScenario(next, { playthroughId: playthrough.id, label: team.title, kind: 'recordedCurrent', memberIds: input.characterIds, gameSetupRevisionId: first.gameSetupRevisionId, catalogLock: first.catalogLock, assignments: Object.fromEntries(input.characterIds.map((id, index) => [id, refs[index]!])), inventoryPolicy: { enforceStock: true, includeProtected: true }, activate: true, now: input.now, expectedRevision: next.revision })
}
