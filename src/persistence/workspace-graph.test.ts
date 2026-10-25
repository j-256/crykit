import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { createBlankLocalData } from '../domain/local-data'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace, openAccountWorkspace } from '../workspace/account-graph'
import type { WorkspaceState } from '../workspace/documents'

it('stages separate encrypted records, reopens the complete graph and reuses unchanged identities', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData()
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const reopened = await openAccountWorkspace(database, token, prepared.head)
    expect(reopened.state).toEqual(state)
    const next = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: { ...localData, revision: 1 } } }, reopened)
    expect(next.entries.map(entry => entry.ref)).toEqual(prepared.entries.map(entry => entry.ref))
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: next.head, records: next.records })
    expect((await openAccountWorkspace(database, token, next.head)).state.planner.localData.revision).toBe(1)
    for (const table of database.tables) await table.each(row => {
      const payload = table.name === 'stagedCipherChunks' ? new TextDecoder().decode(row.bytes) : JSON.stringify(row)
      expect(payload).not.toContain(localData.id)
    })
  } finally { invalidateProfile(); await database.delete() }
})

it('maps real disjoint domain edits without a shared bookkeeping head', async () => {
  const { createPersonalDefinition } = await import('../domain/local-data')
  const { mappedChanges } = await import('../workspace/account-intents')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData()
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
    const initial = await prepareAccountWorkspace(database, token, state)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records })
    const first = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: createPersonalDefinition(localData, { name: 'First independent edit', kind: 'item', now: '2026-01-01T00:00:00.000Z' }) } }, initial.opened)
    const second = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: createPersonalDefinition(localData, { name: 'Second independent edit', kind: 'class', now: '2026-01-02T00:00:00.000Z' }) } }, initial.opened)
    const a = mappedChanges(initial.opened, first.opened), b = mappedChanges(initial.opened, second.opened)
    expect(a.some(value => value.kind === 'personal-definition')).toBe(true)
    expect(b.some(value => value.kind === 'personal-definition')).toBe(true)
    expect(a.filter(value => b.some(other => other.key === value.key))).toEqual([])
    expect(a.concat(b).some(value => value.kind === 'workspace-identity')).toBe(false)
    const deleted = await prepareAccountWorkspace(database, token, state, first.opened)
    const definition = first.entries.find(value => value.kind === 'personal-definition')!
    const tombstone = deleted.entries.find(value => value.key === definition.key)!
    expect(tombstone.kind).toBe('tombstone')
    expect(tombstone.ref.documentId).toBe(definition.ref.documentId)
    expect(deleted.records.find(record => record.revisionId === tombstone.ref.revisionId)?.descriptor.parents).toEqual([definition.ref.revisionId])
    const revived = await prepareAccountWorkspace(database, token, first.opened.state, deleted.opened)
    expect(revived.entries.find(value => value.key === definition.key)?.ref.documentId).toBe(definition.ref.documentId)
  } finally { invalidateProfile(); await database.delete() }
})

it('maps activates and reopens more exact per-record retaining edges than a descriptor can hold', async () => {
  const { BUNDLED_CATALOGS } = await import('../catalog/bundled')
  const { validateWorkspaceClosure, inspectWorkspaceClosure } = await import('../workspace/closure')
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData()
    // Width is the subject; copied native lookup tables add payload work unrelated to synthetic catalog edges
    const { legacy: _legacy, ...catalogTemplate } = BUNDLED_CATALOGS[0]!
    const catalogs = Array.from({ length: 257 }, (_, i) => ({ ...catalogTemplate, id: `crystal-edit:wide-${i}` as typeof BUNDLED_CATALOGS[0]['id'], revisionId: `sha256:${i.toString(16).padStart(64, '0')}:rules-v1:library-v1` as typeof BUNDLED_CATALOGS[0]['revisionId'], entities: {}, claims: [], checksum: `sha256:${i.toString(16).padStart(64, '0')}` }))
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: catalogs.map(c => ({ catalogId: c.id, catalogRevisionId: c.revisionId, enabled: true })) } }
    const { memoryBlob, hashBlob, readBlob } = await import('../workspace/blobs')
    const content = memoryBlob(new Uint8Array([0, 255, 17]))
    const body = { documentId: 'wide-save-original', revisionId: 'wide-save-original:1', encoding: 'bytes' as const, byteLength: content.byteLength, sha256: await hashBlob(content) }
    const complete: WorkspaceState = { ...state, blobs: [{ ref: body, content }], saveDocuments: [{ version: 1, id: 'wide-save', revision: 0, filename: 'wide.sav', original: body, working: body, pendingForm: { inert: 'typed' }, requirements: catalogs.map(c => ({ catalogId: c.id, catalogRevisionId: c.revisionId, checksum: c.checksum, title: c.id })), coverage: { status: 'unsupported', diagnostics: ['Exact required catalogs retained'] }, createdAt: '2026-01-01', updatedAt: '2026-01-01', exportedRevision: null }] }
    await validateWorkspaceClosure(complete)
    const prepared = await prepareAccountWorkspace(database, token, complete)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    for (const entry of prepared.entries.filter(entry => ['library-defaults', 'save'].includes(entry.kind))) {
      expect(entry.retainingIndex).toBeDefined()
      expect(prepared.records.find(record => record.revisionId === entry.ref.revisionId)?.descriptor.dependencies).toEqual([entry.retainingIndex])
    }
    const reopened = await openAccountWorkspace(database, token, prepared.head)
    expect(reopened.state.libraryDefaults).toEqual(state.libraryDefaults)
    expect(reopened.state.planner.catalogs).toEqual(catalogs)
    expect(reopened.state.saveDocuments).toEqual(complete.saveDocuments)
    const output = new Map<string, WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(reopened, '["library-defaults"]', output)
    const saveClosure = await archiveWorkspaceUnit(reopened, '["save","wide-save"]', output)
    const portable = { ...state, planner: { ...state.planner, catalogs: [] }, libraryDefaults: { version: 1 as const, layers: [] }, blobs: [...output.values()], retainedContent: [{ version: 1 as const, kind: 'pending-content' as const, id: 'wide', groupId: 'wide', unit: { kind: 'record' as const, privateKey: '["library-defaults"]' }, base: { kind: 'absent' as const }, target: closure }, { version: 1 as const, kind: 'pending-content' as const, id: 'wide-save', groupId: 'wide', unit: { kind: 'record' as const, privateKey: '["save","wide-save"]' }, base: { kind: 'absent' as const }, target: saveClosure }] }
    // Older portable archives may declare wide direct edges even though transport descriptors cannot
    const archiveEntries: import('../workspace/documents').WorkspaceConflictClosureEntry[] = []
    const readPage = async (ref: import('../workspace/documents').WorkspaceBlobRef): Promise<void> => {
      const blob = output.get(JSON.stringify([ref.documentId, ref.revisionId]))!
      const page = JSON.parse(new TextDecoder().decode(await readBlob(blob.content, ref.byteLength))) as { entries: typeof archiveEntries; children: import('../workspace/documents').WorkspaceBlobRef[] }
      archiveEntries.push(...page.entries)
      for (const child of page.children) await readPage(child)
    }
    await readPage(closure.index)
    const legacyEntries = archiveEntries.filter(entry => entry.kind !== 'unit-index').map(entry => {
      if (entry.key !== '["library-defaults"]') return entry
      const { retainingIndex: _index, ...direct } = entry
      return { ...direct, dependencies: archiveEntries.filter(value => value.kind === 'catalog').map(value => value.ref) }
    })
    const addPage = async (entries: typeof archiveEntries, children: typeof closure.index[]) => {
      const content = memoryBlob(new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'conflict-closure-page', entries, children })))
      const ref = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf8' as const }
      portable.blobs.push({ ref, content }); return ref
    }
    const legacyChildren = []
    for (let at = 0; at < legacyEntries.length; at += 64) legacyChildren.push(await addPage(legacyEntries.slice(at, at + 64), []))
    const legacyClosure = { ...closure, index: await addPage([], legacyChildren) }
    portable.retainedContent[0].target = legacyClosure
    // Simulate an archive transfer while source authority is valid, then remove its account key
    portable.blobs = await Promise.all(portable.blobs.map(async blob => ({ ref: blob.ref, content: memoryBlob(await readBlob(blob.content, blob.ref.byteLength)) })))
    invalidateProfile()
    await validateWorkspaceClosure(portable)
    expect((await inspectWorkspaceClosure(portable, closure)).value).toEqual(state.libraryDefaults)
    expect((await inspectWorkspaceClosure(portable, saveClosure)).value).toEqual(complete.saveDocuments[0])
    expect(prepared.records.every(record => record.descriptor.dependencies.length <= 256)).toBe(true)
    const destinationToken = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
    const destination = new AccountDatabase(destinationToken.accountId)
    try {
      const retained = await prepareAccountWorkspace(destination, destinationToken, portable)
      await activateLocalAccountCommit(destination, destinationToken, { version: 1, id: accountLocalId(), expected: undefined, head: retained.head, records: retained.records })
      const copied = (await openAccountWorkspace(destination, destinationToken, retained.head)).state
      expect((await inspectWorkspaceClosure(copied, saveClosure)).value).toEqual(complete.saveDocuments[0])
      expect((await inspectWorkspaceClosure(copied, legacyClosure)).value).toEqual(state.libraryDefaults)
      expect(retained.records.every(record => record.descriptor.dependencies.length <= 256)).toBe(true)
    } finally { invalidateProfile(); await destination.delete() }
  } finally { invalidateProfile(); await database.delete() }
})

it('authenticates a prepared v2 workspace subtree without installing descriptors or selecting it', async () => {
  const graph = await import('../workspace/account-graph')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  expect(typeof graph.stageAccountWorkspaceGraph).toBe('function')
  expect(typeof graph.authenticateAccountWorkspaceSubtree).toBe('function')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  try {
    const inherited = await createAccountInheritedEvidencePreparation(database, token).prepare({})
    await inherited.handle.dispose()
    await owner.adopt(inherited.owner)
    const localData = createBlankLocalData()
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
    const staged = await graph.stageAccountWorkspaceGraph(database, token, state, { owner, rootFormat: { version: 2, inheritedEvidence: inherited.root } })
    expect('opened' in staged).toBe(false)
    const opened = await graph.authenticateAccountWorkspaceSubtree(database, token, staged.head, { owner, version: 2 })
    expect(opened.workspace.state).toEqual(state)
    expect(opened.root.version).toBe(2)
    expect(graph.AccountWorkspaceRootSchema.safeParse(opened.root).success).toBe(false)
    expect(graph.AccountWorkspaceRootV2Schema.safeParse({ ...opened.root, inheritedEvidence: undefined }).success).toBe(false)
    expect(await database.encryptedRevisions.count()).toBe(0)
    expect(await database.profileMeta.count()).toBe(0)
    await expect(openAccountWorkspace(database, token, staged.head)).rejects.toThrow()
    await opened.dispose()
    await expect(opened.workspace.readCaptured(staged.entries[0].ref)).rejects.toThrow(/released/)
  } finally { await owner.abandon(); invalidateProfile(); await database.delete() }
})

async function subtreeFixture(installed = false, sourceState?: WorkspaceState) {
  const graph = await import('../workspace/account-graph')
  const cache = await import('../workspace/account-cache')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const key = crypto.getRandomValues(new Uint8Array(32)), token = installProfile(accountLocalId(), key.slice())
  const database = new AccountDatabase(token.accountId), owner = createAccountPreparationOwner(database, token)
  const inherited = await createAccountInheritedEvidencePreparation(database, token).prepare({})
  await inherited.handle.dispose(); await owner.adopt(inherited.owner)
  const localData = createBlankLocalData()
  const state: WorkspaceState = sourceState ?? { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
  const staged = await graph.stageAccountWorkspaceGraph(database, token, state, { owner, rootFormat: { version: 2, inheritedEvidence: inherited.root } })
  const root = await cache.openAccountJson(database, token, staged.head, graph.AccountWorkspaceRootV2Schema, owner)
  const readOwner = installed ? undefined : owner
  if (installed) await database.encryptedRevisions.bulkAdd([...inherited.records, ...staged.records])
  async function write(value: unknown, dependencies: readonly import('./account-database').CipherRef[]) {
    const record = await cache.stageAccountJson(database, token, value, dependencies, undefined, owner)
    if (installed) await database.encryptedRevisions.add(record)
    return cache.cipherRef(record)
  }
  const rootEdges = (value: typeof root) => [value.index, value.allocations, value.playthroughBookkeeping!.index, ...(value.plannerJournal ? [value.plannerJournal.index] : []), value.inheritedEvidence]
  return { graph, cache, database, token, key, owner, state, staged, root, readOwner, write, rootEdges, async dispose() { vi.restoreAllMocks(); await owner.abandon(); invalidateProfile(); await database.delete() } }
}

it.each([false, true])('checks genuinely encrypted root and page edges with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const { z } = await import('zod')
    const page = await f.cache.openAccountJson(f.database, f.token, f.root.index, z.any(), f.readOwner)
    const badIndex = await f.write(page, [])
    const root = { ...f.root, index: badIndex }
    const head = await f.write(root, f.rootEdges(root))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/dependencies/)
    const wrongRoot = await f.write(f.root, f.rootEdges(f.root).slice(1))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, wrongRoot, { version: 2, owner: f.readOwner })).rejects.toThrow(/dependencies/)
  } finally { await f.dispose() }
})

it.each([false, true])('applies cumulative declared/read/visit budgets before returning a subtree with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    for (const limits of [{ records: 1 }, { declaredBytes: 1 }, { readBytes: 1 }]) {
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner, limits })).rejects.toThrow(/resource limit/)
    }
  } finally { await f.dispose() }
})

it('pins consumed source-context absence through return and lazy reads', async () => {
  const f = await subtreeFixture()
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })
    expect(opened.observations()).toEqual([{ id: `source-context:${f.staged.head.revisionId}`, row: undefined }])
    await f.database.syncState.add({ id: `source-context:${f.staged.head.revisionId}`, ref: f.staged.head })
    await expect(opened.recheck()).rejects.toThrow(/association/)
    await expect(opened.workspace.readCaptured(f.staged.entries[0].ref)).rejects.toThrow(/association/)
    await expect((await import('../workspace/blobs')).hashBlob(opened.workspace.payloads.get(f.staged.entries[0].key)!)).rejects.toThrow(/association/)
    await opened.dispose()
  } finally { await f.dispose() }
})

it.each([false, true])('rejects authentically unprotected descendant pages with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const { z } = await import('zod')
    const { encryptRevision } = await import('../account/crypto/revisions')
    const { withAccountKey } = await import('../account/profile')
    const { runAccountStage } = await import('../workspace/account-prepared-records')
    const page = await f.cache.openAccountJson(f.database, f.token, f.root.allocations, z.any(), f.readOwner)
    const bytes = new TextEncoder().encode(JSON.stringify(page)), payloadId = accountLocalId()
    const bad = await runAccountStage(f.database, f.token, payloadId, f.owner, async lease => {
      const encrypted = await withAccountKey(f.token, key => encryptRevision(key, { format: 1, accountId: f.token.accountId, documentId: accountLocalId(), revisionId: accountLocalId(), parents: [], dependencies: [], protected: false, plainBytes: bytes.length }, accountLocalId(), (async function* () { yield bytes })(), { id: payloadId, write: (index, value) => lease.write(index, value) }))
      return { revisionId: encrypted.descriptor.revisionId, payloadId, descriptor: encrypted.descriptor }
    })
    if (installed) await f.database.encryptedRevisions.add(bad)
    const root = { ...f.root, allocations: f.cache.cipherRef(bad) }, head = await f.write(root, f.rootEdges(root))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/protected/)
  } finally { await f.dispose() }
})

it.each([false, true])('bounds deep and wide page trees cumulatively before scheduling children with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const { z } = await import('zod')
    const leaf = await f.cache.openAccountJson(f.database, f.token, f.root.allocations, z.any(), f.readOwner)
    const nested = await f.write({ version: 1, entries: [], children: [f.root.allocations] }, [f.root.allocations])
    const top = await f.write({ version: 1, entries: [], children: [nested] }, [nested])
    const deepRoot = { ...f.root, allocations: top }, deep = await f.write(deepRoot, f.rootEdges(deepRoot))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, deep, { version: 2, owner: f.readOwner, limits: { depth: 1 } })).rejects.toThrow(/resource limit/)
    const children = await Promise.all(Array.from({ length: 10 }, () => f.write({ ...leaf, entries: [] }, [])))
    const wideIndex = await f.write({ version: 1, entries: [], children }, children)
    const wideRoot = { ...f.root, allocations: wideIndex }, wide = await f.write(wideRoot, f.rootEdges(wideRoot))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, wide, { version: 2, owner: f.readOwner, limits: { records: 10 } })).rejects.toThrow(/resource limit/)
    const legacy = { ...deepRoot, version: 1, inheritedEvidence: undefined }
    const selectedHead = await f.write(legacy, [])
    if (!installed) await f.database.encryptedRevisions.bulkAdd([...f.staged.records, ...[nested, top, selectedHead].map(ref => f.owner.prepared(ref)!)])
    expect((await openAccountWorkspace(f.database, f.token, selectedHead)).state).toEqual(f.state)
  } finally { await f.dispose() }
})

it('pins same-ref replacement before initial decryption and each lazy frame read', async () => {
  const f = await subtreeFixture(true)
  try {
    const streams = await import('../workspace/account-streams')
    const original = streams.openAccountSource
    let changed = false
    const target = f.staged.entries[0].ref
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      if (!changed && args[2].revisionId === target.revisionId) {
        changed = true
        const record = await f.database.encryptedRevisions.get(target.revisionId)
        await f.database.encryptedRevisions.put({ ...record!, payloadId: accountLocalId() })
      }
      return original(...args)
    })
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2 })).rejects.toThrow(/descriptor changed/)
    expect(changed).toBe(true)
    vi.restoreAllMocks()
    await f.database.encryptedRevisions.put(f.staged.records.find(record => record.revisionId === target.revisionId)!)
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2 })
    await f.database.encryptedRevisions.put({ ...f.staged.records.find(record => record.revisionId === target.revisionId)!, payloadId: accountLocalId() })
    await expect((await import('../workspace/blobs')).hashBlob(opened.workspace.payloads.get(f.staged.entries[0].key)!)).rejects.toThrow(/descriptor changed/)
    await opened.dispose()
  } finally { await f.dispose() }
})

it('records only the effective context key when an unmarked v1 source follows a view', async () => {
  const f = await subtreeFixture(true)
  try {
    const marked = { ...f.root, version: 1, inheritedEvidence: undefined }
    const effective = await f.write(marked, [])
    const original = await f.write({ ...marked, sourceEvidenceVersion: undefined }, [])
    const wrapper = await f.write({ version: 1, kind: 'local-source-view', source: original, view: effective }, [original, effective])
    await f.database.syncState.add({ id: `source-view:${original.revisionId}`, ref: wrapper })
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, original, { version: 1 })
    expect(opened.originalRoot).toEqual(original)
    expect(opened.effectiveRoot).toEqual(effective)
    expect(opened.workspace.head).toEqual(original)
    expect(opened.observations()).toEqual([{ id: `source-view:${original.revisionId}`, row: { id: `source-view:${original.revisionId}`, ref: wrapper } }, { id: `source-context:${effective.revisionId}`, row: undefined }])
    await f.database.syncState.add({ id: `source-context:${original.revisionId}`, ref: original })
    await opened.recheck()
    await f.database.syncState.add({ id: `source-context:${effective.revisionId}`, ref: original })
    await expect(opened.recheck()).rejects.toThrow(/association/)
    await opened.dispose()
  } finally { await f.dispose() }
})

it('rejects source-row appearance during final authenticated wrapper recheck', async () => {
  const f = await subtreeFixture(true)
  try {
    const streams = await import('../workspace/account-streams'), original = streams.openAccountSource
    let rootReads = 0
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await original(...args)
      if (args[2].revisionId === f.staged.head.revisionId && ++rootReads === 2) {
        await f.database.syncState.add({ id: `source-context:${f.staged.head.revisionId}`, ref: f.staged.head })
      }
      return source
    })
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2 })).rejects.toThrow(/association/)
  } finally { await f.dispose() }
})

it('authenticates retained checkpoint predecessor frames that are absent from the current state', async () => {
  const { createPersonalDefinition } = await import('../domain/local-data')
  const { historyEntry } = await import('./local-data')
  const f = await subtreeFixture()
  try {
    const previousState = { ...f.state, planner: { ...f.state.planner, localData: createPersonalDefinition(f.state.planner.localData, { name: 'Private removed predecessor', kind: 'item', now: '2026-01-01T00:00:00.000Z' }) } }
    const previous = await f.graph.stageAccountWorkspaceGraph(f.database, f.token, previousState, { owner: f.owner, rootFormat: { version: 2, inheritedEvidence: f.root.inheritedEvidence } })
    const before = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, previous.head, { version: 2, owner: f.owner })
    const checkpoint = historyEntry(previousState.planner.localData, f.state.planner.localData, 'synthetic', f.state.planner.localData.updatedAt)
    const state = { ...f.state, planner: { ...f.state.planner, journal: { version: 1 as const, changes: [], checkpoints: [checkpoint], undoable: false } } }
    const next = await f.graph.stageAccountWorkspaceGraph(f.database, f.token, state, { owner: f.owner, semanticBase: before.workspace, rootFormat: { version: 2, inheritedEvidence: f.root.inheritedEvidence } })
    await before.dispose()
    const target = previous.entries.find(entry => entry.kind === 'personal-definition')!
    const record = f.owner.prepared(target.ref)!
    const chunk = await f.database.stagedCipherChunks.get([record.payloadId, 0])
    const bytes = chunk!.bytes.slice(); bytes[0] ^= 1
    await f.database.stagedCipherChunks.put({ ...chunk!, bytes })
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, next.head, { version: 2, owner: f.owner })).rejects.toThrow()
  } finally { await f.dispose() }
})

it.each([false, true])('validates journal checkpoint edges with and without a predecessor with installed=%s', async installed => {
  const { historyEntry } = await import('./local-data')
  const { z } = await import('zod')
  const f = await subtreeFixture(installed)
  try {
    const after = { ...f.state.planner.localData, revision: 1 }
    const checkpoint = historyEntry(f.state.planner.localData, after, 'synthetic checkpoint', after.updatedAt)
    const state = { ...f.state, planner: { ...f.state.planner, localData: after, journal: { version: 1 as const, changes: after.changes, checkpoints: [checkpoint], undoable: true } } }
    const base = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner })
    for (const semanticBase of [undefined, base.workspace]) {
      const staged = await f.graph.stageAccountWorkspaceGraph(f.database, f.token, state, { owner: f.owner, semanticBase, rootFormat: { version: 2, inheritedEvidence: f.root.inheritedEvidence } })
      if (installed) await f.database.encryptedRevisions.bulkAdd([...staged.records])
      const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, staged.head, { version: 2, owner: f.readOwner })
      expect(opened.workspace.state.planner.journal).toEqual(state.planner.journal)
      await opened.dispose()
      const root = await f.cache.openAccountJson(f.database, f.token, staged.head, f.graph.AccountWorkspaceRootV2Schema, f.readOwner)
      const page = await f.cache.openAccountJson(f.database, f.token, root.plannerJournal!.index, z.any(), f.readOwner)
      const value = await f.cache.openAccountJson(f.database, f.token, page.entries[0].ref, z.any(), f.readOwner)
      const bad = await f.write(value, [])
      const badPage = await f.write({ ...page, entries: [{ kind: 'checkpoint', ref: bad }] }, [bad])
      const changed = { ...root, plannerJournal: { ...root.plannerJournal!, index: badPage } }
      const record = await f.cache.stageAccountJson(f.database, f.token, changed, f.rootEdges(changed), semanticBase?.head, f.owner)
      if (installed) await f.database.encryptedRevisions.add(record)
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.cache.cipherRef(record), { version: 2, owner: f.readOwner })).rejects.toThrow(/checkpoint dependencies/)
    }
    await base.dispose()
  } finally { await f.dispose() }
})

it.each([false, true])('authenticates stable source context wrappers and rejects replacement or removal with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const index = await f.write({ version: 1, entries: [], children: [] }, [])
    const wrapper = await f.write({ version: 1, kind: 'local-source-context', source: f.staged.head, index }, [f.staged.head, index])
    const row = { id: `source-context:${f.staged.head.revisionId}`, ref: wrapper }
    await f.database.syncState.add(row)
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner })
    expect(opened.observations()).toEqual([{ id: row.id, row }])
    await opened.recheck()
    await f.database.syncState.delete(row.id)
    await expect(opened.workspace.readCaptured(f.staged.entries[0].ref)).rejects.toThrow(/association/)
    await f.database.syncState.put({ ...row, ref: index })
    await expect(opened.recheck()).rejects.toThrow(/association/)
    await f.database.syncState.put(row)
    const record = f.owner.prepared(wrapper)!, chunk = await f.database.stagedCipherChunks.get([record.payloadId, 0])
    const bytes = chunk!.bytes.slice(); bytes[0] ^= 1
    await f.database.stagedCipherChunks.put({ ...chunk!, bytes })
    await expect(opened.workspace.readCaptured(f.staged.entries[0].ref)).rejects.toThrow()
    await opened.dispose()
  } finally { await f.dispose() }
})

it.each([false, true])('checks typed child dependencies for allocation and bookkeeping pages with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    for (const kind of ['allocation', 'bookkeeping'] as const) {
      const child = kind === 'allocation' ? f.root.allocations : f.root.playthroughBookkeeping!.index
      const page = { version: 1, ...(kind === 'bookkeeping' ? { kind: 'local-playthrough-bookkeeping' } : {}), entries: [], children: [child] }
      const index = await f.write(page, [])
      const root = kind === 'allocation' ? { ...f.root, allocations: index } : { ...f.root, playthroughBookkeeping: { version: 1 as const, index } }
      const head = await f.write(root, f.rootEdges(root))
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/page dependencies/)
    }
  } finally { await f.dispose() }
})

it.each([false, true])('charges aggregate descriptors once and every physical reread with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const declaredBytes = f.staged.records.reduce((sum, record) => sum + record.descriptor.plainBytes, 0)
    const complete = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner, limits: { declaredBytes, records: f.staged.records.length } })
    await complete.dispose()
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner, limits: { declaredBytes: declaredBytes - 1 } })).rejects.toThrow(/resource limit/)
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner, limits: { readBytes: declaredBytes } })).rejects.toThrow(/resource limit/)
  } finally { await f.dispose() }
})

it.each([false, true])('reads native frame bodies through the owner and authenticates finality with installed=%s', async installed => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { readBlob } = await import('../workspace/blobs')
  const original = await editorClosureFixture(), f = await subtreeFixture(installed, original.state)
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner })
    expect(opened.workspace.state.retainedContent).toEqual(original.state.retainedContent)
    for (const body of opened.workspace.state.blobs) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(original.state.blobs.find(value => value.ref.documentId === body.ref.documentId)!.content, body.ref.byteLength))
    const entry = f.staged.entries.find(value => value.kind === 'blob')!, record = f.owner.prepared(entry.ref)!
    const chunk = await f.database.stagedCipherChunks.get([record.payloadId, 0])
    await f.database.stagedCipherChunks.put({ ...chunk!, bytes: chunk!.bytes.slice(1) })
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner })).rejects.toThrow()
    await expect(readBlob(opened.workspace.payloads.get(entry.key)!, record.descriptor.plainBytes)).rejects.toThrow()
    await opened.dispose()
  } finally { await f.dispose() }
})

it('rejects cancellation, stale profile and conflicting prepared/installed records without deleting borrowed rows', async () => {
  const f = await subtreeFixture()
  try {
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancelled subtree'))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner, signal: controller.signal })).rejects.toThrow(/cancelled/)
    const record = f.owner.prepared(f.staged.head)!
    await f.database.encryptedRevisions.add({ ...record, payloadId: accountLocalId() })
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })).rejects.toThrow(/conflicts/)
    expect(await f.database.encryptedRevisions.count()).toBe(1)
    expect(await f.database.profileMeta.count()).toBe(0)
    await f.database.encryptedRevisions.clear()
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })
    invalidateProfile()
    await expect(opened.recheck()).rejects.toThrow()
    await opened.dispose()
  } finally { await f.dispose() }
})

async function syntheticRecord(f: Awaited<ReturnType<typeof subtreeFixture>>, bytes: Uint8Array, dependencies: readonly import('./account-database').CipherRef[], ref = { documentId: accountLocalId(), revisionId: accountLocalId() }, protectedRecord = true) {
  const { encryptRevision } = await import('../account/crypto/revisions')
  const { withAccountKey } = await import('../account/profile')
  const { runAccountStage } = await import('../workspace/account-prepared-records')
  const payloadId = accountLocalId()
  const record = await runAccountStage(f.database, f.token, payloadId, f.owner, async lease => {
    const encrypted = await withAccountKey(f.token, key => encryptRevision(key, { format: 1, accountId: f.token.accountId, ...ref, parents: [], dependencies, protected: protectedRecord, plainBytes: bytes.length }, accountLocalId(), (async function* () { yield bytes })(), { id: payloadId, write: (index, value) => lease.write(index, value) }))
    return { revisionId: encrypted.descriptor.revisionId, payloadId, descriptor: encrypted.descriptor }
  })
  if (!f.readOwner) await f.database.encryptedRevisions.add(record)
  return f.cache.cipherRef(record)
}

it.each([false, true])('rejects authentically unprotected semantic frames with installed=%s', async installed => {
  const { z } = await import('zod')
  const { readBlob } = await import('../workspace/blobs')
  const { openAccountSource } = await import('../workspace/account-streams')
  const f = await subtreeFixture(installed)
  try {
    const entry = f.staged.entries[0], record = f.owner.prepared(entry.ref)!
    const bytes = await readBlob(await openAccountSource(f.database, f.token, entry.ref, f.readOwner), record.descriptor.plainBytes)
    const changed = await syntheticRecord(f, bytes, record.descriptor.dependencies, { documentId: entry.ref.documentId, revisionId: accountLocalId() }, false)
    const page = await f.cache.openAccountJson(f.database, f.token, f.root.index, z.object({ version: z.literal(1), entries: z.array(z.any()), children: z.array(f.cache.CipherRefSchema) }), f.readOwner)
    const entries = page.entries.map(value => value.ref.revisionId === entry.ref.revisionId ? { ...value, ref: changed } : value)
    const index = await f.write({ ...page, entries }, entries.map(value => value.ref))
    const root = { ...f.root, index }, head = await f.write(root, f.rootEdges(root))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/protected/)
  } finally { await f.dispose() }
})

it.each([false, true])('rejects encrypted page cycles and repeated children with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const self = { documentId: accountLocalId(), revisionId: accountLocalId() }
    await syntheticRecord(f, new TextEncoder().encode(JSON.stringify({ version: 1, entries: [], children: [self] })), [self], self)
    const repeated = await f.write({ version: 1, entries: [], children: [f.root.allocations, f.root.allocations] }, [f.root.allocations])
    for (const allocations of [self, repeated]) {
      const root = { ...f.root, allocations }, head = await f.write(root, f.rootEdges(root))
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/Cyclic|Repeated/)
    }
  } finally { await f.dispose() }
})

it('pins present source-context index ciphertext before lazy reads', async () => {
  const f = await subtreeFixture(true)
  try {
    const index = await f.write({ version: 1, entries: [], children: [] }, [])
    const wrapper = await f.write({ version: 1, kind: 'local-source-context', source: f.staged.head, index }, [f.staged.head, index])
    await f.database.syncState.add({ id: `source-context:${f.staged.head.revisionId}`, ref: wrapper })
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2 })
    const record = f.owner.prepared(index)!, chunk = await f.database.stagedCipherChunks.get([record.payloadId, 0])
    const bytes = chunk!.bytes.slice(); bytes[0] ^= 1
    await f.database.stagedCipherChunks.put({ ...chunk!, bytes })
    await expect(opened.workspace.readCaptured(f.staged.entries[0].ref)).rejects.toThrow()
    await opened.dispose()
  } finally { await f.dispose() }
})

it('bounds domain depth even when child records were already validated as index entries', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const f = await subtreeFixture(false, (await editorClosureFixture()).state)
  try {
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner, limits: { depth: 1 } })).rejects.toThrow(/resource limit/)
  } finally { await f.dispose() }
})

it.each([false, true])('rejects unknown local selectors only for v2 with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    const cases: typeof f.root.selections[] = [{ scenarios: {}, selectedPlaythroughId: 'missing-playthrough' }, { scenarios: {}, planningGameSetupRevisionId: 'missing-setup' }, { scenarios: { missing: 'missing-scenario' } }]
    for (const selections of cases) {
      const root = { ...f.root, selections }, head = await f.write(root, f.rootEdges(root))
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow(/selection/)
      const legacy = await f.write({ ...root, version: 1, inheritedEvidence: undefined }, [])
      if (!installed) await f.database.encryptedRevisions.bulkPut([...f.staged.records, f.owner.prepared(legacy)!])
      expect((await openAccountWorkspace(f.database, f.token, legacy)).state.planner.localData.selectedPlaythroughId).toBeUndefined()
    }
  } finally { await f.dispose() }
})

it('independently opens installed workspace ciphertext after the prepared owner and original profile are disposed', async () => {
  const f = await subtreeFixture(true)
  let fresh: AccountDatabase | undefined
  try {
    await f.owner.abandon()
    f.database.close(); invalidateProfile()
    const token = installProfile(f.token.accountId, f.key.slice())
    fresh = new AccountDatabase(token.accountId)
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(fresh, token, f.staged.head, { version: 2 })
    expect(opened.workspace.state).toEqual(f.state)
    expect(await fresh.profileMeta.count()).toBe(0)
    const rows = await fresh.encryptedRevisions.toArray()
    await opened.dispose()
    expect(await fresh.encryptedRevisions.toArray()).toEqual(rows)
  } finally { fresh?.close(); await f.dispose() }
})

it('disposes only this subtree reader and clears live bytes while keeping its allocation owner usable', async () => {
  const f = await subtreeFixture()
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })
    const iterator = opened.workspace.payloads.get(f.staged.entries[0].key)!.open()[Symbol.asyncIterator]()
    const bytes = (await iterator.next()).value as Uint8Array
    expect(bytes.some(value => value !== 0)).toBe(true)
    await opened.dispose()
    expect(bytes.every(value => value === 0)).toBe(true)
    await expect(iterator.next()).rejects.toThrow(/released/)
    f.owner.check()
    expect(f.owner.prepared(f.staged.head)).toBeDefined()
    expect(await f.database.stagedCipherChunks.count()).toBeGreaterThan(0)
  } finally { await f.dispose() }
})

it.each([false, true])('keeps version and unknown-field admission strict in encrypted roots with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    for (const root of [{ ...f.root, inheritedEvidence: undefined }, { ...f.root, inheritedEvidence: null }, { ...f.root, version: 3 }, { ...f.root, extra: true }]) {
      const head = await f.write(root, f.rootEdges(f.root))
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow()
    }
    const foreignVersion = await f.write({ ...f.root, version: 1 }, f.rootEdges(f.root))
    if (!installed) await f.database.encryptedRevisions.add(f.owner.prepared(foreignVersion)!)
    await expect(openAccountWorkspace(f.database, f.token, foreignVersion)).rejects.toThrow()
  } finally { await f.dispose() }
})

it.each([false, true])('authenticates retaining page edges and depth through prepared semantic frames with installed=%s', async installed => {
  const { z } = await import('zod')
  const { readBlob } = await import('../workspace/blobs')
  const { openAccountSource } = await import('../workspace/account-streams')
  const f = await subtreeFixture(installed)
  try {
    const entry = f.staged.entries[0], record = f.owner.prepared(entry.ref)!
    const bytes = await readBlob(await openAccountSource(f.database, f.token, entry.ref, f.readOwner), record.descriptor.plainBytes)
    const envelope = { version: 1, kind: 'local-retaining-edges', privateKey: entry.key, entries: [], children: [] }
    const valid = await f.write(envelope, [])
    const wrong = await f.write(envelope, [f.root.allocations])
    const child = await f.write({ ...envelope, children: [valid] }, [valid])
    const deep = await f.write({ ...envelope, children: [child] }, [child])
    const page = await f.cache.openAccountJson(f.database, f.token, f.root.index, z.any(), f.readOwner)
    for (const [retainingIndex, failure] of [[valid, undefined], [wrong, /Retaining page descriptor/], [deep, /resource limit/]] as const) {
      const changed = await syntheticRecord(f, bytes, [retainingIndex], { documentId: entry.ref.documentId, revisionId: accountLocalId() })
      const entries = page.entries.map((value: typeof entry) => value.ref.revisionId === entry.ref.revisionId ? { ...value, ref: changed, retainingIndex } : value)
      const index = await f.write({ ...page, entries }, entries.map((value: typeof entry) => value.ref))
      const root = { ...f.root, index }, head = await f.write(root, f.rootEdges(root))
      const result = f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner, limits: { depth: 1 } })
      if (failure) await expect(result).rejects.toThrow(failure)
      else { const opened = await result; expect(opened.workspace.state).toEqual(f.state); await opened.dispose() }
    }
  } finally { await f.dispose() }
})

it.each([false, true])('uses the same depth budget for index, bookkeeping and journal page trees with installed=%s', async installed => {
  const f = await subtreeFixture(installed)
  try {
    for (const kind of ['index', 'bookkeeping', 'journal'] as const) {
      const envelope = { version: 1, ...(kind === 'bookkeeping' ? { kind: 'local-playthrough-bookkeeping' } : {}), entries: [] }
      const leaf = kind === 'index' ? f.root.index : kind === 'bookkeeping' ? f.root.playthroughBookkeeping!.index : await f.write({ ...envelope, children: [] }, [])
      const child = await f.write({ ...envelope, children: [leaf] }, [leaf])
      const top = await f.write({ ...envelope, children: [child] }, [child])
      const root = { ...f.root, ...(kind === 'index' ? { index: top } : kind === 'bookkeeping' ? { playthroughBookkeeping: { version: 1 as const, index: top } } : { plannerJournal: { version: 1 as const, index: top, undoable: false } }) }
      const head = await f.write(root, f.rootEdges(root))
      await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner, limits: { depth: 1 } })).rejects.toThrow(/resource limit/)
    }
  } finally { await f.dispose() }
})

it.each([false, true])('authenticates recorded-party source bookkeeping and rejects a foreign captured owner with installed=%s', async installed => {
  const { createTestLocalData, addTestTeam, addTestBuild, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { createScenario } = await import('../domain')
  const { z } = await import('zod')
  const { sourceBookkeepingRefs } = await import('../workspace/source-bookkeeping')
  const team = addTestTeam(createTestLocalData()), built = addTestBuild(team.localData, 'synthetic-baseline-build', team.memberIds[0], {})
  const localData = createScenario(built, { label: 'Synthetic recorded party', memberIds: team.memberIds, baseline: { kind: 'recordedParty', playthroughRevision: built.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: { [team.memberIds[0]]: Object.values(built.buildRevisions)[0].id } }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const f = await subtreeFixture(installed, state)
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.readOwner })
    expect(opened.workspace.state.planner.localData).toEqual(localData)
    await opened.dispose()
    const page = await f.cache.openAccountJson(f.database, f.token, f.root.index, z.any(), f.readOwner)
    const foreign = f.staged.entries.find(entry => entry.kind === 'workspace-preferences')!.ref
    const entries = page.entries.map((entry: typeof f.staged.entries[number]) => entry.sourceBookkeeping ? { ...entry, sourceBookkeeping: { ...entry.sourceBookkeeping, owner: foreign } } : entry)
    const refs = entries.flatMap((entry: typeof f.staged.entries[number]) => [entry.ref, ...(entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping) : [])])
    const index = await f.write({ ...page, entries }, [...new Map(refs.map((ref: import('./account-database').CipherRef) => [JSON.stringify(ref), ref])).values()] as import('./account-database').CipherRef[])
    const root = { ...f.root, index }, head = await f.write(root, f.rootEdges(root))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner })).rejects.toThrow()
  } finally { await f.dispose() }
})

it('returns defensive record observations that cannot authorize a copied subtree under another owner', async () => {
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const f = await subtreeFixture()
  const unrelated = createAccountPreparationOwner(f.database, f.token)
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })
    expect(typeof opened.recordObservations).toBe('function')
    const records = opened.recordObservations()
    expect(records).toContainEqual(f.owner.prepared(f.staged.head))
    const mutable = records[0] as { payloadId: string }
    mutable.payloadId = accountLocalId()
    expect(opened.recordObservations()).not.toEqual(records)
    await opened.recheck()
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { ...opened, version: 2, owner: unrelated })).rejects.toThrow(/missing/)
    await opened.dispose()
  } finally { await unrelated.abandon(); await f.dispose() }
})

it('waits for an in-flight wrapper recheck before disposal permits owner transfer', async () => {
  const f = await subtreeFixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const observed = new Promise<void>(resolve => { entered = resolve })
  let checking: Promise<void> | undefined, disposing: Promise<void> | undefined
  try {
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, owner: f.owner })
    const get = f.database.stagedCipherChunks.get.bind(f.database.stagedCipherChunks)
    const { default: Dexie } = await import('dexie')
    vi.spyOn(f.database.stagedCipherChunks, 'get').mockImplementationOnce((...args: Parameters<typeof get>) => { entered(); return Dexie.Promise.resolve(gate).then(() => get(...args)) })
    checking = opened.recheck()
    void checking.catch(() => {})
    await observed
    let settled = false
    disposing = opened.dispose().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await disposing
    await expect(checking).rejects.toMatchObject({ code: 'LOCAL_INTEGRITY_FAILED', message: 'Encrypted source read failed.' })
    await expect(opened.recheck()).rejects.toThrow('Workspace subtree reader was released')
    f.owner.check()
  } finally { release(); await Promise.allSettled([checking, disposing]); await f.dispose() }
})

it('preserves authentication and reader cleanup failures together', async () => {
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const f = await subtreeFixture()
  try {
    const head = await f.write(f.root, [])
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'dispose').mockRejectedValueOnce(new Error('synthetic reader cleanup failure'))
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.owner })).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'Workspace root dependencies differ' }), expect.objectContaining({ message: 'synthetic reader cleanup failure' })] })
  } finally { await f.dispose() }
})

it('keeps native journal checkpoint limits distinct from index page limits', async () => {
  const { createPersonalDefinition } = await import('../domain/local-data')
  const { historyEntry } = await import('./local-data')
  const { INDEX_PAGE_BYTES } = await import('../workspace/directory')
  const f = await subtreeFixture()
  try {
    let before = f.state.planner.localData
    for (let index = 0; JSON.stringify(before).length < INDEX_PAGE_BYTES; index++) before = createPersonalDefinition(before, { name: `Synthetic checkpoint entry ${index}`, kind: 'item' })
    const after = createPersonalDefinition(before, { name: 'Synthetic last checkpoint entry', kind: 'item' })
    const checkpoint = historyEntry(before, after, 'synthetic large checkpoint', after.updatedAt)
    const state = { ...f.state, planner: { ...f.state.planner, localData: after, journal: { version: 1 as const, changes: after.changes, checkpoints: [checkpoint], undoable: false } } }
    const staged = await f.graph.stageAccountWorkspaceGraph(f.database, f.token, state, { owner: f.owner, rootFormat: { version: 2, inheritedEvidence: f.root.inheritedEvidence } })
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, staged.head, { version: 2, owner: f.owner })
    expect(opened.workspace.state.planner.journal!.checkpoints).toEqual([checkpoint])
    await opened.dispose()
  } finally { await f.dispose() }
})


it('rejects changed wrapper payload identity even when the stable row still decrypts to identical content', async () => {
  const f = await subtreeFixture(true)
  try {
    const index = await f.write({ version: 1, entries: [], children: [] }, [])
    const value = { version: 1, kind: 'local-source-context', source: f.staged.head, index }
    const wrapper = await f.write(value, [f.staged.head, index])
    const row = { id: `source-context:${f.staged.head.revisionId}`, ref: wrapper }
    await f.database.syncState.add(row)
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2 })
    const record = f.owner.prepared(wrapper)!, payloadId = accountLocalId()
    const chunks = (await f.database.stagedCipherChunks.toArray()).filter(chunk => chunk.payloadId === record.payloadId)
    await f.database.stagedCipherChunks.bulkAdd(chunks.map(chunk => ({ ...chunk, payloadId })))
    await f.database.encryptedRevisions.put({ ...record, payloadId })
    expect(await f.database.syncState.get(row.id)).toEqual(row)
    const { z } = await import('zod')
    expect(await f.cache.openAccountJson(f.database, f.token, wrapper, z.any())).toEqual(value)
    expect(opened.recordObservations()).toContainEqual(record)
    await expect(opened.recheck()).rejects.toThrow(/descriptor changed/)
    await opened.dispose()
  } finally { await f.dispose() }
})


async function checkpointAncestryFixture(installed: boolean) {
  const f = await subtreeFixture(installed)
  const { historyEntry } = await import('./local-data')
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { memoryBlob } = await import('../workspace/blobs')
  const after = { ...f.state.planner.localData, revision: 1 }
  const checkpoint = historyEntry(f.state.planner.localData, after, 'synthetic checkpoint ancestry', after.updatedAt)
  async function makeRoot(parents: readonly import('./account-database').CipherRef[], journal = true, version: 1 | 2 = 2) {
    const body = await f.write({ version: 1, kind: 'local-journal-checkpoint', value: checkpoint }, [f.root.index, ...parents])
    const index = await f.write({ version: 1, entries: [{ kind: 'checkpoint', ref: body }], children: [] }, [body])
    const value = { ...f.root, version, inheritedEvidence: version === 2 ? f.root.inheritedEvidence : undefined, localRevision: 1, ...(journal ? { plannerJournal: { version: 1 as const, index, undoable: false } } : {}) }
    const record = await stageAccountSource(f.database, f.token, memoryBlob(new TextEncoder().encode(JSON.stringify(value))), f.rootEdges({ ...value, version: 2, inheritedEvidence: f.root.inheritedEvidence }), parents, f.staged.head.documentId, f.owner)
    if (installed) await f.database.encryptedRevisions.add(record)
    return f.cache.cipherRef(record)
  }
  return { ...f, makeRoot }
}

it.each([false, true])('rejects encrypted multi-parent roots throughout strict checkpoint ancestry with installed=%s', async installed => {
  const f = await checkpointAncestryFixture(installed)
  try {
    const branch = await f.makeRoot([f.staged.head])
    const parents = [f.staged.head, branch]
    const shared = await f.makeRoot(parents)
    const noJournal = await f.makeRoot(parents, false)
    const nested = await f.makeRoot([shared])
    for (const head of [shared, noJournal, nested]) {
      let opened: Awaited<ReturnType<typeof f.graph.authenticateAccountWorkspaceSubtree>> | undefined
      try {
        await expect((async () => { opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner }); return opened })()).rejects.toThrow(/multiple workspace predecessors/)
      } finally { await opened?.dispose() }
    }
    if (installed) {
      const legacy = await f.makeRoot(parents, true, 1)
      expect((await openAccountWorkspace(f.database, f.token, legacy)).state.planner.journal!.checkpoints).toHaveLength(1)
    }
  } finally { await f.dispose() }
})

it.each([false, true])('checks single-parent ancestry depth before reading predecessor JSON with installed=%s', async installed => {
  const f = await checkpointAncestryFixture(installed)
  try {
    const branch = await f.makeRoot([f.staged.head]), head = await f.makeRoot([branch])
    const streams = await import('../workspace/account-streams')
    const reads = vi.spyOn(streams, 'openAccountSource')
    await expect(f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, head, { version: 2, owner: f.readOwner, limits: { depth: 1 } })).rejects.toThrow(/resource limit/)
    expect(reads.mock.calls.filter(([, , ref]) => ref.revisionId === f.staged.head.revisionId)).toEqual([])
  } finally { await f.dispose() }
})

it('binds complete inactive v2 evidence through blank bootstrap and parent adoption', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const bootstrap = inactive.createBlankInactiveAccountWorkspacePreparation(database, token)
  const parent = createAccountPreparationOwner(database, token)
  try {
    const blank = await bootstrap.prepare()
    expect(blank.opened.origin).toBe('legacy-v1-empty')
    expect(blank.opened.version).toBe(1)
    expect(blank.opened.workspace.state.blobs).toEqual([])
    const evidence = await createAccountInheritedEvidencePreparation(database, token).prepare({})
    const inherited = await inactive.adoptInactiveAccountEvidence(database, token, evidence, blank.owner, blank.opened)
    const next = await inactive.prepareInactiveAccountWorkspace(database, token, blank.opened.workspace.state, { owner: blank.owner, sourceOrigin: blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
    expect(next.opened.origin).toBe('evidence-v1')
    expect(next.opened.version).toBe(2)
    expect((await inactive.inactiveAccountInheritedSources(next.opened)).members).toEqual([])
    await blank.opened.dispose()
    await inherited.dispose()
    const rebound = await inactive.rebindInactiveAccountWorkspace(database, token, next.opened, parent)
    await expect(next.opened.check()).rejects.toThrow()
    expect(rebound.head).toEqual(next.head)
    expect(rebound.workspace.state).toEqual(blank.opened.workspace.state)
    await rebound.check()
    expect(await database.profileMeta.count()).toBe(0)
    expect(await database.encryptedRevisions.count()).toBe(0)
    await rebound.dispose()
  } finally { await bootstrap.abandon(); await parent.abandon(); invalidateProfile(); await database.delete() }
})

async function inactiveFixture() {
  const inactive = await import('../workspace/account-inactive-graph')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const key = crypto.getRandomValues(new Uint8Array(32)), token = installProfile(accountLocalId(), key.slice())
  const database = new AccountDatabase(token.accountId)
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token)
  const blank = await operation.prepare()
  return { inactive, database, token, key, operation, blank, createAccountInheritedEvidencePreparation, async close() { await operation.abandon(); invalidateProfile(); await database.delete() } }
}

it('pins the explicit evidence root in a complete inactive binding', async () => {
  const f = await inactiveFixture()
  try {
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
    const handle = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const next = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: handle, rootFormat: 'upgrade-v2' })
    const record = evidence.records.find(record => record.revisionId === evidence.root.revisionId)!
    await f.database.encryptedRevisions.add({ ...record, payloadId: accountLocalId() })
    await expect(next.opened.check()).rejects.toThrow()
    await next.opened.dispose(); await handle.dispose()
  } finally { await f.close() }
})

it('rejects copied inactive origins and tracks transaction-time source absence without activation', async () => {
  const f = await inactiveFixture()
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const copyOwner = createAccountPreparationOwner(f.database, f.token)
  try {
    await expect(f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: copyOwner, sourceOrigin: { ...f.blank.opened }, rootFormat: 'preserve' })).rejects.toThrow()
    const gate = await f.inactive.prepareInactiveAccountSourceCheck(f.blank.opened)
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
    await f.database.transaction('rw', f.database.profileMeta, f.database.syncState, f.database.encryptedRevisions, () => gate.recheckInTransaction())
    const context = await stageAccountJson(f.database, f.token, { changed: true }, [])
    const row = { id: `source-context:${f.blank.head.revisionId}`, ref: cipherRef(context) }
    await f.database.syncState.add(row)
    await expect(f.database.transaction('rw', f.database.profileMeta, f.database.syncState, f.database.encryptedRevisions, () => gate.recheckInTransaction())).rejects.toThrow()
    await expect(f.blank.opened.check()).rejects.toThrow()
    expect(await f.database.profileMeta.count()).toBe(0)
  } finally { await copyOwner.abandon(); await f.close() }
})

it.each([false, true])('authenticates a legacy projection without mapping or selecting it (installed=%s)', async installed => {
  const f = await inactiveFixture()
  const { AccountProjectionSchema, stageAccountJson, stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { sha256 } = await import('../interchange/util')
  const { readBlob } = await import('../workspace/blobs')
  try {
    const bytes = new TextEncoder().encode('private-D2-projection-native')
    const source = await stageAccountBytes(f.database, f.token, bytes, [], undefined, f.blank.owner)
    const projection = AccountProjectionSchema.parse({ version: 1, kind: 'local-planner-cache', localData: f.blank.opened.workspace.state.planner.localData, lineage: f.blank.opened.workspace.state.planner.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [{ id: 'projection-original', mediaType: 'text/plain', format: 'crystal-edit-json-1', importedAt: '2026-10-13T00:00:00.000Z', filename: 'synthetic.txt', digest: await sha256(bytes), original: cipherRef(source) }] })
    const root = await stageAccountJson(f.database, f.token, projection, [cipherRef(source)], undefined, f.blank.owner)
    if (installed) await f.database.encryptedRevisions.bulkAdd([source, root])
    const { exactAccountTables } = await import('./account-inactive-test-helpers')
    const before = await exactAccountTables(f.database)
    for (const inputFormat of ['workspace-graph', 'legacy-local-graph'] as const) await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(root), { owner: installed ? undefined : f.blank.owner, inputFormat })).rejects.toThrow()
    expect(await exactAccountTables(f.database)).toEqual(before)
    const opened = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(root), { owner: installed ? undefined : f.blank.owner, inputFormat: 'legacy-projection' })
    expect(opened.origin).toBe('legacy-v1-empty')
    expect(await readBlob(opened.workspace.state.blobs[0].content, bytes.length)).toEqual(bytes)
    expect(await f.database.profileMeta.count()).toBe(0)
    expect(await f.database.outbox.count()).toBe(0)
    await opened.dispose()
    await expect(readBlob(opened.workspace.state.blobs[0].content, bytes.length)).rejects.toThrow()
  } finally { await f.close() }
})

it('reopens complete inactive nonempty history from immutable ciphertext after all original owners retire', async () => {
  const f = await inactiveFixture()
  const { editorClosureFixture, multiPageMetadataText } = await import('../workspace/test-helpers')
  const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup')
  const { capturedBackupEvidence } = await import('../interchange/workspace-backup-evidence')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { memoryBlob, hashBlob, readBlob } = await import('../workspace/blobs')
  const fixture = await editorClosureFixture()
  const native = new TextEncoder().encode('private-D2-historical-only-native')
  const content = memoryBlob(native), sha256 = await hashBlob(content)
  const aliases = ['zz-history-only', 'aa-history-only'].map(documentId => ({ ref: { documentId, revisionId: 'original:1', encoding: 'bytes' as const, byteLength: native.length, sha256 }, content }))
  const historical = { version: 1 as const, snapshotId: 'D2-historical', capturedAt: '2026-10-13', revisionVector: {}, state: { ...fixture.state, blobs: [...aliases, ...fixture.state.blobs], editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: multiPageMetadataText('D2-private\ud800') } } }] } }
  const current = { version: 1 as const, snapshotId: 'D2-current', capturedAt: '2026-10-13', revisionVector: {}, state: f.blank.opened.workspace.state }
  const snapshot = await inheritWorkspaceSnapshot(current, [historical])
  async function pages(source: import('../workspace/documents').BlobSource) { const result: Uint8Array[] = []; for await (const page of source.open()) result.push(page.slice()); return result }
  let fresh: AccountDatabase | undefined
  try {
    const originals = await pages([...capturedBackupEvidence(snapshot).historical.values()][0])
    expect(originals.length).toBeGreaterThan(1)
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({ additions: [snapshot] })
    const inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const next = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, current.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
    expect(next.opened.workspace.state.blobs).toEqual([])
    const before = await f.inactive.inactiveAccountInheritedSources(next.opened)
    expect(await pages(before.members[0].metadata)).toEqual(originals)
    expect(before.members[0].subset).toEqual(historical.state.blobs.map(body => body.ref))
    const preserved = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, current.state, { owner: f.blank.owner, sourceOrigin: next.opened, inheritedEvidence: inherited, rootFormat: 'preserve' })
    expect(preserved.opened.version).toBe(2)
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records, ...evidence.records, ...next.records, ...preserved.records])
    const persisted = JSON.stringify([await f.database.encryptedRevisions.toArray(), await f.database.stagedCipherChunks.toArray()])
    for (const marker of ['private-D2', 'D2-private', 'zz-history-only', 'D2-historical']) expect(persisted).not.toContain(marker)
    await next.opened.dispose(); await preserved.opened.dispose(); await inherited.dispose(); await disposeWorkspaceSnapshot(snapshot); await f.operation.abandon()
    f.database.close(); invalidateProfile()
    const token = installProfile(f.token.accountId, f.key), database = new AccountDatabase(f.token.accountId)
    fresh = database
    const reopened = await f.inactive.openInactiveAccountWorkspace(database, token, preserved.head)
    const after = await f.inactive.inactiveAccountInheritedSources(reopened)
    expect(await pages(after.members[0].metadata)).toEqual(originals)
    expect(after.members[0].subset).toEqual(historical.state.blobs.map(body => body.ref))
    expect(await readBlob(after.bodies.find(body => body.ref.documentId === 'zz-history-only')!.content, native.length)).toEqual(native)
    expect(reopened.workspace.state.blobs).toEqual([])
    expect(await database.profileMeta.count()).toBe(0)
    await reopened.dispose()
    await expect(pages(after.members[0].metadata)).rejects.toThrow()
  } finally { await disposeWorkspaceSnapshot(snapshot); fresh?.close(); await f.close() }
})

it.each(['omitted', 'copied', 'disposed', 'erased', 'downgrade'] as const)('rejects %s evidence in an inactive v2 successor', async mode => {
  const f = await inactiveFixture()
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const fixture = await editorClosureFixture()
  const current = { version: 1 as const, snapshotId: 'membership-current', capturedAt: '2026-10-13', revisionVector: {}, state: f.blank.opened.workspace.state }
  const snapshot = await inheritWorkspaceSnapshot(current, [{ ...current, snapshotId: 'membership-history', state: fixture.state }])
  const successor = createAccountPreparationOwner(f.database, f.token)
  try {
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({ additions: [snapshot] })
    const inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const next = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, current.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records, ...evidence.records, ...next.records])
    let supplied: typeof inherited | undefined = inherited
    if (mode === 'omitted') supplied = undefined
    if (mode === 'copied') supplied = { ...inherited }
    if (mode === 'disposed') await inherited.dispose()
    if (mode === 'erased') {
      const empty = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
      supplied = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, empty, successor, next.opened)
    }
    await expect(f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, current.state, { owner: successor, sourceOrigin: next.opened, inheritedEvidence: supplied, rootFormat: mode === 'downgrade' ? 'v1' as 'preserve' : 'preserve' })).rejects.toThrow()
    expect(await f.database.profileMeta.count()).toBe(0)
    await next.opened.dispose(); await inherited.dispose()
  } finally { await successor.abandon(); await disposeWorkspaceSnapshot(snapshot); await f.close() }
})

it('treats the legacy input-format hint only as a strict decoding constraint', async () => {
  const f = await inactiveFixture()
  try {
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: f.blank.owner, inputFormat: 'legacy-projection' })).rejects.toThrow()
  } finally { await f.close() }
})

it('keeps a large legacy projection on its explicit archive-bound path', async () => {
  const f = await inactiveFixture()
  const { AccountProjectionSchema, stageAccountJson, cipherRef, openAccountJson } = await import('../workspace/account-cache')
  const { AccountWorkspaceRootV1Schema } = await import('../workspace/account-graph')
  const { INDEX_PAGE_BYTES } = await import('../workspace/directory')
  try {
    const localData = { ...f.blank.opened.workspace.state.planner.localData, referenceLibrary: { version: 1, excludedMods: Array.from({ length: 3000 }, (_, index) => `synthetic-large-projection-${index}-${'x'.repeat(70)}`) } }
    const projection = AccountProjectionSchema.parse({ version: 1, kind: 'local-planner-cache', localData, lineage: f.blank.opened.workspace.state.planner.lineage, catalogs: [], bundledCatalogs: [], sources: [], evidence: [] })
    expect(new TextEncoder().encode(JSON.stringify(projection)).length).toBeGreaterThan(INDEX_PAGE_BYTES)
    const record = await stageAccountJson(f.database, f.token, projection, [], undefined, f.blank.owner)
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(record), { owner: f.blank.owner })).rejects.toThrow(/bound/)
    const opened = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(record), { owner: f.blank.owner, inputFormat: 'legacy-projection' })
    expect(opened.workspace.state.planner.localData.referenceLibrary).toEqual(localData.referenceLibrary)
    await opened.dispose()
    const root = await openAccountJson(f.database, f.token, f.blank.head, AccountWorkspaceRootV1Schema, f.blank.owner)
    const oversized = await stageAccountJson(f.database, f.token, { ...root, lineageId: 'x'.repeat(INDEX_PAGE_BYTES + 1) }, [root.index, root.allocations], undefined, f.blank.owner)
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(oversized), { owner: f.blank.owner })).rejects.toThrow(/bound/)
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, cipherRef(oversized), { owner: f.blank.owner, inputFormat: 'legacy-projection' })).rejects.toThrow()
  } finally { await f.close() }
})

it('preserves effective-view context association through inactive preparation and parent reopen', async () => {
  const f = await subtreeFixture(true)
  const inactive = await import('../workspace/account-inactive-graph')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const owner = createAccountPreparationOwner(f.database, f.token), parent = createAccountPreparationOwner(f.database, f.token)
  try {
    const marked = { ...f.root, version: 1, inheritedEvidence: undefined }
    const effective = await f.write(marked, [])
    const original = await f.write({ ...marked, sourceEvidenceVersion: undefined }, [])
    const wrapper = await f.write({ version: 1, kind: 'local-source-view', source: original, view: effective }, [original, effective])
    await f.database.syncState.add({ id: `source-view:${original.revisionId}`, ref: wrapper })
    const index = await f.write({ version: 1, entries: [], children: [] }, [])
    const context = await f.write({ version: 1, kind: 'local-source-context', source: effective, index }, [effective, index])
    const row = { id: `source-context:${effective.revisionId}`, ref: context }
    await f.database.syncState.add(row)
    const source = await inactive.openInactiveAccountWorkspace(f.database, f.token, original)
    expect(source.effectiveRoot).toEqual(effective)
    await f.database.syncState.add({ id: `source-context:${original.revisionId}`, ref: original })
    await source.check()
    const prepared = await inactive.prepareInactiveAccountWorkspace(f.database, f.token, source.workspace.state, { owner, sourceOrigin: source, rootFormat: 'preserve' })
    await source.dispose()
    const reopened = await inactive.rebindInactiveAccountWorkspace(f.database, f.token, prepared.opened, parent)
    await reopened.check()
    await f.database.syncState.delete(row.id)
    await expect(reopened.check()).rejects.toThrow()
    await f.database.syncState.put(row)
    await reopened.check()
    await f.database.syncState.put({ ...row, ref: index })
    await expect(reopened.workspace.readCaptured(reopened.workspace.entries[0].ref)).rejects.toThrow()
    await reopened.dispose()
  } finally { await owner.abandon(); await parent.abandon(); await f.dispose() }
})

it.each(['database', 'profile', 'fence', 'disposed', 'cancelled'] as const)('rejects a stale inactive origin after %s changes', async mode => {
  const f = await inactiveFixture()
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const foreign = new AccountDatabase(f.token.accountId)
  const owner = createAccountPreparationOwner(f.database, f.token)
  try {
    if (mode === 'profile') invalidateProfile()
    if (mode === 'fence') await f.database.profileMeta.put({ key: 'active', headRevision: 1, head: f.blank.head })
    if (mode === 'disposed') await f.blank.opened.dispose()
    const controller = new AbortController()
    if (mode === 'cancelled') controller.abort(new Error('synthetic D cancellation'))
    await expect(f.inactive.prepareInactiveAccountWorkspace(mode === 'database' ? foreign : f.database, f.token, f.blank.opened.workspace.state, { owner, sourceOrigin: f.blank.opened, rootFormat: 'preserve', signal: controller.signal })).rejects.toThrow()
    expect(await f.database.encryptedRevisions.count()).toBe(0)
  } finally { foreign.close(); await owner.abandon(); await f.close() }
})

it('retains retryable blank-operation cleanup after staging and cleanup both fail', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const graph = await import('../workspace/account-graph')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token)
  const original = graph.stageAccountWorkspaceGraph
  const stage = vi.spyOn(graph, 'stageAccountWorkspaceGraph').mockImplementation(async (...args) => { await original(...args); throw new Error('synthetic D staging failure') })
  const transaction = database.transaction.bind(database)
  let denyCleanup = true
  const transactions = vi.spyOn(database, 'transaction').mockImplementation(((...args: unknown[]) => {
    if (denyCleanup && args[1] === database.stagedCipherChunks && args[2] === database.encryptedRevisions) return Promise.reject(new Error('synthetic D cleanup failure'))
    return Reflect.apply(transaction, database, args)
  }) as typeof database.transaction)
  try {
    // Allocation transactions also use these stores, so enable cleanup failure only after real staging
    denyCleanup = false
    stage.mockImplementation(async (...args) => { await original(...args); denyCleanup = true; throw new Error('synthetic D staging failure') })
    await expect(operation.prepare()).rejects.toBeInstanceOf(AggregateError)
    expect(await database.stagedCipherChunks.count()).toBeGreaterThan(0)
    expect(await database.encryptedRevisions.count()).toBe(0)
    denyCleanup = false
    await operation.abandon()
    expect(await database.stagedCipherChunks.count()).toBe(0)
    expect(await database.profileMeta.count()).toBe(0)
  } finally { stage.mockRestore(); transactions.mockRestore(); await operation.abandon(); invalidateProfile(); await database.delete() }
})

it('cleans blank bootstrap when a selector appears during encryption', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const graph = await import('../workspace/account-graph')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token)
  const original = graph.stageAccountWorkspaceGraph
  const spy = vi.spyOn(graph, 'stageAccountWorkspaceGraph').mockImplementation(async (...args) => {
    const result = await original(...args)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: result.head, records: result.records })
    return result
  })
  try {
    await expect(operation.prepare()).rejects.toThrow()
    const winner = await database.profileMeta.get('active')
    expect(winner).toBeDefined()
    expect((await openAccountWorkspace(database, token, winner!.head)).state.blobs).toEqual([])
    // The competing v1 selector installed these records; losing cleanup cannot remove shared ciphertext
    expect(await database.stagedCipherChunks.count()).toBeGreaterThan(0)
    await operation.abandon()
    expect(await database.profileMeta.get('active')).toEqual(winner)
  } finally { spy.mockRestore(); await operation.abandon(); invalidateProfile(); await database.delete() }
})

it.each([false, true])('rejects corrupt C ciphertext behind an otherwise valid inactive workspace (installed=%s)', async installed => {
  const f = await subtreeFixture(installed)
  const inactive = await import('../workspace/account-inactive-graph')
  try {
    const record = f.owner.prepared(f.root.inheritedEvidence)!
    const chunk = await f.database.stagedCipherChunks.get([record.payloadId, 0])
    await f.database.stagedCipherChunks.put({ ...chunk!, bytes: chunk!.bytes.slice(1) })
    const workspaceOnly = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { owner: f.readOwner, version: 2 })
    await workspaceOnly.dispose()
    await expect(inactive.openInactiveAccountWorkspace(f.database, f.token, f.staged.head, { owner: f.readOwner })).rejects.toThrow()
    expect(await f.database.profileMeta.count()).toBe(0)
  } finally { await f.dispose() }
})

it('rejects a replaced legacy native source before returning an inactive projection origin', async () => {
  const f = await inactiveFixture()
  const cache = await import('../workspace/account-cache')
  const streams = await import('../workspace/account-streams')
  const { sha256 } = await import('../interchange/util')
  const realOpen = streams.openAccountSource
  try {
    const bytes = new TextEncoder().encode('projection replacement marker')
    const body = await cache.stageAccountBytes(f.database, f.token, bytes, [], undefined, f.blank.owner)
    const projection = { version: 1, kind: 'local-planner-cache', localData: f.blank.opened.workspace.state.planner.localData, lineage: f.blank.opened.workspace.state.planner.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [{ id: 'synthetic-source', mediaType: 'text/plain', format: 'crystal-edit-json-1', importedAt: '2026-10-13T00:00:00.000Z', filename: 'original.txt', digest: await sha256(bytes), original: cache.cipherRef(body) }] }
    const root = await cache.stageAccountJson(f.database, f.token, projection, [cache.cipherRef(body)], undefined, f.blank.owner)
    await f.database.encryptedRevisions.bulkAdd([body, root])
    let changed = false
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      if (!changed && args[2].revisionId === body.revisionId) { changed = true; await f.database.encryptedRevisions.put({ ...body, payloadId: accountLocalId() }) }
      return realOpen(...args)
    })
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, cache.cipherRef(root), { inputFormat: 'legacy-projection' })).rejects.toThrow(/descriptor changed/)
    expect(changed).toBe(true)
    expect(await f.database.profileMeta.count()).toBe(0)
    expect(await f.database.encryptedRevisions.count()).toBe(2)
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('independently reopens complete explicit empty v2 after owner cleanup', async () => {
  const f = await inactiveFixture()
  try {
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
    const inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const next = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records, ...evidence.records, ...next.records])
    await next.opened.dispose(); await inherited.dispose(); await f.operation.abandon()
    const reopened = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, next.head)
    expect(reopened.origin).toBe('evidence-v1')
    expect(reopened.version).toBe(2)
    expect((await f.inactive.inactiveAccountInheritedSources(reopened)).members).toEqual([])
    expect(await f.database.profileMeta.count()).toBe(0)
    await reopened.dispose()
  } finally { await f.close() }
})

it('rejects source-association rebinding to a different full workspace root', async () => {
  const f = await inactiveFixture()
  try {
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
    const inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const next = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: f.blank.owner, sourceAssociation: next.opened })).rejects.toThrow()
    const exact = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, next.head, { owner: f.blank.owner, sourceAssociation: next.opened })
    expect(exact.version).toBe(2)
    await exact.dispose(); await next.opened.dispose(); await inherited.dispose()
  } finally { await f.close() }
})

it('rechecks source rows after the final borrowed C handle check', async () => {
  const f = await inactiveFixture()
  const evidenceApi = await import('../workspace/account-evidence-snapshots')
  try {
    const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
    const inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, f.blank.owner, f.blank.opened)
    const original = evidenceApi.accountInheritedSources
    let checks = 0
    vi.spyOn(evidenceApi, 'accountInheritedSources').mockImplementation(async handle => {
      const result = await original(handle)
      if (handle === inherited && ++checks === 2) await f.database.syncState.add({ id: `source-context:${f.blank.head.revisionId}`, ref: f.blank.head })
      return result
    })
    await expect(f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })).rejects.toThrow()
    expect(checks).toBe(2)
    expect(await f.database.profileMeta.count()).toBe(0)
    await inherited.dispose()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['owner', 'signal'] as const)('rejects same-root reopen when its target %s retires during the final source check', async mode => {
  const f = await inactiveFixture()
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { openAccountJson } = await import('../workspace/account-cache')
  const { AccountWorkspaceRootV1Schema } = await import('../workspace/account-graph')
  const target = createAccountPreparationOwner(f.database, f.token), controller = new AbortController()
  try {
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
    const recheck = AccountWorkspaceGraphReader.prototype.recheck
    let sourceChecks = 0
    // Keep real authentication and retire only the new target during the last old-source check
    const spy = vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await recheck.call(this)
      if (this.owner === f.blank.owner && ++sourceChecks === 2) {
        if (mode === 'owner') await target.abandon()
        else controller.abort(new Error('synthetic target cancelled during final source check'))
      }
    })
    await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: target, sourceAssociation: f.blank.opened, signal: controller.signal })).rejects.toThrow(mode === 'owner' ? /preparation has closed/ : /target cancelled/)
    expect(sourceChecks).toBe(2)
    spy.mockRestore()
    await f.blank.opened.check()
    if (mode === 'signal') expect((await openAccountJson(f.database, f.token, f.blank.head, AccountWorkspaceRootV1Schema, target)).version).toBe(1)
    expect(await f.database.encryptedRevisions.count()).toBe(f.blank.records.length)
    expect(await f.database.profileMeta.count()).toBe(0)
  } finally { vi.restoreAllMocks(); await target.abandon(); await f.close() }
})

it('rejects C adoption when the distinct target parent retires during the final source check', async () => {
  const f = await inactiveFixture()
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const parent = createAccountPreparationOwner(f.database, f.token)
  const evidence = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
  try {
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
    const installed = await f.database.encryptedRevisions.toArray()
    const sourceChunks = (await f.database.stagedCipherChunks.toArray()).filter(chunk => f.blank.records.some(record => record.payloadId === chunk.payloadId))
    const recheck = AccountWorkspaceGraphReader.prototype.recheck
    let sourceChecks = 0
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await recheck.call(this)
      if (this.owner === f.blank.owner && ++sourceChecks === 2) await parent.abandon()
    })
    await expect(f.inactive.adoptInactiveAccountEvidence(f.database, f.token, evidence, parent, f.blank.opened)).rejects.toThrow(/preparation has closed/)
    expect(sourceChecks).toBe(2)
    vi.restoreAllMocks()
    await f.blank.opened.check()
    await evidence.dispose()
    expect(await f.database.encryptedRevisions.toArray()).toEqual(installed)
    expect(await f.database.stagedCipherChunks.toArray()).toEqual(sourceChunks)
    expect(await f.database.profileMeta.toArray()).toEqual([])
  } finally { vi.restoreAllMocks(); await evidence.dispose(); await parent.abandon(); await f.close() }
})

it('transfers nonempty C and D twice while preserving borrowed ciphertext and an independent parent stream', async () => {
  const f = await inactiveFixture()
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountSource } = await import('../workspace/account-streams')
  const { openAccountInheritedEvidence, accountInheritedSources } = await import('../workspace/account-evidence-snapshots')
  const parent = createAccountPreparationOwner(f.database, f.token)
  await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
  const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, true, { segmentedMetadata: true })
  try {
    await f.database.encryptedRevisions.bulkAdd([...candidate.evidence.records])
    const borrowed = await openAccountInheritedEvidence(f.database, f.token, candidate.evidence.root)
    const borrowedSources = await accountInheritedSources(borrowed)
    const independent = await stageAccountBytes(f.database, f.token, new Uint8Array([7, 8]), [], undefined, parent)
    const iterator = (await openAccountSource(f.database, f.token, cipherRef(independent), parent)).open()[Symbol.asyncIterator]()
    const parentBytes = (await iterator.next()).value
    const extraChild = await openAccountInheritedEvidence(f.database, f.token, candidate.evidence.root, candidate.owner)
    const extra = (await accountInheritedSources(extraChild)).members[0].metadata.open()[Symbol.asyncIterator]()
    await extra.next()
    await candidate.inherited.dispose()
    await expect(f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)).rejects.toThrow(/busy/)
    expect(parentBytes).toEqual(new Uint8Array([7, 8]))
    await extra.return?.(); await extraChild.dispose()
    const retry = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, candidate.head, { owner: candidate.owner })
    const rebound = await f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, retry, parent)
    expect(rebound.head).toEqual(candidate.head)
    expect(rebound.inheritedEvidence!.root).toEqual(candidate.evidence.root)
    await candidate.assertContents(rebound)
    await expect(candidate.opened.check()).rejects.toThrow()
    await expect(accountInheritedSources(candidate.evidence.handle)).rejects.toThrow()
    await candidate.dispose()
    expect(parentBytes).toEqual(new Uint8Array([7, 8]))
    const borrowedIterator = borrowedSources.members[0].metadata.open()[Symbol.asyncIterator]()
    expect((await borrowedIterator.next()).done).toBe(false)
    await borrowedIterator.return?.()
    await borrowed.check()
    const second = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, rebound.workspace.state, { owner: parent, sourceOrigin: rebound, inheritedEvidence: rebound.inheritedEvidence, rootFormat: 'preserve' })
    await candidate.assertContents(second.opened)
    await second.opened.dispose(); await rebound.dispose(); await borrowed.dispose(); await iterator.return?.()
    const installed = await f.database.encryptedRevisions.toArray()
    const keep = new Set(installed.map(record => record.payloadId))
    const chunks = (await f.database.stagedCipherChunks.toArray()).filter(chunk => keep.has(chunk.payloadId))
    await parent.abandon()
    expect(await f.database.encryptedRevisions.toArray()).toEqual(installed)
    expect(await f.database.stagedCipherChunks.toArray()).toEqual(chunks)
  } finally { await candidate.dispose(); await parent.abandon(); await f.close() }
})

it.each(['C-root', 'C-descendant', 'C-final', 'D-root', 'D-descendant', 'D-C-root', 'D-C-descendant', 'D-final'] as const)(
  'abandons transferred allocations after real %s authentication failure and retains cleanup retry', async phase => {
    const f = await inactiveFixture()
    const { completeInactiveCandidate, exactAccountTables } = await import('./account-inactive-test-helpers')
    const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
    const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
    const streams = await import('../workspace/account-streams')
    const graph = await import('../workspace/account-graph')
    const evidenceApi = await import('../workspace/account-evidence-snapshots')
    const parent = createAccountPreparationOwner(f.database, f.token)
    await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
    const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, true)
    let cleanupDenied = false, transferred = false, injected = false
    const transaction = f.database.transaction.bind(f.database)
    try {
      await f.database.encryptedRevisions.bulkAdd([...candidate.evidence.records])
      const borrowedEvidence = await evidenceApi.openAccountInheritedEvidence(f.database, f.token, candidate.evidence.root)
      const baseline = await exactAccountTables(f.database)
      const keep = new Set((await f.database.encryptedRevisions.toArray()).map(record => record.payloadId))
      const keepChunks = (await f.database.stagedCipherChunks.toArray()).filter(chunk => keep.has(chunk.payloadId))
      const childC = phase.startsWith('C-') ? await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({ base: candidate.inherited }) : undefined
      await candidate.inherited.dispose()
      const adopt = parent.adopt.bind(parent)
      vi.spyOn(parent, 'adopt').mockImplementation(async owner => { await adopt(owner); transferred = true })
      vi.spyOn(f.database, 'transaction').mockImplementation(((...args: unknown[]) => {
        if (cleanupDenied && args[1] === f.database.stagedCipherChunks && args[2] === f.database.encryptedRevisions) return Promise.reject(new Error('synthetic transferred cleanup failure'))
        return Reflect.apply(transaction, f.database, args)
      }) as typeof f.database.transaction)
      const fail = () => { injected = true; cleanupDenied = true; throw new Error(`synthetic ${phase} failure`) }
      const root = childC?.root ?? candidate.head
      const evidenceRoot = childC?.root ?? candidate.evidence.root
      const cRecords = childC?.records ?? candidate.evidence.records
      const target = phase.endsWith('descendant') ? (phase.startsWith('C') || phase.startsWith('D-C') ? cRecords.find(record => record.revisionId !== evidenceRoot.revisionId)! : candidate.records.find(record => !candidate.evidence.records.includes(record) && record.revisionId !== candidate.head.revisionId)!) : undefined
      const targetRef = target ? { documentId: target.descriptor.documentId, revisionId: target.revisionId } : phase === 'D-C-root' ? evidenceRoot : root
      const realOpen = streams.openAccountSource
      vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
        const source = await realOpen(...args)
        if (transferred && !injected && !phase.endsWith('final') && args[3] === parent && args[2].revisionId === targetRef.revisionId) {
          return { ...source, async *open() { for await (const bytes of source.open()) { expect(bytes.length).toBeGreaterThan(0); fail() } } }
        }
        return source
      })
      if (phase === 'C-final') {
        const recheck = AccountWorkspaceGraphReader.prototype.recheck
        vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
          await recheck.call(this)
          if (transferred && this.owner === f.blank.owner && !injected) fail()
        })
      }
      if (phase === 'D-final') {
        const authenticate = graph.authenticateAccountWorkspaceSubtree
        vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => {
          const result = await authenticate(...args)
          return args[3]?.owner === parent ? { ...result, recheck: async () => { await result.recheck(); fail() } } : result
        })
      }
      const outcome = await (childC ? f.inactive.adoptInactiveAccountEvidence(f.database, f.token, childC, parent, f.blank.opened) : f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)).then(() => undefined, error => error)
      expect(outcome).toBeInstanceOf(AggregateError)
      expect(outcome.errors.map((error: Error) => error.message)).toEqual([`synthetic ${phase} failure`, 'synthetic transferred cleanup failure'])
      expect(transferred).toBe(true); expect(injected).toBe(true)
      const failed = await exactAccountTables(f.database)
      expect(failed.encryptedRevisions).toEqual(baseline.encryptedRevisions)
      for (const name of ['profileMeta', 'documentHeads', 'migrationJournal', 'outbox', 'conflicts', 'syncState']) expect(failed[name]).toEqual(baseline[name])
      expect((failed.stagedCipherChunks as unknown[]).length).toBeGreaterThan(keepChunks.length)
      if (childC) await childC.dispose(); else await candidate.owner.abandon()
      expect(await exactAccountTables(f.database)).toEqual(failed)
      cleanupDenied = false
      await parent.abandon()
      if (childC) await candidate.dispose()
      expect(await f.database.stagedCipherChunks.toArray()).toEqual(keepChunks)
      await f.blank.opened.check()
      // Installed source data remains independently readable after parent retry
      const borrowed = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head)
      await borrowed.check(); await borrowed.dispose()
      expect((await evidenceApi.accountInheritedSources(borrowedEvidence)).members).toHaveLength(1)
      await borrowedEvidence.check(); await borrowedEvidence.dispose()
    } finally { cleanupDenied = false; vi.restoreAllMocks(); await candidate.dispose(); await parent.abandon(); await f.close() }
  },
)

async function inactiveAssociationFixture(view: boolean, present: boolean) {
  const f = await subtreeFixture(true)
  const inactive = await import('../workspace/account-inactive-graph')
  const effective = await f.write({ ...f.root, version: 1, inheritedEvidence: undefined }, [])
  const original = await f.write({ ...f.root, version: 1, inheritedEvidence: undefined, sourceEvidenceVersion: undefined }, [])
  const viewValue = { version: 1, kind: 'local-source-view', source: original, view: effective }
  const viewRef = await f.write(viewValue, [original, effective])
  const viewRow = { id: `source-view:${original.revisionId}`, ref: viewRef }
  if (view) await f.database.syncState.add(viewRow)
  const consumed = view ? effective : original
  const indexValue = { version: 1, entries: [], children: [] }
  const index = await f.write(indexValue, [])
  const contextValue = { version: 1, kind: 'local-source-context', source: consumed, index }
  const contextRef = await f.write(contextValue, [consumed, index])
  const contextRow = { id: `source-context:${consumed.revisionId}`, ref: contextRef }
  if (present) await f.database.syncState.add(contextRow)
  const origin = await inactive.openInactiveAccountWorkspace(f.database, f.token, original)
  async function replaceIdentity(ref: import('./account-database').CipherRef, value: unknown, reencrypt: boolean) {
    const record = (await f.database.encryptedRevisions.get(ref.revisionId))!, payloadId = accountLocalId()
    if (reencrypt) {
      const { encryptRevision } = await import('../account/crypto/revisions')
      const { withAccountKey } = await import('../account/profile')
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      const encrypted = await withAccountKey(f.token, key => encryptRevision(key, { format: 1, accountId: f.token.accountId, ...ref, parents: [], dependencies: record.descriptor.dependencies, protected: true, plainBytes: bytes.length }, accountLocalId(), (async function* () { yield bytes })(), { id: payloadId, write: async (index, bytes) => { await f.database.stagedCipherChunks.add({ payloadId, index, bytes }) } }))
      await f.database.encryptedRevisions.put({ revisionId: ref.revisionId, payloadId, descriptor: encrypted.descriptor })
    } else {
      const chunks = await f.database.stagedCipherChunks.where('payloadId').equals(record.payloadId).toArray()
      await f.database.stagedCipherChunks.bulkAdd(chunks.map(chunk => ({ ...chunk, payloadId })))
      await f.database.encryptedRevisions.put({ ...record, payloadId })
    }
    const { z } = await import('zod')
    expect(await f.cache.openAccountJson(f.database, f.token, ref, z.any())).toEqual(value)
  }
  async function mutate(change: string) {
    if (change === 'context-appearance') await f.database.syncState.put(contextRow)
    if (change === 'context-removal') await f.database.syncState.delete(contextRow.id)
    if (change === 'context-replacement') await f.database.syncState.put({ ...contextRow, ref: await f.write(contextValue, [consumed, index]) })
    if (change === 'context-payload' || change === 'context-descriptor') await replaceIdentity(contextRef, contextValue, change.endsWith('descriptor'))
    if (change === 'index-payload' || change === 'index-descriptor') await replaceIdentity(index, indexValue, change.endsWith('descriptor'))
    if (change === 'view-appearance') await f.database.syncState.put(viewRow)
    if (change === 'view-removal') await f.database.syncState.delete(viewRow.id)
    if (change === 'view-replacement') await f.database.syncState.put({ ...viewRow, ref: await f.write(viewValue, [original, effective]) })
    if (change === 'view-payload' || change === 'view-descriptor') await replaceIdentity(viewRef, viewValue, change.endsWith('descriptor'))
    if (change === 'fence') await f.database.profileMeta.put({ key: 'active', headRevision: 1, head: original })
    if (change === 'unconsumed-original') await f.database.syncState.put({ id: `source-context:${original.revisionId}`, ref: original })
  }
  return { ...f, inactive, origin, mutate, async close() { await origin.dispose(); await f.dispose() } }
}

const associationCases = [false, true].flatMap(view => ['context-appearance', 'context-removal', 'context-replacement', 'context-payload', 'context-descriptor', 'index-payload', 'index-descriptor', 'fence', ...(view ? ['view-removal', 'view-replacement', 'view-payload', 'view-descriptor'] : ['view-appearance'])].flatMap(change => ['capture', 'C-transfer', 'D-transfer', 'workspace-final', 'C-final', 'lazy-first', 'lazy-next', 'transaction'].map(phase => ({ view, change, phase }))))
it.each(associationCases)('preserves original source snapshot: view=$view, $change at $phase', async ({ view, change, phase }) => {
  const f = await inactiveAssociationFixture(view, change !== 'context-appearance')
  const { completeInactiveCandidate, exactAccountTables } = await import('./account-inactive-test-helpers')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const graph = await import('../workspace/account-graph')
  const evidenceApi = await import('../workspace/account-evidence-snapshots')
  const parent = createAccountPreparationOwner(f.database, f.token)
  let candidate: Awaited<ReturnType<typeof completeInactiveCandidate>> | undefined
  let rebound: import('../workspace/account-inactive-graph').InactiveAccountWorkspace | undefined
  let mutated = false
  const mutate = async () => { if (!mutated) { mutated = true; await f.mutate(change) } }
  try {
    if (phase === 'capture') {
      await mutate()
      await expect(f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.origin.workspace.state, { owner: parent, sourceOrigin: f.origin, rootFormat: 'preserve' })).rejects.toThrow()
    } else if (phase === 'C-transfer') {
      const prepared = await evidenceApi.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
      const adopt = parent.adopt.bind(parent)
      vi.spyOn(parent, 'adopt').mockImplementation(async owner => { await adopt(owner); await mutate() })
      await expect(f.inactive.adoptInactiveAccountEvidence(f.database, f.token, prepared, parent, f.origin)).rejects.toThrow()
      await prepared.dispose()
    } else {
      candidate = await completeInactiveCandidate(f.database, f.token, f.origin, phase.startsWith('lazy'))
      await candidate.inherited.dispose()
      if (phase === 'D-transfer') {
        const adopt = parent.adopt.bind(parent)
        vi.spyOn(parent, 'adopt').mockImplementation(async owner => { await adopt(owner); await mutate() })
        await expect(f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)).rejects.toThrow()
      } else if (phase === 'workspace-final' || phase === 'C-final') {
        if (phase === 'workspace-final') {
          const authenticate = graph.authenticateAccountWorkspaceSubtree
          vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => { const result = await authenticate(...args); if (args[3]?.owner === parent) await mutate(); return result })
        } else {
          const open = evidenceApi.openAccountInheritedEvidence
          vi.spyOn(evidenceApi, 'openAccountInheritedEvidence').mockImplementation(async (...args) => { const result = await open(...args); if (args[3] === parent) await mutate(); return result })
        }
        await expect(f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)).rejects.toThrow()
      } else {
        rebound = await f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)
        if (phase.startsWith('lazy')) {
          const sources = await f.inactive.inactiveAccountInheritedSources(rebound)
          const stream = sources.members[0].metadata.open()[Symbol.asyncIterator]()
          if (phase === 'lazy-next') expect((await stream.next()).done).toBe(false)
          await mutate()
          await expect(stream.next()).rejects.toThrow()
          await expect(rebound.workspace.readCaptured(rebound.workspace.entries[0].ref)).rejects.toThrow()
          await stream.return?.()
        } else {
          const gate = await f.inactive.prepareInactiveAccountSourceCheck(rebound)
          await mutate()
          const before = await exactAccountTables(f.database)
          await expect(f.database.transaction('rw', f.database.tables, async () => {
            await f.database.encryptedRevisions.bulkAdd([...candidate!.records])
            await gate.recheckInTransaction()
            await f.database.documentHeads.put(candidate!.head)
            await f.database.syncState.put({ id: 'synthetic-transaction-pointer', ref: candidate!.head })
          })).rejects.toThrow()
          expect(await exactAccountTables(f.database)).toEqual(before)
        }
      }
    }
    expect(mutated).toBe(true)
  } finally { vi.restoreAllMocks(); await rebound?.dispose(); await candidate?.dispose(); await parent.abandon(); await f.close() }
})

it.each([false, true].flatMap(view => [false, true].map(present => ({ view, present }))))('retains stable source associations through both transfers and native equality (view=$view, present=$present)', async ({ view, present }) => {
  const f = await inactiveAssociationFixture(view, present)
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const parent = createAccountPreparationOwner(f.database, f.token)
  const candidate = await completeInactiveCandidate(f.database, f.token, f.origin, true)
  try {
    if (view) await f.mutate('unconsumed-original')
    await candidate.inherited.dispose()
    const rebound = await f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)
    await candidate.assertContents(rebound)
    expect(await rebound.workspace.readCaptured(rebound.workspace.entries[0].ref)).toBeDefined()
    const gate = await f.inactive.prepareInactiveAccountSourceCheck(rebound)
    await f.database.transaction('rw', f.database.tables, async () => {
      await f.database.encryptedRevisions.bulkAdd([...candidate.records])
      await gate.recheckInTransaction()
      await f.database.documentHeads.put(candidate.head)
    })
    expect(await f.database.documentHeads.get(candidate.head.documentId)).toEqual(candidate.head)
    await rebound.dispose()
  } finally { await candidate.dispose(); await parent.abandon(); await f.close() }
})

it.each([false, true])('races distinct blank native selectors and awaits loser cleanup before winner reopen (cleanupFailure=%s)', async cleanupFailure => {
  const inactive = await import('../workspace/account-inactive-graph')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const { stageAccountBytes, cipherRef, readAccountBytes } = await import('../workspace/account-cache')
  const borrowed = await stageAccountBytes(database, token, new Uint8Array([19, 23]), [])
  await database.encryptedRevisions.add(borrowed)
  const operations = [inactive.createBlankInactiveAccountWorkspacePreparation(database, token), inactive.createBlankInactiveAccountWorkspacePreparation(database, token)]
  let release!: () => void, reached!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { reached = resolve })
  let recovery: Promise<unknown> | undefined
  try {
    const prepared = [await operations[0].prepare(), await operations[1].prepare()]
    expect(prepared[0].head).not.toEqual(prepared[1].head)
    expect(await database.profileMeta.get('active')).toBeUndefined()
    const results = await Promise.allSettled(prepared.map(value => activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: value.head, records: value.records })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const loser = results.findIndex(result => result.status === 'rejected'), winner = 1 - loser
    expect(results[loser]).toMatchObject({ status: 'rejected', reason: { code: 'LOCAL_REVISION_CONFLICT' } })
    const fence = (await database.profileMeta.get('active'))!
    expect(fence.head).toEqual(prepared[winner].head)
    expect(await database.documentHeads.toArray()).toEqual([prepared[winner].head])
    expect(await database.migrationJournal.toArray()).toEqual([expect.objectContaining({ head: prepared[winner].head, headRevision: fence.headRevision, localStatus: 'active' })])
    for (const record of prepared[loser].records) expect(await database.encryptedRevisions.get(record.revisionId)).toBeUndefined()
    const selected = await exactAccountTables(database)
    const installed = await database.encryptedRevisions.toArray(), payloads = new Set(installed.map(record => record.payloadId))
    const chunks = (await database.stagedCipherChunks.toArray()).filter(chunk => payloads.has(chunk.payloadId))
    const transaction = database.transaction.bind(database)
    let block = true, reopened = false
    vi.spyOn(database, 'transaction').mockImplementation(((...args: unknown[]) => {
      if (block && args[1] === database.stagedCipherChunks && args[2] === database.encryptedRevisions) {
        block = false
        return (async () => { reached(); await barrier; if (cleanupFailure) throw new Error('synthetic loser cleanup failure'); return Reflect.apply(transaction, database, args) })()
      }
      return Reflect.apply(transaction, database, args)
    }) as typeof database.transaction)
    const recover = async () => {
      await operations[loser].abandon()
      const opened = await inactive.openInactiveAccountWorkspace(database, token, fence.head)
      reopened = true
      expect(opened.version).toBe(1); await opened.check(); await opened.dispose()
    }
    recovery = recover()
    const outcome = recovery.then(() => undefined, error => error)
    await entered
    expect(reopened).toBe(false)
    expect(await database.stagedCipherChunks.toArray()).toEqual(selected.stagedCipherChunks)
    release()
    if (cleanupFailure) {
      expect(await outcome).toMatchObject({ message: 'Inactive workspace cleanup failed' })
      expect(reopened).toBe(false)
      expect(await database.stagedCipherChunks.toArray()).toEqual(selected.stagedCipherChunks)
      await recover()
    } else expect(await outcome).toBeUndefined()
    expect(reopened).toBe(true)
    expect(await readAccountBytes(database, token, cipherRef(borrowed))).toEqual(new Uint8Array([19, 23]))
    expect(await database.encryptedRevisions.toArray()).toEqual(installed)
    expect(await database.stagedCipherChunks.toArray()).toEqual(chunks)
    for (const table of [database.profileMeta, database.documentHeads, database.migrationJournal, database.syncState, database.outbox, database.conflicts]) expect(await table.toArray()).toEqual(selected[table.name])
  } finally { release?.(); await Promise.allSettled([recovery]); vi.restoreAllMocks(); for (const operation of operations) await operation.abandon(); invalidateProfile(); await database.delete() }
})

it('C adoption settles only its handle and preserves independent child and continuing-parent readers', async () => {
  const f = await inactiveFixture()
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const { openAccountInheritedEvidence, accountInheritedSources } = await import('../workspace/account-evidence-snapshots')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountSource } = await import('../workspace/account-streams')
  await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
  const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, true, { segmentedMetadata: true })
  const parent = createAccountPreparationOwner(f.database, f.token)
  const child = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({ base: candidate.inherited })
  try {
    const parentRecord = await stageAccountBytes(f.database, f.token, new Uint8Array([31, 41]), [], undefined, parent)
    const parentStream = (await openAccountSource(f.database, f.token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
    const bytes = (await parentStream.next()).value
    const other = await openAccountInheritedEvidence(f.database, f.token, child.root, child.owner)
    const stream = (await accountInheritedSources(other)).members[0].metadata.open()[Symbol.asyncIterator]()
    await stream.next()
    await expect(f.inactive.adoptInactiveAccountEvidence(f.database, f.token, child, parent, f.blank.opened)).rejects.toThrow(/busy/)
    expect(bytes).toEqual(new Uint8Array([31, 41]))
    expect((await stream.next()).done).toBe(false)
    await stream.return?.(); await other.dispose()
    const handle = await openAccountInheritedEvidence(f.database, f.token, child.root, child.owner)
    const adopted = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, { ...child, handle }, parent, f.blank.opened)
    expect(adopted.root).toEqual(child.root)
    await expect(accountInheritedSources(handle)).rejects.toThrow()
    await child.dispose()
    expect(bytes).toEqual(new Uint8Array([31, 41]))
    expect((await accountInheritedSources(adopted)).members).toHaveLength(1)
    await adopted.dispose(); await parentStream.return?.()
  } finally { await child.dispose(); await candidate.dispose(); await parent.abandon(); await f.close() }
})

it.each(['signal', 'profile'].flatMap(mode => ['workspace', 'C', 'final'].map(phase => ({ mode, phase }))))('rejects $mode retirement during parent $phase authentication', async ({ mode, phase }) => {
  const f = await inactiveFixture()
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const graph = await import('../workspace/account-graph')
  const evidence = await import('../workspace/account-evidence-snapshots')
  await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
  const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, true)
  const parent = createAccountPreparationOwner(f.database, f.token), controller = new AbortController()
  const signed = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, candidate.head, { owner: candidate.owner, sourceAssociation: candidate.opened, signal: controller.signal })
  await candidate.opened.dispose(); await candidate.inherited.dispose()
  let retired = false
  const retire = () => { retired = true; if (mode === 'signal') controller.abort(new Error('synthetic target retirement')); else invalidateProfile() }
  const installed = await f.database.encryptedRevisions.toArray()
  const payloads = new Set(installed.map(record => record.payloadId))
  const chunks = (await f.database.stagedCipherChunks.toArray()).filter(chunk => payloads.has(chunk.payloadId))
  try {
    if (phase === 'C') {
      const open = evidence.openAccountInheritedEvidence
      vi.spyOn(evidence, 'openAccountInheritedEvidence').mockImplementation(async (...args) => { const result = await open(...args); if (args[3] === parent) retire(); return result })
    } else {
      const authenticate = graph.authenticateAccountWorkspaceSubtree
      vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => {
        const result = await authenticate(...args)
        if (args[3]?.owner !== parent) return result
        if (phase === 'workspace') { retire(); return result }
        return { ...result, recheck: async () => { await result.recheck(); retire() } }
      })
    }
    await expect(f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, signed, parent)).rejects.toThrow()
    expect(retired).toBe(true)
    expect(await f.database.encryptedRevisions.toArray()).toEqual(installed)
    expect(await f.database.stagedCipherChunks.toArray()).toEqual(chunks)
    expect(await f.database.profileMeta.toArray()).toEqual([])
  } finally { vi.restoreAllMocks(); await signed.dispose(); await candidate.dispose(); await parent.abandon(); await f.close() }
})

it.each(['first', 'next'] as const)('guards native workspace body %s reads against the original source after both transfers', async phase => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const fixture = await editorClosureFixture(), f = await subtreeFixture(true, fixture.state)
  const inactive = await import('../workspace/account-inactive-graph')
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const origin = await inactive.openInactiveAccountWorkspace(f.database, f.token, f.staged.head)
  const candidate = await completeInactiveCandidate(f.database, f.token, origin, false)
  const parent = createAccountPreparationOwner(f.database, f.token)
  try {
    await candidate.inherited.dispose()
    const rebound = await inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate.opened, parent)
    expect(rebound.workspace.state.blobs.length).toBeGreaterThan(0)
    const stream = rebound.workspace.state.blobs[0].content.open()[Symbol.asyncIterator]()
    if (phase === 'next') expect((await stream.next()).done).toBe(false)
    await f.database.syncState.put({ id: `source-context:${f.staged.head.revisionId}`, ref: f.staged.head })
    await expect(stream.next()).rejects.toThrow()
    await stream.return?.(); await rebound.dispose()
  } finally { await candidate.dispose(); await origin.dispose(); await parent.abandon(); await f.dispose() }
})

it.each([false, true])('legacy-local dispatch denies valid inactive v2 with nonempty evidence=%s', async nonempty => {
  const f = await inactiveFixture()
  const { completeInactiveCandidate, exactAccountTables } = await import('./account-inactive-test-helpers')
  const { openAccountJson, stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const { AccountWorkspaceRootV2Schema } = await import('../workspace/account-graph')
  await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
  const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, nonempty, { segmentedMetadata: true })
  try {
    const root = await openAccountJson(f.database, f.token, candidate.head, AccountWorkspaceRootV2Schema, candidate.owner)
    const unmarked = await stageAccountJson(f.database, f.token, { ...root, sourceEvidenceVersion: undefined }, candidate.records.find(record => record.revisionId === candidate.head.revisionId)!.descriptor.dependencies, undefined, candidate.owner)
    const before = await exactAccountTables(f.database)
    for (const head of [candidate.head, cipherRef(unmarked)]) {
      await expect(f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: candidate.owner, inputFormat: 'legacy-local-graph' })).rejects.toThrow()
      const ordinary = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: candidate.owner })
      await candidate.assertContents(ordinary); await ordinary.dispose()
    }
    expect(await exactAccountTables(f.database)).toEqual(before)
  } finally { await candidate.dispose(); await f.close() }
})

function cleanupBarrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it.each(['subtree', 'evidence', 'new-projection'] as const)('lateDOrCEvidenceHandleRegistersBeforeExposure (%s)', async phase => {
  const f = await inactiveFixture()
  const graph = await import('../workspace/account-graph')
  const evidence = await import('../workspace/account-evidence-snapshots')
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountCleanupCoordinator, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  let head = f.blank.head
  let inherited: Awaited<ReturnType<typeof evidence.openAccountInheritedEvidence>> | undefined
  let prepared: Awaited<ReturnType<typeof f.inactive.prepareInactiveAccountWorkspace>> | undefined
  try {
    if (phase === 'evidence') {
      const historical = await evidence.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
      inherited = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, historical, f.blank.owner, f.blank.opened)
      prepared = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
      head = prepared.head
    } else if (phase === 'new-projection') {
      const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
      const root = await stageAccountJson(f.database, f.token, { version: 1, kind: 'local-planner-cache', localData: f.blank.opened.workspace.state.planner.localData, lineage: f.blank.opened.workspace.state.planner.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [] }, [], undefined, f.blank.owner)
      head = cipherRef(root)
    }
    const before = await exactAccountTables(f.database)
    const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
    const parent = cleanup.group([]), rawReaders: { dispose(): Promise<void> }[] = [], counts: number[] = []
    const managed = { ...cleanup, reader(raw: { dispose(): Promise<void> }) {
      const index = rawReaders.push(raw) - 1; counts[index] = 0
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { counts[index]++; return dispose() })
      const node = cleanup.reader(raw); parent.include(node); return node
    }, group(parts: readonly import('../workspace/account-cleanup-attempt').AccountCleanupJoin[]) {
      const group = cleanup.group(parts); parent.include(group); return group
    } }
    // Two real encrypted readers supply distinct equal-message failures; shared membership
    // must preserve each resource once without collapsing errors by their text
    const failures = [new Error('same cleanup message'), new Error('same cleanup message')]
    const open = streams.openAccountSource
    let ordinal = 0
    const sourceSpy = vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args), error = failures[ordinal++]
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() { await input.return?.(); throw error }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    for (const _error of failures) {
      const raw = new AccountWorkspaceGraphReader(f.database, f.token, f.blank.owner)
      const input = (await raw.source(f.blank.head)).open()[Symbol.asyncIterator]()
      expect((await input.next()).value.length).toBeGreaterThan(0)
      const join = managed.reader(raw); parent.include(join)
    }
    sourceSpy.mockRestore()
    if (phase === 'subtree') {
      const real = graph.authenticateAccountWorkspaceSubtree
      vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => { const result = await real(...args); reached.resolve(); await resume.promise; return result })
    } else if (phase === 'evidence') {
      const real = evidence.openAccountInheritedEvidence
      vi.spyOn(evidence, 'openAccountInheritedEvidence').mockImplementation(async (...args) => { const result = await real(...args); reached.resolve(); await resume.promise; return result })
    } else {
      const get = f.database.profileMeta.get.bind(f.database.profileMeta)
      const { default: Dexie } = await import('dexie')
      vi.spyOn(f.database.profileMeta, 'get').mockImplementationOnce((...args: Parameters<typeof get>) => Dexie.Promise.resolve((async () => { const row = await get(...args); reached.resolve(); await resume.promise; return row })()))
    }
    const opening = f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: f.blank.owner, cleanup: managed, ...(phase === 'new-projection' ? { inputFormat: 'legacy-projection' as const } : {}) }).then(value => value, error => error)
    await reached.promise
    const first = await parent.request()
    expect(first.status).toBe('failed')
    if (first.status !== 'failed') throw new Error('Expected sibling failure')
    expect(first.errors).toHaveLength(2)
    expect((first.errors[0] as AggregateError).errors).toEqual([failures[0]])
    expect((first.errors[1] as AggregateError).errors).toEqual([failures[1]])
    const allocated = rawReaders.length
    resume.resolve()
    const rejected = await opening
    expect(rejected).toBeInstanceOf(Error)
    if (phase === 'new-projection') expect(rawReaders.length).toBeGreaterThan(allocated)
    expect(counts.every(count => count === 1)).toBe(true)
    expect(await parent.request()).toMatchObject({ attempt: 1, status: 'failed', errors: first.errors })
    // Sibling failures belong to the outer owner, never a fabricated inner operation primary
    const carrier = readAccountPreparationFailure(rejected)
    expect(carrier?.primary ?? rejected).toBeInstanceOf(Error)
    expect(await exactAccountTables(f.database)).toEqual(before)
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
  } finally { resume.resolve(); vi.restoreAllMocks(); await prepared?.opened.dispose(); await inherited?.dispose(); await f.close() }
})

it('managed D final source await denies a separately retired target and preserves the borrowed source', async () => {
  const f = await inactiveFixture()
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  try {
    const real = AccountWorkspaceGraphReader.prototype.recheck
    let borrowed!: InstanceType<typeof AccountWorkspaceGraphReader>
    const identify = vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(function (this: InstanceType<typeof AccountWorkspaceGraphReader>) { borrowed = this; return real.call(this) })
    await f.blank.opened.check(); identify.mockRestore()
    let checks = 0
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await real.call(this)
      if (this === borrowed && ++checks === 2) { reached.resolve(); await resume.promise }
    })
    const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
    const parent = cleanup.group([])
    const before = await exactAccountTables(f.database)
    const opening = f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: f.blank.owner, sourceAssociation: f.blank.opened, cleanup: { ...cleanup, group(parts) { const group = cleanup.group(parts); parent.include(group); return group } } }).then(value => value, error => error)
    await reached.promise
    expect(await parent.request()).toMatchObject({ status: 'succeeded' })
    resume.resolve()
    expect(await opening).toBeInstanceOf(Error)
    await f.blank.opened.check()
    expect(await exactAccountTables(f.database)).toEqual(before)
  } finally { resume.resolve(); vi.restoreAllMocks(); await f.close() }
})

it('managed D settles its pending checks and every real stream cleanup once without retiring the owner', async () => {
  const f = await inactiveFixture()
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  let prepared: Awaited<ReturnType<typeof f.inactive.prepareInactiveAccountWorkspace>> | undefined
  let reading: Promise<unknown> | undefined, disposal: Promise<unknown> | undefined
  try {
    prepared = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, (await editorClosureFixture()).state, { owner: f.blank.owner, sourceOrigin: f.blank.opened, rootFormat: 'preserve' })
    const before = await exactAccountTables(f.database)
    const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
    const counts: number[] = [], rawReaders: InstanceType<typeof AccountWorkspaceGraphReader>[] = []
    const opened = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, prepared.head, { owner: f.blank.owner, cleanup: { ...cleanup, reader(raw) {
      const index = counts.push(0) - 1, dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { counts[index]++; return dispose() })
      if (raw instanceof AccountWorkspaceGraphReader) rawReaders.push(raw)
      return cleanup.reader(raw)
    } } })
    const failures = [new Error('same stream cleanup error'), new Error('same stream cleanup error')]
    const entry = opened.workspace.entries.find(value => value.kind === 'blob')!
    const callbackChecks: Promise<unknown>[] = []
    let returns = 0
    const open = streams.openAccountSource
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args)
      if (args[2].revisionId !== entry.ref.revisionId) return source
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          callbackChecks.push(opened.check().then(() => undefined, error => error))
          await input.return?.()
          throw failures[returns++]
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    const iterator = opened.workspace.payloads.get(entry.key)!.open()[Symbol.asyncIterator]()
    const held = (await iterator.next()).value as Uint8Array
    expect(held.some(byte => byte !== 0)).toBe(true)
    const raw = rawReaders[1], recheck = raw.recheck.bind(raw)
    vi.spyOn(raw, 'recheck').mockImplementationOnce(async () => { reached.resolve(); await resume.promise; await recheck() })
    reading = opened.check().then(() => undefined, error => error)
    await reached.promise
    disposal = opened.dispose().then(() => undefined, error => error)
    await expect(opened.check()).rejects.toThrow(/origin or source/)
    expect(held.every(byte => byte === 0)).toBe(true)
    // All raw sibling attempts start in the synchronous request prefix, before a pending
    // check is released; expected revocation of that check is not a cleanup failure
    expect(counts.every(count => count === 1)).toBe(true)
    resume.resolve()
    expect(await reading).toBeInstanceOf(Error)
    const rejected = await disposal
    expect(rejected).toBeInstanceOf(AggregateError)
    const cleanupOnly = readAccountCleanupOnlyFailure(rejected)
    expect(cleanupOnly?.result.status).toBe('failed')
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    const errors = (rejected as AggregateError).errors as AggregateError[]
    expect(errors).toHaveLength(2)
    const causes = errors.flatMap(error => error.errors)
    expect(causes).toHaveLength(failures.length)
    for (const failure of failures) expect(causes.some(cause => cause === failure)).toBe(true)
    expect(returns).toBe(2)
    for (const result of await Promise.all(callbackChecks)) expect(result).toMatchObject({ message: 'Inactive workspace origin or source association changed' })
    await expect(opened.dispose()).rejects.toMatchObject({ errors })
    expect(returns).toBe(2)
    expect(counts.every(count => count === 1)).toBe(true)
    vi.restoreAllMocks()
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
    expect(await exactAccountTables(f.database)).toEqual(before)
  } finally { resume.resolve(); await Promise.allSettled([reading, disposal]); vi.restoreAllMocks(); await prepared?.opened.dispose(); await f.close() }
})

it('managed direct subtree facade joins a failed disposal after natural stream return', async () => {
  const f = await subtreeFixture(true)
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  let input: AsyncIterator<Uint8Array> | undefined
  try {
    const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
    let raw!: InstanceType<typeof AccountWorkspaceGraphReader>, attempts = 0
    const opened = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, cleanup: { ...cleanup, reader(value) {
      raw = value as InstanceType<typeof AccountWorkspaceGraphReader>
      const dispose = value.dispose.bind(value)
      vi.spyOn(value, 'dispose').mockImplementation(() => { attempts++; return dispose() })
      return cleanup.reader(value)
    } } })
    const open = streams.openAccountSource, cleanupError = new Error('physical return failure')
    let armed = false, failures = 0
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args)
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const iterator = source.open()[Symbol.asyncIterator]()
        return { next: () => iterator.next(), async return() {
          await iterator.return?.()
          if (armed && failures++ === 0) throw cleanupError
          return { done: true as const, value: undefined }
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    input = (await raw.source(f.staged.head)).open()[Symbol.asyncIterator]()
    expect((await input.next()).value.length).toBeGreaterThan(0)
    armed = true
    const rejected = await opened.dispose().catch(error => error)
    expect(rejected).toBeInstanceOf(AggregateError)
    const first = await cleanup.reader(raw).wait()
    expect(first.status).toBe('failed')
    if (first.status !== 'failed') throw new Error('Expected cleanup failure')
    expect((first.errors[0] as AggregateError).errors[0]).toBe(cleanupError)
    expect(readAccountCleanupOnlyFailure(rejected)).toEqual({ cleanup: cleanup.reader(raw), result: first })
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    await input.return?.()
    await expect(opened.dispose()).rejects.toMatchObject({ errors: first.errors })
    expect(await cleanup.reader(raw).request()).toBe(first)
    expect(attempts).toBe(1)
  } finally { vi.restoreAllMocks(); await input?.return?.(); await f.dispose() }
})

it('managed D reports a normal dispatch cleanup failure without inventing an opening primary', async () => {
  const f = await inactiveFixture()
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const before = await exactAccountTables(f.database)
  const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const cleanupError = new Error('native dispatch return'), json = AccountWorkspaceGraphReader.prototype.json
  let capture = false, held: Uint8Array | undefined, dispatch: InstanceType<typeof AccountWorkspaceGraphReader> | undefined
  let dispatchJoin: import('../workspace/account-cleanup-attempt').AccountCleanupJoin | undefined, attempts = 0, failedReturns = 0
  try {
    const source = streams.openAccountSource
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const opened = await source(...args)
      if (!capture) return opened
      return { ...opened, open(): AsyncIterableIterator<Uint8Array> {
        const input = opened.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          await input.return?.()
          if (failedReturns++ === 0) throw cleanupError
          return { done: true as const, value: undefined }
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'json').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>, ...args: Parameters<typeof json>) {
      const value = await json.call(this, ...args)
      if (!held) {
        expect(this).toBe(dispatch)
        capture = true
        const input = (await this.source(f.blank.head)).open()[Symbol.asyncIterator]()
        held = (await input.next()).value as Uint8Array
        capture = false
      }
      return value
    })
    const rejected = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: f.blank.owner, cleanup: { ...cleanup, reader(raw) {
      if (raw instanceof AccountWorkspaceGraphReader && !dispatch) {
        dispatch = raw
        const dispose = raw.dispose.bind(raw)
        vi.spyOn(raw, 'dispose').mockImplementation(() => { attempts++; return dispose() })
        dispatchJoin = cleanup.reader(raw)
        return dispatchJoin
      }
      return cleanup.reader(raw)
    } } }).then(value => value, error => error)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only).toBeDefined()
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    expect(only!.result.status).toBe('failed')
    expect(only!.result.status === 'failed' ? (only!.result.errors[0] as AggregateError).errors[0] : undefined).toBe(cleanupError)
    expect(held?.length).toBeGreaterThan(0)
    expect(held!.every(byte => byte === 0)).toBe(true)
    expect(attempts).toBe(1)
    const physicalReturns = failedReturns
    expect(physicalReturns).toBeGreaterThan(0)
    expect((await dispatchJoin!.request()).status).toBe('failed')
    expect(attempts).toBe(1)
    expect(failedReturns).toBe(physicalReturns)
    expect(await exactAccountTables(f.database)).toEqual(before)
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['cleanup-only', 'primary-undefined', 'literal-undefined'] as const)('A managed authentication distinguishes a nested cleanup failure from undefined primary (%s)', async kind => {
  const f = await subtreeFixture(true)
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { accountCleanupOnlyFailure, accountPreparationFailure, createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const before = await exactAccountTables(f.database)
  const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const nestedError = new Error('nested cleanup'), nested = cleanup.reader({ async dispose() { throw nestedError } })
  const first = kind === 'literal-undefined' ? undefined : await nested.request()
  if (first && first.status !== 'failed') throw new Error('Expected nested cleanup failure')
  const incoming = kind === 'cleanup-only' ? accountCleanupOnlyFailure(nested, first!) : kind === 'primary-undefined' ? accountPreparationFailure(undefined, nested) : undefined
  const recheck = AccountWorkspaceGraphReader.prototype.recheck
  let injected = false, readerDisposals = 0
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await recheck.call(this)
      if (!injected) { injected = true; throw incoming }
    })
    const rejected = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, cleanup: { ...cleanup, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { readerDisposals++; return dispose() })
      return cleanup.reader(raw)
    } } }).then(value => value, error => error)
    expect(injected).toBe(true)
    expect(readerDisposals).toBe(1)
    if (kind === 'cleanup-only') {
      expect(rejected).toBe(incoming)
      expect(readAccountCleanupOnlyFailure(rejected)).toEqual({ cleanup: nested, result: first })
      expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    } else if (kind === 'primary-undefined') {
      expect(readAccountPreparationFailure(rejected)?.primary).toBeUndefined()
      expect(readAccountPreparationFailure(rejected)?.cleanup).toBeDefined()
      expect(readAccountCleanupOnlyFailure(rejected)).toBeUndefined()
    } else expect(rejected).toBeUndefined()
    if (first) expect(await nested.request()).toBe(first)
    expect(await exactAccountTables(f.database)).toEqual(before)
    expect(() => f.owner.check()).not.toThrow()
  } finally { await f.dispose() }
})

it.each((['projection', 'subtree'] as const).flatMap(route => [{ route, localFailure: false, historicalRetry: false }, { route, localFailure: true, historicalRetry: false }, { route, localFailure: false, historicalRetry: true }, { route, localFailure: true, historicalRetry: true }]))('D managed catch preserves nested cleanup-only errors without a false primary (%j)', async ({ route, localFailure, historicalRetry }) => {
  const f = await inactiveFixture()
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const { accountCleanupOnlyFailure, createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {}), { cleanup } = coordinator
  const original = new Error('same message'), distinct = new Error('same message')
  let nestedAttempts = 0
  const nested = cleanup.reader({ async dispose() { if (++nestedAttempts === 1) throw original } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected nested cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  if (historicalRetry) {
    await coordinator.retryFailed([nested])
    expect(nested.observe()).toEqual({ attempt: 2, status: 'succeeded' })
  }
  let head = f.blank.head
  if (route === 'projection') {
    const local = f.blank.opened.workspace.state.planner
    const projection = await stageAccountJson(f.database, f.token, { version: 1, kind: 'local-planner-cache', localData: local.localData, lineage: local.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [] }, [], undefined, f.blank.owner)
    head = cipherRef(projection)
  }
  const before = await exactAccountTables(f.database), json = AccountWorkspaceGraphReader.prototype.json
  let reads = 0, localAttempts = 0, registrations = 0
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'json').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>, ...args: Parameters<typeof json>) {
      const value = await json.call(this, ...args)
      if (++reads === (route === 'projection' ? 1 : 2)) throw incoming
      return value
    })
    const rejected = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: f.blank.owner, cleanup: { ...cleanup, reader(raw) {
      if (registrations++ === 0 && localFailure) {
        const dispose = raw.dispose.bind(raw)
        vi.spyOn(raw, 'dispose').mockImplementation(async () => { localAttempts++; await dispose(); throw distinct })
      }
      return cleanup.reader(raw)
    } }, ...(route === 'projection' ? { inputFormat: 'legacy-projection' as const } : {}) }).then(value => value, error => error)
    if (!localFailure) expect(rejected).toBe(incoming)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only).toBeDefined()
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    expect(only!.result.status).toBe('failed')
    expect(only!.result.status === 'failed' ? only!.result.errors : undefined).toEqual(localFailure ? historicalRetry ? [distinct] : [distinct, original] : [original])
    if (!historicalRetry || !localFailure) expect(only!.result.status === 'failed' ? only!.result.errors[localFailure ? 1 : 0] : undefined).toBe(original)
    if (localFailure) expect(only!.result.status === 'failed' ? only!.result.errors[0] : undefined).toBe(distinct)
    if (localFailure && historicalRetry) {
      expect((rejected as AggregateError).errors).toEqual([distinct, original])
      expect((rejected as AggregateError).errors[0]).toBe(distinct)
      expect((rejected as AggregateError).errors[1]).toBe(original)
      expect((rejected as Error & { cause?: unknown }).cause).toBe(incoming)
      expect(only!.history).toEqual([incoming])
      expect(readAccountCleanupOnlyFailure(incoming)).toEqual({ cleanup: nested, result: first })
    }
    expect(reads).toBeGreaterThanOrEqual(route === 'projection' ? 1 : 2)
    expect(nestedAttempts).toBe(historicalRetry ? 2 : 1)
    expect(localAttempts).toBe(localFailure ? 1 : 0)
    if (historicalRetry) expect((await nested.request()).status).toBe('succeeded')
    else expect(await nested.request()).toBe(first)
    expect(await exactAccountTables(f.database)).toEqual(before)
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('D retains an aborted native deletion after retry beside a later physical stream-return failure', async () => {
  const f = await inactiveFixture()
  const { IDBObjectStore } = await import('fake-indexeddb')
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { accountCleanupOnlyFailure, createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const owner = createAccountPreparationOwner(f.database, f.token)
  const owned = await stageAccountBytes(f.database, f.token, new Uint8Array([89, 90]), [], undefined, owner)
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {}), { cleanup } = coordinator
  const nested = cleanup.owner(owner)
  const nativeDelete = IDBObjectStore.prototype.delete
  let deletes = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = nativeDelete.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned.payloadId && ++deletes === 1) this.transaction.abort()
    return request
  })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected native first-attempt cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  await coordinator.retryFailed([nested])
  const before = await exactAccountTables(f.database)
  const open = streams.openAccountSource, json = AccountWorkspaceGraphReader.prototype.json
  const localError = new Error('physical D stream return')
  let capture = false, injected = false, held: Uint8Array | undefined, returns = 0
  try {
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args)
      if (!capture) return source
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          await input.return?.()
          returns++
          throw localError
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'json').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>, ...args: Parameters<typeof json>) {
      const value = await json.call(this, ...args)
      if (!injected) {
        capture = true
        const iterator = (await this.source(f.blank.head)).open()[Symbol.asyncIterator]()
        held = (await iterator.next()).value as Uint8Array
        capture = false
        injected = true
        throw incoming
      }
      return value
    })
    const rejected = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, f.blank.head, { owner: f.blank.owner, cleanup }).then(value => value, error => error)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only?.result.status).toBe('failed')
    if (only?.result.status !== 'failed') throw new Error('Expected local cleanup failure')
    expect((only.result.errors[0] as AggregateError).errors[0]).toBe(localError)
    expect((rejected as AggregateError).errors).toEqual([only.result.errors[0], first.errors[0]])
    expect((rejected as AggregateError).errors[0]).toBe(only.result.errors[0])
    expect((rejected as AggregateError).errors[1]).toBe(first.errors[0])
    expect((rejected as Error & { cause?: unknown }).cause).toBe(incoming)
    expect(only.history).toEqual([incoming])
    expect(readAccountCleanupOnlyFailure(incoming)).toEqual({ cleanup: nested, result: first })
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    expect(injected).toBe(true)
    expect(held?.length).toBeGreaterThan(0)
    expect(held!.every(byte => byte === 0)).toBe(true)
    expect(returns).toBe(1)
    expect(deletes).toBe(2)
    expect((await nested.request()).status).toBe('succeeded')
    expect(await exactAccountTables(f.database)).toEqual(before)
    await f.blank.opened.check()
  } finally { vi.restoreAllMocks(); await owner.abandon(); await f.close() }
})

it.each([false, true])('A managed authentication retains distinct failed cleanup history after retry (historical=%s)', async historicalRetry => {
  const f = await subtreeFixture(true)
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { accountCleanupOnlyFailure, createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {}), { cleanup } = coordinator
  const nestedError = new Error('same message'), localError = new Error('same message')
  let nestedAttempts = 0
  const nested = cleanup.reader({ async dispose() { if (++nestedAttempts === 1 || !historicalRetry) throw nestedError } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected nested cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  if (historicalRetry) await coordinator.retryFailed([nested])
  const recheck = AccountWorkspaceGraphReader.prototype.recheck
  let injected = false, localAttempts = 0
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await recheck.call(this)
      if (!injected) { injected = true; throw incoming }
    })
    const rejected = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.staged.head, { version: 2, cleanup: { ...cleanup, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(async () => { localAttempts++; await dispose(); throw localError })
      return cleanup.reader(raw)
    } } }).then(value => value, error => error)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only).toBeDefined()
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    expect(only!.result.status === 'failed' ? only!.result.errors : undefined).toEqual(historicalRetry ? [localError] : [localError, nestedError])
    expect(only!.result.status === 'failed' ? only!.result.errors[0] : undefined).toBe(localError)
    if (historicalRetry) {
      expect((rejected as AggregateError).errors).toEqual([localError, nestedError])
      expect((rejected as AggregateError).errors[0]).toBe(localError)
      expect((rejected as AggregateError).errors[1]).toBe(nestedError)
      expect((rejected as Error & { cause?: unknown }).cause).toBe(incoming)
      expect(only!.history).toEqual([incoming])
      expect(readAccountCleanupOnlyFailure(incoming)).toEqual({ cleanup: nested, result: first })
    } else expect(only!.result.status === 'failed' ? only!.result.errors[1] : undefined).toBe(nestedError)
    expect(localAttempts).toBe(1)
    expect(nestedAttempts).toBe(historicalRetry ? 2 : 1)
    if (historicalRetry) expect((await nested.request()).status).toBe('succeeded')
    else expect(await nested.request()).toBe(first)
    expect(() => f.owner.check()).not.toThrow()
  } finally { await f.dispose() }
})

it.each(['projection', 'subtree'] as const)('D managed %s opening keeps literal undefined as an operation primary', async route => {
  const f = await inactiveFixture()
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  let head = f.blank.head
  if (route === 'projection') {
    const local = f.blank.opened.workspace.state.planner
    head = cipherRef(await stageAccountJson(f.database, f.token, { version: 1, kind: 'local-planner-cache', localData: local.localData, lineage: local.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [] }, [], undefined, f.blank.owner))
  }
  const json = AccountWorkspaceGraphReader.prototype.json
  let reads = 0
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'json').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>, ...args: Parameters<typeof json>) {
      const value = await json.call(this, ...args)
      if (++reads === (route === 'projection' ? 1 : 2)) throw undefined
      return value
    })
    const rejected = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: f.blank.owner, cleanup, ...(route === 'projection' ? { inputFormat: 'legacy-projection' as const } : {}) }).then(value => value, error => error)
    expect(reads).toBeGreaterThanOrEqual(route === 'projection' ? 1 : 2)
    expect(rejected).toBeUndefined()
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('A rejects a foreign cleanup-only join after disposing its local reader', async () => {
  const f = await inactiveFixture()
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { authenticateAccountWorkspaceSubtree } = await import('../workspace/account-graph')
  const { createAccountCleanupCoordinator, accountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const local = createAccountCleanupCoordinator(f.database, f.token, async () => {}).cleanup
  const foreign = createAccountCleanupCoordinator(f.database, f.token, async () => {}).cleanup
  const foreignJoin = foreign.reader({ async dispose() { throw new Error('foreign cleanup') } })
  const first = await foreignJoin.request()
  if (first.status !== 'failed') throw new Error('Expected foreign cleanup failure')
  const incoming = accountCleanupOnlyFailure(foreignJoin, first)
  const recheck = AccountWorkspaceGraphReader.prototype.recheck
  let localDisposals = 0, injected = false
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'recheck').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>) {
      await recheck.call(this)
      if (!injected) { injected = true; throw incoming }
    })
    const rejected = await authenticateAccountWorkspaceSubtree(f.database, f.token, f.blank.head, { version: 1, owner: f.blank.owner, cleanup: { ...local, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { localDisposals++; return dispose() })
      return local.reader(raw)
    } } }).then(value => value, error => error)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toMatch(/Foreign or unregistered account cleanup join/)
    expect(localDisposals).toBe(1)
    await f.blank.opened.check()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('D rejects a foreign cleanup-only join after disposing its local readers', async () => {
  const f = await inactiveFixture()
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const { accountCleanupOnlyFailure, createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const local = createAccountCleanupCoordinator(f.database, f.token, async () => {}).cleanup
  const foreign = createAccountCleanupCoordinator(f.database, f.token, async () => {}).cleanup
  const foreignJoin = foreign.reader({ async dispose() { throw new Error('foreign cleanup') } })
  const first = await foreignJoin.request()
  if (first.status !== 'failed') throw new Error('Expected foreign cleanup failure')
  const incoming = accountCleanupOnlyFailure(foreignJoin, first)
  const planner = f.blank.opened.workspace.state.planner
  const head = cipherRef(await stageAccountJson(f.database, f.token, { version: 1, kind: 'local-planner-cache', localData: planner.localData, lineage: planner.lineage, catalogs: [], bundledCatalogs: [], evidence: [], sources: [] }, [], undefined, f.blank.owner))
  const json = AccountWorkspaceGraphReader.prototype.json
  let injected = false, localDisposals = 0
  try {
    vi.spyOn(AccountWorkspaceGraphReader.prototype, 'json').mockImplementation(async function (this: InstanceType<typeof AccountWorkspaceGraphReader>, ...args: Parameters<typeof json>) {
      const value = await json.call(this, ...args)
      if (!injected) { injected = true; throw incoming }
      return value
    })
    const rejected = await f.inactive.openInactiveAccountWorkspace(f.database, f.token, head, { owner: f.blank.owner, inputFormat: 'legacy-projection', cleanup: { ...local, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { localDisposals++; return dispose() })
      return local.reader(raw)
    } } }).then(value => value, error => error)
    expect(injected).toBe(true)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toMatch(/Foreign or unregistered account cleanup join/)
    expect(localDisposals).toBeGreaterThan(0)
    await f.blank.opened.check()
    expect(() => f.blank.owner.check()).not.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('managed D preparation preserves the first native cleanup failure until explicit retry', async () => {
  const f = await inactiveFixture()
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const owner = createAccountPreparationOwner(f.database, f.token)
  const owned = await stageAccountBytes(f.database, f.token, new Uint8Array([71, 72]), [], undefined, owner)
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const original = IDBObjectStore.prototype.delete
  let deletes = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned.payloadId && ++deletes === 1) this.transaction.abort()
    return request
  })
  try {
    const rejected = await f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner, sourceOrigin: { ...f.blank.opened }, rootFormat: 'preserve', cleanup: coordinator.cleanup }).then(value => value, error => error)
    const wrapped = readAccountPreparationFailure(rejected)
    expect(wrapped).toBeDefined()
    expect(wrapped!.primary).toBeInstanceOf(Error)
    expect(wrapped!.cleanup).toBeDefined()
    const first = await wrapped!.cleanup.request()
    expect(first.status).toBe('failed')
    expect(deletes).toBe(1)
    expect(await f.database.stagedCipherChunks.get([owned.payloadId, 0])).toBeDefined()
    expect(await wrapped!.cleanup.request()).toEqual(first)
    expect(deletes).toBe(1)
    await coordinator.retryFailed([wrapped!.cleanup])
    expect(deletes).toBe(2)
    expect(await f.database.stagedCipherChunks.get([owned.payloadId, 0])).toBeUndefined()
    await f.blank.opened.check()
  } finally { vi.restoreAllMocks(); await owner.abandon(); await f.close() }
})

it.each([false, true])('managed blank abandonment revokes its private owner before cleanup settles (nativeFailure=%s)', async nativeFailure => {
  const inactive = await import('../workspace/account-inactive-graph')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountSource } = await import('../workspace/account-streams')
  const { AccountDatabase } = await import('./account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  let owner: import('../workspace/account-prepared-records').AccountPreparationOwner | undefined
  const managed = { ...coordinator.cleanup, owner(value: import('../workspace/account-prepared-records').AccountPreparationOwner) { owner = value; return coordinator.cleanup.owner(value) } }
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token, managed)
  try {
    expect(owner).toBeDefined()
    const record = await stageAccountBytes(database, token, new Uint8Array([81, 82, 83]), [], undefined, owner!)
    const iterator = (await openAccountSource(database, token, cipherRef(record), owner)).open()[Symbol.asyncIterator]()
    const held = (await iterator.next()).value as Uint8Array
    expect(held).toEqual(new Uint8Array([81, 82, 83]))
    const original = IDBObjectStore.prototype.delete
    let nativeDeletes = 0
    if (nativeFailure) vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = original.call(this, key)
      if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === record.payloadId && ++nativeDeletes === 1) this.transaction.abort()
      return request
    })
    const retiring = operation.abandon().then(() => undefined, error => error)
    expect(operation.cleanup.observe().status).toBe('pending')
    expect(held.every(byte => byte === 0)).toBe(true)
    expect(() => owner!.check()).toThrow(/closed/)
    const rejected = await retiring
    if (nativeFailure) {
      const only = readAccountCleanupOnlyFailure(rejected)
      expect(only?.cleanup).toBe(operation.cleanup)
      expect(only?.result.status).toBe('failed')
      expect(nativeDeletes).toBe(1)
      expect(await database.stagedCipherChunks.get([record.payloadId, 0])).toBeDefined()
      expect((await operation.cleanup.request()).status).toBe('failed')
      expect(nativeDeletes).toBe(1)
      await coordinator.retryFailed([operation.cleanup])
      expect(nativeDeletes).toBe(2)
    } else expect(rejected).toBeUndefined()
    await iterator.return?.()
    expect(await database.stagedCipherChunks.get([record.payloadId, 0])).toBeUndefined()
    await expect(operation.prepare()).rejects.toThrow()
  } finally { vi.restoreAllMocks(); await operation.abandon(); invalidateProfile(); await database.delete() }
})

it('managed blank abandonment waits its inner producer without exposing a late handle', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const graph = await import('../workspace/account-graph')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { AccountDatabase } = await import('./account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token, cleanup)
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  const real = graph.stageAccountWorkspaceGraph
  vi.spyOn(graph, 'stageAccountWorkspaceGraph').mockImplementation(async (...args) => {
    const staged = await real(...args)
    reached.resolve()
    await resume.promise
    return staged
  })
  try {
    const preparing = operation.prepare().then(value => value, error => error)
    await reached.promise
    expect(await operation.prepare().then(value => value, error => error)).toBeInstanceOf(Error)
    let retired = false
    const abandoning = operation.abandon().then(() => { retired = true })
    expect(operation.cleanup.observe().status).toBe('pending')
    expect((await operation.cleanup.wait()).status).toBe('succeeded')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(retired).toBe(false)
    resume.resolve()
    const rejected = await preparing
    expect(rejected).toBeInstanceOf(Error)
    await abandoning
    expect(retired).toBe(true)
    expect(await database.stagedCipherChunks.count()).toBe(0)
    expect(await database.profileMeta.count()).toBe(0)
  } finally { resume.resolve(); vi.restoreAllMocks(); await operation.abandon(); invalidateProfile(); await database.delete() }
})

it('managed blank abandonment reports its failed first attempt after a lower-level retry', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const graph = await import('../workspace/account-graph')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token, coordinator.cleanup)
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  const real = graph.stageAccountWorkspaceGraph
  vi.spyOn(graph, 'stageAccountWorkspaceGraph').mockImplementation(async (...args) => {
    const staged = await real(...args)
    reached.resolve(); await resume.promise
    return staged
  })
  try {
    const preparing = operation.prepare().then(value => value, error => error)
    await reached.promise
    const target = (await database.stagedCipherChunks.toArray())[0].payloadId
    const original = IDBObjectStore.prototype.delete
    let nativeDeletes = 0
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = original.call(this, key)
      if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === target && ++nativeDeletes === 1) this.transaction.abort()
      return request
    })
    const abandoning = operation.abandon().then(() => undefined, error => error)
    const first = await operation.cleanup.wait()
    expect(first.status).toBe('failed')
    expect(nativeDeletes).toBe(1)
    await coordinator.retryFailed([operation.cleanup])
    expect(nativeDeletes).toBe(2)
    resume.resolve()
    expect(await preparing).toBeInstanceOf(Error)
    const rejected = await abandoning
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only?.cleanup).toBe(operation.cleanup)
    expect(only?.result.status).toBe('failed')
    expect(await database.stagedCipherChunks.count()).toBe(0)
  } finally { resume.resolve(); vi.restoreAllMocks(); await operation.abandon(); invalidateProfile(); await database.delete() }
})

it('managed blank abandonment retains the first native failure when a late reader also fails', async () => {
  const inactive = await import('../workspace/account-inactive-graph')
  const graph = await import('../workspace/account-graph')
  const streams = await import('../workspace/account-streams')
  const { AccountWorkspaceGraphReader } = await import('../workspace/account-graph-reader')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  let readers: import('../workspace/account-cleanup-attempt').AccountCleanupGroup | undefined
  const managed = { ...coordinator.cleanup, group(parts: readonly import('../workspace/account-cleanup-attempt').AccountCleanupJoin[]) {
    const group = coordinator.cleanup.group(parts)
    if (parts.length === 0) readers = group
    return group
  } }
  const operation = inactive.createBlankInactiveAccountWorkspacePreparation(database, token, managed)
  const lateOwner = createAccountPreparationOwner(database, token)
  const lateRecord = await stageAccountBytes(database, token, new Uint8Array([141, 142]), [], undefined, lateOwner)
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  const stage = graph.stageAccountWorkspaceGraph
  vi.spyOn(graph, 'stageAccountWorkspaceGraph').mockImplementation(async (...args) => {
    const staged = await stage(...args)
    reached.resolve(); await resume.promise
    return staged
  })
  let reader: InstanceType<typeof AccountWorkspaceGraphReader> | undefined
  const lateError = new Error('late native stream return failed')
  let nativeDeletes = 0, lateReturns = 0
  try {
    const preparing = operation.prepare().then(value => value, error => error)
    await reached.promise
    const target = (await database.stagedCipherChunks.toArray()).find(row => row.payloadId !== lateRecord.payloadId)!.payloadId
    const remove = IDBObjectStore.prototype.delete
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = remove.call(this, key)
      if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === target && ++nativeDeletes === 1) this.transaction.abort()
      return request
    })
    const abandoning = operation.abandon().then(() => undefined, error => error)
    const first = await operation.cleanup.wait()
    expect(first.status).toBe('failed')
    expect(nativeDeletes).toBe(1)
    await coordinator.retryFailed([operation.cleanup])
    expect(nativeDeletes).toBe(2)

    const open = streams.openAccountSource
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args)
      if (args[2].revisionId !== lateRecord.revisionId) return source
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          await input.return?.()
          if (lateReturns++ === 0) throw lateError
          return { done: true as const, value: undefined }
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    reader = new AccountWorkspaceGraphReader(database, token, lateOwner)
    const iterator = (await reader.source(cipherRef(lateRecord))).open()[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(new Uint8Array([141, 142]))
    readers!.include(coordinator.cleanup.reader(reader))
    resume.resolve()
    expect(await preparing).toBeInstanceOf(Error)
    const rejected = await abandoning
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only?.cleanup).toBe(operation.cleanup)
    expect(only?.result.status).toBe('failed')
    expect(only?.result.status === 'failed' ? only.result.errors[0] : undefined).toBe(first.status === 'failed' ? first.errors[0] : undefined)
    expect((rejected as AggregateError).errors[0]).toBe(first.status === 'failed' ? first.errors[0] : undefined)
    expect(lateReturns).toBeGreaterThan(0)
    const latest = await only!.cleanup.request()
    expect(latest.status).toBe('failed')
    expect(latest.status === 'failed' ? (latest.errors[0] as AggregateError).errors[0] : undefined).toBe(lateError)
    expect(await database.stagedCipherChunks.get([target, 0])).toBeUndefined()
    await coordinator.retryFailed([operation.cleanup])
  } finally { resume.resolve(); vi.restoreAllMocks(); await reader?.dispose().catch(() => {}); await lateOwner.abandon(); await operation.abandon().catch(() => {}); invalidateProfile(); await database.delete() }
})

it.each(['C-adoption', 'D-rebind'] as const)('managed %s retains the first post-transfer native cleanup failure', async route => {
  const f = await inactiveFixture()
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const evidence = await import('../workspace/account-evidence-snapshots')
  const graph = await import('../workspace/account-graph')
  const parent = createAccountPreparationOwner(f.database, f.token)
  const own = await stageAccountBytes(f.database, f.token, new Uint8Array([91, 92]), [], undefined, parent)
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const original = IDBObjectStore.prototype.delete
  let nativeDeletes = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === own.payloadId && ++nativeDeletes === 1) this.transaction.abort()
    return request
  })
  let candidate: Awaited<ReturnType<typeof completeInactiveCandidate>> | undefined
  let child: Awaited<ReturnType<ReturnType<typeof f.createAccountInheritedEvidencePreparation>['prepare']>> | undefined
  const primary = new Error(`post-transfer ${route} failed`)
  try {
    if (route === 'C-adoption') {
      child = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
      const open = evidence.openAccountInheritedEvidence
      vi.spyOn(evidence, 'openAccountInheritedEvidence').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (args[3] === parent) { await handle.check(); throw primary }
        return handle
      })
    } else {
      await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
      candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, false)
      await candidate.inherited.dispose()
      const authenticate = graph.authenticateAccountWorkspaceSubtree
      vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => {
        const result = await authenticate(...args)
        if (args[3]?.owner === parent) { await result.recheck(); throw primary }
        return result
      })
    }
    const rejected = await (route === 'C-adoption'
      ? f.inactive.adoptInactiveAccountEvidence(f.database, f.token, child!, parent, f.blank.opened, coordinator.cleanup)
      : f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate!.opened, parent, coordinator.cleanup)).then(value => value, error => error)
    const wrapped = readAccountPreparationFailure(rejected)
    expect(wrapped?.primary).toBe(primary)
    const first = await wrapped!.cleanup.request()
    expect(first.status).toBe('failed')
    expect(nativeDeletes).toBe(1)
    expect(await f.database.stagedCipherChunks.get([own.payloadId, 0])).toBeDefined()
    expect(await wrapped!.cleanup.request()).toEqual(first)
    expect(nativeDeletes).toBe(1)
    await coordinator.retryFailed([wrapped!.cleanup])
    expect(nativeDeletes).toBe(2)
    expect(await f.database.stagedCipherChunks.get([own.payloadId, 0])).toBeUndefined()
    await f.blank.opened.check()
  } finally { vi.restoreAllMocks(); await candidate?.dispose(); await child?.dispose(); await parent.abandon(); await f.close() }
})

it.each(['C-adoption', 'D-rebind'] as const)('managed %s leaves a busy child and staged parent separate before transfer', async route => {
  const f = await inactiveFixture()
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { stageAccountSource, openAccountSource } = await import('../workspace/account-streams')
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const parent = createAccountPreparationOwner(f.database, f.token)
  const parentRecord = await stageAccountBytes(f.database, f.token, new Uint8Array([101, 102]), [], undefined, parent)
  const parentIterator = (await openAccountSource(f.database, f.token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
  const parentBytes = (await parentIterator.next()).value as Uint8Array
  const coordinator = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  let candidate: Awaited<ReturnType<typeof completeInactiveCandidate>> | undefined
  let child: Awaited<ReturnType<ReturnType<typeof f.createAccountInheritedEvidencePreparation>['prepare']>> | undefined
  try {
    if (route === 'C-adoption') child = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({})
    else {
      await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
      candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, false)
      await candidate.inherited.dispose()
    }
    const childOwner = child?.owner ?? candidate!.owner
    const staging = stageAccountSource(f.database, f.token, { byteLength: 2, async *open() {
      yield new Uint8Array([1]); reached.resolve(); await resume.promise; yield new Uint8Array([2])
    } }, [], undefined, undefined, childOwner).then(value => value, error => error)
    await reached.promise
    const rejected = await (route === 'C-adoption'
      ? f.inactive.adoptInactiveAccountEvidence(f.database, f.token, child!, parent, f.blank.opened, coordinator.cleanup)
      : f.inactive.rebindInactiveAccountWorkspace(f.database, f.token, candidate!.opened, parent, coordinator.cleanup)).then(value => value, error => error)
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toMatch(/busy/)
    expect(coordinator.cleanup.owner(parent).observe().status).toBe('not-started')
    expect(parentBytes).toEqual(new Uint8Array([101, 102]))
    expect(() => parent.check()).not.toThrow()
    const another = await stageAccountBytes(f.database, f.token, new Uint8Array([103]), [], undefined, parent)
    expect(await f.database.stagedCipherChunks.get([another.payloadId, 0])).toBeDefined()
    await f.blank.opened.check()
    resume.resolve()
    expect(await staging).toHaveProperty('payloadId')
  } finally { resume.resolve(); await parentIterator.return?.(); await candidate?.dispose(); await child?.dispose(); await parent.abandon(); await f.close() }
})

it('managed C adoption propagates a real child reader cleanup failure before parent transfer', async () => {
  const f = await inactiveFixture()
  const { completeInactiveCandidate } = await import('./account-inactive-test-helpers')
  const evidence = await import('../workspace/account-evidence-snapshots')
  const streams = await import('../workspace/account-streams')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  await f.database.encryptedRevisions.bulkAdd([...f.blank.records])
  const candidate = await completeInactiveCandidate(f.database, f.token, f.blank.opened, true)
  const parent = createAccountPreparationOwner(f.database, f.token)
  const parentRecord = await stageAccountBytes(f.database, f.token, new Uint8Array([111, 112]), [], undefined, parent)
  const parentIterator = (await streams.openAccountSource(f.database, f.token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
  const parentBytes = (await parentIterator.next()).value as Uint8Array
  const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  let child: Awaited<ReturnType<ReturnType<typeof f.createAccountInheritedEvidencePreparation>['prepare']>> | undefined
  let iterator: AsyncIterator<Uint8Array> | undefined
  const cleanupError = new Error('native child stream return failed')
  let join: import('../workspace/account-cleanup-attempt').AccountCleanupJoin | undefined
  try {
    child = await f.createAccountInheritedEvidencePreparation(f.database, f.token).prepare({ base: candidate.inherited })
    await child.handle.dispose()
    const opened = await evidence.openAccountInheritedEvidence(f.database, f.token, child.root, child.owner, { ...cleanup, reader(raw) {
      join = cleanup.reader(raw)
      return join
    } })
    const sources = await evidence.accountInheritedSources(opened)
    const real = streams.openAccountSource
    let failedReturns = 0
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await real(...args)
      if (args[3] !== child!.owner) return source
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          await input.return?.()
          if (failedReturns++ === 0) throw cleanupError
          return { done: true as const, value: undefined }
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    iterator = sources.bodies[0].content.open()[Symbol.asyncIterator]()
    const held = (await iterator.next()).value as Uint8Array
    expect(held.some(byte => byte !== 0)).toBe(true)
    const rejected = await f.inactive.adoptInactiveAccountEvidence(f.database, f.token, { ...child, handle: opened }, parent, f.blank.opened, cleanup).then(value => value, error => error)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only?.cleanup).toBe(join)
    expect(only?.result.status).toBe('failed')
    expect(only?.result.status === 'failed' ? (only.result.errors[0] as AggregateError).errors[0] : undefined).toBe(cleanupError)
    expect(failedReturns).toBeGreaterThan(0)
    expect(held.every(byte => byte === 0)).toBe(true)
    expect(parentBytes).toEqual(new Uint8Array([111, 112]))
    expect(cleanup.owner(parent).observe().status).toBe('not-started')
    expect(() => parent.check()).not.toThrow()
    const later = await stageAccountBytes(f.database, f.token, new Uint8Array([113]), [], undefined, parent)
    expect(await f.database.stagedCipherChunks.get([later.payloadId, 0])).toBeDefined()
  } finally { vi.restoreAllMocks(); await iterator?.return?.().catch(() => {}); await parentIterator.return?.(); await child?.dispose(); await candidate.dispose(); await parent.abandon(); await f.close() }
})

it('managed D preparation retains a late authenticated reader after the first failed retirement', async () => {
  const f = await inactiveFixture()
  const graph = await import('../workspace/account-graph')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { createAccountCleanupCoordinator, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const owner = createAccountPreparationOwner(f.database, f.token)
  const marker = await stageAccountBytes(f.database, f.token, new Uint8Array([121]), [], undefined, owner)
  const { cleanup } = createAccountCleanupCoordinator(f.database, f.token, async () => {})
  const ownerJoin = cleanup.owner(owner)
  let operationGroup: import('../workspace/account-cleanup-attempt').AccountCleanupGroup | undefined
  const managed = { ...cleanup, group(parts: readonly import('../workspace/account-cleanup-attempt').AccountCleanupJoin[]) {
    const group = cleanup.group(parts)
    if (parts.includes(ownerJoin)) operationGroup = group
    return group
  } }
  const reached = cleanupBarrier(), resume = cleanupBarrier()
  const authenticate = graph.authenticateAccountWorkspaceSubtree
  vi.spyOn(graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => {
    const value = await authenticate(...args)
    if (args[3]?.owner === owner) { reached.resolve(); await resume.promise }
    return value
  })
  const original = IDBObjectStore.prototype.delete
  let nativeDeletes = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === marker.payloadId && ++nativeDeletes === 1) this.transaction.abort()
    return request
  })
  try {
    const preparing = f.inactive.prepareInactiveAccountWorkspace(f.database, f.token, f.blank.opened.workspace.state, { owner, sourceOrigin: f.blank.opened, rootFormat: 'preserve', cleanup: managed }).then(value => value, error => error)
    await reached.promise
    const first = await operationGroup!.request()
    expect(first.status).toBe('failed')
    expect(nativeDeletes).toBe(1)
    resume.resolve()
    const rejected = await preparing
    const wrapped = readAccountPreparationFailure(rejected)
    expect(wrapped?.cleanup).toBe(operationGroup)
    expect(await operationGroup!.request()).toEqual(first)
    expect(nativeDeletes).toBe(1)
    expect(await f.database.stagedCipherChunks.get([marker.payloadId, 0])).toBeDefined()
    await f.blank.opened.check()
  } finally { resume.resolve(); vi.restoreAllMocks(); await owner.abandon(); await f.close() }
})
