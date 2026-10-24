import './guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openGuestManagedRepository } from './guest-managed-repository'
import { prepareWorkspaceImport } from './import-commands'
import { saveBuildRevision } from '../domain/builds'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { previewImport } from '../persistence/local-data'
import * as local from '../persistence/local-data'
import { invalidateProfile } from '../account/profile'
import { createEditorRepository } from './editor-repository'
import { resolveOwnedFileReceipt } from './owned-file-command'
import type { WorkspaceState } from './documents'

it('reads exact imported pins and exports a captured native draft after owned retirement without selecting or saving it', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-adapters-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const initial: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const text = '{\r\n"ID":"synthetic-managed-native","Name":"Synthetic retained source","Version":"1","EditorVersion":34,"Equipment":[{"ID":9000,"Name":"Synthetic sword","Type":0,"Hands":1,"StatMods":[]}],"Unknown":{"exact":900719925474099312345}\r\n}'
  const bytes = new TextEncoder().encode(text), preview = await previewCrystalEdit(bytes, 'synthetic.crystalmod')
  const catalog = preview.proposed.catalogs[0]!
  const imported = await prepareWorkspaceImport(initial, preview, { mode: 'add-reference', includeModInReference: catalog.id })
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', imported.state, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  let repository = await openGuestManagedRepository(database, receipt.target)
  try {
    expect(await repository.readModSource({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId })).toEqual({ filename: 'synthetic.crystalmod', text })
    expect((await repository.readSources())[0]!.bytes).toEqual(bytes)
    await expect(repository.readModSource({ catalogId: catalog.id, catalogRevisionId: 'unavailable' as typeof catalog.revisionId })).rejects.toThrow()
    const saved = await repository.load(), id = Object.keys(saved.localData.builds)[0]!
    const previous = saved.localData.buildRevisions[saved.localData.builds[id]!.latestRevisionId!]!
    const draft = saveBuildRevision(saved.localData, { buildId: previous.buildId, gameSetupRevisionId: previous.gameSetupRevisionId, parentRevisionId: previous.id, content: { ...previous.content, rotationNotes: 'Whole unsaved native draft' } })
    const captured = repository
    await createEditorRepository(repository, { onOutcome: async outcome => { repository = (await resolveOwnedFileReceipt(outcome.receipt!)).repository } }).importFile({ filename: 'unsaved.crystalmod', text: '{}', bytes: new TextEncoder().encode('{}'), referenceId: 'synthetic' })
    const activeBefore = await database.active.get('active'), rowsBefore = await database.table('managedOperations').count()
    const successorBefore = await repository.load()
    await expect(captured.load()).rejects.toThrow(/retired/)
    const exported = await previewImport(await captured.exportPlannerBackup(draft), 'native-draft.zip')
    expect(exported.errors).toEqual([])
    expect(exported.proposed.localData.buildRevisions[draft.builds[id]!.latestRevisionId!]!.content.rotationNotes).toBe('Whole unsaved native draft')
    expect(exported.proposed.sources[0]!.bytes).toEqual(bytes)
    expect(exported.proposed.catalogs.some(value => value.id === catalog.id && value.revisionId === catalog.revisionId)).toBe(true)
    expect(await database.active.get('active')).toEqual(activeBefore)
    expect(await database.table('managedOperations').count()).toBe(rowsBefore)
    expect((await repository.load()).localData).toEqual(successorBefore.localData)
    expect(successorBefore.localData.buildRevisions).toEqual(saved.localData.buildRevisions)
    await expect(captured.exportPlannerBackup()).rejects.toThrow(/retired/)
    await expect(captured.exportPlannerBackup({ ...draft, id: 'wrong' as typeof draft.id })).rejects.toThrow()
    let discarded: Uint8Array | undefined
    const encode = local.exportPlannerSnapshot
    vi.spyOn(local, 'exportPlannerSnapshot').mockImplementationOnce(async (...args) => {
      discarded = await encode(...args)
      invalidateProfile()
      return discarded
    })
    await expect(captured.exportPlannerBackup(draft)).rejects.toThrow('PROFILE_CHANGED')
    expect(discarded?.length).toBeGreaterThan(0)
    expect(discarded?.every(byte => byte === 0)).toBe(true)
    await expect(captured.exportPlannerBackup(draft)).rejects.toThrow('PROFILE_CHANGED')
  } finally { vi.restoreAllMocks(); database.close() }
}, 30_000)
