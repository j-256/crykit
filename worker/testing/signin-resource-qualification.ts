import { assertActiveProfile, currentProfileToken } from '../../src/account/profile'
import { AccountDatabase } from '../../src/persistence/account-database'
import { seedManagedWorkspace } from '../../src/persistence/managed-sync.test-helpers'
import { createBlankLocalData } from '../../src/domain/local-data'
import { memoryBlob, hashBlob } from '../../src/workspace/blobs'
import { sha256 } from '../../src/interchange/util'
import { encodeBytes, getSodium } from '../../src/account/crypto/sodium'
import { createAccountLocalStore } from '../../src/workspace/account-local-store'
import { admitLocalRoot } from '../../src/workspace/local-root'
import { readLocalEvidence } from '../../src/workspace/local-evidence'
import { readIncrementalMappedRoot } from '../../src/workspace/account-local-mapping'
import { openAccountWorkspace } from '../../src/workspace/account-graph'
import { openAccountInheritedEvidence } from '../../src/workspace/account-evidence-snapshots'
import type { CipherRef } from '../../src/persistence/account-database'
import { z } from 'zod'
import { CipherRefSchema } from '../../src/workspace/account-cache'
import { readSyncState } from '../../src/account/sync/outbox'
import { RemoteStateSchema, readRemoteHeads } from '../../src/account/sync/pull'
import { readPublicationPages } from '../../src/account/sync/projection'
import { publicationPageSchema } from '../../src/account/sync/publication'
import { sameCipherRefs } from '../../src/workspace/account-retaining'

const RESOURCE_BODY_BYTES = 64 * 1024 * 1024
const RESOURCE_BODY_PAGE_BYTES = 64 * 1024
const RESOURCE_BODY_ID = 'synthetic-resource-original'
const RESOURCE_SYNC_ROWS = ['remote', 'projection'] as const
const EffectiveUnitPageSchema = publicationPageSchema(z.strictObject({ key: z.string(), body: CipherRefSchema, publication: CipherRefSchema }), 'local-effective-units')

// Retry runs ordinary sync before presenting fresh choices, which can relocate encrypted cache pages
// Only those page addresses are resolved away; all authority fields and body/publication refs stay exact
export async function resourceProjectionAuthority() {
  const token = currentProfileToken()
  if (!token) throw new Error('Resource authority requires an active account')
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  const capture = async () => ({ selected: await database.profileMeta.get('active'), rows: await database.syncState.bulkGet([...RESOURCE_SYNC_ROWS]) })
  try {
    const before = await capture()
    if (!before.selected || before.rows.some(row => !row)) throw new Error('Missing resource sync authority')
    const authority = []
    for (const [index, id] of RESOURCE_SYNC_ROWS.entries()) {
      const captured = await readSyncState(database, token, id, RemoteStateSchema)
      if (!captured || JSON.stringify(captured.row) !== JSON.stringify(before.rows[index])) throw new Error('Resource sync authority changed during readback')
      const { heads, effective, ...fields } = captured.value
      const record = await database.encryptedRevisions.get(captured.row.ref.revisionId)
      const expected = [heads, ...(effective ? [effective.control, effective.units] : [])]
      if (!record || record.descriptor.accountId !== token.accountId || record.descriptor.documentId !== captured.row.ref.documentId || record.descriptor.revisionId !== captured.row.ref.revisionId || !sameCipherRefs(record.descriptor.dependencies, expected)) throw new Error('Resource sync header association changed')
      const decodedHeads = [...await readRemoteHeads(database, token, heads)].sort(([left], [right]) => left.localeCompare(right))
      if (effective) {
        const units = await readPublicationPages(database, token, effective.units, EffectiveUnitPageSchema, entry => [entry.body, entry.publication])
        if (new Set(units.map(unit => unit.key)).size !== units.length) throw new Error('Duplicate resource effective unit')
        authority.push({ id, ...fields, heads: decodedHeads, effective: { lineageId: effective.lineageId, control: effective.control, units: units.sort((left, right) => left.key.localeCompare(right.key)) } })
      } else authority.push({ id, ...fields, heads: decodedHeads })
    }
    // A valid decoded header is not a coherent observation if its selected fence or pointer changed
    if (JSON.stringify(await capture()) !== JSON.stringify(before)) throw new Error('Resource sync authority changed during readback')
    assertActiveProfile(token)
    return { ...before, authority }
  } finally { database.close() }
}

// Seed only fresh synthetic storage; ordinary mapping must create the second physical representation
// The large original is current-only so Merge never stages a large guest evidence archive
export async function seedCurrentOnlyResourceDestination() {
  const token = currentProfileToken()!, database = new AccountDatabase(token.accountId)
  try {
    if (await database.profileMeta.get('active')) throw new Error('Resource fixture requires fresh account storage')
    const bytes = new Uint8Array(RESOURCE_BODY_BYTES)
    for (let offset = 0; offset < bytes.length; offset += RESOURCE_BODY_PAGE_BYTES) bytes[offset] = offset / RESOURCE_BODY_PAGE_BYTES % 251
    const ref = { documentId: RESOURCE_BODY_ID, revisionId: `${RESOURCE_BODY_ID}:1`, byteLength: bytes.length, sha256: await sha256(bytes), encoding: 'bytes' as const }
    const localData = createBlankLocalData()
    await seedManagedWorkspace(database, token, {
      planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] },
      editorDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [{ ref, content: memoryBlob(bytes) }],
      saveDocuments: [{ version: 1, id: 'resource-save', revision: 0, filename: 'Synthetic resource original.dat', original: ref, working: ref, pendingForm: null, requirements: [], coverage: { status: 'unsupported', diagnostics: ['Synthetic opaque original'] }, createdAt: localData.createdAt, updatedAt: localData.updatedAt, exportedRevision: null }],
    })
    return ref
  } finally { database.close() }
}

// Read-only evidence binds the selected local root to its actual installed native mapping
// Full body hashes and authenticated reads precede any descriptor-size inference
export async function currentOnlyResourceEvidence() {
  const token = currentProfileToken()!, database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  let inherited: Awaited<ReturnType<typeof openAccountInheritedEvidence>> | undefined
  try {
    const selected = (await database.profileMeta.get('active'))!
    if (!selected) throw new Error('Missing selected resource destination')
    const local = await admitLocalRoot(store.adapter, selected.head, store.lifetime)
    if (await readLocalEvidence(store.adapter, local.root.inheritedEvidence, async () => assertActiveProfile(token))) throw new Error('Resource destination must not have local inherited originals')
    const mapped = await readIncrementalMappedRoot(database, token, selected)
    if (!mapped) throw new Error('Resource destination needs its installed native mapping')
    const native = await openAccountWorkspace(database, token, mapped)
    if (native.inheritedEvidence) {
      inherited = await openAccountInheritedEvidence(database, token, native.inheritedEvidence)
      if (inherited.members.length) throw new Error('Resource destination must not have native inherited originals')
    }
    const physical = async (state: typeof local.state, entries: readonly { kind: string; ref: CipherRef }[]) => {
      if (state.planner.catalogs.length || state.retainedContent.length || state.blobs.length !== 1 || state.saveDocuments.length !== 1) throw new Error('Unexpected resource destination closure')
      const body = state.blobs[0], file = state.saveDocuments[0]
      if (body.ref.documentId !== RESOURCE_BODY_ID || body.ref.byteLength !== RESOURCE_BODY_BYTES || JSON.stringify(file.original) !== JSON.stringify(body.ref) || JSON.stringify(file.working) !== JSON.stringify(body.ref)) throw new Error('Resource original association changed')
      const digest = await hashBlob(body.content)
      if (digest !== body.ref.sha256) throw new Error('Resource original bytes changed')
      const blobs = entries.filter(entry => entry.kind === 'blob')
      if (blobs.length !== 1) throw new Error('Resource body must have one current physical frame')
      const ref = blobs[0].ref, record = await database.encryptedRevisions.get(ref.revisionId)
      if (!record || record.descriptor.documentId !== ref.documentId) throw new Error('Resource body frame is not installed')
      const chunks = await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).sortBy('index')
      if (chunks.length !== record.descriptor.chunks.length) throw new Error('Resource frame is incomplete')
      const sodium = await getSodium()
      const observed = await Promise.all(chunks.map(async (chunk, index) => {
        const expected = record.descriptor.chunks[index]
        if (chunk.index !== index || chunk.bytes.length !== expected.cipherBytes || encodeBytes(sodium, sodium.crypto_hash_sha256(chunk.bytes)) !== expected.cipherDigest) throw new Error('Resource frame chunk changed')
        return { index, byteLength: chunk.bytes.length, sha256: await sha256(chunk.bytes) }
      }))
      return { original: body.ref, digest, frame: ref, record, chunks: observed, cipherBytes: observed.reduce((sum, chunk) => sum + chunk.byteLength, 0) }
    }
    const localBody = await physical(local.state, local.entries), nativeBody = await physical(native.state, native.entries)
    if (localBody.frame.revisionId === nativeBody.frame.revisionId || localBody.record.payloadId === nativeBody.record.payloadId) throw new Error('Resource fixture requires distinct physical current representations')
    if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(selected)) throw new Error('Resource selected head changed during readback')
    await inherited?.check(); assertActiveProfile(token)
    return { selected, mapped, localInheritedEmpty: true, nativeInheritedEmpty: true, localBody, nativeBody, distinctBodyCipherBytes: localBody.cipherBytes + nativeBody.cipherBytes }
  } finally { await inherited?.dispose(); await store.dispose(); database.close() }
}
