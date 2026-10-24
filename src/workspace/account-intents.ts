import type { AccountPreparationOwner } from './account-prepared-records'
import { ConflictResolutionIntentSchema } from './conflict-authority'
import { z } from 'zod'
import { OpaqueIdSchema } from '../account/protocol'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence, AccountIntentRecord, CipherRecord, CipherRef } from '../persistence/account-database'
import { activateLocalAccountCommit } from '../persistence/account-database'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import type { PersistedHistoryEntry } from '../interchange/types'
import { AccountProjectionSchema, AccountHistorySchema, AccountIntentSchema, CipherRefSchema, openAccountJson, stageAccountJson, cipherRef, accountLocalId, type AccountProjection } from './account-cache'
import { AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema, openAccountWorkspace, prepareAccountWorkspace, openLegacyLocalAccountWorkspace, type OpenAccountWorkspace } from './account-graph'
import { openAccountSource } from './account-streams'
import { WORKSPACE_DOCUMENT_KINDS, type WorkspaceState } from './documents'
import { retainPendingUnits } from './pending-content'
import { WorkspaceError } from './repository'
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

export async function legacyWorkspace(database: AccountDatabase, token: ProfileToken, projection: AccountProjection): Promise<WorkspaceState> {
  const history: PersistedHistoryEntry[] = [], seen = new Set<string>()
  let ref = projection.history
  while (ref) {
    if (seen.has(ref.revisionId)) throw new Error('Cyclic legacy planner history')
    seen.add(ref.revisionId)
    const saved = await openAccountJson(database, token, ref, AccountHistorySchema)
    history.push(saved.entry as unknown as PersistedHistoryEntry); ref = saved.previous
  }
  const catalogs = projection.bundledCatalogs.map(pin => {
    const catalog = BUNDLED_CATALOGS.find(value => value.id === pin.id && value.revisionId === pin.revisionId && value.checksum === pin.checksum)
    if (!catalog) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'An exact saved catalog revision is unavailable.')
    return catalog
  })
  const sources = [], blobs = []
  for (const { original, ...metadata } of projection.sources) {
    const content = await openAccountSource(database, token, original)
    const sourceRef = { ...original, byteLength: content.byteLength, sha256: metadata.digest, encoding: 'bytes' as const }
    sources.push({ ...metadata, original: sourceRef }); blobs.push({ ref: sourceRef, content })
  }
  return { planner: { localData: projection.localData as unknown as LocalData, lineage: projection.lineage as WorkspaceState['planner']['lineage'], catalogs: [...catalogs, ...projection.catalogs] as readonly CatalogSnapshot[], evidence: projection.evidence as WorkspaceState['planner']['evidence'], sources: sources as unknown as WorkspaceState['planner']['sources'], history: history.reverse() }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs }
}

// The codec is authenticated before dispatch; unsupported formats never trigger a guessed conversion
export async function openOrMapAccountWorkspace(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<{ fence: AccountFence; workspace: OpenAccountWorkspace }> {
  const codec = await openAccountJson(database, token, fence.head, z.union([AccountProjectionSchema, AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema]))
  if (codec.kind === 'local-workspace-graph') {
    if (codec.version === 2) return { fence, workspace: await openAccountWorkspace(database, token, fence.head) }
    const workspace = await openLegacyLocalAccountWorkspace(database, token, fence.head)
    if (workspace.sourceEvidenceVersion === 1) return { fence, workspace }
    const snapshots = new Map([[fence.head.revisionId, workspace]])
    const rows = await database.outbox.toArray(), intents: MappedWorkspaceIntent[] = []
    for (const row of rows) if (row.status === 'mapped-local') {
      const intent = await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)
      intents.push(intent)
      for (const ref of [intent.base, intent.target]) if (!snapshots.has(ref.revisionId)) snapshots.set(ref.revisionId, await openLegacyLocalAccountWorkspace(database, token, ref))
    }
    const { prepareSourceEvidenceMigration } = await import('./account-source-migration')
    const prepared = await prepareSourceEvidenceMigration(database, token, fence.head, snapshots, intents)
    if (!prepared.sourceCaptures.length) return { fence, workspace }
    // The same account/profile/local fence publishes every strict view together while original intent bytes stay unchanged
    const active = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, ...prepared, intentStatus: 'mapped-local' })
    return { fence: active, workspace: await openAccountWorkspace(database, token, active.head) }
  }
  const rows = await database.outbox.toArray()
  const records: CipherRecord[] = [], replacements: { expected: AccountIntentRecord; replacement: AccountIntentRecord }[] = []
  const mapped = new Map<string, OpenAccountWorkspace>()
  let stableAllocations: OpenAccountWorkspace['allocations'] = []
  async function map(ref: CipherRef, base?: OpenAccountWorkspace): Promise<OpenAccountWorkspace> {
    const key = JSON.stringify(ref), found = mapped.get(key)
    if (found) return found
    const original = await openAccountJson(database, token, ref, AccountProjectionSchema)
    const prepared = await prepareAccountWorkspace(database, token, await legacyWorkspace(database, token, original), base, stableAllocations)
    records.push(...prepared.records); mapped.set(key, prepared.opened); stableAllocations = prepared.opened.allocations
    return prepared.opened
  }
  const intents = []
  for (const row of rows) {
    if (row.status !== 'unmapped-local') throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The legacy pending preparation has an unsupported status.')
    const intent = await openAccountJson(database, token, row.ref, AccountIntentSchema)
    if (intent.operationId !== row.id) throw new Error('Pending operation identity mismatch')
    intents.push({ row, intent })
  }
  intents.sort((a, b) => a.intent.localRevision - b.intent.localRevision)
  const portable: { base: OpenAccountWorkspace; target: OpenAccountWorkspace; value: MappedWorkspaceIntent; changes: readonly MappedWorkspaceChange[] }[] = []
  for (const { row, intent } of intents) {
    const base = await map(intent.base), target = await map(intent.target, base)
    const changes = mappedChanges(base, target)
    const prepared = await stageMappedWorkspaceIntent(database, token, { ...intent, kind: 'mapped-workspace-intent', portableGroupId: accountLocalId(), original: { base: intent.base, target: intent.target }, base: base.head, target: target.head, changes })
    portable.push({ base, target, value: prepared.value, changes })
    records.push(...prepared.records); replacements.push({ expected: row, replacement: { id: row.id, ref: cipherRef(prepared.record), status: 'mapped-local' } })
  }
  let workspace = await map(fence.head)
  let state = workspace.state
  for (const { base, target, value, changes } of portable) state = await retainPendingUnits(state, base, target, value.portableGroupId, changes)
  if (portable.length) {
    const complete = await prepareAccountWorkspace(database, token, state, workspace)
    records.push(...complete.records); workspace = complete.opened
  }
  assertActiveProfile(token)
  const active = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: workspace.head, records, replaceIntents: replacements, intentStatus: 'mapped-local' })
  return { fence: active, workspace }
}
