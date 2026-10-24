import { expect, it } from 'vitest'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { prepareManagedPlannerSave } from './managed-planner'
import type { WorkspacePlannerState } from './documents'

it('retains native checkpoints and exact new change history without copying admitted endpoints', async () => {
  const data = createSampleLocalData(BUNDLED_CATALOGS[0])
  const planner: WorkspacePlannerState = { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }
  const saved = await prepareManagedPlannerSave(planner, data)
  expect(saved.localData.revision).toBe(data.revision + 1)
  expect(saved.history[0].before).toBe(data)
  expect(saved.history[0].after).toBe(saved.localData)
  expect(saved.journal?.checkpoints).toEqual(saved.history)
  const again = await prepareManagedPlannerSave(saved, saved.localData)
  expect(again.history[0]).toBe(saved.history[0])
  expect(again.history[1].before).toBe(saved.localData)
  expect(again.savedChanges).toEqual(again.localData.changes)
  expect(again.localData.builds).toBe(data.builds)
  await expect(prepareManagedPlannerSave(saved, { ...saved.localData, revision: saved.localData.revision + 2 })).rejects.toThrow(/history/)
})
