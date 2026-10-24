import { z } from 'zod'

const integer = z.number().int().nonnegative().safe()
const text = z.string().min(1)
// These schemas bound the private envelope, not inert imported field names inside file bodies
const inert: z.ZodType<import('../domain/types').JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(inert), z.record(z.string(), inert)]))
export const WorkspaceBlobRefSchema = z.object({ documentId: text, revisionId: text, byteLength: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/), encoding: z.enum(['bytes', 'utf8', 'utf16le']) }).strict()
const ref = WorkspaceBlobRefSchema
export const EditorWorkspaceDocumentSchema = z.object({ version: z.literal(1), id: text, revision: integer, filename: text, referenceId: z.string(), original: ref, originalByteIdentity: z.enum(['exact', 'text-only']), lastApplied: ref, unfinished: z.object({ text: ref, editedPath: z.array(z.union([z.string(), integer])), fieldState: inert, baseRevision: integer, validation: z.enum(['valid', 'invalid', 'unchecked']) }).strict(), createdAt: text, updatedAt: text }).strict()
const pin = z.object({ catalogId: text, catalogRevisionId: text }).strict()
const receipt = pin.extend({ checksum: text, title: text, contentFingerprint: text.optional() }).strict()
export const SaveWorkspaceDocumentSchema = z.object({ version: z.literal(1), id: text, revision: integer, filename: text, original: ref, working: ref, pendingForm: inert, requirements: z.array(receipt), coverage: z.object({ status: z.enum(['supported', 'unsupported']), codecVersion: text.optional(), diagnostics: z.array(z.string()) }).strict(), createdAt: text, updatedAt: text, exportedRevision: integer.nullable() }).strict()
export const WorkspaceAssetSchema = z.object({ version: z.literal(1), id: text, sourceKey: text, relativePath: text, original: ref, thumbnail: ref.optional(), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']), width: integer.positive(), height: integer.positive() }).strict()
export const LibraryDefaultsSchema = z.object({ version: z.literal(1), layers: z.array(pin.extend({ enabled: z.boolean() }).strict()) }).strict()
export const ClosureSchema = z.object({ version: z.literal(1), root: ref, index: ref }).strict()
export const AncestorSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('absent') }).strict(), z.object({ kind: z.literal('present'), closure: ClosureSchema }).strict()])
export const UnitSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('record'), privateKey: text }).strict(), z.object({ kind: z.literal('directory-mapping'), privateKey: text, shard: integer.max(63) }).strict()])
export const WorkspaceConflictSchema = z.object({ version: z.literal(1), id: text, unit: UnitSchema, commonAncestor: AncestorSchema, branches: z.tuple([z.object({ role: z.literal('local-pending'), closure: ClosureSchema }).strict(), z.object({ role: z.literal('accepted-cloud'), closure: ClosureSchema }).strict()]), disposition: z.discriminatedUnion('kind', [z.object({ kind: z.literal('unresolved') }).strict(), z.object({ kind: z.literal('resolved'), choice: z.enum(['this', 'other', 'both']), result: ClosureSchema }).strict()]) }).strict()
export const WorkspaceRetainedContentSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('file-history'), id: text, fileKind: z.enum(['editor', 'save']), documentId: text, retainedAt: text, retention: z.enum(['protected', 'autosave-recovery']), content: ClosureSchema }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('pending-content'), id: text, groupId: text, unit: UnitSchema, base: AncestorSchema, target: ClosureSchema }).strict(),
])
