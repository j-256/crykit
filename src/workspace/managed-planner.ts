import type { LocalData } from '../domain/types'
import { catalogReferences, journaledLocalDataForSaveWithSharedUnits, prepareModCatalogs } from '../persistence/local-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { catalogSnapshotKey } from '../interchange/identity'
import { nowTimestamp, randomId } from '../interchange/util'
import type { WorkspacePlannerState } from './documents'

// Ordinary journal checkpoints keep exact logical endpoints; managed storage owns their compact encoding
// Historical originals are append-only and an imported history entry never grants new Undo authority
export async function prepareManagedPlannerSave(before: WorkspacePlannerState, proposed: LocalData, destinationChanges = before.savedChanges ?? before.localData.changes): Promise<WorkspacePlannerState> {
  const timestamp = nowTimestamp()
  const saved = journaledLocalDataForSaveWithSharedUnits(before.localData, proposed, destinationChanges, timestamp)
  const missing = BUNDLED_CATALOGS.filter(catalog => !before.catalogs.some(known => known.id === catalog.id && known.revisionId === catalog.revisionId))
  const referenced = missing.length ? catalogReferences(saved.localData, before.localData) : undefined
  const additions = missing.filter(catalog => referenced!.has(catalogSnapshotKey(catalog.id, catalog.revisionId)))
  // Admit exact packaged versions when a new reference needs them; never prune existing or historical catalogs
  const available = additions.length ? Object.freeze([...before.catalogs, ...additions]) : before.catalogs
  const catalogs = await prepareModCatalogs(saved.localData, available)
  const checkpoint = { id: randomId('history'), localDataId: before.localData.id, command: saved.command, previousRevision: before.localData.revision, nextRevision: saved.localData.revision, before: before.localData, after: saved.localData, recordedAt: timestamp }
  return {
    ...before, localData: saved.localData, catalogs, history: [...before.history, checkpoint],
    savedChanges: [...(before.savedChanges ?? before.localData.changes), ...saved.newChanges],
    journal: { version: 1, changes: saved.localData.changes, checkpoints: [...(before.journal?.checkpoints ?? []), checkpoint], undoable: true },
  }
}
