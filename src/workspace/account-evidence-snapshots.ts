import { z } from 'zod'
import { accountCleanupOnlyFailure, accountPreparationFailure, assertAccountCleanupJoinable, hasNewAccountCleanupFailure, readAccountCleanupOnlyFailure, readAccountPreparationFailure, type AccountCleanupGroup, type AccountCleanupJoin, type AccountCleanupResult, type AccountManagedCleanup } from './account-cleanup-attempt'
import { assertActiveProfile, profileSignal, registerProfileCleanup, type ProfileToken } from '../account/profile'
import { maxDependencies, maxDocumentBytes } from '../account/protocol'
import type { AccountDatabase, CipherRecord, CipherRef } from '../persistence/account-database'
import { CipherRefSchema, cipherRef, stageAccountBytes } from './account-cache'
import { beginPreparedRead, createAccountPreparationOwner, resolveAccountRecord, type AccountPreparationOwner } from './account-prepared-records'
import { openAccountSource, stageAccountSource } from './account-streams'
import { buildIndexPages, INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'
import { WorkspaceBlobRefSchema } from './file-schemas'
import type { BlobSource, WorkspaceBlobRef } from './documents'
import { blobIdentity, hashBlob } from './blobs'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { attachBackupBodies, capturedBackupEvidence, compareBackupRefs, equalMetadataStreams, historicalMetadataIdentity, readBackupMetadata, type InheritedSnapshotSources, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { inheritedSnapshotSetDigest } from '../interchange/identity'
import { assertOwnedWorkspaceSnapshot, validateWorkspaceSnapshotV1, type WorkspaceSnapshotV2 } from './snapshot'
import { withImmutableWorkspaceBodyValidation } from './closure'
import { guestEvidenceSources, type CapturedGuestEvidence } from './guest-evidence'

const integer = z.number().int().nonnegative().safe()
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const rootSchema = z.strictObject({ version: z.literal(1), kind: z.literal('inherited-snapshot-evidence'), setDigest: digest, members: CipherRefSchema, blobs: CipherRefSchema })
const streamSchema = z.strictObject({ version: z.literal(1), kind: z.literal('evidence-metadata-stream'), codec: z.literal('backup-json-tokens-v1'), digest, byteLength: integer, pages: CipherRefSchema })
const memberSchema = z.strictObject({ id: digest, metadata: CipherRefSchema, blobSubset: CipherRefSchema })
const bodySchema = z.strictObject({ source: WorkspaceBlobRefSchema, content: CipherRefSchema })
const segmentSchema = z.strictObject({ ordinal: integer, byteLength: integer.positive().max(WORKSPACE_BACKUP_LIMITS.payload), sha256: digest, content: CipherRefSchema })
function pageSchema<K extends string, T>(kind: K, entry: z.ZodType<T>) {
  return z.strictObject({ version: z.literal(1), kind: z.literal(kind), entries: z.array(entry).max(INDEX_PAGE_ENTRIES), children: z.array(CipherRefSchema).max(INDEX_PAGE_ENTRIES) })
    .refine(page => !(page.entries.length && page.children.length), 'Mixed evidence page')
}
const memberPage = pageSchema('evidence-member-page', memberSchema)
const blobPage = pageSchema('evidence-blob-page', bodySchema)
const subsetPage = pageSchema('evidence-subset-page', bodySchema)
const metadataPage = pageSchema('evidence-metadata-page', segmentSchema)
type Body = z.infer<typeof bodySchema>
type Segment = z.infer<typeof segmentSchema>
type Member = z.infer<typeof memberSchema>
type MemberStream = Member & { readonly segments: readonly Segment[]; readonly byteLength: number; readonly subset: readonly WorkspaceBlobRef[] }
const refKey = (ref: CipherRef) => JSON.stringify([ref.documentId, ref.revisionId])
const sameRef = (a: WorkspaceBlobRef, b: WorkspaceBlobRef) => compareBackupRefs(a, b) === 0 && a.encoding === b.encoding && a.byteLength === b.byteLength && a.sha256 === b.sha256
const uniqueRefs = (refs: readonly CipherRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()]
const hashBytes = (bytes: Uint8Array) => hashBlob({ byteLength: bytes.length, async *open() { yield bytes } })
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function checked(current: number, increment: number, limit: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(increment) || increment < 0 || increment > limit - current) throw new Error('Account evidence resource limit')
  return current + increment
}

// One pass owns these counters, including rereads made by identity and frozen v1 validators
// Scheduling reserves visits before queues grow; shared native bodies are the only reusable role
class Budget {
  readonly visits = new Map<string, string>()
  declared = 0
  read = 0
  segments = 0
  private readonly originals = new Set<string>()
  private originalKey(id: string, ordinal: number): string { return JSON.stringify(['original', id, ordinal]) }
  original(id: string, ordinal: number): void {
    const key = this.originalKey(id, ordinal)
    if (this.originals.has(key)) return
    this.room(1); this.segment()
    this.originals.add(key); this.visits.set(key, 'original')
  }
  stagedOriginal(id: string, ordinal: number): void {
    // Transfer the reserved visit to its encrypted record; rereads retain the original identity
    const key = this.originalKey(id, ordinal)
    if (!this.visits.delete(key)) throw new Error('Missing account metadata segment reservation')
  }
  reserve(ref: CipherRef, role: string): void {
    const key = refKey(ref), previous = this.visits.get(key)
    if (previous !== undefined) {
      if (role !== 'body' || previous !== role) throw new Error('Repeated or cyclic account evidence record')
      return
    }
    checked(this.visits.size, 1, WORKSPACE_BACKUP_LIMITS.frames)
    this.visits.set(key, role)
  }
  room(count: number): void { checked(this.visits.size, count, WORKSPACE_BACKUP_LIMITS.frames) }
  depth(depth: number): void { checked(0, depth, WORKSPACE_BACKUP_LIMITS.depth) }
  segment(): void { this.segments = checked(this.segments, 1, WORKSPACE_BACKUP_LIMITS.frames) }
  declare(bytes: number): void { this.declared = checked(this.declared, bytes, WORKSPACE_BACKUP_LIMITS.bytes) }
  consume(bytes: number): void { this.read = checked(this.read, bytes, WORKSPACE_BACKUP_LIMITS.bytes) }
  potential(bytes: number): void { checked(this.declared, bytes, WORKSPACE_BACKUP_LIMITS.bytes) }
  stream(bytes: number): void {
    this.potential(bytes)
    checked(0, bytes, (WORKSPACE_BACKUP_LIMITS.frames - this.segments) * WORKSPACE_BACKUP_LIMITS.payload)
  }
}

// A handle owns only its iterators and copied plaintext, never an owner's entire reader set
class ReadLifetime {
  private closed = false
  private metadataActive = false
  private readonly readers = new Set<() => Promise<void>>()
  constructor(private readonly fresh: () => Promise<void>, private readonly owner?: AccountPreparationOwner, private readonly onDispose?: () => void) {}
  assertOpen(): void { if (this.closed) throw new Error('Account evidence handle was released') }
  async check(): Promise<void> { this.assertOpen(); await this.fresh(); this.assertOpen() }
  source(source: BlobSource, serial = false, fresh: () => Promise<void> = async () => {}, consume: (bytes: Uint8Array) => void = () => {}): BlobSource {
    const lifetime = this
    return { byteLength: source.byteLength, open() {
      if (lifetime.closed) throw new Error('Account evidence handle was released')
      if (serial && lifetime.metadataActive) throw new Error('Release the account historical reader before opening another')
      const lease = beginPreparedRead(lifetime.owner)
      if (serial) lifetime.metadataActive = true
      const buffers = new Set<Uint8Array>()
      let input: AsyncIterator<Uint8Array> | undefined, released = false, cancellation: Promise<void> | undefined
      const finish = () => { if (released) return; released = true; for (const buffer of buffers) buffer.fill(0); buffers.clear(); lifetime.readers.delete(cancel); if (serial) lifetime.metadataActive = false; lease?.finish() }
      const iterator = (async function* () {
        let length = 0
        try {
          await lifetime.check(); await fresh(); lease?.check()
          input = source.open()[Symbol.asyncIterator]()
          while (true) {
            const next = await input.next()
            await lifetime.check(); await fresh(); lease?.check()
            if (next.done) { if (length !== source.byteLength) throw new Error('Account evidence source length mismatch'); break }
            length = checked(length, next.value.length, source.byteLength)
            consume(next.value)
            const bytes = next.value.slice(); buffers.add(bytes)
            try { yield bytes; await lifetime.check(); await fresh() } finally { bytes.fill(0); buffers.delete(bytes) }
          }
        } finally { try { await input?.return?.() } finally { finish() } }
      })()
      const cancel = () => {
        for (const bytes of buffers) bytes.fill(0)
        return cancellation ??= (async () => {
          // A custom source can unblock a pending next through return; asking only the outer
          // generator to return queues behind that next and would deadlock abandonment
          try { await input?.return?.() } finally { try { await iterator.return(undefined) } finally { finish() } }
        })()
      }
      lifetime.readers.add(cancel); lease?.setCancel(cancel)
      const wrapped: AsyncIterableIterator<Uint8Array> = {
        async next() { await lifetime.check(); return iterator.next() },
        async return() { await cancel(); return { done: true as const, value: undefined } },
        async throw(error?: unknown) { await cancel(); throw error },
        [Symbol.asyncIterator]() { return this },
      }
      return wrapped
    } }
  }
  // Authentication has no public stream wrapper yet: own its physical iterator without
  // another consumer or byte accounting pass, and never wait on the consuming generator
  track(input: AsyncIterator<Uint8Array>): () => void {
    let cancellation: Promise<void> | undefined
    const cancel = () => cancellation ??= (async () => { await input.return?.() })()
    this.readers.add(cancel)
    return () => { this.readers.delete(cancel) }
  }
  async dispose(): Promise<void> {
    this.closed = true
    try {
      const results = await Promise.allSettled([...this.readers].map(cancel => cancel()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Account evidence reader cleanup failed')
    } finally { this.onDispose?.() }
  }
}

export interface AccountInheritedEvidence {
  readonly origin: 'evidence-v1'
  readonly root: CipherRef
  readonly setDigest: string
  readonly members: readonly { readonly id: string }[]
  check(): Promise<void>
  dispose(): Promise<void>
}
export interface PrepareAccountInheritedEvidenceInput { readonly base?: AccountInheritedEvidence; readonly merge?: AccountInheritedEvidence; readonly additions?: readonly WorkspaceSnapshotV2[]; readonly sourceEvidence?: CapturedGuestEvidence; readonly signal?: AbortSignal }
export interface PreparedAccountInheritedEvidence { readonly root: CipherRef; readonly records: readonly CipherRecord[]; readonly handle: AccountInheritedEvidence; readonly owner: AccountPreparationOwner; dispose(): Promise<void> }
export interface AccountInheritedEvidencePreparation { prepare(input: PrepareAccountInheritedEvidenceInput): Promise<PreparedAccountInheritedEvidence>; abandon(): Promise<void> }
export interface ManagedAccountInheritedEvidencePreparation extends AccountInheritedEvidencePreparation { readonly cleanup: AccountCleanupJoin }
interface Registration {
  readonly database: AccountDatabase
  readonly token: ProfileToken
  readonly lifetime: ReadLifetime
  readonly sources: (budget: Budget) => InheritedSnapshotSources
}
const registered = new WeakMap<AccountInheritedEvidence, Registration>()
function registration(handle: AccountInheritedEvidence): Registration {
  const value = registered.get(handle)
  if (!value) throw new Error('A registered account evidence handle is required')
  return value
}
export async function assertAccountInheritedEvidenceOwner(handle: AccountInheritedEvidence, database: AccountDatabase, token: ProfileToken): Promise<void> {
  const value = registration(handle)
  if (value.database !== database || value.token.accountId !== token.accountId || value.token.generation !== token.generation) throw new Error('Foreign account evidence handle')
  await handle.check()
}

class GraphReader {
  readonly records = new Map<string, CipherRecord>()
  constructor(readonly database: AccountDatabase, readonly token: ProfileToken, readonly budget: Budget, readonly check: () => Promise<void>, readonly owner?: AccountPreparationOwner, private readonly authenticationLifetime?: ReadLifetime) {}
  async record(ref: CipherRef, limit: number): Promise<CipherRecord> {
    await this.check()
    const record = await resolveAccountRecord(this.database, this.token, ref, this.owner)
    await this.check()
    if (!record.descriptor.protected || record.descriptor.plainBytes > limit) throw new Error('Invalid protected account evidence record size')
    const key = refKey(ref), previous = this.records.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Account evidence descriptor changed')
    if (!previous) { this.budget.declare(record.descriptor.plainBytes); this.records.set(key, freeze(structuredClone(record))) }
    return record
  }
  edges(record: CipherRecord, refs: readonly CipherRef[]): void {
    const expected = new Set(uniqueRefs(refs).map(refKey)), actual = record.descriptor.dependencies
    if (actual.length !== expected.size || actual.some(ref => !expected.has(refKey(ref)))) throw new Error('Account evidence descriptor edge mismatch')
  }
  source(ref: CipherRef, limit: number): BlobSource {
    const captured = this.records.get(refKey(ref))
    if (!captured) throw new Error('Unresolved account evidence record')
    const reader = this
    return { byteLength: captured.descriptor.plainBytes, async *open() {
      await reader.record(ref, limit)
      checked(reader.budget.read, captured.descriptor.plainBytes, WORKSPACE_BACKUP_LIMITS.bytes)
      const source = await openAccountSource(reader.database, reader.token, ref, reader.owner, captured)
      await reader.check()
      let length = 0
      // Retirement can run after the awaited check passes; admission, allocation and
      // registration must share a turn so completed cleanup cannot miss a late iterator
      reader.authenticationLifetime?.assertOpen()
      const input = source.open()[Symbol.asyncIterator]()
      const finish = reader.authenticationLifetime?.track(input)
      try {
        // Keep for-await's primary-error precedence when natural iterator return also fails
        // This iterable exposes the already owned input without a second consumer
        for await (const bytes of { [Symbol.asyncIterator]: () => input }) {
          reader.budget.consume(bytes.length)
          length = checked(length, bytes.length, captured.descriptor.plainBytes)
          await reader.check()
          yield bytes
          await reader.check()
        }
      } finally { finish?.() }
      if (length !== captured.descriptor.plainBytes) throw new Error('Account evidence plaintext length mismatch')
      await reader.check()
    } }
  }
  async bytes(ref: CipherRef, limit: number): Promise<Uint8Array> {
    const record = await this.record(ref, limit)
    checked(this.budget.read, record.descriptor.plainBytes, WORKSPACE_BACKUP_LIMITS.bytes)
    const result = new Uint8Array(record.descriptor.plainBytes)
    let offset = 0
    try { for await (const bytes of this.source(ref, limit).open()) { result.set(bytes, offset); offset += bytes.length } return result }
    catch (error) { result.fill(0); throw error }
  }
  async json<T>(ref: CipherRef, schema: z.ZodType<T>, edges: (value: T) => readonly CipherRef[]): Promise<T> {
    const bytes = await this.bytes(ref, INDEX_PAGE_BYTES)
    try {
      const value = schema.parse(parseBoundedJson(bytes, 'account evidence page', NATIVE_BACKUP_JSON_LIMITS))
      this.edges(this.records.get(refKey(ref))!, edges(value))
      return value
    } finally { bytes.fill(0) }
  }
  async pages<T>(ref: CipherRef, schema: z.ZodType<{ version: 1; kind: string; entries: T[]; children: CipherRef[] }>, role: string, edges: (entry: T) => readonly CipherRef[]): Promise<T[]> {
    const pending = [{ ref, depth: 1 }], result: T[] = []
    this.budget.reserve(ref, role)
    while (pending.length) {
      const next = pending.pop()!
      this.budget.depth(next.depth)
      const page = await this.json(next.ref, schema, value => [...value.children, ...value.entries.flatMap(edges)])
      this.budget.room(page.children.length + page.entries.length)
      if (page.children.length) this.budget.depth(next.depth + 1)
      for (const child of page.children) this.budget.reserve(child, role)
      for (let index = page.children.length - 1; index >= 0; index--) pending.push({ ref: page.children[index], depth: next.depth + 1 })
      checked(result.length, page.entries.length, WORKSPACE_BACKUP_LIMITS.frames)
      result.push(...page.entries)
    }
    return result
  }
  // Account chunk boundaries are transport details; each yielded value must reconstruct exactly
  // one original token page because the frozen backup decoder parses each page independently
  metadata(segments: readonly Segment[], byteLength: number): BlobSource {
    const reader = this
    return { byteLength, async *open() {
      for (const segment of segments) {
        const bytes = await reader.bytes(segment.content, WORKSPACE_BACKUP_LIMITS.payload)
        try {
          if (bytes.length !== segment.byteLength || await hashBytes(bytes) !== segment.sha256) throw new Error('Account metadata segment digest or length mismatch')
          await reader.check()
          yield bytes
        } finally { bytes.fill(0) }
      }
    } }
  }
}

export async function openAccountInheritedEvidence(database: AccountDatabase, token: ProfileToken, root: CipherRef, owner?: AccountPreparationOwner, cleanup?: AccountManagedCleanup): Promise<AccountInheritedEvidence> {
  root = freeze(CipherRefSchema.parse(root)); token = Object.freeze({ ...token })
  let unregister = () => {}
  const lifetime = new ReadLifetime(async () => { assertActiveProfile(token); if (database.accountId !== token.accountId) throw new Error('Foreign account evidence database'); owner?.check() }, owner, () => unregister())
  const join = cleanup?.reader(lifetime)
  const dispose = async () => {
    if (!join) return lifetime.dispose()
    const result = await join.request()
    if (result.status === 'failed') throw accountCleanupOnlyFailure(join, result)
  }
  // Managed requests always resolve a recorded result; the callback cannot discard a failed
  // attempt or restart it after natural stream completion removes the iterator
  unregister = registerProfileCleanup(token, () => { if (join) void join.request(); else void dispose().catch(() => {}) })
  if (join && join.observe().status !== 'not-started') unregister()
  const budget = new Budget(), reader = new GraphReader(database, token, budget, () => lifetime.check(), owner, lifetime)
  try {
    budget.reserve(root, 'root')
    const header = await reader.json(root, rootSchema, value => [value.members, value.blobs])
    const members = await reader.pages(header.members, memberPage, 'member-page', entry => [entry.metadata, entry.blobSubset])
    if (members.some((member, index) => index > 0 && members[index - 1].id >= member.id)) throw new Error('Unsorted or duplicate account historical member')
    if (await inheritedSnapshotSetDigest(members.map(member => member.id)) !== header.setDigest) throw new Error('Account evidence set digest mismatch')
    const shared = await reader.pages(header.blobs, blobPage, 'blob-page', entry => [entry.content])
    const bodies: InheritedSnapshotSources['bodies'][number][] = [], registry = new Map<string, Body>(), contentRefs = new Set<string>()
    for (const [index, body] of shared.entries()) {
      if (index && compareBackupRefs(shared[index - 1].source, body.source) >= 0 || contentRefs.has(refKey(body.content))) throw new Error('Unsorted, duplicate or aliased account native body')
      contentRefs.add(refKey(body.content)); registry.set(blobIdentity(body.source), body)
      budget.reserve(body.content, 'body')
      const record = await reader.record(body.content, maxDocumentBytes)
      reader.edges(record, [])
      if (record.descriptor.plainBytes !== body.source.byteLength) throw new Error('Account native body length mismatch')
      bodies.push({ ref: body.source, content: reader.source(body.content, maxDocumentBytes) })
    }
    const streams: MemberStream[] = [], union = new Set<string>()
    await withImmutableWorkspaceBodyValidation(bodies, async bodyValidation => {
      for (const member of members) {
        const subset = await reader.pages(member.blobSubset, subsetPage, 'subset-page', entry => [entry.content])
        budget.reserve(member.metadata, 'stream')
        const stream = await reader.json(member.metadata, streamSchema, value => [value.pages])
        budget.stream(stream.byteLength)
        const segments = await reader.pages(stream.pages, metadataPage, 'metadata-page', entry => [entry.content])
        let length = 0
        for (const [index, segment] of segments.entries()) {
          budget.segment()
          if (segment.ordinal !== index) throw new Error('Account metadata segment ordinal mismatch')
          budget.reserve(segment.content, 'segment')
          const record = await reader.record(segment.content, WORKSPACE_BACKUP_LIMITS.payload)
          reader.edges(record, [])
          if (record.descriptor.plainBytes !== segment.byteLength) throw new Error('Account metadata segment length mismatch')
          length = checked(length, segment.byteLength, stream.byteLength)
        }
        if (length !== stream.byteLength) throw new Error('Account metadata stream length mismatch')
        const metadata = reader.metadata(segments, length), identity = await historicalMetadataIdentity(metadata)
        if (identity.id !== member.id || identity.metadataStreamDigest !== stream.digest) throw new Error('Account historical metadata identity mismatch')
        const raw = await readBackupMetadata(metadata) as SnapshotMetadataV1
        if (raw.version !== 1 || !raw.state || !Array.isArray(raw.state.blobs) || raw.state.blobs.length !== subset.length) throw new Error('Account historical subset mismatch')
        // Metadata refs are inert originals, not account dependencies; only these typed edges
        // bind their complete native identities to the shared encrypted registry in source order
        for (const [index, body] of subset.entries()) {
          const stored = registry.get(blobIdentity(body.source))
          if (!stored || !sameRef(stored.source, body.source) || !sameRef(raw.state.blobs[index], body.source) || refKey(body.content) !== refKey(stored.content)) throw new Error('Account historical subset association mismatch')
          union.add(blobIdentity(body.source))
        }
        await validateWorkspaceSnapshotV1(attachBackupBodies(raw, new Map(bodies.map(body => [blobIdentity(body.ref), body]))), bodyValidation)
        streams.push(freeze({ ...member, segments, byteLength: length, subset: subset.map(body => body.source) }))
      }
    })
    if (union.size !== registry.size) throw new Error('Orphan account historical native body')
    await lifetime.check()
    const sources = (pass: Budget): InheritedSnapshotSources => {
      const lazy = new GraphReader(database, token, pass, () => lifetime.check(), owner)
      // Pin authenticated identities; lazy readers still resolve and authenticate every physical read
      for (const [key, record] of reader.records) { pass.reserve(cipherRef(record), 'body'); pass.declare(record.descriptor.plainBytes); lazy.records.set(key, record) }
      return freeze({ members: streams.map(member => ({ id: member.id, metadata: lifetime.source(lazy.metadata(member.segments, member.byteLength), true), subset: member.subset })), bodies: shared.map(body => ({ ref: body.source, content: lifetime.source(lazy.source(body.content, maxDocumentBytes)) })) })
    }
    const handle: AccountInheritedEvidence = Object.freeze({ origin: 'evidence-v1', root, setDigest: header.setDigest, members: freeze(members.map(({ id }) => ({ id }))), check: () => lifetime.check(), dispose })
    registered.set(handle, { database, token, lifetime, sources })
    return handle
  } catch (error) {
    if (join) {
      const inner = readAccountPreparationFailure(error)
      const cleanupOnly = readAccountCleanupOnlyFailure(error)
      const primary = inner ? inner.primary : error
      const local = await join.request()
      if (cleanupOnly) {
        assertAccountCleanupJoinable(join, cleanupOnly.cleanup)
        if (local.status === 'succeeded') throw error
      }
      const target = inner || cleanupOnly ? cleanup!.group([join, (inner ?? cleanupOnly)!.cleanup]) : join
      const result = target === join ? local : await target.request()
      if (result.status === 'failed') {
        if (cleanupOnly) throw accountCleanupOnlyFailure(target, result, error as Error)
        throw accountPreparationFailure(primary, target)
      }
      if (cleanupOnly) throw error
      throw primary
    }
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Account evidence opening and cleanup failed') }
    throw error
  }
}

export async function accountInheritedSources(handle: AccountInheritedEvidence): Promise<InheritedSnapshotSources> {
  const owned = registration(handle)
  await owned.lifetime.check()
  const sources = owned.sources(new Budget())
  await owned.lifetime.check()
  return sources
}

interface CapturedAddition {
  readonly snapshot: WorkspaceSnapshotV2
  readonly ids: readonly string[]
  readonly historical: ReadonlyMap<string, BlobSource>
  readonly blobs: InheritedSnapshotSources['bodies']
}
// Capture source references before the first await; public captured-backup views cannot retarget
// an in-flight operation even though only the original owned snapshot supplies authority
function captureAdditions(additions: readonly WorkspaceSnapshotV2[]): readonly CapturedAddition[] {
  checked(0, additions.length, WORKSPACE_BACKUP_LIMITS.frames)
  let capturedEntries = 0
  return additions.map(snapshot => {
    if (snapshot.version !== 2) throw new Error('Owned captured V2 evidence is required')
    const captured = capturedBackupEvidence(snapshot)
    checked(0, captured.blobs.length, WORKSPACE_BACKUP_LIMITS.frames)
    checked(0, captured.historical.size, WORKSPACE_BACKUP_LIMITS.frames)
    checked(0, snapshot.historicalEvidence.snapshots.length, WORKSPACE_BACKUP_LIMITS.frames)
    capturedEntries = checked(capturedEntries, captured.blobs.length, WORKSPACE_BACKUP_LIMITS.frames)
    capturedEntries = checked(capturedEntries, captured.historical.size, WORKSPACE_BACKUP_LIMITS.frames)
    const ids = snapshot.historicalEvidence.snapshots.map(({ id }) => digest.parse(id))
    if (captured.historical.size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1] >= id)) throw new Error('Captured historical membership mismatch')
    return { snapshot, ids, historical: new Map(captured.historical), blobs: captured.blobs.map(body => ({ ref: freeze(WorkspaceBlobRefSchema.parse(body.ref)), content: body.content })) }
  })
}

async function prepareGraph(database: AccountDatabase, token: ProfileToken, owner: AccountPreparationOwner, input: PrepareAccountInheritedEvidenceInput, additions: readonly CapturedAddition[], lifetime: ReadLifetime, check: () => Promise<void>, sidecar?: InheritedSnapshotSources): Promise<{ root: CipherRef; records: readonly CipherRecord[] }> {
  const budget = new Budget(), inputs: InheritedSnapshotSources[] = [], sources = additions.map(value => value.snapshot)
  const base = input.base
  if (input.sourceEvidence) {
    // This registered sidecar already supplies exact member subsets; an intermediate complete
    // backup would decode and restage the same metadata without adding validation authority
    if (!sidecar) throw new Error('Missing captured sidecar sources')
    inputs.push(sidecar)
  }
  if (base) {
    const owned = registration(base)
    if (owned.database !== database || owned.token.accountId !== token.accountId || owned.token.generation !== token.generation) throw new Error('Foreign account evidence base')
    inputs.push(await accountInheritedSources(base))
  }
  if (input.merge) {
    const owned = registration(input.merge)
    if (owned.database !== database || owned.token.accountId !== token.accountId || owned.token.generation !== token.generation) throw new Error('Foreign account evidence merge')
    inputs.push(await accountInheritedSources(input.merge))
  }
  const sourceCheck = async () => { await check(); await input.sourceEvidence?.check(); if (base) await registration(base).lifetime.check(); if (input.merge) await registration(input.merge).lifetime.check(); for (const source of sources) await assertOwnedWorkspaceSnapshot(source); await check() }
  const guarded = (source: BlobSource, memberId?: string): BlobSource => ({ byteLength: source.byteLength, open() {
    let ordinal = 0
    return lifetime.source(source, false, sourceCheck, bytes => {
      if (memberId !== undefined) {
        if (!bytes.length || bytes.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Account metadata token page limit')
        // Admit original identities before copying or decoder delivery, including the initial
        // subset decode; physical rereads still consume bytes but never reserve a second visit
        budget.original(memberId, ordinal++)
      }
      budget.consume(bytes.length)
    }).open()
  } })
  // Reserve the base before additions so their first decode shares the same admission budget
  for (const source of inputs) for (const member of source.members) {
    for await (const bytes of guarded(member.metadata, member.id).open()) void bytes
  }
  for (const { snapshot, ids, historical, blobs } of additions) {
    await assertOwnedWorkspaceSnapshot(snapshot)
    const members: InheritedSnapshotSources['members'][number][] = [], used = new Set<string>()
    for (const id of ids) {
      const metadata = historical.get(id)
      if (!metadata) throw new Error('Missing captured historical metadata')
      budget.potential(metadata.byteLength)
      const raw = await readBackupMetadata(guarded(metadata, id)) as SnapshotMetadataV1
      await sourceCheck()
      if (raw.version !== 1 || !raw.state || !Array.isArray(raw.state.blobs)) throw new Error('Invalid captured historical metadata')
      checked(0, raw.state.blobs.length, WORKSPACE_BACKUP_LIMITS.frames)
      const subset = raw.state.blobs.map(ref => freeze(WorkspaceBlobRefSchema.parse(ref)))
      for (const ref of subset) used.add(blobIdentity(ref))
      members.push({ id: digest.parse(id), metadata, subset })
    }
    inputs.push({ members, bodies: blobs.filter(body => used.has(blobIdentity(body.ref))) })
  }
  await sourceCheck()
  const members = new Map<string, InheritedSnapshotSources['members'][number]>(), bodies = new Map<string, InheritedSnapshotSources['bodies'][number]>()
  for (const source of inputs) {
    checked(members.size, source.members.length, WORKSPACE_BACKUP_LIMITS.frames)
    checked(bodies.size, source.bodies.length, WORKSPACE_BACKUP_LIMITS.frames)
    for (const member of source.members) {
      const previous = members.get(member.id)
      if (previous && (previous.subset.length !== member.subset.length || previous.subset.some((ref, index) => !sameRef(ref, member.subset[index])) || !await equalMetadataStreams(guarded(previous.metadata, member.id), guarded(member.metadata, member.id)))) throw new Error('Contradictory account historical member')
      if (!previous) members.set(member.id, { id: member.id, metadata: member.metadata, subset: freeze(member.subset.map(ref => WorkspaceBlobRefSchema.parse(ref))) })
    }
    for (const body of source.bodies) {
      const key = blobIdentity(body.ref), previous = bodies.get(key)
      if (previous && (!sameRef(previous.ref, body.ref) || !await equalMetadataStreams(guarded(previous.content), guarded(body.content)))) throw new Error('Contradictory account historical native body')
      if (!previous) bodies.set(key, { ref: freeze(WorkspaceBlobRefSchema.parse(body.ref)), content: body.content })
    }
  }
  const records: CipherRecord[] = []
  const retain = async (job: Promise<CipherRecord>) => { const record = await job; records.push(freeze(structuredClone(record))); await sourceCheck(); return cipherRef(record) }
  const stageBytes = async (bytes: Uint8Array, dependencies: readonly CipherRef[]) => {
    budget.room(1); budget.declare(bytes.length)
    await sourceCheck()
    const ref = await retain(stageAccountBytes(database, token, bytes, uniqueRefs(dependencies), undefined, owner))
    budget.reserve(ref, 'staged')
    return ref
  }
  const stageJson = async (value: unknown, dependencies: readonly CipherRef[]) => {
    const bytes = jsonBytes(value)
    try { if (bytes.length > INDEX_PAGE_BYTES || uniqueRefs(dependencies).length > maxDependencies) throw new Error('Account evidence page limit'); return await stageBytes(bytes, dependencies) } finally { bytes.fill(0) }
  }
  const page = <T>(kind: string, entries: readonly T[], edges: (entry: T) => readonly CipherRef[]) => buildIndexPages(entries, value => stageJson({ ...value, kind }, [...value.children, ...value.entries.flatMap(edges)]), value => jsonBytes({ ...value, kind }).length)
  const shared: Body[] = [], stored = new Map<string, Body>()
  for (const body of [...bodies.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref))) {
    if (body.ref.byteLength > maxDocumentBytes || body.ref.byteLength !== body.content.byteLength) throw new Error('Account historical native body exceeds document limit or has wrong length')
    budget.room(1); budget.declare(body.ref.byteLength)
    await sourceCheck()
    const content = await retain(stageAccountSource(database, token, guarded(body.content), [], undefined, undefined, owner))
    budget.reserve(content, 'body')
    const entry = { source: body.ref, content }; shared.push(entry); stored.set(blobIdentity(body.ref), entry)
  }
  const written: Member[] = []
  for (const member of [...members.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    budget.potential(member.metadata.byteLength)
    const segments: Segment[] = []
    let length = 0
    for await (const bytes of guarded(member.metadata, member.id).open()) {
      budget.stagedOriginal(member.id, segments.length)
      if (!bytes.length || bytes.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Account metadata token page limit')
      length = checked(length, bytes.length, member.metadata.byteLength)
      const content = await stageBytes(bytes, [])
      segments.push({ ordinal: segments.length, byteLength: bytes.length, sha256: await hashBytes(bytes), content })
      await sourceCheck()
    }
    if (length !== member.metadata.byteLength) throw new Error('Account historical metadata length mismatch')
    const identity = await historicalMetadataIdentity(guarded(member.metadata, member.id))
    if (identity.id !== member.id) throw new Error('Account historical metadata identity mismatch')
    const pages = await page('evidence-metadata-page', segments, entry => [entry.content])
    const metadata = await stageJson({ version: 1, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v1', digest: identity.metadataStreamDigest, byteLength: length, pages }, [pages])
    const subset = member.subset.map(ref => { const body = stored.get(blobIdentity(ref)); if (!body || !sameRef(ref, body.source)) throw new Error('Account historical subset body mismatch'); return body })
    const blobSubset = await page('evidence-subset-page', subset, entry => [entry.content])
    written.push({ id: member.id, metadata, blobSubset })
  }
  const memberRoot = await page('evidence-member-page', written, entry => [entry.metadata, entry.blobSubset])
  const blobs = await page('evidence-blob-page', shared, entry => [entry.content])
  const root = await stageJson({ version: 1, kind: 'inherited-snapshot-evidence', setDigest: await inheritedSnapshotSetDigest(written.map(member => member.id)), members: memberRoot, blobs }, [memberRoot, blobs])
  await sourceCheck()
  return { root: freeze(root), records: Object.freeze(records) }
}

// Retain this operation and its database until abandonment succeeds, including failed prepare
// Cleanup attempts are distinct from preparation settlement to avoid waiting on ourselves
export function createAccountInheritedEvidencePreparation(database: AccountDatabase, token: ProfileToken, cleanup: AccountManagedCleanup): ManagedAccountInheritedEvidencePreparation
export function createAccountInheritedEvidencePreparation(database: AccountDatabase, token: ProfileToken): AccountInheritedEvidencePreparation
export function createAccountInheritedEvidencePreparation(database: AccountDatabase, token: ProfileToken, cleanup?: AccountManagedCleanup): AccountInheritedEvidencePreparation & { readonly cleanup?: AccountCleanupJoin } {
  token = Object.freeze({ ...token })
  const owner = createAccountPreparationOwner(database, token)
  let started = false, closed = false, primary: unknown, preparation: Promise<PreparedAccountInheritedEvidence> | undefined
  let standaloneCleanup: Promise<void> | undefined, cleaned = false, handle: AccountInheritedEvidence | undefined
  const check = async () => { if (closed) throw new Error('Account evidence preparation was abandoned'); owner.check() }
  const lifetime = new ReadLifetime(check)
  const ownerJoin = cleanup?.owner(owner)
  const readers = cleanup?.group([])
  const lifetimeJoin = cleanup?.reader(lifetime)
  if (lifetimeJoin) readers!.include(lifetimeJoin)
  // Only the exact opener reader joins this child; its returned facade is not another
  // raw cleanup resource, and the owner remains first in the outer request order
  const openerCleanup: AccountManagedCleanup | undefined = cleanup && readers && {
    owner() { throw new Error('Account evidence opener cannot enroll another owner') },
    reader(raw) { const join = cleanup.reader(raw); readers.include(join); return join },
    group(parts) { const join = cleanup.group(parts); readers.include(join); return join },
  }
  const group: AccountCleanupGroup | undefined = cleanup && ownerJoin && readers && cleanup.group([ownerJoin, readers])
  let firstCleanupFailure: Error | undefined
  const remember = (error: Error) => {
    const known = readAccountCleanupOnlyFailure(error)
    if (!known) throw new Error('Unregistered account cleanup-only history')
    if (firstCleanupFailure) return
    firstCleanupFailure = error
  }
  const failed = (result: AccountCleanupResult, preceding?: Error): Error => {
    if (result.status !== 'failed' || !group) throw new Error('Account evidence cleanup did not fail')
    const previous = firstCleanupFailure ?? preceding
    if (!previous) { const created = accountCleanupOnlyFailure(group, result); remember(created); return created }
    if (!firstCleanupFailure) remember(previous)
    const priorResult = readAccountCleanupOnlyFailure(previous)?.result
    if (!priorResult) throw new Error('Unregistered account cleanup-only history')
    // Compare the exact failed physical attempts recorded by P2, not group observations
    // or diagnostic values that a retry or late include can make indistinguishable
    return hasNewAccountCleanupFailure(result, priorResult)
      ? accountCleanupOnlyFailure(group, result, previous) : previous
  }
  const clean = (): Promise<void> => {
    if (cleaned) return Promise.resolve()
    if (standaloneCleanup) return standaloneCleanup
    // Start raw owner retirement and reader cancellation before awaiting any one disposer
    standaloneCleanup = (async () => {
      const outcomes = await Promise.allSettled([owner.abandon(), owner.releaseReaders(), lifetime.dispose(), handle?.dispose()])
      const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors], 'Account evidence preparation cleanup failed', { cause: primary })
      cleaned = true
    })()
    void standaloneCleanup.catch(() => { standaloneCleanup = undefined })
    return standaloneCleanup
  }
  const abandonStandalone = async () => {
    closed = true
    // Start owner settlement before awaiting preparation so blocked staging can observe closure
    let cleanupError: unknown
    try { await clean() } catch (error) { cleanupError = error }
    await preparation?.catch(() => {})
    if (cleanupError !== undefined) throw cleanupError
  }
  const abandonManaged = async () => {
    closed = true
    // Request synchronously before the first await; the producer can be blocked on a
    // private iterator or stage and must observe revoked admission to settle
    const first = group!.request()
    const initial = await first
    const initialFailure = initial.status === 'failed' ? failed(initial) : undefined
    if (preparation) await Promise.allSettled([preparation])
    const final = await group!.request()
    if (final.status === 'failed') throw failed(final, initialFailure)
    if (initialFailure) throw initialFailure
  }
  const abandon = group ? abandonManaged : abandonStandalone
  const operation = {
    prepare(input: PrepareAccountInheritedEvidenceInput) {
      if (started || closed) return Promise.reject(new Error('Account evidence preparation is single-use'))
      started = true
      preparation = (async () => {
        let stopListening = () => {}
        try {
          const additions = captureAdditions(input.additions ?? [])
          // Resolve registered sidecar authority before yielding; structural copies cannot become inputs
          const source = input.sourceEvidence && guestEvidenceSources(input.sourceEvidence)
          const sidecar = source && { members: source.members.map(member => ({ id: member.id, metadata: member.metadata, subset: member.subset.map(ref => freeze(WorkspaceBlobRefSchema.parse(ref))) })), bodies: source.bodies.map(body => ({ ref: freeze(WorkspaceBlobRefSchema.parse(body.ref)), content: body.content })) }
          const captured = { base: input.base, merge: input.merge, sourceEvidence: input.sourceEvidence, signal: input.signal }
          const profile = profileSignal(token)
          const onAbort = () => { void abandon().catch(() => {}) }
          captured.signal?.addEventListener('abort', onAbort, { once: true })
          profile.addEventListener('abort', onAbort, { once: true })
          stopListening = () => { captured.signal?.removeEventListener('abort', onAbort); profile.removeEventListener('abort', onAbort) }
          const fresh = async () => { await check(); captured.signal?.throwIfAborted(); await captured.sourceEvidence?.check(); if (captured.base) await registration(captured.base).lifetime.check(); if (captured.merge) await registration(captured.merge).lifetime.check(); for (const { snapshot } of additions) await assertOwnedWorkspaceSnapshot(snapshot); await check(); captured.signal?.throwIfAborted() }
          await fresh()
          const graph = await prepareGraph(database, token, owner, captured, additions, lifetime, fresh, sidecar)
          await fresh()
          handle = await openAccountInheritedEvidence(database, token, graph.root, owner, openerCleanup)
          await fresh()
          return Object.freeze({ ...graph, handle, owner, dispose: abandon })
        } catch (error) {
          primary = error; closed = true
          if (group) {
            const inner = readAccountPreparationFailure(error)
            const cleanupOnly = readAccountCleanupOnlyFailure(error)
            // Start local retirement even when a nested failure has a foreign join; validation
            // must reject its authority, but it must not strand this factory's own ciphertext
            const local = group.request()
            if (inner || cleanupOnly) {
              const joined = (inner ?? cleanupOnly)!.cleanup
              try { assertAccountCleanupJoinable(group, joined) }
              catch (invalid) { await local; throw invalid }
              if (cleanupOnly) remember(error as Error)
              group.include(joined)
            }
            const result = await group.request()
            if (cleanupOnly) {
              if (result.status === 'failed') throw failed(result, error as Error)
              throw error
            }
            const cause = inner ? inner.primary : error
            if (result.status === 'failed') throw accountPreparationFailure(cause, group)
            throw cause
          }
          await clean()
          throw error
        } finally { stopListening() }
      })()
      void preparation.catch(() => {})
      return preparation
    }, abandon,
  }
  return Object.freeze(group ? { ...operation, cleanup: group } : operation)
}
