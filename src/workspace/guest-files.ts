import Dexie, { type Table, type PromiseExtended } from 'dexie'
import type { WorkspaceState, WorkspaceBlobRef, BlobSource } from './documents'
import { blobIdentity, BLOB_CHUNK_BYTES } from './blobs'
import { installGuestWriteBarrier } from './guest-barrier'
import { prepareFreshGuestTargetOpening, prepareRequiredGuestTargetOpening } from './fresh-guest-target'

import { getSodium } from '../account/crypto/sodium'
import { GUEST_FILES_V1_STORES, GUEST_EVIDENCE_STORES, prepareEmptyGuestEvidence, readGuestEvidence, databaseEvidenceRows, GuestExtensionsSchema, writeGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { inspectGuestFilesSchema, validateLegacyGuestFiles } from './guest-files-migration'

type FileState = Pick<WorkspaceState, 'editorDocuments' | 'saveDocuments' | 'assets' | 'libraryDefaults' | 'conflicts' | 'retainedContent'>
const GUEST_FILES_NATIVE_VERSION = 20
export class GuestFilesDatabase extends Dexie {
  documents!: Table<{ key: string; value: unknown }, string>
  blobs!: Table<{ key: string; ref: WorkspaceBlobRef }, string>
  chunks!: Table<{ key: string; index: number; bytes: Uint8Array }, [string, number]>
  meta!: Table<{ key: string; value: string }, string>
  private opening?: PromiseExtended<Dexie>
  private upgradeBlocked = false
  private preparing?: Promise<void>
  private emptyEvidence?: Awaited<ReturnType<typeof prepareEmptyGuestEvidence>>
  private sodium?: Awaited<ReturnType<typeof getSodium>>
  private readonly requiredGuestTarget: boolean
  constructor(name: string, options: { readonly freshGuestTarget?: true; readonly requiredGuestTarget?: true } = {}) {
    if (options.freshGuestTarget && options.requiredGuestTarget) throw new Error('A files target cannot be fresh and selected at once')
    const opening = options.freshGuestTarget ? prepareFreshGuestTargetOpening(name, GUEST_FILES_NATIVE_VERSION)
      : options.requiredGuestTarget ? prepareRequiredGuestTargetOpening(name, GUEST_FILES_NATIVE_VERSION, { ...GUEST_FILES_V1_STORES, ...GUEST_EVIDENCE_STORES }) : undefined
    super(name, opening?.dependencies)
    opening?.attach(this)
    this.requiredGuestTarget = options.requiredGuestTarget === true
    this.version(1).stores(GUEST_FILES_V1_STORES)
    const populate = (transaction: import('dexie').Transaction) => {
      if (!this.emptyEvidence) throw new Error('Guest evidence initialization is unavailable')
      // Dexie's populate event follows Dexie promises, not a discarded native async callback rejection
      return Dexie.Promise.all(this.emptyEvidence.map(({ table, row }) => transaction.table(table).add(row))).then(() => {})
    }
    this.version(2).stores(GUEST_EVIDENCE_STORES).upgrade(async transaction => {
      if (this.upgradeBlocked) throw new Error('Guest files upgrade was blocked')
      if (!this.sodium) throw new Error('Guest migration validation is unavailable')
      await validateLegacyGuestFiles(transaction, this.sodium)
      await populate(transaction)
    })
    this.on('populate', populate)
    installGuestWriteBarrier(this)
  }
  override open(): PromiseExtended<Dexie> {
    if (this.upgradeBlocked) return Dexie.Promise.reject(new Error('Guest files upgrade was blocked. Reopen the workspace after closing the other tab.'))
    if (this.isOpen()) return super.open()
    if (this.opening) return this.opening
    // Dexie's implicit table transactions call this same open method
    // Prepare crypto and immutable empty rows before entering the native upgrade transaction
    this.preparing ??= this.requiredGuestTarget ? Promise.resolve() : (async () => { await inspectGuestFilesSchema(this.name); this.sodium = await getSodium(); this.emptyEvidence = await prepareEmptyGuestEvidence() })()
    this.opening = Dexie.Promise.resolve(this.preparing).then(() => new Dexie.Promise<Dexie>((resolve, reject) => {
      // Closing a blocked handle does not cancel its native request; prevent any delayed upgrade commit
      const blocked = () => { this.upgradeBlocked = true; this.close(); reject(new Error('Guest files upgrade is blocked by another tab. Close that tab and retry.')) }
      this.on('blocked', blocked)
      super.open().then(resolve, reject).finally(() => { this.on.blocked.unsubscribe(blocked) })
    })).finally(() => { this.opening = undefined })
    return this.opening
  }
}
export async function writeGuestFiles(database: GuestFilesDatabase, state: WorkspaceState, evidence: CapturedGuestEvidence, stage: import('./guest-evidence').GuestEvidenceStageWriter = {
  put: (table, row) => database.table(table).add(row),
  clear: table => database.table(table).clear(),
  delete: (table, key) => database.table(table).delete(key),
}): Promise<void> {
  const sources = new Set(state.planner.sources.map(source => blobIdentity(source.original)))
  for (const blob of state.blobs) {
    if (sources.has(blobIdentity(blob.ref))) continue
    const key = blobIdentity(blob.ref)
    let index = 0, length = 0
    for await (const bytes of blob.content.open()) {
      for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
        const part = bytes.slice(offset, offset + BLOB_CHUNK_BYTES)
        length += part.length
        await stage.put('chunks', { key, index: index++, bytes: part })
      }
    }
    if (length !== blob.ref.byteLength) throw new Error('Guest file staging length mismatch')
    await stage.put('blobs', { key, ref: blob.ref })
  }
  for (const field of ['editorDocuments', 'saveDocuments', 'assets', 'conflicts', 'retainedContent'] as const) for (const value of state[field]) await stage.put('documents', { key: JSON.stringify([field, value.id]), value })
  await stage.put('documents', { key: 'libraryDefaults', value: state.libraryDefaults })
  await writeGuestEvidence(database, evidence, stage)
}
export async function readGuestFiles(database: GuestFilesDatabase, assertCurrent: () => Promise<void>): Promise<FileState & Pick<WorkspaceState, 'blobs'>> {
  await assertCurrent()
  await database.open()
  await readGuestEvidence(databaseEvidenceRows(database), assertCurrent)
  const captured = await database.transaction('r', database.documents, database.blobs, async () => ({ documents: await database.documents.toArray(), blobs: await database.blobs.toArray() }))
  const state: FileState = { editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] }
  for (const document of captured.documents) {
    if (document.key === 'workspaceExtensions') { GuestExtensionsSchema.parse(document.value); continue }
    if (document.key === 'libraryDefaults') (state as { libraryDefaults: FileState['libraryDefaults'] }).libraryDefaults = document.value as FileState['libraryDefaults']
    else {
      const [field, id] = JSON.parse(document.key) as [keyof FileState, string]
      if (field === 'libraryDefaults' || !(field in state) || (document.value as { id?: string }).id !== id) throw new Error('Unsupported guest file record')
      ;(state[field] as unknown[]).push(document.value)
    }
  }
  const blobs = captured.blobs.map(({ key, ref }) => ({ ref, content: {
    byteLength: ref.byteLength,
    async *open() {
      await assertCurrent()
      let length = 0, index = 0
      while (length < ref.byteLength) {
        const chunk = await database.chunks.get([key, index++])
        await assertCurrent()
        if (!chunk || !chunk.bytes.length || length + chunk.bytes.length > ref.byteLength) throw new Error('Guest file body is incomplete')
        length += chunk.bytes.length; yield chunk.bytes
      }
      if (await database.chunks.get([key, index])) throw new Error('Guest file body has trailing chunks')
      await assertCurrent()
    },
  } satisfies BlobSource }))
  await assertCurrent()
  return { ...state, blobs }
}
