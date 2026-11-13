import { CryKitDatabase, getDatabase } from '../persistence/database'
import { createBlankLocalData } from '../domain/local-data'
import * as local from '../persistence/local-data'
import { checkGuestRecovery } from './guest-recovery'
import { assertGuestCurrent, commitGuestWorkspace, openGuestBindings, readGuestWorkspace } from './guest-workspace'
import type { WorkspaceRepository } from './repository'

// Detached native graphs are inputs to the supported restore and managed-admission engines
// Exercise those engines directly without making public startup accept a prelaunch workspace
export function createDetachedGuestGraph(original: CryKitDatabase = getDatabase()) {
  const binding = (async () => {
    if (!await original.localDatas.get('local-data-record')) {
      const localData = createBlankLocalData()
      await original.localDatas.add({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
    }
    return openGuestBindings(original)
  })()
  const current = async () => {
    const selected = await binding
    await assertGuestCurrent(selected)
    await checkGuestRecovery(selected)
    return selected
  }
  return {
    binding,
    readWorkspace: async () => readGuestWorkspace(await current()),
    commitWorkspace: async (...[state, revision]: Parameters<WorkspaceRepository['commitWorkspace']>) => commitGuestWorkspace(await current(), state, revision),
    save: async (...[data, revision]: Parameters<WorkspaceRepository['save']>) => local.saveLocalDataWithStatus(data, revision, (await current()).planner, true),
    undo: async (revision: number) => local.undoLocalDataWithStatus(revision, (await current()).planner, true),
  }
}
export function detachedGuestBindings(graph: ReturnType<typeof createDetachedGuestGraph>) { return graph.binding }
