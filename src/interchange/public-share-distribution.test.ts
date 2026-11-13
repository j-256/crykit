import { expect, it, vi } from 'vitest'
import type { BundledSourceRevisionReceipt } from '../catalog/source-revisions'
import { addTestBuild, createTestLocalData } from '../domain/test-helpers'
import type { CatalogSnapshot } from '../domain/types'
import type { WorkspaceState } from '../workspace/documents'
import { previewCrystalEdit } from './crystal-edit'
import { createPublicSnapshot } from './public-share'
import { enrichPublicSnapshot } from './public-share-enrichment'

// A synthetic future bundle has an explicit trusted release receipt, just as shipped distributions require
const trust = vi.hoisted(() => ({ receipts: [] as BundledSourceRevisionReceipt[] }))
vi.mock('../catalog/source-revisions', async importOriginal => {
  const original = await importOriginal<typeof import('../catalog/source-revisions')>()
  trust.receipts.push(...original.SOURCE_REVISION_RECEIPTS)
  return { ...original, SOURCE_REVISION_RECEIPTS: trust.receipts }
})

it('fulfills public exact pins across distributions without originals, substitutions, or receipt changes', async () => {
  const imported = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'Synthetic future distribution', EditorVersion: 34, Equipment: [{ ID: 3, Name: 'Selected synthetic item', EquipmentType: 0 }] })), 'PRIVATE_ORIGINAL.json')).proposed.catalogs[0]!
  const receipt: BundledSourceRevisionReceipt = { id: 'crystal-project/mod/synthetic-future' as CatalogSnapshot['id'], revisionId: 'v1' as CatalogSnapshot['revisionId'], checksum: imported.checksum, payloadSource: { catalogId: imported.id, catalogRevisionId: imported.revisionId } }
  trust.receipts.push(receipt)
  try {
    const bundled: CatalogSnapshot = { ...imported, id: receipt.id as CatalogSnapshot['id'], revisionId: receipt.revisionId as CatalogSnapshot['revisionId'], payloadSource: { catalogId: imported.id, catalogRevisionId: imported.revisionId } }
    for (const [requested, supplied] of [[imported, bundled], [bundled, imported]]) {
      const entity = Object.values(requested!.entities)[0]!
      const ref = { kind: 'catalog' as const, catalogId: requested!.id, catalogRevisionId: requested!.revisionId, entityId: entity.id }
      const localData = addTestBuild(createTestLocalData(), 'synthetic-share', '', { hand: { ref } }, { catalogLock: { [requested!.id]: requested!.revisionId } })
      const snapshot = createPublicSnapshot({ planner: { localData, catalogs: [requested!] } }, { kind: 'build', revisionId: 'synthetic-share-revision' as never }, { includeNotes: false })
      const viewer: WorkspaceState = { planner: { localData: createTestLocalData(), catalogs: [supplied!], sources: [], evidence: [], history: [], lineage: { rootLocalDataId: localData.id } }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
      const before = structuredClone(snapshot), result = enrichPublicSnapshot(snapshot, viewer)
      expect(result.resolved).toBe(true)
      expect(result.entries[0]?.definition).toEqual(entity)
      expect(result.entries[0]?.viewerRef).toEqual(ref)
      expect(snapshot).toEqual(before)
      const forged = { ...supplied!, entities: { [entity.id]: { ...entity, name: 'Changed body' } } }
      expect(enrichPublicSnapshot(snapshot, { ...viewer, planner: { ...viewer.planner, catalogs: [forged] } }).resolved).toBe(false)
    }
  } finally { trust.receipts.pop() }
})
