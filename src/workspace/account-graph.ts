import { readIncrementalMappedRoot } from './account-mapping-origin'
// Proof consumers must share their issuer's private registry through a static module edge
import { openAccountInheritedEvidence, assertAccountInheritedEvidenceOwner } from './account-evidence-snapshots'
import { admittedLocalHistoryTransition, type AdmittedLocalSnapshot, type LocalStoreAdapter } from './local-root'
import { checkpointRecordKey } from './source-bookkeeping'
import { z } from 'zod'
import { accountCleanupOnlyFailure, accountPreparationFailure, assertAccountCleanupJoinable, readAccountCleanupOnlyFailure, readAccountPreparationFailure, type AccountManagedCleanup } from './account-cleanup-attempt'
import { AccountWorkspaceGraphReader, type AccountWorkspaceReadLimits } from './account-graph-reader'
import type { AccountPreparationOwner } from './account-prepared-records'
import { maxDependencies } from '../account/protocol'
import { SourceBookkeepingSchema, validateSourceBookkeeping, sourceBookkeepingRefs } from './source-bookkeeping'
import { NativeHistorySchema, NativeLocalDataSchema } from '../interchange/native-schema'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import type { PlannerJournal } from './planner-journal'
import { capturedRecordReader, validateCapturedWorkspaceRecords, type CapturedRecordReader, type CapturedWorkspaceRecord } from './account-evidence'
import { stageAccountRetainingEdges, readAccountRetainingEdges, sameCipherRefs } from './account-retaining'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRecord, CipherRef } from '../persistence/account-database'
import { CipherRefSchema, accountLocalId, cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { captureWorkspaceDocuments, captureWorkspaceDocument, privateRecordKey, assembleWorkspace, WORKSPACE_DOCUMENT_KINDS, type WorkspaceState, type WorkspaceDocument, type BlobSource } from './documents'
import { decodeWorkspaceDocument, workspaceDocumentSource } from './document-codec'
import { openAccountSource, stageAccountSource } from './account-streams'
import { resolvedDomainClosureKeys } from './domain-closure'
import { blobIdentity, hashBlob, verifiedBlob } from './blobs'
import { buildIndexPages, INDEX_PAGE_ENTRIES, INDEX_PAGE_BYTES } from './directory'
import { encodeCatalogPayload, decodeCatalogPayload } from './catalog-codec'
import { archiveTypedReferences, validatedWorkspaceRetentionEdges, validatedLegacyLocalWorkspaceRetentionEdges } from './closure'

const entrySchema = z.object({ key: z.string(), kind: z.enum(WORKSPACE_DOCUMENT_KINDS), ref: CipherRefSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), retainingIndex: CipherRefSchema.optional(), sourceBookkeeping: SourceBookkeepingSchema.optional(), semanticDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
export type AccountWorkspaceEntry = z.infer<typeof entrySchema>
const pageSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema), children: z.array(CipherRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)
export const AccountWorkspaceRootV1Schema = z.object({ version: z.literal(1), kind: z.literal('local-workspace-graph'), sourceEvidenceVersion: z.literal(1).optional(), lineageId: z.string(), localRevision: z.number().int().nonnegative().safe(), localUpdatedAt: z.string(), plannerJournal: z.strictObject({ version: z.literal(1), index: CipherRefSchema, undoable: z.boolean() }).optional(), playthroughBookkeeping: z.object({ version: z.literal(1), index: CipherRefSchema }).strict().optional(), index: CipherRefSchema, allocations: CipherRefSchema, selections: z.object({ selectedPlaythroughId: z.string().optional(), planningGameSetupRevisionId: z.string().optional(), scenarios: z.record(z.string(), z.string()) }).strict() }).strict()
export const AccountWorkspaceRootSchema = AccountWorkspaceRootV1Schema
export const AccountWorkspaceRootV2Schema = AccountWorkspaceRootV1Schema.extend({ version: z.literal(2), inheritedEvidence: CipherRefSchema }).strict()
type WorkspaceRoot = z.infer<typeof AccountWorkspaceRootV1Schema> | z.infer<typeof AccountWorkspaceRootV2Schema>

const allocationSchema = z.object({ version: z.literal(1), entries: z.array(z.object({ key: z.string(), documentId: z.string() }).strict()), children: z.array(CipherRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)
const bookkeepingSchema = z.object({ version: z.literal(1), kind: z.literal('local-playthrough-bookkeeping'), entries: z.array(z.object({ id: z.string(), revision: z.number().int().nonnegative().safe(), updatedAt: z.string() }).strict()), children: z.array(CipherRefSchema) }).strict().refine(value => value.entries.length + value.children.length <= INDEX_PAGE_ENTRIES)

const sourceContextSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-source-context'), source: CipherRefSchema, index: CipherRefSchema })
const sourceContextPageSchema = z.strictObject({ version: z.literal(1), entries: z.array(SourceBookkeepingSchema), children: z.array(CipherRefSchema) }).refine(page => page.entries.length + page.children.length <= INDEX_PAGE_ENTRIES)

const journalEntrySchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('change'), value: NativeLocalDataSchema.shape.changes.element }), z.strictObject({ kind: z.literal('checkpoint'), ref: CipherRefSchema })])
const journalPageSchema = z.strictObject({ version: z.literal(1), entries: z.array(journalEntrySchema), children: z.array(CipherRefSchema) }).refine(page => page.entries.length + page.children.length <= INDEX_PAGE_ENTRIES)
const checkpointSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-journal-checkpoint'), value: NativeHistorySchema })

export interface OpenAccountWorkspace { readonly sourceEvidenceVersion?: 1; readonly formatVersion?: 2; readonly inheritedEvidence?: CipherRef; readonly state: WorkspaceState; readonly head: CipherRef; readonly lineageId: string; readonly entries: readonly AccountWorkspaceEntry[]; readonly allocations: readonly { key: string; documentId: string }[]; readonly payloads: ReadonlyMap<string, BlobSource>; readonly readCaptured: CapturedRecordReader }
export interface PreparedAccountWorkspace { readonly head: CipherRef; readonly records: readonly CipherRecord[]; readonly entries: readonly AccountWorkspaceEntry[]; readonly opened: OpenAccountWorkspace; readonly validatedEvidence?: import('./account-evidence-snapshots').AccountInheritedEvidence }

interface NativeHistorySources {
  readonly database: AccountDatabase; readonly token: ProfileToken; readonly head: CipherRef
  readonly entries: ReadonlyMap<string, { readonly entry: AccountWorkspaceEntry; readonly source: BlobSource }>
  readonly immutableValues?: ReadonlyMap<string, WorkspaceState['planner']['history'][number]>
}
const nativeHistorySources = new WeakMap<OpenAccountWorkspace, NativeHistorySources>()
export interface AccountHistoryReuse { readonly kind: 'managed-native-history-reuse' }
interface HistoryReuseData {
  readonly previous: OpenAccountWorkspace; readonly native: NativeHistorySources
  readonly local: ReturnType<typeof admittedLocalHistoryTransition>
}
const historyReuses = new WeakMap<AccountHistoryReuse, HistoryReuseData>()

// Copy entry metadata and source methods before exposing structural workspace views
// Neither a caller-mutated entry/map nor a lookalike OpenAccountWorkspace can mint reuse
function rememberHistory(workspace: OpenAccountWorkspace, database: AccountDatabase, token: ProfileToken, immutableValues?: NativeHistorySources['immutableValues']): OpenAccountWorkspace {
  const entries = new Map<string, { entry: AccountWorkspaceEntry; source: BlobSource }>()
  for (const entry of workspace.entries) if (entry.kind === 'history') {
    const source = workspace.payloads.get(entry.key)!
    const open = source.open.bind(source)
    const captured = structuredClone(entry)
    Object.freeze(captured.ref)
    if (captured.retainingIndex) Object.freeze(captured.retainingIndex)
    entries.set(entry.key, { entry: Object.freeze(captured), source: Object.freeze({ byteLength: source.byteLength, open }) })
  }
  nativeHistorySources.set(workspace, { database, token, head: { ...workspace.head }, entries, ...(immutableValues ? { immutableValues } : {}) })
  return workspace
}

export async function prepareAccountHistoryReuse(database: AccountDatabase, token: ProfileToken, before: AdmittedLocalSnapshot, after: AdmittedLocalSnapshot, adapter: LocalStoreAdapter, previous: OpenAccountWorkspace, headRevision: number): Promise<AccountHistoryReuse> {
  assertActiveProfile(token)
  const local = admittedLocalHistoryTransition(before, after, adapter), native = nativeHistorySources.get(previous)
  if (!native || native.database !== database || native.token !== token || !sameCipherRefs([native.head], [previous.head])) throw new Error('Foreign native history predecessor')
  // The durable mapping receipt/origin binds the managed before root to this exact native graph
  // IDs or payload digests alone cannot establish that cross-format association
  const mapped = await readIncrementalMappedRoot(database, token, { head: local.before, headRevision })
  local.check(); assertActiveProfile(token)
  if (!mapped || !sameCipherRefs([mapped], [native.head])) throw new Error('Native history predecessor changed')
  const capability: AccountHistoryReuse = Object.freeze({ kind: 'managed-native-history-reuse' })
  historyReuses.set(capability, { previous, native, local })
  return capability
}

function reusableHistory(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, previous?: OpenAccountWorkspace, capability?: AccountHistoryReuse) {
  const proof = capability && historyReuses.get(capability)
  if (capability && (!proof || proof.previous !== previous)) throw new Error('Foreign managed history reuse')
  proof?.local.check()
  const native = previous && nativeHistorySources.get(previous)
  if (proof && (native !== proof.native || state.planner.history !== proof.local.history)) throw new Error('Managed history input changed')
  if (native && (native.database !== database || native.token !== token || !sameCipherRefs([native.head], [previous!.head]))) throw new Error('Native history lifetime changed')
  const immutableValues = proof ? new Map(proof.local.history.map(value => [value.id, value])) : native?.immutableValues
  const entries = new Map<string, { readonly entry: AccountWorkspaceEntry; readonly source: BlobSource }>()
  for (const value of state.planner.history) {
    const key = privateRecordKey('history', value.id), saved = native?.entries.get(key)
    if (saved && (proof ? proof.local.unchanged.has(value.id) : immutableValues?.get(value.id) === value)) entries.set(key, saved)
  }
  // Only exact privately admitted immutable input values survive into a constructed output
  const values = new Map(state.planner.history.filter(value => immutableValues?.get(value.id) === value).map(value => [value.id, value]))
  return { entries, values, check: () => {
    proof?.local.check(); assertActiveProfile(token)
    if (proof && state.planner.history !== proof.local.history) throw new Error('Managed history input changed')
    if (native && !sameCipherRefs([native.head], [previous!.head])) throw new Error('Native history lifetime changed')
  } }
}

// Child commands advance these counters without changing the owner unit; keep its original full frame and refs
async function playthroughSemanticDigest(document: WorkspaceDocument): Promise<string | undefined> {
  if (document.kind !== 'playthrough') return undefined
  const value = document.value as unknown as { metadata: Record<string, unknown> }
  const { revision: _revision, updatedAt: _updatedAt, ...metadata } = value.metadata
  return hashBlob(workspaceDocumentSource({ ...document, value: { ...value, metadata } as WorkspaceDocument['value'] }))
}

async function readPages<T>(database: AccountDatabase, token: ProfileToken, root: CipherRef, schema: z.ZodType<{ version: 1; entries: T[]; children: CipherRef[] }>, retained?: (entry: T) => readonly CipherRef[], reader?: AccountWorkspaceGraphReader, association = false): Promise<T[]> {
  const result: T[] = [], visiting = new Set<string>(), visited = new Set<string>()
  async function visit(ref: CipherRef, depth = 0): Promise<void> {
    reader?.depth(depth)
    const key = JSON.stringify(ref)
    if (visiting.has(key)) throw new Error('Cyclic workspace index')
    if (visited.has(key)) throw new Error('Repeated workspace index page')
    visiting.add(key)
    const page = reader ? await reader.json(ref, schema, association) : await openAccountJson(database, token, ref, schema)
    if (new TextEncoder().encode(JSON.stringify(page)).length > INDEX_PAGE_BYTES) throw new Error('Workspace index exceeds page bound')
    if (retained || reader?.strict) {
      const record = reader ? await reader.record(ref) : await database.encryptedRevisions.get(ref.revisionId)
      const expected = [...new Map([...page.children, ...page.entries.flatMap(retained ?? (() => []))].map(ref => [blobIdentity(ref), ref])).values()]
      if (!record || !sameCipherRefs(record.descriptor.dependencies, expected)) throw new Error('Workspace page dependencies differ')
    }
    reader?.reserve([...page.children, ...page.entries.flatMap(retained ?? (() => []))])
    if (page.children.length) reader?.depth(depth + 1)
    result.push(...page.entries)
    for (const child of page.children) await visit(child, depth + 1)
    visiting.delete(key); visited.add(key)
  }
  await visit(root); return result
}

export async function openAccountWorkspace(database: AccountDatabase, token: ProfileToken, head: CipherRef, verified?: import('./account-evidence-snapshots').AccountInheritedEvidence): Promise<OpenAccountWorkspace> {
  const root = await openAccountJson(database, token, head, z.union([AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema]))
  if (root.version === 1) { if (verified) throw new Error('Selected account history association changed'); return openWorkspace(database, token, head) }
  if (root.sourceEvidenceVersion !== 1) throw new Error('Selected account history has no authenticated source evidence')
  // Strict admission proves the current encrypted graph independently of its reusable lazy sources
  // Archive validation is fresh or borrowed from the same live account/database preparation
  const admitted = await authenticateAccountWorkspaceSubtree(database, token, head, { version: 2 })
  try {
    const inherited = verified ?? await openAccountInheritedEvidence(database, token, root.inheritedEvidence)
    if (verified) {
      await assertAccountInheritedEvidenceOwner(verified, database, token)
      if (JSON.stringify(verified.root) !== JSON.stringify(root.inheritedEvidence)) throw new Error('Selected account history association changed')
    }
    try {
      if (JSON.stringify(admitted.root) !== JSON.stringify(root)) throw new Error('Selected account history changed during admission')
      const opened = await openWorkspace(database, token, head, false, true, undefined, 2)
      if (JSON.stringify(opened.inheritedEvidence) !== JSON.stringify(inherited.root)) throw new Error('Selected account history association changed')
      await admitted.recheck(); await inherited.check(); assertActiveProfile(token)
      return opened
    } finally { if (!verified) await inherited.dispose() }
  } finally { await admitted.dispose() }
}
export const openLegacyLocalAccountWorkspace = (database: AccountDatabase, token: ProfileToken, head: CipherRef) => openWorkspace(database, token, head, true)
export const sourceViewSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-source-view'), source: CipherRefSchema, view: CipherRefSchema })

async function openWorkspace(database: AccountDatabase, token: ProfileToken, head: CipherRef, legacyLocal = false, followView = true, reader?: AccountWorkspaceGraphReader, expectedVersion: 1 | 2 = 1, trace?: { root?: WorkspaceRoot; effectiveRoot?: CipherRef }, ancestry: { pending: Set<string>; completed: Set<string>; depth: number } = { pending: new Set(), completed: new Set(), depth: 0 }): Promise<OpenAccountWorkspace> {
  if (reader?.strict) {
    reader.depth(ancestry.depth)
    if (ancestry.pending.has(blobIdentity(head))) throw new Error('Cyclic workspace checkpoint ancestry')
    ancestry.pending.add(blobIdentity(head))
  }
  const root: WorkspaceRoot = reader ? expectedVersion === 2 ? await reader.json(head, AccountWorkspaceRootV2Schema, true) : await reader.json(head, AccountWorkspaceRootV1Schema, true) : expectedVersion === 2 ? await openAccountJson(database, token, head, AccountWorkspaceRootV2Schema) : await openAccountJson(database, token, head, AccountWorkspaceRootSchema)
  if (trace) { trace.root = root; trace.effectiveRoot = head }
  if (reader?.strict) {
    const record = await reader.record(head)
    // The checkpoint writer retains one prior full head; merge-style ancestry is not this format
    if (record.descriptor.parents.length > 1) throw new Error('Strict workspace root has multiple workspace predecessors')
    const children = [root.index, root.allocations, ...(root.playthroughBookkeeping ? [root.playthroughBookkeeping.index] : []), ...(root.plannerJournal ? [root.plannerJournal.index] : [])]
    const edges = [...children, ...(root.version === 2 ? [root.inheritedEvidence] : [])]
    const unique = [...new Map(edges.map(ref => [blobIdentity(ref), ref])).values()]
    if (!sameCipherRefs(record.descriptor.dependencies, unique)) throw new Error('Workspace root dependencies differ')
    // C has its own independent budget and authentication; the workspace counts only its own children
    reader.reserve(children)
  }
  if (followView && root.version === 1 && root.sourceEvidenceVersion === undefined) {
    const row = await (reader ? reader.observeRow(`source-view:${head.revisionId}`) : database.syncState.get(`source-view:${head.revisionId}`))
    if (row) {
      const saved = reader ? await reader.json(row.ref, sourceViewSchema, true) : await openAccountJson(database, token, row.ref, sourceViewSchema)
      const descriptor = reader ? await reader.record(row.ref) : await database.encryptedRevisions.get(row.ref.revisionId)
      if (!sameCipherRefs([saved.source], [head]) || !descriptor || !sameCipherRefs(descriptor.descriptor.dependencies, [saved.source, saved.view])) throw new Error('Foreign source migration view')
      const view = reader ? await reader.json(saved.view, AccountWorkspaceRootSchema, true) : await openAccountJson(database, token, saved.view, AccountWorkspaceRootSchema)
      if (view.sourceEvidenceVersion !== 1 || view.lineageId !== root.lineageId || view.localRevision !== root.localRevision || view.localUpdatedAt !== root.localUpdatedAt || JSON.stringify(view.selections) !== JSON.stringify(root.selections)) throw new Error('Source migration view identity changed')
      const opened = await openWorkspace(database, token, saved.view, false, false, reader, 1, trace, { ...ancestry, depth: ancestry.depth + 1 })
      const original = await readPages(database, token, root.index, pageSchema, reader?.strict ? entry => [entry.ref, ...(entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping) : [])] : undefined, reader)
      const semantic = (entries: readonly AccountWorkspaceEntry[]) => entries.filter(entry => !['retained-content', 'blob', 'blob-reference', 'tombstone'].includes(entry.kind)).map(entry => JSON.stringify([entry.key, entry.kind, entry.ref, entry.digest])).sort()
      if (JSON.stringify(semantic(original)) !== JSON.stringify(semantic(opened.entries))) throw new Error('Source migration changed an original semantic frame')
      ancestry.pending.delete(blobIdentity(head)); ancestry.completed.add(blobIdentity(head))
      return rememberHistory({ ...opened, head }, database, token)
    }
  }
  // Only authenticated unmarked v1 bytes can omit frozen recorded-party evidence
  // Runtime hints cannot relax modern v2 or the independently reopened effective view
  const frozenLocal = legacyLocal === true && root.version === 1 && root.sourceEvidenceVersion === undefined
  let entries = await readPages(database, token, root.index, pageSchema, reader?.strict ? entry => [entry.ref, ...(entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping) : [])] : undefined, reader)
  const compatibility = await (reader ? reader.observeRow(`source-context:${head.revisionId}`) : database.syncState.get(`source-context:${head.revisionId}`))
  if (compatibility) {
    const saved = reader ? await reader.json(compatibility.ref, sourceContextSchema, true) : await openAccountJson(database, token, compatibility.ref, sourceContextSchema)
    const descriptor = reader ? await reader.record(compatibility.ref) : await database.encryptedRevisions.get(compatibility.ref.revisionId)
    if (!sameCipherRefs([saved.source], [head]) || !descriptor || !sameCipherRefs(descriptor.descriptor.dependencies, [saved.source, saved.index])) throw new Error('Foreign source migration snapshot')
    const values = await readPages(database, token, saved.index, sourceContextPageSchema, value => [value.scenario, ...sourceBookkeepingRefs(value)], reader, true)
    if (new Set(values.map(value => value.scenarioKey)).size !== values.length) throw new Error('Duplicate source migration context')
    const contexts = new Map(values.map(value => [value.scenarioKey, value]))
    entries = entries.map(entry => { const sourceBookkeeping = contexts.get(entry.key); if (!sourceBookkeeping) return entry; if (entry.sourceBookkeeping || !sameCipherRefs([entry.ref], [sourceBookkeeping.scenario])) throw new Error('Conflicting source migration context'); contexts.delete(entry.key); return { ...entry, sourceBookkeeping } })
    if (contexts.size) throw new Error('Missing source migration scenario')
  }
  const allocations = await readPages(database, token, root.allocations, allocationSchema, undefined, reader)
  const documents: WorkspaceDocument[] = [], capturedDocuments = new Map<string, WorkspaceDocument>(), payloads = new Map<string, BlobSource>()
  const keys = new Set<string>(), ids = new Set<string>(), allocationMap = new Map<string, string>()
  for (const allocation of allocations) {
    if (allocationMap.has(allocation.key) || ids.has(allocation.documentId)) throw new Error('Contradictory workspace allocation')
    allocationMap.set(allocation.key, allocation.documentId); ids.add(allocation.documentId)
  }
  for (const entry of entries) {
    if (keys.has(entry.key) || allocationMap.get(entry.key) !== entry.ref.documentId) throw new Error('Workspace mapping identity mismatch')
    keys.add(entry.key)
    const source = reader ? await reader.source(entry.ref) : await openAccountSource(database, token, entry.ref)
    payloads.set(entry.key, source)
    // The decoder consumes EOF before exposing metadata, so digest and frame authentication
    // share one ciphertext pass without trusting cached plaintext or skipping later durable reads
    const document = await decodeWorkspaceDocument(verifiedBlob(source, entry.digest))
    if (document.key !== entry.key || document.kind !== entry.kind) throw new Error('Workspace frame key mismatch')
    const decoded = document.kind === 'catalog' ? { ...document, value: decodeCatalogPayload(document.value) as WorkspaceDocument['value'] } : document
    if (entry.semanticDigest !== undefined && entry.semanticDigest !== await playthroughSemanticDigest(decoded)) throw new Error('Workspace semantic digest mismatch')
    capturedDocuments.set(entry.key, decoded)
    if (decoded.kind !== 'tombstone') documents.push(decoded)
  }
  let journal: PlannerJournal | undefined
  if (root.plannerJournal) {
    const values = await readPages(database, token, root.plannerJournal.index, journalPageSchema, entry => entry.kind === 'checkpoint' ? [entry.ref] : [], reader)
    const changes = values.flatMap(entry => entry.kind === 'change' ? [entry.value] : []) as unknown as PlannerJournal['changes']
    const checkpoints = []
    for (const entry of values) if (entry.kind === 'checkpoint') {
      if (reader?.strict) {
        const record = await reader.record(entry.ref), rootRecord = await reader.record(head)
        const expected = [root.index, ...rootRecord.descriptor.parents.map(revisionId => ({ documentId: head.documentId, revisionId }))]
        if (!sameCipherRefs(record.descriptor.dependencies, expected)) throw new Error('Workspace checkpoint dependencies differ')
        // Checkpoint ancestry retains the exact previous workspace head, not refs inferred from native history
        for (const previous of expected.slice(1)) {
          reader.depth(ancestry.depth + 1)
          const prior = await reader.json(previous, z.union([AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema]), true)
          if (prior.lineageId !== root.lineageId) throw new Error('Foreign workspace checkpoint predecessor')
          if (!ancestry.completed.has(blobIdentity(previous))) await openWorkspace(database, token, previous, false, true, reader, prior.version, undefined, { ...ancestry, depth: ancestry.depth + 1 })
        }
      }
      // Native history envelopes retain their existing body limit; index wrappers stay page-bounded
      checkpoints.push((reader ? await reader.json(entry.ref, checkpointSchema, false, NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes) : await openAccountJson(database, token, entry.ref, checkpointSchema)).value)
    }
    journal = { version: 1, changes, checkpoints: checkpoints as unknown as PlannerJournal['checkpoints'], undoable: root.plannerJournal.undoable }
  }
  const bookkeeping = root.playthroughBookkeeping ? await readPages(database, token, root.playthroughBookkeeping.index, bookkeepingSchema, undefined, reader) : undefined
  const assembled = assembleWorkspace(documents, root.localRevision, journal, new Map(bookkeeping?.map(({ id, ...value }) => [id, value])))
  const local = assembled.planner.localData
  if (reader?.strict && (root.selections.selectedPlaythroughId !== undefined && !local.playthroughs[root.selections.selectedPlaythroughId]
    || root.selections.planningGameSetupRevisionId !== undefined && !local.gameSetups[root.selections.planningGameSetupRevisionId]
    || Object.entries(root.selections.scenarios).some(([id, scenario]) => !local.playthroughs[id]?.scenarios[scenario]))) throw new Error('Unknown workspace selection')
  if (bookkeeping && (new Set(bookkeeping.map(entry => entry.id)).size !== bookkeeping.length || JSON.stringify(bookkeeping.map(entry => entry.id).sort()) !== JSON.stringify(Object.keys(local.playthroughs).sort()))) throw new Error('Playthrough bookkeeping identity mismatch')
  const bookkeepingById = new Map(bookkeeping?.map(({ id, ...value }) => [id, value]))
  // These selectors live only in the encrypted local cache root, never mapped publication records
  const localData = { ...local, updatedAt: root.localUpdatedAt, ...(root.selections.selectedPlaythroughId && local.playthroughs[root.selections.selectedPlaythroughId] ? { selectedPlaythroughId: root.selections.selectedPlaythroughId } : {}), ...(root.selections.planningGameSetupRevisionId && local.gameSetups[root.selections.planningGameSetupRevisionId] ? { planningGameSetupRevisionId: root.selections.planningGameSetupRevisionId } : {}), playthroughs: Object.fromEntries(Object.entries(local.playthroughs).map(([id, playthrough]) => [id, { ...playthrough, ...bookkeepingById.get(id), ...(root.selections.scenarios[id] && playthrough.scenarios[root.selections.scenarios[id]] ? { activeScenarioId: root.selections.scenarios[id] } : {}) }])) } as typeof local
  const state = { ...assembled, planner: { ...assembled.planner, localData } }
  const retaining = await (frozenLocal ? validatedLegacyLocalWorkspaceRetentionEdges(state) : validatedWorkspaceRetentionEdges(state))
  const captured = new Map<string, CapturedWorkspaceRecord>()
  for (const entry of entries) {
    const record = reader ? await reader.record(entry.ref) : await database.encryptedRevisions.get(entry.ref.revisionId)
    if (!record) throw new Error('Missing workspace retaining descriptor')
    const dependencies = entry.retainingIndex ? await readAccountRetainingEdges(database, token, entry.key, entry.retainingIndex, reader?.owner, reader) : record.descriptor.dependencies
    if (entry.retainingIndex && !sameCipherRefs(record.descriptor.dependencies, [entry.retainingIndex])) throw new Error('Workspace retaining index mismatch')
    const document = capturedDocuments.get(entry.key)!
    captured.set(blobIdentity(entry.ref), { ref: entry.ref, document, source: payloads.get(entry.key)!, digest: entry.digest, dependencies, ...(entry.sourceBookkeeping ? { sourceBookkeeping: entry.sourceBookkeeping } : {}), ...(entry.retainingIndex ? { retainingIndex: entry.retainingIndex } : {}) })
  }
  const readCaptured = capturedRecordReader(database, token, captured, undefined, reader?.owner, reader)
  // ID-only links retain their captured owner evidence; the assembled live state was validated separately
  await validateCapturedWorkspaceRecords(readCaptured, entries.map(entry => entry.ref), allocationMap, retaining, frozenLocal, reader)
  assertActiveProfile(token)
  ancestry.pending.delete(blobIdentity(head)); ancestry.completed.add(blobIdentity(head))
  return rememberHistory({ state, head, sourceEvidenceVersion: root.sourceEvidenceVersion, ...(root.version === 2 ? { formatVersion: 2 as const, inheritedEvidence: root.inheritedEvidence } : {}), lineageId: root.lineageId, entries, allocations, payloads, readCaptured }, database, token)
}

export interface AuthenticatedAccountWorkspaceSubtree {
  readonly root: WorkspaceRoot
  readonly originalRoot: CipherRef
  readonly effectiveRoot: CipherRef
  readonly workspace: OpenAccountWorkspace
  readonly observations: () => readonly { readonly id: string; readonly row: import('../persistence/account-database').EncryptedSyncState | undefined }[]
  recordObservations(): readonly CipherRecord[]
  recheck(): Promise<void>
  dispose(): Promise<void>
}

// The expected version constrains decrypted bytes; the returned subtree has no inherited evidence authority
export async function authenticateAccountWorkspaceSubtree(database: AccountDatabase, token: ProfileToken, head: CipherRef, options: { owner?: AccountPreparationOwner; version: 1 | 2; legacyLocal?: true; signal?: AbortSignal; limits?: Partial<AccountWorkspaceReadLimits>; cleanup?: AccountManagedCleanup }): Promise<AuthenticatedAccountWorkspaceSubtree> {
  const reader = new AccountWorkspaceGraphReader(database, token, options.owner, options.version === 2, options.signal, options.limits)
  // The original reader owns cancellation before authentication can suspend or reject
  const cleanup = options.cleanup?.reader(reader)
  const dispose = async () => {
    if (!cleanup) return reader.dispose()
    const result = await cleanup.request()
    if (result.status === 'failed') throw accountCleanupOnlyFailure(cleanup, result)
  }
  const trace: { root?: WorkspaceRoot; effectiveRoot?: CipherRef } = {}
  try {
    const workspace = await openWorkspace(database, token, head, options.legacyLocal === true, true, reader, options.version, trace)
    await reader.recheck()
    reader.seal()
    return { root: trace.root!, originalRoot: head, effectiveRoot: trace.effectiveRoot!, workspace, observations: () => reader.observations(), recordObservations: () => reader.recordObservations(), recheck: () => reader.recheck(), dispose }
  } catch (error) {
    if (cleanup) {
      const inner = readAccountPreparationFailure(error)
      const cleanupOnly = readAccountCleanupOnlyFailure(error)
      const primary = inner ? inner.primary : error
      const local = await cleanup.request()
      if (cleanupOnly) {
        assertAccountCleanupJoinable(cleanup, cleanupOnly.cleanup)
        if (local.status === 'succeeded') throw error
      }
      const join = inner || cleanupOnly ? options.cleanup!.group([cleanup, (inner ?? cleanupOnly)!.cleanup]) : cleanup
      const result = join === cleanup ? local : await join.request()
      if (result.status === 'failed') {
        if (cleanupOnly) throw accountCleanupOnlyFailure(join, result, error as Error)
        throw accountPreparationFailure(primary, join)
      }
      if (cleanupOnly) throw error
      throw primary
    }
    try { await reader.dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Workspace authentication and reader cleanup failed', { cause: error }) }
    throw error
  }
}

export interface StageAccountWorkspaceGraphOptions {
  readonly owner: AccountPreparationOwner
  readonly semanticBase?: OpenAccountWorkspace
  readonly stableAllocations?: OpenAccountWorkspace['allocations']
  readonly rootFormat: { readonly version: 1 } | { readonly version: 2; readonly inheritedEvidence: CipherRef }
}

// A structural evidence ref is only an encrypted edge; D's composite preparer authenticates its provenance
export async function stageAccountWorkspaceGraph(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, options: StageAccountWorkspaceGraphOptions): Promise<Omit<PreparedAccountWorkspace, 'opened'>> {
  const { opened: _draft, ...staged } = await prepareWorkspace(database, token, state, options.semanticBase, options.stableAllocations ?? options.semanticBase?.allocations ?? [], options.owner, options.rootFormat)
  return staged
}

export async function prepareAccountWorkspace(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, previous?: OpenAccountWorkspace, stableAllocations: OpenAccountWorkspace['allocations'] = previous?.allocations ?? [], historyReuse?: AccountHistoryReuse): Promise<PreparedAccountWorkspace> {
  if (previous?.formatVersion === 2 && !previous.inheritedEvidence) throw new Error('Selected account history is incomplete')
  return prepareWorkspace(database, token, state, previous, stableAllocations, undefined, previous?.formatVersion === 2 ? { version: 2, inheritedEvidence: previous.inheritedEvidence! } : { version: 1 }, historyReuse)
}
export async function prepareAccountWorkspaceWithEvidence(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, inherited: import('./account-evidence-snapshots').PreparedAccountInheritedEvidence, previous?: OpenAccountWorkspace, stableAllocations: OpenAccountWorkspace['allocations'] = previous?.allocations ?? [], historyReuse?: AccountHistoryReuse): Promise<PreparedAccountWorkspace> {
  await assertAccountInheritedEvidenceOwner(inherited.handle, database, token)
  const prepared = await prepareWorkspace(database, token, state, previous, stableAllocations, inherited.owner, { version: 2, inheritedEvidence: inherited.root }, historyReuse)
  await assertAccountInheritedEvidenceOwner(inherited.handle, database, token)
  return { ...prepared, records: [...inherited.records, ...prepared.records], validatedEvidence: inherited.handle }
}
export async function prepareAccountWorkspaceWithExistingEvidence(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, input: CipherRef | import('./account-evidence-snapshots').AccountInheritedEvidence, previous?: OpenAccountWorkspace, stableAllocations: OpenAccountWorkspace['allocations'] = previous?.allocations ?? [], historyReuse?: AccountHistoryReuse): Promise<PreparedAccountWorkspace> {
  // A borrowed proof belongs to its caller; private registration, account and lifetime checks remain mandatory
  const borrowed = 'origin' in input
  const inherited = borrowed ? input : await openAccountInheritedEvidence(database, token, input)
  if (borrowed) await assertAccountInheritedEvidenceOwner(inherited, database, token)
  const inheritedEvidence = inherited.root
  try {
    if (previous?.inheritedEvidence) {
      const { accountEvidenceContains } = await import('./account-evidence-union')
      if (!await accountEvidenceContains(database, token, inheritedEvidence, previous.inheritedEvidence)) throw new Error('Account successor cannot discard historical originals')
    }
    const prepared = await prepareWorkspace(database, token, state, previous, stableAllocations, undefined, { version: 2, inheritedEvidence }, historyReuse)
    await inherited.check()
    return borrowed ? { ...prepared, validatedEvidence: inherited } : prepared
  } finally { if (!borrowed) await inherited.dispose() }
}

async function prepareWorkspace(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, previous?: OpenAccountWorkspace, stableAllocations: OpenAccountWorkspace['allocations'] = previous?.allocations ?? [], owner?: AccountPreparationOwner, rootFormat: StageAccountWorkspaceGraphOptions['rootFormat'] = { version: 1 }, historyReuse?: AccountHistoryReuse): Promise<PreparedAccountWorkspace> {
  assertActiveProfile(token)
  owner?.check()
  const retaining = await validatedWorkspaceRetentionEdges(state)
  const history = reusableHistory(database, token, state, previous, historyReuse)
  // Retention validation above includes the complete workspace validation for this exact input
  const documents = captureWorkspaceDocuments(state, (kind, key, value) => kind === 'history' && history.entries.has(key)
    ? { version: 1, kind, key, value: value as WorkspaceDocument['value'] }
    : captureWorkspaceDocument(kind, key, value))
  const records: CipherRecord[] = [], entries: AccountWorkspaceEntry[] = [], payloads = new Map<string, BlobSource>()
  const captured = new Map<string, CapturedWorkspaceRecord>()
  const prior = new Map(previous?.entries.map(entry => [entry.key, entry]) ?? [])
  // Allocation reuse confers identity, not ancestry; only the exact semantic base supplies parents
  const allocations = new Map(stableAllocations.map(entry => [entry.key, entry.documentId]))
  const bindings = new Map<string, CipherRef>(), recordBindings = new Map<string, CipherRef>()
  // Bodies precede file/source metadata so descriptor retention uses actual account-owned bindings
  const sourceByKey = new Map(documents.map(document => [document.key, document]))
  // This captured document set is fixed for preparation, so repeated traversal reuses only its typed edge keys
  const domainEdges = new Map(documents.map(document => [document.key, resolvedDomainClosureKeys(document, sourceByKey)]))
  const ordered: WorkspaceDocument[] = [], visiting = new Set<string>(), visited = new Set<string>()
  const references = (document: WorkspaceDocument) => document.kind === 'blob' ? retaining.get((JSON.parse(document.key) as string[])[1]) ?? [] : archiveTypedReferences(document.kind, document.value)
  function order(document: WorkspaceDocument) {
    if (visiting.has(document.key)) throw new Error('Cyclic workspace retaining edges')
    if (visited.has(document.key)) return
    visiting.add(document.key)
    for (const ref of references(document)) {
      const dependency = sourceByKey.get(JSON.stringify(['blob', blobIdentity(ref)]))
      if (!dependency) throw new Error('Missing workspace retaining body')
      order(dependency)
    }
    for (const key of domainEdges.get(document.key)!) { const dependency = sourceByKey.get(key); if (!dependency) throw new Error('Missing typed workspace record'); order(dependency) }
    visiting.delete(document.key); visited.add(document.key); ordered.push(document)
  }
  for (const document of documents) order(document)
  for (const original of ordered) {
    const live = original.kind === 'workspace-identity' ? { ...original, value: { ...original.value as object, localData: Object.fromEntries(Object.entries((original.value as unknown as { localData: object }).localData).filter(([key]) => key !== 'updatedAt')) } as WorkspaceDocument['value'] } : original
    const document = live.kind === 'catalog' ? { ...original, value: encodeCatalogPayload(live.value as unknown as import('../domain/types').CatalogSnapshot) as WorkspaceDocument['value'] } : live
    const retainedHistory = history.entries.get(document.key)
    let source = retainedHistory?.source ?? workspaceDocumentSource(document), digest = retainedHistory?.entry.digest ?? await hashBlob(source)
    const old = retainedHistory?.entry ?? prior.get(document.key), semanticDigest = await playthroughSemanticDigest(original)
    const oldSemanticDigest = old && semanticDigest !== undefined ? old.semanticDigest ?? await playthroughSemanticDigest((await previous!.readCaptured(old.ref)).document) : undefined
    const reuse = old && (old.digest === digest || semanticDigest !== undefined && semanticDigest === oldSemanticDigest)
    let ref: CipherRef, retainingIndex = old?.retainingIndex
    let sourceBookkeeping = reuse ? old.sourceBookkeeping : undefined
    if (reuse) { ref = { ...old.ref }; digest = old.digest; source = retainedHistory?.source ?? previous!.payloads.get(document.key)! }
    else {
      const dependencies = references(original).map(portable => {
        const binding = bindings.get(blobIdentity(portable))
        if (!binding) throw new Error('Missing encrypted workspace body binding')
        return binding
      })
      for (const key of domainEdges.get(original.key)!) { const ref = recordBindings.get(key); if (!ref) throw new Error('Missing encrypted typed record binding'); dependencies.push(ref) }
      const uniqueDependencies = [...new Map(dependencies.map(ref => [JSON.stringify(ref), ref])).values()]
      const allocation = allocations.get(document.key)
      // Retired keys keep their transport identity; only an actual new unit receives a new allocation
      const retaining = await stageAccountRetainingEdges(database, token, document.key, uniqueDependencies, records, owner)
      retainingIndex = retaining.retainingIndex
      const staged = await stageAccountSource(database, token, source, retaining.dependencies, old?.ref, allocation, owner)
      records.push(staged); ref = cipherRef(staged)
      captured.set(blobIdentity(ref), { ref, document: original, source, digest, dependencies: uniqueDependencies, ...(retainingIndex ? { retainingIndex } : {}) })
    }
    if (!reuse && original.kind === 'scenario') {
      const scenario = original.value as unknown as import('../domain/types').Playthrough['scenarios'][string]
      if (scenario.baseline.kind === 'recordedParty') {
        const ownerId = (JSON.parse(original.key) as string[])[1], ownerKey = JSON.stringify(['playthrough', ownerId])
        const ownerRef = recordBindings.get(ownerKey)!
        const reader = capturedRecordReader(database, token, captured, previous?.readCaptured, owner)
        const capturedOwner = await reader(ownerRef), context = state.planner.localData.playthroughs[ownerId]
        sourceBookkeeping = SourceBookkeepingSchema.parse({ version: 1, kind: 'recorded-party-source', origin: 'local-capture', scenarioDependencies: 'complete-v1', baselineCheckpoints: [...new Set(Object.values(scenario.baseline.assignments).map(checkpointRecordKey))].map(key => { return { key, ref: recordBindings.get(key)! } }), scenarioKey: original.key, scenario: ref, ownerKey, owner: ownerRef, revision: context.revision, updatedAt: context.updatedAt })
        validateSourceBookkeeping(sourceBookkeeping, { ref, document: original }, capturedOwner)
        captured.set(blobIdentity(ref), { ...captured.get(blobIdentity(ref))!, sourceBookkeeping })
      }
    }
    payloads.set(document.key, source)
    recordBindings.set(document.key, ref)
    allocations.set(document.key, ref.documentId)
    if (document.kind === 'blob') bindings.set((JSON.parse(document.key) as string[])[1], ref)
    entries.push({ key: document.key, kind: document.kind, ref, digest, ...(sourceBookkeeping ? { sourceBookkeeping } : {}), ...(retainingIndex ? { retainingIndex } : {}), ...(semanticDigest ? { semanticDigest } : {}) })
  }
  // Deletion advances the established document rather than discarding its allocation or parent
  const present = new Set(entries.map(entry => entry.key))
  for (const old of previous?.entries ?? []) if (!present.has(old.key)) {
    if (old.kind === 'tombstone') { entries.push(old); payloads.set(old.key, previous!.payloads.get(old.key)!); continue }
    const document: WorkspaceDocument = { version: 1, kind: 'tombstone', key: old.key, value: { version: 1, kind: 'tombstone', privateKey: old.key } }
    const source = workspaceDocumentSource(document)
    const digest = await hashBlob(source)
    payloads.set(old.key, source)
    const record = await stageAccountSource(database, token, source, [], old.ref, undefined, owner)
    captured.set(blobIdentity(cipherRef(record)), { ref: cipherRef(record), document, source, digest, dependencies: [] })
    records.push(record); entries.push({ key: old.key, kind: 'tombstone', ref: cipherRef(record), digest })
  }
  const index = await buildIndexPages(entries, async page => { const record = await stageAccountJson(database, token, page, [...new Map([...page.children, ...page.entries.flatMap(entry => [entry.ref, ...(entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping) : [])])].map(ref => [blobIdentity(ref), ref])).values()], undefined, owner); records.push(record); return cipherRef(record) }, page => page.entries.reduce((count, entry) => count + 1 + (entry.sourceBookkeeping ? sourceBookkeepingRefs(entry.sourceBookkeeping).length : 0), page.children.length) > maxDependencies ? INDEX_PAGE_BYTES + 1 : new TextEncoder().encode(JSON.stringify(page)).length)
  const allocationIndex = await buildIndexPages([...allocations].map(([key, documentId]) => ({ key, documentId })), async page => { const record = await stageAccountJson(database, token, page, page.children, undefined, owner); records.push(record); return cipherRef(record) })
  // Current native counters are local projection evidence; immutable semantic frames keep their original counters
  const bookkeepingIndex = await buildIndexPages(Object.entries(state.planner.localData.playthroughs).map(([id, value]) => ({ id, revision: value.revision, updatedAt: value.updatedAt })), async page => { const record = await stageAccountJson(database, token, bookkeepingSchema.parse({ ...page, kind: 'local-playthrough-bookkeeping' }), page.children, undefined, owner); records.push(record); return cipherRef(record) }, page => new TextEncoder().encode(JSON.stringify({ ...page, kind: 'local-playthrough-bookkeeping' })).length)
  let plannerJournal: { version: 1; index: CipherRef; undoable: boolean } | undefined
  if (state.planner.journal) {
    const journalEntries: z.infer<typeof journalEntrySchema>[] = state.planner.journal.changes.map(value => journalEntrySchema.parse({ kind: 'change', value }))
    for (const value of state.planner.journal.checkpoints) {
      const record = await stageAccountJson(database, token, { version: 1, kind: 'local-journal-checkpoint', value }, [index, ...(previous ? [previous.head] : [])], undefined, owner)
      records.push(record); journalEntries.push({ kind: 'checkpoint', ref: cipherRef(record) })
    }
    const journalIndex = await buildIndexPages(journalEntries, async page => { const record = await stageAccountJson(database, token, page, [...page.children, ...page.entries.flatMap(entry => entry.kind === 'checkpoint' ? [entry.ref] : [])], undefined, owner); records.push(record); return cipherRef(record) })
    plannerJournal = { version: 1, index: journalIndex, undoable: state.planner.journal.undoable }
  }
  const root = (rootFormat.version === 2 ? AccountWorkspaceRootV2Schema : AccountWorkspaceRootV1Schema).parse({ ...rootFormat, kind: 'local-workspace-graph', sourceEvidenceVersion: 1, lineageId: previous?.lineageId ?? accountLocalId(), localRevision: state.planner.localData.revision, localUpdatedAt: state.planner.localData.updatedAt, ...(plannerJournal ? { plannerJournal } : {}), playthroughBookkeeping: { version: 1, index: bookkeepingIndex }, index, allocations: allocationIndex, selections: { selectedPlaythroughId: state.planner.localData.selectedPlaythroughId, planningGameSetupRevisionId: state.planner.localData.planningGameSetupRevisionId, scenarios: Object.fromEntries(Object.entries(state.planner.localData.playthroughs).flatMap(([id, value]) => value.activeScenarioId ? [[id, value.activeScenarioId]] : [])) } })
  const record = await stageAccountJson(database, token, root, [index, allocationIndex, bookkeepingIndex, ...(plannerJournal ? [plannerJournal.index] : []), ...(root.version === 2 ? [root.inheritedEvidence] : [])], previous?.head, owner)
  records.push(record)
  assertActiveProfile(token)
  history.check()
  return { head: cipherRef(record), records, entries, opened: rememberHistory({ head: cipherRef(record), state, sourceEvidenceVersion: 1, ...(root.version === 2 ? { formatVersion: 2 as const, inheritedEvidence: root.inheritedEvidence } : {}), lineageId: root.lineageId, entries, payloads, readCaptured: capturedRecordReader(database, token, captured, previous?.readCaptured, owner), allocations: [...allocations].map(([key, documentId]) => ({ key, documentId })) }, database, token, history.values) }
}

// A compatibility capture is local authority from this exact validated saved snapshot, never a remote-head repair
export async function prepareLegacySourceContext(database: AccountDatabase, token: ProfileToken, workspace: OpenAccountWorkspace): Promise<{ opened: OpenAccountWorkspace; records: CipherRecord[]; capture?: import('../persistence/account-database').EncryptedSyncState }> {
  const values = [], records: CipherRecord[] = []
  for (const entry of workspace.entries) if (entry.kind === 'scenario' && !entry.sourceBookkeeping) {
    const scenario = await workspace.readCaptured(entry.ref)
    const value = scenario.document.value as unknown as import('../domain/types').Playthrough['scenarios'][string]
    if (value.baseline.kind !== 'recordedParty') continue
    const ownerId = (JSON.parse(entry.key) as string[])[1], ownerKey = JSON.stringify(['playthrough', ownerId])
    const owner = workspace.entries.find(entry => entry.key === ownerKey)
    const context = workspace.state.planner.localData.playthroughs[ownerId]
    if (!owner || !context) throw new Error('Legacy source context is unavailable')
    const evidence = SourceBookkeepingSchema.parse({ version: 1, kind: 'recorded-party-source', origin: 'legacy-local-migration', scenarioDependencies: 'legacy-s02', baselineCheckpoints: [...new Set(Object.values(value.baseline.assignments).map(checkpointRecordKey))].map(key => { const ref = workspace.entries.find(entry => entry.key === key)?.ref; if (!ref) throw new Error('Missing legacy baseline checkpoint'); return { key, ref } }), scenarioKey: entry.key, scenario: entry.ref, ownerKey, owner: owner.ref, revision: context.revision, updatedAt: context.updatedAt })
    validateSourceBookkeeping(evidence, scenario, await workspace.readCaptured(owner.ref)); values.push(evidence)
  }
  if (!values.length) return { records, opened: workspace }
  const index = await buildIndexPages(values, async page => {
    const dependencies = [...new Map([...page.children, ...page.entries.flatMap(value => [value.scenario, ...sourceBookkeepingRefs(value)])].map(ref => [blobIdentity(ref), ref])).values()]
    const record = await stageAccountJson(database, token, page, dependencies)
    records.push(record); return cipherRef(record)
  }, page => page.entries.reduce((count, entry) => count + 1 + sourceBookkeepingRefs(entry).length, page.children.length) > maxDependencies ? INDEX_PAGE_BYTES + 1 : new TextEncoder().encode(JSON.stringify(page)).length)
  const record = await stageAccountJson(database, token, { version: 1, kind: 'local-source-context', source: workspace.head, index }, [workspace.head, index])
  records.push(record)
  const byRef = new Map(values.map(value => [blobIdentity(value.scenario), value]))
  const opened: OpenAccountWorkspace = { ...workspace, entries: workspace.entries.map(entry => ({ ...entry, ...(byRef.has(blobIdentity(entry.ref)) ? { sourceBookkeeping: byRef.get(blobIdentity(entry.ref))! } : {}) })), readCaptured: async ref => { const value = await workspace.readCaptured(ref), sourceBookkeeping = byRef.get(blobIdentity(ref)); return sourceBookkeeping ? { ...value, sourceBookkeeping } : value } }
  return { records, opened, capture: { id: `source-context:${workspace.head.revisionId}`, ref: cipherRef(record) } }
}
