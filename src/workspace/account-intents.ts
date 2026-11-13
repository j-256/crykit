import type { AccountPreparationOwner } from './account-prepared-records'
import { ConflictResolutionIntentSchema } from './conflict-authority'
import { z } from 'zod'
import { OpaqueIdSchema } from '../account/protocol'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence, CipherRecord, CipherRef } from '../persistence/account-database'
import { CipherRefSchema, openAccountJson, stageAccountJson, cipherRef } from './account-cache'
import { openAccountWorkspace, type OpenAccountWorkspace } from './account-graph'
import { WORKSPACE_DOCUMENT_KINDS } from './documents'
import { buildIndexPages, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'

export const MappedWorkspaceChangeSchema = z.object({ key: z.string(), kind: z.enum(WORKSPACE_DOCUMENT_KINDS), before: CipherRefSchema.nullable(), after: CipherRefSchema.nullable() }).strict().refine(value => (value.before !== null || value.after !== null) && (!value.before || !value.after || value.before.documentId === value.after.documentId), 'Empty or foreign mapped change identity')
export type MappedWorkspaceChange = z.infer<typeof MappedWorkspaceChangeSchema>
const changePageSchema = z.object({ version: z.literal(1), kind: z.literal('mapped-change-page'), operationId: OpaqueIdSchema, entries: z.array(MappedWorkspaceChangeSchema), children: z.array(CipherRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)

export const MappedWorkspaceIntentSchema = z.object({
  version: z.literal(1), kind: z.literal('mapped-workspace-intent'), operationId: OpaqueIdSchema, portableGroupId: OpaqueIdSchema,
  operation: z.enum(['save', 'undo', 'workspace-command', 'import', 'mod-setup']), mode: z.enum(['additive', 'replace']),
  original: z.object({ base: CipherRefSchema, target: CipherRefSchema }).strict(),
  base: CipherRefSchema, target: CipherRefSchema, localRevision: z.number().int().nonnegative().safe(),
  changesIndex: CipherRefSchema, copiedConflicts: CipherRefSchema.optional(), conflictResolution: ConflictResolutionIntentSchema.optional(),
}).strict()
export type MappedWorkspaceIntent = z.infer<typeof MappedWorkspaceIntentSchema>

export function mappedChanges(before: OpenAccountWorkspace, after: OpenAccountWorkspace): MappedWorkspaceChange[] {
  const previous = new Map(before.entries.map(entry => [entry.key, entry]))
  return after.entries.filter(entry => previous.get(entry.key)?.ref.revisionId !== entry.ref.revisionId).map(entry => ({ key: entry.key, kind: entry.kind, before: previous.get(entry.key)?.ref ?? null, after: entry.ref }))
}
export async function stageMappedWorkspaceIntent(database: AccountDatabase, token: ProfileToken, input: Omit<MappedWorkspaceIntent, 'changesIndex'> & { readonly changes: readonly MappedWorkspaceChange[] }, owner?: AccountPreparationOwner): Promise<{ readonly value: MappedWorkspaceIntent; readonly record: CipherRecord; readonly records: readonly CipherRecord[] }> {
  const { changes, ...metadata } = input
  const seen = new Set<string>(), records: CipherRecord[] = []
  for (const change of changes) { MappedWorkspaceChangeSchema.parse(change); if (seen.has(change.key)) throw new Error('Duplicate mapped change'); seen.add(change.key) }
  const changesIndex = await buildIndexPages(changes, async page => {
    const value = changePageSchema.parse({ ...page, kind: 'mapped-change-page', operationId: metadata.operationId })
    if (new TextEncoder().encode(JSON.stringify(value)).length > INDEX_PAGE_BYTES) throw new Error('Mapped change page exceeds format bound')
    const dependencies = [...page.children, ...page.entries.flatMap(change => [change.before, change.after].filter((ref): ref is CipherRef => ref !== null))]
    const record = await stageAccountJson(database, token, value, dependencies, undefined, owner)
    records.push(record); return cipherRef(record)
  }, page => new TextEncoder().encode(JSON.stringify({ ...page, kind: 'mapped-change-page', operationId: metadata.operationId })).length)
  const value = MappedWorkspaceIntentSchema.parse({ ...metadata, changesIndex })
  const dependencies = [value.original.base, value.original.target, value.base, value.target, changesIndex, ...(value.copiedConflicts ? [value.copiedConflicts] : []), ...(value.conflictResolution ? [value.conflictResolution.conflict, value.conflictResolution.local, value.conflictResolution.remote] : [])]
  const record = await stageAccountJson(database, token, value, [...new Map(dependencies.map(ref => [JSON.stringify(ref), ref])).values()], undefined, owner)
  records.push(record)
  return { value, record, records }
}

export async function readMappedWorkspaceChanges(database: AccountDatabase, token: ProfileToken, intent: MappedWorkspaceIntent): Promise<readonly MappedWorkspaceChange[]> {
  assertActiveProfile(token)
  MappedWorkspaceIntentSchema.parse(intent)
  const pages = new Set<string>(), keys = new Set<string>(), changes: MappedWorkspaceChange[] = []
  async function visit(ref: CipherRef): Promise<void> {
    const id = JSON.stringify(ref)
    if (pages.has(id)) throw new Error('Cyclic or duplicate mapped change page')
    pages.add(id)
    const page = await openAccountJson(database, token, ref, changePageSchema)
    if (page.operationId !== intent.operationId || new TextEncoder().encode(JSON.stringify(page)).length > INDEX_PAGE_BYTES) throw new Error('Foreign or oversized mapped change page')
    for (const change of page.entries) {
      if (keys.has(change.key)) throw new Error('Duplicate mapped change')
      if (change.before && change.after && change.before.documentId !== change.after.documentId) throw new Error('Foreign mapped change identity')
      keys.add(change.key); changes.push(change)
    }
    for (const child of page.children) await visit(child)
  }
  await visit(intent.changesIndex)
  assertActiveProfile(token)
  return changes
}

// The selected graph must already use the supported application generation
// Authentication admits ciphertext; this reader never converts an older plaintext schema
export async function openExactAccountWorkspace(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<{ fence: AccountFence; workspace: OpenAccountWorkspace }> {
  return { fence, workspace: await openAccountWorkspace(database, token, fence.head) }
}
