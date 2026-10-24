import { z } from 'zod'
import { prepareLocalIndex, readLocalIndex } from './local-index'
import type { LocalRecordRef, LocalStoreAdapter } from './local-root'
import { GUEST_EVIDENCE_STORES, GUEST_FILES_V1_STORES, GUEST_EXTENSION_KEY, readGuestEvidence, writeCapturedGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { hashBlob, memoryBlob, readBlob, verifiedBlob } from './blobs'
import { parseBoundedJson } from '../interchange/json'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { INDEX_PAGE_BYTES } from './directory'

const refSchema = z.strictObject({ documentId: z.string().min(1), revisionId: z.string().min(1) })
const keySchema = z.union([z.string(), z.tuple([z.string(), z.number().int().nonnegative().safe()])])
const rowSchema = z.strictObject({ table: z.enum(['documents', 'evidenceRoots', 'evidencePages', 'evidenceSegments', 'plannerEvidence', 'evidenceBlobs', 'evidenceChunks']), key: keySchema, ref: refSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), encoding: z.enum(['json', 'bytes']) })
const rootSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-inherited-evidence'), roots: z.array(z.strictObject({ kind: z.literal('guest-evidence-rows'), index: refSchema })).max(1) })
const utf8 = new TextEncoder()
const rowIdentity = (table: string, key: unknown) => JSON.stringify([table, key])

// The existing strict evidence codec owns historical metadata, original body and orphan validation
// This adapter only relocates its immutable rows into the managed transaction domain
export async function prepareLocalEvidence(adapter: LocalStoreAdapter, operationId: string, evidence: CapturedGuestEvidence): Promise<LocalRecordRef> {
  const rows: z.infer<typeof rowSchema>[] = [], seen = new Set<string>()
  await writeCapturedGuestEvidence(evidence, { async put(table, input) {
    const row = input as { key: string; index?: number; bytes?: Uint8Array }
    const key = table === 'evidenceChunks' ? [row.key, row.index!] as [string, number] : row.key
    const identity = rowIdentity(table, key)
    if (seen.has(identity)) throw new Error('Duplicate managed evidence row')
    seen.add(identity)
    const binary = table === 'evidenceChunks' || table === 'evidenceSegments'
    if (binary && !(row.bytes instanceof Uint8Array)) throw new Error('Missing managed evidence bytes')
    const content = memoryBlob(binary ? row.bytes! : utf8.encode(JSON.stringify(input)))
    const digest = await hashBlob(content), ref = await adapter.stage(operationId, content, [])
    rows.push(rowSchema.parse({ table, key, ref, digest, encoding: binary ? 'bytes' : 'json' }))
  } })
  const index = await prepareLocalIndex(rows, page => adapter.stage(operationId, memoryBlob(utf8.encode(JSON.stringify(page))), [...page.children, ...page.entries.map(row => row.ref)]))
  const root = rootSchema.parse({ version: 1, kind: 'local-inherited-evidence', roots: [{ kind: 'guest-evidence-rows', index: index.root }] })
  return adapter.stage(operationId, memoryBlob(utf8.encode(JSON.stringify(root))), [index.root])
}

// Current editing needs the authenticated archive reference, not every historical payload
// Full consumers still use readLocalEvidence; this check does not certify archive health
export async function checkLocalEvidenceRoot(adapter: LocalStoreAdapter, root: LocalRecordRef, check: () => Promise<void>): Promise<void> {
  await check()
  const bytes = await readBlob(await adapter.read(root), INDEX_PAGE_BYTES)
  try { rootSchema.parse(parseBoundedJson(bytes, 'managed inherited evidence root')) }
  finally { bytes.fill(0) }
  await check()
}

export async function readLocalEvidence(adapter: LocalStoreAdapter, root: LocalRecordRef, check: () => Promise<void>, readBounded?: (ref: LocalRecordRef, limit: number, digest?: string) => Promise<Uint8Array>): Promise<CapturedGuestEvidence | undefined> {
  // A supplied reader owns the same captured head/profile checks in one bounded native read window
  // The default adapter path keeps its existing per-read guards, and both paths retain full evidence validation
  const read = readBounded ?? (async (ref: LocalRecordRef, limit: number, digest?: string) => { await check(); const source = await adapter.read(ref); const bytes = await readBlob(digest ? verifiedBlob(source, digest) : source, limit); await check(); return bytes })
  const json = async (ref: LocalRecordRef) => parseBoundedJson(await read(ref, INDEX_PAGE_BYTES), 'managed inherited evidence')
  const value = rootSchema.parse(await json(root))
  if (!value.roots.length) return undefined
  const index = await readLocalIndex(value.roots[0].index, json, rowSchema.parse)
  const rows = new Map<string, z.infer<typeof rowSchema>>()
  for (const row of index.entries) {
    const identity = rowIdentity(row.table, row.key)
    if (rows.has(identity) || row.table === 'documents' && row.key !== GUEST_EXTENSION_KEY || (row.table === 'evidenceChunks') !== Array.isArray(row.key)
      || (row.table === 'evidenceChunks' || row.table === 'evidenceSegments') !== (row.encoding === 'bytes')) throw new Error('Invalid managed evidence row association')
    rows.set(identity, row)
  }
  return readGuestEvidence({
    tables: [...Object.keys(GUEST_FILES_V1_STORES), ...Object.keys(GUEST_EVIDENCE_STORES)],
    keys: async table => index.entries.filter(row => row.table === table).map(row => row.key),
    async get(table, key) {
      const row = rows.get(rowIdentity(table, key))
      if (!row) return undefined
      const bytes = await read(row.ref, row.encoding === 'bytes' ? WORKSPACE_BACKUP_LIMITS.payload : INDEX_PAGE_BYTES, row.digest)
      if (row.encoding === 'json') return parseBoundedJson(bytes, 'managed evidence row')
      return Array.isArray(row.key) ? { key: row.key[0], index: row.key[1], bytes } : { key: row.key, bytes }
    },
  }, check)
}
