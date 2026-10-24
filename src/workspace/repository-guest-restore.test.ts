import './guest-managed-monitor.test-helpers'
import { expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { createPersonalDefinition } from '../domain'
import { invalidateProfile } from '../account/profile'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'
import { openGuestManagedRepository } from './guest-managed-repository'
import { editorBlob } from './editor-document'
import { readBlob, blobIdentity } from './blobs'
import { ownWorkspaceSnapshot, captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import type { WorkspaceState, SaveWorkspaceDocument } from './documents'
import { activateGuestWorkspaceRestore, beginGuestWorkspaceRestore, previewGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview, stageGuestWorkspaceRestore } from './repository-guest-restore'

async function fixture(label: string): Promise<WorkspaceState> {
  const localData = createPersonalDefinition(createBlankLocalData(), { name: label, kind: 'item' })
  const body = await editorBlob(new TextEncoder().encode(`${label}: exact unsupported original\u0000`), 'bytes')
  const file: SaveWorkspaceDocument = { version: 1, id: `${label}-save`, revision: 1, filename: `${label}.sav`, original: body.ref, working: body.ref, pendingForm: { version: 1, fields: { unknown: 'invalid user form' } }, requirements: [], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: localData.createdAt, updatedAt: localData.updatedAt, exportedRevision: null }
  return { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [body], libraryDefaults: { version: 1, layers: [] } }
}

it('stages complete managed restore without selecting it, then preserves both exact original graphs through restart', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-restore-${crypto.randomUUID()}`), store = createGuestLocalStore(database, () => {})
  const current = await fixture('destination'), incoming = await fixture('incoming')
  const input = ownWorkspaceSnapshot({ version: 1, snapshotId: 'synthetic-input', capturedAt: new Date().toISOString(), revisionVector: { synthetic: 'incoming' }, state: incoming }, { check: async () => {}, dispose: async () => {} })
  let preview: Awaited<ReturnType<typeof previewGuestWorkspaceRestore>> | undefined
  let exported: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const prepared = await prepareLocalWorkspace(store.adapter, 'initial', current, { check: () => {}, assertCurrent: async () => {} })
    const initial = await store.activate('initial', prepared.head, undefined, () => {})
    const repository = await openGuestManagedRepository(database, initial.target)
    preview = await previewGuestWorkspaceRestore(repository, input)
    await expect(beginGuestWorkspaceRestore({ ...preview })).rejects.toThrow(/preview/)
    const operation = await beginGuestWorkspaceRestore(preview)
    await stageGuestWorkspaceRestore(preview, operation.id)
    expect((await database.active.get('active'))!.manifest).toEqual(initial.target)
    expect(await database.table('managedOperations').get(operation.id)).toBeUndefined()
    const interrupted = await openGuestManagedRepository(database, initial.target)
    expect((await interrupted.readWorkspace()).planner).toEqual(current.planner)
    await expect(activateGuestWorkspaceRestore(preview, operation.id, () => { throw new Error('Open input changed') })).rejects.toThrow('Open input changed')
    expect((await database.active.get('active'))!.manifest).toEqual(initial.target)
    const target = await activateGuestWorkspaceRestore(preview, operation.id)
    expect(target.version).toBe(3)
    await expect(repository.load()).rejects.toThrow(/retired/)
    if (target.version !== 3) throw new Error('Managed target required')
    const reopened = await openGuestManagedRepository(database, target)
    const actual = await reopened.readWorkspace()
    expect(actual.saveDocuments).toEqual(incoming.saveDocuments)
    expect(actual.planner.localData.id).toBe(current.planner.localData.id)
    expect(actual.planner.localData.personalDefinitions).toEqual(incoming.planner.localData.personalDefinitions)
    expect(actual.planner.history).toHaveLength(1)
    expect(actual.planner.history[0]).toMatchObject({ command: 'guest-restore', before: current.planner.localData, after: actual.planner.localData })
    expect((await reopened.load()).canUndo).toBe(false)
    exported = await captureWorkspaceSnapshot(reopened)
    expect(exported.version).toBe(2)
    if (exported.version !== 2) throw new Error('Both original graphs must remain portable')
    const originals: WorkspaceState[] = []
    for (const member of exported.historicalEvidence.snapshots) {
      const original = await openHistoricalSnapshot(exported, member.id)
      originals.push(original.state)
      for (const body of original.state.blobs) {
        const expected = [...current.blobs, ...incoming.blobs].find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!
        expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(expected.content, expected.ref.byteLength))
      }
      await disposeWorkspaceSnapshot(original)
    }
    expect(originals.map(value => value.planner)).toEqual(expect.arrayContaining([current.planner, incoming.planner]))
    const retained = await admitLocalRoot(createGuestLocalStore(database, () => {}).adapter, initial.target.root, { check: () => {}, assertCurrent: async () => {} })
    expect(retained.state.planner).toEqual(current.planner)
    const loaded = await reopened.load()
    expect((await reopened.save(loaded.localData, loaded.revision)).localData.revision).toBe(loaded.revision + 1)
  } finally {
    if (preview) await releaseGuestWorkspaceRestorePreview(preview)
    if (exported) await disposeWorkspaceSnapshot(exported)
    await disposeWorkspaceSnapshot(input)
    invalidateProfile(); database.close()
  }
}, 30_000)

it('rejects a preview after a local edit and cannot activate a released or old-profile stage', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-restore-fences-${crypto.randomUUID()}`), store = createGuestLocalStore(database, () => {})
  const state = await fixture('captured'), incoming = await fixture('replacement')
  const input = ownWorkspaceSnapshot({ version: 1, snapshotId: 'fenced-input', capturedAt: new Date().toISOString(), revisionVector: { synthetic: 'fenced' }, state: incoming }, { check: async () => {}, dispose: async () => {} })
  const previews: Awaited<ReturnType<typeof previewGuestWorkspaceRestore>>[] = []
  try {
    const prepared = await prepareLocalWorkspace(store.adapter, 'initial', state, { check: () => {}, assertCurrent: async () => {} })
    const initial = await store.activate('initial', prepared.head, undefined, () => {})
    const repository = await openGuestManagedRepository(database, initial.target)
    const stale = await previewGuestWorkspaceRestore(repository, input); previews.push(stale)
    const loaded = await repository.load()
    await repository.save(loaded.localData, loaded.revision)
    const before = await database.active.get('active')
    await expect(beginGuestWorkspaceRestore(stale)).rejects.toThrow(/changed/)
    const released = await previewGuestWorkspaceRestore(repository, input); previews.push(released)
    const releasedOperation = await beginGuestWorkspaceRestore(released)
    await stageGuestWorkspaceRestore(released, releasedOperation.id)
    await releaseGuestWorkspaceRestorePreview(released)
    await expect(activateGuestWorkspaceRestore(released, releasedOperation.id)).rejects.toThrow(/preview/)
    expect(await database.active.get('active')).toEqual(before)
    const switched = await previewGuestWorkspaceRestore(repository, input); previews.push(switched)
    const switchedOperation = await beginGuestWorkspaceRestore(switched)
    await stageGuestWorkspaceRestore(switched, switchedOperation.id)
    invalidateProfile()
    await expect(activateGuestWorkspaceRestore(switched, switchedOperation.id)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    expect(await database.active.get('active')).toEqual(before)
    expect(await database.table('managedOperations').get(releasedOperation.id)).toBeUndefined()
    expect(await database.table('managedOperations').get(switchedOperation.id)).toBeUndefined()
  } finally {
    for (const preview of previews) await releaseGuestWorkspaceRestorePreview(preview)
    await disposeWorkspaceSnapshot(input)
    invalidateProfile(); database.close()
  }
}, 30_000)
