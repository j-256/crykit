import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { AccountDatabase, activateLocalAccountCommit, type CipherChunk } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { createBlankLocalData } from '../domain/local-data'
import { accountLocalId, openAccountJson, CipherRefSchema } from './account-cache'
import { openAccountWorkspace, prepareAccountWorkspace } from './account-graph'
import type { WorkspaceState } from './documents'
import { privateRecordKey } from './documents'
import { editorClosureFixture } from './test-helpers'
import { editorBlob, encodeEditorText } from './editor-document'
import { blobIdentity } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openAccountManagedRepository } from './account-managed-repository'
import { createPersonalDefinition } from '../domain'
import { prepareIncrementalMapping } from './account-local-mapping'

// Staging check, final frame scan, full-body digest and the editor's three exact references
const MAPPING_BODY_READ_PASSES = 6

it('authenticates and decodes a native historical frame in one ciphertext pass', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  try {
    const before = createBlankLocalData(), after = { ...before, revision: 1 }
    const history = [{ id: 'exact-original-history', localDataId: before.id, command: 'synthetic-change', previousRevision: 0, nextRevision: 1, before, after, recordedAt: before.updatedAt }]
    const state: WorkspaceState = { planner: { localData: after, lineage: { rootLocalDataId: before.id }, catalogs: [], evidence: [], sources: [], history }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    await database.encryptedRevisions.bulkAdd([...prepared.records])
    const entry = prepared.entries.find(value => value.kind === 'history')!
    const record = prepared.records.find(value => value.revisionId === entry.ref.revisionId)!
    let reads = 0
    database.stagedCipherChunks.hook('reading', row => { if (row?.payloadId === record.payloadId) reads++; return row })
    const opened = await openAccountWorkspace(database, token, prepared.head)
    expect(opened.state.planner.history).toEqual(history)
    expect(reads).toBe(record.descriptor.chunks.length)
    const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    const bytes = chunk.bytes.slice(); bytes[bytes.length - 1] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes })
    await expect(openAccountWorkspace(database, token, prepared.head)).rejects.toThrow()
  } finally { database.close(); invalidateProfile() }
})

for (const corrupt of [false, true]) it(`validates stored mapping output once after constructing intermediate views; corruption: ${corrupt}`, async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), original = await editorBlob(encodeEditorText('Unrelated original'.repeat(2048)), 'utf16le')
    const file = { ...fixture.file, original: original.ref, lastApplied: original.ref, unfinished: { ...fixture.file.unfinished, text: original.ref } }
    const state: WorkspaceState = { ...fixture.state, editorDocuments: [file], blobs: [original], retainedContent: [] }
    const operation = accountLocalId(), prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    await repository.save(createPersonalDefinition(state.planner.localData, { kind: 'item', name: 'Mapping work sentinel' }), state.planner.localData.revision)
    const selected = await database.profileMeta.get('active'), intent = (await database.outbox.toArray())[0]!
    const counts = new Map<string, number>()
    database.stagedCipherChunks.hook('reading', row => { if (row) counts.set(row.payloadId, (counts.get(row.payloadId) ?? 0) + 1); return row })
    let corrupted = false, corruption: Promise<unknown> | undefined
    if (corrupt) {
      const frameLength = workspaceDocumentSource({ version: 1, kind: 'blob', key: privateRecordKey('blob', blobIdentity(original.ref)), value: original.content }).byteLength
      database.encryptedRevisions.hook('creating', (_key, record, transaction) => {
        if (corrupted || record.descriptor.plainBytes !== frameLength) return
        corrupted = true
        // The local source predates this hook; corrupt only newly constructed native ciphertext
        const chunks = transaction.table<CipherChunk>('stagedCipherChunks')
        corruption = chunks.get([record.payloadId, 0]).then(chunk => {
          const bytes = chunk!.bytes.slice(); bytes[bytes.length - 1] ^= 1
          return chunks.put({ ...chunk!, bytes })
        })
      })
      await expect(prepareIncrementalMapping(database, token, intent)).rejects.toThrow()
      await corruption
      expect(corrupted).toBe(true)
      expect(await database.profileMeta.get('active')).toEqual(selected)
      expect(await database.outbox.get(intent.id)).toEqual(intent)
      expect(await database.syncState.get(`incremental-mapping:${intent.id}`)).toBeUndefined()
      return
    }
    const ticket = await prepareIncrementalMapping(database, token, intent), observed = new Map(counts)
    const receipt = await openAccountJson(database, token, ticket.receipt, z.object({ base: CipherRefSchema }))
    const base = await openAccountWorkspace(database, token, receipt.base)
    const body = base.entries.find(entry => entry.key === privateRecordKey('blob', blobIdentity(original.ref)))!
    const record = (await database.encryptedRevisions.get(body.ref.revisionId))!
    expect(observed.get(record.payloadId)).toBeGreaterThan(0)
    expect(observed.get(record.payloadId)).toBeLessThanOrEqual(record.descriptor.chunks.length * MAPPING_BODY_READ_PASSES)
    expect(await database.profileMeta.get('active')).toEqual(selected)
    expect(await database.outbox.get(intent.id)).toEqual(intent)
  } finally { await store.dispose(); database.close(); invalidateProfile() }
})
