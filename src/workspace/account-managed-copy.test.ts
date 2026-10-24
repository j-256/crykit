import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import * as activation from '../persistence/account-database'
import { AccountDatabase, type CipherChunk } from '../persistence/account-database'
import { accountLocalId, openAccountJson } from './account-cache'
import { editorClosureFixture } from './test-helpers'
import { createAccountLocalStore } from './account-local-store'
import { LocalWorkspaceRootV3Schema, prepareLocalWorkspace } from './local-root'
import { prepareIncrementalBaseline, activateIncrementalBaseline, prepareIncrementalMapping, activateIncrementalMapping, readIncrementalMappedRoot } from './account-local-mapping'
import { createGuestCopyService } from './guest-copy'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, type WorkspaceSnapshot } from './snapshot'
import { openAccountRepository } from './account-repository'
import { createPersonalDefinition } from '../domain'
import { openAccountManagedRepository } from './account-managed-repository'
import { blobIdentity, readBlob } from './blobs'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { captureAccountSnapshot } from './account-snapshot'
import { captureAccountSyncWorkspace } from './account-sync-capture'

it('resumes an exact saved guest copy into managed selection without recapturing or losing its native download', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), store = createAccountLocalStore(database, token), id = accountLocalId()
  const copiedState = { ...fixture.state, editorDocuments: [fixture.file] }
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'managed-copy-original', capturedAt: fixture.state.planner.localData.updatedAt, revisionVector: {}, state: copiedState }, { check: async () => {}, dispose: async () => {} })
  let service = createGuestCopyService(async () => source)
  try {
    const beforeState = { ...fixture.state, editorDocuments: [] }
    const initial = await prepareLocalWorkspace(store.adapter, id, beforeState, store.lifetime)
    const before = await activation.activateLocalAccountCommit(database, token, await store.prepareActivation(id, initial, undefined)); store.committed(id)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, before))
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
    const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Copy activation interrupted'))
    await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Copy activation interrupted')
    fail.mockRestore()
    expect(await database.profileMeta.get('active')).toEqual(before)
    await service.dispose()
    service = createGuestCopyService(async () => { throw new Error('Guest recapture is forbidden') })
    const resumed = await service.previewGuestCopy(token), receipt = await service.commitGuestCopy(token, resumed)
    expect(await service.commitGuestCopy(token, resumed)).toEqual(receipt)
    const pending = (await database.outbox.toArray())[0]!
    expect(pending.status).toBe('unmapped-local')
    expect(await readIncrementalMappedRoot(database, token, (await database.profileMeta.get('active'))!)).toBeUndefined()
    // Projection is separate real work after the copy is durable and editable
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, pending))
    expect(await service.commitGuestCopy(token, resumed)).toEqual(receipt)
    const selected = (await database.profileMeta.get('active'))!, mapped = await readIncrementalMappedRoot(database, token, selected)
    expect(mapped).toBeDefined(); expect(mapped).not.toEqual(selected.head)
    const state = await (await openAccountManagedRepository(database, token, selected)).readWorkspace()
    expect(state.editorDocuments).toEqual(copiedState.editorDocuments)
    for (const original of fixture.state.blobs) {
      const body = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(original.ref))!
      expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(original.content, original.ref.byteLength))
    }
    expect(await service.listSavedGuestCopies(token)).toMatchObject([{ activated: true, pending: false }])
    await service.withSavedGuestCopy(token, receipt.copyId, async snapshot => { expect(snapshot.state.editorDocuments).toEqual(copiedState.editorDocuments) })
    expect((await database.outbox.toArray())[0]!.status).toBe('mapped-local')
    expect(await service.inspectCopiedComparisons(token)).toEqual([])
    await expect(service.continueCopiedComparisons(token, receipt.copyId)).rejects.toThrow('Finish syncing')
    const journal = (await database.migrationJournal.get(receipt.copyId))!
    await database.migrationJournal.put({ ...journal, head: before.head })
    await expect(service.listSavedGuestCopies(token)).rejects.toThrow('Saved copy receipt does not match')
    await database.migrationJournal.put(journal)
    expect(await service.listSavedGuestCopies(token)).toMatchObject([{ activated: true }])
  } finally { vi.restoreAllMocks(); await service.dispose(); await disposeWorkspaceSnapshot(source); await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('reads the managed operative revision before rejecting stale or missing captured conflict choices', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), store = createAccountLocalStore(database, token), id = accountLocalId()
  try {
    const initial = await prepareLocalWorkspace(store.adapter, id, fixture.state, store.lifetime)
    const before = await activation.activateLocalAccountCommit(database, token, await store.prepareActivation(id, initial, undefined)); store.committed(id)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, before))
    const { resolveAccountConflict } = await import('../account/sync/resolution')
    await expect(resolveAccountConflict(token, 'missing-conflict', 'this', fixture.state.planner.localData.revision + 1)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' })
    await expect(resolveAccountConflict(token, 'missing-conflict', 'other', fixture.state.planner.localData.revision)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' })
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.outbox.count()).toBe(0)
    invalidateProfile()
    await expect(resolveAccountConflict(token, 'missing-conflict', 'both', fixture.state.planner.localData.revision)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('resumes a first managed copy after profile restart using only its exact saved ciphertext', async () => {
  const id = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(id, key.slice()), database = new AccountDatabase(id)
  const fixture = await editorClosureFixture(), state = { ...fixture.state, editorDocuments: [fixture.file] }
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'fresh-copy-restart', capturedAt: fixture.file.updatedAt, revisionVector: {}, state }, { check: async () => {}, dispose: async () => {} })
  let service = createGuestCopyService(async () => source)
  try {
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
    const before = await database.profileMeta.get('active')
    const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Copy activation interrupted'))
    await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Copy activation interrupted')
    fail.mockRestore()
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.outbox.count()).toBe(0)
    const records = await database.encryptedRevisions.toArray(), chunks = await database.stagedCipherChunks.toArray()
    await service.dispose(); database.close(); invalidateProfile()
    const retired = token
    token = installProfile(id, key.slice()); database = new AccountDatabase(id)
    await expect(service.commitGuestCopy(retired, preview)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    service = createGuestCopyService(async () => { throw new Error('Guest recapture is forbidden') })
    const resumed = await service.previewGuestCopy(token)
    expect(resumed.resumable).toBe(true)
    const receipt = await service.commitGuestCopy(token, resumed)
    expect(receipt.copyId).toBe(preview.copyId)
    expect(await database.encryptedRevisions.toArray()).toEqual(records)
    expect(await database.stagedCipherChunks.toArray()).toEqual(chunks)
    const selected = (await database.profileMeta.get('active'))!
    const current = await (await openAccountRepository(token)).readWorkspace()
    expect(current.editorDocuments).toEqual([fixture.file])
    for (const body of fixture.state.blobs) expect(await readBlob(current.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    expect(await service.commitGuestCopy(token, resumed)).toEqual(receipt)
    expect(await database.profileMeta.get('active')).toEqual(selected)
    expect((await database.outbox.toArray()).map(row => row.status)).toEqual(['unmapped-local'])
  } finally { vi.restoreAllMocks(); await service.dispose(); await disposeWorkspaceSnapshot(source); database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('rejects changed staged ciphertext at the final managed-copy CAS and retains the exact resumable group', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), state = { ...fixture.state, editorDocuments: [fixture.file] }
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'managed-copy-ciphertext-fence', capturedAt: fixture.file.updatedAt, revisionVector: {}, state }, { check: async () => {}, dispose: async () => {} })
  let service = createGuestCopyService(async () => source)
  try {
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]']), before = await database.profileMeta.get('active')
    const activate = activation.activateLocalAccountCommit
    let original: CipherChunk | undefined
    const change = vi.spyOn(activation, 'activateLocalAccountCommit').mockImplementationOnce(async (db, profile, prepared, guard) => {
      const record = (await db.encryptedRevisions.get(prepared.head.revisionId))!
      original = (await db.stagedCipherChunks.get([record.payloadId, 0]))!
      const bytes = original.bytes.slice(); bytes[0] ^= 1
      await db.stagedCipherChunks.put({ ...original, bytes })
      return activate(db, profile, prepared, guard)
    })
    await expect(service.commitGuestCopy(token, preview)).rejects.toThrow(/bytes changed/)
    change.mockRestore()
    expect(await database.profileMeta.get('active')).toEqual(before)
    expect(await database.outbox.count()).toBe(0)
    expect(await database.syncState.get('guest-copy:pending')).toBeDefined()
    expect(original).toBeDefined()
    await database.stagedCipherChunks.put(original!)
    const records = await database.encryptedRevisions.toArray()
    await service.dispose()
    service = createGuestCopyService(async () => { throw new Error('Guest recapture is forbidden') })
    const resumed = await service.previewGuestCopy(token)
    await service.commitGuestCopy(token, resumed)
    expect(await database.encryptedRevisions.toArray()).toEqual(records)
    expect((await (await openAccountRepository(token)).readWorkspace()).editorDocuments).toEqual([fixture.file])
  } finally { vi.restoreAllMocks(); await service.dispose(); await disposeWorkspaceSnapshot(source); database.close(); invalidateProfile() }
}, 30_000)

it('keeps a stale managed copy downloadable and adds a fresh copy without mapping pending local edits', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), state = { ...fixture.state, editorDocuments: [fixture.file] }
  const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'stale-managed-copy', capturedAt: fixture.file.updatedAt, revisionVector: {}, state }, { check: async () => {}, dispose: async () => {} }))
  try {
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
    const fail = vi.spyOn(activation, 'activateLocalAccountCommit').mockRejectedValueOnce(new Error('Copy activation interrupted'))
    await expect(service.commitGuestCopy(token, preview)).rejects.toThrow('Copy activation interrupted')
    fail.mockRestore()
    const repository = await openAccountRepository(token), loaded = await repository.load()
    const edited = await repository.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Keep this pending local edit' }), loaded.revision)
    const advanced = await database.profileMeta.get('active')
    const stale = await service.previewGuestCopy(token)
    expect(stale.problems.join(' ')).toContain('account changed')
    await expect(service.commitGuestCopy(token, stale)).rejects.toThrow()
    expect(await service.keepSavedCopyAndRepreview(token, stale)).toEqual({ activated: false })
    await service.withSavedGuestCopy(token, preview.copyId, async saved => { expect(saved.state.editorDocuments).toEqual([fixture.file]) })
    expect(await database.profileMeta.get('active')).toEqual(advanced)
    const fresh = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
    expect(fresh.copyId).not.toBe(preview.copyId)
    await service.commitGuestCopy(token, fresh)
    const current = await (await openAccountRepository(token)).readWorkspace()
    expect(current.planner.localData.personalDefinitions).toEqual(edited.localData.personalDefinitions)
    expect(current.editorDocuments).toEqual([fixture.file])
    expect((await database.outbox.toArray()).map(row => row.status)).toEqual(['unmapped-local', 'unmapped-local'])
    await expect(service.withSavedGuestCopy(token, preview.copyId, async saved => {
      const content = saved.state.blobs[0].content
      invalidateProfile()
      await expect(readBlob(content, saved.state.blobs[0].ref.byteLength)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    })).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { vi.restoreAllMocks(); await service.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('retains an unselected historical original through direct copy and the real cloud mapping codec', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture(), originalBytes = new Uint8Array([0xff, 0x00, 0x42, 0x80])
  const archivedRef = await fixture.add(originalBytes, 'historical-only-original', 'utf16le')
  const archivedFile = { ...fixture.file, filename: 'Historical only.json', original: archivedRef, lastApplied: archivedRef, unfinished: { ...fixture.file.unfinished, text: archivedRef } }
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'unselected-historical-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [archivedFile], retainedContent: [], blobs: fixture.blobs.filter(body => body.ref === archivedRef) } }, { check: async () => {}, dispose: async () => {} })
  const current = ownWorkspaceSnapshot({ version: 1, snapshotId: 'selected-current-draft', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file], blobs: fixture.blobs.filter(body => body.ref !== archivedRef) } }, { check: async () => {}, dispose: async () => {} })
  const source = await inheritWorkspaceSnapshot(current, [original])
  const service = createGuestCopyService(async () => source)
  let mappedSnapshot: WorkspaceSnapshot | undefined
  try {
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]', '["workspace-identity"]'])
    expect(preview.problems).toEqual([])
    await service.commitGuestCopy(token, preview)
    const fence = (await database.profileMeta.get('active'))!, pending = (await database.outbox.toArray())[0]!
    expect(pending.status).toBe('unmapped-local')
    const localRevisions = new Set((await database.encryptedRevisions.toArray()).map(record => record.revisionId))
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, pending))
    const mapped = await readIncrementalMappedRoot(database, token, fence)
    expect(mapped).toBeDefined()
    const localRoot = await openAccountJson(database, token, fence.head, LocalWorkspaceRootV3Schema)
    let archiveReads = 0
    database.encryptedRevisions.hook('reading', row => { if (row?.revisionId === localRoot.inheritedEvidence.revisionId) archiveReads++; return row })
    const sync = await captureAccountSyncWorkspace(database, token, fence)
    try {
      expect(archiveReads).toBe(0)
      expect(sync.inheritedEvidence).toEqual(sync.workspace.inheritedEvidence)
      mappedSnapshot = await captureAccountSnapshot(sync.workspace, fence, async () => {}, { database, token })
    } finally { await sync.dispose() }
    expect(mappedSnapshot.state.editorDocuments.map(file => file.filename)).toEqual([fixture.file.filename])
    if (mappedSnapshot.version !== 2) throw new Error('The mapped history is missing')
    let found = false
    for (const member of mappedSnapshot.historicalEvidence.snapshots) {
      const child = await openHistoricalSnapshot(mappedSnapshot, member.id)
      try {
        if (!child.state.editorDocuments.some(file => file.filename === archivedFile.filename)) continue
        const body = child.state.blobs.find(body => blobIdentity(body.ref) === blobIdentity(archivedRef))
        expect(body).toBeDefined()
        expect(await readBlob(body!.content, archivedRef.byteLength)).toEqual(originalBytes)
        found = true
      } finally { await disposeWorkspaceSnapshot(child) }
    }
    expect(found).toBe(true)
    const nativeOriginal = (await database.encryptedRevisions.toArray()).find(record => !localRevisions.has(record.revisionId) && record.descriptor.plainBytes === originalBytes.length)
    expect(nativeOriginal).toBeDefined()
    const chunk = (await database.stagedCipherChunks.get([nativeOriginal!.payloadId, 0]))!, damaged = chunk.bytes.slice()
    damaged[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes: damaged })
    await expect(captureAccountSyncWorkspace(database, token, fence)).rejects.toThrow()
  } finally {
    if (mappedSnapshot) await disposeWorkspaceSnapshot(mappedSnapshot)
    await service.dispose(); await disposeWorkspaceSnapshot(source); await disposeWorkspaceSnapshot(current); await disposeWorkspaceSnapshot(original)
    database.close(); invalidateProfile()
  }
}, 30_000)
