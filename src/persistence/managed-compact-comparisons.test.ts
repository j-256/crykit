import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { conflictService } from './sync-conflict-fixture'
import { createGuestCopyService } from '../workspace/guest-copy'
import { ownWorkspaceSnapshot, validateWorkspaceSnapshot } from '../workspace/snapshot'
import { captureCompactCatalogSnapshot } from '../workspace/catalog-capture'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { SYNTHETIC_PACKAGED_CATALOG } from '../workspace/catalog-writer.test-helpers'
import { now, progress } from '../workspace/signin-merge.test-helpers'
import { editorClosureFixture } from '../workspace/test-helpers'
import { blobIdentity, hashBlob, memoryBlob } from '../workspace/blobs'
import { inspectWorkspaceClosure, validateWorkspaceClosure } from '../workspace/closure'
import * as compact from '../workspace/catalog-writer-capability'
import { capturedBackupEvidence, historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup'
import { openAccountInheritedEvidence, accountInheritedSources } from '../workspace/account-evidence-snapshots'
import * as comparisons from '../workspace/managed-copy-comparisons'

// Comparison originals deliberately repeat full legacy metadata, independent of catalog scale
// Declare this bounded source without changing production membership or skipping physical admission
vi.mock('../catalog/bundled', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/bundled')>()
  const { SYNTHETIC_PACKAGED_CATALOG } = await import('../workspace/catalog-writer.test-helpers')
  return { ...actual, BUNDLED_CATALOGS: Object.freeze([...actual.BUNDLED_CATALOGS, SYNTHETIC_PACKAGED_CATALOG]) }
})

let service: Awaited<ReturnType<typeof conflictService>> | undefined
afterEach(async () => { await service?.dispose(); service = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each([false, true])('publishes saved editor and Progress originals after producer disposal with compact=%s', async enabled => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', enabled)
  vi.spyOn(compact, 'compactCatalogWritersEnabled').mockReturnValue(enabled)
  vi.spyOn(comparisons, 'managedComparisonWritesEnabled').mockReturnValue(true)
  expect(BUNDLED_CATALOGS).toContain(CURRENT_CATALOG)
  expect(BUNDLED_CATALOGS).toContain(SYNTHETIC_PACKAGED_CATALOG)
  const fixture = await editorClosureFixture()
  const source = { ...progress('local', false), editorDocuments: [fixture.file], blobs: fixture.blobs }
  const content = memoryBlob(new Uint8Array([1, 216]))
  const draft = { ...fixture.file.unfinished.text, revisionId: 'account-draft', byteLength: content.byteLength, sha256: await hashBlob(content) }
  const destination = { ...progress('account'), editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, text: draft } }], blobs: [...fixture.blobs, { ref: draft, content }] }
  for (const state of [source, destination]) {
    state.planner = { ...state.planner, catalogs: [SYNTHETIC_PACKAGED_CATALOG] }
    state.libraryDefaults = { version: 1, layers: [{ catalogId: SYNTHETIC_PACKAGED_CATALOG.id, catalogRevisionId: SYNTHETIC_PACKAGED_CATALOG.revisionId, enabled: true }] }
  }
  let collision: { native: import('../workspace/documents').WorkspaceBlobRef; catalog: import('../workspace/documents').WorkspaceBlobRef } | undefined
  if (enabled) {
    const snapshot = () => ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'role-collision', capturedAt: now, revisionVector: {}, state: source }, { async check() {}, async dispose() {} })
    const catalog = capturedBackupEvidence(await captureCompactCatalogSnapshot(snapshot())).catalogBodies![0].ref
    const content = memoryBlob(new Uint8Array([91, 92]))
    const native = { documentId: catalog.documentId, revisionId: catalog.revisionId, byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
    source.saveDocuments = [{ version: 1, id: 'opaque-role-collision', revision: 0, filename: 'synthetic.dat', original: native, working: native, pendingForm: {}, requirements: [], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: now, updatedAt: now, exportedRevision: null }]
    source.blobs = [...source.blobs, { ref: native, content }]
    const admitted = await captureCompactCatalogSnapshot(snapshot())
    expect(admitted.version).toBe(3)
    await validateWorkspaceSnapshot(admitted)
    expect(blobIdentity(native)).toBe(blobIdentity(catalog))
    expect(native.sha256).not.toBe(catalog.sha256)
    collision = { native, catalog }
  }
  service = await conflictService()
  const device = await service.device(0, destination)
  await device.settle()
  const original = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'compact-comparison', capturedAt: now, revisionVector: {}, state: source }, { async check() {}, async dispose() {} })
  const originalIdentity = await historicalMetadataIdentity(capturedBackupEvidence(original).current)
  const inherited = await inheritWorkspaceSnapshot(original, [original])
  const copy = createGuestCopyService(async () => inherited)
  try {
    const preview = await copy.previewSigninMerge(device.token)
    expect(preview.conflicts).toContain('["progress","play","account"]')
    expect(preview.conflicts).toContain(`["editor",${JSON.stringify(fixture.file.id)}]`)
    await copy.commitGuestCopy(device.token, preview)
    await copy.dispose()
    if (enabled) {
      const { prepareManagedSync } = await import('./managed-sync.test-helpers')
      const { openAccountJson } = await import('../workspace/account-cache')
      const { IncrementalWorkspaceIntentSchema } = await import('../workspace/account-mapping-origin')
      const copied = await import('../workspace/copied-conflicts')
      const row = (await device.db.outbox.toArray())[0]
      const intent = await openAccountJson(device.db, device.token, row.ref, IncrementalWorkspaceIntentSchema)
      if (intent.version !== 2) throw new Error('Expected saved comparison intent')
      const descriptor = (await device.db.encryptedRevisions.get(intent.copiedComparisons.revisionId))!
      const chunk = (await device.db.stagedCipherChunks.get([descriptor.payloadId, 0]))!
      const selected = await device.db.profileMeta.get('active'), beforeOutbox = await device.db.outbox.toArray()
      const prepare = copied.prepareManagedCopiedConflicts
      let changed = false
      const fault = vi.spyOn(copied, 'prepareManagedCopiedConflicts').mockImplementationOnce(async (...args) => {
        const value = await prepare(...args), bytes = chunk.bytes.slice(); bytes[0] ^= 1
        await device.db.stagedCipherChunks.put({ ...chunk, bytes }); changed = true
        return value
      })
      try {
        await expect(prepareManagedSync(device.db, device.token)).rejects.toThrow()
        expect(changed).toBe(true)
        expect(await device.db.profileMeta.get('active')).toEqual(selected)
        expect(await device.db.outbox.toArray()).toEqual(beforeOutbox)
      } finally { fault.mockRestore(); await device.db.stagedCipherChunks.put(chunk) }
    }
    await device.settle()
    expect(await device.db.outbox.count()).toBe(0)
    const native = await device.native(), state = native.state
    const evidence = await openAccountInheritedEvidence(device.db, device.token, native.inheritedEvidence!)
    try {
      const retained = (await accountInheritedSources(evidence)).members.find(member => member.id === originalIdentity.id)!
      expect(retained.format ?? 'legacy-v1').toBe('legacy-v1')
      expect(await historicalMetadataIdentity(retained.metadata)).toEqual(originalIdentity)
    } finally { await evidence.dispose() }
    const conflict = state.conflicts.find(value => value.unit.privateKey === '["progress","play","account"]')!
    expect(conflict.progressIdentity).toMatchObject(enabled ? { version: 2, sourceFormat: 'compact-v2' } : { version: 1 })
    if (enabled) expect(conflict.progressIdentity?.version === 2 ? conflict.progressIdentity.catalogBodies.length : 0).toBeGreaterThan(0)
    if (collision) {
      const identity = conflict.progressIdentity
      if (identity?.version !== 2) throw new Error('Expected compact original binding')
      expect(state.saveDocuments.find(file => file.id === 'opaque-role-collision')?.original).toEqual(collision.native)
      const binding = identity.catalogBodies.find(binding => binding.source.documentId === collision.catalog.documentId)!
      expect(binding.source).toEqual(collision.catalog)
      const { WorkspaceConflictSchema } = await import('../workspace/file-schemas')
      expect(WorkspaceConflictSchema.safeParse({ ...conflict, progressIdentity: { ...identity, catalogBodies: identity.catalogBodies.map(binding => binding.source) } }).success).toBe(false)
      expect(blobIdentity(binding.retained)).not.toBe(blobIdentity(collision.native))
      expect(await hashBlob(state.blobs.find(body => blobIdentity(body.ref) === blobIdentity(collision.native))!.content)).toBe(collision.native.sha256)
      expect(await hashBlob(state.blobs.find(body => blobIdentity(body.ref) === blobIdentity(binding.retained))!.content)).toBe(collision.catalog.sha256)
    }
    await validateWorkspaceClosure(state)
    const originals = await Promise.all(state.blobs.map(async body => [blobIdentity(body.ref), await hashBlob(body.content)]))
    for (const comparison of state.conflicts) for (const branch of comparison.branches) await inspectWorkspaceClosure(state, branch.closure)
    const { publicationDocuments } = await import('../workspace/closure')
    const published = new Set((await publicationDocuments(state)).filter(document => document.kind === 'blob').map(document => (JSON.parse(document.key) as string[])[1]))
    // Pending save wrappers are local operational receipts, unlike file originals and comparisons
    // Independently constrain every omission so the production projection cannot hide data loss
    const localSaveWrappers = new Set(state.retainedContent.flatMap(retained => retained.kind === 'pending-content' && retained.unit.privateKey === '["save","opaque-role-collision"]' ? [blobIdentity(retained.target.root), blobIdentity(retained.target.index)] : []))
    for (const body of state.blobs) if (!published.has(blobIdentity(body.ref))) expect(localSaveWrappers.has(blobIdentity(body.ref))).toBe(true)
    const other = await service.device(1)
    await other.settle()
    const reopened = (await other.native()).state
    expect(reopened.conflicts).toEqual(state.conflicts)
    expect(reopened.saveDocuments).toEqual(state.saveDocuments)
    expect(await Promise.all(reopened.blobs.map(async body => [blobIdentity(body.ref), await hashBlob(body.content)]))).toEqual(originals.filter(([key]) => published.has(key)))
    await validateWorkspaceClosure(reopened)
  } finally { await copy.dispose() }
}, 60_000)
