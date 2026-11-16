import { expect, it } from 'vitest'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { historicalMetadataIdentity, metadataSource } from '../interchange/workspace-backup-evidence'
import { validateSigninProgressIdentity } from './signin-progress-evidence'
import { snapshotMetadata } from './snapshot'
import { splitWorkspace, type WorkspaceConflict, type WorkspaceBlobRef } from './documents'
import { editorClosureFixture } from './test-helpers'
import { progress, now } from './signin-merge.test-helpers'
import { projectSigninProgress, signinProgressCorrespondence } from './signin-progress'

it.each(['complete', 'missing', 'contradictory'] as const)('checks complete original metadata references without granting body access: %s', async kind => {
  const fixture = await editorClosureFixture(), destination = progress('account')
  const source = { ...progress('local', false), editorDocuments: [fixture.file], blobs: fixture.blobs }
  const metadata = snapshotMetadata({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'progress-with-editor', capturedAt: now, revisionVector: {}, state: source })
  if (kind === 'missing') metadata.state.blobs = metadata.state.blobs.filter(ref => ref.documentId !== fixture.file.original.documentId)
  if (kind === 'contradictory') metadata.state.blobs = metadata.state.blobs.map(ref => ref.documentId === fixture.file.original.documentId ? { ...ref, sha256: '0'.repeat(64) } : ref)
  const content = metadataSource(metadata), identity = await historicalMetadataIdentity(content)
  const ref: WorkspaceBlobRef = { documentId: 'metadata', revisionId: 'original', encoding: 'bytes', byteLength: content.byteLength, sha256: identity.metadataStreamDigest }
  const mapping = signinProgressCorrespondence(source, destination).mappings[0]
  const conflict = { unit: { kind: 'record', privateKey: mapping.destinationKey }, progressIdentity: { version: 1, sourceKey: mapping.sourceKey, destinationKey: mapping.destinationKey, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest, sourceMetadata: ref } } as WorkspaceConflict
  const pending = new Map(splitWorkspace(projectSigninProgress(source, destination, mapping)).map(document => [document.key, document]))
  const accepted = new Map(splitWorkspace(destination).map(document => [document.key, document]))
  const check = validateSigninProgressIdentity({ ...destination, blobs: [{ ref, content }] }, conflict, pending, accepted)
  if (kind === 'complete') await expect(check).resolves.toBeUndefined()
  else await expect(check).rejects.toThrow('Missing or contradictory blob reference')
})

it.each(['complete', 'missing-catalog', 'changed-catalog', 'late-catalog-failure', 'duplicate-catalog', 'wrong-format', 'changed-source', 'changed-retained', 'changed-encoding', 'unbound-v2'] as const)('validates compact Progress metadata with inert unrelated native originals: %s', async kind => {
  const { vi } = await import('vitest')
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  try {
    const { GUIDE_CATALOG } = await import('../catalog/bundled')
    const { captureCompactCatalogSnapshot } = await import('./catalog-capture')
    const { ownWorkspaceSnapshot } = await import('./snapshot')
    const { capturedCopyOriginal } = await import('./guest-evidence')
    const { historicalSourceIdentity } = await import('../interchange/workspace-backup-catalog')
    const { capturedBackupEvidence } = await import('../interchange/workspace-backup-evidence')
    const { blobIdentity, readBlob, memoryBlob } = await import('./blobs')
    const fixture = await editorClosureFixture(), destination = progress('account')
    const source = { ...progress('local', false), editorDocuments: [fixture.file], blobs: fixture.blobs }
    source.planner = { ...source.planner, catalogs: [GUIDE_CATALOG] }
    const snapshot = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'compact-progress', capturedAt: now, revisionVector: {}, state: source }, { async check() {}, async dispose() {} }))
    const member = await capturedCopyOriginal(snapshot), identity = await historicalSourceIdentity(member.format, member.metadata)
    const originalCatalogBodies = [...capturedBackupEvidence(snapshot).catalogBodies!]
    const catalogBodies = originalCatalogBodies.map((body, index) => ({ ...body, ref: { documentId: `retained-${index}`, revisionId: 'catalog', byteLength: body.ref.byteLength, sha256: body.ref.sha256, encoding: body.ref.encoding } }))
    const mapping = signinProgressCorrespondence(source, destination).mappings[0]
    const ref: WorkspaceBlobRef = { documentId: 'metadata', revisionId: identity.metadataStreamDigest, encoding: 'bytes', byteLength: member.metadata.byteLength, sha256: identity.metadataStreamDigest }
    const association = { version: 2 as const, sourceFormat: 'compact-v2' as const, sourceKey: mapping.sourceKey, destinationKey: mapping.destinationKey, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest, sourceMetadata: ref, catalogBodies: catalogBodies.map((body, index) => ({ source: originalCatalogBodies[index].ref, retained: body.ref })) }
    const conflict = { unit: { kind: 'record', privateKey: mapping.destinationKey }, progressIdentity: association } as unknown as WorkspaceConflict
    if (kind === 'missing-catalog') catalogBodies.splice(0)
    if (kind === 'duplicate-catalog') association.catalogBodies.push(association.catalogBodies[0])
    if (kind === 'changed-source') association.catalogBodies[0].source = { ...association.catalogBodies[0].source, documentId: 'foreign-source' }
    if (kind === 'changed-retained') association.catalogBodies[0].retained = { ...association.catalogBodies[0].retained, sha256: '0'.repeat(64) }
    if (kind === 'changed-encoding') association.catalogBodies[0].retained = { ...association.catalogBodies[0].retained, encoding: 'utf8' }
    if (kind === 'unbound-v2') Object.assign(association, { catalogBodies: originalCatalogBodies.map(body => body.ref) })
    if (kind === 'wrong-format') Object.assign(association, { sourceFormat: 'legacy-v1' })
    if (kind === 'changed-catalog') {
      const bytes = await readBlob(catalogBodies[0].content, catalogBodies[0].ref.byteLength); bytes[bytes.length - 1] ^= 1
      catalogBodies[0] = { ...catalogBodies[0], content: memoryBlob(bytes) }
    }
    if (kind === 'late-catalog-failure') {
      const content = catalogBodies[0].content
      catalogBodies[0] = { ...catalogBodies[0], content: { byteLength: content.byteLength, async *open() { yield* content.open(); throw new Error('late catalog authentication') } } }
    }
    const pending = new Map(splitWorkspace(projectSigninProgress(source, destination, mapping)).map(document => [document.key, document]))
    const accepted = new Map(splitWorkspace(destination).map(document => [document.key, document]))
    const state = { ...destination, blobs: [{ ref, content: member.metadata }, ...catalogBodies] }
    expect(state.blobs.some(body => blobIdentity(body.ref) === blobIdentity(fixture.file.original))).toBe(false)
    const checked = validateSigninProgressIdentity(state, conflict, pending, accepted)
    if (kind === 'complete') await expect(checked).resolves.toBeUndefined()
    else await expect(checked).rejects.toThrow()
  } finally { vi.unstubAllGlobals() }
})
