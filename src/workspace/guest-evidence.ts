import { z } from 'zod'
import Dexie from 'dexie'
import type { BlobSource, WorkspaceBlobRef, WorkspaceState } from './documents'
import { WorkspaceBlobRefSchema } from './file-schemas'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { PlannerJournalSchema } from './planner-journal'
import { blobIdentity, BLOB_CHUNK_BYTES, hashBlob, memoryBlob } from './blobs'
import { INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'
import { attachBackupBodies, capturedBackupEvidence, compareBackupRefs, equalMetadataStreams, historicalMetadataIdentity, metadataSource, readBackupMetadata, type InheritedSnapshotSources, type SnapshotMetadataV1 } from '../interchange/workspace-backup-evidence'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { inheritedSnapshotSetDigest } from '../interchange/identity'
import { assertOwnedWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot, validateWorkspaceSnapshotV1, snapshotMetadata, projectWorkspaceSnapshotV1, type WorkspaceSnapshot, type WorkspaceSnapshotV1, type WorkspaceSnapshotV2 } from './snapshot'
import { withImmutableWorkspaceBodyValidation } from './closure'

const integer = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[0-9a-f]{64}$/)
const locator = z.strictObject({ version: z.literal(1), key: z.string().min(1) })
type Locator = z.infer<typeof locator>
const envelope = z.strictObject({ key: z.string().min(1), value: z.unknown() })
export const GuestExtensionsSchema = z.strictObject({ version: z.literal(1), kind: z.literal('guest-workspace-extensions'), inheritedEvidence: locator, plannerEvidence: locator })
// Frozen v1 admits inert entries individually; the operative list bound cannot restrict retained originals
const inertSavedChanges = z.array(NativeLocalDataSchema.shape.changes.element).refine(values => new Set(values.map(value => value.id)).size === values.length, 'Duplicate saved planner evidence')
export const GuestPlannerEvidenceSchema = z.strictObject({ version: z.literal(1), kind: z.literal('guest-planner-evidence'), savedChanges: inertSavedChanges, importedJournal: PlannerJournalSchema.optional() })
export interface GuestPlannerEvidence { readonly version: 1; readonly kind: 'guest-planner-evidence'; readonly savedChanges: readonly import('../domain/types').ChangeEntry[]; readonly importedJournal?: import('./planner-journal').PlannerJournal }
const rootSchema = z.strictObject({ version: z.literal(1), kind: z.literal('inherited-snapshot-evidence'), setDigest: digest, members: locator, blobs: locator })
const streamSchema = z.strictObject({ version: z.literal(1), kind: z.literal('evidence-metadata-stream'), codec: z.literal('backup-json-tokens-v1'), digest, byteLength: integer, pages: locator })
const memberSchema = z.strictObject({ id: digest, metadata: locator, blobSubset: locator })
const bodySchema = z.strictObject({ source: WorkspaceBlobRefSchema, content: locator })
const segmentSchema = z.strictObject({ ordinal: integer, byteLength: integer.positive(), sha256: digest, content: locator })
const kinds = ['evidence-member-page', 'evidence-blob-page', 'evidence-subset-page', 'evidence-metadata-page'] as const
type PageKind = typeof kinds[number]
export const GUEST_EVIDENCE_STORES = Object.freeze({ evidenceRoots: 'key', evidencePages: 'key', evidenceSegments: 'key', plannerEvidence: 'key', evidenceBlobs: 'key', evidenceChunks: '[key+index], key' })
export const GUEST_FILES_V1_STORES = Object.freeze({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
export const GUEST_EXTENSION_KEY = 'workspaceExtensions'
export const emptyPlannerEvidence = (): GuestPlannerEvidence => ({ version: 1, kind: 'guest-planner-evidence', savedChanges: [] })
const sameRef = (a: WorkspaceBlobRef, b: WorkspaceBlobRef) => a.documentId === b.documentId && a.revisionId === b.revisionId && a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.encoding === b.encoding
const strictBody = z.strictObject({ key: z.string(), ref: WorkspaceBlobRefSchema })
const strictChunk = z.strictObject({ key: z.string(), index: integer, bytes: z.instanceof(Uint8Array) })
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export interface GuestEvidenceRows {
  readonly tables: readonly string[]
  keys(table: string): Promise<readonly IDBValidKey[]>
  get(table: string, key: IDBValidKey): Promise<unknown>
}
export function databaseEvidenceRows(database: Dexie): GuestEvidenceRows {
  return { tables: database.tables.map(table => table.name), keys: async table => await database.table<unknown, IDBValidKey>(table).toCollection().primaryKeys(), get: (table, key) => database.table<unknown, IDBValidKey>(table).get(key) }
}
export interface CapturedGuestEvidence { readonly setDigest: string; readonly planner: GuestPlannerEvidence; check(): Promise<void> }
interface EvidenceValue { readonly sources: InheritedSnapshotSources; readonly plannerStream: BlobSource }
const captured = new WeakMap<CapturedGuestEvidence, EvidenceValue>()
function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeEvidence(child); Object.freeze(value) }
  return value
}
export function guestEvidenceSources(evidence: CapturedGuestEvidence): InheritedSnapshotSources {
  const owned = captured.get(evidence)
  if (!owned) throw new Error('A captured guest evidence sidecar is required')
  return owned.sources
}

// Every locator is interpreted under its retaining role and confined to this files participant
// A successful set hash alone cannot admit missing, cross-role or unreachable storage rows
export async function readGuestEvidence(rows: GuestEvidenceRows, check: () => Promise<void>): Promise<CapturedGuestEvidence> {
  await check()
  const expected = [...Object.keys(GUEST_FILES_V1_STORES), ...Object.keys(GUEST_EVIDENCE_STORES)].sort()
  if (JSON.stringify([...rows.tables].sort()) !== JSON.stringify(expected)) throw new Error('Unsupported guest evidence layout')
  const visited = new Map<string, Set<string>>(Object.keys(GUEST_EVIDENCE_STORES).map(table => [table, new Set()]))
  const take = async (table: string, ref: Locator): Promise<unknown> => {
    const used = visited.get(table)!
    if (used.has(ref.key)) throw new Error('Repeated or cyclic guest evidence locator')
    used.add(ref.key)
    const row = envelope.parse(await rows.get(table, ref.key))
    if (row.key !== ref.key) throw new Error('Guest evidence locator mismatch')
    return row.value
  }
  const page = async <T>(ref: Locator, kind: PageKind, schema: z.ZodType<T>): Promise<T[]> => {
    const entries: T[] = [], pending = [ref]
    while (pending.length) {
      const value = await take('evidencePages', pending.pop()!)
      const parsed = z.strictObject({ version: z.literal(1), kind: z.literal(kind), entries: z.array(schema), children: z.array(locator) }).parse(value)
      if (size(value) > INDEX_PAGE_BYTES || parsed.entries.length + parsed.children.length > INDEX_PAGE_ENTRIES || parsed.entries.length && parsed.children.length) throw new Error('Invalid guest evidence page bound')
      entries.push(...parsed.entries); pending.push(...[...parsed.children].reverse())
    }
    return entries
  }
  const stream = async (ref: Locator): Promise<BlobSource> => {
    const root = streamSchema.parse(await take('evidenceRoots', ref))
    const segments = await page(root.pages, 'evidence-metadata-page', segmentSchema)
    let length = 0
    for (const [index, segment] of segments.entries()) {
      if (segment.ordinal !== index || segment.byteLength > WORKSPACE_BACKUP_LIMITS.payload || visited.get('evidenceSegments')!.has(segment.content.key)) throw new Error('Invalid metadata segment index')
      visited.get('evidenceSegments')!.add(segment.content.key); length += segment.byteLength
    }
    if (length !== root.byteLength) throw new Error('Metadata stream length mismatch')
    const source: BlobSource = { byteLength: root.byteLength, async *open() {
      for (const segment of segments) {
        const row = z.strictObject({ key: z.string(), bytes: z.instanceof(Uint8Array) }).parse(await rows.get('evidenceSegments', segment.content.key))
        if (row.key !== segment.content.key || row.bytes.length !== segment.byteLength || await hashBlob(memoryBlob(row.bytes)) !== segment.sha256) throw new Error('Invalid guest metadata segment')
        yield row.bytes
      }
    } }
    if (await hashBlob(source) !== root.digest) throw new Error('Metadata stream digest mismatch')
    return source
  }
  const sentinel = envelope.parse(await rows.get('documents', GUEST_EXTENSION_KEY))
  if (sentinel.key !== GUEST_EXTENSION_KEY) throw new Error('Missing workspace extension sentinel')
  const extension = GuestExtensionsSchema.parse(sentinel.value)
  const root = rootSchema.parse(await take('evidenceRoots', extension.inheritedEvidence))
  const members = await page(root.members, 'evidence-member-page', memberSchema)
  if (await inheritedSnapshotSetDigest(members.map(member => member.id)) !== root.setDigest) throw new Error('Inherited membership digest mismatch')
  const shared = await page(root.blobs, 'evidence-blob-page', bodySchema)
  const bodies: WorkspaceState['blobs'][number][] = [], registry = new Map<string, WorkspaceState['blobs'][number]>()
  let previous: WorkspaceBlobRef | undefined
  for (const entry of shared) {
    const key = blobIdentity(entry.source)
    if (entry.content.key !== key || previous && compareBackupRefs(previous, entry.source) >= 0) throw new Error('Invalid historical body order or association')
    previous = entry.source
    const row = strictBody.parse(await rows.get('evidenceBlobs', key))
    if (row.key !== key || !sameRef(row.ref, entry.source)) throw new Error('Historical body association mismatch')
    visited.get('evidenceBlobs')!.add(key)
    const indexes: IDBValidKey[] = []
    let length = 0, index = 0
    while (length < row.ref.byteLength) {
      const chunkKey = [key, index] as IDBValidKey
      const chunk = strictChunk.parse(await rows.get('evidenceChunks', chunkKey))
      if (chunk.key !== key || chunk.index !== index || !chunk.bytes.length || chunk.bytes.length > BLOB_CHUNK_BYTES || length + chunk.bytes.length > row.ref.byteLength) throw new Error('Invalid historical native chunk')
      visited.get('evidenceChunks')!.add(JSON.stringify(chunkKey)); indexes.push(chunkKey); length += chunk.bytes.length; index++
    }
    const content: BlobSource = { byteLength: row.ref.byteLength, async *open() { for (const key of indexes) { const chunk = strictChunk.parse(await rows.get('evidenceChunks', key)); yield chunk.bytes } } }
    const body = { ref: row.ref, content }; registry.set(key, body); bodies.push(body)
  }
  const inherited: InheritedSnapshotSources['members'][number][] = [], union = new Set<string>()
  await withImmutableWorkspaceBodyValidation(bodies, async bodyValidation => {
    for (const member of members) {
      const subset = await page(member.blobSubset, 'evidence-subset-page', bodySchema), metadata = await stream(member.metadata)
      if ((await historicalMetadataIdentity(metadata)).id !== member.id) throw new Error('Historical metadata identity mismatch')
      const raw = await readBackupMetadata(metadata) as SnapshotMetadataV1
      if (raw.version !== 1 || raw.state.blobs.length !== subset.length) throw new Error('Historical subset mismatch')
      for (const [index, entry] of subset.entries()) {
        const key = blobIdentity(entry.source), body = registry.get(key)
        if (!sameRef(raw.state.blobs[index], entry.source) || !body || !sameRef(body.ref, entry.source) || entry.content.key !== key) throw new Error('Historical subset association mismatch')
        union.add(key)
      }
      await validateWorkspaceSnapshotV1(attachBackupBodies(raw, registry), bodyValidation)
      inherited.push({ id: member.id, metadata, subset: raw.state.blobs })
    }
  })
  if (union.size !== registry.size) throw new Error('Orphan historical native body')
  const plannerRow = z.strictObject({ key: z.string(), stream: locator }).parse(await rows.get('plannerEvidence', extension.plannerEvidence.key))
  if (plannerRow.key !== extension.plannerEvidence.key) throw new Error('Planner evidence locator mismatch')
  visited.get('plannerEvidence')!.add(plannerRow.key)
  const plannerStream = await stream(plannerRow.stream), plannerRaw = await readBackupMetadata(plannerStream)
  GuestPlannerEvidenceSchema.parse(plannerRaw)
  const planner = freezeEvidence(plannerRaw as GuestPlannerEvidence)
  if (new Set(planner.savedChanges.map(change => change.id)).size !== planner.savedChanges.length) throw new Error('Duplicate saved planner evidence')
  for (const [table, used] of visited) {
    const keys = await rows.keys(table)
    if (keys.length !== used.size || keys.some(key => !used.has(typeof key === 'string' ? key : JSON.stringify(key)))) throw new Error(`Orphan or missing guest evidence rows in ${table}`)
  }
  await check()
  const evidence: CapturedGuestEvidence = Object.freeze({ setDigest: root.setDigest, planner, check })
  captured.set(evidence, { sources: { members: inherited, bodies }, plannerStream })
  return evidence
}

interface Writer { put(table: string, row: unknown): Promise<unknown> }
async function writeGraph(writer: Writer, sources: InheritedSnapshotSources, plannerStream: BlobSource): Promise<void> {
  const ref = (): Locator => ({ version: 1, key: crypto.randomUUID() })
  const put = async (table: string, value: unknown) => { const key = ref(); await writer.put(table, { key: key.key, value }); return key }
  const page = async (kind: PageKind, entries: readonly unknown[]): Promise<Locator> => {
    const layer = async (values: readonly unknown[], children: boolean) => {
      const result: Locator[] = []
      let chunk: unknown[] = []
      const value = (list: unknown[]) => ({ version: 1, kind, entries: children ? [] : list, children: children ? list : [] })
      for (const entry of values) {
        if (chunk.length >= INDEX_PAGE_ENTRIES || size(value([...chunk, entry])) > INDEX_PAGE_BYTES) { if (!chunk.length) throw new Error('Evidence entry exceeds page bound'); result.push(await put('evidencePages', value(chunk))); chunk = [] }
        chunk.push(entry)
        if (size(value(chunk)) > INDEX_PAGE_BYTES) throw new Error('Evidence entry exceeds page bound')
      }
      if (chunk.length || !values.length) result.push(await put('evidencePages', value(chunk)))
      return result
    }
    let refs = await layer(entries, false)
    while (refs.length > 1) refs = await layer(refs, true)
    return refs[0]
  }
  const stream = async (source: BlobSource): Promise<Locator> => {
    const segments: z.infer<typeof segmentSchema>[] = []
    let length = 0
    // Token pages are individually parsed JSON arrays; splitting one changes the accepted stream grammar
    for await (const bytes of source.open()) {
      if (!bytes.length || bytes.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Metadata token page exceeds format bound')
      const part = bytes.slice(), content = ref()
      await writer.put('evidenceSegments', { key: content.key, bytes: part })
      segments.push({ ordinal: segments.length, byteLength: part.length, sha256: await hashBlob(memoryBlob(part)), content }); length += part.length
    }
    if (length !== source.byteLength) throw new Error('Metadata staging length mismatch')
    return put('evidenceRoots', { version: 1, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v1', digest: await hashBlob(source), byteLength: length, pages: await page('evidence-metadata-page', segments) })
  }
  const members = []
  for (const member of sources.members) members.push({ id: member.id, metadata: await stream(member.metadata), blobSubset: await page('evidence-subset-page', member.subset.map(source => ({ source, content: { version: 1, key: blobIdentity(source) } }))) })
  const shared = []
  for (const body of [...sources.bodies].sort((a, b) => compareBackupRefs(a.ref, b.ref))) {
    const key = blobIdentity(body.ref)
    await writer.put('evidenceBlobs', { key, ref: body.ref })
    let index = 0, length = 0
    for await (const bytes of body.content.open()) for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
      const part = bytes.slice(offset, offset + BLOB_CHUNK_BYTES)
      await writer.put('evidenceChunks', { key, index: index++, bytes: part }); length += part.length
    }
    if (length !== body.ref.byteLength) throw new Error('Historical native staging length mismatch')
    shared.push({ source: body.ref, content: { version: 1, key } })
  }
  const inheritedEvidence = await put('evidenceRoots', { version: 1, kind: 'inherited-snapshot-evidence', setDigest: await inheritedSnapshotSetDigest(members.map(member => member.id)), members: await page('evidence-member-page', members), blobs: await page('evidence-blob-page', shared) })
  const plannerEvidence = ref()
  await writer.put('plannerEvidence', { key: plannerEvidence.key, stream: await stream(plannerStream) })
  await writer.put('documents', { key: GUEST_EXTENSION_KEY, value: { version: 1, kind: 'guest-workspace-extensions', inheritedEvidence, plannerEvidence } })
}

// Managed storage reuses this exact inert row codec without opening or mutating a legacy files database
export async function writeCapturedGuestEvidence(evidence: CapturedGuestEvidence, writer: Writer): Promise<void> {
  const owned = captured.get(evidence)
  if (!owned) throw new Error('A captured guest evidence sidecar is required')
  await evidence.check()
  await writeGraph(writer, owned.sources, owned.plannerStream)
  await evidence.check()
}

export async function prepareEmptyGuestEvidence(): Promise<readonly { table: string; row: unknown }[]> {
  const result: { table: string; row: unknown }[] = []
  await writeGraph({ async put(table, row) { result.push({ table, row }) } }, { members: [], bodies: [] }, metadataSource(emptyPlannerEvidence()))
  return result
}
export interface GuestEvidenceStageWriter {
  put(table: string, row: unknown): Promise<unknown>
  clear(table: string): Promise<unknown>
  delete(table: string, key: string): Promise<unknown>
}
export async function writeGuestEvidence(database: Dexie, evidence: CapturedGuestEvidence, stage: GuestEvidenceStageWriter = {
  put: (table, row) => database.table(table).add(row),
  clear: table => database.table(table).clear(),
  delete: (table, key) => database.table(table).delete(key),
}): Promise<void> {
  const owned = captured.get(evidence)
  if (!owned) throw new Error('A captured guest evidence sidecar is required')
  await evidence.check()
  // The target is unselected; a sentinel is published only after all copied graph rows exist
  for (const table of Object.keys(GUEST_EVIDENCE_STORES)) await stage.clear(table)
  await stage.delete('documents', GUEST_EXTENSION_KEY)
  await writeGraph({ put: stage.put }, owned.sources, owned.plannerStream)
  await compareGuestEvidence(evidence, await readGuestEvidence(databaseEvidenceRows(database), async () => {}))
  await evidence.check()
}
export async function compareGuestEvidence(a: CapturedGuestEvidence, b: CapturedGuestEvidence): Promise<void> {
  const left = captured.get(a), right = captured.get(b)
  if (!left || !right) throw new Error('A captured guest evidence sidecar is required')
  if (a.setDigest !== b.setDigest || left.sources.members.length !== right.sources.members.length || left.sources.bodies.length !== right.sources.bodies.length || !await equalMetadataStreams(left.plannerStream, right.plannerStream)) throw new Error('Guest evidence changed')
  for (const [index, member] of left.sources.members.entries()) {
    const other = right.sources.members[index]
    if (member.id !== other.id || member.subset.length !== other.subset.length || member.subset.some((ref, index) => !sameRef(ref, other.subset[index])) || !await equalMetadataStreams(member.metadata, other.metadata)) throw new Error('Guest historical evidence changed')
  }
  for (const [index, body] of left.sources.bodies.entries()) { const other = right.sources.bodies[index]; if (!sameRef(body.ref, other.ref) || !await equalMetadataStreams(body.content, other.content)) throw new Error('Guest historical body changed') }
}

// Imported changes are inert originals; only the destination's actual local changes can extend them
export function mergeGuestSavedChanges(originals: GuestPlannerEvidence['savedChanges'], local: GuestPlannerEvidence['savedChanges']): GuestPlannerEvidence['savedChanges'] {
  const result = [...originals], ids = new Map(result.map(change => [change.id, change]))
  for (const change of local) {
    const previous = ids.get(change.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(change)) throw new Error('Saved planner change identity collision')
    if (!previous) { result.push(change); ids.set(change.id, change) }
  }
  return result
}

// Only a registered, fully validated portable owner can supply import originals
// Copying to a durable target and reopening it still runs the complete graph validation
export async function guestEvidenceFromSnapshot(snapshot: WorkspaceSnapshotV2, planner: GuestPlannerEvidence): Promise<CapturedGuestEvidence> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  GuestPlannerEvidenceSchema.parse(planner)
  const original = capturedBackupEvidence(snapshot), members: InheritedSnapshotSources['members'][number][] = [], keys = new Set<string>()
  for (const { id } of snapshot.historicalEvidence.snapshots) {
    const child = await openHistoricalSnapshot(snapshot, id)
    try {
      const metadata = original.historical.get(id)
      if (!metadata) throw new Error('Missing inherited metadata')
      const subset = child.state.blobs.map(blob => blob.ref)
      for (const ref of subset) keys.add(blobIdentity(ref))
      members.push({ id, metadata, subset })
    } finally { await disposeWorkspaceSnapshot(child) }
  }
  const bodies = original.blobs.filter(blob => keys.has(blobIdentity(blob.ref)))
  const ownedPlanner = freezeEvidence(structuredClone(planner))
  const evidence: CapturedGuestEvidence = Object.freeze({ setDigest: await inheritedSnapshotSetDigest(members.map(member => member.id)), planner: ownedPlanner, check: () => assertOwnedWorkspaceSnapshot(snapshot) })
  captured.set(evidence, { sources: { members, bodies }, plannerStream: metadataSource(ownedPlanner) })
  return evidence
}

export async function mergeGuestEvidence(destination: CapturedGuestEvidence, source: CapturedGuestEvidence, planner: GuestPlannerEvidence): Promise<CapturedGuestEvidence> {
  await destination.check(); await source.check()
  GuestPlannerEvidenceSchema.parse(planner)
  const members = new Map<string, InheritedSnapshotSources['members'][number]>(), bodies = new Map<string, WorkspaceState['blobs'][number]>()
  for (const evidence of [destination, source]) {
    const input = guestEvidenceSources(evidence)
    for (const member of input.members) {
      const previous = members.get(member.id)
      if (previous && (previous.subset.length !== member.subset.length || previous.subset.some((ref, index) => !sameRef(ref, member.subset[index])) || !await equalMetadataStreams(previous.metadata, member.metadata))) throw new Error('Contradictory inherited snapshot identity')
      if (!previous) members.set(member.id, member)
    }
    for (const body of input.bodies) {
      const key = blobIdentity(body.ref), previous = bodies.get(key)
      if (previous && (!sameRef(previous.ref, body.ref) || !await equalMetadataStreams(previous.content, body.content))) throw new Error('Contradictory inherited native body')
      if (!previous) bodies.set(key, body)
    }
  }
  const ordered = [...members.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ownedPlanner = freezeEvidence(structuredClone(planner))
  const evidence: CapturedGuestEvidence = Object.freeze({ setDigest: await inheritedSnapshotSetDigest(ordered.map(member => member.id)), planner: ownedPlanner, async check() { await destination.check(); await source.check() } })
  captured.set(evidence, { sources: { members: ordered, bodies: [...bodies.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref)) }, plannerStream: metadataSource(ownedPlanner) })
  return evidence
}

export async function validateGuestCurrentBodies(state: WorkspaceState, evidence: CapturedGuestEvidence): Promise<void> {
  const historical = new Map(guestEvidenceSources(evidence).bodies.map(body => [blobIdentity(body.ref), body]))
  for (const body of state.blobs) {
    const previous = historical.get(blobIdentity(body.ref))
    if (previous && (!sameRef(previous.ref, body.ref) || !await equalMetadataStreams(previous.content, body.content))) throw new Error('Contradictory current and historical native body')
  }
}

// The selected source's old operative endpoints are original backup evidence, not another live undo branch
export async function guestEvidenceFromFrozenCurrent(snapshot: WorkspaceSnapshotV1): Promise<CapturedGuestEvidence> {
  return captureCurrentEvidence(snapshot)
}

async function captureCurrentEvidence(snapshot: WorkspaceSnapshot, preserveStored = false): Promise<CapturedGuestEvidence> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  const current = projectWorkspaceSnapshotV1(snapshot)
  await validateWorkspaceSnapshotV1(current)
  const metadata = preserveStored && snapshot.version === 1 ? capturedBackupEvidence(snapshot).current : metadataSource(snapshotMetadata(current))
  if (preserveStored && snapshot.version === 1) {
    // Stored current token pages are independent of the already-admitted in-memory view
    // Keep the complete-backup format/subset checks before granting a new sidecar producer authority
    const raw = await readBackupMetadata(metadata) as SnapshotMetadataV1
    const registry = new Map(snapshot.state.blobs.map(body => [blobIdentity(body.ref), body]))
    await validateWorkspaceSnapshotV1(attachBackupBodies(raw, registry))
    if (raw.state.blobs.length !== snapshot.state.blobs.length || raw.state.blobs.some((ref, index) => !sameRef(ref, snapshot.state.blobs[index].ref))) throw new Error('Copied current metadata body subset changed')
  }
  const { id } = await historicalMetadataIdentity(metadata)
  const planner = emptyPlannerEvidence()
  const evidence: CapturedGuestEvidence = Object.freeze({ setDigest: await inheritedSnapshotSetDigest([id]), planner, check: () => assertOwnedWorkspaceSnapshot(snapshot) })
  captured.set(evidence, { sources: { members: [{ id, metadata, subset: snapshot.state.blobs.map(blob => blob.ref) }], bodies: snapshot.state.blobs }, plannerStream: metadataSource(planner) })
  return evidence
}

// Match complete-backup inheritance without constructing and then decoding another backup
// Stored pages keep their original packing; native capture supplies the raw original instead of another picker projection
export async function guestEvidenceForCopy(selected: WorkspaceSnapshot, source?: WorkspaceSnapshot, originals?: CapturedGuestEvidence): Promise<CapturedGuestEvidence> {
  const planner = emptyPlannerEvidence()
  let result = await captureCurrentEvidence(selected, true)
  if (originals) {
    if (!source) throw new Error('Copy originals require their captured source')
    await assertOwnedWorkspaceSnapshot(source); await originals.check()
    const exact = guestEvidenceSources(originals)
    // A native capture already retains its complete raw source, before the pure picker projection
    // Require its full declared membership and body identities; never omit an older stored original
    if (source.version !== 2 || exact.members.length !== source.historicalEvidence.snapshots.length
      || exact.members.some((member, index) => member.id !== source.historicalEvidence.snapshots[index].id)
      || exact.bodies.length !== source.historicalEvidence.blobs.length
      || exact.bodies.some((body, index) => !sameRef(body.ref, source.historicalEvidence.blobs[index]))) throw new Error('Copy original evidence differs from the captured source')
    result = await mergeGuestEvidence(result, originals, planner)
  } else if (source && source !== selected) result = await mergeGuestEvidence(result, await captureCurrentEvidence(source, true), planner)
  for (const snapshot of new Set([selected, ...(source && !originals ? [source] : [])])) {
    if (snapshot.version === 2) result = await mergeGuestEvidence(result, await guestEvidenceFromSnapshot(snapshot, planner), planner)
  }
  return result
}
