import { assertActiveProfile, captureGuestWorkspaceEpoch, profileSignal, type ProfileToken } from '../../src/account/profile'
import { AccountDatabase, type AccountFence } from '../../src/persistence/account-database'
import { GuestCoordinatorDatabase } from '../../src/workspace/guest-coordinator'
import { createAccountLocalStore } from '../../src/workspace/account-local-store'
import { createGuestLocalStore } from '../../src/workspace/guest-local-store'
import { admitLocalRoot, LocalWorkspaceRootV3Schema, type LocalRecordRef, type LocalStoreAdapter, type LocalWorkspaceEntry } from '../../src/workspace/local-root'
import { GuestManagedManifestSchema } from '../../src/workspace/guest-managed-contract'
import { readLocalIndex } from '../../src/workspace/local-index'
import { decodeWorkspaceDocument } from '../../src/workspace/document-codec'
import { blobIdentity, hashBlob, readBlob } from '../../src/workspace/blobs'
import { isBlobSource, privateRecordKey, type WorkspaceBlobRef, type WorkspaceDocumentKind } from '../../src/workspace/documents'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema } from '../../src/workspace/file-schemas'
import { decodeCrystalSave } from '../../src/interchange/crystal-save'
import { decodeEditorText } from '../../src/workspace/editor-document'
import { PERFORMANCE_EDITOR_ID, PERFORMANCE_SAVE_ID } from './local-save-workload'

type OracleStorage = { adapter: LocalStoreAdapter } & ({ account: AccountDatabase } | { guest: GuestCoordinatorDatabase })

async function withOracleStorage<T>(token: ProfileToken | undefined, read: (storage: OracleStorage) => Promise<T>, checkGuest = () => {}) {
  if (token) {
    const account = new AccountDatabase(token.accountId), store = createAccountLocalStore(account, token)
    try { return await read({ adapter: store.adapter, account }) }
    finally { await store.dispose(); account.close() }
  }
  const guest = new GuestCoordinatorDatabase(), store = createGuestLocalStore(guest, checkGuest)
  try { return await read({ adapter: store.adapter, guest }) }
  finally { guest.close() }
}

export function selected<T>(token: ProfileToken | undefined, read: (adapter: LocalStoreAdapter, head: LocalRecordRef, account?: AccountDatabase) => Promise<T>) {
  return withOracleStorage(token, async storage => {
    const { adapter } = storage
    if ('account' in storage) {
      const { account } = storage
      const before = await account.profileMeta.get('active')
      if (!before) throw new Error('Missing selected account head')
      const result = await read(adapter, before.head, account)
      if (JSON.stringify(await account.profileMeta.get('active')) !== JSON.stringify(before)) throw new Error('Account head changed during oracle')
      return result
    }
    const { guest } = storage
    const before = await guest.active.get('active')
    const manifest = GuestManagedManifestSchema.parse(before?.manifest)
    const result = await read(adapter, manifest.root)
    if (JSON.stringify(await guest.active.get('active')) !== JSON.stringify(before)) throw new Error('Guest head changed during oracle')
    return result
  })
}

// Each untimed oracle reads actual durable bytes through the real storage authentication and codecs
// It neither reads the rendered draft nor uses a previous in-memory admission as storage-health evidence
function inspectStored(kind: 'planner' | 'save' | 'editor', editorId = PERFORMANCE_EDITOR_ID) {
  return async (adapter: LocalStoreAdapter, head: LocalRecordRef, account?: AccountDatabase) => {
    const json = async (ref: typeof head) => JSON.parse(new TextDecoder().decode(await readBlob(await adapter.read(ref), 512 * 1024 * 1024)))
    const root = LocalWorkspaceRootV3Schema.parse(await json(head))
    const index = await readLocalIndex<LocalWorkspaceEntry>(root.contentIndex, json)
    const records = await bodyRecords(index.entries, account)
    const document = async (entry: LocalWorkspaceEntry) => {
      const source = await adapter.read(entry.ref)
      if (await hashBlob(source) !== entry.digest) throw new Error('Oracle document digest mismatch')
      return decodeWorkspaceDocument(source)
    }
    const find = async (type: WorkspaceDocumentKind, id: string) => {
      const entry = index.entries.find(value => value.key === privateRecordKey(type, id))
      if (!entry) throw new Error('Missing oracle document')
      return (await document(entry)).value
    }
    const body = async (ref: WorkspaceBlobRef) => {
      const value = await find('blob', blobIdentity(ref))
      if (!isBlobSource(value)) throw new Error('Missing oracle body')
      return readBlob(value, ref.byteLength)
    }
    if (kind === 'save') {
      const file = SaveWorkspaceDocumentSchema.parse(await find('save', PERFORMANCE_SAVE_ID))
      const native = decodeCrystalSave(await body(file.working))
      return { file, native, records }
    }
    if (kind === 'editor') {
      const file = EditorWorkspaceDocumentSchema.parse(await find('editor', editorId))
      return { file, applied: decodeEditorText(await body(file.lastApplied)), unfinished: decodeEditorText(await body(file.unfinished.text)), records }
    }
    // Per-save assertions consume checkpoints and progress; unrelated Builds are admitted by full()
    // Reading every Build here repeats unrelated encrypted payload work between measured operations
    const values = await Promise.all(index.entries.filter(entry => ['build-checkpoint', 'progress'].includes(entry.kind)).map(document))
    return { revision: root.localRevision, values, records }
  }
}

export function inspect(token: ProfileToken | undefined, kind: 'planner' | 'save' | 'editor', editorId?: string) {
  return selected(token, inspectStored(kind, editorId))
}

// Enqueue in the readiness turn on a connection opened in setup, before a later pending-form write
// A success event alone does not establish a completed read transaction
function readActiveFence(database: IDBDatabase, table: string) {
  return new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(table, 'readonly')
    const request = transaction.objectStore(table).get('active')
    transaction.oncomplete = () => resolve(request.result as unknown)
    transaction.onabort = () => reject(new Error('Save Apply fence read aborted', { cause: transaction.error }))
  })
}

export async function openAppliedSaveOracle(token: ProfileToken | undefined) {
  const profile = token
    ? { assertCurrent: () => assertActiveProfile(token), signal: profileSignal(token) }
    : captureGuestWorkspaceEpoch()
  const database = token ? new AccountDatabase(token.accountId) : new GuestCoordinatorDatabase()
  try {
    await database.open()
    profile.assertCurrent()
  } catch (error) {
    database.close()
    throw error
  }
  const native = database.backendDB()
  const table = database instanceof AccountDatabase ? database.profileMeta.name : database.active.name
  type FenceRead = Promise<{ row: unknown } | { error: unknown }>
  let sequence = 0, closed = false
  let attempt: { readonly id: number; fence?: FenceRead | 'consumed' } | undefined

  const close = () => {
    if (closed) return
    closed = true
    attempt = undefined
    profile.signal.removeEventListener('abort', close)
    database.close()
  }
  profile.signal.addEventListener('abort', close, { once: true })
  const requireOpen = () => {
    profile.assertCurrent()
    if (closed) throw new Error('Save Apply oracle is closed')
  }
  const requireAttempt = (id: number) => {
    requireOpen()
    if (attempt?.id !== id) throw new Error('Stale Save Apply attempt')
    return attempt
  }
  return {
    begin() {
      requireOpen()
      attempt = { id: ++sequence }
      return attempt.id
    },
    capture(id: number) {
      const owned = requireAttempt(id)
      if (owned.fence) return
      // Hold failures for the untimed oracle so an aborted request cannot produce an unhandled rejection
      owned.fence = readActiveFence(native, table).then(row => ({ row }), error => ({ error }))
    },
    async read(id: number) {
      const owned = requireAttempt(id)
      if (!owned.fence || owned.fence === 'consumed') throw new Error('Missing Save Apply fence capture')
      const fence = owned.fence
      owned.fence = 'consumed'
      const captured = await fence
      requireAttempt(id)
      if ('error' in captured) throw captured.error
      const inspectSave = inspectStored('save')
      // Only the captured storage row supplies a root; each immutable record is authenticated afresh
      const result = await withOracleStorage(token, storage => {
        if ('account' in storage) {
          const row = captured.row as AccountFence | undefined
          if (!row?.head) throw new Error('Missing captured account head')
          return inspectSave(storage.adapter, row.head, storage.account)
        }
        const row = captured.row as { manifest: unknown } | undefined
        const manifest = GuestManagedManifestSchema.parse(row?.manifest)
        return inspectSave(storage.adapter, manifest.root)
      }, profile.assertCurrent)
      requireAttempt(id)
      return result
    },
    close,
  }
}

type AppliedSaveOracle = Awaited<ReturnType<typeof openAppliedSaveOracle>>
export interface SaveApplyProof {
  beginSaveApply(): number
  captureSaveApply: AppliedSaveOracle['capture']
  inspectSaveApply: AppliedSaveOracle['read']
}

async function bodyRecords(entries: readonly LocalWorkspaceEntry[], account?: AccountDatabase) {
  const bodies = entries.filter(entry => entry.kind === 'blob' || entry.kind === 'catalog')
  // One fresh native transaction captures the same immutable identities without opening one transaction per row
  const encrypted = account && await account.encryptedRevisions.bulkGet(bodies.map(entry => entry.ref.revisionId))
  return bodies.map((entry, index) => {
    const record = encrypted && encrypted[index]
    if (account && !record) throw new Error('Missing immutable oracle record')
    return { key: entry.key, kind: entry.kind, ref: entry.ref, digest: entry.digest, storageId: record ? record.payloadId : entry.ref.revisionId }
  })
}

export function full(token: ProfileToken | undefined) {
  // Complete restart admission remains separate from the small per-operation readback
  return selected(token, async (adapter, head, account) => {
    const loaded = await admitLocalRoot(adapter, head, { check() {}, async assertCurrent() {} })
    // Authenticate the complete workspace before returning only the asserted planner observation
    // Sending unused catalogs through the browser protocol duplicates their decoded graph in the controller
    return { planner: { history: loaded.state.planner.history }, editorDocuments: loaded.state.editorDocuments, saveDocuments: loaded.state.saveDocuments, records: await bodyRecords(loaded.entries, account), blobs: await Promise.all(loaded.state.blobs.map(async value => ({ ref: value.ref, digest: await hashBlob(value.content) }))) }
  })
}
