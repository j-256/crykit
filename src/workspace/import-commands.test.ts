import { expect, it } from 'vitest'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { asTimestamp } from '../domain/core'
import { selectPlaythrough } from '../domain/local-data'
import { previewImport, exportPlannerSnapshot } from '../persistence/local-data'
import { prepareWorkspaceImport } from './import-commands'
import { captureManagedPlannerInput } from './local-root'
import { prepareManagedPlannerSave } from './managed-planner'
import type { WorkspaceState } from './documents'

it('can replace the selected planner with its own native backup without rewriting immutable evidence', async () => {
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const bytes = new TextEncoder().encode(JSON.stringify({ schema_version: '1.1.0', base_equipment: [{ id: 'synthetic:reed-staff', name: 'Reed Staff', description: 'Synthetic original', category: 'Staff' }], classes: [{ id: 'synthetic:scribe', name: 'Scribe' }], passives: [{ id: 'synthetic:patience', name: 'Patience', pp_cost: null }] }))
  const raw = await previewImport(bytes, 'synthetic.json')
  const imported = (await prepareWorkspaceImport(state, raw, { mode: 'replace' })).state
  const selected = selectPlaythrough(imported.planner.localData, { playthroughId: Object.values(imported.planner.localData.playthroughs)[0]!.id })
  const planner = await prepareManagedPlannerSave(imported.planner, captureManagedPlannerInput(selected))
  const exported = await exportPlannerSnapshot(planner, raw.proposed.sources)
  const preview = await previewImport(exported, 'synthetic-backup.zip')
  expect(preview.errors).toEqual([])
  const restored = await prepareWorkspaceImport({ ...imported, planner }, preview, { mode: 'replace' })
  expect(restored.state.planner.sources).toEqual(imported.planner.sources)
  expect(restored.state.planner.history).toEqual(planner.history)
  expect(restored.state.blobs).toEqual(imported.blobs)
  expect(preview.proposed.sources[0]!.bytes).toEqual(bytes)
  const tampered = { ...preview, proposed: { ...preview.proposed, history: preview.proposed.history.map((entry, at) => at ? entry : { ...entry, after: { ...entry.after, updatedAt: asTimestamp('2000-01-01T00:00:00.000Z') } }) } }
  await expect(prepareWorkspaceImport({ ...imported, planner }, tampered, { mode: 'replace' })).rejects.toThrow('immutable identity has conflicting contents')
}, 15000)
