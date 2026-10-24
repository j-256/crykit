import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace, admitLocalRoot } from './local-root'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { readBlob, hashBlob } from './blobs'
import { editorBlob } from './editor-document'
import type { WorkspaceState } from './documents'

it('activates a fully encrypted managed root and rejects forged or stale admission', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  // A real binary body exceeds inline preparation, so the staged-byte corruption below reaches durable staging
  const original = await editorBlob(new Uint8Array(5 * 1024 * 1024).fill(37), 'bytes')
  const timestamp = new Date().toISOString()
  const file = { version: 1 as const, id: 'staged-original', revision: 1, filename: 'unsupported.sav', original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: 'unsupported' as const, diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [original], libraryDefaults: { version: 1, layers: [] } }
  const store = createAccountLocalStore(database, token)
  try {
    const id = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, id, state, store.lifetime)
    const activation = await store.prepareActivation(id, prepared, undefined)
    await expect(activateLocalAccountCommit(database, token, { ...activation, managedAdmission: {} })).rejects.toThrow()
    await expect(activateLocalAccountCommit(database, token, { ...activation, id: accountLocalId() })).rejects.toThrow()
    const stagedRows = await database.stagedCipherChunks.toArray()
    expect(stagedRows.reduce((bytes, row) => bytes + row.bytes.length, 0)).toBeGreaterThan(4 * 1024 * 1024)
    const staged = stagedRows[0]!
    const corrupt = staged.bytes.slice(); corrupt[0] ^= 1
    await database.stagedCipherChunks.put({ ...staged, bytes: corrupt })
    await expect(activateLocalAccountCommit(database, token, activation)).rejects.toThrow(/bytes changed/)
    expect(await database.profileMeta.get('active')).toBeUndefined()
    await database.stagedCipherChunks.put(staged)
    const fence = await activateLocalAccountCommit(database, token, activation)
    store.committed(id)
    const reopened = (await admitLocalRoot(store.adapter, fence.head, store.lifetime)).state
    expect({ ...reopened, blobs: [] }).toEqual({ ...state, blobs: [] })
    expect(reopened.blobs.map(blob => blob.ref)).toEqual([original.ref])
    expect(await hashBlob(reopened.blobs[0].content)).toBe(original.ref.sha256)
    const durable = JSON.stringify(await database.encryptedRevisions.toArray()) + (await database.stagedCipherChunks.toArray()).map(row => new TextDecoder().decode(row.bytes)).join('')
    expect(durable).not.toContain('local-workspace-graph')
    expect(durable).not.toContain('incremental-local-workspace')
    expect(durable).not.toContain(Object.values(localData.builds)[0]!.title)
    const nextId = accountLocalId()
    const next = await prepareLocalWorkspace(store.adapter, nextId, state, store.lifetime, prepared.snapshot)
    const stale = await store.prepareActivation(nextId, next, undefined)
    await expect(activateLocalAccountCommit(database, token, stale)).rejects.toThrow()
    store.finishAdmission()
    await readBlob(await store.adapter.read(fence.head), 256 * 1024)
    const nextActivation = await store.prepareActivation(nextId, next, fence, prepared.snapshot)
    const headRecord = (await database.encryptedRevisions.get(fence.head.revisionId))!
    const consumed = (await database.stagedCipherChunks.get([headRecord.payloadId, 0]))!
    const altered = consumed.bytes.slice(); altered[0] ^= 1
    await database.stagedCipherChunks.put({ ...consumed, bytes: altered })
    await expect(activateLocalAccountCommit(database, token, nextActivation)).rejects.toThrow(/bytes changed/)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    await database.stagedCipherChunks.put(consumed)
    const candidate = nextActivation.records.find(record => record.revisionId === next.head.revisionId)!
    const foreign = { payloadId: candidate.payloadId, index: 3, bytes: new Uint8Array([9, 8, 7]) }
    await database.stagedCipherChunks.add(foreign)
    await expect(activateLocalAccountCommit(database, token, nextActivation)).rejects.toThrow(/identity was reused/)
    expect(await database.stagedCipherChunks.get([foreign.payloadId, foreign.index])).toEqual(foreign)
    await database.stagedCipherChunks.delete([foreign.payloadId, foreign.index])
    const beforeFailure = await Promise.all(database.tables.map(async table => [table.name, await table.count()]))
    const quotaFailure = () => { throw new Error('synthetic atomic write failure') }
    database.profileMeta.hook('updating', quotaFailure)
    await expect(activateLocalAccountCommit(database, token, nextActivation)).rejects.toThrow('synthetic atomic write failure')
    database.profileMeta.hook('updating').unsubscribe(quotaFailure)
    expect(await Promise.all(database.tables.map(async table => [table.name, await table.count()]))).toEqual(beforeFailure)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    invalidateProfile()
    await expect(activateLocalAccountCommit(database, token, nextActivation)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toEqual(fence)
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 15_000)
