import 'fake-indexeddb/auto'
import Dexie, { type Transaction } from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import { createPersonalDefinition } from '../domain'
import { encryptRevision } from '../account/crypto/revisions'
import { withAccountKey, installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit, type CipherChunk, type CipherRef } from '../persistence/account-database'
import * as backup from '../interchange/workspace-backup-evidence'
import * as cache from './account-cache'
import * as streams from './account-streams'
import { captureAccountMappingEvidence, claimInstalledMappingProof, createAccountLocalStore, createMappingAccountLocalStore } from './account-local-store'
import { activateIncrementalBaseline, prepareIncrementalBaseline, prepareIncrementalMapping, readIncrementalAccountEvidence, ensureIncrementalAccountEvidence } from './account-local-mapping'
import { admitLocalRoot, prepareLocalWorkspace, LocalWorkspaceRootV3Schema } from './local-root'
import { readLocalEvidence, localEvidenceReadAdmission } from './local-evidence'
import { guestEvidenceSources } from './guest-evidence'
import { createGuestCopyService } from './guest-copy'
import { editorClosureFixture } from './test-helpers'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import { accountInheritedSources, openAccountInheritedEvidence } from './account-evidence-snapshots'
import { memoryBlob, readBlob } from './blobs'
import { compactCatalogWritersEnabled } from './catalog-writer-capability'
import { managedComparisonWritesEnabled } from './managed-copy-comparisons'

vi.mock('../interchange/workspace-backup-schema', async importOriginal => {
  const actual = await importOriginal<typeof import('../interchange/workspace-backup-schema')>()
  return { ...actual, WORKSPACE_BACKUP_LIMITS: { ...actual.WORKSPACE_BACKUP_LIMITS } }
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const release of cleanup.splice(0).reverse()) await release() })

async function installedSignin({ withNativeBody = false, mapBaseline = true } = {}) {
  expect([compactCatalogWritersEnabled(), managedComparisonWritesEnabled()]).toEqual([false, false])
  const key = crypto.getRandomValues(new Uint8Array(32)), token = installProfile(cache.accountLocalId(), key.slice())
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  const fixture = await editorClosureFixture(), state = { ...fixture.state, blobs: [], retainedContent: [] }
  const local = createPersonalDefinition(state.planner.localData, { kind: 'item', name: 'Unknown quantity' })
  const guestState = withNativeBody ? { ...state, editorDocuments: [fixture.file], blobs: [fixture.blobs[0]] } : state
  const original = ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'ordered-historical-source', revisionVector: { z: 'unknown', a: 'original' }, capturedAt: fixture.file.updatedAt, state: { ...guestState, planner: { ...guestState.planner, localData: local } } }, { async check() {}, async dispose() {} })
  const service = createGuestCopyService(async () => original)
  cleanup.push(async () => { await service.dispose(); await disposeWorkspaceSnapshot(original); await store.dispose(); database.close(); invalidateProfile(); key.fill(0) })
  const operation = cache.accountLocalId(), initial = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime)
  const before = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined))
  store.committed(operation)
  if (mapBaseline) await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, before))
  const preview = await service.previewSigninMerge(token)
  expect(preview.conflicts).toEqual([])
  await service.commitGuestCopy(token, preview)
  const pending = (await database.outbox.toArray())[0], fence = (await database.profileMeta.get('active'))!
  expect(pending.status).toBe('unmapped-local')
  const root = await cache.openAccountJson(database, token, fence.head, LocalWorkspaceRootV3Schema)
  const evidence = (await readLocalEvidence(store.adapter, root.inheritedEvidence, async () => {}))!
  const admission = localEvidenceReadAdmission(evidence, store.adapter, root.inheritedEvidence)
  const members = guestEvidenceSources(evidence).members
  expect(members.map(member => member.subset.length)).toEqual(withNativeBody ? [1, 1] : [0, 0])
  const originals = await Promise.all(members.map(async member => ({ id: member.id, bytes: await readBlob(member.metadata, member.metadata.byteLength) })))
  const leaves = []
  for (const row of admission.index.entries.filter(row => row.table === 'evidenceSegments')) {
    const source = await store.adapter.read(row.ref), bytes = await readBlob(source, source.byteLength)
    if (!originals.some(original => Buffer.from(original.bytes).equals(bytes))) continue
    const record = (await database.encryptedRevisions.get(row.ref.revisionId))!
    leaves.push({ bytes, record, chunks: await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).toArray() })
  }
  expect(leaves).toHaveLength(2)
  return { key, token, database, store, root, admission, evidence, originals, leaves, pending, fence }
}

it('uses exact installed leaves for both physical passes and validates the originals afresh on a cold device', async () => {
  const { token, key, database, root, admission, originals, leaves, pending } = await installedSignin()
  const decode = vi.spyOn(backup, 'readBackupMetadata'), stage = cache.stageAccountBytes, open = streams.openAccountSource
  let duplicates = 0
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation((...args) => {
    if (originals.some(original => Buffer.from(original.bytes).equals(args[2]))) duplicates++
    return stage(...args)
  })
  const reads: string[] = [], localReads: string[] = []
  vi.spyOn(streams, 'openAccountSource').mockImplementation((db, profile, ref, owner, expected, observe) =>
    open(db, profile, ref, owner, expected, observe && ((record, chunks) => { observe(record, chunks); (expected ? reads : localReads).push(record.revisionId) })))
  let associationTransaction: Transaction | undefined
  database.syncState.hook('creating', (_key, value, transaction) => {
    if (value.id === `incremental-evidence:${root.inheritedEvidence.revisionId}`) associationTransaction = transaction
  })
  const chunkReads = new Map<Transaction, string[]>()
  database.stagedCipherChunks.hook('reading', chunk => {
    const transaction = Dexie.currentTransaction
    if (chunk && transaction?.mode === 'readwrite') {
      const ids = chunkReads.get(transaction) ?? []
      ids.push(chunk.payloadId); chunkReads.set(transaction, ids)
    }
    return chunk
  })
  await prepareIncrementalMapping(database, token, pending)
  expect(associationTransaction).toBeDefined()
  for (const leaf of leaves) expect.soft(chunkReads.get(associationTransaction!)?.filter(id => id === leaf.record.payloadId)).toHaveLength(leaf.chunks.length)
  expect.soft(duplicates).toBe(0)
  const memberDecodeCount = () => decode.mock.calls.filter(([source]) => originals.some(original => original.bytes.length === source.byteLength)).length
  expect.soft(memberDecodeCount()).toBe(2)
  for (const leaf of leaves) {
    expect(localReads.filter(id => id === leaf.record.revisionId)).toHaveLength(6)
    expect(reads.filter(id => id === leaf.record.revisionId)).toHaveLength(2)
  }
  const mapped = (await readIncrementalAccountEvidence(database, token, root.inheritedEvidence))!
  decode.mockClear()
  // Move only the native archive's dependency closure into a separate IndexedDB factory
  const { IDBFactory } = await import('fake-indexeddb')
  const factory = Dexie.dependencies.indexedDB
  Dexie.dependencies.indexedDB = new IDBFactory()
  const cold = new AccountDatabase(token.accountId)
  Dexie.dependencies.indexedDB = factory
  cleanup.push(async () => { cold.close() })
  const stack = [mapped], closure = new Set<string>()
  while (stack.length) {
    const ref = stack.pop()!
    if (closure.has(ref.revisionId)) continue
    closure.add(ref.revisionId)
    const record = (await database.encryptedRevisions.get(ref.revisionId))!
    await cold.encryptedRevisions.add(record)
    await cold.stagedCipherChunks.bulkAdd(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).toArray())
    stack.push(...record.descriptor.dependencies)
  }
  const included = admission.dependencies.filter(({ ref }) => closure.has(ref.revisionId)).map(({ ref }) => ref.revisionId)
  expect(included.sort()).toEqual(leaves.map(leaf => leaf.record.revisionId).sort())
  invalidateProfile()
  const fresh = installProfile(token.accountId, key.slice())
  const reader = await openAccountInheritedEvidence(cold, fresh, mapped)
  try {
    expect(memberDecodeCount()).toBe(2)
    const native = await accountInheritedSources(reader)
    for (const member of native.members) expect(await readBlob(member.metadata, member.metadata.byteLength)).toEqual(originals.find(original => original.id === member.id)!.bytes)
  } finally { await reader.dispose() }
  for (const leaf of leaves) {
    expect(await database.encryptedRevisions.get(leaf.record.revisionId)).toEqual(leaf.record)
    expect(await database.stagedCipherChunks.where('payloadId').equals(leaf.record.payloadId).toArray()).toEqual(leaf.chunks)
  }
})

it.each(['source index', 'ownership', 'outbox', 'journal', 'predecessor'])('rejects a changed %s at the first evidence association', async race => {
  const { token, database, root, admission, leaves, pending, fence } = await installedSignin()
  const index = (await database.encryptedRevisions.get(admission.index.root.revisionId))!
  const chunk = (await database.stagedCipherChunks.get([index.payloadId, 0]))!
  const stage = cache.stageAccountJson
  vi.spyOn(cache, 'stageAccountJson').mockImplementation(async (...args) => {
    const record = await stage(...args)
    if ((args[2] as { kind?: string }).kind === 'incremental-evidence-association') {
      if (race === 'source index') {
        const bytes = chunk.bytes.slice(); bytes[0] ^= 1
        await database.stagedCipherChunks.put({ ...chunk, bytes })
      } else if (race === 'ownership') await database.preparationPayloads.add({ operationId: cache.accountLocalId(), payloadId: leaves[0].record.payloadId })
      else if (race === 'outbox') await database.outbox.put({ ...pending, status: 'mapped-local' })
      else if (race === 'journal') await database.migrationJournal.update(pending.id, { headRevision: fence.headRevision + 1 })
      else {
        const { accountMappingRootKey, IncrementalWorkspaceIntentSchema } = await import('./account-mapping-origin')
        const intent = await cache.openAccountJson(database, token, pending.ref, IncrementalWorkspaceIntentSchema)
        await database.syncState.delete(accountMappingRootKey(intent.before))
      }
    }
    return record
  })
  await expect(prepareIncrementalMapping(database, token, pending)).rejects.toThrow(race === 'ownership' ? 'acquired a preparation owner' : /changed/)
  expect(await database.syncState.get(`incremental-evidence:${root.inheritedEvidence.revisionId}`)).toBeUndefined()
  if (race !== 'outbox') expect(await database.outbox.get(pending.id)).toEqual(pending)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  await database.stagedCipherChunks.put(chunk)
  for (const leaf of leaves) {
    expect(await database.encryptedRevisions.get(leaf.record.revisionId)).toEqual(leaf.record)
    expect(await database.stagedCipherChunks.where('payloadId').equals(leaf.record.payloadId).toArray()).toEqual(leaf.chunks)
  }
})

it.each(['ciphertext', 'descriptor', 'retirement'])('rejects a late %s change during the second physical member traversal', async fault => {
  const { token, database, leaves, root, fence, pending } = await installedSignin()
  const leaf = leaves.at(-1)!, ref = cache.cipherRef(leaf.record), mapper = createMappingAccountLocalStore(database, token)
  cleanup.push(() => mapper.dispose())
  const local = await admitLocalRoot(mapper.adapter, fence.head, mapper.lifetime)
  const source = (await captureAccountMappingEvidence(database, token, mapper, local, async () => {}))!
  const open = streams.openAccountSource
  let pass = 0
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (db, profile, current, owner, expected, observe) => {
    if (expected && current.revisionId === ref.revisionId && ++pass === 2) {
      if (fault === 'retirement') mapper.finishAdmission()
      else if (fault === 'descriptor') await database.encryptedRevisions.put({ ...leaf.record, payloadId: cache.accountLocalId() })
      else {
        const chunk = leaf.chunks.at(-1)!, bytes = chunk.bytes.slice(); bytes[bytes.length - 1] ^= 1
        await database.stagedCipherChunks.put({ ...chunk, bytes })
      }
    }
    return open(db, profile, current, owner, expected, observe)
  })
  await expect(source.prepare()).rejects.toThrow()
  expect(pass).toBe(2)
  expect(await database.syncState.get(`incremental-evidence:${root.inheritedEvidence.revisionId}`)).toBeUndefined()
  expect(await database.outbox.get(pending.id)).toEqual(pending)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  if (fault === 'descriptor') await database.encryptedRevisions.put(leaf.record)
  if (fault === 'ciphertext') await database.stagedCipherChunks.bulkPut(leaf.chunks)
  for (const original of leaves) {
    expect(await database.encryptedRevisions.get(original.record.revisionId)).toEqual(original.record)
    expect(await database.stagedCipherChunks.where('payloadId').equals(original.record.payloadId).toArray()).toEqual(original.chunks)
  }
  await expect(prepareIncrementalMapping(database, token, pending)).resolves.toMatchObject({ operationId: pending.id })
})

it('isolates mapping preparations by store, exact admitted head, generation, and single use', async () => {
  const { database, token, store, fence, evidence } = await installedSignin()
  const mapper = createMappingAccountLocalStore(database, token)
  cleanup.push(() => mapper.dispose())
  const foreign = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
  await expect(captureAccountMappingEvidence(database, token, mapper, foreign, async () => {})).rejects.toThrow('Foreign local admission')
  const local = await admitLocalRoot(mapper.adapter, fence.head, mapper.lifetime)
  await expect(captureAccountMappingEvidence(database, token, mapper, { ...local }, async () => {})).rejects.toThrow('Foreign local admission')
  expect(claimInstalledMappingProof({}, database, token, evidence)).toBeUndefined()
  const other = new AccountDatabase(token.accountId)
  cleanup.push(async () => { other.close() })
  await expect(ensureIncrementalAccountEvidence(other, token, mapper, local)).rejects.toThrow('Foreign mapping store')
  await expect(ensureIncrementalAccountEvidence(database, token, { ...mapper }, local)).rejects.toThrow('Foreign mapping store')
  const source = (await captureAccountMappingEvidence(database, token, mapper, local, async () => {}))!
  const prepared = await source.prepare()
  await prepared.dispose()
  await expect(source.prepare()).rejects.toThrow('single-use')
  const stale = (await captureAccountMappingEvidence(database, token, mapper, local, async () => {}))!
  mapper.finishAdmission()
  await expect(stale.prepare()).rejects.toThrow('expired')
})

it.each(['planner', 'member', 'ordinal', 'digest', 'dependency'])('rejects a changed native metadata page binding before publishing: %s', async fault => {
  const { database, token, pending, root, admission, leaves } = await installedSignin()
  const stage = cache.stageAccountBytes
  let altered = false
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation((db, profile, bytes, dependencies, previous, owner) => {
    if (!altered && bytes[0] === 123) {
      const value = JSON.parse(new TextDecoder().decode(bytes))
      if (value.kind === 'evidence-metadata-page') {
        const entry = value.entries[0] as { content: CipherRef; ordinal: number; sha256: string }
        if (fault === 'planner') entry.content = admission.index.entries.find(row => row.table === 'evidenceSegments' && !leaves.some(leaf => leaf.record.revisionId === row.ref.revisionId))!.ref
        if (fault === 'member') entry.content = cache.cipherRef(leaves.find(leaf => leaf.record.revisionId !== entry.content.revisionId)!.record)
        if (fault === 'ordinal') entry.ordinal++
        if (fault === 'digest') entry.sha256 = '0'.repeat(64)
        altered = true
        return stage(db, profile, new TextEncoder().encode(JSON.stringify(value)), fault === 'dependency' ? [] : [entry.content], previous, owner)
      }
    }
    return stage(db, profile, bytes, dependencies, previous, owner)
  })
  await expect(prepareIncrementalMapping(database, token, pending)).rejects.toThrow()
  expect(altered).toBe(true)
  expect(await database.syncState.get(`incremental-evidence:${root.inheritedEvidence.revisionId}`)).toBeUndefined()
})

it.each(['parented', 'reserved'])('allocates a new native leaf and fully decodes a %s local segment', async shape => {
  const { database, token, leaves, originals, pending } = await installedSignin()
  const { record, bytes } = leaves[0], { descriptor } = record, chunks: CipherChunk[] = []
  if (shape === 'reserved') await database.preparationPayloads.add({ operationId: cache.accountLocalId(), payloadId: record.payloadId })
  else {
    const encrypted = await withAccountKey(token, key => encryptRevision(key, {
      format: 1, accountId: token.accountId, documentId: descriptor.documentId, revisionId: descriptor.revisionId,
      parents: [cache.accountLocalId()], dependencies: [], protected: true, plainBytes: bytes.length,
    }, cache.accountLocalId(), memoryBlob(bytes).open(), { id: record.payloadId, async write(index, part) { chunks.push({ index, bytes: part.slice(), payloadId: record.payloadId }) } }))
    await database.encryptedRevisions.put({ ...record, descriptor: encrypted.descriptor })
    await database.stagedCipherChunks.bulkPut(chunks)
  }
  const decode = vi.spyOn(backup, 'readBackupMetadata'), stage = cache.stageAccountBytes
  let allocated = 0
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation((...args) => {
    if (Buffer.from(bytes).equals(args[2])) allocated++
    return stage(...args)
  })
  await prepareIncrementalMapping(database, token, pending)
  expect(allocated).toBe(1)
  expect(decode.mock.calls.filter(([input]) => originals.some(original => original.bytes.length === input.byteLength))).toHaveLength(3)
})

it('charges the final authenticated reread of a proven empty-subset member against the same cumulative byte limit', async () => {
  const { database, token, leaves, pending, root } = await installedSignin()
  const limits = WORKSPACE_BACKUP_LIMITS as { bytes: number }, originalLimit = limits.bytes
  const open = streams.openAccountSource, target = leaves.at(-1)!.record
  let charged = 0, passes = 0
  try {
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (db, profile, ref, owner, expected, observe) => {
      if (!expected || !observe) return open(db, profile, ref, owner, expected, observe)
      if (ref.revisionId === target.revisionId && ++passes === 2) limits.bytes = charged + target.descriptor.plainBytes - 1
      return open(db, profile, ref, owner, expected, (record, chunks) => { charged += record.descriptor.plainBytes; observe(record, chunks) })
    })
    await expect(prepareIncrementalMapping(database, token, pending)).rejects.toThrow('Account evidence resource limit')
    expect(passes).toBe(2)
    expect(await database.syncState.get(`incremental-evidence:${root.inheritedEvidence.revisionId}`)).toBeUndefined()
  } finally { limits.bytes = originalLimit }
})

it('keeps a segment referenced by both members and the planner out of the native graph', async () => {
  const { database, token, store, admission, originals, fence } = await installedSignin()
  const { hashBlob } = await import('./blobs'), { prepareLocalIndex } = await import('./local-index')
  const json = (value: unknown) => memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
  const operation = cache.accountLocalId(), rows = [...admission.index.entries]
  const prefix = memoryBlob(new Uint8Array([91])), prefixRef = await store.adapter.stage(operation, prefix, [])
  let aliases = 0
  for (const [at, row] of rows.entries()) {
    if (row.table !== 'evidencePages') continue
    const source = await store.adapter.read(row.ref)
    const page = JSON.parse(new TextDecoder().decode(await readBlob(source, source.byteLength)))
    if (page.value.kind !== 'evidence-metadata-page') continue
    const [entry] = page.value.entries
    const index = rows.findIndex(value => value.table === 'evidenceSegments' && value.key === entry.content.key)
    const segment = rows[index], content = await store.adapter.read(segment.ref), bytes = await readBlob(content, content.byteLength)
    expect(bytes[0]).toBe(91)
    const tail = memoryBlob(bytes.subarray(1)), key = crypto.randomUUID(), digest = await hashBlob(prefix)
    rows.push({ ...segment, key, ref: prefixRef, digest })
    rows[index] = { ...segment, ref: await store.adapter.stage(operation, tail, []), digest: await hashBlob(tail) }
    page.value.entries = [{ ...entry, byteLength: 1, sha256: digest, content: { version: 1, key } }, { ...entry, ordinal: 1, byteLength: tail.byteLength, sha256: rows[index].digest }]
    const updated = json(page)
    rows[at] = { ...row, ref: await store.adapter.stage(operation, updated, []), digest: await hashBlob(updated) }
    aliases++
  }
  expect(aliases).toBe(3)
  const index = await prepareLocalIndex(rows, page => {
    const edges = [...page.children, ...page.entries.map(row => row.ref)]
    return store.adapter.stage(operation, json(page), [...new Map(edges.map(ref => [ref.revisionId, ref])).values()])
  })
  const inherited = await store.adapter.stage(operation, json({ version: 1, kind: 'local-inherited-evidence', roots: [{ kind: 'guest-evidence-rows', index: index.root }] }), [index.root])
  const local = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
  const snapshot = await prepareLocalWorkspace(store.adapter, operation, local.state, store.lifetime, undefined, inherited)
  await store.persistOperation(operation, async () => {}, () => {})
  const mapper = createMappingAccountLocalStore(database, token)
  cleanup.push(() => mapper.dispose())
  const selected = await admitLocalRoot(mapper.adapter, snapshot.head, mapper.lifetime)
  const source = (await captureAccountMappingEvidence(database, token, mapper, selected, async () => {}))!
  const decode = vi.spyOn(backup, 'readBackupMetadata')
  const native = await source.prepare()
  try {
    expect(decode.mock.calls.filter(([input]) => originals.some(original => original.bytes.length === input.byteLength))).toHaveLength(2)
    expect(native.records.flatMap(record => record.descriptor.dependencies)).not.toContainEqual(prefixRef)
    for (const member of (await accountInheritedSources(native.handle)).members) {
      expect(await readBlob(member.metadata, member.metadata.byteLength)).toEqual(originals.find(original => original.id === member.id)!.bytes)
    }
  } finally { await native.dispose() }
})

it('fully decodes each installed member with a native body subset during the staged reopen', async () => {
  const { database, token, pending, originals } = await installedSignin({ withNativeBody: true })
  const decode = vi.spyOn(backup, 'readBackupMetadata'), stage = cache.stageAccountBytes
  let allocations = 0
  vi.spyOn(cache, 'stageAccountBytes').mockImplementation((...args) => {
    if (originals.some(original => Buffer.from(original.bytes).equals(args[2]))) allocations++
    return stage(...args)
  })
  await prepareIncrementalMapping(database, token, pending)
  expect(allocations).toBe(2)
  expect(decode.mock.calls.filter(([input]) => originals.some(original => original.bytes.length === input.byteLength))).toHaveLength(4)
})

it('maps the exact earlier pending sign-in archive after a later foreground save', async () => {
  const { database, token, pending, fence, leaves } = await installedSignin()
  const { openAccountManagedRepository } = await import('./account-managed-repository')
  const repo = await openAccountManagedRepository(database, token, fence), loaded = await repo.load()
  await repo.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Later foreground edit' }), loaded.revision)
  const advanced = await database.profileMeta.get('active')
  expect(advanced?.headRevision).toBe(fence.headRevision + 1)
  const open = vi.spyOn(streams, 'openAccountSource')
  await expect(prepareIncrementalMapping(database, token, pending)).resolves.toMatchObject({ operationId: pending.id })
  for (const leaf of leaves) expect(open.mock.calls.filter(([, , ref, , expected]) => expected && ref.revisionId === leaf.record.revisionId)).toHaveLength(2)
  expect(await database.profileMeta.get('active')).toEqual(advanced)
  expect(await database.outbox.get(pending.id)).toEqual(pending)
})

it('keeps an uninstalled local archive out of the first association CAS', async () => {
  const { database, token, store, evidence, fence } = await installedSignin()
  const { prepareLocalEvidence } = await import('./local-evidence')
  const local = await admitLocalRoot(store.adapter, fence.head, store.lifetime), operation = cache.accountLocalId()
  const root = await prepareLocalEvidence(store.adapter, operation, evidence)
  const pending = await prepareLocalWorkspace(store.adapter, operation, local.state, store.lifetime, undefined, root)
  await expect(ensureIncrementalAccountEvidence(database, token, store, pending.snapshot)).rejects.toThrow(/installed/)
  expect(await database.syncState.get(`incremental-evidence:${root.revisionId}`)).toBeUndefined()
  expect(await database.profileMeta.get('active')).toEqual(fence)
})

it.each(['incremental-evidence-association', 'incremental-mapping-receipt'])('fences the admitted no-command predecessor journal when publishing the %s', async boundary => {
  const { database, token, pending, root, leaves, fence } = await installedSignin({ mapBaseline: false })
  const { accountMappingRootKey, IncrementalWorkspaceIntentSchema } = await import('./account-mapping-origin')
  const intent = await cache.openAccountJson(database, token, pending.ref, IncrementalWorkspaceIntentSchema)
  expect(intent.version).toBe(1)
  expect(await database.syncState.get(accountMappingRootKey(intent.before))).toBeUndefined()
  const prior = (await database.migrationJournal.toArray()).find(row => row.head.revisionId === intent.before.revisionId)!
  expect(prior.head).toEqual(intent.before)
  expect(prior.intent).toBeUndefined()
  const stage = cache.stageAccountJson
  let changed = false
  const fault = vi.spyOn(cache, 'stageAccountJson').mockImplementation(async (...args) => {
    const record = await stage(...args)
    if ((args[2] as { kind?: string }).kind === boundary) {
      // The pointer stays absent while the qualifying journal changes
      await database.migrationJournal.update(prior.id, { headRevision: prior.headRevision + 1 })
      changed = true
    }
    return record
  })
  await expect(prepareIncrementalMapping(database, token, pending)).rejects.toThrow('Mapping preparation changed')
  expect(changed).toBe(true)
  const association = await database.syncState.get(`incremental-evidence:${root.inheritedEvidence.revisionId}`)
  if (boundary === 'incremental-evidence-association') expect(association).toBeUndefined()
  else expect(association).toBeDefined()
  expect(await database.syncState.get(`incremental-mapping:${pending.id}`)).toBeUndefined()
  expect(await database.outbox.get(pending.id)).toEqual(pending)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  for (const leaf of leaves) {
    expect(await database.encryptedRevisions.get(leaf.record.revisionId)).toEqual(leaf.record)
    expect(await database.stagedCipherChunks.where('payloadId').equals(leaf.record.payloadId).toArray()).toEqual(leaf.chunks)
  }
  fault.mockRestore()
  await database.migrationJournal.put(prior)
  await expect(prepareIncrementalMapping(database, token, pending)).resolves.toMatchObject({ operationId: pending.id })
})

it('accepts reordered outer ciphertext record fields while reusing exact installed leaves', async () => {
  const { database, token, pending, leaves } = await installedSignin()
  for (const { record } of leaves) await database.encryptedRevisions.put({ descriptor: record.descriptor, payloadId: record.payloadId, revisionId: record.revisionId })
  const open = vi.spyOn(streams, 'openAccountSource')
  await expect(prepareIncrementalMapping(database, token, pending)).resolves.toMatchObject({ operationId: pending.id })
  for (const { record } of leaves) expect(open.mock.calls.filter(([, , ref, , expected]) => expected && ref.revisionId === record.revisionId)).toHaveLength(2)
})
