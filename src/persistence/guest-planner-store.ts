import type { CryKitDatabase, LocalDataRecord, CatalogRecord, ImportRecord, MetaRecord } from './database'
import type { EvidenceRecord, SourceArchiveRecord, PersistedHistoryEntry } from '../interchange/types'
import { requirePreparedGuestPlanner, type PreparedGuestPlanner } from '../workspace/guest-planner'
import { encodeCatalogPayload } from '../workspace/catalog-codec'
import { equalLegacyValue } from '../workspace/legacy-value'
import { GUEST_PLANNER_LAYOUT_KEY, GUEST_PLANNER_ROOT_KEY, guestPlannerValuesEqual, mergeGuestPlannerEvidence, validateGuestPlannerRecord } from './guest-planner-record'

export interface GuestPlannerInstallStagedRows {
  readonly localDatas: readonly LocalDataRecord[]
  readonly catalogs: readonly CatalogRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly sources: readonly SourceArchiveRecord[]
  readonly history: readonly PersistedHistoryEntry[]
  readonly imports: readonly ImportRecord[]
  readonly meta: readonly MetaRecord[]
}
export interface GuestPlannerInstallBoundary {
  // Exact existing staging is an admission precondition, never a permit or replacement payload
  readonly expectedStaged: GuestPlannerInstallStagedRows
  readonly assertOwned: () => void
}

function keyedRows<Row>(rows: readonly Row[], key: (row: Row) => string): Map<string, Row> {
  const result = new Map<string, Row>()
  for (const row of rows) {
    const id = key(row)
    if (result.has(id)) throw new Error('Duplicate staged guest planner row')
    result.set(id, row)
  }
  return result
}

function assertStagedRows<Row>(actual: readonly Row[], expected: readonly Row[], key: (row: Row) => string): void {
  const wanted = keyedRows(expected, key)
  // Typed exact comparison also preserves binary source values and unrelated inert metadata
  if (actual.length !== wanted.size || actual.some(row => !wanted.has(key(row)) || !equalLegacyValue(row, wanted.get(key(row))))) {
    throw new Error('The staged guest planner rows changed')
  }
}

function additions<Row>(existing: readonly Row[], requested: readonly Row[], key: (row: Row) => string): Row[] {
  const rows = keyedRows(existing, key)
  return mergeGuestPlannerEvidence([requested], key).filter(row => {
    if (!rows.has(key(row))) return true
    if (!guestPlannerValuesEqual(rows.get(key(row)), row)) throw new Error('Immutable staged guest planner evidence changed')
    return false
  })
}

function assertSynchronousOwnership(assertOwned: () => void): void {
  const result: unknown = assertOwned()
  // TypeScript allows async callbacks for void signatures; a pending assertion cannot grant admission
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
    // Observe eventual rejection without waiting inside the live transaction or treating it as approval
    void Promise.resolve(result).catch(() => {})
    throw new Error('Guest planner ownership assertion must be synchronous')
  }
}

/**
 * Installs only an unselected fresh planner, with planner-local atomicity
 * The preparation proves projection identity, not target ownership or source freshness
 * The caller must already own registered staging and body closure; this primitive cannot authorize activation
 * assertOwned must be synchronous and perform no I/O, and must throw on cancellation or owner loss
 */
export async function writePreparedGuestPlanner(database: CryKitDatabase, preparation: PreparedGuestPlanner, boundary: GuestPlannerInstallBoundary): Promise<void> {
  const prepared = requirePreparedGuestPlanner(preparation)
  // Capture caller expectations before yielding; later caller edits cannot adopt changed staged rows
  const expected = structuredClone(boundary.expectedStaged)
  const assertOwned = boundary.assertOwned
  const packagedCatalogKeys = new Set<string>()
  const catalogs: CatalogRecord[] = prepared.planner.catalogs.map(snapshot => {
    const key = JSON.stringify([snapshot.id, snapshot.revisionId])
    if ((encodeCatalogPayload(snapshot) as { kind?: string }).kind === 'packaged-catalog-pin') packagedCatalogKeys.add(key)
    return { key, id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot }
  })
  const catalogIdentities = new Set(catalogs.map(row => row.key))
  assertSynchronousOwnership(assertOwned)
  // All tables participate, including preserved staging: admission must not race a concurrent writer
  await database.transaction('rw', database.tables, async () => {
    const localDatas = await database.localDatas.toArray()
    const storedCatalogs = await database.catalogs.toArray()
    const evidence = await database.evidence.toArray()
    const sources = await database.sources.toArray()
    const history = await database.history.toArray()
    const imports = await database.imports.toArray()
    const meta = await database.meta.toArray()
    assertStagedRows(localDatas, expected.localDatas, row => row.id)
    assertStagedRows(storedCatalogs, expected.catalogs, row => row.key)
    assertStagedRows(evidence, expected.evidence, row => row.id)
    assertStagedRows(sources, expected.sources, row => row.id)
    assertStagedRows(history, expected.history, row => row.id)
    assertStagedRows(imports, expected.imports, row => row.id)
    assertStagedRows(meta, expected.meta, row => row.key)
    if (localDatas.some(row => row.id === GUEST_PLANNER_ROOT_KEY) || meta.some(row => row.key === GUEST_PLANNER_LAYOUT_KEY)) {
      throw new Error('A guest planner root or declaration already exists')
    }
    // A packaged pin avoids a new stored copy, but never excuses a conflicting staged wrapper or snapshot
    for (const row of storedCatalogs) {
      const identity = JSON.stringify([row.id, row.revisionId])
      if (catalogIdentities.has(identity) && row.key !== identity) throw new Error('Immutable staged guest planner catalog key changed')
    }
    const newCatalogs = additions(storedCatalogs, catalogs, row => row.key).filter(row => !packagedCatalogKeys.has(row.key))
    const newHistory = additions(history, prepared.planner.history, row => row.id)
    if (additions(evidence, prepared.planner.evidence, row => row.id).length) throw new Error('Missing staged guest planner evidence')
    const bySource = keyedRows(sources, row => row.id)
    for (const { original, ...source } of prepared.planner.sources) {
      const stored = bySource.get(source.id)
      if (!stored) throw new Error('Missing staged guest planner source')
      const { bytes, ...metadata } = stored
      // Full body digest/closure verification belongs to the staging owner, outside this transaction
      if (!guestPlannerValuesEqual(source, metadata) || bytes.byteLength !== original.byteLength || source.digest !== original.sha256) {
        throw new Error('Immutable staged guest planner source changed')
      }
    }
    validateGuestPlannerRecord(prepared.record, prepared.declaration, [...history, ...newHistory], 'journaled')
    assertSynchronousOwnership(assertOwned)
    // Never replace staged identities; any failed request or final guard abort rolls back all additions
    if (newCatalogs.length) await database.catalogs.bulkAdd(newCatalogs)
    if (newHistory.length) await database.history.bulkAdd(newHistory)
    await database.meta.add(prepared.declaration)
    await database.localDatas.add(prepared.record)
    assertSynchronousOwnership(assertOwned)
  })
}
