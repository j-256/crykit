import { publicContextForNoteEdit, publicContextForContent } from './public-source-context'
import { assertRetainedSelections, retainOutOfContextSelections, retainedSelectionRefs } from './retained-selections'
import { createBuild, saveBuildRevision } from './builds'
import { withBuildReferenceNames } from './build-reference-names'
import { asTimestamp, assertExpectedRevision, createId, DomainError, entityDefinitionKey, nowTimestamp, updateLocalData } from './core'
import { buildModReferences } from './build-references'
import { sameBuildBehavior } from './build-behavior'
import { checkpointContentDigest } from './checkpoint-identity'
import { sameValue } from './definition-values'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import { NativeLocalDataSchema, StoredPre250LocalDataSchema } from '../interchange/native-schema'
import { validateNativeLocalDataGraph } from '../interchange/native'
import type { BuildRevisionId, CatalogRevisionId, CatalogSnapshot, CheckpointRef, GameSetupRevisionId, LocalData, TeamId, TeamRevision, TeamRevisionId, TeamSlotCheckpoint, TeamSlotCheckpointId, Timestamp } from './types'

export const TEAM_SLOT_COUNT = 4

export function resolveCheckpoint(localData: LocalData, ref: CheckpointRef) {
  const revision = ref.kind === 'build' ? localData.buildRevisions[ref.revisionId] : localData.teamRevisions[ref.teamRevisionId]
  if (!revision) throw new DomainError('MISSING_BUILD_REVISION', 'The checkpoint is unavailable')
  const content = ref.kind === 'build' ? localData.buildRevisions[ref.revisionId]!.content : localData.teamRevisions[ref.teamRevisionId]!.slots[ref.slot]?.content
  const setup = localData.gameSetups[revision.gameSetupRevisionId]
  if (!content || !setup) throw new DomainError('INVALID_INPUT', 'The checkpoint content or Game Setup is unavailable')
  return { content, setup, catalogLock: revision.catalogLock }
}

export interface SaveSharedTeamInput {
  readonly id?: TeamId
  readonly title: string
  readonly gameSetupRevisionId: GameSetupRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly slots: readonly (BuildRevisionId | TeamSlotCheckpoint | null)[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
  readonly note?: string
}

export function saveSharedTeam(localData: LocalData, input: SaveSharedTeamInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const title = input.title.trim()
  if (!title || title.length > MAX_SHORT_TEXT_LENGTH) throw new DomainError('INVALID_INPUT', 'A Team needs a bounded, nonempty name')
  const setup = localData.gameSetups[input.gameSetupRevisionId]
  if (!setup || input.slots.length !== TEAM_SLOT_COUNT) throw new DomainError('INVALID_INPUT', 'A shared Team needs an explicit Game Setup and exactly four slots')
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const id = input.id ?? createId<TeamId>('team')
  const previous = localData.teams[id]
  const slots = input.slots.map(slot => {
    if (slot === null) return null
    if (typeof slot !== 'string') return { ...structuredClone(slot), content: retainOutOfContextSelections(localData, structuredClone(slot.content), setup, input.catalogLock ?? setup.catalogLock) }
    const source = localData.buildRevisions[slot]
    if (!source) throw new DomainError('MISSING_BUILD_REVISION', 'The source Build checkpoint is unavailable')
    // A Team captures content and lineage, never a writable alias to its source Build
    return { id: createId<TeamSlotCheckpointId>('teamSlot'), name: localData.builds[source.buildId]!.title, content: retainOutOfContextSelections(localData, structuredClone(source.content), setup, input.catalogLock ?? setup.catalogLock), sourceBuildRevisionId: source.id, createdAt: at }
  })
  const previousCheckpoint = previous?.kind === 'shared' ? localData.teamRevisions[previous.latestRevisionId] : undefined
  const publicSourceContext = publicContextForNoteEdit(previousCheckpoint, setup, slots.map(slot => slot?.content ?? null))
  const catalogLock = { ...(input.catalogLock ?? setup.catalogLock) }
  const slotIds = new Set<string>()
  for (const slot of slots) {
    if (!slot) continue
    if (slot.name !== undefined && (!slot.name.trim() || slot.name.length > MAX_SHORT_TEXT_LENGTH)) throw new DomainError('INVALID_INPUT', 'A member needs a bounded, nonempty name')
    if (slotIds.has(slot.id)) throw new DomainError('INVALID_INPUT', 'Each occupied Team slot needs its own identity')
    slotIds.add(slot.id)
    if (slot.sourceBuildRevisionId && !localData.buildRevisions[slot.sourceBuildRevisionId]) throw new DomainError('MISSING_BUILD_REVISION', 'The source Build checkpoint is unavailable')
    assertRetainedSelections(localData, slot.content, setup, catalogLock)
    const retained = retainedSelectionRefs(slot.content)
    for (const ref of buildModReferences(slot.content)) {
      if (ref.kind === 'catalog' && !retained.has(entityDefinitionKey(ref)) && catalogLock[ref.catalogId] !== ref.catalogRevisionId) throw new DomainError('INVALID_INPUT', 'The Team selection does not match its shared catalog pins')
      if (ref.kind === 'personal' && !localData.personalDefinitions[ref.definitionId] && !localData.unavailableDefinitions?.some(receipt => entityDefinitionKey(receipt.ref) === entityDefinitionKey(ref))) throw new DomainError('INVALID_INPUT', 'The Team selection has no definition or unavailable receipt')
    }
    if (Object.keys(slot.content.equipment).some(id => !setup.slots.some(slot => slot.id === id) && slot.content.equipment[id] !== null && !slot.content.retainedSelections?.slotIds.includes(id as import('./types').SlotId))) throw new DomainError('INVALID_INPUT', 'The Team selection uses an unavailable equipment slot')
  }
  const revision: TeamRevision = { id: createId<TeamRevisionId>('teamRevision'), teamId: id, revision: previous?.kind === 'shared' ? localData.teamRevisions[previous.latestRevisionId]!.revision + 1 : 0,
    ...(previous?.kind === 'shared' ? { parentRevisionId: previous.latestRevisionId } : {}), gameSetupRevisionId: setup.id, catalogLock, slots, ...(publicSourceContext ? { publicSourceContext } : {}), createdAt: at, ...(input.note === undefined ? {} : { note: input.note }) }
  const team = { id, kind: 'shared' as const, title, latestRevisionId: revision.id, revision: previous ? previous.revision + 1 : 0, createdAt: previous?.createdAt ?? at, updatedAt: at }
  return updateLocalData(localData, { teams: { ...localData.teams, [id]: team }, teamRevisions: { ...localData.teamRevisions, [revision.id]: revision } }, previous ? 'team.update' : 'team.create', [`teams.${id}`, `teamRevisions.${revision.id}`], at)
}

// Equal display labels never establish equality, and each Build owns independent exact catalog pins
export function equivalentTeamSetup(localData: Pick<LocalData, 'gameSetups' | 'buildRevisions'>, slots: readonly (BuildRevisionId | null)[]) {
  const revisions = slots.flatMap(id => id ? [localData.buildRevisions[id]] : [])
  if (!revisions.length || revisions.some(value => !value)) return undefined
  const first = revisions[0]!
  return revisions.every(value => sameBuildBehavior(localData.gameSetups[first.gameSetupRevisionId], localData.gameSetups[value!.gameSetupRevisionId]) && sameValue(first.catalogLock, value!.catalogLock)) ? first : undefined
}

export function migrateLocalData250(value: unknown, catalogs: readonly CatalogSnapshot[]): LocalData {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === '2.5.0') {
    const current = NativeLocalDataSchema.parse(value) as unknown as LocalData
    validateNativeLocalDataGraph(current, catalogs)
    return current
  }
  const original = StoredPre250LocalDataSchema.parse(value)
  // Validate the original graph before copying so migration cannot conceal missing or foreign lineage
  validateNativeLocalDataGraph(original as unknown as LocalData, catalogs)
  const teamRevisions: Record<string, TeamRevision> = {}
  const teams: Record<string, LocalData['teams'][string]> = {}
  for (const team of Object.values(original.teams)) {
    const equivalent = equivalentTeamSetup(original as unknown as LocalData, team.slots as (BuildRevisionId | null)[])
    if (!equivalent) { teams[team.id] = { ...team, kind: 'legacy-mixed' } as unknown as LocalData['teams'][string]; continue }
    // Historical endpoints may contain different contents for one legacy Team identity
    // Include the exact captured content and context so immutable IDs remain stable without aliasing those endpoints
    const revisionId = `teamMigration:${checkpointContentDigest({ team, setup: equivalent.gameSetupRevisionId, catalogLock: equivalent.catalogLock, slots: team.slots.map(id => id ? original.buildRevisions[id]!.content : null) })}` as TeamRevisionId
    const slots = team.slots.map((sourceId, index) => sourceId ? { id: `slot:${index}` as TeamSlotCheckpointId, content: structuredClone(original.buildRevisions[sourceId]!.content), sourceBuildRevisionId: sourceId as BuildRevisionId, createdAt: team.updatedAt as Timestamp } : null)
    teamRevisions[revisionId] = { id: revisionId, teamId: team.id as TeamId, revision: 0, gameSetupRevisionId: equivalent.gameSetupRevisionId, catalogLock: { ...equivalent.catalogLock }, slots: slots as TeamRevision['slots'], createdAt: team.updatedAt as Timestamp }
    const { slots: _slots, ...metadata } = team
    teams[team.id] = { ...metadata, kind: 'shared', latestRevisionId: revisionId } as LocalData['teams'][string]
  }
  const refs = (assignments: Readonly<Record<string, string | null>>) => Object.fromEntries(Object.entries(assignments).map(([id, revisionId]) => [id, revisionId === null ? null : { kind: 'build' as const, revisionId }]))
  const result = { ...original, schemaVersion: '2.5.0', teams, teamRevisions, playthroughs: Object.fromEntries(Object.entries(original.playthroughs).map(([id, playthrough]) => [id, { ...playthrough, scenarios: Object.fromEntries(Object.entries(playthrough.scenarios).map(([id, scenario]) => [id, { ...scenario, assignments: refs(scenario.assignments), baseline: scenario.baseline.kind === 'recordedParty' ? { ...scenario.baseline, assignments: refs(scenario.baseline.assignments) } : scenario.baseline }])) }])) }
  const next = NativeLocalDataSchema.parse(result) as unknown as LocalData
  validateNativeLocalDataGraph(next, catalogs)
  return next
}

// Compatibility view only: no caller may persist these Build-shaped Team slots or update their source Builds
export function checkpointBuildView(localData: LocalData, ref: CheckpointRef): import('./types').BuildRevision | undefined {
  if (ref.kind === 'build') return localData.buildRevisions[ref.revisionId]
  const revision = localData.teamRevisions[ref.teamRevisionId]
  const slot = revision?.slots[ref.slot]
  if (!revision || !slot) return undefined
  const source = slot.sourceBuildRevisionId ? localData.buildRevisions[slot.sourceBuildRevisionId] : undefined
  return { id: teamSlotViewId(revision.id, ref.slot), buildId: source?.buildId ?? revision.teamId as unknown as import('./types').BuildId, revision: revision.revision, gameSetupRevisionId: revision.gameSetupRevisionId, catalogLock: revision.catalogLock, ...(revision.publicSourceContext ? { publicSourceContext: publicContextForContent(revision.publicSourceContext, slot.content) } : {}), content: slot.content, createdAt: slot.createdAt, ...(slot.note !== undefined ? { note: slot.note } : {}) }
}

export function teamSlotViewId(revisionId: TeamRevisionId, slot: number): BuildRevisionId {
  return JSON.stringify(['team-slot', revisionId, slot]) as BuildRevisionId
}

export function teamSlots(localData: LocalData, team: LocalData['teams'][string]): readonly (BuildRevisionId | null)[] {
  if (team.kind === 'legacy-mixed') return team.slots
  const revision = localData.teamRevisions[team.latestRevisionId]
  if (!revision) throw new DomainError('INVALID_INPUT', 'The Team checkpoint is unavailable')
  return revision.slots.map((slot, index) => slot ? teamSlotViewId(revision.id, index) : null)
}

export function teamSlotForViewId(localData: LocalData, id: BuildRevisionId): TeamSlotCheckpoint | undefined {
  // Presentation IDs contain their exact revision and slot, so rendering names need not scan Team history
  try {
    const parts: unknown = JSON.parse(id)
    if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== 'team-slot' || typeof parts[1] !== 'string' || !Number.isInteger(parts[2]) || parts[2] < 0 || parts[2] >= TEAM_SLOT_COUNT) return undefined
    const revision = localData.teamRevisions[parts[1]]
    return revision && teamSlotViewId(revision.id, parts[2]) === id ? revision.slots[parts[2]] ?? undefined : undefined
  } catch { return undefined }
}

export function teamMemberName(localData: LocalData, id: BuildRevisionId, fallback = 'Team member'): string {
  const owned = teamSlotForViewId(localData, id)
  const revision = localData.buildRevisions[id]
  return owned?.name ?? (revision ? localData.builds[revision.buildId]?.title : undefined) ?? fallback
}

export function withTeamBuildViews(localData: LocalData): LocalData {
  const buildRevisions = { ...localData.buildRevisions }
  for (const revision of Object.values(localData.teamRevisions)) for (const [index, slot] of revision.slots.entries()) {
    if (!slot) continue
    const view = checkpointBuildView(localData, { kind: 'team-slot', teamRevisionId: revision.id, slot: index as 0 | 1 | 2 | 3 })!
    if (buildRevisions[view.id]) throw new DomainError('INVALID_INPUT', 'A Build identity collides with a Team presentation identity')
    buildRevisions[view.id] = view
  }
  return { ...localData, buildRevisions }
}

export function saveTeamCheckpoint(localData: LocalData, input: { readonly teamId?: TeamId; readonly title: string; readonly setupRevisionId: GameSetupRevisionId; readonly slots: readonly (TeamSlotCheckpoint | null)[]; readonly expectedRevision: number; readonly now?: Timestamp }): LocalData {
  return saveSharedTeam(localData, { ...input, id: input.teamId, gameSetupRevisionId: input.setupRevisionId })
}

export function addBuildToTeam(localData: LocalData, input: { readonly teamId: TeamId; readonly slot: 0 | 1 | 2 | 3; readonly sourceRevisionId: BuildRevisionId; readonly expectedRevision: number }, catalogs: readonly CatalogSnapshot[]): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const team = localData.teams[input.teamId]
  if (!team || team.kind !== 'shared') throw new DomainError('INVALID_INPUT', 'Choose a shared Game Setup before adding a member')
  const revision = localData.teamRevisions[team.latestRevisionId]!
  const source = localData.buildRevisions[input.sourceRevisionId]
  if (!source) throw new DomainError('MISSING_BUILD_REVISION', 'The source Build checkpoint is unavailable')
  const slots = revision.slots.map((slot, index) => index === input.slot ? { id: createId<TeamSlotCheckpointId>('teamSlot'), name: localData.builds[source.buildId]!.title, sourceBuildRevisionId: source.id, createdAt: nowTimestamp(), content: withBuildReferenceNames(structuredClone(source.content), catalogs) } : slot)
  return saveSharedTeam(localData, { id: team.id, title: team.title, gameSetupRevisionId: revision.gameSetupRevisionId, catalogLock: revision.catalogLock, slots, expectedRevision: input.expectedRevision })
}

export function changeTeamSetup(localData: LocalData, input: { readonly teamId: TeamId; readonly setupRevisionId: GameSetupRevisionId; readonly expectedRevision: number }, catalogs: readonly CatalogSnapshot[]): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const team = localData.teams[input.teamId]
  if (!team) throw new DomainError('INVALID_INPUT', 'The Team is unavailable')
  const slots = team.kind === 'shared' ? localData.teamRevisions[team.latestRevisionId]!.slots.map(slot => slot ? { ...slot, content: withBuildReferenceNames(slot.content, catalogs) } : null) : team.slots
  return saveSharedTeam(localData, { id: team.id, title: team.title, gameSetupRevisionId: input.setupRevisionId, slots, expectedRevision: input.expectedRevision })
}

export function saveTeamSlotAsBuild(localData: LocalData, input: { readonly teamRevisionId: TeamRevisionId; readonly slot: 0 | 1 | 2 | 3; readonly title: string; readonly expectedRevision: number }): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const resolved = resolveCheckpoint(localData, { kind: 'team-slot', teamRevisionId: input.teamRevisionId, slot: input.slot })
  const id = createId<import('./types').BuildId>('build')
  const next = createBuild(localData, { id, title: input.title, gameSetupId: resolved.setup.gameSetupId, expectedRevision: input.expectedRevision })
  return saveBuildRevision(next, { buildId: id, gameSetupRevisionId: resolved.setup.id, catalogLock: resolved.catalogLock, content: structuredClone(resolved.content), expectedRevision: next.revision })
}
