import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace, openAccountWorkspace } from '../workspace/account-graph'
import { archiveWorkspaceUnit } from '../workspace/pending-content'
import { privateRecordKey, type WorkspaceState } from '../workspace/documents'
import { inspectWorkspaceClosure, WorkspaceUnitIndexSchema } from '../workspace/closure'
import { blobIdentity, memoryBlob, readBlob } from '../workspace/blobs'
import * as codec from '../workspace/catalog-codec'

it('keeps original pin frames and distinct full catalog artifacts inspectable without package resolution', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData(), catalog = BUNDLED_CATALOGS[0]
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true }] }, blobs: [] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const opened = await openAccountWorkspace(database, token, prepared.head)
    const key = privateRecordKey('catalog', catalog.id, catalog.revisionId), original = opened.entries.find(entry => entry.key === key)!
    const output = new Map<string, WorkspaceState['blobs'][number]>()
    const started = performance.now(), closure = await archiveWorkspaceUnit(opened, key, output)
    const evidence = output.get(blobIdentity(original.ref))!
    const originalBytes = await readBlob(opened.payloads.get(key)!, 4096)
    expect(await readBlob(evidence.content, 4096)).toEqual(originalBytes)
    const portable: WorkspaceState = { ...state, planner: { ...state.planner, catalogs: [] }, blobs: [...output.values()] }
    const resolver = vi.spyOn(codec, 'decodeCatalogPayload').mockImplementation(() => { throw new Error('No packaged snapshot exists at destination') })
    const inspected = await inspectWorkspaceClosure(portable, closure)
    expect(inspected.root.kind).toBe('catalog')
    expect(inspected.root.ref.documentId).not.toBe(original.ref.documentId)
    expect(inspected.value).toEqual(catalog)
    expect(resolver).not.toHaveBeenCalled()
    const full = output.get(blobIdentity(inspected.root.ref))!
    expect(full.ref.byteLength).toBeGreaterThan(evidence.ref.byteLength)
    const relationBlob = [...output.values()].find(blob => blob !== evidence && blob.ref.byteLength < 4096 && blob.ref.documentId !== closure.index.documentId && blob.ref.documentId !== closure.root.documentId)!
    const relation = WorkspaceUnitIndexSchema.parse(JSON.parse(new TextDecoder().decode(await readBlob(relationBlob.content, 4096))))
    expect(relation.relation.kind).toBe('catalog-expansion')
    const changed = { ...relation, relation: { ...relation.relation, checksum: 'different' } }
    await expect(inspectWorkspaceClosure({ ...portable, blobs: portable.blobs.map(blob => blob === relationBlob ? { ...blob, content: memoryBlob(new TextEncoder().encode(JSON.stringify(changed))) } : blob) }, closure)).rejects.toThrow('association')
    const count = output.size
    await archiveWorkspaceUnit(opened, key, output)
    expect(output.get(blobIdentity(full.ref))).toBe(full)
    expect(output.size).toBeGreaterThan(count)
    const dependent = await archiveWorkspaceUnit(opened, privateRecordKey('library-defaults'), output)
    const domain = await import('../workspace/domain-closure')
    const domainInspection = vi.spyOn(domain, 'resolvedDomainClosureKeys')
    const dependentResult = await inspectWorkspaceClosure({ ...portable, blobs: [...output.values()] }, dependent)
    expect(dependentResult.root.key).toBe(privateRecordKey('library-defaults'))
    expect(domainInspection.mock.calls.filter(([document]) => document.kind === 'catalog')).toHaveLength(1)
    domainInspection.mockRestore()
    expect(dependentResult.refs.has(blobIdentity(evidence.ref))).toBe(true)
    expect(dependentResult.refs.has(blobIdentity(full.ref))).toBe(true)
    const contradictory = new Map(output).set(blobIdentity(full.ref), { ...full, ref: { ...full.ref, sha256: '0'.repeat(64) } })
    await expect(archiveWorkspaceUnit(opened, key, contradictory)).rejects.toThrow('Contradictory archived body identity')
    console.info(JSON.stringify({ proof: 'catalog-pin-portability', originalFrameBytes: evidence.ref.byteLength, fullCatalogBytes: full.ref.byteLength, elapsedMs: Math.round(performance.now() - started) }))
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('closes unavailable effective catalogs with their exact owning setup evidence', async () => {
  const { createTestLocalData } = await import('../domain/test-helpers')
  const { modCatalogRevision } = await import('../domain/mod-layers')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const blank = createBlankLocalData(), base = Object.values(createTestLocalData().gameSetups)[0], catalog = BUNDLED_CATALOGS[0]
    const checksum = `sha256:${'a'.repeat(64)}`
    const receipt = { catalogId: 'crystal-edit:missing', catalogRevisionId: `${checksum}:rules-v1:library-v1`, checksum, title: 'Recorded missing source' }
    const setup = { ...base, catalogLock: { [catalog.id]: modCatalogRevision(base.id) }, modComposition: { baseline: { catalogId: catalog.id, catalogRevisionId: catalog.revisionId }, layers: [{ catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId, enabled: true }], links: [] }, modSourceReceipts: [receipt] } as unknown as typeof base
    const copy = { ...setup, id: 'copied-setup' as typeof setup.id }
    const localData = { ...blank, gameSetups: { [setup.id]: setup, [copy.id]: copy } }
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
    const prepared = await prepareAccountWorkspace(database, token, state)
    const output = new Map<string, WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(prepared.opened, privateRecordKey('setup', copy.id), output)
    const portable = { ...state, planner: { ...state.planner, localData: blank, catalogs: [] }, blobs: [...output.values()] }
    invalidateProfile()
    const inspected = await inspectWorkspaceClosure(portable, closure)
    expect(inspected.value).toEqual(copy)
    expect(inspected.refs.has(blobIdentity(prepared.entries.find(entry => entry.key === privateRecordKey('setup', setup.id))!.ref))).toBe(true)
    const origin = prepared.entries.find(entry => entry.key === privateRecordKey('setup', setup.id))!
    await expect(inspectWorkspaceClosure({ ...portable, blobs: portable.blobs.filter(blob => blobIdentity(blob.ref) !== blobIdentity(origin.ref)) }, closure)).rejects.toThrow('Missing')
    expect([...output.values()].some(blob => blob.ref.documentId.includes(receipt.catalogId))).toBe(false)
  } finally { invalidateProfile(); await database.delete() }
})
