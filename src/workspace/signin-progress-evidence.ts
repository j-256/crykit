import { logicalEntityKey } from '../domain/definitions'
import type { LocalData, PartyProgressRecord } from '../domain/types'
import { jsonEqual } from '../persistence/local-data'
import { SnapshotHeaderSchema } from '../interchange/workspace-backup-schema'
import { historicalMetadataIdentity, readBackupMetadata, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
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
  const digest = await historicalMetadataIdentity(body.content)
  if (digest.id !== identity.sourceIdentity || digest.metadataStreamDigest !== identity.sourceDigest) throw new Error('Progress original metadata identity mismatch')
  const raw = await readBackupMetadata(verifiedBlob(body.content, identity.sourceDigest)) as SnapshotMetadataV1
  const { state: originalState, ...header } = raw
  SnapshotHeaderSchema.parse(header)
  const sourceParts = JSON.parse(identity.sourceKey) as unknown
  const destinationParts = JSON.parse(identity.destinationKey) as unknown
  if (!Array.isArray(sourceParts) || !Array.isArray(destinationParts) || sourceParts.length !== 3 || destinationParts.length !== 3 || [...sourceParts, ...destinationParts].some(part => typeof part !== 'string') || sourceParts[0] !== 'progress' || destinationParts[0] !== 'progress' || sourceParts[1] !== destinationParts[1] || sourceParts[2] === destinationParts[2] || identity.destinationKey !== conflict.unit.privateKey || conflict.unit.kind !== 'record') throw new Error('Invalid Progress original identity mapping')
  // Metadata is inert, bounded input. Only the original root and its schema-declared domain
  // closure participate in this comparison; file payloads are neither duplicated nor activated
  const originals = new Map(splitWorkspace({ ...originalState, blobs: [] }).map(document => [document.key, document]))
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
