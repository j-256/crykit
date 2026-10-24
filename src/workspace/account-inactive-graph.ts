import Dexie from 'dexie'
import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { RevisionDescriptorSchema } from '../account/protocol'
import { createBlankLocalData } from '../domain/local-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { AccountDatabase, AccountFence, CipherRecord, CipherRef, EncryptedSyncState } from '../persistence/account-database'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import type { InheritedSnapshotSources } from '../interchange/workspace-backup-evidence'
import { INDEX_PAGE_BYTES } from './directory'
import { AccountHistorySchema, AccountProjectionSchema, cipherRef } from './account-cache'
import { accountCleanupOnlyFailure, accountPreparationFailure, assertAccountCleanupJoinable, readAccountCleanupOnlyFailure, readAccountPreparationFailure, type AccountCleanupGroup, type AccountCleanupJoin, type AccountManagedCleanup } from './account-cleanup-attempt'
import { AccountWorkspaceGraphReader } from './account-graph-reader'
import { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema, authenticateAccountWorkspaceSubtree, stageAccountWorkspaceGraph, type AuthenticatedAccountWorkspaceSubtree, type OpenAccountWorkspace } from './account-graph'
import { accountInheritedSources, openAccountInheritedEvidence, type AccountInheritedEvidence, type PreparedAccountInheritedEvidence } from './account-evidence-snapshots'
import { createAccountPreparationOwner, resolveAccountRecord, type AccountPreparationOwner } from './account-prepared-records'
import { openAccountSource } from './account-streams'
import { sameCipherRefs } from './account-retaining'
import { hashBlob } from './blobs'
import { validateWorkspace } from './validation'
import { isBlobSource, type BlobSource, type WorkspaceState } from './documents'

const rootSchema = z.union([AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema])
type InputFormat = 'workspace-graph' | 'legacy-projection' | 'legacy-local-graph'
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const sameRecord = (left: CipherRecord | undefined, right: CipherRecord) => left !== undefined && same({ revisionId: left.revisionId, payloadId: left.payloadId, descriptor: RevisionDescriptorSchema.parse(left.descriptor) }, { revisionId: right.revisionId, payloadId: right.payloadId, descriptor: RevisionDescriptorSchema.parse(right.descriptor) })
const failure = () => new Error('Inactive workspace origin or source association changed')
type Observation = { readonly id: string; readonly row: EncryptedSyncState | undefined }
interface Association {
  readonly fence: AccountFence | undefined
  readonly rows: readonly Observation[]
  readonly records: readonly CipherRecord[]
}
interface Reader {
  readonly workspace: OpenAccountWorkspace
  readonly version: 1 | 2
  readonly inputFormat: InputFormat
  readonly effectiveRoot: CipherRef
  readonly inherited?: CipherRef
  observations(): readonly Observation[]
  recordObservations(): readonly CipherRecord[]
  recheck(): Promise<void>
  dispose(): Promise<void>
}

export interface InactiveAccountWorkspace {
  readonly origin: 'legacy-v1-empty' | 'evidence-v1'
  readonly version: 1 | 2
  readonly head: CipherRef
  readonly effectiveRoot: CipherRef
  readonly workspace: OpenAccountWorkspace
  // C's content-only handle can seed C preparation; D-bound lazy reads use inactiveAccountInheritedSources
  readonly inheritedEvidence?: AccountInheritedEvidence
  check(): Promise<void>
  dispose(): Promise<void>
}
export interface PreparedInactiveAccountWorkspace {
  readonly head: CipherRef
  readonly records: readonly CipherRecord[]
  readonly opened: InactiveAccountWorkspace
  readonly owner: AccountPreparationOwner
}
interface ReaderLifetime {
  readonly pending: Set<Promise<void>>
  readonly streams: Set<AsyncIterator<Uint8Array>>
  closed: boolean
}
interface Registration {
  readonly database: AccountDatabase
  readonly token: ProfileToken
  readonly owner?: AccountPreparationOwner
  readonly reader: Reader
  readonly evidence?: AccountInheritedEvidence
  readonly association: Association
  readonly signal?: AbortSignal
  readonly lifetime: ReaderLifetime
  readonly cleanup?: AccountCleanupGroup
}
const registered = new WeakMap<InactiveAccountWorkspace, Registration>()

function registration(handle: InactiveAccountWorkspace, database?: AccountDatabase, token?: ProfileToken): Registration {
  const value = registered.get(handle)
  if (!value || value.lifetime.closed || database && value.database !== database || token && (value.token.accountId !== token.accountId || value.token.generation !== token.generation)) throw failure()
  assertActiveProfile(value.token)
  value.signal?.throwIfAborted()
  value.owner?.check()
  return value
}

function mergeAssociation(source: Association | undefined, fence: AccountFence | undefined, reader: Reader): Association {
  if (source && !same(source.fence, fence)) throw failure()
  const rows = new Map(source?.rows.map(row => [row.id, row]) ?? [])
  for (const row of reader.observations()) {
    if (rows.has(row.id) && !same(rows.get(row.id), row)) throw failure()
    rows.set(row.id, row)
  }
  const records = new Map(source?.records.map(record => [record.revisionId, record]) ?? [])
  for (const record of reader.recordObservations()) {
    if (records.has(record.revisionId) && !same(records.get(record.revisionId), record)) throw failure()
    records.set(record.revisionId, record)
  }
  return structuredClone({ fence, rows: [...rows.values()], records: [...records.values()] })
}

// The snapshot is private and survives reader retirement; transferring ciphertext cannot recapture
// changed source rows as a new origin, even when the new root itself has different context keys
async function recheckAssociation(value: Registration): Promise<void> {
  const { database, token, owner, association } = value
  const rows = async () => {
    if (!same(await database.profileMeta.get('active'), association.fence)) throw failure()
    for (const observation of association.rows) if (!same(await database.syncState.get(observation.id), observation.row)) throw failure()
  }
  await rows()
  for (const record of association.records) if (!same(await resolveAccountRecord(database, token, cipherRef(record), owner), record)) throw failure()
  for (const { row } of association.rows) if (row) {
    const record = association.records.find(record => record.revisionId === row.ref.revisionId)
    if (!record) throw failure()
    const source = await openAccountSource(database, token, row.ref, owner, record)
    const iterator = source.open()[Symbol.asyncIterator]()
    value.lifetime.streams.add(iterator)
    try {
      while (true) {
        if (value.lifetime.closed) throw failure()
        const next = await iterator.next()
        if (next.done) break
      }
    } finally { value.lifetime.streams.delete(iterator); await iterator.return?.() }
  }
  await rows()
}

async function check(handle: InactiveAccountWorkspace): Promise<void> {
  const value = registration(handle)
  const job = (async () => {
    await value.reader.recheck()
    await value.evidence?.check()
    await recheckAssociation(value)
    registration(handle)
  })()
  value.lifetime.pending.add(job)
  try { await job } finally { value.lifetime.pending.delete(job) }
}

function guardedSource(handle: InactiveAccountWorkspace, source: BlobSource): BlobSource {
  return { byteLength: source.byteLength, async *open() {
    await check(handle)
    const value = registration(handle), iterator = source.open()[Symbol.asyncIterator]()
    value.lifetime.streams.add(iterator)
    try {
      while (true) {
        await check(handle)
        const next = await iterator.next()
        await check(handle)
        if (next.done) break
        yield next.value
      }
    } finally { value.lifetime.streams.delete(iterator); await iterator.return?.() }
  } }
}

async function settleCleanup(jobs: readonly (Promise<void> | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(jobs)
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Inactive workspace cleanup failed')
}

// This view only accumulates canonical nodes from the supplied coordinator; it creates no
// second executor for a returned facade, and descendants never include their ancestor group
function nestedCleanup(cleanup: AccountManagedCleanup, group: AccountCleanupGroup): AccountManagedCleanup {
  return {
    owner(owner) { const join = cleanup.owner(owner); group.include(join); return join },
    reader(reader) { const join = cleanup.reader(reader); group.include(join); return join },
    group(parts) { const child = cleanup.group(parts); group.include(child); return child },
  }
}

async function requestCleanup(join: AccountCleanupJoin): Promise<void> {
  const result = await join.request()
  if (result.status === 'failed') throw accountCleanupOnlyFailure(join, result)
}

async function openingFailure(error: unknown, group: AccountCleanupGroup): Promise<never> {
  const inner = readAccountPreparationFailure(error)
  const cleanupOnly = readAccountCleanupOnlyFailure(error)
  // The incoming failure already carries its exact attempt; successful local cleanup
  // must not rewrap it or lose that history if an explicit retry raced with this catch
  const local = cleanupOnly ? await group.request() : undefined
  if (cleanupOnly) {
    assertAccountCleanupJoinable(group, cleanupOnly.cleanup)
    if (local?.status === 'succeeded') throw error
  }
  if (inner || cleanupOnly) group.include((inner ?? cleanupOnly)!.cleanup)
  const primary = inner ? inner.primary : error
  const result = await group.request()
  if (result.status === 'failed') {
    // A historical child may have retried successfully, so preserve its prior failed
    // attempt beside the latest group result without enrolling or retrying it again
    if (cleanupOnly) throw accountCleanupOnlyFailure(group, result, error as Error)
    throw accountPreparationFailure(primary, group)
  }
  // A later explicit retry may clear the group's latest result, but it cannot make
  // the failed opening operation successful or erase its original cleanup evidence
  if (cleanupOnly) throw error
  throw primary
}

// D owns pending checks and guarded streams independently of its children; awaiting their
// canonical nodes here would duplicate failures or make the group wait on itself
async function disposeLocal(value: ReaderLifetime): Promise<void> {
  value.closed = true
  const streams = [...value.streams].map(async stream => { await stream.return?.() })
  const results = await Promise.allSettled([...streams, ...value.pending])
  const errors = results.flatMap((result, index) => index < streams.length && result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Inactive workspace stream cleanup failed')
}

async function dispose(handle: InactiveAccountWorkspace): Promise<void> {
  const value = registered.get(handle)
  if (!value) throw failure()
  if (value.cleanup) return requestCleanup(value.cleanup)
  value.lifetime.closed = true
  const streamCount = value.lifetime.streams.size
  const results = await Promise.allSettled([
    ...[...value.lifetime.streams].map(async stream => { await stream.return?.() }),
    ...value.lifetime.pending,
    value.reader.dispose(),
    value.evidence?.dispose(),
  ])
  // Pending reads report their own revocation failures; only cleanup failures belong to disposal
  const failures = results.filter((result, index): result is PromiseRejectedResult => result.status === 'rejected' && (index < streamCount || index >= results.length - 2)).map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'Inactive workspace reader cleanup failed')
}

function bind(value: Registration, head: CipherRef): InactiveAccountWorkspace {
  let handle!: InactiveAccountWorkspace
  const original = value.reader.workspace
  const workspace: OpenAccountWorkspace = {
    ...original,
    payloads: new Map([...original.payloads].map(([key, source]) => [key, guardedSourceProxy(source)])),
    state: { ...original.state, blobs: original.state.blobs.map(body => ({ ref: body.ref, content: guardedSourceProxy(body.content) })) },
    readCaptured: async (...args) => {
      await check(handle)
      const result = await original.readCaptured(...args)
      await check(handle)
      return { ...result, source: guardedSourceProxy(result.source), document: isBlobSource(result.document.value) ? { ...result.document, value: guardedSourceProxy(result.document.value) } : result.document }
    },
  }
  function guardedSourceProxy(source: BlobSource): BlobSource { return { byteLength: source.byteLength, open: () => guardedSource(handle, source).open() } }
  handle = Object.freeze({ origin: value.evidence ? 'evidence-v1' : 'legacy-v1-empty', version: value.reader.version, head: Object.freeze({ ...head }), effectiveRoot: Object.freeze({ ...value.reader.effectiveRoot }), workspace, inheritedEvidence: value.evidence, check: () => check(handle), dispose: () => dispose(handle) })
  registered.set(handle, value)
  return handle
}

async function projectionReader(database: AccountDatabase, token: ProfileToken, head: CipherRef, owner: AccountPreparationOwner | undefined, signal?: AbortSignal, cleanup?: AccountManagedCleanup): Promise<Reader> {
  const reader = new AccountWorkspaceGraphReader(database, token, owner, false, signal)
  const join = cleanup?.reader(reader)
  const dispose = () => join ? requestCleanup(join) : reader.dispose()
  try {
    const projection = await reader.json(head, AccountProjectionSchema, false, NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes)
    const root = await reader.record(head)
    if (!sameCipherRefs(root.descriptor.dependencies, [...projection.sources.map(source => source.original), ...(projection.history ? [projection.history] : [])])) throw failure()
    // Projection roots predate graph source wrappers; admitting a wrapper here would guess graph semantics
    for (const prefix of ['source-view:', 'source-context:']) if (await reader.observeRow(`${prefix}${head.revisionId}`)) throw failure()
    const history: WorkspaceState['planner']['history'][number][] = [], seen = new Set<string>()
    let ref = projection.history
    while (ref) {
      if (seen.has(ref.revisionId)) throw failure()
      seen.add(ref.revisionId)
      const saved = await reader.json(ref, AccountHistorySchema, false, NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes)
      if (!sameCipherRefs((await reader.record(ref)).descriptor.dependencies, saved.previous ? [saved.previous] : [])) throw failure()
      history.push(saved.entry as unknown as WorkspaceState['planner']['history'][number]); ref = saved.previous
    }
    const catalogs = projection.bundledCatalogs.map(pin => {
      const catalog = BUNDLED_CATALOGS.find(value => value.id === pin.id && value.revisionId === pin.revisionId && value.checksum === pin.checksum)
      if (!catalog) throw failure()
      return catalog
    })
    const blobs: WorkspaceState['blobs'][number][] = [], sources: WorkspaceState['planner']['sources'][number][] = []
    for (const { original, ...metadata } of projection.sources) {
      const content = await reader.source(original)
      if (!sameCipherRefs((await reader.record(original)).descriptor.dependencies, []) || await hashBlob(content) !== metadata.digest) throw failure()
      const sourceRef = { ...original, byteLength: content.byteLength, sha256: metadata.digest, encoding: 'bytes' as const }
      blobs.push({ ref: sourceRef, content }); sources.push({ ...metadata, original: sourceRef } as WorkspaceState['planner']['sources'][number])
    }
    const state: WorkspaceState = { planner: { localData: projection.localData as unknown as WorkspaceState['planner']['localData'], lineage: projection.lineage as WorkspaceState['planner']['lineage'], catalogs: [...catalogs, ...projection.catalogs] as WorkspaceState['planner']['catalogs'], evidence: projection.evidence as WorkspaceState['planner']['evidence'], sources, history: history.reverse() }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs }
    validateWorkspace(state)
    await reader.recheck(); reader.seal()
    return { version: 1, inputFormat: 'legacy-projection', effectiveRoot: head, workspace: { state, head, lineageId: state.planner.lineage.rootLocalDataId, entries: [], allocations: [], payloads: new Map(), readCaptured: async () => { await reader.recheck(); throw new Error('Legacy projection has no mapped captured records') } }, observations: () => reader.observations(), recordObservations: () => reader.recordObservations(), recheck: () => reader.recheck(), dispose }
  } catch (error) {
    if (join) {
      return openingFailure(error, cleanup!.group([join]))
    }
    try { await reader.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Projection authentication and cleanup failed') }
    throw error
  }
}

async function openBound(database: AccountDatabase, token: ProfileToken, head: CipherRef, options: { owner?: AccountPreparationOwner; signal?: AbortSignal; inputFormat?: InputFormat; cleanup?: AccountManagedCleanup }, association?: Association): Promise<InactiveAccountWorkspace> {
  const dispatch = new AccountWorkspaceGraphReader(database, token, options.owner, false, options.signal)
  const group = options.cleanup?.group([])
  const cleanup = group && nestedCleanup(options.cleanup!, group)
  const lifetime: ReaderLifetime = { pending: new Set(), streams: new Set(), closed: false }
  // Enroll D admission first so every child's raw return callback sees a closed parent
  // The same lifetime is bound later; an already requested ancestor cannot expose it live
  cleanup?.reader({ dispose: () => disposeLocal(lifetime) })
  const dispatchCleanup = cleanup?.reader(dispatch)
  let reader: Reader | undefined, evidence: AccountInheritedEvidence | undefined, handle: InactiveAccountWorkspace | undefined
  try {
    const fence = await database.profileMeta.get('active')
    // A declared legacy path has its own strict schema and archive bound; failed graph parsing
    // never retries under the larger legacy bound or turns a caller hint into provenance
    if (options.inputFormat === 'legacy-projection') reader = await projectionReader(database, token, head, options.owner, options.signal, cleanup)
    else {
      if (options.inputFormat !== undefined && options.inputFormat !== 'workspace-graph' && options.inputFormat !== 'legacy-local-graph') throw failure()
      // Compatibility comes from this authenticated dispatch, never extra caller options
      const legacyLocal = options.inputFormat === 'legacy-local-graph'
      const root = await dispatch.json(head, legacyLocal ? AccountWorkspaceRootV1Schema : rootSchema, false, INDEX_PAGE_BYTES)
      if (legacyLocal && root.sourceEvidenceVersion !== undefined) throw failure()
      const subtree: AuthenticatedAccountWorkspaceSubtree = await authenticateAccountWorkspaceSubtree(database, token, head, { owner: options.owner, signal: options.signal, version: root.version, cleanup, ...(legacyLocal ? { legacyLocal: true } : {}) })
      reader = { ...subtree, inputFormat: legacyLocal ? 'legacy-local-graph' : 'workspace-graph', version: subtree.root.version, inherited: subtree.root.version === 2 ? subtree.root.inheritedEvidence : undefined }
    }
    const observed = reader.recordObservations()
    if (!dispatch.recordObservations().every(record => observed.some(other => same(record, other)))) throw failure()
    let evidenceRecord: CipherRecord | undefined
    if (reader.inherited) {
      evidenceRecord = await resolveAccountRecord(database, token, reader.inherited, options.owner)
      evidence = await openAccountInheritedEvidence(database, token, reader.inherited, options.owner, cleanup)
      if (!sameRecord(await resolveAccountRecord(database, token, reader.inherited, options.owner), evidenceRecord)) throw failure()
    }
    if (dispatchCleanup) await requestCleanup(dispatchCleanup)
    else await dispatch.dispose()
    const snapshot = mergeAssociation(association, fence, reader)
    const completeAssociation = evidenceRecord ? { ...snapshot, records: [...snapshot.records, evidenceRecord] } : snapshot
    handle = bind({ database, token, owner: options.owner, signal: options.signal, reader, evidence, association: completeAssociation, lifetime, cleanup: group }, head)
    await check(handle)
    registration(handle)
    return handle
  } catch (error) {
    if (group) return openingFailure(error, group)
    try { await settleCleanup([dispatch.dispose(), ...(handle ? [dispose(handle)] : [reader?.dispose(), evidence?.dispose()])]) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Inactive workspace authentication and cleanup failed') }
    throw error
  }
}

export async function openInactiveAccountWorkspace(database: AccountDatabase, token: ProfileToken, head: CipherRef, options: { owner?: AccountPreparationOwner; sourceAssociation?: InactiveAccountWorkspace; signal?: AbortSignal; inputFormat?: InputFormat; cleanup?: AccountManagedCleanup } = {}): Promise<InactiveAccountWorkspace> {
  token = Object.freeze({ ...token }); options = { ...options }; head = { ...head }
  const source = options.sourceAssociation && registration(options.sourceAssociation, database, token)
  // A public rebind can reopen only the exact root; successor roots go through membership policy
  if (options.sourceAssociation && !same(head, options.sourceAssociation.head)) throw failure()
  if (options.sourceAssociation) await check(options.sourceAssociation)
  const result = await openBound(database, token, head, options, source?.association)
  try {
    if (options.sourceAssociation) await check(options.sourceAssociation)
    // The source can outlive a separately owned or cancelled target during that final await
    registration(result)
    return result
  } catch (error) {
    const group = registered.get(result)?.cleanup
    if (group) return openingFailure(error, group)
    try { await result.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Inactive reopen and cleanup failed') }
    throw error
  }
}

export async function inactiveAccountInheritedSources(handle: InactiveAccountWorkspace): Promise<InheritedSnapshotSources> {
  const value = registration(handle)
  await check(handle)
  if (!value.evidence) throw new Error('Legacy workspace has no explicit inherited evidence graph')
  const sources = await accountInheritedSources(value.evidence)
  await check(handle)
  return { members: sources.members.map(member => ({ ...member, metadata: guardedSource(handle, member.metadata) })), bodies: sources.bodies.map(body => ({ ...body, content: guardedSource(handle, body.content) })) }
}

// The caller supplies an operation owner before staging and retains it for retryable abandonment
// Failure consumes that owner; successful handle disposal releases readers without deleting ciphertext
export async function prepareInactiveAccountWorkspace(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, options: { owner: AccountPreparationOwner; sourceOrigin: InactiveAccountWorkspace; inheritedEvidence?: AccountInheritedEvidence; rootFormat: 'preserve' | 'upgrade-v2'; semanticBase?: OpenAccountWorkspace; stableAllocations?: OpenAccountWorkspace['allocations']; signal?: AbortSignal; cleanup?: AccountManagedCleanup }): Promise<PreparedInactiveAccountWorkspace> {
  token = Object.freeze({ ...token }); options = { ...options }
  const ownerJoin = options.cleanup?.owner(options.owner)
  const readers = options.cleanup?.group([])
  const group = ownerJoin && readers && options.cleanup!.group([ownerJoin, readers])
  const cleanup = readers && nestedCleanup(options.cleanup!, readers)
  let opened: InactiveAccountWorkspace | undefined, inherited: AccountInheritedEvidence | undefined
  try {
    const source = registration(options.sourceOrigin, database, token)
    await check(options.sourceOrigin)
    options.signal?.throwIfAborted()
    if (options.rootFormat !== 'preserve' && options.rootFormat !== 'upgrade-v2') throw failure()
    const version = options.rootFormat === 'upgrade-v2' ? 2 : source.reader.version
    if (version === 2 && !options.inheritedEvidence || version === 1 && options.inheritedEvidence) throw failure()
    if (options.inheritedEvidence) {
      await accountInheritedSources(options.inheritedEvidence)
      inherited = await openAccountInheritedEvidence(database, token, options.inheritedEvidence.root, options.owner, cleanup)
      // C member IDs authenticate exact historical content; successors may add members but cannot erase them
      const members = new Set(inherited.members.map(member => member.id))
      if (source.evidence?.members.some(member => !members.has(member.id))) throw failure()
    }
    await check(options.sourceOrigin)
    const staged = await stageAccountWorkspaceGraph(database, token, state, { owner: options.owner, semanticBase: options.semanticBase, stableAllocations: options.stableAllocations, rootFormat: inherited ? { version: 2, inheritedEvidence: inherited.root } : { version: 1 } })
    await check(options.sourceOrigin)
    // Successors always authenticate as modern graphs; caller extras cannot carry legacy authority
    opened = await openBound(database, token, staged.head, { owner: options.owner, signal: options.signal, inputFormat: 'workspace-graph', cleanup }, source.association)
    await inherited?.dispose(); inherited = undefined
    if (options.inheritedEvidence) await accountInheritedSources(options.inheritedEvidence)
    await check(options.sourceOrigin); await check(opened)
    registration(options.sourceOrigin, database, token); registration(opened)
    return { ...staged, opened, owner: options.owner }
  } catch (error) {
    if (group) return openingFailure(error, group)
    try { await settleCleanup([opened?.dispose(), inherited?.dispose()]) } catch (cleanup) { error = new AggregateError([error, cleanup], 'Inactive preparation and reader cleanup failed') }
    await options.owner.abandon(error)
    throw error
  }
}

// The operation exists before staging so failed preparation never hides the retryable cleanup owner
export function createBlankInactiveAccountWorkspacePreparation(database: AccountDatabase, token: ProfileToken, cleanup: AccountManagedCleanup): { prepare(): Promise<PreparedInactiveAccountWorkspace>; abandon(): Promise<void>; cleanup: AccountCleanupJoin }
export function createBlankInactiveAccountWorkspacePreparation(database: AccountDatabase, token: ProfileToken): { prepare(): Promise<PreparedInactiveAccountWorkspace>; abandon(): Promise<void> }
export function createBlankInactiveAccountWorkspacePreparation(database: AccountDatabase, token: ProfileToken, cleanup?: AccountManagedCleanup): { prepare(): Promise<PreparedInactiveAccountWorkspace>; abandon(): Promise<void>; cleanup?: AccountCleanupJoin } {
  token = Object.freeze({ ...token })
  const owner = createAccountPreparationOwner(database, token)
  const ownerJoin = cleanup?.owner(owner)
  const readers = cleanup?.group([])
  const group = ownerJoin && readers && cleanup!.group([ownerJoin, readers])
  const readerCleanup = readers && nestedCleanup(cleanup!, readers)
  let used = false, opened: InactiveAccountWorkspace | undefined
  let preparing: Promise<PreparedInactiveAccountWorkspace> | undefined
  // Request before awaiting the inner producer, which may hold decrypted bytes or a stage
  // The final request collects readers enrolled after the first finite group snapshot
  const abandon = group ? async () => {
    const first = group.request()
    await Promise.allSettled([preparing])
    const initial = await first
    const final = await group.request()
    // Keep the first failed attempt after an explicit retry; the final request enrolls late
    // readers and leaves their latest failures observable through the canonical group
    if (initial.status === 'failed') throw accountCleanupOnlyFailure(group, initial)
    if (final.status === 'failed') throw accountCleanupOnlyFailure(group, final)
  } : () => settleCleanup([opened?.dispose(), owner.abandon()])
  const prepare = async (): Promise<PreparedInactiveAccountWorkspace> => {
    if (used) throw new Error('Blank workspace preparation is single use')
    used = true
    try {
      owner.check()
      if (await database.profileMeta.get('active')) throw failure()
      const localData = createBlankLocalData()
      const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
      const staged = await stageAccountWorkspaceGraph(database, token, state, { owner, rootFormat: { version: 1 } })
      opened = await openBound(database, token, staged.head, { owner, cleanup: readerCleanup }, { fence: undefined, rows: [], records: [] })
      await check(opened)
      owner.check()
      return { ...staged, opened, owner }
    } catch (error) {
      if (group) return openingFailure(error, group)
      try { await abandon() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Blank workspace preparation and cleanup failed') }
      throw error
    }
  }
  const operation = { abandon, prepare: () => {
    const run = prepare()
    // Keep the first producer: a rejected second single-use call cannot replace its barrier
    if (!preparing) preparing = run
    // The external abandon path observes this same producer even when its caller delays catch
    void run.catch(() => {})
    return run
  } }
  return group ? { ...operation, cleanup: group } : operation
}

// C owns its child provenance; D verifies registration before retiring that handle and reopens
// identical ciphertext under the parent, preserving D's source snapshot across the transfer
export async function adoptInactiveAccountEvidence(database: AccountDatabase, token: ProfileToken, prepared: PreparedAccountInheritedEvidence, parent: AccountPreparationOwner, sourceOrigin: InactiveAccountWorkspace, cleanup?: AccountManagedCleanup): Promise<AccountInheritedEvidence> {
  const { handle, owner } = prepared
  const declaredRoot = { ...prepared.root }
  const parentJoin = cleanup?.owner(parent)
  const readers = cleanup?.group([])
  const group = parentJoin && readers && cleanup!.group([parentJoin, readers])
  const readerCleanup = readers && nestedCleanup(cleanup!, readers)
  registration(sourceOrigin, database, token)
  await check(sourceOrigin)
  await accountInheritedSources(handle)
  const root = { ...handle.root }
  if (!same(root, declaredRoot) || !owner.prepared(root)) throw failure()
  await handle.dispose()
  let adopted = false, reopened: AccountInheritedEvidence | undefined
  try {
    await parent.adopt(owner); adopted = true
    reopened = await openAccountInheritedEvidence(database, token, root, parent, readerCleanup)
    await check(sourceOrigin)
    // The source may outlive the target; the last awaited source check can retire the parent
    parent.check()
    return reopened
  } catch (error) {
    if (group && adopted) return openingFailure(error, group)
    try { await reopened?.dispose() } catch (cleanup) { error = new AggregateError([error, cleanup], 'Evidence adoption and reader cleanup failed') }
    if (adopted) await parent.abandon(error)
    throw error
  }
}

export async function rebindInactiveAccountWorkspace(database: AccountDatabase, token: ProfileToken, child: InactiveAccountWorkspace, parent: AccountPreparationOwner, cleanup?: AccountManagedCleanup): Promise<InactiveAccountWorkspace> {
  const source = registration(child, database, token)
  if (!source.owner || source.owner === parent) throw failure()
  const parentJoin = cleanup?.owner(parent)
  const readers = cleanup?.group([])
  const group = parentJoin && readers && cleanup!.group([parentJoin, readers])
  const readerCleanup = readers && nestedCleanup(cleanup!, readers)
  await check(child)
  const head = { ...child.head }, association = structuredClone(source.association)
  await child.dispose()
  let adopted = false
  try {
    await parent.adopt(source.owner); adopted = true
    return await openBound(database, token, head, { owner: parent, signal: source.signal, inputFormat: source.reader.inputFormat, cleanup: readerCleanup }, association)
  } catch (error) {
    if (group && adopted) return openingFailure(error, group)
    if (adopted) await parent.abandon(error)
    throw error
  }
}

// E calls this after authentication, then runs only native IDB equality requests inside its
// activation transaction, after immutable inserts and before changing the captured pointers
export async function prepareInactiveAccountSourceCheck(handle: InactiveAccountWorkspace): Promise<{ recheckInTransaction(): Promise<void> }> {
  await check(handle)
  const value = registration(handle), association = structuredClone(value.association)
  return Object.freeze({ async recheckInTransaction() {
    registration(handle)
    if (Dexie.currentTransaction?.db !== value.database) throw failure()
    if (!same(await value.database.profileMeta.get('active'), association.fence)) throw failure()
    for (const { id, row } of association.rows) if (!same(await value.database.syncState.get(id), row)) throw failure()
    for (const record of association.records) if (!sameRecord(await value.database.encryptedRevisions.get(record.revisionId), record)) throw failure()
    registration(handle)
  } })
}
