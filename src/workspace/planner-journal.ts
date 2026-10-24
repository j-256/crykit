import { migrateLocalData250 } from '../domain/team-checkpoints'
import { z } from 'zod'
import type { ChangeEntry, LocalData } from '../domain/types'
import type { PersistedHistoryEntry } from '../interchange/types'
import { NativeHistorySchema, NativeLocalDataSchema } from '../interchange/native-schema'
import { changedLocalData, historyEntry, jsonEqual } from '../persistence/local-data'
import { nowTimestamp } from '../interchange/util'
import type { WorkspacePlannerState } from './documents'

export const PlannerJournalSchema = z.strictObject({ version: z.literal(1), changes: NativeLocalDataSchema.shape.changes, checkpoints: z.array(NativeHistorySchema), undoable: z.boolean() })
export interface PlannerJournal { readonly version: 1; readonly changes: readonly ChangeEntry[]; readonly checkpoints: readonly PersistedHistoryEntry[]; readonly undoable: boolean }
export function connectedHistory(planner: WorkspacePlannerState): readonly PersistedHistoryEntry[] {
  const values = planner.journal?.checkpoints ?? planner.history
  const result: PersistedHistoryEntry[] = []
  let current = planner.localData
  for (;;) {
    const matches = values.filter(entry => entry.localDataId === current.id && entry.nextRevision === current.revision && jsonEqual(entry.after, current))
    if (matches.length !== 1) break
    const match = matches[0]
    if (match.previousRevision >= current.revision || match.previousRevision !== match.before.revision || result.some(value => value.id === match.id)) throw new Error('Invalid operative planner journal')
    result.unshift(match); current = match.before
  }
  return result
}
export function undoCheckpoint(planner: WorkspacePlannerState): PersistedHistoryEntry | undefined {
  return planner.journal?.undoable === false ? undefined : connectedHistory(planner).at(-1)
}
function mergeExact<T extends { readonly id: string }>(left: readonly T[], right: readonly T[]): T[] {
  const values = new Map(left.map(value => [value.id, value]))
  for (const value of right) { if (values.has(value.id) && !jsonEqual(values.get(value.id), value)) throw new Error('Immutable planner evidence changed'); values.set(value.id, value) }
  return [...values.values()]
}
export function savedChanges(planner: WorkspacePlannerState): readonly ChangeEntry[] { return planner.savedChanges ?? planner.localData.changes }
export function afterLocalCommand(before: WorkspacePlannerState, next: WorkspacePlannerState, checkpoint: PersistedHistoryEntry): WorkspacePlannerState {
  if (!before.journal) return next
  const originals = mergeExact(savedChanges(before), next.localData.changes.filter(change => change.previousRevision >= before.localData.revision))
  return { ...next, savedChanges: originals, journal: { version: 1, changes: next.localData.changes, checkpoints: [...connectedHistory(before), checkpoint], undoable: true } }
}
function semantic(data: LocalData): unknown {
  const { revision: _revision, updatedAt: _updatedAt, changes: _changes, selectedPlaythroughId: _selected, planningGameSetupRevisionId: _setup, ...value } = data
  return { ...value, playthroughs: Object.fromEntries(Object.entries(value.playthroughs).map(([id, playthrough]) => { const { revision: _revision, updatedAt: _updated, activeScenarioId: _active, ...semantic } = playthrough; return [id, semantic] })) }
}
function localPlaythroughClocks(current: LocalData | undefined, accepted: LocalData, timestamp: LocalData['updatedAt']): LocalData {
  return { ...accepted, playthroughs: Object.fromEntries(Object.entries(accepted.playthroughs).map(([id, value]) => {
    const previous = current?.playthroughs[id]
    const { revision: _revision, updatedAt: _updatedAt, activeScenarioId: _active, ...nextSemantic } = value
    const previousSemantic = previous && (({ revision: _revision, updatedAt: _updatedAt, activeScenarioId: _active, ...rest }) => rest)(previous)
    const changed = !jsonEqual(previousSemantic, nextSemantic)
    const floor = Object.values(value.scenarios).reduce((floor, scenario) => scenario.baseline.kind === 'recordedParty' ? Math.max(floor, scenario.baseline.playthroughRevision) : floor, 0)
    const revision = Math.max(floor, previous ? previous.revision + (changed ? 1 : 0) : 0)
    if (!Number.isSafeInteger(revision)) throw new Error('Playthrough projection revision overflow')
    return [id, { ...value, revision, updatedAt: changed ? timestamp : previous!.updatedAt }]
  })) }
}
export function projectPlanner(current: WorkspacePlannerState, accepted: WorkspacePlannerState, adopt: boolean): WorkspacePlannerState {
  const timestamp = nowTimestamp()
  // The accepted projection has already authenticated every baseline floor; preserve this device's causal clock
  accepted = { ...accepted, localData: localPlaythroughClocks(adopt ? undefined : current.localData, accepted.localData, timestamp) }
  const originals = mergeExact(savedChanges(current), savedChanges(accepted)), history = mergeExact(current.history, accepted.history)
  if (adopt) return { ...accepted, localData: { ...accepted.localData, revision: 0, changes: [] }, history, savedChanges: originals, journal: { version: 1, changes: [], checkpoints: [], undoable: false } }
  if (jsonEqual(semantic(current.localData), semantic(accepted.localData))) return { ...accepted, localData: { ...accepted.localData, revision: current.localData.revision, updatedAt: current.localData.updatedAt, changes: current.localData.changes }, history, savedChanges: originals, journal: current.journal ?? { version: 1, changes: current.localData.changes, checkpoints: [...connectedHistory(current)], undoable: !!undoCheckpoint(current) } }
  if (!Number.isSafeInteger(current.localData.revision + 1)) throw new Error('Planner projection revision overflow')
  const localData = changedLocalData(current.localData, accepted.localData, 'sync-projection', timestamp)
  const checkpoint = historyEntry(current.localData, localData, 'sync-projection', timestamp)
  // Pull transitions are truthful local evidence, never new remote semantic history or undo authority
  return { ...accepted, localData, history, savedChanges: originals, journal: { version: 1, changes: localData.changes, checkpoints: [...connectedHistory(current), checkpoint], undoable: false } }
}

// Original history stays inert; only the separately owned undo endpoints acquire the live domain shape
export function migratePlanner250(planner: WorkspacePlannerState): WorkspacePlannerState {
  if (String(planner.localData.schemaVersion) === '2.5.0') return planner
  const checkpoints = connectedHistory(planner).map(entry => ({ ...entry, before: migrateLocalData250(entry.before, planner.catalogs), after: migrateLocalData250(entry.after, planner.catalogs) }))
  return { ...planner, localData: migrateLocalData250(planner.localData, planner.catalogs), journal: { version: 1, changes: planner.localData.changes, checkpoints, undoable: planner.journal?.undoable ?? checkpoints.length > 0 } }
}
