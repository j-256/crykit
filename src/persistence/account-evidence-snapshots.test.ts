import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import type { CipherRecord, CipherRef } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { AccountDatabase } from './account-database'
import { editorClosureFixture } from '../workspace/test-helpers'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup'
import { capturedBackupEvidence, readBackupMetadata, attachBackupBodies } from '../interchange/workspace-backup-evidence'
import { disposeWorkspaceSnapshot, validateWorkspaceSnapshotV1, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { hashBlob, memoryBlob, blobIdentity, readBlob } from '../workspace/blobs'
import * as evidence from '../workspace/account-evidence-snapshots'
import { createAccountCleanupCoordinator } from '../workspace/account-cleanup-attempt'
import { emptyPlannerEvidence, guestEvidenceFromSnapshot } from '../workspace/guest-evidence'

vi.mock('../interchange/workspace-backup-schema', async importOriginal => {
  const actual = await importOriginal<typeof import('../interchange/workspace-backup-schema')>()
  return { ...actual, WORKSPACE_BACKUP_LIMITS: { ...actual.WORKSPACE_BACKUP_LIMITS } }
})
const limits = WORKSPACE_BACKUP_LIMITS as { frames: number; bytes: number; depth: number; payload: number }
const defaultLimits = { ...limits }
const MULTIPAGE_DRAFT_REPEATS = 400_000
const databases: AccountDatabase[] = []
afterEach(async () => { Object.assign(limits, defaultLimits); vi.restoreAllMocks(); invalidateProfile(); for (const database of databases.splice(0)) await database.delete() })
function account() {
  const key = crypto.getRandomValues(new Uint8Array(32)), accountId = accountLocalId()
  const token = installProfile(accountId, key.slice()), database = new AccountDatabase(accountId)
  databases.push(database)
  return { database, token, key }
}
async function pages(source: import('../workspace/documents').BlobSource) {
  const result: Uint8Array[] = []
  for await (const page of source.open()) result.push(page.slice())
  return result
}
async function original(long = false): Promise<WorkspaceSnapshotV1> {
  const fixture = await editorClosureFixture()
  const content = memoryBlob(new TextEncoder().encode('synthetic-private-native-C-marker'))
  const sha256 = await hashBlob(content)
  const aliases = ['zz-alias', 'aa-alias'].map(documentId => ({ ref: { documentId, revisionId: 'same-bytes', encoding: 'bytes' as const, byteLength: content.byteLength, sha256 }, content }))
  const file = { ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { zeta: long ? 'private-C\ud800'.repeat(MULTIPAGE_DRAFT_REPEATS) : 'private-C', alpha: 'last' } } }
  return { version: 1, snapshotId: 'synthetic-C-history', capturedAt: '2026-10-12', revisionVector: {}, state: { ...fixture.state, editorDocuments: [file], blobs: [...aliases, ...fixture.state.blobs] } }
}

it('independently reopens exact original token pages and native subset order under the destination account', async () => {
  expect(typeof evidence.createAccountInheritedEvidencePreparation).toBe('function')
  const { database, token, key } = account(), historical = await original(true)
  const current = await original()
  const snapshot = await inheritWorkspaceSnapshot({ ...current, state: { ...current.state, blobs: current.state.blobs.slice(2) } }, [historical])
  const captured = capturedBackupEvidence(snapshot), expected = await pages([...captured.historical.values()][0])
  expect(expected.length).toBeGreaterThan(1)
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  expect(await database.encryptedRevisions.count()).toBe(0)
  expect(await database.profileMeta.count()).toBe(0)
  expect(prepared.handle.origin).toBe('evidence-v1')
  expect(prepared.handle.members).toEqual(snapshot.historicalEvidence.snapshots)
  const persisted = JSON.stringify([prepared.records, await database.stagedCipherChunks.toArray()])
  expect(persisted).not.toContain('private-C')
  await database.encryptedRevisions.bulkAdd([...prepared.records])
  await disposeWorkspaceSnapshot(snapshot)
  await prepared.dispose()
  database.close(); invalidateProfile()
  const freshToken = installProfile(token.accountId, key), fresh = new AccountDatabase(token.accountId)
  databases.push(fresh)
  const reopened = await evidence.openAccountInheritedEvidence(fresh, freshToken, prepared.root)
  const sources = await evidence.accountInheritedSources(reopened)
  expect(await pages(sources.members[0].metadata)).toEqual(expected)
  expect(sources.members[0].subset).toEqual(historical.state.blobs.map(body => body.ref))
  expect(sources.bodies.map(body => body.ref.documentId)).toEqual([...sources.bodies.map(body => body.ref.documentId)].sort())
  const raw = await readBackupMetadata(sources.members[0].metadata) as import('../interchange/workspace-backup-evidence').SnapshotMetadataV1
  const state = attachBackupBodies(raw, new Map(sources.bodies.map(body => [blobIdentity(body.ref), body])))
  await validateWorkspaceSnapshotV1(state)
  for (const body of sources.bodies) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(historical.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength))
  await reopened.dispose()
}, 30_000)

it('creates explicit empty evidence and rejects structural authority, foreign bases and unregistered V2 wrappers', async () => {
  const { database, token } = account()
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({})
  expect(prepared.handle.members).toEqual([])
  expect(prepared.handle.setDigest).toBe('b31b613c1f568466840704190d9a418278ba187123148b5c31c8d0d979840297')
  expect(prepared.records).toHaveLength(3)
  expect(await evidence.accountInheritedSources(prepared.handle)).toEqual({ members: [], bodies: [] })
  await expect(evidence.accountInheritedSources({ ...prepared.handle })).rejects.toThrow(/registered/)
  const sameName = new AccountDatabase(token.accountId)
  const foreign = evidence.createAccountInheritedEvidencePreparation(sameName, token)
  await expect(foreign.prepare({ base: prepared.handle })).rejects.toThrow(/Foreign/)
  sameName.close()
  const source = await inheritWorkspaceSnapshot(await original(), [])
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [{ ...source }] })).rejects.toThrow(/owned/)
  const { ownWorkspaceSnapshot } = await import('../workspace/snapshot')
  const fake = ownWorkspaceSnapshot({ ...source }, { async check() {}, async dispose() {} })
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [fake] })).rejects.toThrow(/captured/)
  await disposeWorkspaceSnapshot(source)
  await prepared.dispose()
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('copies a prepared base independently and preserves property-order variants while deduplicating exact members', async () => {
  const { database, token } = account(), first = await original()
  const second = { ...first, state: { ...first.state, editorDocuments: [{ ...first.state.editorDocuments[0], unfinished: { ...first.state.editorDocuments[0].unfinished, fieldState: { alpha: 'last', zeta: 'private-C' } } }] } }
  const snapshot = await inheritWorkspaceSnapshot(first, [first, second, first])
  const source = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  const copy = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ base: source.handle, additions: [snapshot] })
  expect(copy.handle.members).toHaveLength(2)
  expect(copy.handle.members).toEqual(source.handle.members)
  const previousPayloads = new Set(source.records.map(record => record.payloadId))
  expect(copy.records.every(record => !previousPayloads.has(record.payloadId))).toBe(true)
  await source.dispose(); await disposeWorkspaceSnapshot(snapshot)
  const reopened = await evidence.openAccountInheritedEvidence(database, token, copy.root, copy.owner)
  const sources = await evidence.accountInheritedSources(reopened)
  const orders = []
  for (const member of sources.members) {
    const raw = await readBackupMetadata(member.metadata) as import('../interchange/workspace-backup-evidence').SnapshotMetadataV1
    orders.push(Object.keys(raw.state.editorDocuments[0].unfinished.fieldState!))
  }
  expect(orders).toContainEqual(['zeta', 'alpha'])
  expect(orders).toContainEqual(['alpha', 'zeta'])
  await reopened.dispose(); await copy.dispose()
})

it('revokes only the disposed handle, rejects busy adoption and reauthenticates through the parent', async () => {
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountSource } = await import('../workspace/account-streams')
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  const other = await evidence.openAccountInheritedEvidence(database, token, prepared.root, prepared.owner)
  const parent = createAccountPreparationOwner(database, token)
  const parentRecord = await stageAccountBytes(database, token, new Uint8Array([7, 8]), [], undefined, parent)
  const parentIterator = (await openAccountSource(database, token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
  const parentBytes = (await parentIterator.next()).value as Uint8Array
  const iterator = (await evidence.accountInheritedSources(prepared.handle)).members[0].metadata.open()[Symbol.asyncIterator]()
  const bytes = (await iterator.next()).value as Uint8Array
  expect(bytes.some(byte => byte !== 0)).toBe(true)
  await expect(parent.adopt(prepared.owner)).rejects.toThrow(/busy/)
  const otherIterator = (await evidence.accountInheritedSources(other)).members[0].metadata.open()[Symbol.asyncIterator]()
  await otherIterator.next()
  await prepared.handle.dispose()
  expect(bytes.every(byte => byte === 0)).toBe(true)
  await expect(iterator.next()).rejects.toThrow(/released/)
  await expect(parent.adopt(prepared.owner)).rejects.toThrow(/busy/)
  await otherIterator.return?.()
  await parent.adopt(prepared.owner)
  await expect(other.check()).rejects.toThrow(/closed/)
  const fresh = await evidence.openAccountInheritedEvidence(database, token, prepared.root, parent)
  await prepared.dispose()
  expect(parentBytes).toEqual(new Uint8Array([7, 8]))
  expect((await evidence.accountInheritedSources(fresh)).members).toHaveLength(1)
  expect(await database.stagedCipherChunks.count()).toBeGreaterThan(0)
  await fresh.dispose(); await other.dispose(); await parentIterator.return?.(); await parent.abandon(); await disposeWorkspaceSnapshot(snapshot)
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('retains retryable cleanup after prepare rejects before returning any authority', async () => {
  const streams = await import('../workspace/account-streams')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source])
  const input = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({})
  const parent = createAccountPreparationOwner(database, token)
  await stageAccountBytes(database, token, new Uint8Array([41]), [], undefined, parent)
  const installed = await stageAccountBytes(database, token, new Uint8Array([31]), [])
  await database.encryptedRevisions.add(installed)
  const before = await database.stagedCipherChunks.toArray()
  const tables = async () => Promise.all(database.tables.filter(table => table.name !== 'stagedCipherChunks').map(async table => [table.name, await table.toArray()]))
  const selected = await tables()
  const originalStage = streams.stageAccountSource
  vi.spyOn(streams, 'stageAccountSource').mockImplementationOnce(async (...args) => { await originalStage(...args); throw new Error('synthetic C primary failure') })
  const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => { throw new Error('synthetic C deletion failure') })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  let returned: evidence.PreparedAccountInheritedEvidence | undefined, error: unknown
  try { returned = await operation.prepare({ base: input.handle, additions: [snapshot] }) } catch (failure) { error = failure }
  expect(returned).toBeUndefined()
  expect(error).toMatchObject({ errors: [expect.objectContaining({ message: 'synthetic C primary failure' }), expect.objectContaining({ message: 'synthetic C deletion failure' })] })
  expect(await database.stagedCipherChunks.count()).toBeGreaterThan(before.length)
  await expect(operation.abandon()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'synthetic C primary failure' }), expect.objectContaining({ message: 'synthetic C deletion failure' })] })
  expect(await tables()).toEqual(selected)
  await input.handle.check()
  await import('../workspace/snapshot').then(module => module.assertOwnedWorkspaceSnapshot(snapshot))
  deletion.mockRestore(); invalidateProfile()
  await Promise.all([operation.abandon(), operation.abandon()]); await operation.abandon()
  expect(await database.stagedCipherChunks.toArray()).toEqual(before)
  expect(await tables()).toEqual(selected)
  await input.dispose(); await parent.abandon(); await disposeWorkspaceSnapshot(snapshot)
})

it('rejects repeated preparation and abandonment before preparation without allocating', async () => {
  const { database, token } = account(), operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  await operation.abandon()
  await expect(operation.prepare({})).rejects.toThrow(/single-use/)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  const second = evidence.createAccountInheritedEvidencePreparation(database, token)
  const first = second.prepare({})
  await expect(second.prepare({})).rejects.toThrow(/single-use/)
  await first
  await expect(second.prepare({})).rejects.toThrow(/single-use/)
  await second.abandon()
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

type Wire = { version: number; kind: string; entries?: Record<string, unknown>[]; children?: CipherRef[]; members?: CipherRef; blobs?: CipherRef; pages?: CipherRef; byteLength?: number; digest?: string; setDigest?: string; [key: string]: unknown }
const keyOf = (ref: CipherRef) => JSON.stringify([ref.documentId, ref.revisionId])
async function rewrite(prepared: evidence.PreparedAccountInheritedEvidence, database: AccountDatabase, token: import('../account/profile').ProfileToken, mutate: (value: Wire, dependencies: CipherRef[]) => void): Promise<CipherRef> {
  const { readAccountBytes, cipherRef, stageAccountJson } = await import('../workspace/account-cache')
  const refs = new Map<string, CipherRef>()
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace)
    if (!value || typeof value !== 'object') return value
    const object = value as Record<string, unknown>
    if (Object.keys(object).length === 2 && typeof object.documentId === 'string' && typeof object.revisionId === 'string') return refs.get(keyOf(object as unknown as CipherRef)) ?? value
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, replace(child)]))
  }
  for (const record of prepared.records) {
    const ref = cipherRef(record), bytes = await readAccountBytes(database, token, ref, undefined, prepared.owner)
    let value: Wire | undefined
    try { const raw = JSON.parse(new TextDecoder().decode(bytes)); if (raw.kind === 'inherited-snapshot-evidence' || raw.kind?.startsWith('evidence-')) value = replace(raw) as Wire } catch { /* Raw bodies and token pages retain their original bytes */ } finally { bytes.fill(0) }
    if (!value) { refs.set(keyOf(ref), ref); continue }
    const dependencies = record.descriptor.dependencies.map(dependency => replace(dependency) as CipherRef)
    mutate(value, dependencies)
    const changed = await stageAccountJson(database, token, value, dependencies)
    await database.encryptedRevisions.add(changed)
    refs.set(keyOf(ref), cipherRef(changed))
  }
  return refs.get(keyOf(prepared.root))!
}
async function installedFixture() {
  const context = account(), originalSnapshot = await original()
  const snapshot = await inheritWorkspaceSnapshot(originalSnapshot, [originalSnapshot])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(context.database, context.token).prepare({ additions: [snapshot] })
  await context.database.encryptedRevisions.bulkAdd([...prepared.records])
  return { ...context, snapshot, prepared }
}

it.each([
  ['missing edge', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'inherited-snapshot-evidence') refs.pop() }],
  ['extra edge', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'inherited-snapshot-evidence') refs.push({ documentId: accountLocalId(), revisionId: accountLocalId() }) }],
  ['wrong edge', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'inherited-snapshot-evidence') refs[0] = { documentId: accountLocalId(), revisionId: accountLocalId() } }],
  ['unknown root field', (value: Wire) => { if (value.kind === 'inherited-snapshot-evidence') value.selected = true }],
  ...['member', 'blob', 'subset', 'metadata'].map(role => [`${role} kind swap`, (value: Wire) => { if (value.kind === `evidence-${role}-page`) value.kind = 'evidence-wrong-page' }] as const),
  ['mixed page', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'evidence-member-page') { value.children = [refs[0]]; refs.push(refs[0]) } }],
  ['duplicate member', (value: Wire) => { if (value.kind === 'evidence-member-page') value.entries!.push(value.entries![0]) }],
  ['unsorted bodies', (value: Wire) => { if (value.kind === 'evidence-blob-page') value.entries!.reverse() }],
  ['duplicate body', (value: Wire) => { if (value.kind === 'evidence-blob-page') value.entries!.push(value.entries![0]) }],
  ['reordered subset', (value: Wire) => { if (value.kind === 'evidence-subset-page') value.entries!.reverse() }],
  ['changed full ref', (value: Wire) => { if (value.kind === 'evidence-subset-page') (value.entries![0].source as { encoding: string }).encoding = 'utf8' }],
  ['foreign subset content', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'evidence-subset-page') { value.entries![0].content = value.entries![1].content; refs.splice(0, 1) } }],
  ['missing segment', (value: Wire, refs: CipherRef[]) => { if (value.kind === 'evidence-metadata-page') { value.entries = []; refs.splice(0) } }],
  ['duplicate ordinal', (value: Wire) => { if (value.kind === 'evidence-metadata-page') value.entries!.push(value.entries![0]) }],
  ['noncontiguous ordinal', (value: Wire) => { if (value.kind === 'evidence-metadata-page') value.entries![0].ordinal = 1 }],
  ['segment length', (value: Wire) => { if (value.kind === 'evidence-metadata-page') value.entries![0].byteLength = (value.entries![0].byteLength as number) + 1 }],
  ['segment hash', (value: Wire) => { if (value.kind === 'evidence-metadata-page') value.entries![0].sha256 = '0'.repeat(64) }],
  ['stream digest', (value: Wire) => { if (value.kind === 'evidence-metadata-stream') value.digest = '0'.repeat(64) }],
  ['stream length', (value: Wire) => { if (value.kind === 'evidence-metadata-stream') value.byteLength = value.byteLength! + 1 }],
  ['member identity', (value: Wire) => { if (value.kind === 'evidence-member-page') value.entries![0].id = '0'.repeat(64) }],
  ['set digest', (value: Wire) => { if (value.kind === 'inherited-snapshot-evidence') value.setDigest = '0'.repeat(64) }],
  ['oversized page envelope', (value: Wire) => { if (value.kind === 'evidence-blob-page') (value.entries![0].source as { documentId: string }).documentId = 'x'.repeat(256 * 1024) }],
  ['oversized segment', (value: Wire) => { if (value.kind === 'evidence-metadata-page') value.entries![0].byteLength = 4 * 1024 * 1024 + 1 }],
] as const)('rejects authenticated retaining corruption: %s', async (_name, corrupt) => {
  const { database, token, snapshot, prepared } = await installedFixture()
  const root = await rewrite(prepared, database, token, (value, refs) => {
    corrupt(value, refs)
    // Descriptors prohibit duplicate edges even where malformed pages repeat a ref
    const unique = [...new Map(refs.map(ref => [keyOf(ref), ref])).values()]
    refs.splice(0, refs.length, ...unique)
  })
  await expect(evidence.openAccountInheritedEvidence(database, token, root)).rejects.toThrow()
  expect(await database.profileMeta.count()).toBe(0)
  await disposeWorkspaceSnapshot(snapshot); await prepared.dispose()
})

it.each(['payload', 'document', 'account', 'unprotected', 'missing', 'truncated', 'trailing', 'finality', 'dependencies'] as const)('rejects installed identity or ciphertext corruption: %s', async kind => {
  const { database, token, snapshot, prepared } = await installedFixture()
  const record: { -readonly [Key in keyof CipherRecord]: CipherRecord[Key] } = structuredClone(prepared.records.at(-1)!)
  if (kind === 'payload') record.payloadId = prepared.records[0].payloadId
  if (kind === 'document') record.descriptor = { ...record.descriptor, documentId: accountLocalId() }
  if (kind === 'account') record.descriptor = { ...record.descriptor, accountId: accountLocalId() }
  if (kind === 'unprotected') record.descriptor = { ...record.descriptor, protected: false }
  if (kind === 'dependencies') record.descriptor = { ...record.descriptor, dependencies: Array.from({ length: 257 }, () => ({ documentId: accountLocalId(), revisionId: accountLocalId() })) }
  if (['payload', 'document', 'account', 'unprotected', 'dependencies'].includes(kind)) await database.encryptedRevisions.put(record)
  else {
    const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    if (kind === 'missing') await database.stagedCipherChunks.delete([record.payloadId, 0])
    if (kind === 'truncated') await database.stagedCipherChunks.put({ ...chunk, bytes: chunk.bytes.slice(0, -1) })
    if (kind === 'trailing') await database.stagedCipherChunks.put({ ...chunk, bytes: new Uint8Array([...chunk.bytes, 1]) })
    if (kind === 'finality') { const bytes = chunk.bytes.slice(); bytes[bytes.length - 1] ^= 1; await database.stagedCipherChunks.put({ ...chunk, bytes }) }
  }
  await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root)).rejects.toThrow()
  await disposeWorkspaceSnapshot(snapshot); await prepared.dispose()
})

it('rejects later raw body corruption on complete lazy consumption and clears delivered buffers', async () => {
  const { database, token, snapshot, prepared } = await installedFixture()
  const handle = await evidence.openAccountInheritedEvidence(database, token, prepared.root)
  const sources = await evidence.accountInheritedSources(handle)
  const body = prepared.records[0], chunk = (await database.stagedCipherChunks.get([body.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await database.stagedCipherChunks.put({ ...chunk, bytes })
  await expect(pages(sources.bodies[0].content)).rejects.toThrow()
  await handle.dispose(); await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

async function putJson(database: AccountDatabase, token: import('../account/profile').ProfileToken, value: unknown, dependencies: readonly CipherRef[]): Promise<CipherRef> {
  const { stageAccountJson, cipherRef } = await import('../workspace/account-cache')
  const record = await stageAccountJson(database, token, value, dependencies)
  await database.encryptedRevisions.add(record)
  return cipherRef(record)
}
async function emptyRoot(database: AccountDatabase, token: import('../account/profile').ProfileToken, members: CipherRef) {
  const blobs = await putJson(database, token, { version: 1, kind: 'evidence-blob-page', entries: [], children: [] }, [])
  return putJson(database, token, { version: 1, kind: 'inherited-snapshot-evidence', setDigest: 'b31b613c1f568466840704190d9a418278ba187123148b5c31c8d0d979840297', members, blobs }, [members, blobs])
}

it('rejects repeated and cyclic pages, and bounds cycle-free wide and deep trees before traversal', async () => {
  const { database, token } = account()
  const leaf = () => putJson(database, token, { version: 1, kind: 'evidence-member-page', entries: [], children: [] }, [])
  const node = (children: CipherRef[]) => putJson(database, token, { version: 1, kind: 'evidence-member-page', entries: [], children }, [...new Map(children.map(ref => [keyOf(ref), ref])).values()])
  const shared = await leaf(), repeated = await emptyRoot(database, token, await node([shared, shared]))
  await expect(evidence.openAccountInheritedEvidence(database, token, repeated)).rejects.toThrow(/Repeated/)

  const { encryptRevision } = await import('../account/crypto/revisions')
  const { withAccountKey } = await import('../account/profile')
  const self = { documentId: accountLocalId(), revisionId: accountLocalId() }, payloadId = accountLocalId()
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'evidence-member-page', entries: [], children: [self] }))
  const encrypted = await withAccountKey(token, key => encryptRevision(key, { format: 1, accountId: token.accountId, ...self, parents: [], dependencies: [self], protected: true, plainBytes: bytes.length }, accountLocalId(), memoryBlob(bytes).open(), { id: payloadId, async write(index, chunk) { await database.stagedCipherChunks.add({ payloadId, index, bytes: chunk }) } }))
  await database.encryptedRevisions.add({ revisionId: self.revisionId, payloadId, descriptor: encrypted.descriptor })
  await expect(evidence.openAccountInheritedEvidence(database, token, await emptyRoot(database, token, self))).rejects.toThrow(/Repeated/)

  let deep = await leaf()
  for (let level = 0; level < 4; level++) deep = await node([deep])
  const deepRoot = await emptyRoot(database, token, deep)
  const wideRoot = await emptyRoot(database, token, await node([await leaf(), await leaf(), await leaf(), await leaf()]))
  await (await evidence.openAccountInheritedEvidence(database, token, deepRoot)).dispose()
  await (await evidence.openAccountInheritedEvidence(database, token, wideRoot)).dispose()
  limits.depth = 3
  await expect(evidence.openAccountInheritedEvidence(database, token, deepRoot)).rejects.toThrow(/resource limit/)
  limits.depth = defaultLimits.depth; limits.frames = 5
  const get = vi.spyOn(database.stagedCipherChunks, 'get')
  await expect(evidence.openAccountInheritedEvidence(database, token, wideRoot)).rejects.toThrow(/resource limit/)
  expect(get).toHaveBeenCalledTimes(2)
})

it('enforces cumulative declared and reread byte budgets on both preparation and installed reopening', async () => {
  const { database, token, snapshot, prepared } = await installedFixture()
  const declared = prepared.records.reduce((sum, record) => sum + record.descriptor.plainBytes, 0)
  const existing = await database.stagedCipherChunks.toArray()
  limits.bytes = declared - 1
  await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root)).rejects.toThrow(/resource limit/)
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })).rejects.toThrow(/resource limit/)
  expect(await database.stagedCipherChunks.toArray()).toEqual(existing)
  limits.bytes = declared
  await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root)).rejects.toThrow(/resource limit/)
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })).rejects.toThrow(/resource limit/)
  expect(await database.stagedCipherChunks.toArray()).toEqual(existing)
  Object.assign(limits, defaultLimits)
  await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

it('bounds many small original token pages across members without losing their boundaries', async () => {
  const { historicalMetadataIdentity, metadataSource, joinWorkspaceSnapshotEvidence } = await import('../interchange/workspace-backup-evidence')
  const { ownWorkspaceSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
  const { database, token } = account(), source = await original()
  const tiny = async (value: WorkspaceSnapshotV1) => {
    const tokens = (await pages(metadataSource(snapshotMetadata(value)))).flatMap(bytes => JSON.parse(new TextDecoder().decode(bytes)) as unknown[])
    const parts = tokens.map(token => new TextEncoder().encode(JSON.stringify([token])))
    const metadata = { byteLength: parts.reduce((sum, part) => sum + part.length, 0), async *open() { for (const part of parts) yield part.slice() } }
    return { id: (await historicalMetadataIdentity(metadata)).id, metadata, subset: value.state.blobs.map(body => body.ref) }
  }
  const members = [await tiny(source), await tiny({ ...source, snapshotId: 'second-small-page-original' })]
  const current = ownWorkspaceSnapshot(source, { async check() {}, async dispose() {} })
  const snapshot = await joinWorkspaceSnapshotEvidence(current, { members, bodies: source.state.blobs })
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  await database.encryptedRevisions.bulkAdd([...prepared.records])
  const reopened = await evidence.openAccountInheritedEvidence(database, token, prepared.root)
  for (const member of (await evidence.accountInheritedSources(reopened)).members) expect(await pages(member.metadata)).toEqual(await pages(members.find(value => value.id === member.id)!.metadata))
  await reopened.dispose()
  const before = await database.stagedCipherChunks.toArray()
  let readPages = 0
  const captured = capturedBackupEvidence(snapshot)
  for (const [id, source] of captured.historical) {
    (captured.historical as Map<string, typeof source>).set(id, { byteLength: source.byteLength, async *open() {
      for await (const bytes of source.open()) { readPages++; yield bytes }
    } })
  }
  limits.frames = 25
  await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root)).rejects.toThrow(/resource limit/)
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })).rejects.toThrow(/resource limit/)
  expect(readPages).toBeLessThanOrEqual(limits.frames + 1)
  expect(await database.stagedCipherChunks.toArray()).toEqual(before)
  Object.assign(limits, defaultLimits)
  await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
}, 30_000)

it('settles abandonment during a blocked source read without a late result or self-wait', async () => {
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source]), captured = capturedBackupEvidence(snapshot)
  const [id, metadata] = [...captured.historical][0]
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  let returned = false
  const replacement = { byteLength: metadata.byteLength, open() {
    return { [Symbol.asyncIterator]() { return {
      async next() { started(); await blocked; return { done: true as const, value: undefined } },
      async return() { returned = true; release(); return { done: true as const, value: undefined } },
    } } }
  } }
  ;(captured.historical as Map<string, typeof metadata>).set(id, replacement)
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  const pending = operation.prepare({ additions: [snapshot] }).then(() => 'late success', () => 'rejected')
  await began
  const cleanup = operation.abandon()
  const settled = await Promise.race([cleanup.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  release()
  await cleanup
  expect(await pending).toBe('rejected')
  expect(settled).toBe(true)
  expect(returned).toBe(true)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  await disposeWorkspaceSnapshot(snapshot)
})

it('managed C abandonment closes its reserved owner before a private reader return settles', async () => {
  const streams = await import('../workspace/account-streams')
  const { cipherRef } = await import('../workspace/account-cache')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  const historical = capturedBackupEvidence(snapshot).historical as Map<string, import('../workspace/documents').BlobSource>
  const [id, metadata] = [...historical][0]
  let bodyRecord: CipherRecord | undefined
  let owner: import('../workspace/account-prepared-records').AccountPreparationOwner | undefined
  let reached!: () => void, release!: () => void
  const pendingRead = new Promise<void>(resolve => { reached = resolve })
  const blockedReturn = new Promise<void>(resolve => { release = resolve })
  const stage = streams.stageAccountSource
  vi.spyOn(streams, 'stageAccountSource').mockImplementation(async (...args) => {
    const record = await stage(...args)
    bodyRecord = record; owner = args[6]
    return record
  })
  historical.set(id, { byteLength: metadata.byteLength, open() {
    const input = metadata.open()[Symbol.asyncIterator]()
    return { [Symbol.asyncIterator]() { return this as AsyncIterableIterator<Uint8Array> }, async next() {
      if (bodyRecord) { reached(); await blockedReturn }
      return input.next()
    }, async return() { if (bodyRecord) await blockedReturn; return input.return?.() ?? { done: true as const, value: undefined } } }
  } })
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const preparation = operation.prepare({ additions: [snapshot] }).then(value => value, error => error)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([pendingRead, new Promise<void>((_, reject) => { deadline = setTimeout(() => { release(); reject(new Error(`Managed C reader was not reached after native staging: ${Boolean(bodyRecord)}`)) }, 10_000) })])
  } finally { if (deadline) clearTimeout(deadline) }
  expect(bodyRecord).toBeDefined()
  expect(owner).toBeDefined()
  const iterator = (await streams.openAccountSource(database, token, cipherRef(bodyRecord!), owner)).open()[Symbol.asyncIterator]()
  const held = (await iterator.next()).value as Uint8Array
  expect(held.some(byte => byte !== 0)).toBe(true)
  const abandoned = operation.abandon().then(() => 'succeeded', error => error)
  try {
    expect(() => owner!.check()).toThrow(/closed/)
    await Promise.resolve()
    expect(held.every(byte => byte === 0)).toBe(true)
  } finally { release() }
  const result = await abandoned
  expect(result).toBe('succeeded')
  expect(await preparation).toBeInstanceOf(Error)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  await iterator.return?.(); await disposeWorkspaceSnapshot(snapshot)
}, 30_000)

it('managed C retains incoming cleanup history when a distinct owner throws the same error object', async () => {
  const profile = await import('../account/profile')
  const streams = await import('../workspace/account-streams')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const shared = new Error('shared cleanup object')
  const nested = coordinator.cleanup.reader({ async dispose() { throw shared } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected nested cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  let armed = false, injected = false
  const active = profile.assertActiveProfile, open = streams.openAccountSource
  vi.spyOn(profile, 'assertActiveProfile').mockImplementation(value => {
    active(value)
    if (armed && !injected) { injected = true; throw incoming }
  })
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() { const value = await input.next(); if (!value.done) armed = true; return value }, return: () => input.return?.() ?? Promise.resolve({ done: true as const, value: undefined }), [Symbol.asyncIterator]() { return this } }
    } }
  })
  const managed = { ...coordinator.cleanup, owner(raw: import('../workspace/account-prepared-records').AccountPreparationOwner) {
    const abandon = raw.abandon.bind(raw)
    vi.spyOn(raw, 'abandon').mockImplementation(async () => { await abandon(); throw shared })
    return coordinator.cleanup.owner(raw)
  } }
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, managed)
  const rejected = await operation.prepare({}).then(value => value, error => error)
  expect(injected).toBe(true)
  const failure = readAccountCleanupOnlyFailure(rejected)
  expect(failure).toBeDefined()
  expect((rejected as Error).cause).toBe(incoming)
  expect(failure?.history).toContain(incoming)
  expect(failure?.result.status).toBe('failed')
  expect(failure?.result.status === 'failed' ? failure.result.errors.filter(error => error === shared).length : 0).toBe(2)
  await expect(operation.abandon()).rejects.toBeInstanceOf(AggregateError)
}, 30_000)

it.each([false, true])('managed C preserves a retried nested failure when later local cleanup fails (group=%s)', async grouped => {
  const cache = await import('../workspace/account-cache')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const nestedError = new Error('historical nested cleanup')
  let nestedAttempts = 0
  const nestedReader = coordinator.cleanup.reader({ async dispose() { if (++nestedAttempts === 1) throw nestedError } })
  const nested = grouped ? coordinator.cleanup.group([nestedReader]) : nestedReader
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected first nested cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  await coordinator.retryFailed([nested])
  expect(nested.observe()).toMatchObject({ attempt: 2, status: 'succeeded' })
  const localError = new Error('later local cleanup')
  const managed = { ...coordinator.cleanup, owner(raw: import('../workspace/account-prepared-records').AccountPreparationOwner) {
    const abandon = raw.abandon.bind(raw)
    vi.spyOn(raw, 'abandon').mockImplementation(async () => { await abandon(); throw localError })
    return coordinator.cleanup.owner(raw)
  } }
  const stage = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => { await stage(...args); throw incoming })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, managed)
  const rejected = await operation.prepare({}).then(value => value, error => error)
  const failure = readAccountCleanupOnlyFailure(rejected)
  expect(readAccountPreparationFailure(rejected)).toBeUndefined()
  expect((rejected as Error).cause).toBe(incoming)
  expect(failure?.history).toContain(incoming)
  expect(failure?.result.status === 'failed' ? failure.result.errors : []).toEqual([localError])
  expect((rejected as AggregateError).errors).toEqual([localError, nestedError])
  expect(readAccountCleanupOnlyFailure(incoming)?.result).toBe(first)
  expect(await operation.cleanup.request()).toMatchObject({ status: 'failed', errors: [localError] })
}, 30_000)

it('managed C preserves literal undefined as a primary when cleanup succeeds', async () => {
  const profile = await import('../account/profile')
  const streams = await import('../workspace/account-streams')
  const { database, token } = account()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  let armed = false, injected = false
  const active = profile.assertActiveProfile, open = streams.openAccountSource
  vi.spyOn(profile, 'assertActiveProfile').mockImplementation(value => {
    active(value)
    if (armed && !injected) { injected = true; throw undefined }
  })
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() { const value = await input.next(); if (!value.done) armed = true; return value }, return: () => input.return?.() ?? Promise.resolve({ done: true as const, value: undefined }), [Symbol.asyncIterator]() { return this } }
    } }
  })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const outcome = await operation.prepare({}).then(() => ({ status: 'succeeded' as const }), error => ({ status: 'rejected' as const, error }))
  expect(injected).toBe(true)
  expect(outcome).toEqual({ status: 'rejected', error: undefined })
  expect(await operation.cleanup.request()).toMatchObject({ status: 'succeeded' })
}, 30_000)

it('managed C retires its local ciphertext before rejecting a foreign nested cleanup join', async () => {
  const cache = await import('../workspace/account-cache')
  const { accountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const local = createAccountCleanupCoordinator(database, token, async () => {})
  const foreign = createAccountCleanupCoordinator(database, token, async () => {})
  const nested = foreign.cleanup.reader({ async dispose() { throw new Error('foreign reader cleanup') } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected foreign cleanup failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  const stage = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => { await stage(...args); throw incoming })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, local.cleanup)
  await expect(operation.prepare({})).rejects.toThrow(/Foreign or unregistered account cleanup join/)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  expect(await operation.cleanup.request()).toMatchObject({ status: 'succeeded' })
}, 30_000)

it('managed C retains a failed native deletion until explicit same-owner retry', async () => {
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  let settled = false
  const coordinator = createAccountCleanupCoordinator(database, token, async () => { expect(settled).toBe(true) })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const prepared = await operation.prepare({ additions: [snapshot] })
  settled = true
  const owned = prepared.records[0]
  const borrowedOwner = createAccountPreparationOwner(database, token)
  const borrowed = await stageAccountBytes(database, token, new Uint8Array([71]), [], undefined, borrowedOwner)
  const installed = await stageAccountBytes(database, token, new Uint8Array([72]), [])
  await database.encryptedRevisions.add(installed)
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    const rejected = await operation.abandon().then(() => undefined, error => error)
    const first = readAccountCleanupOnlyFailure(rejected)
    expect(first?.cleanup).toBe(operation.cleanup)
    expect(first?.result.status).toBe('failed')
    expect(deletions).toBe(1)
    expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeDefined()
    await expect(operation.abandon()).rejects.toBe(rejected)
    expect(deletions).toBe(1)
    await coordinator.retryFailed([operation.cleanup])
    expect(deletions).toBe(2)
    expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeUndefined()
    expect(await database.stagedCipherChunks.get([borrowed.payloadId, 0])).toBeDefined()
    expect(await database.encryptedRevisions.get(installed.revisionId)).toBeDefined()
  } finally { vi.restoreAllMocks(); await borrowedOwner.abandon(); await prepared.dispose().catch(() => {}); await disposeWorkspaceSnapshot(snapshot) }
}, 30_000)

it.each(['signal', 'profile'] as const)('managed C %s callback retains native failure until retry after preparation settles', async mode => {
  const cache = await import('../workspace/account-cache')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { database, token } = account()
  let wrote!: () => void, release!: () => void
  const staged = new Promise<void>(resolve => { wrote = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let owned: CipherRecord | undefined
  const stage = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => {
    const record = await stage(...args)
    owned = record; wrote()
    await blocked
    return record
  })
  let captured!: Promise<evidence.PreparedAccountInheritedEvidence>
  let operation!: evidence.ManagedAccountInheritedEvidencePreparation
  let settlementCalls = 0
  const coordinator = createAccountCleanupCoordinator(database, token, async parts => {
    expect(parts).toContain(operation.cleanup)
    settlementCalls++
    await Promise.allSettled([captured])
  })
  operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const controller = new AbortController()
  captured = operation.prepare(mode === 'signal' ? { signal: controller.signal } : {})
  const preparation = captured.then(value => value, error => error)
  await staged
  const borrowedOwner = createAccountPreparationOwner(database, token)
  const borrowed = await cache.stageAccountBytes(database, token, new Uint8Array([71]), [], undefined, borrowedOwner)
  const installed = await cache.stageAccountBytes(database, token, new Uint8Array([72]), [])
  await database.encryptedRevisions.add(installed)
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned?.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    if (mode === 'signal') controller.abort()
    else invalidateProfile()
    expect(operation.cleanup.observe()).toMatchObject({ attempt: 1 })
    const first = await operation.cleanup.request()
    if (first.status !== 'failed') throw new Error('Expected native deletion failure')
    expect(deletions).toBe(1)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeDefined()
    expect(operation.cleanup.observe()).toMatchObject({ attempt: 1, status: 'failed', errors: first.errors })
    expect(await operation.cleanup.wait()).toMatchObject({ attempt: 1, status: 'failed', errors: first.errors })
    const ordinary = operation.abandon().then(() => undefined, error => error)
    await Promise.resolve()
    expect(deletions).toBe(1)
    release()
    const rejected = await preparation
    const carriedPrimary = readAccountPreparationFailure(rejected)
    expect(carriedPrimary?.cleanup).toBe(operation.cleanup)
    const firstCarrier = await ordinary
    const cleanupOnly = readAccountCleanupOnlyFailure(firstCarrier)
    expect(cleanupOnly?.cleanup).toBe(operation.cleanup)
    expect(cleanupOnly?.result.status).toBe('failed')
    expect(cleanupOnly?.result.status === 'failed' ? cleanupOnly.result.errors : []).toEqual(first.errors)
    expect(cleanupOnly?.result.status === 'failed' ? cleanupOnly.result.errors[0] : undefined).toBe(first.errors[0])
    await expect(operation.abandon()).rejects.toBe(firstCarrier)
    expect(await operation.cleanup.request()).toMatchObject({ attempt: 1, status: 'failed', errors: first.errors })
    expect(deletions).toBe(1)
    await coordinator.retryFailed([operation.cleanup])
    expect(settlementCalls).toBe(1)
    expect(deletions).toBe(2)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeUndefined()
    expect(await database.stagedCipherChunks.get([borrowed.payloadId, 0])).toBeDefined()
    expect(await database.encryptedRevisions.get(installed.revisionId)).toBeDefined()
    expect(cleanupOnly?.result.status).toBe('failed')
    expect(readAccountPreparationFailure(rejected)?.primary).toBe(carriedPrimary?.primary)
    expect(await operation.cleanup.request()).toMatchObject({ attempt: 2, status: 'succeeded' })
  } finally { release(); vi.restoreAllMocks(); await borrowedOwner.abandon() }
}, 30_000)

it('managed C explicit retry waits for the captured inner preparation after failed native cleanup', async () => {
  const cache = await import('../workspace/account-cache')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  let staged!: () => void, release!: () => void, entered!: () => void
  const wrote = new Promise<void>(resolve => { staged = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const barrier = new Promise<void>(resolve => { entered = resolve })
  let owned: CipherRecord | undefined
  const stage = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => {
    const record = await stage(...args)
    owned = record; staged()
    await blocked
    return record
  })
  let captured!: Promise<evidence.PreparedAccountInheritedEvidence>
  let operation!: evidence.ManagedAccountInheritedEvidencePreparation
  const coordinator = createAccountCleanupCoordinator(database, token, async parts => {
    expect(parts).toContain(operation.cleanup)
    entered()
    await Promise.allSettled([captured])
  })
  operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  captured = operation.prepare({})
  const observed = captured.then(value => value, error => error)
  await wrote
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned?.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    const abandoned = operation.abandon().then(() => undefined, error => error)
    const first = await operation.cleanup.request()
    expect(first.status).toBe('failed')
    expect(deletions).toBe(1)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeDefined()
    const retry = coordinator.retryFailed([operation.cleanup])
    await barrier
    await Promise.resolve()
    expect(deletions).toBe(1)
    expect(await operation.cleanup.wait()).toMatchObject({ attempt: 1, status: 'failed' })
    release()
    const rejected = await observed
    expect(readAccountPreparationFailure(rejected)?.cleanup).toBe(operation.cleanup)
    await retry
    await abandoned
    expect(deletions).toBe(2)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeUndefined()
    expect(await operation.cleanup.request()).toMatchObject({ attempt: 2, status: 'succeeded' })
  } finally { release(); vi.restoreAllMocks() }
}, 30_000)

it('managed C composes a late nested failure after local failure while explicit retry waits', async () => {
  const cache = await import('../workspace/account-cache')
  const streams = await import('../workspace/account-streams')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  let reached!: () => void, rejectOpening!: (error: Error) => void, entered!: () => void
  const opening = new Promise<void>(resolve => { reached = resolve })
  const sourceFailure = new Promise<never>((_, reject) => { rejectOpening = reject })
  const barrier = new Promise<void>(resolve => { entered = resolve })
  let owned: CipherRecord | undefined
  const stage = cache.stageAccountBytes, open = streams.openAccountSource
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation(async (...args) => { const record = await stage(...args); owned ??= record; return record })
  vi.spyOn(streams, 'openAccountSource').mockImplementationOnce(async (...args) => { await open(...args); reached(); return sourceFailure })
  let captured!: Promise<evidence.PreparedAccountInheritedEvidence>
  let operation!: evidence.ManagedAccountInheritedEvidencePreparation
  const coordinator = createAccountCleanupCoordinator(database, token, async parts => {
    expect(parts).toContain(operation.cleanup)
    entered()
    await Promise.allSettled([captured])
  })
  operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  captured = operation.prepare({})
  const observed = captured.then(value => value, error => error)
  await opening
  expect(owned).toBeDefined()
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned?.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    const abandoned = operation.abandon().then(() => undefined, error => error)
    expect(await operation.cleanup.request()).toMatchObject({ attempt: 1, status: 'failed' })
    expect(deletions).toBe(1)
    const retry = coordinator.retryFailed([operation.cleanup])
    await barrier
    expect(deletions).toBe(1)
    const nestedError = new Error('late nested reader cleanup')
    let nestedAttempts = 0
    const nested = coordinator.cleanup.reader({ async dispose() { if (++nestedAttempts === 1) throw nestedError } })
    const nestedFirst = await nested.request()
    if (nestedFirst.status !== 'failed') throw new Error('Expected late nested failure')
    const incoming = accountCleanupOnlyFailure(nested, nestedFirst)
    rejectOpening(incoming)
    const rejected = await observed
    const failure = readAccountCleanupOnlyFailure(rejected)
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    expect(failure?.history).toHaveLength(1)
    const firstLocal = failure!.history![0]
    expect((rejected as Error).cause).toBe(firstLocal)
    expect(readAccountCleanupOnlyFailure(firstLocal)?.cleanup).toBe(operation.cleanup)
    expect(readAccountCleanupOnlyFailure(firstLocal)?.result.status).toBe('failed')
    expect(failure?.result.status === 'failed' ? failure.result.errors : []).toContain(nestedError)
    await retry
    await abandoned
    expect(deletions).toBe(2)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeUndefined()
    expect(await operation.cleanup.request()).toMatchObject({ attempt: 2, status: 'succeeded' })
  } finally { rejectOpening(new Error('test cleanup')); vi.restoreAllMocks() }
}, 30_000)

it.each([{ grouped: false, retried: false }, { grouped: true, retried: false }, { grouped: true, retried: true }])('managed C composes a nested failure after a direct cleanup request already failed locally (group=$grouped retry=$retried)', async ({ grouped, retried }) => {
  const cache = await import('../workspace/account-cache')
  const streams = await import('../workspace/account-streams')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  let reached!: () => void, rejectOpening!: (error: Error) => void
  const opening = new Promise<void>(resolve => { reached = resolve })
  const sourceFailure = new Promise<never>((_, reject) => { rejectOpening = reject })
  let owned: CipherRecord | undefined
  const stage = cache.stageAccountBytes, open = streams.openAccountSource
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation(async (...args) => { const record = await stage(...args); owned ??= record; return record })
  vi.spyOn(streams, 'openAccountSource').mockImplementationOnce(async (...args) => { await open(...args); reached(); return sourceFailure })
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const preparation = operation.prepare({}).then(value => value, error => error)
  await opening
  expect(owned).toBeDefined()
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned?.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    const first = await operation.cleanup.request()
    if (first.status !== 'failed') throw new Error('Expected local owner cleanup failure')
    expect(deletions).toBe(1)
    const nestedError = new Error('nested failure after local request')
    let nestedAttempts = 0
    const nestedReader = coordinator.cleanup.reader({ async dispose() { if (++nestedAttempts === 1) throw nestedError } })
    const nested = grouped ? coordinator.cleanup.group([nestedReader]) : nestedReader
    const nestedResult = await nested.request()
    if (nestedResult.status !== 'failed') throw new Error('Expected nested failure')
    const incoming = accountCleanupOnlyFailure(nested, nestedResult)
    if (retried) await coordinator.retryFailed([nested])
    rejectOpening(incoming)
    const rejected = await preparation
    const failure = readAccountCleanupOnlyFailure(rejected)
    expect((rejected as Error).cause).toBe(incoming)
    expect(failure?.history).toContain(incoming)
    expect(failure?.cleanup).toBe(operation.cleanup)
    const latest = failure?.result.status === 'failed' ? failure.result.errors : []
    expect(latest).toContain(first.errors[0])
    expect(latest.includes(nestedError)).toBe(!retried)
    expect(latest).toHaveLength(retried ? 1 : 2)
    expect(deletions).toBe(1)
    expect(await database.stagedCipherChunks.get([owned!.payloadId, 0])).toBeDefined()
  } finally { rejectOpening(new Error('test cleanup')); vi.restoreAllMocks() }
}, 30_000)

it('managed C retains a partly retried group history beside a distinct local failure', async () => {
  const streams = await import('../workspace/account-streams')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const historicalA = new Error('historical A'), historicalB = new Error('historical B'), local = new Error('factory local owner failure')
  let attemptsA = 0, attemptsB = 0, ownerAttempts = 0
  const nestedA = coordinator.cleanup.reader({ async dispose() { if (++attemptsA === 1) throw historicalA } })
  const nestedB = coordinator.cleanup.reader({ async dispose() { attemptsB++; throw historicalB } })
  const nested = coordinator.cleanup.group([nestedA, nestedB])
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected historical group failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  await coordinator.retryFailed([nestedA])
  expect(nested.observe()).toMatchObject({ status: 'failed', errors: [historicalB] })
  let reached!: () => void, rejectOpening!: (error: Error) => void
  const opening = new Promise<void>(resolve => { reached = resolve })
  const sourceFailure = new Promise<never>((_, reject) => { rejectOpening = reject })
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementationOnce(async (...args) => { await open(...args); reached(); return sourceFailure })
  const managed = { ...coordinator.cleanup, owner(raw: import('../workspace/account-prepared-records').AccountPreparationOwner) {
    const abandon = raw.abandon.bind(raw)
    vi.spyOn(raw, 'abandon').mockImplementation(async () => { ownerAttempts++; await abandon(); throw local })
    return coordinator.cleanup.owner(raw)
  } }
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, managed)
  const preparation = operation.prepare({}).then(value => value, error => error)
  try {
    await opening
    expect(await operation.cleanup.request()).toMatchObject({ status: 'failed', errors: [local] })
    rejectOpening(incoming)
    const rejected = await preparation
    const carried = readAccountCleanupOnlyFailure(rejected)
    expect(carried?.cleanup).toBe(operation.cleanup)
    expect(carried?.result.status === 'failed' ? carried.result.errors : []).toEqual([local, historicalB])
    expect((rejected as Error).cause).toBe(incoming)
    expect(carried?.history?.[0]).toBe(incoming)
    expect((rejected as AggregateError).errors).toEqual([local, historicalB, historicalA])
    expect(readAccountCleanupOnlyFailure(incoming)?.result).toBe(first)
    expect(await operation.cleanup.request()).toMatchObject({ status: 'failed', errors: [local, historicalB] })
    expect([attemptsA, attemptsB, ownerAttempts]).toEqual([2, 1, 1])
    expect(await database.stagedCipherChunks.count()).toBe(0)
  } finally { rejectOpening(new Error('test cleanup')); vi.restoreAllMocks() }
}, 30_000)

it('managed C forwards the actual P3 opener composition group without restarting its readers', async () => {
  const streams = await import('../workspace/account-streams')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const nestedError = new Error('nested reader failure'), openerError = new Error('opener reader failure'), ownerError = new Error('factory owner failure')
  let nestedAttempts = 0, openerAttempts = 0, ownerAttempts = 0, readerRegistrations = 0
  const nested = coordinator.cleanup.reader({ async dispose() { nestedAttempts++; throw nestedError } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected nested reader failure')
  const incoming = accountCleanupOnlyFailure(nested, first)
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementationOnce(async (...args) => { await open(...args); throw incoming })
  let openerJoin: import('../workspace/account-cleanup-attempt').AccountCleanupJoin | undefined
  const managed = { ...coordinator.cleanup,
    owner(raw: import('../workspace/account-prepared-records').AccountPreparationOwner) {
      const abandon = raw.abandon.bind(raw)
      vi.spyOn(raw, 'abandon').mockImplementation(async () => { ownerAttempts++; await abandon(); throw ownerError })
      return coordinator.cleanup.owner(raw)
    },
    reader(raw: { dispose(): Promise<void> }) {
      const join = coordinator.cleanup.reader(raw)
      if (++readerRegistrations === 2) {
        openerJoin = join
        const dispose = raw.dispose.bind(raw)
        vi.spyOn(raw, 'dispose').mockImplementation(async () => { openerAttempts++; await dispose(); throw openerError })
      }
      return join
    },
  }
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, managed)
  const rejected = await operation.prepare({}).then(value => value, error => error)
  const carried = readAccountCleanupOnlyFailure(rejected)
  expect(carried?.cleanup).toBe(operation.cleanup)
  expect(carried?.result.status === 'failed' ? carried.result.errors : []).toEqual([ownerError, openerError, nestedError])
  const openerCarrier = carried?.history?.[0]
  expect((rejected as Error).cause).toBe(openerCarrier)
  const openerFailure = readAccountCleanupOnlyFailure(openerCarrier)
  expect(openerFailure?.result.status === 'failed' ? openerFailure.result.errors : []).toEqual([openerError, nestedError])
  expect(openerFailure?.history?.[0]).toBe(incoming)
  expect(readAccountCleanupOnlyFailure(incoming)?.result).toBe(first)
  expect(await openerJoin?.request()).toMatchObject({ attempt: 1, status: 'failed', errors: [openerError] })
  expect([nestedAttempts, openerAttempts, ownerAttempts]).toEqual([1, 1, 1])
  expect(await database.stagedCipherChunks.count()).toBe(0)
}, 30_000)

it('managed C returns its first carrier when a late group re-observes the same failed owner', async () => {
  const cache = await import('../workspace/account-cache')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { accountCleanupOnlyFailure, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  let reached!: () => void, release!: () => void
  const written = new Promise<void>(resolve => { reached = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  let incoming: Error | undefined, owned: CipherRecord | undefined, ownerJoin: import('../workspace/account-cleanup-attempt').AccountCleanupJoin | undefined
  const stage = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => {
    owned = await stage(...args); reached(); await blocked; throw incoming
  })
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const managed = { ...coordinator.cleanup, owner(raw: import('../workspace/account-prepared-records').AccountPreparationOwner) {
    ownerJoin = coordinator.cleanup.owner(raw); return ownerJoin
  } }
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, managed)
  const preparation = operation.prepare({}).then(value => value, error => error)
  await written
  const remove = IDBObjectStore.prototype.delete
  let deletions = 0
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = remove.call(this, key)
    if (this.name === 'stagedCipherChunks' && Array.isArray(key) && key[0] === owned?.payloadId && ++deletions === 1) this.transaction.abort()
    return request
  })
  try {
    const abandoned = operation.abandon().then(() => undefined, error => error)
    const first = await operation.cleanup.request()
    expect(first.status).toBe('failed')
    const duplicate = coordinator.cleanup.group([ownerJoin!])
    const duplicateResult = await duplicate.request()
    if (duplicateResult.status !== 'failed') throw new Error('Expected group to observe failed owner')
    incoming = accountCleanupOnlyFailure(duplicate, duplicateResult)
    release()
    const rejected = await preparation
    const firstLocal = await abandoned
    expect(rejected).toBe(firstLocal)
    expect(readAccountCleanupOnlyFailure(rejected)?.history).toBeUndefined()
    expect(deletions).toBe(1)
    await coordinator.retryFailed([operation.cleanup])
    expect(deletions).toBe(2)
  } finally { release(); vi.restoreAllMocks() }
}, 30_000)

it.each([false, true])('managed C cleanup after D adoption leaves the transferred parent and its reader live (nonempty=%s)', async nonempty => {
  const inactive = await import('../workspace/account-inactive-graph')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountSource } = await import('../workspace/account-streams')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  const blank = await inactive.createBlankInactiveAccountWorkspacePreparation(database, token).prepare()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token, coordinator.cleanup)
  const child = await operation.prepare({ additions: nonempty ? [snapshot] : [] })
  const parent = createAccountPreparationOwner(database, token)
  const parentRecord = await stageAccountBytes(database, token, new Uint8Array([81, 82, 83]), [], undefined, parent)
  const parentReader = (await openAccountSource(database, token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
  const held = (await parentReader.next()).value as Uint8Array
  let adopted: evidence.AccountInheritedEvidence | undefined
  try {
    adopted = await inactive.adoptInactiveAccountEvidence(database, token, child, parent, blank.opened)
    await operation.abandon()
    expect(held).toEqual(new Uint8Array([81, 82, 83]))
    expect(() => parent.check()).not.toThrow()
    expect((await evidence.accountInheritedSources(adopted)).members.map(member => member.id)).toEqual(nonempty ? snapshot.historicalEvidence.snapshots.map(member => member.id) : [])
    expect(await database.stagedCipherChunks.get([child.records[0].payloadId, 0])).toBeDefined()
    expect(await database.stagedCipherChunks.get([parentRecord.payloadId, 0])).toBeDefined()
  } finally {
    await adopted?.dispose()
    await parentReader.return?.()
    await parent.abandon()
    await blank.opened.dispose()
    await blank.owner.abandon()
    await disposeWorkspaceSnapshot(snapshot)
  }
}, 30_000)

it('waits for a pending write and prevents late success when abandoned', async () => {
  const cache = await import('../workspace/account-cache')
  const { database, token } = account()
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const actual = cache.stageAccountBytes
  vi.spyOn(cache, 'stageAccountBytes').mockImplementationOnce(async (...args) => { const record = await actual(...args); started(); await blocked; return record })
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  const pending = operation.prepare({}).then(() => 'late success', () => 'rejected')
  await began
  let complete = false
  const cleanup = operation.abandon().then(() => { complete = true })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(complete).toBe(false)
  release()
  await cleanup
  expect(await pending).toBe('rejected')
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('cancels a blocked source through the abort signal and leaves the caller-owned snapshot alive', async () => {
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source]), captured = capturedBackupEvidence(snapshot)
  const [id, metadata] = [...captured.historical][0]
  let release!: () => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { release = resolve })
  const replacement = { byteLength: metadata.byteLength, open() { return { [Symbol.asyncIterator]() { return {
    async next() { started(); await blocked; return { done: true as const, value: undefined } },
    async return() { release(); return { done: true as const, value: undefined } },
  } } } } }
  ;(captured.historical as Map<string, typeof metadata>).set(id, replacement)
  const controller = new AbortController(), operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  const pending = operation.prepare({ additions: [snapshot], signal: controller.signal }).then(() => false, () => true)
  await began; controller.abort()
  const settled = await Promise.race([pending, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  release(); await pending; await operation.abandon()
  expect(settled).toBe(true)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  await import('../workspace/snapshot').then(module => module.assertOwnedWorkspaceSnapshot(snapshot))
  await disposeWorkspaceSnapshot(snapshot)
})

it.each(['source', 'quota', 'profile', 'overlay', 'freshness'] as const)('isolates allocations and caller state on %s failure', async kind => {
  const cache = await import('../workspace/account-cache'), snapshots = await import('../workspace/snapshot'), closure = await import('../workspace/closure')
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source])
  const retained = await cache.stageAccountBytes(database, token, new Uint8Array([91]), [])
  await database.encryptedRevisions.add(retained)
  const before = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
  if (kind === 'source') {
    const captured = capturedBackupEvidence(snapshot), [id, metadata] = [...captured.historical][0]
    ;(captured.historical as Map<string, typeof metadata>).set(id, { byteLength: metadata.byteLength, async *open() { for await (const page of metadata.open()) { yield page; throw new Error('synthetic source read failure') } } })
  }
  if (kind === 'quota') {
    const add = IDBObjectStore.prototype.add
    let writes = 0
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) { if (this.name === 'stagedCipherChunks' && ++writes === 3) throw new DOMException('synthetic quota', 'QuotaExceededError'); return add.call(this, value, key) })
  }
  let rootPayload: string | undefined
  if (kind === 'profile' || kind === 'overlay') {
    const stage = cache.stageAccountBytes
    vi.spyOn(cache, 'stageAccountBytes').mockImplementation(async (...args) => {
      const record = await stage(...args)
      if (new TextDecoder().decode(args[2]).includes('"kind":"inherited-snapshot-evidence"')) { rootPayload = record.payloadId; if (kind === 'profile') invalidateProfile() }
      return record
    })
  }
  if (kind === 'overlay') {
    const get = database.stagedCipherChunks.get.bind(database.stagedCipherChunks)
    vi.spyOn(database.stagedCipherChunks, 'get').mockImplementation(((key: [string, number]) => get(key).then(row => row && row.payloadId === rootPayload ? { ...row, bytes: new Uint8Array(row.bytes.length) } : row)) as typeof database.stagedCipherChunks.get)
  }
  if (kind === 'freshness') {
    let stale = false
    const validate = closure.withImmutableWorkspaceBodyValidation, owned = snapshots.assertOwnedWorkspaceSnapshot
    vi.spyOn(closure, 'withImmutableWorkspaceBodyValidation').mockImplementation(async (...args) => { const result = await validate(...args); stale = true; return result })
    vi.spyOn(snapshots, 'assertOwnedWorkspaceSnapshot').mockImplementation(async value => { await owned(value); if (stale) throw new Error('synthetic final source freshness failure') })
  }
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  await expect(operation.prepare({ additions: [snapshot] })).rejects.toThrow()
  vi.restoreAllMocks()
  await operation.abandon()
  expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(before)
  await snapshots.assertOwnedWorkspaceSnapshot(snapshot)
  await disposeWorkspaceSnapshot(snapshot)
})

it('snapshots original stream references before asynchronous ownership checks and excludes current-only bodies', async () => {
  const { database, token } = account(), source = await original()
  const currentBody = { ref: { ...source.state.blobs[0].ref, documentId: 'current-only' }, content: source.state.blobs[0].content }
  const current = { ...source, state: { ...source.state, blobs: [currentBody, ...source.state.blobs.slice(2)] } }
  const snapshot = await inheritWorkspaceSnapshot(current, [source])
  const captured = capturedBackupEvidence(snapshot), originals = new Map(captured.historical)
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  const pending = operation.prepare({ additions: [snapshot] })
  const changed = { byteLength: 0, async *open() { throw new Error('retargeted historical stream'); yield new Uint8Array() } }
  for (const id of captured.historical.keys()) (captured.historical as Map<string, typeof changed>).set(id, changed)
  const prepared = await pending
  const sources = await evidence.accountInheritedSources(prepared.handle)
  expect(sources.bodies.some(body => body.ref.documentId === 'current-only')).toBe(false)
  expect(sources.bodies.filter(body => body.ref.revisionId === 'same-bytes')).toHaveLength(2)
  for (const member of sources.members) expect(await pages(member.metadata)).toEqual(await pages(originals.get(member.id)!))
  await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

it('rejects contradictory same-ID originals and byte-identical full-ref changes before returning a graph', async () => {
  const { database, token } = account(), source = await original()
  const left = await inheritWorkspaceSnapshot(source, [source]), right = await inheritWorkspaceSnapshot(source, [source])
  const captured = capturedBackupEvidence(right), [id, metadata] = [...captured.historical][0]
  const originalPages = await pages(metadata)
  const raw = JSON.parse(new TextDecoder().decode(originalPages[0])) as unknown[]
  const changed = new TextEncoder().encode(JSON.stringify(raw).replace('synthetic-C-history', 'synthetic-C-changed'))
  ;(captured.historical as Map<string, typeof metadata>).set(id, { byteLength: changed.length, async *open() { yield changed } })
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [left, right] })).rejects.toThrow(/Contradictory/)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  ;(captured.historical as Map<string, typeof metadata>).set(id, metadata)
  const body = captured.blobs[0]
  ;(captured.blobs as { ref: typeof body.ref; content: typeof body.content }[])[0] = { ...body, ref: { ...body.ref, encoding: 'utf8' } }
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [left, right] })).rejects.toThrow(/Contradictory/)
  expect(await database.stagedCipherChunks.count()).toBe(0)
  await disposeWorkspaceSnapshot(left); await disposeWorkspaceSnapshot(right)
})

it('rejects an orphan body and unsorted members with authenticated exact descriptor edges', async () => {
  const { database, token, snapshot, prepared } = await installedFixture()
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const native = new Uint8Array([1]), extra = await stageAccountBytes(database, token, native, [])
  await database.encryptedRevisions.add(extra)
  const source = { documentId: 'zzzz-orphan', revisionId: 'native', encoding: 'bytes', byteLength: 1, sha256: await hashBlob(memoryBlob(native)) }
  const root = await rewrite(prepared, database, token, (value, refs) => { if (value.kind === 'evidence-blob-page') { value.entries!.push({ source, content: cipherRef(extra) }); refs.push(cipherRef(extra)) } })
  await expect(evidence.openAccountInheritedEvidence(database, token, root)).rejects.toThrow(/Orphan/)
  const raw = await original(), two = await inheritWorkspaceSnapshot(raw, [raw, { ...raw, snapshotId: 'another-member' }])
  const result = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [two] })
  await database.encryptedRevisions.bulkAdd([...result.records])
  const unsorted = await rewrite(result, database, token, value => { if (value.kind === 'evidence-member-page') value.entries!.reverse() })
  await expect(evidence.openAccountInheritedEvidence(database, token, unsorted)).rejects.toThrow(/Unsorted/)
  await result.dispose(); await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot); await disposeWorkspaceSnapshot(two)
})

it('rejects an oversized declared page before reading or allocating its plaintext', async () => {
  const { database, token } = account()
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const record = await stageAccountBytes(database, token, new Uint8Array(256 * 1024 + 1), [])
  await database.encryptedRevisions.add(record)
  const get = vi.spyOn(database.stagedCipherChunks, 'get')
  await expect(evidence.openAccountInheritedEvidence(database, token, cipherRef(record))).rejects.toThrow(/size/)
  expect(get).not.toHaveBeenCalled()
})

it('clears lazy metadata buffers on profile invalidation and leaves adopted allocations with the parent after reopen failure', async () => {
  const { database, token } = account(), source = await original()
  const snapshot = await inheritWorkspaceSnapshot(source, [source])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const parent = createAccountPreparationOwner(database, token)
  await prepared.handle.dispose(); await parent.adopt(prepared.owner)
  const opened = await evidence.openAccountInheritedEvidence(database, token, prepared.root, parent)
  const iterator = (await evidence.accountInheritedSources(opened)).members[0].metadata.open()[Symbol.asyncIterator]()
  const bytes = (await iterator.next()).value as Uint8Array
  const root = prepared.records.at(-1)!, chunk = (await database.stagedCipherChunks.get([root.payloadId, 0]))!
  const corrupted = chunk.bytes.slice(); corrupted[0] ^= 1
  await database.stagedCipherChunks.put({ ...chunk, bytes: corrupted })
  const before = await database.stagedCipherChunks.toArray()
  await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root, parent)).rejects.toThrow()
  await prepared.dispose()
  expect(await database.stagedCipherChunks.toArray()).toEqual(before)
  expect(bytes.some(byte => byte !== 0)).toBe(true)
  invalidateProfile()
  expect(bytes.every(byte => byte === 0)).toBe(true)
  await expect(iterator.next()).rejects.toThrow()
  await opened.dispose(); await parent.abandon(); await disposeWorkspaceSnapshot(snapshot)
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('retains a historical-only native mod original outside current workspace blobs', async () => {
  const { database, token } = account(), current = await original()
  const bytes = new TextEncoder().encode('{"Name":"synthetic-private-mod-C","Description":"inert original"}')
  const content = memoryBlob(bytes), ref = { documentId: 'native-mod-original', revisionId: 'mod-revision', encoding: 'utf8' as const, byteLength: bytes.length, sha256: await hashBlob(content) }
  const file = current.state.editorDocuments[0]
  const historical = { ...current, state: { ...current.state, blobs: [...current.state.blobs, { ref, content }], editorDocuments: [{ ...file, filename: 'synthetic-mod.json', original: ref, originalByteIdentity: 'exact' as const, lastApplied: ref }] } }
  const snapshot = await inheritWorkspaceSnapshot(current, [historical])
  expect(snapshot.state.blobs.some(body => body.ref.documentId === ref.documentId)).toBe(false)
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  await database.encryptedRevisions.bulkAdd([...prepared.records])
  await disposeWorkspaceSnapshot(snapshot); await prepared.dispose()
  const reopened = await evidence.openAccountInheritedEvidence(database, token, prepared.root)
  const sources = await evidence.accountInheritedSources(reopened)
  expect(await readBlob(sources.bodies.find(body => body.ref.documentId === ref.documentId)!.content, bytes.length)).toEqual(bytes)
  expect((await readBackupMetadata(sources.members[0].metadata) as import('../interchange/workspace-backup-evidence').SnapshotMetadataV1).state.editorDocuments[0].filename).toBe('synthetic-mod.json')
  await reopened.dispose()
})

it('rejects cryptographically valid nonfinal ciphertext rather than trusting descriptor presence', async () => {
  const { database, token } = account()
  const members = await putJson(database, token, { version: 1, kind: 'evidence-member-page', entries: [], children: [] }, [])
  const { getSodium } = await import('../account/crypto/sodium')
  const sodium = await getSodium(), push = sodium.crypto_secretstream_xchacha20poly1305_push
  vi.spyOn(sodium, 'crypto_secretstream_xchacha20poly1305_push').mockImplementation((state, message, additionalData, _tag, format) => push(state, message, additionalData, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE, format))
  const root = await emptyRoot(database, token, members)
  vi.restoreAllMocks()
  await expect(evidence.openAccountInheritedEvidence(database, token, root)).rejects.toThrow()
})

it('rejects a missing late native chunk and zeroes the early lazy plaintext', async () => {
  const { database, token } = account(), source = await original()
  const { plainChunkBytes } = await import('../account/protocol')
  const content = memoryBlob(new Uint8Array(plainChunkBytes + 1).fill(57))
  const ref = { documentId: 'aa-large-native', revisionId: 'multi-chunk', encoding: 'bytes' as const, byteLength: content.byteLength, sha256: await hashBlob(content) }
  const historical = { ...source, state: { ...source.state, blobs: [...source.state.blobs, { ref, content }] } }
  const snapshot = await inheritWorkspaceSnapshot(source, [historical])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  const sources = await evidence.accountInheritedSources(prepared.handle)
  const record = prepared.records.find(record => record.descriptor.plainBytes === content.byteLength)!
  await database.stagedCipherChunks.delete([record.payloadId, 1])
  const iterator = sources.bodies.find(body => body.ref.documentId === ref.documentId)!.content.open()[Symbol.asyncIterator]()
  const bytes = (await iterator.next()).value as Uint8Array
  expect(bytes[0]).toBe(57)
  await expect(iterator.next()).rejects.toThrow()
  expect(bytes.every(byte => byte === 0)).toBe(true)
  await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
}, 30_000)

it.each(['typed root', 'raw segment', 'lazy native body'])('pins the captured descriptor before decrypting a replacement %s', async role => {
  const { readAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { withAccountKey } = await import('../account/profile')
  const { encryptRevision } = await import('../account/crypto/revisions')
  const { database, token, snapshot, prepared } = await installedFixture()
  const handle = role === 'lazy native body' ? await evidence.openAccountInheritedEvidence(database, token, prepared.root) : undefined
  const sources = handle ? await evidence.accountInheritedSources(handle) : undefined
  let target = prepared.records.at(-1)!
  if (role !== 'typed root') {
    for (const record of prepared.records) {
      const bytes = await readAccountBytes(database, token, cipherRef(record))
      const text = new TextDecoder().decode(bytes)
      if (role === 'raw segment' ? text.startsWith('[[') : text === 'synthetic-private-native-C-marker') { target = record; break }
    }
    expect(target).not.toBe(prepared.records.at(-1))
  }
  const bytes = await readAccountBytes(database, token, cipherRef(target)), payloadId = accountLocalId(), descriptor = target.descriptor
  const encrypted = await withAccountKey(token, key => encryptRevision(key, {
    format: 1, accountId: token.accountId, documentId: descriptor.documentId, revisionId: descriptor.revisionId,
    parents: descriptor.parents, dependencies: role === 'raw segment' ? [prepared.root] : descriptor.dependencies,
    protected: role !== 'typed root', plainBytes: bytes.length,
  }, accountLocalId(), memoryBlob(bytes).open(), { id: payloadId, async write(index, bytes) { await database.stagedCipherChunks.add({ payloadId, index, bytes }) } }))
  await prepared.dispose()
  const replacementResolution = handle ? 2 : role === 'typed root' ? 3 : 4
  let resolutions = 0
  const get = database.encryptedRevisions.get.bind(database.encryptedRevisions)
  const spy = vi.spyOn(database.encryptedRevisions, 'get').mockImplementation(async function (...args: unknown[]) {
    if (args[0] === target.revisionId && ++resolutions === replacementResolution) {
      await database.encryptedRevisions.put({ revisionId: target.revisionId, payloadId, descriptor: encrypted.descriptor })
    }
    return get(...args as Parameters<typeof get>)
  } as typeof database.encryptedRevisions.get)
  if (sources) {
    const source = sources.bodies.find(body => body.ref.documentId === 'aa-alias')!.content
    await expect(source.open()[Symbol.asyncIterator]().next()).rejects.toThrow(/changed/)
  } else await expect(evidence.openAccountInheritedEvidence(database, token, prepared.root)).rejects.toThrow(/changed/)
  spy.mockRestore()
  expect(resolutions).toBe(replacementResolution)
  await handle?.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

it.each(['base', 'addition'])('reserves original pages cumulatively before decoding an addition after a %s', async firstKind => {
  const { historicalMetadataIdentity, metadataSource, joinWorkspaceSnapshotEvidence } = await import('../interchange/workspace-backup-evidence')
  const { ownWorkspaceSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
  const { database, token } = account(), source = await original()
  const make = async (snapshotId: string) => {
    const value = { ...source, snapshotId }
    const tokens = (await pages(metadataSource(snapshotMetadata(value)))).flatMap(bytes => JSON.parse(new TextDecoder().decode(bytes)) as unknown[])
    const parts = tokens.map(token => new TextEncoder().encode(JSON.stringify([token])))
    const metadata = { byteLength: parts.reduce((sum, part) => sum + part.length, 0), async *open() { for (const part of parts) yield part.slice() } }
    const id = (await historicalMetadataIdentity(metadata)).id
    const snapshot = await joinWorkspaceSnapshotEvidence(ownWorkspaceSnapshot(value, { async check() {}, async dispose() {} }), { members: [{ id, metadata, subset: source.state.blobs.map(body => body.ref) }], bodies: source.state.blobs })
    return { snapshot, count: parts.length }
  }
  const first = await make('first-budget-member'), second = await make('second-budget-member')
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [first.snapshot] })
  limits.frames = prepared.records.length + 10
  const copy = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ base: prepared.handle, additions: [first.snapshot, first.snapshot] })
  await copy.dispose()
  let delivered = 0
  const captured = capturedBackupEvidence(second.snapshot)
  for (const [id, metadata] of captured.historical) (captured.historical as Map<string, typeof metadata>).set(id, { byteLength: metadata.byteLength, async *open() {
    for await (const bytes of metadata.open()) { delivered++; yield bytes }
  } })
  limits.frames = first.count + 20
  await expect(evidence.createAccountInheritedEvidencePreparation(database, token).prepare(firstKind === 'base'
    ? { base: prepared.handle, additions: [second.snapshot] }
    : { additions: [first.snapshot, second.snapshot] })).rejects.toThrow(/resource limit/)
  expect(delivered).toBeGreaterThan(0)
  expect(delivered).toBeLessThanOrEqual(21)
  Object.assign(limits, defaultLimits)
  await prepared.dispose(); await disposeWorkspaceSnapshot(first.snapshot); await disposeWorkspaceSnapshot(second.snapshot)
}, 30_000)

it.each([false, true])('rejects physical authentication admission after lifetime retirement (installed=%s)', async installed => {
  const profile = await import('../account/profile')
  const streams = await import('../workspace/account-streams')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({})
  if (installed) await database.encryptedRevisions.bulkAdd([...prepared.records])
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  let join!: import('../workspace/account-cleanup-attempt').AccountCleanupJoin
  let disposal: ReturnType<typeof join.request> | undefined
  let armed = false, retired = false, attempts = 0
  let openedAfterRetirement = 0, startedAfterRetirement = 0, decryptedAfterRetirement = 0
  const assert = profile.assertActiveProfile
  vi.spyOn(profile, 'assertActiveProfile').mockImplementation(value => {
    assert(value)
    if (armed) {
      armed = false
      // Retire after the awaited freshness check passes but before its caller resumes
      queueMicrotask(() => queueMicrotask(() => { retired = true; disposal = join.request() }))
    }
  })
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    armed = true
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      if (retired) openedAfterRetirement++
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() {
        if (retired) startedAfterRetirement++
        const next = await input.next()
        if (retired && !next.done) decryptedAfterRetirement += next.value.length
        return next
      }, async return() { return input.return!() }, [Symbol.asyncIterator]() { return this } }
    } }
  })
  try {
    const rejected = await evidence.openAccountInheritedEvidence(database, token, prepared.root, installed ? undefined : prepared.owner, { ...cleanup, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { attempts++; return dispose() })
      join = cleanup.reader(raw); return join
    } }).then(value => value, error => error)
    expect(rejected).toMatchObject({ message: 'Account evidence handle was released' })
    expect(retired).toBe(true)
    const first = await disposal
    expect(first).toMatchObject({ status: 'succeeded', attempt: 1 })
    expect(await join.request()).toBe(first)
    expect(attempts).toBe(1)
    expect({ openedAfterRetirement, startedAfterRetirement, decryptedAfterRetirement }).toEqual({ openedAfterRetirement: 0, startedAfterRetirement: 0, decryptedAfterRetirement: 0 })
    expect(() => prepared.owner.check()).not.toThrow()
    expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
  } finally { vi.restoreAllMocks(); await prepared.dispose() }
})

it.each([{ installed: false, profile: false, failing: true }, { installed: true, profile: false, failing: true }, { installed: true, profile: true, failing: true }, { installed: true, profile: false, failing: false }])('managed C owns pre-return physical streams (%j)', async ({ installed, profile, failing }) => {
  const streams = await import('../workspace/account-streams')
  const { createAccountCleanupCoordinator, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  if (installed) await database.encryptedRevisions.bulkAdd([...prepared.records])
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  const joins: import('../workspace/account-cleanup-attempt').AccountCleanupJoin[] = []
  let attempts = 0, returns = 0, decrypted = 0
  let held: Uint8Array | undefined
  let reached!: () => void, resume!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve }), release = new Promise<void>(resolve => { resume = resolve })
  const cleanupError = new Error('physical return failure'), primary = new Error('physical return failure')
  const managed = { ...cleanup, reader(raw: { dispose(): Promise<void> }) {
    const dispose = raw.dispose.bind(raw)
    vi.spyOn(raw, 'dispose').mockImplementation(() => { attempts++; return dispose() })
    const join = cleanup.reader(raw); joins.push(join); return join
  } }
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() {
        const next = await input.next()
        if (!next.done) { held = next.value; decrypted += next.value.length; reached(); await release; throw primary }
        return next
      }, async return() {
        await input.return?.(); returns++
        if (failing && returns === 1) throw cleanupError
        return { done: true as const, value: undefined }
      }, [Symbol.asyncIterator]() { return this } }
    } }
  })
  const opening = evidence.openAccountInheritedEvidence(database, token, prepared.root, installed ? undefined : prepared.owner, managed).then(value => value, error => error)
  await paused
  expect(decrypted).toBeGreaterThan(0)
  if (profile) invalidateProfile()
  const first = await joins[0].request()
  // Release before assertions so a failing RED cannot strand a real reader
  resume()
  const rejected = await opening
  expect(held!.every(byte => byte === 0)).toBe(true)
  expect(first).toMatchObject({ attempt: 1, status: failing ? 'failed' : 'succeeded' })
  if (first.status === 'failed') {
    expect((first.errors[0] as AggregateError).errors).toEqual([cleanupError])
    expect(readAccountPreparationFailure(rejected)?.cleanup).toBe(joins[0])
    expect(readAccountPreparationFailure(rejected)?.primary).toBe(primary)
  } else expect(rejected).toBe(primary)
  expect(attempts).toBe(1)
  expect(await joins[0].request()).toBe(first)
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
  if (!profile) expect(() => prepared.owner.check()).not.toThrow()
  vi.restoreAllMocks()
  await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

it.each(['body', 'metadata'] as const)('openedEvidenceProfileCallbackJoinsItsManagedDisposer (%s)', async kind => {
  const streams = await import('../workspace/account-streams')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  await database.encryptedRevisions.bulkAdd([...prepared.records])
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  let join!: import('../workspace/account-cleanup-attempt').AccountCleanupJoin, attempts = 0, returns = 0
  const opened = await evidence.openAccountInheritedEvidence(database, token, prepared.root, undefined, { ...cleanup, reader(raw) {
    const dispose = raw.dispose.bind(raw)
    vi.spyOn(raw, 'dispose').mockImplementation(() => { attempts++; return dispose() })
    join = cleanup.reader(raw); return join
  } })
  const sources = await evidence.accountInheritedSources(opened), cleanupError = new Error('physical return failure')
  // A body is suspended at its physical yield; metadata must be held during segment input
  // because a fully reconstructed page has already released its transport iterator
  let reached!: () => void, resume!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve }), release = new Promise<void>(resolve => { resume = resolve })
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() {
        const next = await input.next()
        if (kind === 'metadata' && !next.done) { reached(); await release }
        return next
      }, async return() {
        await input.return?.(); returns++; resume()
        if (returns === 1) throw cleanupError
        return { done: true as const, value: undefined }
      }, [Symbol.asyncIterator]() { return this } }
    } }
  })
  const iterator = (kind === 'body' ? sources.bodies[0].content : sources.members[0].metadata).open()[Symbol.asyncIterator]()
  const reading = iterator.next().then(value => value, error => error)
  const held = kind === 'body' ? (await reading).value as Uint8Array : undefined
  if (held) expect(held.some(byte => byte !== 0)).toBe(true)
  else await paused
  invalidateProfile()
  // GraphReader's pending next is owned by the returned wrapper, whose outer return queues
  // behind it; release the test-only barrier without claiming arbitrary producer termination
  resume()
  const first = await join.wait()
  expect(first).toMatchObject({ attempt: 1, status: kind === 'body' ? 'failed' : 'succeeded' })
  expect(attempts).toBe(1)
  if (held) expect(held.every(byte => byte === 0)).toBe(true)
  if (kind === 'body') {
    const rejected = await opened.dispose().catch(error => error)
    expect(rejected).toBeInstanceOf(AggregateError)
    expect(readAccountCleanupOnlyFailure(rejected)).toEqual({ cleanup: join, result: first })
    expect(readAccountPreparationFailure(rejected)).toBeUndefined()
  }
  else {
    // Natural iterator closing preserves the read's revocation primary even if return
    // also rejects; successful cancellation is not a failed resource disposal
    expect(await reading).toMatchObject({ message: 'Account evidence handle was released' })
    await opened.dispose()
  }
  expect(await join.request()).toBe(first)
  expect(attempts).toBe(1)
  await reading
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
  vi.restoreAllMocks(); await prepared.dispose(); await disposeWorkspaceSnapshot(snapshot)
})

it('managed C child cleanup failure leaves a separate staged parent and held plaintext available', async () => {
  const streams = await import('../workspace/account-streams')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { createAccountCleanupCoordinator, readAccountCleanupOnlyFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account(), native = await original()
  const snapshot = await inheritWorkspaceSnapshot(native, [native])
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  const parent = createAccountPreparationOwner(database, token)
  const parentRecord = await stageAccountBytes(database, token, new Uint8Array([71, 72, 73]), [], undefined, parent)
  const parentIterator = (await streams.openAccountSource(database, token, cipherRef(parentRecord), parent)).open()[Symbol.asyncIterator]()
  const parentBytes = (await parentIterator.next()).value as Uint8Array
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  let opened: Awaited<ReturnType<typeof evidence.openAccountInheritedEvidence>> | undefined
  let childIterator: AsyncIterator<Uint8Array> | undefined
  const cleanupError = new Error('child physical return failure')
  let join: import('../workspace/account-cleanup-attempt').AccountCleanupJoin | undefined, attempts = 0, failedReturns = 0
  try {
    // The preparation factory's original C handle is standalone; the exact staged root is
    // reopened as a separate managed child while neither owner has transferred authority
    await prepared.handle.dispose()
    opened = await evidence.openAccountInheritedEvidence(database, token, prepared.root, prepared.owner, { ...cleanup, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(() => { attempts++; return dispose() })
      join = cleanup.reader(raw); return join
    } })
    const sources = await evidence.accountInheritedSources(opened)
    const body = sources.bodies[0]
    const real = streams.openAccountSource
    let selected = false
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await real(...args)
      if (selected) return source
      selected = true
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { next: () => input.next(), async return() {
          await input.return?.()
          if (failedReturns++ === 0) throw cleanupError
          return { done: true as const, value: undefined }
        }, [Symbol.asyncIterator]() { return this } }
      } }
    })
    childIterator = body.content.open()[Symbol.asyncIterator]()
    const childBytes = (await childIterator.next()).value as Uint8Array
    expect(childBytes.some(byte => byte !== 0)).toBe(true)
    expect(parentBytes).toEqual(new Uint8Array([71, 72, 73]))
    const rejected = await opened.dispose().catch(error => error)
    const only = readAccountCleanupOnlyFailure(rejected)
    expect(only?.cleanup).toBe(join)
    expect(only?.result.status).toBe('failed')
    expect(only?.result.status === 'failed' ? (only.result.errors[0] as AggregateError).errors[0] : undefined).toBe(cleanupError)
    expect(childBytes.every(byte => byte === 0)).toBe(true)
    expect(parentBytes).toEqual(new Uint8Array([71, 72, 73]))
    expect(attempts).toBe(1)
    const physicalReturns = failedReturns
    expect(physicalReturns).toBeGreaterThan(0)
    await expect(opened.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(attempts).toBe(1)
    expect(failedReturns).toBe(physicalReturns)
    expect((await join!.request()).attempt).toBe(1)
    expect(() => parent.check()).not.toThrow()
    expect(() => prepared.owner.check()).not.toThrow()
    const later = await stageAccountBytes(database, token, new Uint8Array([74]), [], undefined, parent)
    expect(await database.stagedCipherChunks.get([parentRecord.payloadId, 0])).toBeDefined()
    expect(await database.stagedCipherChunks.get([later.payloadId, 0])).toBeDefined()
  } finally {
    vi.restoreAllMocks()
    await childIterator?.return?.().catch(() => {})
    await parentIterator.return?.()
    await prepared.dispose()
    await parent.abandon()
    await disposeWorkspaceSnapshot(snapshot)
  }
})

it.each(['cleanup-only', 'historical-retry', 'historical-retry-local-failure', 'two-cleanups', 'foreign-cleanup', 'primary-undefined', 'literal-undefined'] as const)('C managed authentication distinguishes a nested cleanup failure from undefined primary (%s)', async kind => {
  const profile = await import('../account/profile')
  const streams = await import('../workspace/account-streams')
  const { accountCleanupOnlyFailure, accountPreparationFailure, createAccountCleanupCoordinator, readAccountCleanupOnlyFailure, readAccountPreparationFailure } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({})
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {}), { cleanup } = coordinator
  const nestedError = new Error('nested evidence cleanup')
  const owner = kind === 'foreign-cleanup' ? createAccountCleanupCoordinator(database, token, async () => {}).cleanup : cleanup
  let nestedAttempts = 0
  const nested = owner.reader({ async dispose() { if (++nestedAttempts === 1) throw nestedError } })
  const first = kind === 'literal-undefined' ? undefined : await nested.request()
  if (first && first.status !== 'failed') throw new Error('Expected nested cleanup failure')
  const incoming = kind === 'cleanup-only' || kind === 'historical-retry' || kind === 'historical-retry-local-failure' || kind === 'two-cleanups' || kind === 'foreign-cleanup' ? accountCleanupOnlyFailure(nested, first!) : kind === 'primary-undefined' ? accountPreparationFailure(undefined, nested) : undefined
  if (kind === 'historical-retry' || kind === 'historical-retry-local-failure') {
    await coordinator.retryFailed([nested])
    expect(nested.observe()).toEqual({ attempt: 2, status: 'succeeded' })
  }
  const active = profile.assertActiveProfile, open = streams.openAccountSource
  const localError = new Error('nested evidence cleanup')
  let armed = false, injected = false, decrypted = 0, localDisposals = 0
  try {
    vi.spyOn(profile, 'assertActiveProfile').mockImplementation(value => {
      active(value)
      if (armed && !injected) { injected = true; throw incoming }
    })
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await open(...args)
      return { ...source, open(): AsyncIterableIterator<Uint8Array> {
        const input = source.open()[Symbol.asyncIterator]()
        return { async next() {
          const next = await input.next()
          if (!next.done) { decrypted += next.value.length; armed = true }
          return next
        }, return: () => input.return?.() ?? Promise.resolve({ done: true as const, value: undefined }), [Symbol.asyncIterator]() { return this } }
      } }
    })
    const rejected = await evidence.openAccountInheritedEvidence(database, token, prepared.root, prepared.owner, { ...cleanup, reader(raw) {
      const dispose = raw.dispose.bind(raw)
      vi.spyOn(raw, 'dispose').mockImplementation(async () => { localDisposals++; await dispose(); if (kind === 'two-cleanups' || kind === 'historical-retry-local-failure') throw localError })
      return cleanup.reader(raw)
    } }).then(value => value, error => error)
    expect(decrypted).toBeGreaterThan(0)
    expect(injected).toBe(true)
    expect(localDisposals).toBe(1)
    if (kind === 'cleanup-only' || kind === 'historical-retry') {
      expect(rejected).toBe(incoming)
      expect(readAccountCleanupOnlyFailure(rejected)).toEqual({ cleanup: nested, result: first })
      expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    } else if (kind === 'foreign-cleanup') {
      expect(rejected).toBeInstanceOf(Error)
      expect((rejected as Error).message).toMatch(/Foreign or unregistered account cleanup join/)
      expect(readAccountCleanupOnlyFailure(rejected)).toBeUndefined()
    } else if (kind === 'historical-retry-local-failure') {
      const only = readAccountCleanupOnlyFailure(rejected)
      expect(only?.result.status === 'failed' ? only.result.errors : undefined).toEqual([localError])
      expect((rejected as AggregateError).errors).toEqual([localError, nestedError])
      expect((rejected as AggregateError).errors[0]).toBe(localError)
      expect((rejected as AggregateError).errors[1]).toBe(nestedError)
      expect((rejected as Error & { cause?: unknown }).cause).toBe(incoming)
      expect(only?.history).toEqual([incoming])
      expect(readAccountCleanupOnlyFailure(incoming)).toEqual({ cleanup: nested, result: first })
      expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    } else if (kind === 'two-cleanups') {
      const only = readAccountCleanupOnlyFailure(rejected)
      expect(only?.result.status === 'failed' ? only.result.errors : undefined).toEqual([localError, nestedError])
      expect(only?.result.status === 'failed' ? only.result.errors[0] : undefined).toBe(localError)
      expect(only?.result.status === 'failed' ? only.result.errors[1] : undefined).toBe(nestedError)
      expect(readAccountPreparationFailure(rejected)).toBeUndefined()
    } else if (kind === 'primary-undefined') {
      expect(readAccountPreparationFailure(rejected)?.primary).toBeUndefined()
      expect(readAccountPreparationFailure(rejected)?.cleanup).toBeDefined()
      expect(readAccountCleanupOnlyFailure(rejected)).toBeUndefined()
    } else expect(rejected).toBeUndefined()
    if (kind === 'historical-retry' || kind === 'historical-retry-local-failure') {
      expect((await nested.request()).status).toBe('succeeded')
      expect(nestedAttempts).toBe(2)
    } else if (first) expect(await nested.request()).toBe(first)
    expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
    expect(() => prepared.owner.check()).not.toThrow()
  } finally { vi.restoreAllMocks(); await prepared.dispose() }
})

it.each([false, true])('preserves authentication primary when natural iterator return also fails (managed=%s)', async managed => {
  const profile = await import('../account/profile')
  const streams = await import('../workspace/account-streams')
  const { createAccountCleanupCoordinator } = await import('../workspace/account-cleanup-attempt')
  const { database, token } = account()
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({})
  const primary = new Error('authentication primary'), cleanupError = new Error('natural return cleanup')
  let armed = false, injected = false, returned = false, decrypted = 0
  const assert = profile.assertActiveProfile
  vi.spyOn(profile, 'assertActiveProfile').mockImplementation(value => {
    assert(value)
    if (armed && !injected) { injected = true; throw primary }
  })
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() {
        const next = await input.next()
        if (!next.done) { decrypted += next.value.length; armed = true }
        return next
      }, async return() {
        await input.return?.(); returned = true
        throw cleanupError
      }, [Symbol.asyncIterator]() { return this } }
    } }
  })
  const cleanup = managed ? createAccountCleanupCoordinator(database, token, async () => {}).cleanup : undefined
  const rejected = await evidence.openAccountInheritedEvidence(database, token, prepared.root, prepared.owner, cleanup).then(value => value, error => error)
  expect(decrypted).toBeGreaterThan(0)
  expect(returned).toBe(true)
  expect(rejected).toBe(primary)
  vi.restoreAllMocks(); await prepared.dispose()
})

it('prepares exact captured sidecar sources directly and rejects structural or released authority', async () => {
  const { database, token } = account(), historical = await original()
  const snapshot = await inheritWorkspaceSnapshot(historical, [historical])
  const sourceEvidence = await guestEvidenceFromSnapshot(snapshot, emptyPlannerEvidence())
  const operation = evidence.createAccountInheritedEvidencePreparation(database, token)
  try {
    const prepared = await operation.prepare({ sourceEvidence })
    expect(prepared.handle.members).toEqual(snapshot.historicalEvidence.snapshots)
    const sources = await evidence.accountInheritedSources(prepared.handle)
    const expected = capturedBackupEvidence(snapshot)
    for (const member of sources.members) expect(await pages(member.metadata)).toEqual(await pages(expected.historical.get(member.id)!))
    for (const body of sources.bodies) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(expected.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength))
    const forged = evidence.createAccountInheritedEvidencePreparation(database, token)
    try { await expect(forged.prepare({ sourceEvidence: { ...sourceEvidence } })).rejects.toThrow(/captured/) }
    finally { await forged.abandon() }
    await disposeWorkspaceSnapshot(snapshot)
    const released = evidence.createAccountInheritedEvidencePreparation(database, token)
    try { await expect(released.prepare({ sourceEvidence })).rejects.toThrow() }
    finally { await released.abandon() }
  } finally { await operation.abandon(); await disposeWorkspaceSnapshot(snapshot) }
})

it('borrows only a live registered archive proof for native preparation and opening', async () => {
  const { prepareAccountWorkspaceWithExistingEvidence, openAccountWorkspace } = await import('../workspace/account-graph')
  const { database, token } = account(), historical = await original()
  const snapshot = await inheritWorkspaceSnapshot(historical, [historical])
  const owner = evidence.createAccountInheritedEvidencePreparation(database, token), other = evidence.createAccountInheritedEvidencePreparation(database, token)
  try {
    const archive = await owner.prepare({ additions: [snapshot] }), empty = await other.prepare({})
    await database.encryptedRevisions.bulkAdd([...archive.records, ...empty.records])
    const native = await prepareAccountWorkspaceWithExistingEvidence(database, token, historical.state, archive.handle)
    await database.encryptedRevisions.bulkAdd(native.records)
    expect((await openAccountWorkspace(database, token, native.head, archive.handle)).state.planner.localData).toEqual(historical.state.planner.localData)
    await expect(prepareAccountWorkspaceWithExistingEvidence(database, token, historical.state, { ...archive.handle })).rejects.toThrow(/registered/)
    await expect(openAccountWorkspace(database, token, native.head, { ...archive.handle })).rejects.toThrow(/registered/)
    await expect(openAccountWorkspace(database, token, native.head, empty.handle)).rejects.toThrow(/association/)
    await owner.abandon()
    await expect(openAccountWorkspace(database, token, native.head, archive.handle)).rejects.toThrow()
    expect((await openAccountWorkspace(database, token, native.head)).state.planner.localData).toEqual(historical.state.planner.localData)
  } finally { await owner.abandon(); await other.abandon(); await disposeWorkspaceSnapshot(snapshot) }
})
