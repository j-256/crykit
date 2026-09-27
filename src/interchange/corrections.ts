import { z } from 'zod'
import { CORRECTION_DECISIONS, CORRECTIONS_FORMAT, CORRECTIONS_VERSION, MAX_CORRECTIONS, MAX_CORRECTION_BYTES, correctionKey, sameCorrectionValue, type CatalogCorrection, type CorrectionCollection } from '../domain/corrections'
import { AppDataError } from './errors'
import { parseBoundedJson } from './json'
import { NativeCatalogSnapshotSchema } from './native-schema'

const text = z.string().max(20_000)
const identifier = z.string().min(1).max(1_024).refine(value => !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value))
const knowledge = NativeCatalogSnapshotSchema.shape.entities.valueType.shape.fields.valueType
const timestamp = z.iso.datetime()
const change = z.discriminatedUnion('path', [
  z.object({ path: z.literal('name'), before: text, after: text.trim().min(1) }).strict(),
  z.object({ path: z.literal('aliases'), before: z.array(text).max(100), after: z.array(text).max(100) }).strict(),
  z.object({ path: z.literal('description'), before: text.nullable(), after: text.nullable() }).strict(),
  z.object({ path: z.literal('field'), field: identifier.trim().min(1), before: knowledge.nullable(), after: knowledge.nullable() }).strict(),
  z.object({ path: z.literal('visibility'), before: z.boolean(), after: z.boolean() }).strict(),
])

const correction = z.object({
  id: identifier,
  supersedes: z.array(identifier).max(MAX_CORRECTIONS),
  decision: z.enum(Object.keys(CORRECTION_DECISIONS) as [keyof typeof CORRECTION_DECISIONS, ...Array<keyof typeof CORRECTION_DECISIONS>]),
  baselineSources: NativeCatalogSnapshotSchema.shape.entities.valueType.shape.sources,
  baselineClaims: NativeCatalogSnapshotSchema.shape.claims,
  target: z.object({ kind: z.literal('catalog'), catalogId: identifier, catalogRevisionId: identifier, entityId: identifier }).strict(),
  baselineChecksum: identifier,
  baselineName: text.min(1),
  confidence: z.enum(['tentative', 'confirmed']),
  reason: text,
  evidence: text,
  context: z.object({ platform: text, gameVersion: text, mods: text }).strict(),
  updatedAt: timestamp,
  changes: z.array(change).max(200),
}).strict().superRefine((entry, context) => {
  if (entry.baselineClaims.some(claim => claim.entityId !== entry.target.entityId)) context.addIssue({ code: 'custom', message: 'Baseline claims must belong to the correction target' })
  if (entry.supersedes.includes(entry.id) || new Set(entry.supersedes).size !== entry.supersedes.length) context.addIssue({ code: 'custom', message: 'Invalid supersession' })
  if (!entry.changes.length && !entry.supersedes.length) context.addIssue({ code: 'custom', message: 'An empty correction must restore an earlier decision' })
  const paths = entry.changes.map(value => value.path === 'field' ? `field:${value.field.toLocaleLowerCase()}` : value.path === 'description' ? 'field:description' : value.path)
  if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', message: 'Repeated correction fields' })
  if (entry.changes.some(value => sameCorrectionValue(value.before, value.after))) context.addIssue({ code: 'custom', message: 'A correction must change its original value' })
})

const entriesSchema = z.array(correction).max(MAX_CORRECTIONS).superRefine((entries, context) => {
  const keys = entries.map(entry => entry.id)
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Repeated correction IDs' })
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (entry: typeof entries[number]): boolean => {
    if (visiting.has(entry.id)) return false
    if (done.has(entry.id)) return true
    visiting.add(entry.id)
    for (const id of entry.supersedes) {
      const previous = byId.get(id)
      if (previous && (correctionKey(previous as unknown as CatalogCorrection) !== correctionKey(entry as unknown as CatalogCorrection) || !visit(previous))) return false
    }
    visiting.delete(entry.id)
    done.add(entry.id)
    return true
  }
  if (entries.some(entry => !visit(entry))) context.addIssue({ code: 'custom', message: 'Supersession must be acyclic and stay within one exact target' })
})

const fileSchema = z.object({ format: z.literal(CORRECTIONS_FORMAT), version: z.literal(CORRECTIONS_VERSION), exportedAt: timestamp, corrections: entriesSchema }).strict()
const collectionSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), entries: entriesSchema }).strict()

function boundedValue(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > MAX_CORRECTION_BYTES) throw new AppDataError('unsupported-format', 'Corrections must be a nonempty JSON file of at most 4 MiB')
  return parseBoundedJson(bytes, 'Corrections')
}

function validate<T>(schema: z.ZodType, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AppDataError('schema-mismatch', 'The corrections format or values are invalid. No corrections were imported', { details: { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })).slice(0, 10) } })
  return result.data as T
}

export function readCorrections(bytes: Uint8Array): readonly CatalogCorrection[] {
  return validate<{ corrections: readonly CatalogCorrection[] }>(fileSchema, boundedValue(bytes)).corrections
}

export function exportCorrections(entries: readonly CatalogCorrection[], exportedAt = new Date().toISOString()): Uint8Array {
  const value = validate(fileSchema, { format: CORRECTIONS_FORMAT, version: CORRECTIONS_VERSION, exportedAt, corrections: entries })
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
  boundedValue(bytes)
  return bytes
}

export function parseCorrectionCollection(value: string): CorrectionCollection {
  return validate<CorrectionCollection>(collectionSchema, boundedValue(new TextEncoder().encode(value)))
}

export function serializeCorrectionCollection(value: CorrectionCollection): string {
  const serialized = JSON.stringify(validate<CorrectionCollection>(collectionSchema, value))
  boundedValue(new TextEncoder().encode(serialized))
  return serialized
}
