import { z } from 'zod'
import { TEAM_SIZE } from '../domain/scenarios'
import { NativeLocalDataSchema, NativeLocalData240Schema } from '../interchange/native-schema'
import { CipherRefSchema } from './account-cache'
import type { CipherRef } from '../persistence/account-database'
import type { WorkspaceDocument } from './documents'

export const SourceBookkeepingSchema = z.strictObject({ version: z.literal(1), kind: z.literal('recorded-party-source'), origin: z.enum(['local-capture', 'legacy-local-migration']), scenarioDependencies: z.enum(['complete-v1', 'legacy-s02']), baselineCheckpoints: z.array(z.strictObject({ key: z.string(), ref: CipherRefSchema })).max(TEAM_SIZE), scenarioKey: z.string(), scenario: CipherRefSchema, ownerKey: z.string(), owner: CipherRefSchema, revision: z.number().int().nonnegative().safe(), updatedAt: NativeLocalDataSchema.shape.updatedAt })
export type SourceBookkeeping = z.infer<typeof SourceBookkeepingSchema>
const scenarioReader = z.union([NativeLocalDataSchema.shape.playthroughs.valueType.shape.scenarios.valueType, NativeLocalData240Schema.shape.playthroughs.valueType.shape.scenarios.valueType])
export function checkpointRecordKey(ref: string | import('../domain/types').CheckpointRef): string { return typeof ref === 'string' ? JSON.stringify(['build-checkpoint', ref]) : ref.kind === 'build' ? JSON.stringify(['build-checkpoint', ref.revisionId]) : JSON.stringify(['team-checkpoint', ref.teamRevisionId]) }
type RecordBody = { readonly ref: CipherRef; readonly document: WorkspaceDocument }
const same = (a: CipherRef, b: CipherRef) => a.documentId === b.documentId && a.revisionId === b.revisionId

// This association proves only the source clock at capture, never inventory, progress or replay authority
export function validateSourceBookkeeping(evidence: SourceBookkeeping, scenario: RecordBody, owner: RecordBody): number {
  SourceBookkeepingSchema.parse(evidence)
  const ids = JSON.parse(scenario.document.key) as string[]
  const value = scenarioReader.parse(scenario.document.value)
  const metadata = (owner.document.value as unknown as { metadata: { id: string; revision: number } }).metadata
  if (scenario.document.kind !== 'scenario' || owner.document.kind !== 'playthrough' || ids.length !== 3 || ids[0] !== 'scenario' || ids[2] !== value.id || owner.document.key !== JSON.stringify(['playthrough', ids[1]]) || metadata.id !== ids[1] || value.baseline.kind !== 'recordedParty' || evidence.scenarioKey !== scenario.document.key || evidence.ownerKey !== owner.document.key || !same(evidence.scenario, scenario.ref) || !same(evidence.owner, owner.ref) || value.baseline.playthroughRevision > evidence.revision || metadata.revision > evidence.revision) throw new Error('Invalid recorded-party source bookkeeping')
  return value.baseline.playthroughRevision
}

export function recordedPartyFloor(scenario: RecordBody, owner: RecordBody, evidence?: SourceBookkeeping): number {
  if (scenario.document.kind !== 'scenario') { if (evidence) throw new Error('Unexpected source bookkeeping'); return 0 }
  const value = scenarioReader.parse(scenario.document.value)
  if (value.baseline.kind !== 'recordedParty') { if (evidence) throw new Error('Unexpected source bookkeeping'); return 0 }
  const metadata = (owner.document.value as unknown as { metadata: { id: string; revision: number; updatedAt: string } }).metadata
  return validateSourceBookkeeping(evidence ?? { version: 1, kind: 'recorded-party-source', origin: 'local-capture', scenarioDependencies: 'complete-v1', baselineCheckpoints: [], scenarioKey: scenario.document.key, scenario: scenario.ref, ownerKey: owner.document.key, owner: owner.ref, revision: metadata.revision, updatedAt: metadata.updatedAt }, scenario, owner)
}

export function validateSourceCheckpoints(evidence: SourceBookkeeping, scenario: RecordBody, checkpoints: readonly RecordBody[]): void {
  const value = scenarioReader.parse(scenario.document.value)
  const expected = value.baseline.kind === 'recordedParty' ? [...new Set(Object.values(value.baseline.assignments).map(ref => checkpointRecordKey(ref as import('../domain/types').CheckpointRef | string)))].sort() : []
  if (JSON.stringify(evidence.baselineCheckpoints.map(value => value.key).sort()) !== JSON.stringify(expected) || checkpoints.length !== expected.length) throw new Error('Incomplete recorded-party baseline checkpoints')
  for (const binding of evidence.baselineCheckpoints) {
    const record = checkpoints.find(record => same(record.ref, binding.ref))
    if (!record || record.document.key !== binding.key || record.document.kind !== (JSON.parse(binding.key) as string[])[0] || (record.document.value as unknown as { id: string }).id !== (JSON.parse(binding.key) as string[])[1]) throw new Error('Foreign recorded-party baseline checkpoint')
  }
}
export function sourceBookkeepingRefs(evidence: SourceBookkeeping): readonly CipherRef[] { return [evidence.owner, ...evidence.baselineCheckpoints.map(value => value.ref)] }
