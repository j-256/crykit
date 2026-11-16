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
