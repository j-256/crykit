import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, type ProfileToken } from '../account/profile'
import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import { immutableCatalogSnapshot, isImmutableCatalogSnapshot } from '../interchange/native'
import * as localData from './local-data'
import * as closure from '../workspace/closure'
import * as documents from '../workspace/documents'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspaceWithExistingEvidence } from '../workspace/account-graph'
import { captureAccountSnapshot } from '../workspace/account-snapshot'
import * as evidence from '../workspace/account-evidence-snapshots'
import { disposeWorkspaceSnapshot, openHistoricalSnapshot, projectWorkspaceSnapshotV1, validateWorkspaceSnapshotV1 } from '../workspace/snapshot'
import { editorClosureFixture } from '../workspace/test-helpers'
import { readBlob } from '../workspace/blobs'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  invalidateProfile()
})

async function fixture(catalog = false) {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const token = installProfile(accountLocalId(), key.slice()), database = new AccountDatabase(token.accountId)
  cleanup.push(() => database.delete())
  const original = await editorClosureFixture()
  const state = { ...original.state, planner: { ...original.state.planner, catalogs: catalog ? [SYNTHETIC_RETAINED_CATALOG] : original.state.planner.catalogs }, editorDocuments: [original.file] }
  const source = { dataGeneration: LAUNCH_DATA_GENERATION, version: 1 as const, snapshotId: 'snapshot-proof-original', capturedAt: '2026-11-15', revisionVector: { synthetic: 'original' }, state }
  const snapshot = await inheritWorkspaceSnapshot(source, [source])
  cleanup.push(() => disposeWorkspaceSnapshot(snapshot))
  const prepared = await evidence.createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [snapshot] })
  await database.encryptedRevisions.bulkAdd([...prepared.records])
  await prepared.dispose()
  const handle = await evidence.openAccountInheritedEvidence(database, token, prepared.root)
  cleanup.push(() => handle.dispose())
  const current = await prepareAccountWorkspaceWithExistingEvidence(database, token, state, handle)
  const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: current.head, records: current.records })
  const check = async () => { if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(fence)) throw new Error('Captured fence changed') }
  const capture = async (validatedEvidence: evidence.AccountInheritedEvidence | undefined = handle, sourceToken: ProfileToken = token, sourceDatabase = database, assertSource = check) => {
    const source = { database: sourceDatabase, token: sourceToken, validatedEvidence }
    const result = await captureAccountSnapshot(current.opened, fence, assertSource, source)
    cleanup.push(() => disposeWorkspaceSnapshot(result))
    return result
  }
  return { database, token, key, current, fence, check, capture, handle, prepared, state }
}

it('borrows exact authenticated evidence without reopening and preserves caller ownership through snapshot disposal', async () => {
  const input = await fixture()
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  const captured = await input.capture()
  expect(open).not.toHaveBeenCalled()
  expect(captured.version).toBe(2)
  if (captured.version !== 2) throw new Error('Missing inherited snapshot')
  const original = await openHistoricalSnapshot(captured, captured.historicalEvidence.snapshots[0].id)
  try {
    expect(original.state.editorDocuments).toEqual(input.state.editorDocuments)
    for (const body of input.state.blobs) {
      const retained = original.state.blobs.find(value => value.ref.documentId === body.ref.documentId)!
      expect(await readBlob(retained.content, retained.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    }
  } finally { await disposeWorkspaceSnapshot(original) }
  await disposeWorkspaceSnapshot(captured)
  await expect(input.handle.check()).resolves.toBeUndefined()
})

it('opens fresh evidence for absent proof and a genuinely different complete root, disposing only the local handle', async () => {
  const input = await fixture()
  const different = await evidence.createAccountInheritedEvidencePreparation(input.database, input.token).prepare({})
  cleanup.push(() => different.dispose())
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  // A valid same-account archive can accompany discovery of a different remote archive
  await input.capture(different.handle)
  expect(open).toHaveBeenCalledExactlyOnceWith(input.database, input.token, input.handle.root)
  const locallyOpened = await open.mock.results[0].value
  await expect(locallyOpened.check()).rejects.toThrow()
  await expect(different.handle.check()).resolves.toBeUndefined()
  open.mockClear()
  const snapshot = await captureAccountSnapshot(input.current.opened, input.fence, input.check, { database: input.database, token: input.token })
  cleanup.push(() => disposeWorkspaceSnapshot(snapshot))
  expect(open).toHaveBeenCalledExactlyOnceWith(input.database, input.token, input.handle.root)
  await expect((await open.mock.results[0].value).check()).rejects.toThrow()
})

it.each(['forged', 'disposed', 'database', 'account', 'generation', 'stale-profile'] as const)('rejects %s proof before archive work', async mode => {
  const input = await fixture()
  let handle = input.handle, token = input.token, database = input.database
  if (mode === 'forged') handle = { ...handle, root: { documentId: accountLocalId(), revisionId: accountLocalId() } }
  if (mode === 'disposed') await handle.dispose()
  if (mode === 'database') { database = new AccountDatabase(token.accountId); cleanup.push(async () => database.close()) }
  if (mode === 'account') token = { ...token, accountId: accountLocalId() }
  if (mode === 'generation') token = { ...token, generation: token.generation + 1 }
  if (mode === 'stale-profile') { invalidateProfile(); token = installProfile(token.accountId, input.key) }
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(input.capture(handle, token, database)).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
})

it('rechecks the captured fence during joined construction without disposing borrowed proof on failure', async () => {
  const input = await fixture()
  let checks = 0
  const changed = async () => {
    if (++checks === 3) await input.database.profileMeta.put({ ...input.fence, headRevision: input.fence.headRevision + 1 })
    await input.check()
  }
  await expect(input.capture(input.handle, input.token, input.database, changed)).rejects.toThrow('Captured fence changed')
  expect(checks).toBe(3)
  await expect(input.handle.check()).resolves.toBeUndefined()
})

it.each(['metadata', 'ciphertext'] as const)('reauthenticates changed physical %s while borrowing admitted evidence', async mode => {
  const input = await fixture()
  const records = [...input.prepared.records].sort((left, right) => right.descriptor.plainBytes - left.descriptor.plainBytes)
  const record = mode === 'metadata' ? records[0] : records.find(value => value.descriptor.plainBytes === 2)!
  expect(record).toBeDefined()
  if (mode === 'metadata') await input.database.encryptedRevisions.put({ ...record, descriptor: { ...record.descriptor, plainBytes: record.descriptor.plainBytes + 1 } })
  else {
    const chunk = (await input.database.stagedCipherChunks.where('payloadId').equals(record.payloadId).toArray())[0]
    const bytes = chunk.bytes.slice(); bytes[0] ^= 255
    await input.database.stagedCipherChunks.put({ ...chunk, bytes })
  }
  await expect(input.capture()).rejects.toThrow()
  await expect(input.handle.check()).resolves.toBeUndefined()
})

it.each(['documentId', 'revisionId'] as const)('requires the exact inherited %s and validates a different root afresh', async field => {
  const input = await fixture()
  const root = { ...input.handle.root, [field]: accountLocalId() }
  const workspace = { ...input.current.opened, inheritedEvidence: root }
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(captureAccountSnapshot(workspace, input.fence, input.check, { database: input.database, token: input.token, validatedEvidence: input.handle })).rejects.toThrow()
  expect(open).toHaveBeenCalledExactlyOnceWith(input.database, input.token, root)
  await expect(input.handle.check()).resolves.toBeUndefined()
})

it('avoids canonical allocation for the same admitted catalog during real account capture', async () => {
  const input = await fixture(true), compare = vi.spyOn(localData, 'jsonEqual')
  const captured = await input.capture()
  expect(captured.state.planner.catalogs[0]).toBe(SYNTHETIC_RETAINED_CATALOG)
  expect(isImmutableCatalogSnapshot(captured.state.planner.catalogs[0])).toBe(true)
  expect(captured.sourceEvidence?.units.some(unit => unit.key.includes('catalog'))).toBe(true)
  expect(compare.mock.calls.filter(([left, right]) => left === right && left === SYNTHETIC_RETAINED_CATALOG)).toHaveLength(0)
})

it.each(['distinct-equal', 'distinct-unequal', 'unbranded', 'shallow-frozen'] as const)('retains structural comparison for %s current catalog evidence', async mode => {
  const input = await fixture(true), captured = projectWorkspaceSnapshotV1(await input.capture())
  const inspectedCatalog = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  if (mode === 'distinct-unequal') Object.assign(inspectedCatalog, { checksum: 'different-evidence' })
  if (mode === 'shallow-frozen') Object.freeze(inspectedCatalog)
  if (mode === 'distinct-equal') immutableCatalogSnapshot(inspectedCatalog)
  expect(inspectedCatalog).not.toBe(SYNTHETIC_RETAINED_CATALOG)
  expect(isImmutableCatalogSnapshot(inspectedCatalog)).toBe(mode === 'distinct-equal')
  const inspect = closure.inspectWorkspaceClosures
  vi.spyOn(closure, 'inspectWorkspaceClosures').mockImplementation(async (...args) => (await inspect(...args)).map(value => value.root.kind === 'catalog' ? { ...value, value: inspectedCatalog } : value))
  if (mode === 'unbranded' || mode === 'shallow-frozen') {
    const split = documents.splitWorkspace
    vi.spyOn(documents, 'splitWorkspace').mockImplementation(state => split(state).map(value => value.kind === 'catalog' ? { ...value, value: inspectedCatalog as unknown as typeof value.value } : value))
  }
  const compare = vi.spyOn(localData, 'jsonEqual')
  const result = validateWorkspaceSnapshotV1(captured)
  if (mode === 'distinct-unequal') await expect(result).rejects.toThrow('Current-unit evidence differs from its projected logical record')
  else await expect(result).resolves.toBeUndefined()
  expect(compare.mock.calls.some(([left]) => left === inspectedCatalog)).toBe(true)
})
