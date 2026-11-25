import { captureStoredEvidenceGraph, type StoredEvidenceGraph, type StoredEvidenceMember } from './guest-evidence-graph'
import { requireCompactCatalogWriters } from './catalog-writer-capability'
import { catalogEvidenceSetDigest, historicalMemberKey, compactHistoricalIdentity } from '../interchange/workspace-backup-catalog'
import { z } from 'zod'
import { catalogEvidenceSchemas, validateCatalogEvidenceSources, type CatalogInheritedSnapshotSources } from './catalog-evidence'
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
import { assertOwnedWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot, validateWorkspaceSnapshot, validateWorkspaceSnapshotV1, snapshotMetadata, projectWorkspaceSnapshotV1, type WorkspaceSnapshot, type WorkspaceSnapshotV2, type WorkspaceSnapshotV3 } from './snapshot'
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
interface LegacyStreamBinding { readonly id: string; readonly digest: string; readonly byteLength: number; readonly segments: readonly z.infer<typeof segmentSchema>[] }
interface EvidenceValue { readonly emptyLegacyStreams?: readonly LegacyStreamBinding[]; readonly sources: InheritedSnapshotSources; readonly plannerStream: BlobSource; readonly graph?: StoredEvidenceGraph }
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

// Only the completed strict legacy read attaches these empty-subset member bindings
// The planner shares the segment table but can never contribute a historical binding
export function admittedEmptyLegacyStreams(evidence: CapturedGuestEvidence) {
  return captured.get(evidence)?.emptyLegacyStreams
}

// Every locator is interpreted under its retaining role and confined to this files participant
// A successful set hash alone cannot admit missing, cross-role or unreachable storage rows
export async function readGuestEvidence(rows: GuestEvidenceRows, check: () => Promise<void>): Promise<CapturedGuestEvidence> {
  await check()
  const stored = captureStoredEvidenceGraph(rows)
  rows = stored.rows
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
  const emptyLegacyStreams: LegacyStreamBinding[] = []
  const stream = async (ref: Locator, emptyMemberId?: string): Promise<BlobSource> => {
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
    if (emptyMemberId !== undefined) emptyLegacyStreams.push({ id: emptyMemberId, digest: root.digest, byteLength: length, segments })
    return source
  }
  const sentinel = envelope.parse(await rows.get('documents', GUEST_EXTENSION_KEY))
  if (sentinel.key !== GUEST_EXTENSION_KEY) throw new Error('Missing workspace extension sentinel')
  const extension = GuestExtensionsSchema.parse(sentinel.value)
  const rootValue = await take('evidenceRoots', extension.inheritedEvidence)
  if (rootValue && typeof rootValue === 'object' && 'version' in rootValue && rootValue.version === 2) return readCatalogGuestEvidence(rows, check, stored.complete)
  const root = rootSchema.parse(rootValue)
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
      const subset = await page(member.blobSubset, 'evidence-subset-page', bodySchema), metadata = await stream(member.metadata, subset.length ? undefined : member.id)
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
  captured.set(evidence, { sources: freezeEvidence({ members: inherited, bodies }), plannerStream, graph: stored.complete(), emptyLegacyStreams: freezeEvidence(emptyLegacyStreams) })
  return evidence
}

interface Writer { put(table: string, row: unknown): Promise<unknown> }
interface GraphReuse {
  member(value: InheritedSnapshotSources['members'][number]): Promise<StoredEvidenceMember | undefined>
  body(value: WorkspaceState['blobs'][number], catalog: boolean): Promise<boolean>
  registry(catalog: boolean): Promise<Locator | undefined>
  members(): Promise<Locator | undefined>
  root(value: unknown): Promise<Locator | undefined>
  planner(): Promise<Locator | undefined>
}
async function writeGraph(writer: Writer, sources: InheritedSnapshotSources, plannerStream: BlobSource, reuse?: GraphReuse): Promise<void> {
  const compact = sources.version === 2
  if (compact) requireCompactCatalogWriters()
  if (compact) await validateCatalogEvidenceSources(sources as CatalogInheritedSnapshotSources, async () => {})
  const ref = (): Locator => ({ version: 1, key: crypto.randomUUID() })
  const put = async (table: string, value: unknown) => { const key = ref(); await writer.put(table, { key: key.key, value }); return key }
  const page = async (kind: PageKind | 'evidence-catalog-member-page' | 'evidence-catalog-body-page' | 'evidence-catalog-subset-page', entries: readonly unknown[]): Promise<Locator> => {
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
  const stream = async (source: BlobSource, catalog = false): Promise<Locator> => {
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
    return put('evidenceRoots', { version: catalog ? 2 : 1, kind: 'evidence-metadata-stream', codec: catalog ? 'backup-json-tokens-v2' : 'backup-json-tokens-v1', digest: await hashBlob(source), byteLength: length, pages: await page('evidence-metadata-page', segments) })
  }
  const subset = (refs: readonly WorkspaceBlobRef[], catalog = false) => page(catalog ? 'evidence-catalog-subset-page' : 'evidence-subset-page', refs.map(source => ({ source, content: { version: 1, key: `${catalog ? 'catalog-body:' : ''}${blobIdentity(source)}` } })))
  const members = []
  for (const member of sources.members) {
    const prior = await reuse?.member(member)
    members.push({ ...(compact ? { format: member.format ?? 'legacy-v1', catalogSubset: prior?.catalogSubset ?? await subset(member.catalogSubset ?? [], true) } : {}), id: member.id, metadata: prior?.metadata ?? await stream(member.metadata, member.format === 'compact-v2'), blobSubset: prior?.blobSubset ?? await subset(member.subset) })
  }
  const bodies = async (entries: WorkspaceState['blobs'], catalog = false) => {
    const existing = await reuse?.registry(catalog)
    if (existing) return existing
    const shared = []
    for (const body of [...entries].sort((a, b) => compareBackupRefs(a.ref, b.ref))) {
      const key = `${catalog ? 'catalog-body:' : ''}${blobIdentity(body.ref)}`
      if (await reuse?.body(body, catalog)) { shared.push({ source: body.ref, content: { version: 1, key } }); continue }
      await writer.put('evidenceBlobs', { key, ref: body.ref })
      let index = 0, length = 0
      for await (const bytes of body.content.open()) for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
        const part = bytes.slice(offset, offset + BLOB_CHUNK_BYTES)
        await writer.put('evidenceChunks', { key, index: index++, bytes: part }); length += part.length
      }
      if (length !== body.ref.byteLength) throw new Error('Historical body staging length mismatch')
      shared.push({ source: body.ref, content: { version: 1, key } })
    }
    return page(catalog ? 'evidence-catalog-body-page' : 'evidence-blob-page', shared)
  }
  const inheritedRoot = { version: compact ? 2 : 1, kind: 'inherited-snapshot-evidence', setDigest: compact ? await catalogEvidenceSetDigest(sources.members as CatalogInheritedSnapshotSources['members']) : await inheritedSnapshotSetDigest(members.map(member => member.id)), members: await reuse?.members() ?? await page(compact ? 'evidence-catalog-member-page' : 'evidence-member-page', members), blobs: await bodies(sources.bodies), ...(compact ? { catalogBodies: await bodies(sources.catalogBodies ?? [], true) } : {}) }
  const inheritedEvidence = await reuse?.root(inheritedRoot) ?? await put('evidenceRoots', inheritedRoot)
  let plannerEvidence = await reuse?.planner()
  if (!plannerEvidence) {
    plannerEvidence = ref()
    await writer.put('plannerEvidence', { key: plannerEvidence.key, stream: await stream(plannerStream) })
  }
  await writer.put('documents', { key: GUEST_EXTENSION_KEY, value: { version: 1, kind: 'guest-workspace-extensions', inheritedEvidence, plannerEvidence } })
}

// Logical equality selects stored locator branches; it never grants account ciphertext authority
// Managed storage separately proves the exact installed predecessor and compares every emitted row
export async function prepareCapturedGuestEvidenceWrite(evidence: CapturedGuestEvidence, previous: CapturedGuestEvidence, checkpoint?: () => Promise<void>) {
  const next = captured.get(evidence), prior = captured.get(previous), graph = prior?.graph
  if (!next || !prior || !graph) throw new Error('Read-admitted guest evidence is required for retention')
  // Freeze small reference vectors and bind read methods before yielding; no payload is cloned
  // Public logical-source views cannot retarget an in-flight stored-graph retention decision
  const stream = (source: BlobSource): BlobSource => Object.freeze({ byteLength: source.byteLength, open: source.open.bind(source) })
  const refs = (values: readonly WorkspaceBlobRef[]) => values.map(ref => WorkspaceBlobRefSchema.parse(ref))
  const bodies = (values: WorkspaceState['blobs']) => values.map(body => ({ ref: WorkspaceBlobRefSchema.parse(body.ref), content: stream(body.content) }))
  const sources: InheritedSnapshotSources = freezeEvidence({ ...next.sources, members: next.sources.members.map(member => ({ ...member, metadata: stream(member.metadata), subset: refs(member.subset), ...(member.catalogSubset ? { catalogSubset: refs(member.catalogSubset) } : {}) })), bodies: bodies(next.sources.bodies), ...(next.sources.catalogBodies ? { catalogBodies: bodies(next.sources.catalogBodies) } : {}) })
  const plannerStream = stream(next.plannerStream)
  const check = async () => { await checkpoint?.(); await previous.check(); await evidence.check(); await checkpoint?.() }
  await check()
  const membership = sources.version === 2 ? await catalogEvidenceSetDigest(sources.members as CatalogInheritedSnapshotSources['members']) : await inheritedSnapshotSetDigest(sources.members.map(member => member.id))
  if (membership !== evidence.setDigest) throw new Error('Captured evidence membership changed')
  const key = (member: InheritedSnapshotSources['members'][number]) => `${member.format ?? 'legacy-v1'}:${member.id}`
  const oldMembers = new Map(prior.sources.members.map(member => [key(member), member]))
  const storedMembers = new Map(graph.members.map(member => [`${member.format ?? 'legacy-v1'}:${member.id}`, member]))
  const members = new Map<string, StoredEvidenceMember>()
  const sameRefs = (a: readonly WorkspaceBlobRef[], b: readonly WorkspaceBlobRef[]) => a.length === b.length && a.every((ref, index) => sameRef(ref, b[index]))
  for (const member of sources.members) {
    const old = oldMembers.get(key(member))
    if (old && sameRefs(old.subset, member.subset) && sameRefs(old.catalogSubset ?? [], member.catalogSubset ?? []) && await equalMetadataStreams(old.metadata, member.metadata)) members.set(key(member), storedMembers.get(key(member))!)
    await check()
  }
  const native = new Set<string>(), catalogs = new Set<string>()
  for (const [oldBodies, nextBodies, matching] of [[prior.sources.bodies, sources.bodies, native], [prior.sources.catalogBodies ?? [], sources.catalogBodies ?? [], catalogs]] as const) {
    const registry = new Map(oldBodies.map(body => [blobIdentity(body.ref), body]))
    for (const body of nextBodies) {
      const old = registry.get(blobIdentity(body.ref))
      if (old && sameRef(old.ref, body.ref) && await equalMetadataStreams(old.content, body.content)) matching.add(blobIdentity(body.ref))
      await check()
    }
  }
  const planner = await equalMetadataStreams(prior.plannerStream, plannerStream)
  await check()
  const sameMembers = members.size === sources.members.length && members.size === prior.sources.members.length
  const sameNative = native.size === sources.bodies.length && native.size === prior.sources.bodies.length
  const sameCatalogs = catalogs.size === (sources.catalogBodies?.length ?? 0) && catalogs.size === (prior.sources.catalogBodies?.length ?? 0)
  const sameFormat = (prior.sources.version ?? 1) === (sources.version ?? 1)
  return { unchanged: sameFormat && sameMembers && sameNative && sameCatalogs && planner, async write(writer: Writer) {
    await check()
    const emitted = new Set<string>()
    const emit = (table: string, ref: Locator) => graph.emit(writer, table, ref.key, emitted, check)
    const reuse: GraphReuse = {
      async member(member) {
        const stored = members.get(key(member))
        if (stored) {
          await emit('evidenceRoots', stored.metadata); await emit('evidencePages', stored.blobSubset)
          if (sources.version === 2 && stored.catalogSubset) await emit('evidencePages', stored.catalogSubset)
        }
        return stored
      },
      async body(body, catalog) {
        if (!(catalog ? catalogs : native).has(blobIdentity(body.ref))) return false
        await emit('evidenceBlobs', { version: 1, key: `${catalog ? 'catalog-body:' : ''}${blobIdentity(body.ref)}` })
        return true
      },
      async registry(catalog) {
        const root = catalog ? graph.root.catalogBodies : graph.root.blobs
        if (!root || !(catalog ? sameCatalogs : sameNative)) return undefined
        await emit('evidencePages', root); return root
      },
      async members() {
        if (!sameFormat || !sameMembers) return undefined
        await emit('evidencePages', graph.root.members); return graph.root.members
      },
      async root(value) {
        if (JSON.stringify(value) !== JSON.stringify(graph.root)) return undefined
        await emit('evidenceRoots', graph.extension.inheritedEvidence); return graph.extension.inheritedEvidence
      },
      async planner() {
        if (!planner) return undefined
        await emit('plannerEvidence', graph.extension.plannerEvidence); return graph.extension.plannerEvidence
      },
    }
    await writeGraph(writer, sources, plannerStream, reuse)
    await check()
  } }
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
  if (left.sources.version !== right.sources.version) throw new Error('Guest evidence format changed')
  const leftCatalogs = left.sources.catalogBodies ?? [], rightCatalogs = right.sources.catalogBodies ?? []
  if (leftCatalogs.length !== rightCatalogs.length) throw new Error('Guest catalog registry changed')
  // Registries are sets that durable encoders sort; member subsets retain their original order
  const rightCatalogRegistry = new Map(rightCatalogs.map(body => [blobIdentity(body.ref), body]))
  for (const body of leftCatalogs) { const other = rightCatalogRegistry.get(blobIdentity(body.ref)); if (!other || !sameRef(body.ref, other.ref) || !await equalMetadataStreams(body.content, other.content)) throw new Error('Guest catalog body changed') }
  if (a.setDigest !== b.setDigest || left.sources.members.length !== right.sources.members.length || left.sources.bodies.length !== right.sources.bodies.length || !await equalMetadataStreams(left.plannerStream, right.plannerStream)) throw new Error('Guest evidence changed')
  for (const [index, member] of left.sources.members.entries()) {
    const other = right.sources.members[index]
    if (member.format !== other.format || (member.catalogSubset?.length ?? 0) !== (other.catalogSubset?.length ?? 0) || (member.catalogSubset ?? []).some((ref, index) => !sameRef(ref, other.catalogSubset![index])) || member.id !== other.id || member.subset.length !== other.subset.length || member.subset.some((ref, index) => !sameRef(ref, other.subset[index])) || !await equalMetadataStreams(member.metadata, other.metadata)) throw new Error('Guest historical evidence changed')
  }
  const rightBodyRegistry = new Map(right.sources.bodies.map(body => [blobIdentity(body.ref), body]))
  for (const body of left.sources.bodies) { const other = rightBodyRegistry.get(blobIdentity(body.ref)); if (!other || !sameRef(body.ref, other.ref) || !await equalMetadataStreams(body.content, other.content)) throw new Error('Guest historical body changed') }
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
export async function guestEvidenceFromSnapshot(snapshot: WorkspaceSnapshotV2 | WorkspaceSnapshotV3, planner: GuestPlannerEvidence): Promise<CapturedGuestEvidence> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  GuestPlannerEvidenceSchema.parse(planner)
  const compact = snapshot.version === 3
  const original = capturedBackupEvidence(snapshot), catalogKeys = new Set<string>(), members: InheritedSnapshotSources['members'][number][] = [], keys = new Set<string>()
  for (const { id } of snapshot.historicalEvidence?.snapshots ?? []) {
    const child = await openHistoricalSnapshot(snapshot, id)
    try {
      const metadata = original.historical.get(id)
      if (!metadata) throw new Error('Missing inherited metadata')
      const subset = child.state.blobs.map(blob => blob.ref)
      for (const ref of subset) keys.add(blobIdentity(ref))
      const catalogSubset = child.version === 3 ? child.catalogBodies : []
      for (const ref of catalogSubset) catalogKeys.add(blobIdentity(ref))
      members.push({ id, metadata, subset, ...(compact ? { format: child.version === 3 ? 'compact-v2' : 'legacy-v1', catalogSubset } : {}) })
    } finally { await disposeWorkspaceSnapshot(child) }
  }
  const bodies = original.blobs.filter(blob => keys.has(blobIdentity(blob.ref)))
  const ownedPlanner = freezeEvidence(structuredClone(planner))
  const evidence: CapturedGuestEvidence = Object.freeze({ setDigest: compact ? await catalogEvidenceSetDigest(members as CatalogInheritedSnapshotSources['members']) : await inheritedSnapshotSetDigest(members.map(member => member.id)), planner: ownedPlanner, check: () => assertOwnedWorkspaceSnapshot(snapshot) })
  captured.set(evidence, { sources: { members, bodies, ...(compact ? { version: 2, catalogBodies: original.catalogBodies?.filter(body => catalogKeys.has(blobIdentity(body.ref))) ?? [] } : {}) }, plannerStream: metadataSource(ownedPlanner) })
  return evidence
}

export async function mergeGuestEvidence(destination: CapturedGuestEvidence, source: CapturedGuestEvidence, planner: GuestPlannerEvidence): Promise<CapturedGuestEvidence> {
  await destination.check(); await source.check()
  if ([destination, source].some(value => guestEvidenceSources(value).version === 2)) return mergeCatalogGuestEvidence(destination, source, planner)
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
export async function guestEvidenceFromFrozenCurrent(snapshot: WorkspaceSnapshot): Promise<CapturedGuestEvidence> {
  return captureCurrentEvidence(snapshot)
}

async function captureCurrentEvidence(snapshot: WorkspaceSnapshot, preserveStored = false): Promise<CapturedGuestEvidence> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  if (snapshot.version === 3) {
    await validateWorkspaceSnapshot(snapshot)
    const { historicalEvidence: _history, ...flat } = snapshotMetadata(snapshot)
    const metadata = metadataSource(flat), id = await compactHistoricalIdentity(metadata), planner = emptyPlannerEvidence()
    const all = capturedBackupEvidence(snapshot)
    const sources: CatalogInheritedSnapshotSources = { version: 2, members: [{ format: 'compact-v2', id, metadata, subset: snapshot.state.blobs.map(body => body.ref), catalogSubset: snapshot.catalogBodies }], bodies: snapshot.state.blobs, catalogBodies: (all.catalogBodies ?? []).filter(body => snapshot.catalogBodies.some(ref => sameRef(ref, body.ref))) }
    await validateCatalogEvidenceSources(sources, () => assertOwnedWorkspaceSnapshot(snapshot))
    const evidence = Object.freeze({ setDigest: await catalogEvidenceSetDigest(sources.members), planner, check: () => assertOwnedWorkspaceSnapshot(snapshot) })
    captured.set(evidence, { sources, plannerStream: metadataSource(planner) })
    return evidence
  }
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

// Use the same flat current-member producer as the saved copy archive, including ordered subsets
// A comparison binding must never hash a compact stream with the legacy identity domain
export async function capturedCopyOriginal(snapshot: WorkspaceSnapshot) {
  const evidence = await captureCurrentEvidence(snapshot, true), sources = guestEvidenceSources(evidence)
  const member = sources.members[0]
  const metadata = { byteLength: member.metadata.byteLength, async *open() {
    await evidence.check()
    for await (const bytes of member.metadata.open()) { await evidence.check(); yield bytes; await evidence.check() }
    await evidence.check()
  } }
  return { ...member, metadata, format: member.format ?? 'legacy-v1' as const }
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
    if (source.version === 1 || !source.historicalEvidence || exact.members.length !== source.historicalEvidence.snapshots.length
      || exact.members.some((member, index) => { const retained = source.historicalEvidence!.snapshots[index]; return member.id !== retained.id || (member.format ?? 'legacy-v1') !== ('format' in retained ? retained.format : 'legacy-v1') })
      || exact.bodies.length !== source.historicalEvidence.blobs.length
      || exact.bodies.some((body, index) => !sameRef(body.ref, source.historicalEvidence!.blobs[index]))) throw new Error('Copy original evidence differs from the captured source')
    if (source.version === 3 && (exact.catalogBodies ?? []).some(body => !source.historicalEvidence!.catalogBodies.some(ref => sameRef(body.ref, ref)))) throw new Error('Copy catalog originals differ from the captured source')
    result = await mergeGuestEvidence(result, originals, planner)
  } else if (source && source !== selected) result = await mergeGuestEvidence(result, await captureCurrentEvidence(source, true), planner)
  for (const snapshot of new Set([selected, ...(source && !originals ? [source] : [])])) {
    if (snapshot.version !== 1) result = await mergeGuestEvidence(result, await guestEvidenceFromSnapshot(snapshot, planner), planner)
  }
  return result
}

// V2 keeps its own strict root/member/stream route; v1 token bytes never acquire compact semantics
async function readCatalogGuestEvidence(rows: GuestEvidenceRows, check: () => Promise<void>, graph: () => StoredEvidenceGraph): Promise<CapturedGuestEvidence> {
  const schemas = catalogEvidenceSchemas(locator)
  let visits = 0, declaredBytes = 0
  const reserve = (count: number, bytes = 0) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > WORKSPACE_BACKUP_LIMITS.frames - visits || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > WORKSPACE_BACKUP_LIMITS.bytes - declaredBytes) throw new Error('Guest catalog evidence resource limit')
    visits += count; declaredBytes += bytes
  }
  const visited = new Map<string, Set<string>>(Object.keys(GUEST_EVIDENCE_STORES).map(table => [table, new Set()]))
  const take = async (table: string, ref: Locator): Promise<unknown> => {
    await check()
    const used = visited.get(table)!
    if (used.has(ref.key)) throw new Error('Repeated or cyclic guest catalog locator')
    reserve(1); used.add(ref.key)
    const row = envelope.parse(await rows.get(table, ref.key))
    await check()
    if (row.key !== ref.key) throw new Error('Guest catalog locator mismatch')
    return row.value
  }
  const page = async <T>(ref: Locator, kind: string, schema: z.ZodType<T>): Promise<T[]> => {
    const entries: T[] = [], pending = [{ ref, depth: 1 }]
    while (pending.length) {
      const next = pending.pop()!
      if (next.depth > WORKSPACE_BACKUP_LIMITS.depth) throw new Error('Guest catalog page depth exceeded')
      const raw = await take('evidencePages', next.ref)
      const value = z.strictObject({ version: z.literal(1), kind: z.literal(kind), entries: z.array(schema), children: z.array(locator) }).parse(raw)
      if (size(raw) > INDEX_PAGE_BYTES || value.entries.length + value.children.length > INDEX_PAGE_ENTRIES || value.entries.length && value.children.length || visited.get('evidencePages')!.size > WORKSPACE_BACKUP_LIMITS.frames) throw new Error('Guest catalog page bound exceeded')
      entries.push(...value.entries); pending.push(...value.children.toReversed().map(ref => ({ ref, depth: next.depth + 1 })))
    }
    return entries
  }
  const stream = async (ref: Locator, compact: boolean): Promise<BlobSource> => {
    const raw = await take('evidenceRoots', ref), root = compact ? schemas.stream.parse(raw) : streamSchema.parse(raw)
    if (root.byteLength > WORKSPACE_BACKUP_LIMITS.bytes) throw new Error('Guest catalog metadata bound exceeded')
    reserve(0, root.byteLength)
    const segments = await page(root.pages, 'evidence-metadata-page', segmentSchema)
    let length = 0
    for (const [index, segment] of segments.entries()) {
      if (segment.ordinal !== index || segment.byteLength > WORKSPACE_BACKUP_LIMITS.payload || visited.get('evidenceSegments')!.has(segment.content.key)) throw new Error('Guest catalog segment mismatch')
      reserve(1); visited.get('evidenceSegments')!.add(segment.content.key); length += segment.byteLength
    }
    if (length !== root.byteLength) throw new Error('Guest catalog metadata length mismatch')
    const content: BlobSource = { byteLength: length, async *open() {
      await check()
      for (const segment of segments) {
        const row = z.strictObject({ key: z.string(), bytes: z.instanceof(Uint8Array) }).parse(await rows.get('evidenceSegments', segment.content.key))
        if (row.key !== segment.content.key || row.bytes.length !== segment.byteLength || await hashBlob(memoryBlob(row.bytes)) !== segment.sha256) throw new Error('Guest catalog metadata segment changed')
        await check(); yield row.bytes; await check()
      }
    } }
    const { verifiedBlob } = await import('./blobs')
    return verifiedBlob(content, root.digest)
  }
  const extension = GuestExtensionsSchema.parse(envelope.parse(await rows.get('documents', GUEST_EXTENSION_KEY)).value)
  const root = schemas.root.parse(await take('evidenceRoots', extension.inheritedEvidence))
  const members = await page(root.members, 'evidence-catalog-member-page', schemas.member)
  const loadBodies = async (ref: Locator, catalog: boolean) => {
    const entries = await page(ref, catalog ? 'evidence-catalog-body-page' : 'evidence-blob-page', bodySchema)
    const bodies: WorkspaceState['blobs'][number][] = []
    for (const [ordinal, entry] of entries.entries()) {
      const key = `${catalog ? 'catalog-body:' : ''}${blobIdentity(entry.source)}`
      if (entry.content.key !== key || ordinal && compareBackupRefs(entries[ordinal - 1].source, entry.source) >= 0 || visited.get('evidenceBlobs')!.has(key)) throw new Error('Guest catalog body association mismatch')
      const row = strictBody.parse(await rows.get('evidenceBlobs', key))
      if (row.key !== key || !sameRef(row.ref, entry.source)) throw new Error('Guest catalog body ref mismatch')
      reserve(1, row.ref.byteLength); visited.get('evidenceBlobs')!.add(key)
      const lengths: number[] = []
      let length = 0
      // Native rows keep their original variable chunk boundaries across a root-version upgrade
      while (length < row.ref.byteLength) {
        const index = lengths.length
        if (index >= WORKSPACE_BACKUP_LIMITS.frames) throw new Error('Guest catalog body bound exceeded')
        const chunk = strictChunk.parse(await rows.get('evidenceChunks', [key, index]))
        if (chunk.key !== key || chunk.index !== index || !chunk.bytes.length || chunk.bytes.length > BLOB_CHUNK_BYTES || chunk.bytes.length > row.ref.byteLength - length) throw new Error('Guest catalog body chunk mismatch')
        reserve(1); visited.get('evidenceChunks')!.add(JSON.stringify([key, index])); lengths.push(chunk.bytes.length); length += chunk.bytes.length
        await check()
      }
      const content: BlobSource = { byteLength: row.ref.byteLength, async *open() {
        await check()
        for (const [index, length] of lengths.entries()) {
          const chunk = strictChunk.parse(await rows.get('evidenceChunks', [key, index]))
          if (chunk.key !== key || chunk.index !== index || chunk.bytes.length !== length) throw new Error('Guest catalog body chunk mismatch')
          await check(); yield chunk.bytes; await check()
        }
      } }
      bodies.push({ ref: row.ref, content })
    }
    return bodies
  }
  const bodies = await loadBodies(root.blobs, false), catalogBodies = await loadBodies(root.catalogBodies, true)
  const registry = new Map(bodies.map(body => [blobIdentity(body.ref), body])), catalogRegistry = new Map(catalogBodies.map(body => [blobIdentity(body.ref), body]))
  const inherited: CatalogInheritedSnapshotSources['members'][number][] = []
  for (const member of members) {
    const subset = await page(member.blobSubset, 'evidence-subset-page', bodySchema)
    const catalogSubset = await page(member.catalogSubset, 'evidence-catalog-subset-page', bodySchema)
    for (const [entries, lookup, prefix] of [[subset, registry, ''], [catalogSubset, catalogRegistry, 'catalog-body:']] as const) for (const entry of entries) {
      const body = lookup.get(blobIdentity(entry.source))
      if (!body || !sameRef(body.ref, entry.source) || entry.content.key !== `${prefix}${blobIdentity(entry.source)}`) throw new Error('Guest catalog subset association mismatch')
    }
    inherited.push({ format: member.format, id: member.id, metadata: await stream(member.metadata, member.format === 'compact-v2'), subset: subset.map(entry => entry.source), catalogSubset: catalogSubset.map(entry => entry.source) })
  }
  const sources: CatalogInheritedSnapshotSources = { version: 2, members: inherited, bodies, catalogBodies }
  if (await validateCatalogEvidenceSources(sources, check) !== root.setDigest) throw new Error('Guest catalog membership digest mismatch')
  const plannerRow = z.strictObject({ key: z.string(), stream: locator }).parse(await rows.get('plannerEvidence', extension.plannerEvidence.key))
  if (plannerRow.key !== extension.plannerEvidence.key) throw new Error('Planner evidence locator mismatch')
  reserve(1); visited.get('plannerEvidence')!.add(plannerRow.key)
  const plannerStream = await stream(plannerRow.stream, false), plannerRaw = await readBackupMetadata(plannerStream)
  GuestPlannerEvidenceSchema.parse(plannerRaw)
  for (const [table, used] of visited) {
    const keys = await rows.keys(table)
    if (keys.length !== used.size || keys.some(key => !used.has(typeof key === 'string' ? key : JSON.stringify(key)))) throw new Error('Orphan guest catalog evidence rows')
  }
  await check()
  const planner = freezeEvidence(plannerRaw as GuestPlannerEvidence)
  const evidence = Object.freeze({ setDigest: root.setDigest, planner, check })
  captured.set(evidence, { sources: freezeEvidence(sources), plannerStream, graph: graph() })
  return evidence
}

async function mergeCatalogGuestEvidence(destination: CapturedGuestEvidence, source: CapturedGuestEvidence, planner: GuestPlannerEvidence): Promise<CapturedGuestEvidence> {
  GuestPlannerEvidenceSchema.parse(planner)
  const members = new Map<string, CatalogInheritedSnapshotSources['members'][number]>()
  const bodies = new Map<string, WorkspaceState['blobs'][number]>(), catalogs = new Map<string, WorkspaceState['blobs'][number]>()
  for (const evidence of [destination, source]) {
    await evidence.check()
    const input = guestEvidenceSources(evidence)
    for (const value of input.members) {
      const member = { ...value, format: value.format ?? 'legacy-v1', catalogSubset: value.catalogSubset ?? [] }, key = historicalMemberKey(member), previous = members.get(key)
      if (previous && (previous.subset.length !== member.subset.length || previous.subset.some((ref, index) => !sameRef(ref, member.subset[index])) || previous.catalogSubset.length !== member.catalogSubset.length || previous.catalogSubset.some((ref, index) => !sameRef(ref, member.catalogSubset[index])) || !await equalMetadataStreams(previous.metadata, member.metadata))) throw new Error('Contradictory inherited catalog member')
      if (!previous) members.set(key, member)
    }
    for (const [registry, entries] of [[bodies, input.bodies], [catalogs, input.catalogBodies ?? []]] as const) for (const body of entries) {
      const key = blobIdentity(body.ref), previous = registry.get(key)
      if (previous && (!sameRef(previous.ref, body.ref) || !await equalMetadataStreams(previous.content, body.content))) throw new Error('Contradictory inherited catalog body')
      if (!previous) registry.set(key, body)
    }
    await evidence.check()
  }
  const sources: CatalogInheritedSnapshotSources = { version: 2, members: [...members].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, member]) => member), bodies: [...bodies.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref)), catalogBodies: [...catalogs.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref)) }
  const check = async () => { await destination.check(); await source.check() }
  await validateCatalogEvidenceSources(sources, check)
  const ownedPlanner = freezeEvidence(structuredClone(planner))
  const evidence = Object.freeze({ setDigest: await catalogEvidenceSetDigest(sources.members), planner: ownedPlanner, check })
  captured.set(evidence, { sources, plannerStream: metadataSource(ownedPlanner) })
  return evidence
}
