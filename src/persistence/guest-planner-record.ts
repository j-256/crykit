import { guestPlannerValuesEqual } from './guest-planner-equality'
export { guestPlannerValuesEqual } from './guest-planner-equality'
import { z } from 'zod'
import type { ChangeEntry, LocalData, LocalDataId } from '../domain/types'
import type { PersistedHistoryEntry } from '../interchange/types'
import { NativeHistorySchema, NativeLineageSchema, NativeLocalDataSchema, NativeLocalData240Schema } from '../interchange/native-schema'
import type { PlannerJournal } from '../workspace/planner-journal'
import type { LocalDataRecord, MetaRecord } from './database'

export const GUEST_PLANNER_ROOT_KEY = 'local-data-record'
export const GUEST_PLANNER_LAYOUT_KEY = 'guest-planner-layout-v1'
export interface OperativePlannerDescriptorV1 {
  readonly version: 1
  readonly kind: 'guest-operative-planner'
  readonly epoch: string
  readonly localDataId: LocalDataId
  readonly revision: number
  readonly checkpointIds: readonly string[]
  readonly savedDestinationChanges: readonly ChangeEntry[]
  readonly undoable: boolean
}
const safeCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const descriptorSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('guest-operative-planner'), epoch: z.string().min(1),
  localDataId: NativeLocalDataSchema.shape.id, revision: safeCounter,
  checkpointIds: z.array(NativeHistorySchema.shape.id),
  savedDestinationChanges: z.array(NativeLocalDataSchema.shape.changes.element), undoable: z.boolean(),
})
const declarationSchema = z.strictObject({ version: z.literal(1), kind: z.literal('guest-journaled-planner'), epoch: z.string().min(1) })
const rootSchema = z.strictObject({
  id: z.literal(GUEST_PLANNER_ROOT_KEY), revision: safeCounter, updatedAt: NativeLocalDataSchema.shape.updatedAt,
  localData: NativeLocalDataSchema, lineage: NativeLineageSchema, operativePlanner: descriptorSchema,
})
// Operative values must already use the current domain format; native import migration would silently change exact endpoints
const checkpointSchema = NativeHistorySchema.extend({ before: NativeLocalDataSchema, after: NativeLocalDataSchema })

export function mergeGuestPlannerEvidence<T>(groups: readonly (readonly T[])[], identity: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const group of groups) for (const value of group) {
    const key = identity(value)
    if (result.has(key) && !guestPlannerValuesEqual(result.get(key), value)) throw new Error('Immutable guest planner evidence changed')
    if (!result.has(key)) result.set(key, value)
  }
  return [...result.values()]
}
function validateChanges(changes: readonly ChangeEntry[], revision?: number): void {
  let previous: number | undefined
  const ids = new Set<string>()
  for (const change of changes) {
    NativeLocalDataSchema.shape.changes.element.parse(change)
    if (ids.has(change.id) || !Number.isSafeInteger(change.previousRevision + 1) || change.nextRevision !== change.previousRevision + 1 || revision !== undefined && previous !== undefined && change.previousRevision !== previous) throw new Error('Invalid guest planner change sequence')
    ids.add(change.id); previous = change.nextRevision
  }
  if (revision !== undefined && previous !== undefined && previous !== revision) throw new Error('Guest planner changes do not reach the root')
}
function validateLocalCounters(localData: LocalData): void {
  validateChanges(localData.changes, localData.revision)
  for (const playthrough of Object.values(localData.playthroughs)) for (const scenario of Object.values(playthrough.scenarios)) {
    if (scenario.baseline.kind === 'recordedParty' && scenario.baseline.playthroughRevision > playthrough.revision) throw new Error('Guest planner baseline exceeds its playthrough clock')
  }
}
export type ValidatedGuestPlanner = { readonly format: 'legacy' } | {
  readonly format: 'journaled'
  readonly descriptor: OperativePlannerDescriptorV1
  readonly journal: PlannerJournal
}

/** Validates format and exact operative association; catalog/body graph validation remains the caller's separate obligation */
export function validateGuestPlannerRecord(record: LocalDataRecord, declaration: MetaRecord | undefined, history: readonly PersistedHistoryEntry[], required: 'legacy-or-journaled' | 'journaled', frozen240 = false): ValidatedGuestPlanner {
  const rootReader = frozen240 ? rootSchema.extend({ localData: NativeLocalData240Schema }) : rootSchema
  const checkpointReader = frozen240 ? checkpointSchema.extend({ before: NativeLocalData240Schema, after: NativeLocalData240Schema }) : checkpointSchema
  const hasDescriptor = Object.hasOwn(record, 'operativePlanner')
  if (!hasDescriptor && declaration === undefined && required === 'legacy-or-journaled') {
    rootReader.omit({ operativePlanner: true }).parse(record)
    if (record.revision !== record.localData.revision || record.updatedAt !== record.localData.updatedAt) throw new Error('Legacy guest planner wrapper mismatch')
    validateLocalCounters(record.localData)
    return { format: 'legacy' }
  }
  if (!hasDescriptor || declaration === undefined) throw new Error('Missing guest planner format declaration or descriptor')
  rootReader.parse(record)
  z.strictObject({ key: z.literal(GUEST_PLANNER_LAYOUT_KEY), value: z.string() }).parse(declaration)
  const layout = declarationSchema.parse(JSON.parse(declaration.value)), descriptor = record.operativePlanner!
  if (descriptor.epoch !== layout.epoch || descriptor.localDataId !== record.localData.id || descriptor.revision !== record.revision || record.revision !== record.localData.revision || record.updatedAt !== record.localData.updatedAt) throw new Error('Guest planner identity or revision mismatch')
  validateLocalCounters(record.localData)
  validateChanges(descriptor.savedDestinationChanges)
  if (descriptor.savedDestinationChanges.some(change => change.nextRevision > record.revision)) throw new Error('Guest destination evidence exceeds its root revision')
  const knownChanges = new Map(descriptor.savedDestinationChanges.map(change => [change.id, change]))
  // Live destination entries require explicit saved coverage; a conflict-free union cannot prove completeness
  for (const change of record.localData.changes) {
    if (!knownChanges.has(change.id) || !guestPlannerValuesEqual(knownChanges.get(change.id), change)) throw new Error('Guest destination evidence does not cover a live change')
  }
  const byId = new Map<string, PersistedHistoryEntry>()
  for (const entry of history) {
    if (byId.has(entry.id)) throw new Error('Duplicate guest planner history identity')
    byId.set(entry.id, entry)
  }
  if (new Set(descriptor.checkpointIds).size !== descriptor.checkpointIds.length || !descriptor.checkpointIds.length && descriptor.undoable) throw new Error('Invalid guest planner operative membership')
  const checkpoints: PersistedHistoryEntry[] = []
  for (const id of descriptor.checkpointIds) {
    const entry = byId.get(id)
    if (!entry) throw new Error('Missing guest planner checkpoint')
    checkpointReader.parse(entry)
    if (entry.localDataId !== record.localData.id || entry.before.id !== record.localData.id || entry.after.id !== record.localData.id || entry.previousRevision !== entry.before.revision || entry.nextRevision !== entry.after.revision || entry.previousRevision >= entry.nextRevision) throw new Error('Invalid guest planner checkpoint identity or revision')
    validateLocalCounters(entry.before); validateLocalCounters(entry.after)
    // Only declared operative snapshots constrain these identities; unlisted imported branches remain inert
    // Older snapshot entries establish consistency, not completeness of all prior destination evidence
    for (const change of [...entry.before.changes, ...entry.after.changes]) {
      if (knownChanges.has(change.id) && !guestPlannerValuesEqual(knownChanges.get(change.id), change)) throw new Error('Immutable guest planner operative change changed')
      knownChanges.set(change.id, change)
    }
    const prior = checkpoints.at(-1)
    if (prior && !guestPlannerValuesEqual(prior.after, entry.before)) throw new Error('Disconnected guest planner checkpoint')
    checkpoints.push(entry)
  }
  const endpoint = checkpoints.at(-1)
  if (endpoint && !guestPlannerValuesEqual(endpoint.after, record.localData)) throw new Error('Guest planner checkpoint endpoint mismatch')
  return { format: 'journaled', descriptor, journal: { version: 1, changes: record.localData.changes, checkpoints, undoable: descriptor.undoable } }
}
