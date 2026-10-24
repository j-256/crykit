import { migrateLocalData250 } from '../domain/team-checkpoints'
import type { CatalogSnapshot, ChangeEntry, LocalData } from '../domain/types'
import type { LocalDataRecord, MetaRecord } from '../persistence/database'
import type { PersistedHistoryEntry } from '../interchange/types'
import { NativeHistorySchema, NativeLineageSchema, NativeLocalDataSchema } from '../interchange/native-schema'
import { isImmutableCatalogSnapshot, validateNativeLocalDataGraph } from '../interchange/native'
import { changedLocalData, historyEntry, journaledLocalDataForSave } from '../persistence/local-data'
import { GUEST_PLANNER_LAYOUT_KEY, GUEST_PLANNER_ROOT_KEY, guestPlannerValuesEqual, mergeGuestPlannerEvidence, validateGuestPlannerRecord, type OperativePlannerDescriptorV1 } from '../persistence/guest-planner-record'
import { nowTimestamp } from '../interchange/util'
import type { WorkspacePlannerState } from './documents'
import { preserveLocalSelections } from './local-selections'

export interface GuestPlannerCurrentTuple {
  readonly record: LocalDataRecord
  readonly declaration: MetaRecord
  readonly history: readonly PersistedHistoryEntry[]
}
declare const preparedGuestPlanner: unique symbol
export interface PreparedGuestPlanner { readonly [preparedGuestPlanner]: true }
export interface PreparedGuestPlannerProjection {
  readonly current: WorkspacePlannerState
  readonly resolved: WorkspacePlannerState
  readonly mode: 'additive' | 'replace'
  readonly planner: WorkspacePlannerState
  readonly record: LocalDataRecord & { readonly operativePlanner: OperativePlannerDescriptorV1 }
  readonly declaration: MetaRecord
}
const GUEST_RESTORE_COMMAND = 'guest-restore'
const prepared = new WeakMap<PreparedGuestPlanner, PreparedGuestPlannerProjection>()
function captureProjection(value: PreparedGuestPlannerProjection): PreparedGuestPlannerProjection {
  const copies = new Map<CatalogSnapshot, CatalogSnapshot>()
  const catalogs = (planner: WorkspacePlannerState) => planner.catalogs.map(catalog => {
    if (isImmutableCatalogSnapshot(catalog)) return catalog
    let copy = copies.get(catalog)
    if (!copy) { copy = structuredClone(catalog); copies.set(catalog, copy) }
    return copy
  })
  // Only native-owned deep immutability permits identity reuse; every other input remains independently captured
  // Keep catalogs out of the broad clone so their admission and freezing work survives this private preparation
  const capturedCatalogs = { current: catalogs(value.current), resolved: catalogs(value.resolved), planner: catalogs(value.planner) }
  const metadata = structuredClone({ ...value, current: { ...value.current, catalogs: [] }, resolved: { ...value.resolved, catalogs: [] }, planner: { ...value.planner, catalogs: [] } })
  return freeze({ ...metadata, current: { ...metadata.current, catalogs: capturedCatalogs.current }, resolved: { ...metadata.resolved, catalogs: capturedCatalogs.resolved }, planner: { ...metadata.planner, catalogs: capturedCatalogs.planner } })
}
function freeze<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}
function validatePlanner(planner: WorkspacePlannerState): void {
  NativeLineageSchema.parse(planner.lineage)
  // One fixed membership serves every endpoint; mutable catalog values retain uncached validation
  const catalogs = Object.isFrozen(planner.catalogs) ? planner.catalogs : Object.freeze([...planner.catalogs])
  validateNativeLocalDataGraph(planner.localData, catalogs)
  for (const entry of [...planner.history, ...(planner.journal?.checkpoints ?? [])]) {
    NativeHistorySchema.parse(entry)
    validateNativeLocalDataGraph(entry.before, catalogs)
    validateNativeLocalDataGraph(entry.after, catalogs)
  }
  for (const change of planner.savedChanges ?? planner.localData.changes) NativeLocalDataSchema.shape.changes.element.parse(change)
  const history = mergeGuestPlannerEvidence([planner.history], value => value.id)
  const checkpoints = mergeGuestPlannerEvidence([planner.journal?.checkpoints ?? []], value => value.id)
  const checkpointById = new Map(checkpoints.map(entry => [entry.id, entry]))
  // Account migration retains frozen originals and separately projects operative endpoints with the same IDs
  // Compare that exact schema transition without rewriting either collection or admitting arbitrary ID conflicts
  const comparisonHistory = history.map(entry => {
    const checkpoint = checkpointById.get(entry.id)
    if (!checkpoint || String(entry.before.schemaVersion) !== '2.4.0' || String(entry.after.schemaVersion) !== '2.4.0'
      || String(checkpoint.before.schemaVersion) !== '2.5.0' || String(checkpoint.after.schemaVersion) !== '2.5.0') return entry
    return { ...entry, before: migrateLocalData250(entry.before, planner.catalogs), after: migrateLocalData250(entry.after, planner.catalogs) }
  })
  mergeGuestPlannerEvidence([comparisonHistory, checkpoints], value => value.id)
  mergeGuestPlannerEvidence([planner.savedChanges ?? [], planner.localData.changes], value => value.id)
}
function playthroughClocks(current: LocalData, resolved: LocalData, timestamp: LocalData['updatedAt']): LocalData {
  return { ...resolved, playthroughs: Object.fromEntries(Object.entries(resolved.playthroughs).map(([id, value]) => {
    const previous = current.playthroughs[id]
    const semantic = ({ revision: _revision, updatedAt: _updatedAt, activeScenarioId: _active, ...content }: typeof value) => content
    const changed = !previous || !guestPlannerValuesEqual(semantic(previous), semantic(value))
    const incremented = previous ? previous.revision + (changed ? 1 : 0) : 0
    if (!Number.isSafeInteger(incremented)) throw new Error('Guest restore playthrough revision overflow')
    // Validate floors against the complete intended planner graph; source ownership remains a separate caller obligation
    const floor = Object.values(value.scenarios).reduce((maximum, scenario) => scenario.baseline.kind === 'recordedParty' ? Math.max(maximum, scenario.baseline.playthroughRevision) : maximum, 0)
    const revision = Math.max(floor, incremented)
    return [id, { ...value, revision, updatedAt: changed || previous!.revision !== revision ? timestamp : previous!.updatedAt }]
  })) }
}

/** Prepares an already resolved target; mode records intent and does not authorize additive merging or source freshness */
export function prepareGuestRestorePlanner(current: WorkspacePlannerState, resolved: WorkspacePlannerState, mode: 'additive' | 'replace', currentTuple?: GuestPlannerCurrentTuple, command = GUEST_RESTORE_COMMAND): PreparedGuestPlanner {
  if (mode !== 'additive' && mode !== 'replace') throw new Error('Unsupported guest restore mode')
  const ordinary = command !== GUEST_RESTORE_COMMAND
  if (ordinary && (!currentTuple || !current.journal)) throw new Error('An ordinary guest successor requires an operative planner tuple')
  validatePlanner(current); validatePlanner(resolved)
  let destinationChanges: readonly ChangeEntry[] = current.localData.changes
  if (currentTuple) {
    const admitted = validateGuestPlannerRecord(currentTuple.record, currentTuple.declaration, currentTuple.history, 'journaled')
    const ordered = (history: readonly PersistedHistoryEntry[]) => [...history].sort((a, b) => a.id.localeCompare(b.id))
    if (admitted.format !== 'journaled'
      || !guestPlannerValuesEqual(currentTuple.record.localData, current.localData)
      || !guestPlannerValuesEqual(currentTuple.record.lineage, current.lineage)
      || !guestPlannerValuesEqual(admitted.journal, current.journal)
      || !guestPlannerValuesEqual(ordered(currentTuple.history), ordered(current.history))) throw new Error('Guest restore current tuple does not match the destination')
    destinationChanges = admitted.descriptor.savedDestinationChanges
  } else if (current.journal) {
    // Public savedChanges mixes inherited and local evidence; only the validated descriptor proves unbounded destination history
    throw new Error('A journaled guest restore requires its validated current tuple')
  }
  if (!Number.isSafeInteger(current.localData.revision + 1)) throw new Error('Guest restore planner revision overflow')
  const timestamp = nowTimestamp()
  const resolvedLocalData = migrateLocalData250(resolved.localData, resolved.catalogs)
  const target = ordinary ? resolvedLocalData : preserveLocalSelections(playthroughClocks(current.localData, resolvedLocalData, timestamp), current.localData)
  const saved = ordinary && command === 'save-localData' ? journaledLocalDataForSave(current.localData, target, destinationChanges, timestamp) : undefined
  const localData = saved?.localData ?? changedLocalData(current.localData, target, command, timestamp)
  const transition = historyEntry(current.localData, localData, saved?.command ?? command, timestamp)
  const savedDestinationChanges = mergeGuestPlannerEvidence([destinationChanges, saved?.newChanges ?? [localData.changes.at(-1)!]], value => value.id)
  const history = mergeGuestPlannerEvidence([current.history, resolved.history, [transition]], value => value.id)
  const savedChanges = mergeGuestPlannerEvidence([current.savedChanges ?? current.localData.changes, resolved.savedChanges ?? resolved.localData.changes, savedDestinationChanges], value => value.id)
  const catalogs = mergeGuestPlannerEvidence([current.catalogs, resolved.catalogs], value => JSON.stringify([value.id, value.revisionId]))
  const sources = mergeGuestPlannerEvidence([current.sources, resolved.sources], value => value.id)
  const evidence = mergeGuestPlannerEvidence([current.evidence, resolved.evidence], value => value.id)
  const checkpoints = ordinary ? [...current.journal!.checkpoints, transition] : []
  const planner: WorkspacePlannerState = {
    ...resolved, localData, catalogs, sources, evidence, history, savedChanges,
    lineage: ordinary ? resolved.lineage : { rootLocalDataId: current.lineage.rootLocalDataId, parentLocalDataId: current.localData.id, sourceLocalDataId: resolved.localData.id, sourceRevision: resolved.localData.revision, forkedAt: timestamp },
    journal: { version: 1, changes: localData.changes, checkpoints, undoable: ordinary },
  }
  const epoch = crypto.randomUUID()
  const operativePlanner: OperativePlannerDescriptorV1 = { version: 1, kind: 'guest-operative-planner', epoch, localDataId: localData.id, revision: localData.revision, checkpointIds: checkpoints.map(entry => entry.id), savedDestinationChanges, undoable: ordinary }
  const record = { id: GUEST_PLANNER_ROOT_KEY, revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: planner.lineage, operativePlanner }
  const declaration = { key: GUEST_PLANNER_LAYOUT_KEY, value: JSON.stringify({ version: 1, kind: 'guest-journaled-planner', epoch }) }
  validatePlanner(planner)
  validateGuestPlannerRecord(record, declaration, history, 'journaled')
  const token = Object.freeze({}) as PreparedGuestPlanner
  // Preserve exact source journals/selectors separately; the owned projection grants no imported undo or activation authority
  prepared.set(token, captureProjection({ current, resolved, mode, planner, record, declaration }))
  return token
}

/** Resolves only a live local preparation identity; persisted rows and structural copies cannot reconstruct it */
export function requirePreparedGuestPlanner(value: PreparedGuestPlanner): PreparedGuestPlannerProjection {
  const projection = prepared.get(value)
  if (!projection) throw new Error('Unregistered guest planner preparation')
  return projection
}

// A format migration has no user command and cannot create an undo edge back to an obsolete schema
export function prepareGuestDomainMigration250(current: WorkspacePlannerState, tuple: GuestPlannerCurrentTuple): PreparedGuestPlanner {
  const admitted = validateGuestPlannerRecord(tuple.record, tuple.declaration, tuple.history, 'journaled', true)
  if (admitted.format !== 'journaled' || !guestPlannerValuesEqual(tuple.record.localData, current.localData) || !guestPlannerValuesEqual(tuple.record.lineage, current.lineage) || !guestPlannerValuesEqual(admitted.journal, current.journal)) throw new Error('Frozen migration tuple does not match its source')
  const ordered = (values: readonly PersistedHistoryEntry[]) => [...values].sort((a, b) => a.id.localeCompare(b.id))
  if (!guestPlannerValuesEqual(ordered(tuple.history), ordered(current.history))) throw new Error('Frozen migration history differs from its source')
  validatePlanner(current)
  const migrate = (entry: PersistedHistoryEntry): PersistedHistoryEntry => ({ ...entry, before: migrateLocalData250(entry.before, current.catalogs), after: migrateLocalData250(entry.after, current.catalogs) })
  const checkpoints = admitted.journal.checkpoints.map(migrate)
  const byId = new Map(checkpoints.map(entry => [entry.id, entry]))
  const localData = migrateLocalData250(current.localData, current.catalogs)
  const planner: WorkspacePlannerState = { ...current, localData, history: current.history.map(entry => byId.get(entry.id) ?? entry), journal: { ...admitted.journal, checkpoints } }
  const record = { ...tuple.record, localData, operativePlanner: admitted.descriptor }
  validatePlanner(planner)
  validateGuestPlannerRecord(record, tuple.declaration, planner.history, 'journaled')
  const token = Object.freeze({}) as PreparedGuestPlanner
  prepared.set(token, captureProjection({ current, resolved: planner, mode: 'additive', planner, record, declaration: tuple.declaration }))
  return token
}
