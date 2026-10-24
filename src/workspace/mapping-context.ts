import type { z } from 'zod'
import type { OriginalPublication } from './conflict-authority'
import type { PublicationControlSchema, DirectorySchema, AllocationSchema, PublicationBaselineEntry } from '../account/sync/publication'
import type { CipherRef } from '../persistence/account-database'
import { DIRECTORY_SHARDS } from './directory'

// This proves the claimed metadata association only; live acceptance and ancestry are separate gates
export function validateMappingContext(publication: OriginalPublication, directory: z.infer<typeof DirectorySchema>, allocations: readonly z.infer<typeof AllocationSchema>[], control: z.infer<typeof PublicationControlSchema>, baseline: readonly PublicationBaselineEntry[]) {
  const mapping = publication.mapping!, context = mapping.context!
  if (control.lineageId !== publication.lineageId || directory.lineageId !== control.lineageId) throw new Error('Mapping control lineage mismatch')
  const directories = baseline.filter(entry => entry.kind === 'directory'), units = baseline.filter(entry => entry.kind !== 'directory')
  if (directories.length !== DIRECTORY_SHARDS || new Set(directories.map(entry => entry.shard)).size !== DIRECTORY_SHARDS || new Set(units.map(entry => entry.key)).size !== units.length || new Set(baseline.map(entry => entry.seed.documentId)).size !== baseline.length) throw new Error('Contradictory mapping baseline')
  const shard = directories.find(entry => entry.shard === mapping.shard)!
  const selected = (seed: CipherRef, replaced: string | null, physical: string | null): CipherRef | undefined => physical === replaced ? seed : physical ? { documentId: seed.documentId, revisionId: physical } : undefined
  if (JSON.stringify(selected(shard.seed, shard.replacedHead, context.directoryPhysicalHead)) !== JSON.stringify(publication.ref)) throw new Error('Mapping shard selection mismatch')
  const raw = allocations.find(entry => entry.key === publication.privateKey)
  const seed = units.find(entry => entry.key === publication.privateKey), record = mapping.record
  if (!record) {
    if (raw || seed) throw new Error('Mapping absence contradicts complete source membership')
  } else {
    if (record.lineageId !== control.lineageId || record.privateKey !== publication.privateKey
      || (seed && seed.kind !== 'mutable') || (raw && raw.documentId !== record.ref.documentId)
      || (!raw && !seed)) throw new Error('Mapping record allocation mismatch')
    const effective = seed?.kind === 'mutable' ? selected(seed.seed, seed.replacedHead, context.recordPhysicalHead!) : context.recordPhysicalHead ? { documentId: raw!.documentId, revisionId: context.recordPhysicalHead } : undefined
    if (JSON.stringify(effective) !== JSON.stringify(record.ref)) throw new Error('Mapping record selection mismatch')
  }
  return { shardSeed: shard.seed, recordSeed: seed?.kind === 'mutable' ? seed.seed : undefined }
}
