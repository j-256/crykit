import { z } from 'zod'
import { assertActiveProfile, profileSignal, withAccountKey, type ProfileToken } from '../profile'
import { ChangePageSchema, OpaqueIdSchema, RevisionDescriptorSchema, type ChangePage } from '../protocol'
import type { AccountDatabase, CipherRecord, CipherRef, EncryptedSyncState } from '../../persistence/account-database'
import { accountLocalId, CipherRefSchema, openAccountJson } from '../../workspace/account-cache'
import { blobIdentity } from '../../workspace/blobs'
import { workspaceControlDocumentId } from '../../workspace/directory'
import { SyncClient, SyncError } from './client'
import { readSyncState, writeSyncState, type TransferBudget } from './outbox'
import { BaselinePageSchema, DirectoryPageSchema, DirectorySchema, PublicationControlSchema, publicationPageSchema, stagePublicationPages } from './publication'
import { readPublicationPages } from './projection'

export const RemoteStateSchema = z.strictObject({ version: z.literal(1), kind: z.literal('remote-state'), cursor: z.string().nullable(), watermark: z.number().int().nonnegative().safe(), publicationEpoch: z.number().int().nonnegative().safe(), heads: CipherRefSchema, initialComplete: z.boolean(), projectionPending: z.boolean().optional(), effective: z.strictObject({ lineageId: z.string(), control: CipherRefSchema, units: CipherRefSchema }).optional() })
export type RemoteState = z.infer<typeof RemoteStateSchema>
export const HeadPageSchema = publicationPageSchema(CipherRefSchema, 'local-remote-heads')
const ScanSchema = z.strictObject({ version: z.literal(1), kind: z.literal('remote-scan'), base: CipherRefSchema.nullable(), cursor: z.string().nullable(), mode: z.enum(['initial', 'incremental']).optional(), watermark: z.number().int().nonnegative().safe().optional(), publicationEpoch: z.number().int().nonnegative().safe().optional(), heads: CipherRefSchema, complete: z.boolean(), page: ChangePageSchema.optional(), groupOffset: z.number().int().nonnegative() })
export type PullCandidate = { readonly previous?: EncryptedSyncState; readonly scanRow: EncryptedSyncState; readonly state: RemoteState; readonly heads: ReadonlyMap<string, string> }
export async function readRemoteState(database: AccountDatabase, token: ProfileToken) { return readSyncState(database, token, 'remote', RemoteStateSchema) }
export async function readRemoteHeads(database: AccountDatabase, token: ProfileToken, root: CipherRef): Promise<Map<string, string>> {
  const values = await readPublicationPages(database, token, root, HeadPageSchema, () => [])
  if (new Set(values.map(value => value.documentId)).size !== values.length) throw new SyncError('INTEGRITY_FAILED')
  return new Map(values.map(({ documentId, revisionId }) => [documentId, revisionId]))
}
async function saveHeads(database: AccountDatabase, token: ProfileToken, heads: ReadonlyMap<string, string>) {
  return stagePublicationPages(database, token, 'local-remote-heads', [...heads].map(([documentId, revisionId]) => ({ documentId, revisionId })), () => [])
}
export function assertPullHighWater(page: ChangePage, previous: Pick<RemoteState, 'watermark' | 'publicationEpoch'>): void {
  if (page.groups.some((group, index) => index > 0 && group.sequence <= page.groups[index - 1].sequence)) throw new SyncError('INTEGRITY_FAILED')
  if (page.watermark < previous.watermark || page.publicationEpoch < previous.publicationEpoch || page.groups.some(group => group.sequence > page.watermark)) throw new SyncError('STALE_CURSOR')
}

// Registration metadata is inert; only required explicit-head closure downloads can reach projection validation
export async function ensureRemoteClosure(database: AccountDatabase, token: ProfileToken, client: SyncClient, roots: readonly CipherRef[], budget: TransferBudget): Promise<boolean> {
  return closureReader(database, token, client, budget)(roots)
}

const CLOSURE_READ_WINDOW = 32
const CLOSURE_KEY_WINDOW = 128
type ClosureVisit = { readonly ref: CipherRef; readonly payload: boolean }
type ClosureLocalRead = { readonly record?: CipherRecord; readonly error?: unknown; present?: ReadonlySet<number> }
const visitIdentity = ({ ref, payload }: ClosureVisit) => `${blobIdentity(ref)}:${payload}`

function checkClosureRecord(database: AccountDatabase, token: ProfileToken, ref: CipherRef, record: CipherRecord): void {
  RevisionDescriptorSchema.parse(record.descriptor)
  OpaqueIdSchema.parse(record.payloadId)
  if (database.accountId !== token.accountId || record.revisionId !== ref.revisionId || record.descriptor.revisionId !== ref.revisionId
    || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new SyncError('INTEGRITY_FAILED')
}

export async function reserveFreshPullPayload(database: AccountDatabase, token: ProfileToken, record: CipherRecord): Promise<void> {
  checkClosureRecord(database, token, { documentId: record.descriptor.documentId, revisionId: record.revisionId }, record)
  OpaqueIdSchema.parse(record.payloadId)
  // A fresh pull reserves its payload by installing the descriptor first; the same native
  // transaction excludes staged orphan chunks and serializes against local first writes
  await database.transaction('rw', database.encryptedRevisions, database.stagedCipherChunks, async () => {
    assertActiveProfile(token)
    if (await database.encryptedRevisions.where('payloadId').equals(record.payloadId).count()
      || await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()) throw new SyncError('INTEGRITY_FAILED')
    await database.encryptedRevisions.add(record)
    assertActiveProfile(token)
  })
}

async function closureReadTransaction<T>(database: AccountDatabase, token: ProfileToken, read: (transaction: import('dexie').Transaction) => Promise<T>): Promise<T> {
  assertActiveProfile(token)
  const signal = profileSignal(token)
  let active: import('dexie').Transaction | undefined
  const abort = () => active?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const result = await database.transaction('r', database.encryptedRevisions, database.stagedCipherChunks, async transaction => {
      active = transaction
      assertActiveProfile(token)
      const result = await read(transaction)
      assertActiveProfile(token)
      return result
    })
    assertActiveProfile(token)
    return result
  } finally { signal.removeEventListener('abort', abort) }
}

async function readChunkPresence(transaction: import('dexie').Transaction, records: readonly CipherRecord[]): Promise<ReadonlySet<number>[]> {
  // Presence needs keys only; loading ciphertext here can copy a full chunk for every repeated traversal
  // All requests are queued in this bounded readonly transaction, with no network or crypto await
  const store = transaction.idbtrans.objectStore('stagedCipherChunks')
  const present = records.map(() => new Set<number>())
  await Promise.all(records.flatMap((record, ordinal) => record.descriptor.chunks.map(chunk => new Promise<void>((resolve, reject) => {
    const request = store.getKey([record.payloadId, chunk.index])
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const key = request.result
      if (key !== undefined) {
        if (!Array.isArray(key) || key[0] !== record.payloadId || key[1] !== chunk.index) { reject(new SyncError('INTEGRITY_FAILED')); return }
        present[ordinal].add(chunk.index)
      }
      resolve()
    }
  }))))
  return present
}

async function readClosureWindow(database: AccountDatabase, token: ProfileToken, visits: readonly ClosureVisit[]): Promise<Map<string, ClosureLocalRead>> {
  return closureReadTransaction(database, token, async transaction => {
    const records = await database.encryptedRevisions.bulkGet(visits.map(({ ref }) => ref.revisionId))
    assertActiveProfile(token)
    const window = new Map<string, ClosureLocalRead>(), payloads: { read: ClosureLocalRead; record: CipherRecord }[] = []
    let keysRemaining = CLOSURE_KEY_WINDOW
    for (const [index, visit] of visits.entries()) {
      const record = records[index], read: ClosureLocalRead = { record }
      window.set(visitIdentity(visit), read)
      try {
        CipherRefSchema.parse(visit.ref)
        if (!record) continue
        checkClosureRecord(database, token, visit.ref, record)
        if (visit.payload && record.descriptor.chunks.length <= keysRemaining) {
          keysRemaining -= record.descriptor.chunks.length
          payloads.push({ read, record })
        }
      } catch (error) {
        // Speculative siblings cannot reorder the DFS's earlier transfer, budget or error outcome
        window.set(visitIdentity(visit), { error })
      }
    }
    const present = await readChunkPresence(transaction, payloads.map(({ record }) => record))
    for (const [index, value] of payloads.entries()) value.read.present = present[index]
    return window
  })
}

function closureReader(database: AccountDatabase, token: ProfileToken, client: SyncClient, budget: TransferBudget) {
  // Only this pull operation shares completed immutable D/R visits, separately for parent metadata and payload
  // Partial-budget traversals confer no reusable completeness; a resumed operation starts with an empty set
  const completed = new Set<string>()
  return async (roots: readonly CipherRef[]): Promise<boolean> => {
    assertActiveProfile(token)
    if (database.accountId !== token.accountId) throw new SyncError('INTEGRITY_FAILED')
    const pending: ClosureVisit[] = roots.map(ref => ({ ref, payload: true })), seen = new Set<string>()
    // Rows and presence live only in this invocation; even incomplete retries read a new local snapshot
    let window = new Map<string, ClosureLocalRead>()
    while (pending.length) {
      const visit = pending.pop()!, { ref, payload } = visit, id = visitIdentity(visit)
      assertActiveProfile(token)
      CipherRefSchema.parse(ref)
      if (completed.has(id) || seen.has(id)) continue
      seen.add(id)
      if (!window.has(id)) {
        // End the prior window before loading another, bounding live descriptor rows independently of graph size
        window.clear()
        const visits = [visit], selected = new Set([id])
        for (let index = pending.length - 1; index >= 0 && visits.length < CLOSURE_READ_WINDOW; index--) {
          const candidate = pending[index], identity = visitIdentity(candidate)
          if (selected.has(identity) || seen.has(identity) || completed.has(identity)) continue
          visits.push(candidate); selected.add(identity)
        }
        window = await readClosureWindow(database, token, visits)
      }
      assertActiveProfile(token)
      const local = window.get(id)!
      if (local.error !== undefined) throw local.error
      let record = local.record
      if (!record) {
        if (budget.metadataRemaining === 0) { assertActiveProfile(token); return false }
        budget.metadataRemaining--
        const descriptor = await client.revision(ref.revisionId)
        if (descriptor.documentId !== ref.documentId || descriptor.accountId !== token.accountId || descriptor.revisionId !== ref.revisionId) throw new SyncError('INTEGRITY_FAILED')
        record = { revisionId: ref.revisionId, payloadId: accountLocalId(), descriptor }
        assertActiveProfile(token)
        checkClosureRecord(database, token, ref, record)
        await reserveFreshPullPayload(database, token, record)
        // Another prefetched role may have observed this row absent before its metadata-only visit
        window.clear()
        local.present = new Set()
      }
      checkClosureRecord(database, token, ref, record)
      if (payload) {
        local.present ??= (await closureReadTransaction(database, token, transaction => readChunkPresence(transaction, [record])))[0]
        assertActiveProfile(token)
        for (const chunk of record.descriptor.chunks) {
          assertActiveProfile(token)
          if (local.present.has(chunk.index)) continue
          if (budget.remaining === 0) return false
          budget.remaining--
          const bytes = await client.chunk(ref.revisionId, chunk.index)
          if (bytes.length !== chunk.cipherBytes) throw new SyncError('INTEGRITY_FAILED')
          assertActiveProfile(token)
          await database.stagedCipherChunks.put({ payloadId: record.payloadId, index: chunk.index, bytes })
        }
        pending.push(...record.descriptor.dependencies.map(ref => ({ ref, payload: true })))
      }
      pending.push(...record.descriptor.parents.map(revisionId => ({ ref: { documentId: ref.documentId, revisionId }, payload: false })))
    }
    assertActiveProfile(token)
    for (const id of seen) completed.add(id)
    return true
  }
}
export async function ensureProjectionClosure(database: AccountDatabase, token: ProfileToken, client: SyncClient, heads: ReadonlyMap<string, string>, budget: TransferBudget): Promise<boolean> {
  return ensureProjectionWithReader(database, token, heads, closureReader(database, token, client, budget))
}

async function ensureProjectionWithReader(database: AccountDatabase, token: ProfileToken, heads: ReadonlyMap<string, string>, ensure: (roots: readonly CipherRef[]) => Promise<boolean>): Promise<boolean> {
  const documentId = await withAccountKey(token, key => workspaceControlDocumentId(key, token.accountId))
  const revisionId = heads.get(documentId)
  if (!revisionId) return true
  const ref = { documentId, revisionId }
  if (!await ensure([ref])) return false
  const root = await openAccountJson(database, token, ref, PublicationControlSchema)
  const baseline = await readPublicationPages(database, token, root.baseline, BaselinePageSchema, entry => [entry.seed])
  const values = new Map(baseline.filter(entry => entry.kind !== 'directory').map(entry => [entry.key, entry]))
  const allocations = new Map<string, string>()
  for (const entry of baseline) {
    if (entry.kind !== 'directory') { allocations.set(entry.key, entry.seed.documentId); continue }
    const physical = heads.get(entry.seed.documentId) ?? null
    const selected = physical === entry.replacedHead ? entry.seed : physical ? { documentId: entry.seed.documentId, revisionId: physical } : undefined
    if (!selected) throw new SyncError('INTEGRITY_FAILED')
    if (!await ensure([selected])) return false
    const directory = await openAccountJson(database, token, selected, DirectorySchema)
    for (const allocation of await readPublicationPages(database, token, directory.index, DirectoryPageSchema, () => [])) allocations.set(allocation.key, allocation.documentId)
  }
  for (const [key, documentId] of allocations) {
    const seed = values.get(key), physical = heads.get(documentId) ?? null
    if (seed?.kind === 'immutable' || (seed?.kind === 'mutable' || seed?.kind === 'lineage') && seed.replacedHead === physical) continue
    if (!physical) throw new SyncError('INTEGRITY_FAILED')
    if (!await ensure([{ documentId, revisionId: physical }])) return false
  }
  return true
}

export async function stagePull(database: AccountDatabase, token: ProfileToken, client: SyncClient, validate: (heads: ReadonlyMap<string, string>) => Promise<void>, budget: TransferBudget): Promise<PullCandidate | null> {
  const ensure = closureReader(database, token, client, budget)
  const ensureProjection = (heads: ReadonlyMap<string, string>) => ensureProjectionWithReader(database, token, heads, ensure)
  const remote = await readRemoteState(database, token)
  let saved = await readSyncState(database, token, 'scan', ScanSchema)
  if (!saved || JSON.stringify(saved.value.base) !== JSON.stringify(remote?.row.ref ?? null)) {
    const heads = remote?.value.heads ?? await saveHeads(database, token, new Map())
    const value: z.infer<typeof ScanSchema> = { version: 1, kind: 'remote-scan', base: remote?.row.ref ?? null, cursor: remote?.value.cursor ?? null, heads, complete: false, groupOffset: 0 }
    const row = await writeSyncState(database, token, 'scan', value, saved?.row, [heads])
    saved = { row, value }
  }
  const scan = saved.value
  const save = async () => { saved!.row = await writeSyncState(database, token, 'scan', scan, saved!.row, [scan.heads]) }
  if (!scan.complete && !scan.page) {
    let page: ChangePage
    try { page = await client.changes(scan.cursor) }
    catch (error) {
      if (!(error instanceof SyncError && error.code === 'STALE_CURSOR')) throw error
      // Restart discovery separately; the last coherent projection and freshness floor remain active
      scan.cursor = null; scan.heads = await saveHeads(database, token, new Map()); delete scan.mode; delete scan.watermark; delete scan.publicationEpoch; await save(); return null
    }
    assertPullHighWater(page, remote?.value ?? { watermark: 0, publicationEpoch: 0 })
    if (scan.mode && (page.mode !== scan.mode || page.watermark !== scan.watermark || page.publicationEpoch !== scan.publicationEpoch)) throw new SyncError('INTEGRITY_FAILED')
    if (scan.cursor === null && page.mode !== 'initial') throw new SyncError('INTEGRITY_FAILED')
    if (page.hasMore && page.cursor === scan.cursor) throw new SyncError('INTEGRITY_FAILED')
    scan.mode = page.mode; scan.watermark = page.watermark; scan.publicationEpoch = page.publicationEpoch; scan.page = page; scan.groupOffset = 0
    await save()
  }
  let heads = await readRemoteHeads(database, token, scan.heads)
  // Rebuild the exact staged predecessor only when the next complete group can be checked
  // Download-only retries cannot advance authority and need not repeat semantic validation
  let restorePredecessor = scan.mode === 'incremental' && JSON.stringify(scan.heads) !== JSON.stringify(remote?.value.heads)
  let validatedHeads = false
  const restore = async (): Promise<boolean> => {
    if (!restorePredecessor) return true
    if (!await ensureProjection(heads)) return false
    await validate(heads)
    restorePredecessor = false
    validatedHeads = true
    return true
  }
  if (scan.page) {
    const page = scan.page
    while (scan.groupOffset < page.groups.length) {
      const group = page.groups[scan.groupOffset]
      if (page.mode === 'incremental' && group.sequence <= (remote?.value.watermark ?? 0)) throw new SyncError('STALE_CURSOR')
      const next = new Map(heads)
      for (const head of group.heads) next.set(head.documentId, head.revisionId)
      // Initial pages form one indivisible snapshot; incremental commands must each leave a valid graph
      if (page.mode === 'incremental' && group.heads.length) {
        if (!await ensureProjection(next)) return null
        if (!await restore()) return null
        await validate(next)
        validatedHeads = true
      }
      heads = next
      scan.groupOffset++
      // One authenticated scan revision binds the completed group offset to exactly its checked heads
      scan.heads = await saveHeads(database, token, heads)
      await save()
    }
    scan.heads = await saveHeads(database, token, heads); scan.cursor = page.cursor; scan.complete = !page.hasMore; delete scan.page
    await save()
  }
  if (!scan.complete) return null
  if (!await ensureProjection(heads)) return null
  if (!validatedHeads) { if (!await restore()) return null; if (!validatedHeads) await validate(heads) }
  const state: RemoteState = { version: 1, kind: 'remote-state', cursor: scan.cursor, watermark: scan.watermark!, publicationEpoch: scan.publicationEpoch!, heads: scan.heads, initialComplete: true }
  // Caller activates this prepared state with the projection under one local transaction
  return { previous: remote?.row, scanRow: saved.row, state, heads }
}

export async function activatePulledState(database: AccountDatabase, token: ProfileToken, candidate: PullCandidate, expected: import('../../persistence/account-database').AccountFence, prepared?: import('../../workspace/account-graph').PreparedAccountWorkspace, completed?: { readonly intent: import('../../persistence/account-database').AccountIntentRecord; readonly publication: EncryptedSyncState }, publicationOnly?: EncryptedSyncState, assertMayActivate: () => void = () => {}, acceptedBodies: readonly string[] = [], newIntent?: { readonly id: string; readonly ref: CipherRef; readonly records: readonly CipherRecord[] }, managed?: import('../../persistence/account-database').PreparedLocalActivation): Promise<void> {
  // Ignore opened functions and caller owner claims; only this captured envelope can publish
  candidate = structuredClone(candidate)
  expected = structuredClone(expected)
  const selected = managed ? structuredClone({ head: managed.head, records: managed.records }) : prepared ? structuredClone({ head: prepared.head, records: prepared.records }) : undefined
  if (managed && (!prepared || JSON.stringify(managed.expected) !== JSON.stringify(expected) || managed.requireSettledSync || JSON.stringify(managed.intent) !== JSON.stringify(newIntent?.ref) || newIntent && managed.id !== newIntent.id)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const managedSelection = managed ? (await import('../../workspace/account-local-store')).accountLocalActivationCheck(database, token, managed) : undefined
  const validatedEvidence = prepared?.validatedEvidence
  newIntent = structuredClone(newIntent)
  if (newIntent && (!selected || completed || publicationOnly)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  completed = structuredClone(completed)
  publicationOnly = structuredClone(publicationOnly)
  acceptedBodies = [...acceptedBodies]
  const { prepareSelectedV1Check } = await import('../../workspace/account-selection')
  const selection = managedSelection ?? (selected ? await prepareSelectedV1Check(database, token, { ...selected, validatedEvidence }) : undefined)
  const { stageAccountJson, cipherRef } = await import('../../workspace/account-cache')
  const { profileSignal } = await import('../profile')
  const record = await stageAccountJson(database, token, candidate.state, [candidate.state.heads, ...(candidate.state.effective ? [candidate.state.effective.control, candidate.state.effective.units] : [])])
  const signal = profileSignal(token)
  let transaction: import('dexie').Transaction | undefined
  const abort = () => transaction?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await database.transaction('rw', database.tables, async current => {
      transaction = current
      assertActiveProfile(token)
      if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(expected)
        || JSON.stringify(await database.syncState.get('remote')) !== JSON.stringify(candidate.previous)
        || JSON.stringify(await database.syncState.get('scan')) !== JSON.stringify(candidate.scanRow)) throw new SyncError('LOCAL_REVISION_CONFLICT')
      const publication = completed?.publication ?? publicationOnly
      if (publication && JSON.stringify(await database.syncState.get('publication')) !== JSON.stringify(publication)) throw new SyncError('LOCAL_REVISION_CONFLICT')
      if (completed && JSON.stringify(await database.outbox.get(completed.intent.id)) !== JSON.stringify(completed.intent)) throw new SyncError('LOCAL_REVISION_CONFLICT')
      if (newIntent && await database.outbox.count()) throw new SyncError('LOCAL_REVISION_CONFLICT')
      await managedSelection?.installInlineInTransaction()
      const records = [...(selected?.records ?? []), ...(managed ? [] : newIntent?.records ?? []), record]
      for (const value of records) {
        for (const chunk of managedSelection?.hasInlineRecord(value) ? [] : value.descriptor.chunks) if ((await database.stagedCipherChunks.get([value.payloadId, chunk.index]))?.bytes.length !== chunk.cipherBytes) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        await database.encryptedRevisions.add(value)
      }
      if (managedSelection) {
        for (const value of records) for (const ref of value.descriptor.dependencies) {
          if (managedSelection.isUnchangedDependency(ref) || managedSelection.preparedDependency(ref)) continue
          const dependency = await database.encryptedRevisions.get(ref.revisionId)
          if (!dependency || dependency.descriptor.documentId !== ref.documentId || dependency.descriptor.accountId !== token.accountId) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        }
      }
      if (selected) {
        await selection!.recheckInTransaction()
        await selection!.recheckSourceCapturesInTransaction()
        assertMayActivate()
        const fence = { ...expected, headRevision: expected.headRevision + 1, head: selected.head }
        if (!Number.isSafeInteger(fence.headRevision)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        await database.documentHeads.put(selected.head)
        await database.profileMeta.put(fence)
        await database.migrationJournal.add({ id: managed?.id ?? newIntent?.id ?? accountLocalId(), version: 1, head: selected.head, headRevision: fence.headRevision, ...(newIntent ? { intent: newIntent.ref } : {}), localStatus: 'active', cloudStatus: 'mapped-local' })
      }
      await database.syncState.put({ id: 'remote', ref: cipherRef(record) })
      if (!candidate.state.projectionPending) await database.syncState.put({ id: 'projection', ref: cipherRef(record) })
      if (newIntent) {
        // Capture the same effective projection as ordinary local commands, within this head transaction
        // Without this base, a later publication cannot prove the lineage used by the evidence-only command
        const publicationBase = (await database.syncState.get('projection'))?.ref
        await database.outbox.add({ id: newIntent.id, ref: newIntent.ref, status: 'mapped-local', ...(publicationBase ? { publicationBase } : {}) })
      }
      await database.syncState.delete('scan')
      if (completed) await database.outbox.delete(completed.intent.id)
      if (publication) {
        // Retain accepted command bytes and body-to-authoritative-envelope bindings for captured bases
        await database.syncState.put({ id: `accepted:${publication.ref.revisionId}`, ref: publication.ref })
        for (const revisionId of acceptedBodies) {
          const id = `binding:${revisionId}`
          if (!await database.syncState.get(id)) await database.syncState.put({ id, ref: publication.ref })
        }
        await database.syncState.delete('publication')
      }
      assertMayActivate()
      assertActiveProfile(token)
    })
  } finally { signal.removeEventListener('abort', abort) }
}
