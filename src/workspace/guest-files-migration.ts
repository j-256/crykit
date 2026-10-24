import Dexie, { type Transaction } from 'dexie'
import { z } from 'zod'
import type { getSodium } from '../account/crypto/sodium'
import { blobIdentity, BLOB_CHUNK_BYTES } from './blobs'
import { GUEST_EVIDENCE_STORES, GUEST_FILES_V1_STORES } from './guest-evidence'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema, WorkspaceAssetSchema, WorkspaceBlobRefSchema, WorkspaceConflictSchema, WorkspaceRetainedContentSchema, LibraryDefaultsSchema } from './file-schemas'
import { GUEST_BARRIER_KEY } from './guest-barrier'

const rowSchema = z.strictObject({ key: z.string(), value: z.unknown() })
const schemas = { editorDocuments: EditorWorkspaceDocumentSchema, saveDocuments: SaveWorkspaceDocumentSchema, assets: WorkspaceAssetSchema, conflicts: WorkspaceConflictSchema, retainedContent: WorkspaceRetainedContentSchema }

export async function inspectGuestFilesSchema(name: string): Promise<void> {
  if (!await Dexie.exists(name)) return
  const source = new Dexie(name)
  try {
    await source.open()
    if (![1, 2].includes(source.verno)) throw new Error('Unsupported guest files version')
    const expected = source.verno === 1 ? GUEST_FILES_V1_STORES : { ...GUEST_FILES_V1_STORES, ...GUEST_EVIDENCE_STORES }
    if (JSON.stringify(source.tables.map(table => table.name).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error('Unsupported guest files stores')
    for (const table of source.tables) {
      const definition = [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', ').replaceAll(' ', '')
      if (definition !== expected[table.name as keyof typeof expected].replaceAll(' ', '')) throw new Error('Unsupported guest files schema')
    }
  } finally { source.close() }
}

// Validation runs against the very rows being upgraded, with no crypto initialization or live-source reads
// All source changes and the explicit empty graph therefore share IndexedDB's versionchange rollback
export async function validateLegacyGuestFiles(transaction: Transaction, sodium: Awaited<ReturnType<typeof getSodium>>): Promise<void> {
  const tables = [...transaction.idbtrans.db.objectStoreNames].sort()
  if (JSON.stringify(tables) !== JSON.stringify([...Object.keys(GUEST_FILES_V1_STORES), ...Object.keys(GUEST_EVIDENCE_STORES)].sort())) throw new Error('Unsupported legacy files stores')
  const documents = await transaction.table('documents').toArray()
  for (const row of documents) {
    const document = rowSchema.parse(row)
    if (document.key === 'libraryDefaults') LibraryDefaultsSchema.parse(document.value)
    else {
      const identity: unknown = JSON.parse(document.key)
      if (!Array.isArray(identity) || identity.length !== 2 || typeof identity[0] !== 'string' || !(identity[0] in schemas) || typeof identity[1] !== 'string') throw new Error('Unsupported legacy file record')
      const parsed = schemas[identity[0] as keyof typeof schemas].parse(document.value)
      if (parsed.id !== identity[1]) throw new Error('Invalid legacy file identity')
    }
  }
  const meta = await transaction.table('meta').toArray()
  // Retired participants cannot use a versionchange transaction to bypass the write barrier
  if (meta.length) throw new Error(meta.some(row => row.key === GUEST_BARRIER_KEY) ? 'The guest files participant is retired or blocked' : 'Unsupported legacy files metadata')
  let chunks = 0
  for (const key of await transaction.table('blobs').toCollection().primaryKeys()) {
    const row = z.strictObject({ key: z.string(), ref: WorkspaceBlobRefSchema }).parse(await transaction.table('blobs').get(key))
    if (row.key !== key || key !== blobIdentity(row.ref)) throw new Error('Invalid legacy blob identity')
    const state = sodium.crypto_hash_sha256_init()
    let finalized = false
    try {
      let index = 0, length = 0
      while (length < row.ref.byteLength) {
        const chunk = z.strictObject({ key: z.string(), index: z.number().int().nonnegative().safe(), bytes: z.instanceof(Uint8Array) }).parse(await transaction.table('chunks').get([key, index]))
        if (chunk.key !== key || chunk.index !== index || !chunk.bytes.length || chunk.bytes.length > BLOB_CHUNK_BYTES || length + chunk.bytes.length > row.ref.byteLength) throw new Error('Invalid legacy native chunk')
        sodium.crypto_hash_sha256_update(state, chunk.bytes); length += chunk.bytes.length; index++; chunks++
      }
      const digest = sodium.crypto_hash_sha256_final(state, 'hex'); finalized = true
      if (digest !== row.ref.sha256) throw new Error('Invalid legacy native body digest')
    } finally {
      if (!finalized) {
        const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
        const address = state as unknown as number
        raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address)
      }
    }
  }
  if (chunks !== await transaction.table('chunks').count()) throw new Error('Orphan or trailing legacy chunks')
}
