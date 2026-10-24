import 'fake-indexeddb/auto'
import { createAccountInheritedEvidencePreparation } from './account-evidence-snapshots'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { accountMappingRootKey } from './account-mapping-origin'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from './account-cache'
import { editorClosureFixture } from './test-helpers'
import { prepareAccountWorkspace, prepareAccountWorkspaceWithEvidence } from './account-graph'
import { prepareAccountManagedMigration } from './account-managed-migration'
import { openAccountManagedRepository } from './account-managed-repository'
import { createPersonalDefinition } from '../domain'
import { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, ownWorkspaceSnapshot } from './snapshot'
import { readBlob, blobIdentity } from './blobs'
import { prepareIncrementalMapping, activateIncrementalMapping } from './account-local-mapping'
import { MappedWorkspaceIntentSchema } from './account-intents'

it('migrates a native encrypted graph without changing originals and keeps its exact mapping baseline after restart', async () => {
  const accountId = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(accountId, key.slice()), database = new AccountDatabase(accountId)
  const fixture = await editorClosureFixture()
  let backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const source = await prepareAccountWorkspace(database, token, fixture.state)
    const original = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: source.head, records: source.records, intentStatus: 'mapped-local' })
    const originalRecords = await database.encryptedRevisions.toArray(), chunks = await database.stagedCipherChunks.toArray()
    const migration = await prepareAccountManagedMigration(database, token, original)
    expect(await database.profileMeta.get('active')).toEqual(original)
    const target = await activateLocalAccountCommit(database, token, migration.prepared)
    await migration.dispose()
    for (const record of originalRecords) expect(await database.encryptedRevisions.get(record.revisionId)).toEqual(record)
    for (const chunk of chunks) expect(await database.stagedCipherChunks.get([chunk.payloadId, chunk.index])).toEqual(chunk)
    invalidateProfile(); database.close(); token = installProfile(accountId, key.slice()); database = new AccountDatabase(accountId)
    const repository = await openAccountManagedRepository(database, token, target)
    expect((await repository.load()).localData).toEqual(fixture.state.planner.localData)
    backup = await captureWorkspaceSnapshot(repository)
    expect(backup.version).toBe(2)
    if (backup.version !== 2) throw new Error('Migration original is missing')
    const historical = await openHistoricalSnapshot(backup, backup.historicalEvidence.snapshots[0]!.id)
    try {
      expect(historical.state.planner).toEqual(fixture.state.planner)
      for (const body of fixture.state.blobs) expect(await readBlob(historical.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    } finally { await disposeWorkspaceSnapshot(historical) }
    await disposeWorkspaceSnapshot(backup); backup = undefined
    await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'After managed migration' }), fixture.state.planner.localData.revision)
    const row = (await database.outbox.toArray())[0]!
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, row))
    const intent = await openAccountJson(database, token, (await database.outbox.get(row.id))!.ref, MappedWorkspaceIntentSchema)
    expect(intent.base).toEqual(source.head)
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('preserves inherited native graphs and rejects competing publication without selecting staged data', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), owner = createAccountInheritedEvidencePreparation(database, token)
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'older-account-native', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: { original: 'one' }, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  const inherited = await inheritWorkspaceSnapshot(original, [original])
  let migration: Awaited<ReturnType<typeof prepareAccountManagedMigration>> | undefined, backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const historical = await owner.prepare({ additions: [inherited] })
    const state = { ...fixture.state, planner: { ...fixture.state.planner, localData: createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Before migration current' }) } }
    const source = await prepareAccountWorkspaceWithEvidence(database, token, state, historical)
    const initial = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: source.head, records: source.records, validatedEvidence: historical.handle, intentStatus: 'mapped-local' })
    migration = await prepareAccountManagedMigration(database, token, initial)
    await database.profileMeta.put({ ...initial, headRevision: initial.headRevision + 1 })
    await expect(activateLocalAccountCommit(database, token, migration.prepared)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' })
    expect(await database.syncState.get(accountMappingRootKey(migration.prepared.head))).toBeUndefined()
    expect(await database.migrationJournal.get(migration.prepared.id)).toBeUndefined()
    await database.profileMeta.put(initial)
    const selected = await activateLocalAccountCommit(database, token, migration.prepared)
    const repository = await openAccountManagedRepository(database, token, selected)
    backup = await captureWorkspaceSnapshot(repository)
    expect(backup.state.planner.localData).toEqual(state.planner.localData)
    expect(backup.version).toBe(2)
    if (backup.version !== 2) throw new Error('Migrated historical graphs missing')
    const planners = []
    for (const member of backup.historicalEvidence.snapshots) {
      const snapshot = await openHistoricalSnapshot(backup, member.id)
      try {
        planners.push(snapshot.state.planner.localData)
        for (const body of fixture.state.blobs) expect(await readBlob(snapshot.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      } finally { await disposeWorkspaceSnapshot(snapshot) }
    }
    expect(planners).toContainEqual(fixture.state.planner.localData)
    expect(planners).toContainEqual(state.planner.localData)
    expect(await database.outbox.toArray()).toEqual([])
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); await migration?.dispose(); await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(original); await owner.abandon(); database.close(); invalidateProfile() }
}, 30_000)
