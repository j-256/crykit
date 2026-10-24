import { z } from 'zod'
import type { JsonValue } from '../domain/types'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { emptySavePending, type SavePending } from './save-input-controller'
const revision = NativeLocalDataSchema.shape.buildRevisions.valueType
const integer = z.number().int().nonnegative()
const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('currency'), value: integer }).strict(),
  z.object({ type: z.literal('member'), index: integer, name: z.string().optional(), level: integer.optional(), jobId: integer.optional(), subJobId: integer.nullable().optional() }).strict(),
  z.object({ type: z.literal('loadout'), index: integer, jobId: integer, subJobId: integer.nullable(), equipmentIds: integer.nullable().array(), passiveIds: integer.array() }).strict(),
  z.object({ type: z.literal('stock'), kind: z.enum(['item', 'equipment']), id: integer, count: integer }).strict(),
  z.object({ type: z.enum(['unlock-jobs', 'master-jobs', 'overpowered', 'reveal-maps', 'vanilla']) }).strict(),
])
const json = z.json()
export const SavePendingSchema = z.object({ version: z.literal(1), fields: z.record(z.string().regex(/^(currency|member\.\d+\.(name|level|jobId|subJobId)|stock\.(?:item|equipment)\.\d+)$/), z.string()), member: integer.max(3), loadout: revision.shape.content.optional(), selectedBuild: z.object({ title: z.string(), revision, context: json }).strict().optional(), review: z.object({ title: z.string(), command, timestamp: z.string(), base: z.string(), context: json, changes: z.string().array(), additions: z.string().array().optional() }).strict().optional(), context: json.optional(), presentation: z.object({ query: z.string().optional(), inventoryKind: z.enum(['all', 'item', 'equipment']).optional(), stockFilter: z.enum(['all', 'carried']).optional(), inventoryLimit: integer.optional(), picker: z.object({ fieldKey: z.string(), query: z.string(), resultLimit: integer }).strict().nullable().optional(), selected: z.object({ key: z.string(), name: z.string() }).strict().nullable().optional(), inspectClassPermissions: z.boolean().optional() }).strict(), focus: z.object({ key: z.string(), start: integer.nullable(), end: integer.nullable(), direction: z.enum(['forward', 'backward', 'none']).nullable() }).strict().optional() }).strict()
export function parseSavePending(value: JsonValue): { readonly kind: 'supported'; readonly input: SavePending } | { readonly kind: 'unsupported'; readonly value: JsonValue } {
  if (value === null) return { kind: 'supported', input: emptySavePending() }
  const parsed = SavePendingSchema.safeParse(value)
  // Unknown versions and keys remain exact inert payloads, never an empty replacement that autosave can overwrite
  return parsed.success ? { kind: 'supported', input: parsed.data as unknown as SavePending } : { kind: 'unsupported', value }
}
