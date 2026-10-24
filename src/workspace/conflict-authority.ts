import { z } from 'zod'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { OpaqueIdSchema } from '../account/protocol'
import { CipherRefSchema } from './account-cache'
import { UnitSchema } from './file-schemas'
import { SourceBookkeepingSchema } from './source-bookkeeping'

// Portable source IDs describe original association only; destination publication requires new authenticated authority
const OriginalRecordFields = { version: z.literal(1), ref: CipherRefSchema, lineageId: OpaqueIdSchema, body: CipherRefSchema, privateKey: z.string(), valueKind: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), parents: z.array(OpaqueIdSchema).max(2), sourceBookkeeping: SourceBookkeepingSchema.optional() }
export const OriginalRecordPublicationSchema = z.strictObject(OriginalRecordFields).refine(value => value.ref.documentId === value.body.documentId && value.ref.revisionId !== value.body.revisionId && new Set(value.parents).size === value.parents.length)
export const MappingContextSchema = z.strictObject({ kind: z.literal('control-baseline'), control: z.strictObject({ ref: CipherRefSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), parents: z.array(OpaqueIdSchema).max(2).refine(parents => new Set(parents).size === parents.length) }), directoryPhysicalHead: OpaqueIdSchema.nullable(), recordPhysicalHead: OpaqueIdSchema.nullable().optional() })
export type MappingContext = z.infer<typeof MappingContextSchema>
export const OriginalPublicationSchema = z.strictObject({
  ...OriginalRecordFields,
  lineage: z.strictObject({ root: NativeLocalDataSchema.shape.personalDefinitions.valueType.shape.baseRef.unwrap(), chain: CipherRefSchema, deleted: z.literal(true).optional(), reallocatedFrom: CipherRefSchema.optional() }).optional(),
  mapping: z.strictObject({ shard: z.number().int().min(0).max(63), index: CipherRefSchema, record: OriginalRecordPublicationSchema.optional(), context: MappingContextSchema.optional() }).refine(value => !value.context || Boolean(value.record) === (value.context.recordPhysicalHead !== undefined)).optional(),
}).refine(value => new Set(value.parents).size === value.parents.length && value.ref.revisionId !== value.body.revisionId && (
  value.mapping ? !value.lineage && !value.sourceBookkeeping && value.valueKind === 'directory-mapping-unit' && JSON.stringify(value.body) === JSON.stringify(value.mapping.index)
    : value.lineage ? value.valueKind === 'personal-lineage' && !value.sourceBookkeeping
      : value.ref.documentId === value.body.documentId && !['personal-lineage', 'directory-mapping-unit'].includes(value.valueKind)
))
export type OriginalPublication = z.infer<typeof OriginalPublicationSchema>
const branch = z.strictObject({ role: z.enum(['local-pending', 'accepted-cloud']), publication: OriginalPublicationSchema })
export const ConflictAuthoritySchema = z.strictObject({
  version: z.literal(1), unit: UnitSchema, lineageId: OpaqueIdSchema,
  commonAncestor: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('absent') }), z.strictObject({ kind: z.literal('present'), publication: OriginalPublicationSchema })]),
  supersedes: z.strictObject({ id: z.string(), ref: CipherRefSchema }).optional(),
  branches: z.tuple([branch.extend({ role: z.literal('local-pending') }), branch.extend({ role: z.literal('accepted-cloud') })]),
})
export type ConflictAuthority = z.infer<typeof ConflictAuthoritySchema>
export function conflictAuthorityRefs(value: ConflictAuthority) {
  const originals = [...(value.commonAncestor.kind === 'present' ? [value.commonAncestor.publication] : []), ...value.branches.map(branch => branch.publication)]
  // Source controls retain their charged physical closures, not portable sibling semantic bodies
  return [...(value.supersedes ? [value.supersedes.ref] : []), ...originals.flatMap(publication => [publication.ref, ...(publication.mapping?.record ? [publication.mapping.record.ref] : []), ...(publication.mapping?.context ? [publication.mapping.context.control.ref] : [])])]
}

export const ConflictResolutionIntentSchema = z.strictObject({ version: z.literal(1), conflictId: z.string(), conflict: CipherRefSchema, privateKey: z.string(), choice: z.enum(['this', 'other', 'both']), local: CipherRefSchema, remote: CipherRefSchema })
export type ConflictResolutionIntent = z.infer<typeof ConflictResolutionIntentSchema>

export const ConflictSuccessorEvidenceSchema = z.strictObject({ kind: z.literal('conflict-successor'), conflictId: z.string(), priorId: z.string(), prior: OriginalPublicationSchema, unit: UnitSchema })
export type ConflictSuccessorEvidence = z.infer<typeof ConflictSuccessorEvidenceSchema>
