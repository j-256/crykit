import { historicalSourceIdentity, type HistoricalMemberFormat } from '../interchange/workspace-backup-catalog'
import { readBackupMetadata, type InheritedSnapshotSources, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { SnapshotHeaderSchema, SnapshotHeaderV3Schema } from '../interchange/workspace-backup-schema'
import { blobIdentity, verifiedBlob } from './blobs'
import type { CatalogInheritedSnapshotSources } from './catalog-evidence'
import { sameCatalogBodyRef } from './catalog-reference'
import type { WorkspaceState } from './documents'
import type { SnapshotMetadataV3 } from './snapshot'

export interface ComparisonOriginalBinding { sourceFormat: HistoricalMemberFormat; sourceIdentity: string; sourceDigest: string }

// Historical identity remains the exact stored stream, independent of its hydrated domain view
// Both roles and ordered subsets must agree before a comparison can use that stream
export async function comparisonOriginal(sources: InheritedSnapshotSources | CatalogInheritedSnapshotSources, binding: ComparisonOriginalBinding) {
  const matches = sources.members.filter(member => (member.format ?? 'legacy-v1') === binding.sourceFormat && member.id === binding.sourceIdentity)
  if (matches.length !== 1) throw new Error('Comparison original identity changed')
  const member = matches[0], identity = await historicalSourceIdentity(binding.sourceFormat, member.metadata)
  if (identity.id !== binding.sourceIdentity || identity.metadataStreamDigest !== binding.sourceDigest) throw new Error('Comparison original stream changed')
  const raw = await readBackupMetadata(verifiedBlob(member.metadata, binding.sourceDigest)) as SnapshotMetadataV1 | SnapshotMetadataV3
  const { state: _state, ...header } = raw
  if (binding.sourceFormat === 'legacy-v1') SnapshotHeaderSchema.parse(header)
  else { SnapshotHeaderV3Schema.parse(header); if ('historicalEvidence' in raw) throw new Error('Nested comparison original') }
  const subset = (declared: readonly WorkspaceState['blobs'][number]['ref'][], expected: typeof declared, registry: WorkspaceState['blobs']) => {
    if (declared.length !== expected.length || new Set(declared.map(blobIdentity)).size !== declared.length) throw new Error('Comparison original subset changed')
    return declared.map((ref, index) => {
      const body = registry.find(body => blobIdentity(body.ref) === blobIdentity(ref))
      if (!body || !sameCatalogBodyRef(ref, expected[index]) || !sameCatalogBodyRef(body.ref, ref)) throw new Error('Comparison original body association changed')
      return body
    })
  }
  const bodies = subset(member.subset, raw.state.blobs, sources.bodies)
  const declaredCatalogs = 'catalogSubset' in member ? member.catalogSubset as CatalogInheritedSnapshotSources['members'][number]['catalogSubset'] : []
  const catalogBodies = subset(declaredCatalogs, raw.version === 3 ? raw.catalogBodies : [], sources.catalogBodies ?? [])
  return { member, raw, bodies, catalogBodies }
}

// This is a domain equality projection, never a snapshot admission or historical identity
// Keep every portable field and full native reference without manufacturing V3 reader ownership
export function comparisonState(state: WorkspaceState) { return { ...state, blobs: state.blobs.map(body => body.ref) } }
