import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import * as documentCodec from './document-codec'
import * as localDataValidation from '../persistence/local-data'
import { NativeHistorySchema } from '../interchange/native-schema'
import { isImmutableHistoryEndpoint } from './history-admission'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson, stageAccountJson, cipherRef } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace, admitLocalRoot } from './local-root'
import { openAccountManagedRepository, IncrementalWorkspaceIntentSchema } from './account-managed-repository'
import { editorClosureFixture } from './test-helpers'
import { createPersonalDefinition } from '../domain'
import { changedLocalDataWithSharedUnits, historyEntry } from '../persistence/local-data'
import { MappedWorkspaceIntentSchema } from './account-intents'
import { openAccountWorkspace, prepareAccountWorkspace, prepareAccountHistoryReuse } from './account-graph'
import { projectPlanner } from './planner-journal'
import { prepareManagedAccountProjection } from './account-managed-projection'
import { stagePull, activatePulledState } from '../account/sync/pull'
import { transferBudget } from '../account/sync/outbox'
import type { SyncClient } from '../account/sync/client'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, captureWorkspaceSnapshot } from './snapshot'
import { guestEvidenceFromFrozenCurrent } from './guest-evidence'
import { prepareLocalEvidence } from './local-evidence'
import { captureAccountSnapshot } from './account-snapshot'
import { readBlob, blobIdentity } from './blobs'
import { prepareIncrementalMapping, activateIncrementalMapping, prepareIncrementalBaseline, activateIncrementalBaseline, readIncrementalMappedRoot, ensureIncrementalAccountEvidence } from './account-local-mapping'

it('keeps exact mapped predecessor refs after preparation restart and published outbox removal without changing the local head', async () => {
  const accountId = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(accountId, key.slice()), database = new AccountDatabase(accountId)
  const store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const first = await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'First queued private edit' }), fixture.state.planner.localData.revision)
    const firstRow = (await database.outbox.toArray())[0]!
    await repository.save(createPersonalDefinition(first.localData, { kind: 'item', name: 'Second queued private edit' }), first.localData.revision)
    const secondRow = (await database.outbox.toArray()).find(value => value.id !== firstRow.id)!
    const finalHead = (await database.profileMeta.get('active'))!
    const finalLocal = (await admitLocalRoot(store.adapter, finalHead.head, store.lifetime)).state.planner
    await expect(prepareIncrementalMapping(database, token, secondRow)).rejects.toThrow(/predecessor/)
    const staged = await prepareIncrementalMapping(database, token, firstRow)
    expect(await database.outbox.get(firstRow.id)).toEqual(firstRow)
    expect(await database.profileMeta.get('active')).toEqual(finalHead)
    invalidateProfile(); database.close()
    token = installProfile(accountId, key.slice()); database = new AccountDatabase(accountId)
    const resumed = await prepareIncrementalMapping(database, token, firstRow)
    expect(resumed).toEqual(staged)
    await activateIncrementalMapping(database, token, resumed)
    const mappedFirstRow = (await database.outbox.get(firstRow.id))!
    const mappedFirst = await openAccountJson(database, token, mappedFirstRow.ref, MappedWorkspaceIntentSchema)
    const firstTarget = await openAccountWorkspace(database, token, mappedFirst.target)
    await database.outbox.delete(firstRow.id)
    const second = await prepareIncrementalMapping(database, token, secondRow)
    await activateIncrementalMapping(database, token, second)
    const mappedSecond = await openAccountJson(database, token, (await database.outbox.get(secondRow.id))!.ref, MappedWorkspaceIntentSchema)
    expect(mappedSecond.base).toEqual(mappedFirst.target)
    const secondTarget = await openAccountWorkspace(database, token, mappedSecond.target)
    expect(secondTarget.state.planner.journal).toEqual({ ...finalLocal.journal, checkpoints: [] })
    expect(secondTarget.state.planner.localData.changes).toEqual(finalLocal.localData.changes)
    expect(secondTarget.state.planner.savedChanges).toEqual(finalLocal.savedChanges)
    expect(secondTarget.state.planner.history).toEqual(finalLocal.history)
    const reopenedStore = createAccountLocalStore(database, token)
    try {
      const selected = await admitLocalRoot(reopenedStore.adapter, finalHead.head, reopenedStore.lifetime)
      expect(selected.state.planner).toEqual(finalLocal)
      expect(selected.state.planner.journal?.checkpoints).toHaveLength(2)
      expect(selected.state.planner.journal?.undoable).toBe(true)
    } finally { await reopenedStore.dispose() }
    expect((await openAccountWorkspace(database, token, mappedSecond.base)).entries).toEqual(firstTarget.entries)
    const localSecond = await openAccountJson(database, token, secondRow.ref, IncrementalWorkspaceIntentSchema)
    expect(mappedSecond.original).toEqual({ base: localSecond.before, target: localSecond.after })
    expect(await database.profileMeta.get('active')).toEqual(finalHead)
    await expect(activateIncrementalMapping(database, token, { ...second, operationId: firstRow.id })).rejects.toThrow()
    // The sync producer restores local operative authority before selecting a pulled native view
    const projectedState = { ...secondTarget.state, planner: projectPlanner(finalLocal, secondTarget.state.planner, false) }
    expect(projectedState.planner.journal).toEqual(finalLocal.journal)
    const native = await prepareAccountWorkspace(database, token, projectedState, secondTarget)
    const projection = await prepareManagedAccountProjection(database, token, finalHead, native)
    try {
      const client = { changes: async () => ({ version: 1, mode: 'initial', watermark: 0, publicationEpoch: 0, groups: [], hasMore: false, cursor: 'covered-journal-pull' }) } as unknown as SyncClient
      const candidate = (await stagePull(database, token, client, async () => {}, transferBudget()))!
      await activatePulledState(database, token, candidate, finalHead, native, undefined, undefined, () => {}, [], undefined, projection.prepared)
      const selected = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
      const backup = await captureWorkspaceSnapshot(selected)
      try {
        expect(backup.state.planner.journal).toEqual(finalLocal.journal)
        expect(backup.state.planner.history).toEqual(finalLocal.history)
        for (const body of fixture.state.blobs) expect(await readBlob(backup.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      } finally { await disposeWorkspaceSnapshot(backup) }
      const undone = await selected.undo(finalLocal.localData.revision)
      expect(undone.localData.personalDefinitions).toEqual(first.localData.personalDefinitions)
      expect((await selected.readWorkspace()).planner.history.slice(0, finalLocal.history.length)).toEqual(finalLocal.history)
    } finally { await projection.dispose() }

    invalidateProfile()
    await expect(activateIncrementalMapping(database, token, second)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { await store.dispose(); database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('maps every inherited original with exact bytes and rejects a replaced outbox at final activation', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  const fixture = await editorClosureFixture()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'historical-mapping-source', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: { synthetic: 'original' }, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  let exported: Awaited<ReturnType<typeof captureAccountSnapshot>> | undefined
  try {
    const operation = accountLocalId(), evidence = await guestEvidenceFromFrozenCurrent(original)
    const inherited = await prepareLocalEvidence(store.adapter, operation, evidence)
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime, undefined, inherited)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Historical mapping sentinel' }), fixture.state.planner.localData.revision)
    const row = (await database.outbox.toArray())[0]!, fence = (await database.profileMeta.get('active'))!
    const ticket = await prepareIncrementalMapping(database, token, row)
    await database.outbox.put({ ...row, ref: fence.head })
    await expect(activateIncrementalMapping(database, token, ticket)).rejects.toThrow(/changed/)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    await database.outbox.put(row)
    await activateIncrementalMapping(database, token, ticket)
    const intent = await openAccountJson(database, token, (await database.outbox.get(row.id))!.ref, MappedWorkspaceIntentSchema)
    const mapped = await openAccountWorkspace(database, token, intent.target)
    exported = await captureAccountSnapshot(mapped, { ...fence, head: mapped.head }, async () => {}, { database, token })
    expect(exported.version).toBe(2)
    if (exported.version !== 2) throw new Error('Inherited original did not map')
    const historical = await openHistoricalSnapshot(exported, exported.historicalEvidence.snapshots[0]!.id)
    try {
      expect(historical.state.planner).toEqual(fixture.state.planner)
      expect(historical.state.editorDocuments).toEqual(fixture.state.editorDocuments)
      for (const body of historical.state.blobs) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(fixture.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength))
    } finally { await disposeWorkspaceSnapshot(historical) }
    expect(await database.profileMeta.get('active')).toEqual(fence)
  } finally { if (exported) await disposeWorkspaceSnapshot(exported); await disposeWorkspaceSnapshot(original); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('maps a fresh managed baseline without selecting a native head and reuses it for the first queued save', async () => {
  const accountId = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(accountId, key.slice()), database = new AccountDatabase(accountId)
  const store = createAccountLocalStore(database, token), fixture = await editorClosureFixture()
  try {
    const operation = accountLocalId(), prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const ticket = await prepareIncrementalBaseline(database, token, fence)
    expect(await readIncrementalMappedRoot(database, token, fence)).toBeUndefined()
    expect(await database.profileMeta.get('active')).toEqual(fence)
    invalidateProfile(); database.close(); token = installProfile(accountId, key.slice()); database = new AccountDatabase(accountId)
    expect(await prepareIncrementalBaseline(database, token, fence)).toEqual(ticket)
    await activateIncrementalBaseline(database, token, ticket)
    const mapped = (await readIncrementalMappedRoot(database, token, fence))!
    expect((await openAccountWorkspace(database, token, mapped)).state.planner).toEqual(fixture.state.planner)
    await activateIncrementalBaseline(database, token, ticket)
    const repository = await openAccountManagedRepository(database, token, fence)
    await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'After baseline mapping' }), fixture.state.planner.localData.revision)
    const row = (await database.outbox.toArray())[0]!, after = (await database.profileMeta.get('active'))!
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, row))
    expect((await openAccountJson(database, token, (await database.outbox.get(row.id))!.ref, MappedWorkspaceIntentSchema)).base).toEqual(mapped)
    expect(await database.profileMeta.get('active')).toEqual(after)
    expect(await readIncrementalMappedRoot(database, token, { ...after, head: fence.head })).toBeUndefined()
    await expect(activateIncrementalBaseline(database, token, { ...ticket, operationId: accountLocalId() })).rejects.toThrow()
  } finally { await store.dispose(); database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('reuses the exact encrypted sidecar association after restart and rejects a foreign local-sidecar binding', async () => {
  const accountId = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(accountId, key.slice()), database = new AccountDatabase(accountId), store = createAccountLocalStore(database, token)
  const fixture = await editorClosureFixture(), original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'evidence-reuse-source', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: { source: 'one' }, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  try {
    const operation = accountLocalId(), evidence = await guestEvidenceFromFrozenCurrent(original)
    const inherited = await prepareLocalEvidence(store.adapter, operation, evidence)
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime, undefined, inherited)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const first = await ensureIncrementalAccountEvidence(database, token, store, prepared.snapshot)
    const counts = [await database.encryptedRevisions.count(), await database.stagedCipherChunks.count()]
    await store.dispose(); invalidateProfile(); database.close()
    token = installProfile(accountId, key.slice()); database = new AccountDatabase(accountId); store = createAccountLocalStore(database, token)
    const selected = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    expect(await ensureIncrementalAccountEvidence(database, token, store, selected)).toEqual(first)
    expect([await database.encryptedRevisions.count(), await database.stagedCipherChunks.count()]).toEqual(counts)
    const row = (await database.syncState.get(`incremental-evidence:${inherited.revisionId}`))!
    const forged = await stageAccountJson(database, token, { version: 1, kind: 'incremental-evidence-association', accountId, localEvidence: fence.head, evidence: first }, [fence.head, first!])
    await database.encryptedRevisions.add(forged)
    await database.syncState.put({ id: row.id, ref: cipherRef(forged) })
    await expect(ensureIncrementalAccountEvidence(database, token, store, selected)).rejects.toThrow('Managed historical association changed')
    expect(await database.profileMeta.get('active')).toEqual(fence)
    await database.syncState.put(row)
    expect(await ensureIncrementalAccountEvidence(database, token, store, selected)).toEqual(first)
  } finally { await store.dispose(); await disposeWorkspaceSnapshot(original); database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('retains unmatched native journal endpoints at the publication boundary', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), base = fixture.state.planner.localData
    const localData = changedLocalDataWithSharedUnits(base, createPersonalDefinition(base, { kind: 'item', name: 'Journal-only recovery sentinel' }), 'legacy-local', base.updatedAt)
    const checkpoint = historyEntry(base, localData, 'legacy-local', base.updatedAt)
    const planner = { ...fixture.state.planner, localData, savedChanges: localData.changes, journal: { version: 1 as const, changes: localData.changes, checkpoints: [checkpoint], undoable: true } }
    const operation = accountLocalId(), prepared = await prepareLocalWorkspace(store.adapter, operation, { ...fixture.state, planner }, store.lifetime)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
    const mapped = await openAccountWorkspace(database, token, (await readIncrementalMappedRoot(database, token, fence))!)
    expect(mapped.state.planner.journal).toEqual(planner.journal)
    expect(mapped.state.planner.history).toEqual([])
    expect((await admitLocalRoot(store.adapter, fence.head, store.lifetime)).state.planner).toEqual(planner)
    expect(await database.profileMeta.get('active')).toEqual(fence)
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('reuses unchanged managed historical bodies before native cloning and encoding', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const first = await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Retained history work sentinel' }), fixture.state.planner.localData.revision)
    const firstRow = (await database.outbox.toArray())[0]!
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, firstRow))
    const mappedFirst = await openAccountJson(database, token, (await database.outbox.get(firstRow.id))!.ref, MappedWorkspaceIntentSchema)
    const firstTarget = await openAccountWorkspace(database, token, mappedFirst.target)
    const historical = firstTarget.state.planner.history[0]!
    const oldEntry = firstTarget.entries.find(value => value.kind === 'history')!
    await repository.save(createPersonalDefinition(first.localData, { kind: 'item', name: 'New history work sentinel' }), first.localData.revision)
    const secondRow = (await database.outbox.toArray()).find(value => value.id !== firstRow.id)!
    const serialize = JSON.stringify.bind(JSON)
    let oldBodySerializations = 0
    const json = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (value && typeof value === 'object' && value.id === historical.id && 'before' in value && 'after' in value) oldBodySerializations++
      return serialize(value, ...args)
    })
    const codec = vi.spyOn(documentCodec, 'workspaceDocumentSource')
    const historyParsing = vi.spyOn(NativeHistorySchema._zod, 'run')
    const endpointChecks: Parameters<typeof localDataValidation.validateLocalDataForStorage>[] = []
    const validateDomain = localDataValidation.validateLocalDataForStorage
    const domainValidation = vi.spyOn(localDataValidation, 'validateLocalDataForStorage').mockImplementation((value, catalogs) => {
      if (isImmutableHistoryEndpoint(value) && Object.isFrozen(catalogs)) endpointChecks.push([value, catalogs])
      return validateDomain(value, catalogs)
    })
    let oldParses = 0, repeatedEndpointChecks = 0
    let oldEncodes = 0, newEncodes = 0
    try {
      await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, secondRow))
      const historyCalls = codec.mock.calls.map(([document]) => document).filter(document => document.kind === 'history')
      oldEncodes = historyCalls.filter(document => document.key === oldEntry.key).length
      newEncodes = historyCalls.filter(document => document.key !== oldEntry.key).length
      oldParses = historyParsing.mock.calls.filter(([payload]) => (payload.value as { id?: string })?.id === historical.id).length
      const seen = new Map<object, readonly unknown[][]>()
      for (const [value, catalogs] of endpointChecks) {
        const contexts = seen.get(value) ?? []
        if (contexts.some(context => context.length === catalogs.length && context.every((catalog, at) => catalog === catalogs[at]))) repeatedEndpointChecks++
        seen.set(value, [...contexts, catalogs.slice()])
      }
    } finally { json.mockRestore(); codec.mockRestore(); historyParsing.mockRestore(); domainValidation.mockRestore() }
    const mappedSecond = await openAccountJson(database, token, (await database.outbox.get(secondRow.id))!.ref, MappedWorkspaceIntentSchema)
    const secondTarget = await openAccountWorkspace(database, token, mappedSecond.target)
    expect(mappedSecond.base).toEqual(mappedFirst.target)
    expect(secondTarget.entries.find(value => value.key === oldEntry.key)).toEqual(oldEntry)
    expect(secondTarget.state.planner.history[0]).toEqual(historical)
    expect(secondTarget.state.planner.history).toHaveLength(2)
    // The native base and final stored target each admit the full old frame; compact roots reuse endpoint shapes
    expect(oldParses).toBe(2)
    expect(repeatedEndpointChecks).toBe(0)
    expect(newEncodes).toBe(1)
    expect({ oldBodySerializations, oldEncodes }).toEqual({ oldBodySerializations: 0, oldEncodes: 0 })
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('binds native history reuse to private admissions, exact predecessors and immutable source captures', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const first = await repository.save(createPersonalDefinition(fixture.state.planner.localData, { kind: 'item', name: 'Captured historical identity' }), fixture.state.planner.localData.revision)
    const firstFence = (await database.profileMeta.get('active'))!, firstRow = (await database.outbox.toArray())[0]!
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, firstRow))
    const firstMapped = await openAccountJson(database, token, (await database.outbox.get(firstRow.id))!.ref, MappedWorkspaceIntentSchema)
    const previous = await openAccountWorkspace(database, token, firstMapped.target)
    const before = await admitLocalRoot(store.adapter, firstFence.head, store.lifetime)
    await repository.save(createPersonalDefinition(first.localData, { kind: 'item', name: 'New historical identity' }), first.localData.revision)
    const after = await admitLocalRoot(store.adapter, (await database.profileMeta.get('active'))!.head, store.lifetime)
    await expect(prepareAccountHistoryReuse(database, token, { ...before }, after, store.adapter, previous, firstFence.headRevision)).rejects.toThrow(/Foreign local/)
    await expect(prepareAccountHistoryReuse(database, token, before, after, { ...store.adapter }, previous, firstFence.headRevision)).rejects.toThrow(/Foreign local/)
    await expect(prepareAccountHistoryReuse(database, token, before, after, store.adapter, { ...previous }, firstFence.headRevision)).rejects.toThrow(/Foreign native/)
    await expect(prepareAccountHistoryReuse(database, token, before, after, store.adapter, previous, firstFence.headRevision + 1)).rejects.toThrow(/predecessor/)
    const proof = await prepareAccountHistoryReuse(database, token, before, after, store.adapter, previous, firstFence.headRevision)
    const state = { ...after.state, planner: { ...after.state.planner, journal: { ...after.state.planner.journal!, checkpoints: [] } } }
    await expect(prepareAccountWorkspace(database, token, state, previous, undefined, { ...proof })).rejects.toThrow(/Foreign managed/)
    await expect(prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, history: [...state.planner.history] } }, previous, undefined, proof)).rejects.toThrow(/history input/)
    // Equal IDs in a separately allocated local frame do not establish unchanged history
    const separate = await prepareLocalWorkspace(store.adapter, accountLocalId(), after.state, store.lifetime)
    const separateProof = await prepareAccountHistoryReuse(database, token, before, separate.snapshot, store.adapter, previous, firstFence.headRevision)
    const separateState = { ...separate.snapshot.state, planner: { ...separate.snapshot.state.planner, journal: { ...separate.snapshot.state.planner.journal!, checkpoints: [] } } }
    const codec = vi.spyOn(documentCodec, 'workspaceDocumentSource')
    try {
      await prepareAccountWorkspace(database, token, separateState, previous, undefined, separateProof)
      expect(codec.mock.calls.filter(([document]) => document.kind === 'history')).toHaveLength(after.state.planner.history.length)
    } finally { codec.mockRestore() }
    const entry = previous.entries.find(value => value.kind === 'history')!, saved = structuredClone(entry)
    entry.ref.revisionId = accountLocalId()
    ;(previous.payloads as Map<string, import('./documents').BlobSource>).set(entry.key, { byteLength: 1, async *open() { yield new Uint8Array([0]) } })
    const prepared = await prepareAccountWorkspace(database, token, state, previous, undefined, proof)
    expect(prepared.entries.find(value => value.key === saved.key)).toEqual(saved)
    const successorEntry = prepared.entries.find(value => value.key === saved.key)!
    successorEntry.ref.revisionId = accountLocalId()
    const repeated = await prepareAccountWorkspace(database, token, state, previous, undefined, proof)
    expect(repeated.entries.find(value => value.key === saved.key)).toEqual(saved)
    // Restore the exposed test metadata; staged index bytes were already captured independently
    successorEntry.ref.revisionId = saved.ref.revisionId
    await database.encryptedRevisions.bulkAdd([...prepared.records])
    expect((await openAccountWorkspace(database, token, prepared.head)).state.planner.history).toEqual(after.state.planner.history)
    const record = (await database.encryptedRevisions.get(saved.ref.revisionId))!, chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    const bytes = chunk.bytes.slice(); bytes[bytes.length - 1] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes })
    await expect(openAccountWorkspace(database, token, prepared.head)).rejects.toThrow()
    invalidateProfile()
    await expect(prepareAccountWorkspace(database, token, state, previous, undefined, proof)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)
