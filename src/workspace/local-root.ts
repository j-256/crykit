import { immutableHistory, immutableHistoryEndpoint, parseImmutableHistory } from './history-admission'
import { WORKSPACE_STARTUP_PHASE } from '../diagnostics/workspace-startup'
import { z } from 'zod'
import type { CipherRef } from '../persistence/account-database'
import { asId, asTimestamp } from '../domain/core'
import type { JsonValue, LocalData, ChangeEntry } from '../domain/types'
import type { BlobSource, WorkspaceDocument, WorkspaceState } from './documents'
import { assembleWorkspace, captureWorkspaceDocuments, isBlobSource, privateRecordKey, WORKSPACE_DOCUMENT_KINDS } from './documents'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import { validateWorkspace } from './validation'
import { validateWorkspaceClosure, inspectWorkspaceClosure } from './closure'
import { compactModCatalog } from '../domain/mod-layers'
import { immutableCatalogSnapshot, isImmutableCatalogSnapshot, immutableExpandedModCatalogs } from '../interchange/native'
import { NativeHistorySchema, NativeLocalDataSchema } from '../interchange/native-schema'
import { capturedWorkspaceBody, decodeWorkspaceDocument, workspaceDocumentSource } from './document-codec'
import { decodeCatalogPayload, encodeCatalogPayload } from './catalog-codec'
import { blobIdentity, hashBlob, memoryBlob, readBlob, verifiedBlob } from './blobs'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { maxDocumentBytes } from '../account/protocol'
import { admittedLocalIndexRefs, prepareLocalIndex, readLocalIndex, type LocalIndex } from './local-index'
import { prepareLocalHistory, type LocalHistory } from './local-history'

export type LocalRecordRef = CipherRef
export interface LocalStoreAdapter {
  read(ref: LocalRecordRef): Promise<BlobSource>
  stage(operationId: string, source: BlobSource, dependencies: readonly LocalRecordRef[], previous?: LocalRecordRef): Promise<LocalRecordRef>
}
export interface CapturedLocalLifetime { check(): void; assertCurrent(): Promise<void> }
const refSchema = z.strictObject({ documentId: z.string().min(1), revisionId: z.string().min(1) })
const integer = z.number().int().nonnegative().safe()
export const LocalWorkspaceRootV3Schema = z.strictObject({
  version: z.literal(3), kind: z.literal('incremental-local-workspace'), lineageId: z.string().min(1),
  localRevision: integer, localUpdatedAt: z.string(), contentIndex: refSchema, allocationIndex: refSchema,
  bookkeepingIndex: refSchema, operativeChanges: refSchema, destinationChanges: refSchema, hasSavedChanges: z.boolean(), historyIndex: refSchema, inheritedEvidence: refSchema,
  journal: z.strictObject({ version: z.literal(1), checkpoints: refSchema, undoable: z.boolean() }).optional(),
  selections: z.strictObject({ selectedPlaythroughId: z.string().optional(), planningGameSetupRevisionId: z.string().optional(), scenarios: z.record(z.string(), z.string()) }),
})
const LocalEndpointSchema = z.strictObject({ version: z.literal(1), codec: z.literal('workspace-native-1'), contentIndex: refSchema, bookkeepingIndex: refSchema, operativeChanges: refSchema, localRevision: integer, localUpdatedAt: z.string(), selections: LocalWorkspaceRootV3Schema.shape.selections })
const LocalHistoryTransitionSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-history-transition'), metadata: NativeHistorySchema.omit({ before: true, after: true }), before: LocalEndpointSchema, after: LocalEndpointSchema })
export type LocalWorkspaceRootV3 = z.infer<typeof LocalWorkspaceRootV3Schema>
const entrySchema = z.strictObject({ key: z.string().min(1), kind: z.enum(WORKSPACE_DOCUMENT_KINDS), ref: refSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) })
export type LocalWorkspaceEntry = z.infer<typeof entrySchema>
const allocationSchema = z.strictObject({ key: z.string(), documentId: z.string() })
const bookkeepingSchema = z.strictObject({ id: z.string(), revision: integer, updatedAt: z.string() })
const historyEntrySchema = z.strictObject({ id: z.string(), ref: refSchema })
export interface AdmittedLocalSnapshot { readonly head: LocalRecordRef; readonly root: LocalWorkspaceRootV3; readonly state: WorkspaceState; readonly entries: readonly LocalWorkspaceEntry[]; readonly destinationChanges: readonly ChangeEntry[] }
interface CapturedDocument { readonly input: unknown; readonly document: WorkspaceDocument }
interface SnapshotData {
  readonly adapter: LocalStoreAdapter; readonly lifetime: CapturedLocalLifetime
  readonly destination: LocalIndex<ChangeEntry>
  readonly documents: ReadonlyMap<string, CapturedDocument>; readonly index: LocalIndex<LocalWorkspaceEntry>
  readonly allocations: LocalIndex<z.infer<typeof allocationSchema>>; readonly bookkeeping: LocalIndex<z.infer<typeof bookkeepingSchema>>
  readonly history: LocalIndex<z.infer<typeof historyEntrySchema>>; readonly journal?: LocalHistory; readonly originals?: LocalHistory; readonly journalIndex?: LocalIndex<z.infer<typeof historyEntrySchema>>
}
const snapshots = new WeakMap<AdmittedLocalSnapshot, SnapshotData>()
export function admittedLocalDestinationChanges(snapshot: AdmittedLocalSnapshot): readonly ChangeEntry[] {
  const admitted = snapshots.get(snapshot)
  if (!admitted) throw new Error('Foreign local destination admission')
  return admitted.destination.entries
}

// Only a snapshot produced by this module can exempt immutable unchanged dependencies
// The storage adapter must pair these refs with the exact selected predecessor in its head CAS
export function admittedLocalReferences(snapshot: AdmittedLocalSnapshot, adapter: LocalStoreAdapter): ReadonlySet<string> {
  const data = snapshots.get(snapshot)
  if (!data || data.adapter !== adapter) throw new Error('Foreign local admission')
  return new Set([snapshot.head, snapshot.root.inheritedEvidence, ...snapshot.entries.map(entry => entry.ref), ...data.history.entries.map(entry => entry.ref), ...(data.journalIndex?.entries.map(entry => entry.ref) ?? []), ...[data.index, data.allocations, data.bookkeeping, data.history, data.destination, ...(data.journalIndex ? [data.journalIndex] : [])].flatMap(index => admittedLocalIndexRefs(index))].map(blobIdentity))
}
// Publication may omit duplicate operative checkpoints only when authenticated history retains
// the same physical frames; IDs or equal decoded values cannot establish this coverage
export function localJournalCoveredByHistory(snapshot: AdmittedLocalSnapshot, adapter: LocalStoreAdapter): boolean {
  const data = snapshots.get(snapshot)
  if (!data || data.adapter !== adapter) throw new Error('Foreign local admission')
  data.lifetime.check()
  const history = new Map(data.history.entries.map(entry => [entry.id, entry.ref]))
  return (data.journalIndex?.entries ?? []).every(entry => {
    const retained = history.get(entry.id)
    return retained?.documentId === entry.ref.documentId && retained.revisionId === entry.ref.revisionId
  })
}
// The caller receives data, not a storage-health or successor-write exemption
// Both private admissions and their exact physical history claims must remain live
export function admittedLocalHistoryTransition(before: AdmittedLocalSnapshot, after: AdmittedLocalSnapshot, adapter: LocalStoreAdapter) {
  const old = snapshots.get(before), next = snapshots.get(after)
  if (!old || !next || old.adapter !== adapter || next.adapter !== adapter) throw new Error('Foreign local history admission')
  const check = () => { old.lifetime.check(); next.lifetime.check() }
  check()
  const prior = new Map(old.history.entries.map(entry => [entry.id, entry.ref]))
  const unchanged = new Set(next.history.entries.filter(entry => {
    const ref = prior.get(entry.id)
    return ref?.documentId === entry.ref.documentId && ref.revisionId === entry.ref.revisionId
  }).map(entry => entry.id))
  return { before: before.head, history: after.state.planner.history, unchanged, check }
}
const utf8 = new TextEncoder()
const deepFrozen = new WeakSet<object>()
const stateDocuments = new WeakMap<WorkspaceState, ReadonlyMap<string, CapturedDocument>>()
// Exact immutable captures avoid resplitting unrelated native history for a file's typed closure
// This lookup supplies data only; storage/current-profile guards stay with the captured repository
export function capturedLocalDocuments(state: WorkspaceState): ReadonlyMap<string, WorkspaceDocument> | undefined {
  const captured = stateDocuments.get(state)
  return captured && new Map([...captured].map(([key, value]) => [key, value.document]))
}
function freeze(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value) || deepFrozen.has(value)) return
  // The native owner already validated and froze every nested catalog value
  // Rewalking that unchanged graph at each typed capture repeats bulk admission work
  if (isImmutableCatalogSnapshot(value as import('../domain/types').CatalogSnapshot)) { deepFrozen.add(value); return }
  seen.add(value)
  for (const child of Object.values(value)) freeze(child, seen)
  Object.freeze(value)
  deepFrozen.add(value)
}
// Only objects recursively frozen by this module can be shared across an asynchronous command
// Caller-frozen values are copied too, so shallow freezing cannot smuggle mutable descendants
export function captureManagedPlannerInput(value: LocalData): LocalData {
  function copy<T>(input: T): T {
    if (!input || typeof input !== 'object' || deepFrozen.has(input)) return input
    if (Array.isArray(input)) return input.map(child => copy(child)) as T
    // Durable JSON omits undefined object fields; retained checkpoints must use that same exact value
    // Array entries remain explicit so native schemas reject unsupported values
    return Object.fromEntries(Object.entries(input).filter(([, child]) => child !== undefined).map(([key, child]) => [key, copy(child)])) as T
  }
  return copy(value)
}
function jsonSource(value: unknown): BlobSource { return memoryBlob(utf8.encode(JSON.stringify(value))) }
async function jsonRead(adapter: LocalStoreAdapter, ref: LocalRecordRef): Promise<unknown> {
  const source = await adapter.read(ref)
  return parseBoundedJson(await readBlob(source, maxDocumentBytes), 'managed local record', NATIVE_BACKUP_JSON_LIMITS)
}
function capture(state: WorkspaceState, previous?: ReadonlyMap<string, CapturedDocument>): ReadonlyMap<string, CapturedDocument> {
  const result = new Map<string, CapturedDocument>()
  captureWorkspaceDocuments({ ...state, planner: { ...state.planner, history: [] } }, (kind, key, input) => {
    const old = previous?.get(key)
    if (old && old.input === input) { result.set(key, old); return old.document }
    const value = kind === 'blob' ? input as BlobSource : kind === 'catalog' ? immutableCatalogSnapshot(compactModCatalog(immutableCatalogSnapshot(input as import('../domain/types').CatalogSnapshot))) as unknown as JsonValue : JSON.parse(JSON.stringify(input)) as JsonValue
    const document: WorkspaceDocument = { version: 1, kind, key, value }
    if (!isBlobSource(value)) freeze(value)
    result.set(key, { input, document })
    return document
  })
  return result
}
function snapshot(head: LocalRecordRef, root: LocalWorkspaceRootV3, state: WorkspaceState, data: SnapshotData): AdmittedLocalSnapshot {
  // Identity reuse is safe only while every retained native value is immutable
  // Blob capabilities remain lifetime-checked by their owning storage adapter
  const documents = new Map(data.documents)
  const entries = new Map(data.index.entries.map(entry => [entry.key, entry]))
  // Prepared views read their exact durable frames on consumption, even when metadata is reused
  // Returning the original preparation buffer would hide later stored-byte corruption
  const capturedState: WorkspaceState = { ...state, blobs: state.blobs.map(blob => {
    const key = privateRecordKey('blob', blobIdentity(blob.ref)), entry = entries.get(key)!
    const content: BlobSource = { byteLength: blob.content.byteLength, async *open() {
      data.lifetime.check()
      const source = await data.adapter.read(entry.ref)
      const body = capturedWorkspaceBody(verifiedBlob(source, entry.digest), { key, kind: 'blob', byteLength: blob.content.byteLength })
      for await (const bytes of body.open()) { data.lifetime.check(); yield bytes }
      data.lifetime.check()
    } }
    documents.set(key, { input: content, document: { version: 1, kind: 'blob', key, value: content } })
    return { ref: blob.ref, content }
  }) }
  freeze(capturedState); freeze(root); freeze(data.index.entries); freeze(data.destination.entries)
  const result = Object.freeze({ head: Object.freeze({ ...head }), root: Object.freeze(root), state: capturedState, entries: data.index.entries, destinationChanges: data.destination.entries })
  snapshots.set(result, { ...data, documents })
  stateDocuments.set(capturedState, documents)
  return result
}

export async function prepareLocalWorkspace(adapter: LocalStoreAdapter, operationId: string, state: WorkspaceState, lifetime: CapturedLocalLifetime, previous?: AdmittedLocalSnapshot, inheritedEvidence?: LocalRecordRef, destinationChanges?: readonly ChangeEntry[]): Promise<{ readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }> {
  lifetime.check(); await lifetime.assertCurrent(); lifetime.check()
  const prior = previous && snapshots.get(previous)
  if (previous && (!prior || prior.adapter !== adapter || prior.lifetime !== lifetime)) throw new Error('Foreign local workspace admission')
  // Ordinary commits cannot remove or rewrite historical originals; replacements use bulk admission
  for (const field of ['history', 'catalogs', 'sources', 'evidence'] as const) {
    const old = previous?.state.planner[field] ?? []
    const next = new Map(state.planner[field].map(value => [JSON.stringify([value.id, ...('revisionId' in value ? [value.revisionId] : [])]), value]))
    for (const value of old) {
      const after = next.get(JSON.stringify([value.id, ...('revisionId' in value ? [value.revisionId] : [])]))
      if (!after || after !== value && JSON.stringify(after) !== JSON.stringify(value)) throw new Error('Retained local evidence changed')
    }
  }
  const retained = new Set(previous?.state.planner.history)
  const transitions = new Set(state.planner.history.filter(value => previous && value.before === previous.state.planner.localData && value.after === state.planner.localData))
  for (const value of transitions) { const { before: _before, after: _after, ...metadata } = value; NativeHistorySchema.omit({ before: true, after: true }).parse(metadata) }
  const checkpoints = new Set(previous?.state.planner.journal?.checkpoints)
  // Current planner and new checkpoints retain full native validation; frozen historical
  // values were admitted already and are not cloned again by schema parsing on each save
  validateWorkspace({ ...state, planner: { ...state.planner, history: state.planner.history.filter(entry => !retained.has(entry) && !transitions.has(entry)), ...(state.planner.journal ? { journal: { ...state.planner.journal, checkpoints: state.planner.journal.checkpoints.filter(entry => !checkpoints.has(entry) && !transitions.has(entry)) } } : {}) } })
  const previousBlobs = new Map(previous?.state.blobs.map(value => [blobIdentity(value.ref), value]))
  for (const blob of state.blobs) {
    const old = previousBlobs.get(blobIdentity(blob.ref))
    if (!old || old.content !== blob.content || JSON.stringify(old.ref) !== JSON.stringify(blob.ref)) {
      if (await hashBlob(blob.content) !== blob.ref.sha256) throw new Error('Local workspace body digest mismatch')
      lifetime.check()
    }
  }
  if (!previous || state.conflicts !== previous.state.conflicts) await validateWorkspaceClosure(state)
  else for (const content of state.retainedContent) if (!previous.state.retainedContent.includes(content)) {
    for (const closure of content.kind === 'file-history' ? [content.content] : [...(content.base.kind === 'present' ? [content.base.closure] : []), content.target]) await inspectWorkspaceClosure(state, closure)
  }
  // Existing catalog codecs keep exact packaged pins and compact effective changes in storage
  // Captured views and portable archives stay expanded; older full frames remain readable
  const documents = capture(state, prior?.documents), oldEntries = new Map(previous?.entries.map(entry => [entry.key, entry]))
  const entries: LocalWorkspaceEntry[] = []
  for (const [key, value] of documents) {
    const old = oldEntries.get(key)
    if (old && prior?.documents.get(key) === value) { entries.push(old); continue }
    const document = value.document.kind === 'catalog' ? { ...value.document, value: encodeCatalogPayload(value.document.value as unknown as import('../domain/types').CatalogSnapshot) as WorkspaceDocument['value'] } : value.document
    const source = workspaceDocumentSource(document), digest = await hashBlob(source)
    const ref = old?.digest === digest ? old.ref : await adapter.stage(operationId, source, [], old?.ref)
    lifetime.check()
    entries.push({ key, kind: value.document.kind, ref, digest })
  }
  for (const old of previous?.entries ?? []) if (!documents.has(old.key)) {
    if (old.kind === 'tombstone') { entries.push(old); continue }
    const source = workspaceDocumentSource({ version: 1, kind: 'tombstone', key: old.key, value: { version: 1, kind: 'tombstone', privateKey: old.key } })
    entries.push({ key: old.key, kind: 'tombstone', ref: await adapter.stage(operationId, source, [], old.ref), digest: await hashBlob(source) })
  }
  // Preserve native collection order; sorting private keys can change retained catalog precedence
  const stageJson = async (value: unknown, dependencies: readonly LocalRecordRef[]) => { lifetime.check(); const ref = await adapter.stage(operationId, jsonSource(value), dependencies); lifetime.check(); return ref }
  const index = await prepareLocalIndex(entries, page => stageJson(page, [...page.children, ...page.entries.map(entry => entry.ref)]), prior?.index)
  const allocations = await prepareLocalIndex(entries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId })), page => stageJson(page, page.children), prior?.allocations)
  const bookkeeping = await prepareLocalIndex(Object.entries(state.planner.localData.playthroughs).map(([id, value]) => ({ id, revision: value.revision, updatedAt: value.updatedAt })), page => stageJson(page, page.children), prior?.bookkeeping)
  const local = state.planner.localData
  const changes = await prepareLocalIndex(local.changes, page => stageJson(page, page.children))
  // Inherited change evidence may use unrelated revision clocks and never grants destination authority
  // Migration/bulk producers supply their validated descriptor; ordinary commands append only their new local edges
  const priorDestinationIds = new Set(previous?.destinationChanges.map(change => change.id))
  const destinationValues = destinationChanges ?? (previous
    ? [...previous.destinationChanges, ...local.changes.filter(change => !priorDestinationIds.has(change.id))]
    : local.changes)
  validateDestinationChanges(destinationValues, local, prior?.destination.entries)
  if (previous && !destinationChanges) for (const value of destinationValues.slice(previous.destinationChanges.length)) {
    if (value.previousRevision < previous.state.planner.localData.revision) throw new Error('Unowned destination change')
  }
  const destination = await prepareLocalIndex(destinationValues, page => stageJson(page, page.children), prior?.destination)
  const selections = { selectedPlaythroughId: local.selectedPlaythroughId, planningGameSetupRevisionId: local.planningGameSetupRevisionId, scenarios: Object.fromEntries(Object.entries(local.playthroughs).flatMap(([id, playthrough]) => playthrough.activeScenarioId ? [[id, playthrough.activeScenarioId]] : [])) }
  const endpoint = { version: 1 as const, codec: 'workspace-native-1' as const, contentIndex: index.root, bookkeepingIndex: bookkeeping.root, operativeChanges: changes.root, localRevision: local.revision, localUpdatedAt: local.updatedAt, selections }
  const endpoints = previous ? { before: previous.state.planner.localData, after: state.planner.localData } : undefined
  const writeHistory = async (value: import('../interchange/types').PersistedHistoryEntry) => {
    const key = privateRecordKey('history', value.id)
    let body: unknown = value
    if (previous && transitions.has(value)) {
      const { before: _before, after: _after, ...metadata } = value
      const priorRoot = previous.root
      body = { version: 1, kind: 'local-history-transition', metadata, before: { version: 1, codec: 'workspace-native-1', contentIndex: priorRoot.contentIndex, bookkeepingIndex: priorRoot.bookkeepingIndex, operativeChanges: priorRoot.operativeChanges, localRevision: priorRoot.localRevision, localUpdatedAt: priorRoot.localUpdatedAt, selections: priorRoot.selections }, after: endpoint }
    }
    return adapter.stage(operationId, workspaceDocumentSource({ version: 1, kind: 'history', key, value: body as JsonValue }), [index.root, bookkeeping.root, changes.root, ...(previous ? [previous.head] : [])])
  }
  const originals = await prepareLocalHistory(state.planner.history, writeHistory, prior?.originals, endpoints)
  const history = await prepareLocalIndex(originals.entries, page => stageJson(page, [...page.children, ...page.entries.map(entry => entry.ref)]), prior?.history)
  const byId = new Map(state.planner.history.map((value, at) => [value.id, { value, ref: originals.entries[at].ref }]))
  const journal = await prepareLocalHistory(state.planner.journal?.checkpoints ?? [], value => { const original = byId.get(value.id); return original?.value === value ? Promise.resolve(original.ref) : writeHistory(value) }, prior?.journal, endpoints)
  const journalIndex = await prepareLocalIndex(journal.entries, page => stageJson(page, [...page.children, ...page.entries.map(entry => entry.ref)]), prior?.journalIndex)
  const evidence = inheritedEvidence ?? previous?.root.inheritedEvidence ?? await stageJson({ version: 1, kind: 'local-inherited-evidence', roots: [] }, [])
  const root = LocalWorkspaceRootV3Schema.parse({ version: 3, kind: 'incremental-local-workspace', lineageId: previous?.root.lineageId ?? crypto.randomUUID(), localRevision: local.revision, localUpdatedAt: local.updatedAt, contentIndex: index.root, allocationIndex: allocations.root, bookkeepingIndex: bookkeeping.root, operativeChanges: changes.root, destinationChanges: destination.root, hasSavedChanges: !!state.planner.savedChanges, historyIndex: history.root, inheritedEvidence: evidence, ...(state.planner.journal ? { journal: { version: 1, checkpoints: journalIndex.root, undoable: state.planner.journal!.undoable } } : {}), selections })
  const head = await stageJson(root, [index.root, allocations.root, bookkeeping.root, history.root, journalIndex.root, destination.root, evidence, ...(changes ? [changes.root] : [])])
  await lifetime.assertCurrent(); lifetime.check()
  return { head, snapshot: snapshot(head, root, state, { adapter, lifetime, documents, index, allocations, bookkeeping, history, destination, journal, originals, journalIndex }) }
}

// Progress reports completed admission stages only; callers choose whether this is an observed startup
// Keep identities and content out of labels, and retain every admission check regardless of observation
export async function admitLocalRoot(adapter: LocalStoreAdapter, head: LocalRecordRef, lifetime: CapturedLocalLifetime, progress?: (phase: 'root-header' | 'root-indexes' | 'root-documents' | 'root-history' | 'root-closure') => void): Promise<AdmittedLocalSnapshot> {
  lifetime.check(); await lifetime.assertCurrent()
  const root = LocalWorkspaceRootV3Schema.parse(await jsonRead(adapter, head))
  progress?.(WORKSPACE_STARTUP_PHASE.rootHeader)
  const read = (ref: LocalRecordRef) => { lifetime.check(); return jsonRead(adapter, ref) }
  const index = await readLocalIndex(root.contentIndex, read, entrySchema.parse)
  const allocations = await readLocalIndex(root.allocationIndex, read, allocationSchema.parse)
  const bookkeeping = await readLocalIndex(root.bookkeepingIndex, read, bookkeepingSchema.parse)
  const history = await readLocalIndex(root.historyIndex, read, historyEntrySchema.parse)
  progress?.(WORKSPACE_STARTUP_PHASE.rootIndexes)
  const allocationMap = new Map(allocations.entries.map(entry => [entry.key, entry.documentId]))
  if (allocationMap.size !== allocations.entries.length || new Set(allocations.entries.map(entry => entry.documentId)).size !== allocations.entries.length) throw new Error('Duplicate local allocation')
  const documentReads = new Map<string, { claim: string; value: Promise<WorkspaceDocument> }>()
  const readDocument = (entry: LocalWorkspaceEntry): Promise<WorkspaceDocument> => {
    const identity = blobIdentity(entry.ref), claim = JSON.stringify([entry.key, entry.kind, entry.digest])
    const prior = documentReads.get(identity)
    if (prior) { if (prior.claim !== claim) throw new Error('Contradictory local frame claims'); return prior.value }
    const value = (async () => {
      const stored = await decodeWorkspaceDocument(verifiedBlob(await adapter.read(entry.ref), entry.digest))
      if (stored.key !== entry.key || stored.kind !== entry.kind) throw new Error('Local frame key mismatch')
      // Exact bundled identity is required; missing packages cannot silently substitute another catalog
      const document = stored.kind === 'catalog' ? { ...stored, value: decodeCatalogPayload(stored.value) as WorkspaceDocument['value'] } : stored
      lifetime.check(); return document
    })()
    documentReads.set(identity, { claim, value }); return value
  }
  const records: WorkspaceDocument[] = [], keys = new Set<string>()
  for (const entry of index.entries) {
    if (keys.has(entry.key) || allocationMap.get(entry.key) !== entry.ref.documentId) throw new Error('Local record identity mismatch')
    keys.add(entry.key)
    const document = await readDocument(entry)
    if (document.kind !== 'tombstone') records.push(document)
    lifetime.check()
  }
  if (keys.size !== allocationMap.size) throw new Error('Missing allocated local record')
  progress?.(WORKSPACE_STARTUP_PHASE.rootDocuments)
  const endpointCache = new Map<string, Promise<LocalData>>()
  // Semantic history and the operative journal can retain the same physical checkpoint
  // Share its complete admission only within this invocation, with an exact identity claim
  const historyReads = new Map<string, { readonly id: string; readonly value: import('../interchange/types').PersistedHistoryEntry }>()
  const readHistory = async (entries: readonly z.infer<typeof historyEntrySchema>[]) => {
    const result: import('../interchange/types').PersistedHistoryEntry[] = []
    for (const entry of entries) {
      lifetime.check()
      const key = blobIdentity(entry.ref), previous = historyReads.get(key)
      if (previous) {
        if (previous.id !== entry.id) throw new Error('Contradictory local history frame claims')
        result.push(previous.value); continue
      }
      const document = await decodeWorkspaceDocument(await adapter.read(entry.ref))
      if (document.kind !== 'history' || document.key !== privateRecordKey('history', entry.id)) throw new Error('Local checkpoint framing mismatch')
      let body = document.value as unknown
      if (body && typeof body === 'object' && 'kind' in body && body.kind === 'local-history-transition') {
        const compact = LocalHistoryTransitionSchema.parse(body)
        const endpointData = (endpoint: z.infer<typeof LocalEndpointSchema>) => {
          const key = JSON.stringify(endpoint)
          let pending = endpointCache.get(key)
          if (!pending) { pending = materializeLocalEndpoint(adapter, endpoint, lifetime, readDocument); endpointCache.set(key, pending) }
          return pending
        }
        body = immutableHistory({ ...compact.metadata, before: await endpointData(compact.before), after: await endpointData(compact.after) } as import('../interchange/types').PersistedHistoryEntry)
      }
      const value = parseImmutableHistory(body)
      if (value.id !== entry.id) throw new Error('Local checkpoint identity mismatch')
      const admitted = value as unknown as import('../interchange/types').PersistedHistoryEntry
      historyReads.set(key, { id: entry.id, value: admitted })
      result.push(admitted)
    }
    return result
  }
  const nativeHistory = await readHistory(history.entries)
  const journalIndex = root.journal && await readLocalIndex(root.journal.checkpoints, read, historyEntrySchema.parse)
  const journalHistory = journalIndex ? await readHistory(journalIndex.entries) : []
  progress?.(WORKSPACE_STARTUP_PHASE.rootHistory)
  const changes = await readLocalIndex(root.operativeChanges, read, NativeLocalDataSchema.shape.changes.element.parse)
  const journal = root.journal ? { version: 1 as const, changes: changes!.entries as unknown as LocalData['changes'], checkpoints: journalHistory, undoable: root.journal.undoable } : undefined
  for (const value of nativeHistory) records.push({ version: 1, kind: 'history', key: privateRecordKey('history', value.id), value: value as unknown as JsonValue })
  const state = assembleWorkspace(records, root.localRevision, journal, new Map(bookkeeping.entries.map(({ id, ...value }) => [id, value])))
  if (new Set(bookkeeping.entries.map(value => value.id)).size !== bookkeeping.entries.length || JSON.stringify(bookkeeping.entries.map(value => value.id).sort()) !== JSON.stringify(Object.keys(state.planner.localData.playthroughs).sort())) throw new Error('Local bookkeeping identity mismatch')
  const local = state.planner.localData, selected = root.selections
  if (selected.selectedPlaythroughId && !local.playthroughs[selected.selectedPlaythroughId] || selected.planningGameSetupRevisionId && !local.gameSetups[selected.planningGameSetupRevisionId] || Object.entries(selected.scenarios).some(([id, value]) => !local.playthroughs[id]?.scenarios[value])) throw new Error('Invalid local selection')
  // Native assembly sorts merged remote evidence; this local index already authenticates exact collection order
  // Restore and imported histories can carry independent clocks, so sorting would rewrite retained native arrays
  const savedChanges = records.filter(record => record.kind === 'change').map(record => record.value as unknown as ChangeEntry)
  // Both older expanded frames and compact frames produce the same complete admitted catalog view
  // Expansion uses the exact stored baseline pin before closure validation and input-identity reuse
  const restored: WorkspaceState = { ...state, planner: { ...state.planner, catalogs: Object.freeze([...immutableExpandedModCatalogs(state.planner.catalogs)]), history: nativeHistory, ...(root.hasSavedChanges ? { savedChanges } : {}), localData: { ...local, changes: changes.entries as unknown as LocalData['changes'], updatedAt: asTimestamp(root.localUpdatedAt), ...(selected.selectedPlaythroughId ? { selectedPlaythroughId: asId<NonNullable<LocalData['selectedPlaythroughId']>>(selected.selectedPlaythroughId) } : {}), ...(selected.planningGameSetupRevisionId ? { planningGameSetupRevisionId: asId<NonNullable<LocalData['planningGameSetupRevisionId']>>(selected.planningGameSetupRevisionId) } : {}), playthroughs: Object.fromEntries(Object.entries(local.playthroughs).map(([id, value]) => [id, { ...value, ...(selected.scenarios[id] ? { activeScenarioId: asId<NonNullable<import('../domain/types').Playthrough['activeScenarioId']>>(selected.scenarios[id]) } : {}) }])) } } }
  const destination = await readLocalIndex(root.destinationChanges, read, value => NativeLocalDataSchema.shape.changes.element.parse(value) as unknown as ChangeEntry)
  validateDestinationChanges(destination.entries, restored.planner.localData)
  await validateWorkspaceClosure(restored)
  progress?.(WORKSPACE_STARTUP_PHASE.rootClosure)
  await lifetime.assertCurrent(); lifetime.check()
  const originals = await prepareLocalHistory(nativeHistory, async value => history.entries.find(entry => entry.id === value.id)!.ref)
  const admittedHistory = await prepareLocalHistory(journalHistory, async value => journalIndex!.entries.find(entry => entry.id === value.id)!.ref)
  return snapshot(head, root, restored, { adapter, lifetime, documents: capture(restored), index, allocations, bookkeeping, history, destination, journal: admittedHistory, originals, journalIndex })
}

function validateDestinationChanges(values: readonly ChangeEntry[], current: LocalData, admitted: readonly ChangeEntry[] = []): void {
  const known = new Set(admitted)
  const byId = new Map<string, ChangeEntry>()
  for (const value of values) {
    if (!known.has(value)) NativeLocalDataSchema.shape.changes.element.parse(value)
    if (byId.has(value.id) || !Number.isSafeInteger(value.previousRevision + 1) || value.nextRevision !== value.previousRevision + 1 || value.nextRevision > current.revision) throw new Error('Invalid destination change evidence')
    byId.set(value.id, value)
  }
  for (const value of current.changes) if (!guestPlannerValuesEqual(byId.get(value.id), value)) throw new Error('Missing exact destination change evidence')
}

const ENDPOINT_KINDS = new Set(['workspace-identity', 'workspace-preferences', 'build', 'build-checkpoint', 'team', 'team-checkpoint', 'playthrough', 'character', 'progress', 'goal', 'scenario', 'inventory', 'quintar-breeding', 'personal-definition', 'setup', 'catalog', 'import-receipt', 'change', 'skill-layout', 'skill-capture', 'reference-preferences', 'library-defaults'])
async function materializeLocalEndpoint(adapter: LocalStoreAdapter, endpoint: z.infer<typeof LocalEndpointSchema>, lifetime: CapturedLocalLifetime, readDocument: (entry: LocalWorkspaceEntry) => Promise<WorkspaceDocument>): Promise<LocalData> {
  const read = (ref: LocalRecordRef) => { lifetime.check(); return jsonRead(adapter, ref) }
  const index = await readLocalIndex(endpoint.contentIndex, read, entrySchema.parse)
  const bookkeeping = await readLocalIndex(endpoint.bookkeepingIndex, read, bookkeepingSchema.parse)
  const documents: WorkspaceDocument[] = []
  for (const entry of index.entries) if (ENDPOINT_KINDS.has(entry.kind)) {
    const document = await readDocument(entry)
    documents.push(document); lifetime.check()
  }
  const changes = await readLocalIndex(endpoint.operativeChanges, read, NativeLocalDataSchema.shape.changes.element.parse)
  // Saved remote evidence can use a different revision clock from this local endpoint
  // Supply its authenticated operative changes before assembly performs native validation
  const journal = { version: 1 as const, changes: changes.entries as unknown as LocalData['changes'], checkpoints: [], undoable: false }
  const state = assembleWorkspace(documents, endpoint.localRevision, journal, new Map(bookkeeping.entries.map(({ id, ...value }) => [id, value])))
  const local = state.planner.localData, selected = endpoint.selections
  const result: LocalData = { ...local, changes: changes.entries as unknown as LocalData['changes'], updatedAt: asTimestamp(endpoint.localUpdatedAt), ...(selected.selectedPlaythroughId ? { selectedPlaythroughId: asId<NonNullable<LocalData['selectedPlaythroughId']>>(selected.selectedPlaythroughId) } : {}), ...(selected.planningGameSetupRevisionId ? { planningGameSetupRevisionId: asId<NonNullable<LocalData['planningGameSetupRevisionId']>>(selected.planningGameSetupRevisionId) } : {}), playthroughs: Object.fromEntries(Object.entries(local.playthroughs).map(([id, value]) => [id, { ...value, ...(selected.scenarios[id] ? { activeScenarioId: asId<NonNullable<import('../domain/types').Playthrough['activeScenarioId']>>(selected.scenarios[id]) } : {}) }])) }
  validateWorkspace({ ...state, planner: { ...state.planner, localData: result } })
  return immutableHistoryEndpoint(result)
}
