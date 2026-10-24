import 'fake-indexeddb/auto'
import { openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { expect, it } from 'vitest'
import { createBlankLocalData, createPersonalDefinition, createPlaythrough } from '../domain/local-data'
import { observeInventory } from '../domain/inventory'
import { updateLocalData } from '../domain/core'
import type { LocalData, PlaythroughId, Timestamp } from '../domain/types'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace, openAccountWorkspace } from '../workspace/account-graph'
import { mappedChanges } from '../workspace/account-intents'
import { archiveWorkspaceUnit } from '../workspace/pending-content'
import { inspectWorkspaceClosure } from '../workspace/closure'
import type { WorkspaceState } from '../workspace/documents'

function rename(localData: LocalData, id: PlaythroughId, label: string): LocalData {
  const at = '2026-01-03T00:00:00.000Z' as Timestamp
  const playthrough = localData.playthroughs[id]
  return updateLocalData(localData, { playthroughs: { ...localData.playthroughs, [id]: { ...playthrough, label, revision: playthrough.revision + 1, updatedAt: at } } }, 'playthrough.rename', [`playthroughs.${id}.label`], at)
}

async function fixture(indexed: boolean) {
  let localData = createPlaythrough(createBlankLocalData(), { label: 'Before' })
  const id = Object.keys(localData.playthroughs)[0] as PlaythroughId
  if (indexed) for (let i = 0; i < 256; i++) {
    localData = createPersonalDefinition(localData, { name: `Captured item ${i}`, kind: 'item' })
    const definition = Object.values(localData.personalDefinitions).at(-1)!
    localData = observeInventory(localData, { ref: { kind: 'personal', definitionId: definition.id }, possession: 'owned', quantity: { kind: 'exact', value: 1 } })
  }
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  return { id, state }
}

for (const indexed of [false, true]) it(`reopens unchanged captured owner evidence after repeated owner edits, indexed=${indexed}`, async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const { id, state } = await fixture(indexed), key = JSON.stringify(['inventory', id])
    const first = await prepareAccountWorkspace(database, token, state)
    let fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: first.head, records: first.records })
    let opened = await openAccountWorkspace(database, token, first.head)
    const original = first.entries.find(entry => entry.key === key)!
    expect(Boolean(original.retainingIndex)).toBe(indexed)
    for (const label of ['After', 'Later']) {
      const localData = rename(opened.state.planner.localData, id, label)
      const next = await prepareAccountWorkspace(database, token, { ...opened.state, planner: { ...opened.state.planner, localData } }, opened)
      expect(next.entries.find(entry => entry.key === key)).toEqual(original)
      expect(mappedChanges(opened, next.opened).some(change => change.key === key)).toBe(false)
      fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: next.head, records: next.records })
      opened = await openAccountWorkspace(database, token, next.head)
      expect(opened.state.planner.localData.playthroughs[id].label).toBe(label)
    }
    expect((await openAccountWorkspace(database, token, first.head)).state.planner.localData.playthroughs[id].label).toBe('Before')
    const blobs = new Map<string, WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(opened, key, blobs)
    const portable = { ...opened.state, blobs: [...blobs.values()] }
    expect((await inspectWorkspaceClosure(portable, closure)).value).toEqual({ inventory: state.planner.localData.playthroughs[id].inventory, inventoryEvents: {} })
    const owner = [...blobs.values()].find(blob => blob.ref.documentId === first.entries.find(entry => entry.kind === 'playthrough')!.ref.documentId)!
    const { readBlob } = await import('../workspace/blobs')
    expect(JSON.parse(new TextDecoder().decode(await readBlob(owner.content, owner.ref.byteLength))).metadata.label).toBe('Before')
    const ownerEntry = first.entries.find(entry => entry.kind === 'playthrough')!
    const capturedOwner = await opened.readCaptured(ownerEntry.ref)
    expect(await readBlob(capturedOwner.source, capturedOwner.source.byteLength)).toEqual(await readBlob(first.opened.payloads.get(ownerEntry.key)!, capturedOwner.source.byteLength))
    expect(JSON.parse(new TextDecoder().decode(await readBlob(owner.content, owner.ref.byteLength)))).toEqual(capturedOwner.document.value)
    if (indexed) {
      const definition = Object.values(opened.state.planner.localData.personalDefinitions)[0]
      const localData = observeInventory(opened.state.planner.localData, { ref: { kind: 'personal', definitionId: definition.id }, possession: 'owned', quantity: { kind: 'exact', value: 2 } })
      const changed = await prepareAccountWorkspace(database, token, { ...opened.state, planner: { ...opened.state.planner, localData } }, opened)
      await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: changed.head, records: changed.records })
      const current = await openAccountWorkspace(database, token, changed.head)
      const { validateCapturedWorkspaceRecords } = await import('../workspace/account-evidence')
      await validateCapturedWorkspaceRecords(current.readCaptured, [original.ref], new Map(current.allocations.map(entry => [entry.key, entry.documentId])), new Map())
      expect((await current.readCaptured(original.ref)).retainingIndex).toEqual(original.retainingIndex)
    }
    invalidateProfile()
    expect((await inspectWorkspaceClosure(portable, closure)).value).toEqual({ inventory: state.planner.localData.playthroughs[id].inventory, inventoryEvents: {} })
  } finally { invalidateProfile(); await database.delete() }
})

it('keeps actual inventory and rename saves disjoint while preserving current counters, history and pending evidence', async () => {
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { openAccountJson } = await import('../workspace/account-cache')
  const { MappedWorkspaceIntentSchema, readMappedWorkspaceChanges } = await import('../workspace/account-intents')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const repository = await openAccountRepository(token)
    const save = async (draft: LocalData, revision: number) => { const result = await repository.save(draft, revision); return { localData: result.localData, revision: result.localData.revision } }
    let loaded: { localData: LocalData; revision: number } = await repository.load()
    let draft = createPlaythrough(createPersonalDefinition(loaded.localData, { name: 'Independent item', kind: 'item' }), { label: 'Before' })
    loaded = await save(draft, loaded.revision)
    const id = Object.keys(loaded.localData.playthroughs)[0] as PlaythroughId
    const definition = Object.values(loaded.localData.personalDefinitions)[0]
    const base = await openManagedNativeWorkspace(database, token)
    const owner = base.entries.find(entry => entry.kind === 'playthrough')!
    draft = observeInventory(loaded.localData, { ref: { kind: 'personal', definitionId: definition.id }, possession: 'owned', quantity: { kind: 'exact', value: 2 } })
    loaded = await save(draft, loaded.revision)
    const inventory = await openManagedNativeWorkspace(database, token)
    expect(inventory.entries.find(entry => entry.kind === 'playthrough')!.ref).toEqual(owner.ref)
    expect(inventory.state.planner.localData.playthroughs[id]).toEqual(loaded.localData.playthroughs[id])
    const inventoryChanges = mappedChanges(base, inventory).filter(change => !['history', 'change', 'retained-content', 'blob', 'blob-reference'].includes(change.kind))
    expect(inventoryChanges.map(change => change.kind)).toEqual(['inventory'])
    const renamed = rename(loaded.localData, id, 'After')
    loaded = await save(renamed, loaded.revision)
    const after = await repository.readWorkspace()
    const opened = await openManagedNativeWorkspace(database, token)
    expect(after.planner.localData.playthroughs[id]).toEqual(loaded.localData.playthroughs[id])
    const renameChanges = mappedChanges(inventory, opened).filter(change => !['history', 'change', 'retained-content', 'blob', 'blob-reference'].includes(change.kind))
    expect(renameChanges.map(change => change.kind)).toEqual(['playthrough'])
    expect(inventoryChanges.some(change => renameChanges.some(other => other.key === change.key))).toBe(false)
    expect((await repository.readHistory()).at(-1)?.after).toEqual(loaded.localData)
    for (const row of await database.outbox.toArray()) {
      const intent = await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)
      const changes = await readMappedWorkspaceChanges(database, token, intent)
      expect(changes.length).toBeGreaterThan(0)
    }
    const captured = await opened.readCaptured(owner.ref)
    expect((captured.document.value as { metadata: { revision: number } }).metadata.revision).toBe(base.state.planner.localData.playthroughs[id].revision)
    const backup = await repository.previewImport(await repository.exportPlannerBackup(), 'captured.zip')
    expect(backup.errors).toEqual([])
    expect(backup.proposed.localData.playthroughs[id]).toEqual(loaded.localData.playthroughs[id])
    expect(backup.proposed.history).toEqual(after.planner.history)
    const reopened = await openAccountRepository(token)
    expect((await reopened.load()).localData).toEqual(loaded.localData)
    await reopened.undo(loaded.revision)
    expect((await reopened.load()).localData.playthroughs[id].label).toBe('Before')
  } finally { invalidateProfile(); await database.delete() }
})

it('opens an older graph without bookkeeping metadata and upgrades without rewriting its captured Playthrough frame', async () => {
  const { stageAccountJson, openAccountJson, cipherRef } = await import('../workspace/account-cache')
  const { AccountWorkspaceRootSchema } = await import('../workspace/account-graph')
  const { buildIndexPages } = await import('../workspace/directory')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const { id, state } = await fixture(false)
    const prepared = await prepareAccountWorkspace(database, token, state)
    let fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const records = [], entries = prepared.entries.map(({ semanticDigest: _digest, ...entry }) => entry)
    const index = await buildIndexPages(entries, async page => { const record = await stageAccountJson(database, token, page, [...page.children, ...page.entries.map(entry => entry.ref)]); records.push(record); return cipherRef(record) })
    const { playthroughBookkeeping: _bookkeeping, ...root } = await openAccountJson(database, token, prepared.head, AccountWorkspaceRootSchema)
    const legacy = await stageAccountJson(database, token, { ...root, index }, [index, root.allocations])
    records.push(legacy)
    fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: cipherRef(legacy), records })
    const opened = await openAccountWorkspace(database, token, cipherRef(legacy))
    expect(opened.state).toEqual(state)
    const playthrough = state.planner.localData.playthroughs[id]
    const updated: WorkspaceState = { ...state, planner: { ...state.planner, localData: { ...state.planner.localData, playthroughs: { [id]: { ...playthrough, revision: 9, updatedAt: '2026-01-09T00:00:00.000Z' as Timestamp } } } } }
    const next = await prepareAccountWorkspace(database, token, updated, opened)
    expect(next.entries.find(entry => entry.kind === 'playthrough')!.ref).toEqual(entries.find(entry => entry.kind === 'playthrough')!.ref)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: next.head, records: next.records })
    expect((await openAccountWorkspace(database, token, next.head)).state).toEqual(updated)
    expect((await openAccountWorkspace(database, token, cipherRef(legacy))).state).toEqual(state)
  } finally { invalidateProfile(); await database.delete() }
})

for (const malformed of ['missing', 'wrong-key', 'foreign-allocation'] as const) it(`rejects ${malformed} captured ownership after the current owner advances`, async () => {
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { workspaceDocumentSource } = await import('../workspace/document-codec')
  const { capturedRecordReader, validateCapturedWorkspaceRecords } = await import('../workspace/account-evidence')
  const { cipherRef } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const { id, state } = await fixture(false)
    const first = await prepareAccountWorkspace(database, token, state)
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: first.head, records: first.records })
    const initial = await openAccountWorkspace(database, token, first.head)
    const next = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: rename(state.planner.localData, id, 'Current') } }, initial)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: next.head, records: next.records })
    const child = first.entries.find(entry => entry.kind === 'inventory')!, owner = first.entries.find(entry => entry.kind === 'playthrough')!
    if (malformed === 'missing') {
      await database.encryptedRevisions.delete(owner.ref.revisionId)
      await expect(openAccountWorkspace(database, token, next.head)).rejects.toThrow()
      return
    }
    const captured = await initial.readCaptured(owner.ref)
    const foreignId = 'foreign-owner'
    const value = captured.document.value as unknown as { metadata: { id: string }; optional: object }
    const document = malformed === 'wrong-key' ? { ...captured.document, key: JSON.stringify(['playthrough', foreignId]), value: { ...value, metadata: { ...value.metadata, id: foreignId } } } : captured.document
    const wrong = await stageAccountSource(database, token, workspaceDocumentSource(document as typeof captured.document), [], undefined, malformed === 'wrong-key' ? owner.ref.documentId : accountLocalId())
    const dependent = await stageAccountSource(database, token, initial.payloads.get(child.key)!, [cipherRef(wrong)], undefined, child.ref.documentId)
    await database.encryptedRevisions.bulkPut([wrong, dependent])
    await expect(validateCapturedWorkspaceRecords(capturedRecordReader(database, token, new Map()), [cipherRef(dependent)], new Map(initial.allocations.map(entry => [entry.key, entry.documentId])), new Map())).rejects.toThrow()
  } finally { invalidateProfile(); await database.delete() }
})

for (const malformed of ['catalog-revision', 'catalog-checksum', 'body-digest'] as const) it(`keeps explicit captured pins exact: ${malformed}`, async () => {
  const { BUNDLED_CATALOGS } = await import('../catalog/bundled')
  const { memoryBlob, hashBlob, blobIdentity } = await import('../workspace/blobs')
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { workspaceDocumentSource } = await import('../workspace/document-codec')
  const { capturedRecordReader, validateCapturedWorkspaceRecords } = await import('../workspace/account-evidence')
  const { cipherRef } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const { state } = await fixture(false), checksum = `sha256:${'1'.repeat(64)}`
    const catalog = { ...BUNDLED_CATALOGS[0], id: 'crystal-edit:captured-pin' as typeof BUNDLED_CATALOGS[0]['id'], revisionId: `${checksum}:rules-v1:library-v1` as typeof BUNDLED_CATALOGS[0]['revisionId'], checksum, entities: {}, claims: [] }
    const content = memoryBlob(new Uint8Array([0, 255, 17])), ref = { documentId: 'exact-body', revisionId: 'exact-revision', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
    const complete: WorkspaceState = { ...state, planner: { ...state.planner, catalogs: [catalog] }, blobs: [{ ref, content }], saveDocuments: [{ version: 1, id: 'exact-save', revision: 0, filename: 'exact.sav', original: ref, working: ref, pendingForm: {}, requirements: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum, title: 'Exact required catalog' }], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: '2026-01-01', updatedAt: '2026-01-01', exportedRevision: null }] }
    const prepared = await prepareAccountWorkspace(database, token, complete)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const opened = await openAccountWorkspace(database, token, prepared.head)
    const owner = prepared.entries.find(entry => entry.kind === 'save')!
    const dependency = prepared.entries.find(entry => malformed === 'body-digest' ? entry.key === JSON.stringify(['blob', blobIdentity(ref)]) : entry.kind === 'catalog')!
    const captured = await opened.readCaptured(dependency.ref)
    const badDocument = malformed === 'body-digest' ? { ...captured.document, value: memoryBlob(new Uint8Array([1, 255, 17])) } : { ...captured.document, ...(malformed === 'catalog-revision' ? { key: JSON.stringify(['catalog', catalog.id, 'wrong-revision']) } : {}), value: { ...catalog, ...(malformed === 'catalog-revision' ? { revisionId: 'wrong-revision' } : { checksum: `sha256:${'2'.repeat(64)}` }) } }
    const forged = await stageAccountSource(database, token, workspaceDocumentSource(badDocument as typeof captured.document), [], undefined, dependency.ref.documentId)
    const originalOwner = await opened.readCaptured(owner.ref)
    const dependent = await stageAccountSource(database, token, originalOwner.source, originalOwner.dependencies.map(value => blobIdentity(value) === blobIdentity(dependency.ref) ? cipherRef(forged) : value), undefined, owner.ref.documentId)
    await database.encryptedRevisions.bulkPut([forged, dependent])
    await expect(validateCapturedWorkspaceRecords(capturedRecordReader(database, token, new Map()), [cipherRef(dependent)], new Map(opened.allocations.map(entry => [entry.key, entry.documentId])), new Map())).rejects.toThrow()
  } finally { invalidateProfile(); await database.delete() }
})
