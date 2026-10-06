import { asTimestamp, assertExpectedRevision, createId, DomainError, nowTimestamp, requirePlaythrough, updateLocalData } from './core'
import { captureCharacter } from './characters'
import { sameBuildBehavior } from './build-behavior'
import { createScenario, replaceScenarioBuild, TEAM_SIZE, updateScenario } from './scenarios'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import type { BuildRevisionId, CharacterId, LocalData, PlaythroughId, Team, TeamId, Timestamp } from './types'

export interface SaveTeamInput {
  readonly id?: TeamId
  readonly title: string
  readonly slots: readonly (BuildRevisionId | null)[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function saveTeam(localData: LocalData, input: SaveTeamInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const title = input.title.trim()
  if (!title || title.length > MAX_SHORT_TEXT_LENGTH) throw new DomainError('INVALID_INPUT', 'A Team needs a bounded, nonempty name')
  if (input.slots.length !== TEAM_SIZE) throw new DomainError('INVALID_INPUT', 'A Team has exactly four build slots')
  for (const id of input.slots) if (id && !localData.buildRevisions[id]) throw new DomainError('MISSING_BUILD_REVISION', 'A Team references an unavailable build checkpoint')
  const id = input.id ?? createId<TeamId>('team')
  const previous = localData.teams[id]
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const team: Team = { id, title, slots: [...input.slots], revision: previous ? previous.revision + 1 : 0, createdAt: previous?.createdAt ?? at, updatedAt: at }
  return updateLocalData(localData, { teams: { ...localData.teams, [id]: team } }, previous ? 'team.update' : 'team.create', [`teams.${id}`], at)
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
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function recordBuildForCharacter(localData: LocalData, input: RecordBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const character = playthrough.characters[input.characterId]
  const revision = localData.buildRevisions[input.buildRevisionId]
  if (!character) throw new DomainError('MISSING_CHARACTER', 'Choose a tracked character from this Playthrough')
  if (!revision) throw new DomainError('MISSING_BUILD_REVISION', 'The build checkpoint is unavailable')
  const setup = localData.gameSetups[revision.gameSetupRevisionId]
  if (!setup) throw new DomainError('MISSING_GAME_SETUP', 'The build Game Setup is unavailable')
  let next = localData
  const recorded = Object.values(playthrough.scenarios).find(scenario => scenario.kind === 'recordedCurrent' && scenario.memberIds.includes(character.id))
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
  if (!team || team.slots.length !== TEAM_SIZE || team.slots.some(id => !id || !localData.buildRevisions[id])) throw new DomainError('INVALID_INPUT', 'Choose a saved build for every Team slot before adopting it')
  if (input.characterIds.length !== TEAM_SIZE || new Set(input.characterIds).size !== TEAM_SIZE || input.characterIds.some(id => !playthrough.characters[id])) throw new DomainError('INVALID_INPUT', 'Match each Team slot to a different tracked character')
  const revisions = team.slots.map(id => localData.buildRevisions[id!]!)
  const first = revisions[0]!
  if (revisions.some(revision => !sameBuildBehavior(localData.gameSetups[first.gameSetupRevisionId], localData.gameSetups[revision.gameSetupRevisionId]))) throw new DomainError('INVALID_INPUT', 'The Team builds need compatible Game Setups before recording one party')
  let next = localData
  for (const previous of Object.values(playthrough.scenarios).filter(scenario => scenario.kind === 'recordedCurrent')) next = updateScenario(next, { playthroughId: playthrough.id, scenarioId: previous.id, kind: 'draft', now: input.now, expectedRevision: next.revision })
  for (const [index, characterId] of input.characterIds.entries()) next = recordBuildForCharacter(next, { playthroughId: playthrough.id, characterId, buildRevisionId: revisions[index]!.id, now: input.now, expectedRevision: next.revision })
  return createScenario(next, { playthroughId: playthrough.id, label: team.title, kind: 'recordedCurrent', memberIds: input.characterIds, gameSetupRevisionId: first.gameSetupRevisionId, catalogLock: first.catalogLock, assignments: Object.fromEntries(input.characterIds.map((id, index) => [id, revisions[index]!.id])), inventoryPolicy: { enforceStock: true, includeProtected: true }, activate: true, now: input.now, expectedRevision: next.revision })
}
