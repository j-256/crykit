import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { LocalWorkspaceRootV3Schema, prepareLocalWorkspace } from './local-root'
import { openAccountManagedRepository } from './account-managed-repository'
import { editorClosureFixture } from './test-helpers'
import { createPersonalDefinition } from '../domain'
import { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, ownWorkspaceSnapshot } from './snapshot'
import { guestEvidenceFromFrozenCurrent } from './guest-evidence'
import { prepareLocalEvidence } from './local-evidence'
import { blobIdentity, readBlob } from './blobs'

it('opens valid current data without reading an unrelated archive and rejects that damage when exporting', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  const fixture = await editorClosureFixture()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'archive-only-original', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: {}, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  try {
    const operation = accountLocalId(), evidence = await guestEvidenceFromFrozenCurrent(original)
    const inherited = await prepareLocalEvidence(store.adapter, operation, evidence)
    const state = { ...fixture.state, blobs: [], retainedContent: [] }
    const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime, undefined, inherited)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined))
    store.committed(operation)
    const archived = (await database.encryptedRevisions.toArray()).find(record => record.descriptor.plainBytes === 2)!
    expect(archived).toBeDefined()
    const chunk = (await database.stagedCipherChunks.get([archived.payloadId, 0]))!, bytes = chunk.bytes.slice()
    bytes[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes })
    let historicalReads = 0
    database.encryptedRevisions.hook('reading', row => { if (row?.revisionId === archived.revisionId) historicalReads++; return row })
    const repository = await openAccountManagedRepository(database, token, fence)
    expect((await repository.load()).localData).toEqual(state.planner.localData)
    expect(historicalReads).toBe(0)
    await repository.save(createPersonalDefinition(state.planner.localData, { kind: 'item', name: 'Current data remains editable' }), state.planner.localData.revision)
    const next = (await database.profileMeta.get('active'))!
    expect((await openAccountJson(database, token, next.head, LocalWorkspaceRootV3Schema)).inheritedEvidence).toEqual(inherited)
    await expect(captureWorkspaceSnapshot(repository)).rejects.toThrow()
    expect(historicalReads).toBeGreaterThan(0)
    expect(await database.stagedCipherChunks.get([archived.payloadId, 0])).toEqual({ ...chunk, bytes })
    await database.encryptedRevisions.delete(inherited.revisionId)
    await expect(openAccountManagedRepository(database, token, next)).rejects.toThrow()
  } finally { await disposeWorkspaceSnapshot(original); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('exports exact encrypted current and inherited graphs while preserving captured draft and profile fences', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  let backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  const fixture = await editorClosureFixture()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'retained-native-original', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: { synthetic: 'original' }, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  try {
    const operation = accountLocalId(), evidence = await guestEvidenceFromFrozenCurrent(original)
    const inherited = await prepareLocalEvidence(store.adapter, operation, evidence)
    const state = { ...fixture.state, planner: { ...fixture.state.planner, localData: createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Private current sentinel' }) } }
    const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime, undefined, inherited)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const fence = (await database.profileMeta.get('active'))!
    const repository = await openAccountManagedRepository(database, token, fence)
    const sources = await repository.readSources()
    expect(sources.map(value => value.bytes)).toEqual(await Promise.all(state.planner.sources.map(source => readBlob(state.blobs.find(body => blobIdentity(body.ref) === blobIdentity(source.original))!.content, source.original.byteLength))))
    backup = await captureWorkspaceSnapshot(repository)
    expect(backup.state.planner).toEqual(state.planner)
    expect(backup.version).toBe(2)
    if (backup.version !== 2) throw new Error('Inherited originals are missing')
    const retained = await openHistoricalSnapshot(backup, backup.historicalEvidence.snapshots[0]!.id)
    try {
      expect(retained.state.planner).toEqual(fixture.state.planner)
      expect(retained.state.editorDocuments).toEqual(fixture.state.editorDocuments)
      for (const body of retained.state.blobs) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(fixture.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength))
    } finally { await disposeWorkspaceSnapshot(retained) }
    const draft = createPersonalDefinition(state.planner.localData, { kind: 'item', name: 'Unsaved private draft' })
    const bytes = await repository.exportPlannerBackup(draft)
    const preview = await repository.previewImport(bytes, 'draft.zip')
    expect(preview.proposed.localData?.personalDefinitions).toEqual(draft.personalDefinitions)
    expect((await repository.load()).localData).toEqual(state.planner.localData)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    await expect(repository.exportPlannerBackup({ ...draft, id: 'wrong-owner' as typeof draft.id })).rejects.toThrow()
    invalidateProfile()
    await expect(repository.exportPlannerBackup(draft)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    await expect(captureWorkspaceSnapshot(repository)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); await disposeWorkspaceSnapshot(original); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)
