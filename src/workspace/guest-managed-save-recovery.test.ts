import './guest-managed-monitor.test-helpers'
import { expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { invalidateProfile } from '../account/profile'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openGuestManagedRepository } from './guest-managed-repository'
import { readGuestSaveRecovery } from './guest-repository'
import { editorBlob } from './editor-document'
import type { SaveWorkspaceDocument, WorkspaceState } from './documents'

it('reads only the exact selected managed Save and rejects changed files or a revoked captured profile', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-save-recovery-${crypto.randomUUID()}`)
  const body = await editorBlob(new Uint8Array([17, 0, 255, 29]), 'bytes'), timestamp = new Date().toISOString()
  const file: SaveWorkspaceDocument = { version: 1, id: 'original-save', revision: 1, filename: 'unsupported.sav', original: body.ref, working: body.ref, pendingForm: null, requirements: [], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
  const localData = createBlankLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [body], libraryDefaults: { version: 1, layers: [] } }
  const store = createGuestLocalStore(database, () => {})
  try {
    const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
    const receipt = await store.activate('initial', prepared.head, undefined, () => {})
    const repository = await openGuestManagedRepository(database, receipt.target)
    const bytes = await readGuestSaveRecovery(repository, file)
    expect(bytes.originalBytes).toEqual(new Uint8Array([17, 0, 255, 29]))
    expect(bytes.workingBytes).toEqual(bytes.originalBytes)
    await expect(readGuestSaveRecovery(repository, { ...file, revision: 2 })).rejects.toThrow(/changed/)
    expect((await database.active.get('active'))!.manifest).toEqual(receipt.target)
    invalidateProfile()
    await expect(readGuestSaveRecovery(repository, file)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { invalidateProfile(); database.close() }
})
