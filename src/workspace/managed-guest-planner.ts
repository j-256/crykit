import { GUEST_PLANNER_LAYOUT_KEY, GUEST_PLANNER_ROOT_KEY, validateGuestPlannerRecord } from '../persistence/guest-planner-record'
import { admittedLocalDestinationChanges, type AdmittedLocalSnapshot } from './local-root'
import type { GuestPlannerCurrentTuple } from './guest-planner'

// This projection is internal to an admitted managed root, never a descriptor synthesized from imported evidence
// The old native validator still owns checkpoint connectivity, destination clocks and exact live-change coverage
export function managedGuestPlannerTuple(snapshot: AdmittedLocalSnapshot): GuestPlannerCurrentTuple {
  const savedDestinationChanges = admittedLocalDestinationChanges(snapshot)
  const { localData, lineage, journal, history } = snapshot.state.planner
  const epoch = JSON.stringify(snapshot.head)
  const record = {
    id: GUEST_PLANNER_ROOT_KEY, revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage,
    operativePlanner: { version: 1 as const, kind: 'guest-operative-planner' as const, epoch, localDataId: localData.id, revision: localData.revision, checkpointIds: (journal?.checkpoints ?? []).map(value => value.id), savedDestinationChanges, undoable: journal?.undoable ?? false },
  }
  const declaration = { key: GUEST_PLANNER_LAYOUT_KEY, value: JSON.stringify({ version: 1, kind: 'guest-journaled-planner', epoch }) }
  validateGuestPlannerRecord(record, declaration, history, 'journaled')
  return { record, declaration, history }
}
