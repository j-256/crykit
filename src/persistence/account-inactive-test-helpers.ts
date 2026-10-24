import { expect } from 'vitest'
import type { ProfileToken } from '../account/profile'
import type { AccountDatabase } from './account-database'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup'
import { capturedBackupEvidence } from '../interchange/workspace-backup-evidence'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import { editorClosureFixture, multiPageMetadataText } from '../workspace/test-helpers'
import { memoryBlob, hashBlob, readBlob } from '../workspace/blobs'
import { createAccountPreparationOwner } from '../workspace/account-prepared-records'
import { createAccountInheritedEvidencePreparation } from '../workspace/account-evidence-snapshots'
import { adoptInactiveAccountEvidence, prepareInactiveAccountWorkspace, inactiveAccountInheritedSources, type InactiveAccountWorkspace } from '../workspace/account-inactive-graph'
import type { BlobSource } from '../workspace/documents'

export async function exactAccountTables(database: AccountDatabase) {
  return Object.fromEntries(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()])))
}

export async function metadataPages(source: BlobSource) {
  const pages: Uint8Array[] = []
  // Decrypted pages are zeroed when their reader advances, so receipts must own their bytes
  for await (const page of source.open()) pages.push(page.slice())
  return pages
}

// Every selector candidate comes from real captured provenance and real encrypted C and D producers
export async function completeInactiveCandidate(database: AccountDatabase, token: ProfileToken, source: InactiveAccountWorkspace, nonempty: boolean, { segmentedMetadata = false }: { segmentedMetadata?: boolean } = {}) {
  const owner = createAccountPreparationOwner(database, token)
  const fixture = await editorClosureFixture()
  const bytes = new TextEncoder().encode('synthetic-private-historical-native')
  const content = memoryBlob(bytes), sha256 = await hashBlob(content)
  const body = { ref: { documentId: 'history-only-native', revisionId: 'original:1', encoding: 'bytes' as const, byteLength: bytes.length, sha256 }, content }
  // Fault matrices need exact nonempty history, not the payload-size cross-product
  // Dedicated transfer and admission cases opt into real segmented metadata
  const metadata = 'synthetic-private-metadata\ud800'
  const historical = { version: 1 as const, snapshotId: 'synthetic-private-history', capturedAt: '2026-10-13', revisionVector: {}, state: { ...fixture.state, blobs: [body, ...fixture.state.blobs], editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: segmentedMetadata ? multiPageMetadataText(metadata) : metadata } } }] } }
  const current = { ...historical, snapshotId: 'synthetic-current', state: source.workspace.state }
  const snapshot = nonempty ? await inheritWorkspaceSnapshot(current, [historical]) : undefined
  const pages = snapshot ? await metadataPages([...capturedBackupEvidence(snapshot).historical.values()][0]) : []
  const operation = createAccountInheritedEvidencePreparation(database, token)
  const evidence = await operation.prepare(snapshot ? { additions: [snapshot] } : {})
  const inherited = await adoptInactiveAccountEvidence(database, token, evidence, owner, source)
  const prepared = await prepareInactiveAccountWorkspace(database, token, current.state, { owner, sourceOrigin: source, inheritedEvidence: inherited, rootFormat: 'upgrade-v2' })
  const records = [...evidence.records, ...prepared.records]
  expect(new Set(records.map(record => record.revisionId)).size).toBe(records.length)
  async function assertContents(opened: InactiveAccountWorkspace) {
    await opened.check()
    expect(opened.version).toBe(2)
    const sources = await inactiveAccountInheritedSources(opened)
    expect(sources.members).toHaveLength(nonempty ? 1 : 0)
    if (nonempty) {
      if (segmentedMetadata) expect(pages.length).toBeGreaterThan(1)
      else expect(pages).toHaveLength(1)
      expect(await metadataPages(sources.members[0].metadata)).toEqual(pages)
      expect(sources.members[0].subset).toEqual(historical.state.blobs.map(value => value.ref))
      expect(await readBlob(sources.bodies.find(value => value.ref.documentId === body.ref.documentId)!.content, bytes.length)).toEqual(bytes)
      expect(opened.workspace.state.blobs.some(value => value.ref.documentId === body.ref.documentId)).toBe(false)
    }
  }
  await assertContents(prepared.opened)
  return { ...prepared, records, evidence, inherited, assertContents, async dispose() {
    await prepared.opened.dispose(); await inherited.dispose(); await owner.abandon(); await operation.abandon()
    if (snapshot) await disposeWorkspaceSnapshot(snapshot)
  } }
}
