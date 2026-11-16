import { logicalEntityKey } from '../domain/definitions'
import type { LocalData, PartyProgressRecord } from '../domain/types'
import { jsonEqual } from '../persistence/local-data'
import { SnapshotHeaderSchema, SnapshotHeaderV3Schema } from '../interchange/workspace-backup-schema'
import { readBackupMetadata, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { historicalSourceIdentity } from '../interchange/workspace-backup-catalog'
import { hydrateStoredCatalogs, sameCatalogBodyRef } from './catalog-reference'
import type { SnapshotMetadataV3 } from './snapshot'
import { blobIdentity, verifiedBlob } from './blobs'
import { splitWorkspace, type WorkspaceConflict, type WorkspaceDocument, type WorkspaceState } from './documents'
import { resolvedDomainClosureKeys, validateArchiveDomainValue } from './domain-closure'

// The retained metadata stream makes this association independently verifiable on another
// device or in a backup, without granting its unrelated records any live workspace authority
export async function validateSigninProgressIdentity(state: WorkspaceState, conflict: WorkspaceConflict, pending: ReadonlyMap<string, WorkspaceDocument>, accepted: ReadonlyMap<string, WorkspaceDocument>): Promise<void> {
  const identity = conflict.progressIdentity
  if (!identity) return
  const body = state.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(identity.sourceMetadata))
  if (!body || !jsonEqual(body.ref, identity.sourceMetadata)) throw new Error('Missing Progress original metadata')
  const digest = await historicalSourceIdentity(identity.version === 2 ? identity.sourceFormat : 'legacy-v1', body.content)
  if (digest.id !== identity.sourceIdentity || digest.metadataStreamDigest !== identity.sourceDigest) throw new Error('Progress original metadata identity mismatch')
  const raw = await readBackupMetadata(verifiedBlob(body.content, identity.sourceDigest)) as SnapshotMetadataV1 | SnapshotMetadataV3
  const { state: storedState, ...header } = raw
  let originalState: Omit<WorkspaceState, 'blobs'> & { blobs: readonly import('./file-types').WorkspaceBlobRef[] }
  if (identity.version === 1) {
    SnapshotHeaderSchema.parse(header)
    originalState = (raw as SnapshotMetadataV1).state
  } else {
    SnapshotHeaderV3Schema.parse(header)
    if (raw.version !== 3 || raw.historicalEvidence !== undefined) throw new Error('Invalid compact Progress original')
    if (identity.sourceFormat !== 'compact-v2' || identity.catalogBodies.length !== raw.catalogBodies.length || identity.catalogBodies.some((binding, index) => !sameCatalogBodyRef(binding.source, raw.catalogBodies[index]))) throw new Error('Progress original catalog subset changed')
    const retainedKeys = new Set<string>()
    const bodies = identity.catalogBodies.map(({ source, retained }) => {
      const key = blobIdentity(retained)
      if (retainedKeys.has(key) || source.byteLength !== retained.byteLength || source.sha256 !== retained.sha256 || source.encoding !== retained.encoding) throw new Error('Progress original catalog binding changed')
      retainedKeys.add(key)
      const body = state.blobs.find(body => blobIdentity(body.ref) === key)
      if (!body || !sameCatalogBodyRef(retained, body.ref)) throw new Error('Missing Progress original catalog')
      // The archive has separate native/catalog roles, while conflict bodies share one registry
      // Relocation changes only storage identity; the original full ref still authenticates bytes
      return { ref: source, content: body.content }
    })
    // Only retained catalog frames are read here; unrelated native payloads remain inert below
    const { catalogs } = await hydrateStoredCatalogs(storedState.planner.catalogs, raw.catalogBodies, bodies, async () => {})
    originalState = { ...storedState, planner: { ...storedState.planner, catalogs } }
  }
  const sourceParts = JSON.parse(identity.sourceKey) as unknown
  const destinationParts = JSON.parse(identity.destinationKey) as unknown
  if (!Array.isArray(sourceParts) || !Array.isArray(destinationParts) || sourceParts.length !== 3 || destinationParts.length !== 3 || [...sourceParts, ...destinationParts].some(part => typeof part !== 'string') || sourceParts[0] !== 'progress' || destinationParts[0] !== 'progress' || sourceParts[1] !== destinationParts[1] || sourceParts[2] === destinationParts[2] || identity.destinationKey !== conflict.unit.privateKey || conflict.unit.kind !== 'record') throw new Error('Invalid Progress original identity mapping')
  // Metadata is inert, bounded input. Only the original root and its schema-declared domain
  // closure participate in this comparison; file payloads are neither duplicated nor activated
  // Preserve every declared reference while validating metadata with unrelated editor/source records
  // The inherited archive owns body authentication; these local shape-only sources cannot
  // read bytes or escape into a captured workspace
  const metadataBodies = originalState.blobs.map(ref => ({ ref, content: { byteLength: ref.byteLength, async *open(): AsyncGenerator<Uint8Array> { throw new Error('Progress metadata does not grant body access') } } }))
  const originals = new Map(splitWorkspace({ ...originalState, blobs: metadataBodies }).filter(document => document.kind !== 'blob').map(document => [document.key, document]))
  const original = originals.get(identity.sourceKey), mapped = pending.get(identity.destinationKey)
  if (!original || original.kind !== 'progress' || !mapped || mapped.kind !== 'progress' || originals.has(identity.destinationKey)) throw new Error('Missing or occupied Progress original identity')
  validateArchiveDomainValue(original.kind, original.value)
  const account = accepted.get(identity.destinationKey)
  if (!account || account.kind !== 'progress') throw new Error('Missing accepted Progress identity')
  validateArchiveDomainValue(account.kind, account.value)
  const accountLocal = { ...originalState.planner.localData, personalDefinitions: Object.fromEntries([...accepted.values()].filter(document => document.kind === 'personal-definition').map(document => [(document.value as unknown as { id: string }).id, document.value])) } as unknown as LocalData
  if (logicalEntityKey(originalState.planner.localData, (original.value as unknown as PartyProgressRecord).subject) !== logicalEntityKey(accountLocal, (account.value as unknown as PartyProgressRecord).subject)) throw new Error('Progress original subject does not match its destination')
  const expected = { ...original, key: identity.destinationKey, value: { ...(original.value as object), id: destinationParts[2] } }
  if (!jsonEqual(expected, mapped)) throw new Error('Progress projection changed its original observation')
  const visited = new Set<string>()
  const compare = (key: string): void => {
    if (visited.has(key)) return
    visited.add(key)
    const source = originals.get(key), actual = pending.get(key)
    if (!source || !actual || !jsonEqual(source, actual)) throw new Error('Progress projection changed its original dependencies')
    for (const dependency of resolvedDomainClosureKeys(source, originals)) compare(dependency)
  }
  for (const dependency of resolvedDomainClosureKeys(original, originals)) compare(dependency)
}
