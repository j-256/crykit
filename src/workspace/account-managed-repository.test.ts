import 'fake-indexeddb/auto'
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openAccountRepository } from './account-repository'
import { openAccountManagedRepository } from './account-managed-repository'
import { createSaveRepository } from './save-repository'
import { resolveOwnedFileReceipt } from './owned-file-command'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { createSharePayload, saveSharedCopy } from '../interchange/share'
import { createSaveEditorFixture } from '../domain/save-editor.fixture'
import { encodeCrystalSave } from '../interchange/crystal-save'
import { editorBlob } from './editor-document'
import type { SaveWorkspaceDocument, WorkspaceState } from './documents'
import { readSaveContent } from './save-repository'

it('starts with current definitions and retains an older catalog when copying its pinned Build', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const repository = await openAccountRepository(token), initial = await repository.load()
    expect(initial.catalogs.map(catalog => catalog.revisionId)).toEqual([CURRENT_CATALOG.revisionId])
    const historical = BUNDLED_CATALOGS.find(catalog => catalog.revisionId !== CURRENT_CATALOG.revisionId)!
    const source = createSampleLocalData(historical), original = Object.values(source.builds)[0]!
    const payload = createSharePayload(source, { kind: 'build', revisionId: original.latestRevisionId! })
    const copy = saveSharedCopy(initial.localData, payload)
    await repository.save(copy.localData, initial.revision)
    const reopened = await openAccountRepository(token), saved = await reopened.load()
    const checkpoint = saved.localData.buildRevisions[saved.localData.builds[copy.buildId!]!.latestRevisionId!]!
    expect(saved.localData.gameSetups[checkpoint.gameSetupRevisionId]!.catalogLock[historical.id]).toBe(historical.revisionId)
    expect(saved.catalogs.map(catalog => catalog.revisionId)).toEqual([CURRENT_CATALOG.revisionId, historical.revisionId])
    expect(initial.catalogs.map(catalog => catalog.revisionId)).toEqual([CURRENT_CATALOG.revisionId])
  } finally { database.close(); invalidateProfile() }
})

it('encrypts ordinary Save edits and reopens exact history while projection is pending', async () => {
  let transactions = 0, writeTransactions = 0
  const nativeTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) { transactions++; if (args[1] === 'readwrite') writeTransactions++; return Reflect.apply(nativeTransaction, this, args) }
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const store = createAccountLocalStore(database, token)
  try {
    const native = createSaveEditorFixture(), original = await editorBlob(encodeCrystalSave(native), 'bytes')
    const localData = createSampleLocalData(BUNDLED_CATALOGS[0]), timestamp = new Date().toISOString()
    const file: SaveWorkspaceDocument = { version: 1, id: 'synthetic-save', revision: 1, filename: 'synthetic.sav', original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: 'supported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [file], assets: [], conflicts: [], retainedContent: [], blobs: [original], libraryDefaults: { version: 1, layers: [] } }
    const operation = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined))
    store.committed(operation)
    let repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const old = repository
    const values = []
    let recordsWritten = 0, bytesWritten = 0, recordsRead = 0, bytesRead = 0
    database.encryptedRevisions.hook('creating', (_key, row) => { recordsWritten++; bytesWritten += row.descriptor.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes, 0) })
    database.encryptedRevisions.hook('reading', row => { if (row) recordsRead++; return row })
    database.stagedCipherChunks.hook('reading', row => { if (row) bytesRead += row.bytes.byteLength; return row })

    for (let revision = 1; revision <= 3; revision++) {
      native.header.currencyAmount = 123 + revision
      const currency = native.party.value.Currency
      if (currency.type !== 'document') throw new Error('Synthetic currency shape')
      currency.value.Val = { type: 'int32', value: 123 + revision }
      const bytes = encodeCrystalSave(native)
      recordsWritten = 0; bytesWritten = 0; recordsRead = 0; bytesRead = 0; transactions = 0; writeTransactions = 0
      const started = performance.now()
      const saved = await createSaveRepository(repository, { intent: 'saveApply', onOutcome: async outcome => {
        expect(outcome.status, 'error' in outcome ? String(outcome.error) : undefined).toBe('saved')
        const completion = await resolveOwnedFileReceipt(outcome.receipt!)
        repository = completion.repository
      } }).saveWorking(file.id, bytes, null, revision)
      const command = { elapsedMs: performance.now() - started, recordsWritten, bytesWritten, recordsRead, bytesRead, transactions, writeTransactions }
      const selected = await repository.readWorkspace()
      const content = await readSaveContent(selected, saved)
      expect(content.workingBytes).toEqual(bytes)
      expect(content.originalBytes).toEqual(encodeCrystalSave(createSaveEditorFixture()))
      values.push({ revision, command, elapsedMs: performance.now() - started, history: selected.planner.history.length, retained: selected.retainedContent.length, recordsWritten, bytesWritten, recordsRead, bytesRead, transactions, writeTransactions })
    }
    if (process.env.R16_RECEIPT_PATH) writeFileSync(process.env.R16_RECEIPT_PATH, JSON.stringify({ runtime: process.version, platform: process.platform, architecture: process.arch, fixtureOriginalBytes: original.content.byteLength, values }, null, 2))
    await expect(old.readWorkspace()).rejects.toThrow()
    const selected = await repository.readWorkspace()
    const reopened = await openAccountRepository(token)
    expect((await database.outbox.toArray()).every(row => row.status === 'unmapped-local')).toBe(true)
    expect(await database.outbox.count()).toBe(3)
    expect((await reopened.readWorkspace()).planner).toEqual(selected.planner)
    expect(values.every(value => value.elapsedMs <= 1000)).toBe(true)
    expect(values.every(value => value.command.writeTransactions === 1)).toBe(true)
    expect(values.slice(1).map(value => value.command.recordsRead)).toEqual([6, 6])
  } finally { IDBDatabase.prototype.transaction = nativeTransaction; await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)
