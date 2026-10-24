import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../src/App'
import { WorkspaceProvider, useWorkspace } from '../../src/ui/WorkspaceProvider'
import { ErrorBoundary } from '../../src/ui/ErrorBoundary'
import { installProfile, type ProfileToken } from '../../src/account/profile'
import { getSodium } from '../../src/account/crypto/sodium'
import { accountLocalId, openAccountJson } from '../../src/workspace/account-cache'
import { IncrementalWorkspaceIntentSchema } from '../../src/workspace/account-managed-repository'
import { mapIncrementalAccountIntent } from '../../src/workspace/account-local-mapping-client'
import { createPersonalDefinition } from '../../src/domain'
import { AccountDatabase, activateLocalAccountCommit } from '../../src/persistence/account-database'
import { GuestManagedManifestSchema } from '../../src/workspace/guest-managed-contract'
import { GuestCoordinatorDatabase } from '../../src/workspace/guest-coordinator'
import { createAccountLocalStore } from '../../src/workspace/account-local-store'
import { createGuestLocalStore } from '../../src/workspace/guest-local-store'
import { admitLocalRoot, LocalWorkspaceRootV3Schema, prepareLocalWorkspace, type LocalStoreAdapter, type LocalWorkspaceEntry } from '../../src/workspace/local-root'
import { readLocalIndex } from '../../src/workspace/local-index'
import { decodeWorkspaceDocument } from '../../src/workspace/document-codec'
import { blobIdentity, hashBlob, readBlob } from '../../src/workspace/blobs'
import { isBlobSource, privateRecordKey, type WorkspaceBlobRef, type WorkspaceDocumentKind } from '../../src/workspace/documents'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema } from '../../src/workspace/file-schemas'
import { decodeCrystalSave } from '../../src/interchange/crystal-save'
import { decodeEditorText } from '../../src/workspace/editor-document'
import { localSaveWorkload, PERFORMANCE_EDITOR_ID, PERFORMANCE_SAVE_ID } from './local-save-workload'
import '../../src/styles.css'

// This entry is built only into excluded synthetic proof assets, never the public application
// Installed keys model local unlocked storage; they do not represent OPAQUE or service authentication
const parameters = new URL(location.href).searchParams
const mode = parameters.get('mode') === 'account' ? 'account' : 'guest'
const large = parameters.get('size') === 'large'
let token: ProfileToken | undefined
let workspace: ReturnType<typeof useWorkspace> | undefined
let opened = false
let opening: Promise<void> | undefined
let mapping: Promise<void> | undefined
let mappingError: string | undefined

async function queueMapping() {
  if (!token || !workspace?.isCurrent()) throw new Error('An active synthetic account is required')
  const loaded = await workspace.repository.load()
  await workspace.repository.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic queued projection' }), loaded.revision)
}

async function startMapping() {
  if (!token) throw new Error('An active synthetic account is required')
  if (mappingError) throw new Error(mappingError)
  if (mapping) return
  const captured = token, database = new AccountDatabase(captured.accountId)
  const pending = []
  for (const row of await database.outbox.toArray()) if (row.status === 'unmapped-local') {
    pending.push({ row, intent: await openAccountJson(database, captured, row.ref, IncrementalWorkspaceIntentSchema) })
  }
  pending.sort((left, right) => left.intent.sequence - right.intent.sequence)
  if (!pending.length) { database.close(); throw new Error('The benchmark requires queued projection') }
  // Use the actual captured-profile worker and exact outbox CAS, without holding its scheduling units open
  mapping = mapIncrementalAccountIntent(database, captured, pending[0].row).catch(error => { mappingError = String(error) }).finally(() => { database.close(); mapping = undefined })
}

async function selected<T>(read: (adapter: LocalStoreAdapter, head: { documentId: string; revisionId: string }, account?: AccountDatabase) => Promise<T>): Promise<T> {
  if (token) {
    const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
    try {
      const before = await database.profileMeta.get('active')
      if (!before) throw new Error('Missing selected account head')
      const result = await read(store.adapter, before.head, database)
      if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(before)) throw new Error('Account head changed during oracle')
      return result
    } finally { await store.dispose(); database.close() }
  }
  const database = new GuestCoordinatorDatabase(), store = createGuestLocalStore(database, () => {})
  try {
    const before = await database.active.get('active')
    const manifest = GuestManagedManifestSchema.parse(before?.manifest)
    const result = await read(store.adapter, manifest.root)
    if (JSON.stringify(await database.active.get('active')) !== JSON.stringify(before)) throw new Error('Guest head changed during oracle')
    return result
  } finally { database.close() }
}

// Each untimed oracle reads actual durable bytes through the real storage authentication and codecs
// It neither reads the rendered draft nor uses a previous in-memory admission as storage-health evidence
async function inspect(kind: 'planner' | 'save' | 'editor') {
  return selected(async (adapter, head, account) => {
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
      const file = EditorWorkspaceDocumentSchema.parse(await find('editor', PERFORMANCE_EDITOR_ID))
      return { file, applied: decodeEditorText(await body(file.lastApplied)), unfinished: decodeEditorText(await body(file.unfinished.text)), records }
    }
    const values = await Promise.all(index.entries.filter(entry => ['build', 'build-checkpoint', 'progress'].includes(entry.kind)).map(document))
    return { revision: root.localRevision, values, records }
  })
}

async function bodyRecords(entries: readonly LocalWorkspaceEntry[], account?: AccountDatabase) {
  return Promise.all(entries.filter(entry => entry.kind === 'blob' || entry.kind === 'catalog').map(async entry => {
    const record = account && await account.encryptedRevisions.get(entry.ref.revisionId)
    if (account && !record) throw new Error('Missing immutable oracle record')
    return { key: entry.key, kind: entry.kind, ref: entry.ref, digest: entry.digest, storageId: record ? record.payloadId : entry.ref.revisionId }
  }))
}

function Entry() {
  const current = useWorkspace()
  useEffect(() => {
    workspace = current
    if (token && !opening) opening = (async () => {
      // The normal guest opening precedes explicit account activation; finish its bulk admission
      // before measuring account edits so abandoned startup work cannot contaminate ordinary saves
      if (current.repository.kind === 'guest') await current.repository.load()
      await current.openAccount(token!)
      opened = true
    })()
    if (!token && current.repository.kind === 'guest') opened = true
  }, [current])
  return <App/>
}

async function start() {
  const cacheStarted = performance.now()
  if (import.meta.env.PROD) {
    await navigator.serviceWorker.register('./sw.js')
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
  }
  const cachePreparationMs = performance.now() - cacheStarted
  const state = await localSaveWorkload(large), started = performance.now(), operation = accountLocalId()
  if (mode === 'account') {
    token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
    const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
    try {
      const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime)
      await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined))
      store.committed(operation)
    } finally { await store.dispose(); database.close() }
  } else {
    const database = new GuestCoordinatorDatabase(), store = createGuestLocalStore(database, () => {})
    try {
      const prepared = await prepareLocalWorkspace(store.adapter, operation, state, { check() {}, async assertCurrent() {} })
      await store.activate(operation, prepared.head, undefined, () => {})
    } finally { database.close() }
  }
  const setupMs = performance.now() - started
  Object.assign(window, { localSaveProof: {
    setup: { mode, large, setupMs, cachePreparationMs, build: import.meta.env.PROD ? 'compiled' : 'development', origin: location.origin, scripts: [...document.scripts].map(script => script.src) },
    ready: () => opened && !!workspace?.isCurrent(),
    diagnostics: () => ({ kind: workspace?.repository.kind, current: workspace?.isCurrent(), pending: workspace?.fileCommandPending(), editorPhase: workspace?.editorSession.phase, editorDirty: workspace?.editorSession.controller.snapshot().dirty, editorHydrating: !!workspace?.editorSession.hydration, savePhase: workspace?.saveSession.phase, saveDirty: workspace?.saveSession.controller.snapshot().dirty, saveHydrating: !!workspace?.saveSession.hydration }),
    inspect,
    queueMapping, startMapping,
    mapping: () => ({ pending: !!mapping, error: mappingError }),
    // Complete restart admission remains separate from the small per-operation readback
    full: () => selected(async (adapter, head, account) => {
      const loaded = await admitLocalRoot(adapter, head, { check() {}, async assertCurrent() {} })
      // Authenticate the complete workspace before returning only the asserted planner observation
      // Sending unused catalogs through the browser protocol duplicates their decoded graph in the controller
      return { planner: { history: loaded.state.planner.history }, editorDocuments: loaded.state.editorDocuments, saveDocuments: loaded.state.saveDocuments, records: await bodyRecords(loaded.entries, account), blobs: await Promise.all(loaded.state.blobs.map(async value => ({ ref: value.ref, digest: await hashBlob(value.content) }))) }
    }),
    sodium: await getSodium(),
  } })
  createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><WorkspaceProvider><Entry/></WorkspaceProvider></ErrorBoundary></StrictMode>)
}
void start().catch(error => { document.body.textContent = String(error); Object.assign(window, { localSaveFailure: String(error) }) })
