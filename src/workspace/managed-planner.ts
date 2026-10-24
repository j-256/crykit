import type { LocalData } from '../domain/types'
import { journaledLocalDataForSaveWithSharedUnits, prepareModCatalogs } from '../persistence/local-data'
import { nowTimestamp, randomId } from '../interchange/util'
import type { WorkspacePlannerState } from './documents'

// Ordinary journal checkpoints keep exact logical endpoints; managed storage owns their compact encoding
// Historical originals are append-only and an imported history entry never grants new Undo authority
export async function prepareManagedPlannerSave(before: WorkspacePlannerState, proposed: LocalData, destinationChanges = before.savedChanges ?? before.localData.changes): Promise<WorkspacePlannerState> {
  const timestamp = nowTimestamp()
  const saved = journaledLocalDataForSaveWithSharedUnits(before.localData, proposed, destinationChanges, timestamp)
  const catalogs = await prepareModCatalogs(saved.localData, before.catalogs)
  const checkpoint = { id: randomId('history'), localDataId: before.localData.id, command: saved.command, previousRevision: before.localData.revision, nextRevision: saved.localData.revision, before: before.localData, after: saved.localData, recordedAt: timestamp }
  return {
    ...before, localData: saved.localData, catalogs, history: [...before.history, checkpoint],
    savedChanges: [...(before.savedChanges ?? before.localData.changes), ...saved.newChanges],
    journal: { version: 1, changes: saved.localData.changes, checkpoints: [...(before.journal?.checkpoints ?? []), checkpoint], undoable: true },
  }
}
