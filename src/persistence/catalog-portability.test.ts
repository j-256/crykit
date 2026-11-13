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
import { inspectWorkspaceClosure } from '../workspace/closure'
import { blobIdentity, readBlob } from '../workspace/blobs'
import { decodeWorkspaceDocument } from '../workspace/document-codec'
import * as codec from '../workspace/catalog-codec'

it('keeps complete catalog bodies inspectable without expanding package-only pins', async () => {
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
    const originalBytes = new TextEncoder().encode(JSON.stringify((await decodeWorkspaceDocument(opened.payloads.get(key)!)).value))
    expect(await readBlob(evidence.content, evidence.ref.byteLength)).toEqual(originalBytes)
    const portable: WorkspaceState = { ...state, planner: { ...state.planner, catalogs: [] }, blobs: [...output.values()] }
    const decoder = vi.spyOn(codec, 'decodeCatalogPayload')
    const inspected = await inspectWorkspaceClosure(portable, closure)
    expect(inspected.root.kind).toBe('catalog')
    expect(inspected.root.ref.documentId).toBe(original.ref.documentId)
    expect(inspected.root.ref.revisionId).toBe(original.ref.revisionId)
    expect(inspected.value).toEqual(catalog)
    expect(decoder).toHaveBeenCalled()
    const full = output.get(blobIdentity(inspected.root.ref))!
    expect(full).toBe(evidence)
    const encoded = JSON.parse(new TextDecoder().decode(originalBytes))
    expect(encoded.kind).toBe('compressed-catalog-snapshot')
    expect(encoded.pages.length).toBeGreaterThan(0)
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
    console.info(JSON.stringify({ proof: 'complete-catalog-portability', originalFrameBytes: evidence.ref.byteLength, fullCatalogBytes: full.ref.byteLength, elapsedMs: Math.round(performance.now() - started) }))
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('rejects private compositions with missing exact source bodies before activation', async () => {
  const { createTestLocalData } = await import('../domain/test-helpers')
  const { modCatalogRevision } = await import('../domain/mod-layers')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const blank = createBlankLocalData(), base = Object.values(createTestLocalData().gameSetups)[0], catalog = BUNDLED_CATALOGS[0]
    const { previewCrystalEdit } = await import('../interchange/crystal-edit')
    const source = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'missing-portable', EditorVersion: 34, Items: [] })), 'missing.json')).proposed.catalogs[0]!
    const receipt = { catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, contentFingerprint: (source.legacy as Record<string, string>).contentFingerprint!, title: 'Recorded missing source' }
    const setup = { ...base, catalogLock: { [catalog.id]: modCatalogRevision(base.id) }, modComposition: { baseline: { catalogId: catalog.id, catalogRevisionId: catalog.revisionId }, layers: [{ catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId, enabled: true }], links: [] }, modSourceReceipts: [receipt] } as unknown as typeof base
    const copy = { ...setup, id: 'copied-setup' as typeof setup.id }
    const localData = { ...blank, gameSetups: { [setup.id]: setup, [copy.id]: copy } }
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
    await expect(prepareAccountWorkspace(database, token, state)).rejects.toThrow('unavailable catalog revision')
    expect(await database.profileMeta.get('active')).toBeUndefined()
    expect(await database.encryptedRevisions.count()).toBe(0)
  } finally { invalidateProfile(); await database.delete() }
})
