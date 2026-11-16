import { z } from 'zod'
import { HistoricalMemberFormatSchema } from '../interchange/workspace-backup-schema'
import { catalogEvidenceSetDigest, compactHistoricalIdentity, type HistoricalMemberFormat } from '../interchange/workspace-backup-catalog'
import { attachBackupBodies, historicalMetadataIdentity, readBackupMetadata, type InheritedSnapshotSources, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { readCompactSnapshot, validateWorkspaceSnapshotV1, type SnapshotMetadataV3 } from './snapshot'
import { blobIdentity } from './blobs'
import { INHERITED_CATALOG_EVIDENCE_VERSION, sameCatalogBodyRef } from './catalog-reference'
import type { WorkspaceBlobRef } from './file-types'

export function catalogEvidenceSchemas<T>(locator: z.ZodType<T>) {
  const digest = z.string().regex(/^[a-f0-9]{64}$/)
  return {
    root: z.strictObject({ version: z.literal(INHERITED_CATALOG_EVIDENCE_VERSION), kind: z.literal('inherited-snapshot-evidence'), setDigest: digest, members: locator, blobs: locator, catalogBodies: locator }),
    member: z.strictObject({ format: HistoricalMemberFormatSchema, id: digest, metadata: locator, blobSubset: locator, catalogSubset: locator }),
    stream: z.strictObject({ version: z.literal(INHERITED_CATALOG_EVIDENCE_VERSION), kind: z.literal('evidence-metadata-stream'), codec: z.literal('backup-json-tokens-v2'), digest, byteLength: z.number().int().nonnegative().safe(), pages: locator }),
  }
}
export interface CatalogInheritedSnapshotSources extends InheritedSnapshotSources {
  readonly version: 2
  readonly members: readonly { readonly format: HistoricalMemberFormat; readonly id: string; readonly metadata: import('./file-types').BlobSource; readonly subset: readonly WorkspaceBlobRef[]; readonly catalogSubset: readonly WorkspaceBlobRef[] }[]
  readonly catalogBodies: import('./documents').WorkspaceState['blobs']
}
// Shared semantic admission runs only after the store adapter authenticates all physical typed edges
// Separate registries prevent a native original from authorizing a missing catalog fallback
export async function validateCatalogEvidenceSources(input: CatalogInheritedSnapshotSources, check: () => Promise<void>): Promise<string> {
  const setDigest = await catalogEvidenceSetDigest(input.members)
  const native = new Map(input.bodies.map(body => [blobIdentity(body.ref), body]))
  const catalogs = new Map(input.catalogBodies.map(body => [blobIdentity(body.ref), body]))
  if (native.size !== input.bodies.length || catalogs.size !== input.catalogBodies.length) throw new Error('Duplicate evidence body')
  const usedNative = new Set<string>(), usedCatalogs = new Set<string>()
  const subset = (declared: readonly WorkspaceBlobRef[], expected: readonly WorkspaceBlobRef[], registry: typeof native, used: Set<string>) => {
    if (declared.length !== expected.length) throw new Error('Historical catalog subset mismatch')
    const seen = new Set<string>()
    for (const [index, ref] of declared.entries()) {
      const key = blobIdentity(ref), body = registry.get(key)
      if (seen.has(key) || !body || !sameCatalogBodyRef(ref, body.ref) || !sameCatalogBodyRef(ref, expected[index])) throw new Error('Historical catalog subset association mismatch')
      seen.add(key); used.add(key)
    }
  }
  for (const member of input.members) {
    await check()
    const id = member.format === 'legacy-v1' ? (await historicalMetadataIdentity(member.metadata)).id : await compactHistoricalIdentity(member.metadata)
    if (id !== member.id) throw new Error('Historical catalog metadata identity mismatch')
    const raw = await readBackupMetadata(member.metadata) as SnapshotMetadataV1 | SnapshotMetadataV3
    subset(member.subset, raw.state.blobs, native, usedNative)
    if (member.format === 'legacy-v1') {
      if (member.catalogSubset.length) throw new Error('Legacy members cannot declare catalog bodies')
      await validateWorkspaceSnapshotV1(attachBackupBodies(raw as SnapshotMetadataV1, native))
    } else {
      if (raw.version !== 3) throw new Error('Compact historical metadata version mismatch')
      subset(member.catalogSubset, raw.catalogBodies, catalogs, usedCatalogs)
      await readCompactSnapshot(raw, input.bodies, input.catalogBodies, { check, async dispose() {} }, true)
    }
    await check()
  }
  if (usedNative.size !== native.size || usedCatalogs.size !== catalogs.size) throw new Error('Orphan inherited catalog body')
  return setDigest
}
