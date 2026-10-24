import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { accountLocalId, openAccountJson } from './account-cache'
import { editorClosureFixture } from './test-helpers'
import { createAccountLocalStore } from './account-local-store'
import { LocalWorkspaceRootV3Schema, prepareLocalWorkspace } from './local-root'
import { openAccountManagedRepository } from './account-managed-repository'
import { openAccountWorkspace, prepareAccountWorkspace } from './account-graph'
import { prepareManagedAccountProjection } from './account-managed-projection'
import { readIncrementalMappedRoot, prepareIncrementalBaseline, activateIncrementalBaseline } from './account-local-mapping'
import { stagePull, activatePulledState } from '../account/sync/pull'
import { transferBudget } from '../account/sync/outbox'
import type { SyncClient } from '../account/sync/client'
import { createPersonalDefinition } from '../domain'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot, captureWorkspaceSnapshot, openHistoricalSnapshot } from './snapshot'
import { guestEvidenceFromFrozenCurrent } from './guest-evidence'
import { prepareLocalEvidence } from './local-evidence'
import { previewAccountWorkspaceRestore, stageAccountWorkspaceRestore, activateAccountWorkspaceRestore, releaseAccountWorkspaceRestoreStage } from './account-restore'
import { blobIdentity, readBlob } from './blobs'

it('selects a managed pull successor and its exact mapped base in the existing remote-state transaction', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), store = createAccountLocalStore(database, token), operation = accountLocalId()
  let projection: Awaited<ReturnType<typeof prepareManagedAccountProjection>> | undefined
  try {
    const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    const before = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    const client = { changes: async () => ({ version: 1, mode: 'initial', watermark: 0, publicationEpoch: 0, groups: [], hasMore: false, cursor: 'synthetic-pull' }) } as unknown as SyncClient
    const candidate = (await stagePull(database, token, client, async () => {}, transferBudget()))!
    const state = { ...fixture.state, planner: { ...fixture.state.planner, localData: createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Pulled exact record' }) } }
    const native = await prepareAccountWorkspace(database, token, state)
    projection = await prepareManagedAccountProjection(database, token, before, native)
    await expect(activatePulledState(database, token, candidate, before, native, undefined, undefined, () => { throw new Error('New dirty draft') }, [], undefined, projection.prepared)).rejects.toThrow('New dirty draft')
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.syncState.get('remote')).toBeUndefined()
    expect(await readIncrementalMappedRoot(database, token, { ...before, headRevision: 1, head: projection.prepared.head })).toBeUndefined()
    await activatePulledState(database, token, candidate, before, native, undefined, undefined, () => {}, [], undefined, projection.prepared)
    const after = (await database.profileMeta.get('active'))!
    expect(after.head).toEqual(projection.prepared.head)
    expect(after.head).not.toEqual(native.head)
    expect(await readIncrementalMappedRoot(database, token, after)).toEqual(native.head)
    expect(await database.syncState.get('remote')).toBeDefined()
    expect(await database.syncState.get('scan')).toBeUndefined()
    const reopened = await openAccountManagedRepository(database, token, after)
    expect((await reopened.readWorkspace()).planner).toEqual(state.planner)
    expect((await reopened.readWorkspace()).editorDocuments).toEqual(fixture.state.editorDocuments)
    expect(await database.encryptedRevisions.get(before.head.revisionId)).toBeDefined()
  } finally { await projection?.dispose(); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('restores into managed selection while retaining destination and imported originals and the settled-sync guard', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), store = createAccountLocalStore(database, token), operation = accountLocalId()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'destination-original', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: { original: 'one' }, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  const state = { ...fixture.state, planner: { ...fixture.state.planner, localData: createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Imported managed restore' }) } }
  const incoming = ownWorkspaceSnapshot({ version: 1, snapshotId: 'incoming-original', capturedAt: state.planner.localData.updatedAt, revisionVector: { imported: 'two' }, state }, { check: async () => {}, dispose: async () => {} })
  let stage: Awaited<ReturnType<typeof stageAccountWorkspaceRestore>> | undefined, backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const evidence = await prepareLocalEvidence(store.adapter, operation, await guestEvidenceFromFrozenCurrent(original))
    const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime, undefined, evidence)
    const before = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, before))
    const preview = await previewAccountWorkspaceRestore(database, token, incoming)
    stage = await stageAccountWorkspaceRestore(preview)
    const unrelated = { id: accountLocalId(), ref: before.head, status: 'unmapped-local' as const }
    await database.outbox.add(unrelated)
    await expect(activateAccountWorkspaceRestore(stage)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' })
    expect(await database.profileMeta.get('active')).toEqual(before)
    await database.outbox.delete(unrelated.id)
    const after = await activateAccountWorkspaceRestore(stage)
    expect(after.head).toEqual(stage.targetHead)
    const repository = await openAccountManagedRepository(database, token, after)
    backup = await captureWorkspaceSnapshot(repository)
    expect(backup.state.planner.localData).toEqual(state.planner.localData)
    if (backup.version !== 2) throw new Error('Managed restore history is missing')
    const originals = []
    for (const member of backup.historicalEvidence.snapshots) {
      const historical = await openHistoricalSnapshot(backup, member.id)
      try {
        originals.push(historical.state.planner.localData)
        for (const body of fixture.state.blobs) expect(await readBlob(historical.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      } finally { await disposeWorkspaceSnapshot(historical) }
    }
    expect(originals).toContainEqual(fixture.state.planner.localData)
    expect(originals).toContainEqual(state.planner.localData)
    expect(await readIncrementalMappedRoot(database, token, after)).toBeDefined()
    expect((await database.outbox.toArray())[0]!.status).toBe('mapped-local')
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); if (stage) await releaseAccountWorkspaceRestoreStage(stage); await disposeWorkspaceSnapshot(original); await disposeWorkspaceSnapshot(incoming); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('reuses an authenticated unchanged archive on pull and rejects damaged retained archive control', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), store = createAccountLocalStore(database, token), operation = accountLocalId()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'unchanged-pull-history', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: {}, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  let projection: Awaited<ReturnType<typeof prepareManagedAccountProjection>> | undefined
  let backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const evidence = await prepareLocalEvidence(store.adapter, operation, await guestEvidenceFromFrozenCurrent(original))
    const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime, undefined, evidence)
    let before = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, before))
    const mapped = (await readIncrementalMappedRoot(database, token, before))!
    const state = { ...fixture.state, planner: { ...fixture.state.planner, localData: createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Accepted same-archive publication' }) } }
    const native = await prepareAccountWorkspace(database, token, state, await openAccountWorkspace(database, token, mapped))
    projection = await prepareManagedAccountProjection(database, token, before, native)
    before = await activateLocalAccountCommit(database, token, projection.prepared)
    const selected = await openAccountJson(database, token, before.head, LocalWorkspaceRootV3Schema)
    expect(selected.inheritedEvidence).toEqual(evidence)
    await projection.dispose(); projection = undefined
    const installed = { ...native, records: [] }
    const record = (await database.encryptedRevisions.get(evidence.revisionId))!, chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    const damaged = chunk.bytes.slice(); damaged[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes: damaged })
    await expect(prepareManagedAccountProjection(database, token, before, installed)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toEqual(before)
    await database.stagedCipherChunks.put(chunk)
    projection = await prepareManagedAccountProjection(database, token, before, installed)
    const after = await activateLocalAccountCommit(database, token, projection.prepared)
    backup = await captureWorkspaceSnapshot(await openAccountManagedRepository(database, token, after))
    expect(backup.state.planner.localData.personalDefinitions).toEqual(state.planner.localData.personalDefinitions)
    if (backup.version !== 2) throw new Error('Historical originals are missing')
    for (const member of backup.historicalEvidence.snapshots) {
      const child = await openHistoricalSnapshot(backup, member.id)
      try {
        expect(child.state.planner.localData).toEqual(fixture.state.planner.localData)
        for (const body of fixture.state.blobs) expect(await readBlob(child.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      } finally { await disposeWorkspaceSnapshot(child) }
    }
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); await projection?.dispose(); await disposeWorkspaceSnapshot(original); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)
