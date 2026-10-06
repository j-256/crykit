import Dexie, { type Table } from 'dexie'
import { DOCUMENT_LIMITS, parseDocument } from './document'
import { deriveInspectorFileInfo, readInspectorFileInfo, INSPECTOR_FILE_INFO_SCHEMA_VERSION } from './file-info'
import type { InspectorDraft, InspectorDraftSummary, InspectorFileInfo } from './types'

const STORAGE_NAME = 'crykit-mod-inspector-v1'
const DOCUMENT_SCHEMA_VERSION = 1
const LEGACY_DATABASE_VERSION = 1
const DATABASE_LAYOUT_VERSION = 2
const INITIAL_REVISION = 1
const TABLES = Object.freeze({ drafts: 'drafts', chunks: 'chunks' })
const PAYLOAD_KIND = Object.freeze({ original: 'original', draft: 'draft' } as const)
const CHUNK_KIND_INDEX = '[draftId+kind]'
const CHUNK_DRAFT_INDEX = 'draftId'
const HASH_OFFSET = 2_166_136_261
const HASH_PRIME = 16_777_619
const MAX_CHECKSUM = 0xffff_ffff

export const INSPECTOR_TEXT_CHUNK_CODE_UNITS = 1024 * 1024

type PayloadKind = typeof PAYLOAD_KIND[keyof typeof PAYLOAD_KIND]
type ChunkKey = [string, PayloadKind, number]

interface PayloadManifest {
  readonly codeUnits: number
  readonly chunkCount: number
  readonly checksums: readonly number[]
}

interface StoredDraft extends InspectorDraftSummary {
  readonly layoutVersion: typeof DATABASE_LAYOUT_VERSION
  readonly originalPayload: PayloadManifest
  readonly draftPayload: PayloadManifest
}

interface TextChunk {
  readonly layoutVersion: typeof DATABASE_LAYOUT_VERSION
  readonly draftId: string
  readonly kind: PayloadKind
  readonly revision: number
  readonly index: number
  readonly text: string
}

export function summarizeInspectorDraft(draft: InspectorDraftSummary): InspectorDraftSummary {
  const { schemaVersion, id, filename, referenceId, createdAt, updatedAt, revision } = draft
  const fileInfo = readInspectorFileInfo(draft.fileInfo)
  return { schemaVersion, id, filename, referenceId, createdAt, updatedAt, revision, ...(fileInfo ? { fileInfo } : {}) }
}

function inconsistent(detail: string): never {
  throw new Error(`Inspector draft storage is incomplete or inconsistent: ${detail}. Restore a verified exported copy before editing.`)
}

function validateSummary(row: InspectorDraftSummary): void {
  if (row.schemaVersion !== DOCUMENT_SCHEMA_VERSION) throw new Error('Unsupported inspector draft version; keep this database intact and use a compatible application version')
  if (typeof row.id !== 'string' || !row.id || typeof row.filename !== 'string' || typeof row.referenceId !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || !Number.isSafeInteger(row.revision) || row.revision < INITIAL_REVISION) inconsistent('invalid draft metadata')
}

function validateManifest(manifest: PayloadManifest | undefined, kind: PayloadKind): PayloadManifest {
  if (!manifest || !Number.isSafeInteger(manifest.codeUnits) || manifest.codeUnits <= 0 || manifest.codeUnits > DOCUMENT_LIMITS.textLength || manifest.chunkCount !== Math.ceil(manifest.codeUnits / INSPECTOR_TEXT_CHUNK_CODE_UNITS) || !Array.isArray(manifest.checksums) || manifest.checksums.length !== manifest.chunkCount || manifest.checksums.some(checksum => !Number.isInteger(checksum) || checksum < 0 || checksum > MAX_CHECKSUM)) inconsistent(`invalid ${kind} payload manifest`)
  return manifest
}

function validateStoredDraft(row: StoredDraft): StoredDraft {
  validateSummary(row)
  if (row.layoutVersion !== DATABASE_LAYOUT_VERSION) inconsistent('unsupported payload layout version')
  validateManifest(row.originalPayload, PAYLOAD_KIND.original)
  validateManifest(row.draftPayload, PAYLOAD_KIND.draft)
  return row
}

function checksum(text: string): number {
  let hash = HASH_OFFSET
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), HASH_PRIME)
  return hash >>> 0
}

function manifestFor(text: string): PayloadManifest {
  const checksums: number[] = []
  for (let offset = 0; offset < text.length; offset += INSPECTOR_TEXT_CHUNK_CODE_UNITS) checksums.push(checksum(text.slice(offset, offset + INSPECTOR_TEXT_CHUNK_CODE_UNITS)))
  return { codeUnits: text.length, chunkCount: checksums.length, checksums }
}

function storedDraft(row: InspectorDraft, originalPayload: PayloadManifest, draftPayload: PayloadManifest): StoredDraft {
  return { ...summarizeInspectorDraft(row), layoutVersion: DATABASE_LAYOUT_VERSION, originalPayload, draftPayload }
}

async function writeChunks(chunks: Table<TextChunk, ChunkKey>, id: string, kind: PayloadKind, text: string, revision: number): Promise<void> {
  for (let offset = 0, index = 0; offset < text.length; offset += INSPECTOR_TEXT_CHUNK_CODE_UNITS, index++) {
    await chunks.add({ layoutVersion: DATABASE_LAYOUT_VERSION, draftId: id, kind, revision, index, text: text.slice(offset, offset + INSPECTOR_TEXT_CHUNK_CODE_UNITS) })
  }
}

export class InspectorStorage {
  private readonly database: Dexie
  private readonly drafts: Table<StoredDraft, string>
  private readonly chunks: Table<TextChunk, ChunkKey>

  constructor(name = STORAGE_NAME) {
    this.database = new Dexie(name)
    this.database.version(LEGACY_DATABASE_VERSION).stores({ [TABLES.drafts]: 'id, updatedAt' })
    this.database.version(DATABASE_LAYOUT_VERSION).stores({
      [TABLES.drafts]: 'id, updatedAt',
      [TABLES.chunks]: '[draftId+kind+index], [draftId+kind], draftId',
    }).upgrade(async transaction => {
      const legacy = transaction.table<InspectorDraft, string>(TABLES.drafts)
      const metadata = transaction.table<StoredDraft, string>(TABLES.drafts)
      const chunks = transaction.table<TextChunk, ChunkKey>(TABLES.chunks)
      for (const id of await legacy.toCollection().primaryKeys()) {
        const row = await legacy.get(id)
        if (!row) inconsistent('legacy draft disappeared during migration')
        validateSummary(row)
        if (typeof row.originalText !== 'string' || typeof row.draftText !== 'string') inconsistent('legacy document text is missing')
        parseDocument(row.originalText)
        parseDocument(row.draftText)
        const originalPayload = manifestFor(row.originalText)
        const draftPayload = row.originalText === row.draftText ? originalPayload : manifestFor(row.draftText)
        await writeChunks(chunks, row.id, PAYLOAD_KIND.original, row.originalText, INITIAL_REVISION)
        await writeChunks(chunks, row.id, PAYLOAD_KIND.draft, row.draftText, row.revision)
        await metadata.put(storedDraft(row, originalPayload, draftPayload))
      }
    })
    this.drafts = this.database.table(TABLES.drafts)
    this.chunks = this.database.table(TABLES.chunks)
  }

  async list(): Promise<InspectorDraftSummary[]> {
    return (await this.drafts.orderBy('updatedAt').reverse().toArray()).map(row => summarizeInspectorDraft(validateStoredDraft(row)))
  }

  private async validateChunkCount(row: StoredDraft): Promise<void> {
    const expected = row.originalPayload.chunkCount + row.draftPayload.chunkCount
    if (await this.chunks.where(CHUNK_DRAFT_INDEX).equals(row.id).count() !== expected) inconsistent('unexpected or missing payload chunks')
  }

  private async payload(row: StoredDraft, kind: PayloadKind, assemble = true): Promise<string> {
    const manifest = kind === PAYLOAD_KIND.original ? row.originalPayload : row.draftPayload
    const revision = kind === PAYLOAD_KIND.original ? INITIAL_REVISION : row.revision
    const parts: string[] = []
    let nextIndex = 0
    let codeUnits = 0
    let invalidChunk: string | undefined
    // Defer errors until iteration resolves because Dexie wraps cursor callbacks
    await this.chunks.where(CHUNK_KIND_INDEX).equals([row.id, kind]).limit(manifest.chunkCount + 1).each(chunk => {
      if (invalidChunk) return
      const expectedLength = Math.min(INSPECTOR_TEXT_CHUNK_CODE_UNITS, manifest.codeUnits - nextIndex * INSPECTOR_TEXT_CHUNK_CODE_UNITS)
      if (chunk.layoutVersion !== DATABASE_LAYOUT_VERSION || chunk.draftId !== row.id || chunk.kind !== kind || chunk.revision !== revision || chunk.index !== nextIndex || typeof chunk.text !== 'string' || chunk.text.length !== expectedLength || checksum(chunk.text) !== manifest.checksums[nextIndex]) {
        invalidChunk = `invalid ${kind} chunk ${nextIndex}`
        return
      }
      nextIndex++
      codeUnits += chunk.text.length
      if (assemble) parts.push(chunk.text)
    })
    if (invalidChunk) inconsistent(invalidChunk)
    if (nextIndex !== manifest.chunkCount || codeUnits !== manifest.codeUnits) inconsistent(`missing ${kind} chunks`)
    return assemble ? parts.join('') : ''
  }

  async get(id: string): Promise<InspectorDraft | undefined> {
    const loaded = await this.database.transaction('r', this.drafts, this.chunks, async () => {
      const row = await this.drafts.get(id)
      if (!row) return undefined
      validateStoredDraft(row)
      await this.validateChunkCount(row)
      const originalText = await this.payload(row, PAYLOAD_KIND.original)
      const draftText = await this.payload(row, PAYLOAD_KIND.draft)
      return { stored: row, draft: { ...summarizeInspectorDraft(row), originalText, draftText } }
    })
    if (!loaded) return undefined
    if (loaded.draft.fileInfo) return loaded.draft
    try {
      const fileInfo = deriveInspectorFileInfo(parseDocument(loaded.draft.draftText), loaded.draft.originalText !== loaded.draft.draftText)
      await this.cacheFileInfo(loaded.stored, fileInfo)
      return { ...loaded.draft, fileInfo }
    } catch {
      // A presentation cache must not prevent access to preserved document text
      return loaded.draft
    }
  }

  private async cacheFileInfo(snapshot: StoredDraft, fileInfo: InspectorFileInfo): Promise<void> {
    try {
      await this.database.transaction('rw', this.drafts, async () => {
        const current = await this.drafts.get(snapshot.id)
        if (!current || current.revision !== snapshot.revision || readInspectorFileInfo(current.fileInfo)) return
        const cacheVersion = (current.fileInfo as { schemaVersion?: unknown } | undefined)?.schemaVersion
        if (typeof cacheVersion === 'number' && cacheVersion > INSPECTOR_FILE_INFO_SCHEMA_VERSION) return
        const matches = (left: PayloadManifest, right: PayloadManifest) => left.codeUnits === right.codeUnits && left.chunkCount === right.chunkCount && left.checksums.every((value, index) => value === right.checksums[index])
        if (!matches(current.originalPayload, snapshot.originalPayload) || !matches(current.draftPayload, snapshot.draftPayload)) return
        await this.drafts.put({ ...current, fileInfo })
      })
    } catch {
      // Optional cache writes do not affect read usability
    }
  }

  async import(filename: string, text: string, referenceId: string): Promise<InspectorDraft> {
    const document = parseDocument(text)
    const now = new Date().toISOString()
    const row: InspectorDraft = { schemaVersion: DOCUMENT_SCHEMA_VERSION, id: crypto.randomUUID(), filename, fileInfo: deriveInspectorFileInfo(document, false), originalText: text, draftText: text, referenceId, createdAt: now, updatedAt: now, revision: INITIAL_REVISION }
    const manifest = manifestFor(text)
    await this.database.transaction('rw', this.drafts, this.chunks, async () => {
      await this.drafts.add(storedDraft(row, manifest, manifest))
      await writeChunks(this.chunks, row.id, PAYLOAD_KIND.original, text, INITIAL_REVISION)
      await writeChunks(this.chunks, row.id, PAYLOAD_KIND.draft, text, INITIAL_REVISION)
    })
    return row
  }

  private async requireRevision(id: string, expectedRevision: number): Promise<StoredDraft> {
    const row = await this.drafts.get(id)
    if (!row) throw new Error('This inspector draft no longer exists; reload the draft list')
    validateStoredDraft(row)
    if (row.revision !== expectedRevision) throw new Error('This inspector draft changed in another tab; reload it before saving or deleting')
    return row
  }

  async save(id: string, draftText: string, expectedRevision: number): Promise<InspectorDraft> {
    const document = parseDocument(draftText)
    const manifest = manifestFor(draftText)
    return this.database.transaction('rw', this.drafts, this.chunks, async () => {
      const row = await this.requireRevision(id, expectedRevision)
      if (row.revision === Number.MAX_SAFE_INTEGER) throw new Error('Inspector draft revision limit reached; download the original and draft before importing a new copy')
      await this.validateChunkCount(row)
      const originalText = await this.payload(row, PAYLOAD_KIND.original)
      await this.payload(row, PAYLOAD_KIND.draft, false)
      const updated: StoredDraft = { ...row, fileInfo: deriveInspectorFileInfo(document, originalText !== draftText), draftPayload: manifest, revision: row.revision + 1, updatedAt: new Date().toISOString() }
      // Replacement chunks and their manifest share the revision check and transaction
      // A failed chunk write must leave the previous draft readable with its original payload intact
      await this.chunks.where(CHUNK_KIND_INDEX).equals([id, PAYLOAD_KIND.draft]).delete()
      await writeChunks(this.chunks, id, PAYLOAD_KIND.draft, draftText, updated.revision)
      await this.drafts.put(updated)
      return { ...summarizeInspectorDraft(updated), originalText, draftText }
    })
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    await this.database.transaction('rw', this.drafts, this.chunks, async () => {
      await this.requireRevision(id, expectedRevision)
      await this.chunks.where(CHUNK_DRAFT_INDEX).equals(id).delete()
      await this.drafts.delete(id)
    })
  }

  close(): void {
    this.database.close()
  }
}

let defaultStorage: InspectorStorage | undefined

export function getInspectorStorage(): InspectorStorage {
  defaultStorage ??= new InspectorStorage()
  return defaultStorage
}
