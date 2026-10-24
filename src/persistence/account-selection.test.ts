import { deepStrictEqual } from 'node:assert'
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit, type CipherRecord, type PreparedLocalActivation } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import * as cache from '../workspace/account-cache'
import { activatePulledState, type PullCandidate } from '../account/sync/pull'
import * as selection from '../workspace/account-selection'
import type { PreparedAccountWorkspace } from '../workspace/account-graph'

let database: AccountDatabase
const ref = () => ({ documentId: cache.accountLocalId(), revisionId: cache.accountLocalId() })
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete() })
function setup() {
  const token = installProfile(cache.accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  return token
}
const graph = (version = 1) => ({ version, kind: 'local-workspace-graph', lineageId: 'synthetic-selection-lineage', localRevision: 0, localUpdatedAt: '2026-01-01', index: ref(), allocations: ref(), selections: { scenarios: {} } })
const snapshot = async () => Object.fromEntries(await Promise.all(database.tables.filter(table => table.name !== 'stagedCipherChunks').map(async table => [table.name, await table.toArray()])))
async function operation(record: CipherRecord, installed = false): Promise<PreparedLocalActivation> {
  if (installed) await database.encryptedRevisions.add(record)
  return { version: 1, id: cache.accountLocalId(), expected: await database.profileMeta.get('active'), head: cache.cipherRef(record), records: installed ? [] : [record] }
}
async function pull(token: ReturnType<typeof setup>, prepared: PreparedLocalActivation) {
  const expected = { key: 'active' as const, headRevision: 0, head: ref() }
  await database.profileMeta.put(expected)
  const scanRow = { id: 'scan', ref: ref() }
  await database.syncState.put(scanRow)
  const candidate: PullCandidate = { previous: await database.syncState.get('remote'), scanRow, state: { version: 1, kind: 'remote-state', cursor: 'synthetic', watermark: 0, publicationEpoch: 0, heads: ref(), initialComplete: true }, heads: new Map() }
  return { candidate, expected, run: () => activatePulledState(database, token, candidate, expected, { ...prepared, opened: { version: 1 }, owner: { disposed: false } } as unknown as PreparedAccountWorkspace) }
}
it.each(['local', 'pull'].flatMap(selector => ['empty', 'nonempty', 'installed'].map(kind => ({ selector, kind }))))('denies encrypted v2 through $selector / $kind', async ({ selector, kind }) => {
  const token = setup()
  const record = await cache.stageAccountJson(database, token, { ...graph(2), inheritedEvidence: kind === 'nonempty' ? [{ synthetic: true }] : [] }, [])
  const prepared = await operation(record, kind === 'installed')
  const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
  const before = await snapshot()
  await expect(run()).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})
it.each(['local', 'pull'] as const)('preserves frozen v1 admission and captured inputs through %s', async selector => {
  const token = setup()
  for (const marked of [false, true]) {
    const value = { ...graph(), ...(marked ? { sourceEvidenceVersion: 1 } : {}) }
    const record = structuredClone(await cache.stageAccountJson(database, token, value, []))
    const prepared = await operation(record)
    const expectedHead = structuredClone(prepared.head)
    const context = selector === 'pull' ? await pull(token, prepared) : undefined
    const read = cache.readAccountRecordBytes
    vi.spyOn(cache, 'readAccountRecordBytes').mockImplementationOnce(async (...args) => {
      const bytes = await read(...args)
      Object.assign(prepared.head, ref())
      Object.assign(record.descriptor, { dependencies: [ref()] })
      if (context) { Object.assign(context.candidate.scanRow.ref, ref()); context.candidate.state.watermark = 99; Object.assign(context.expected.head, ref()) }
      return bytes
    })
    await (context ? context.run() : activateLocalAccountCommit(database, token, prepared))
    expect((await database.profileMeta.get('active'))?.head).toEqual(expectedHead)
    expect((await database.encryptedRevisions.get(expectedHead.revisionId))?.descriptor.dependencies).toEqual([])
    vi.restoreAllMocks()
  }
})
it.each(['local', 'pull'] as const)('denies unknown, extended v1, malformed identity and incomplete roots atomically through %s', async selector => {
  const token = setup()
  for (const failure of ['unknown', 'extra', 'account', 'document', 'revision', 'payload', 'duplicate', 'shadow', 'missing', 'truncated', 'finality']) {
    const record = structuredClone(await cache.stageAccountJson(database, token, failure === 'unknown' ? graph(77) : failure === 'extra' ? { ...graph(), inheritedEvidence: [] } : graph(), []))
    const prepared = await operation(record)
    if (failure === 'account') record.descriptor.accountId = cache.accountLocalId()
    if (failure === 'document') Object.assign(prepared.head, { documentId: cache.accountLocalId() })
    if (failure === 'revision') Object.assign(prepared.head, { revisionId: cache.accountLocalId() })
    if (failure === 'payload') Object.assign(record, { payloadId: 'invalid' })
    if (failure === 'duplicate') (prepared.records as CipherRecord[]).push(record)
    if (failure === 'shadow') await database.encryptedRevisions.add(record)
    if (failure === 'missing') await database.stagedCipherChunks.delete([record.payloadId, 0])
    if (failure === 'truncated') { const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!; await database.stagedCipherChunks.put({ ...chunk, bytes: chunk.bytes.slice(1) }) }
    if (failure === 'finality') record.descriptor.plainBytes++
    const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
    const before = await snapshot()
    await expect(run(), failure).rejects.toThrow()
    expect(await snapshot(), failure).toEqual(before)
  }
})
it.each(['local', 'pull'].flatMap(selector => ['proposed', 'existing', 'older'].filter(mode => selector === 'local' || mode === 'existing').map(mode => ({ selector, mode }))))('denies v2 source views for $selector / $mode sources', async ({ selector, mode }) => {
  const token = setup()
  const source = await cache.stageAccountJson(database, token, graph(), [])
  const view = await cache.stageAccountJson(database, token, { ...graph(2), sourceEvidenceVersion: 1 }, [])
  const wrapper = await cache.stageAccountJson(database, token, { version: 1, kind: 'local-source-view', source: cache.cipherRef(source), view: cache.cipherRef(view) }, [cache.cipherRef(source), cache.cipherRef(view)])
  const capture = { id: `source-view:${source.revisionId}`, ref: cache.cipherRef(wrapper) }
  const head = mode === 'older' ? await cache.stageAccountJson(database, token, { ...graph(), sourceEvidenceVersion: 1 }, []) : source
  const records = [...new Set([source, view, wrapper, head])]
  if (mode === 'existing') { await database.encryptedRevisions.bulkAdd(records); await database.syncState.add(capture) }
  const prepared = { ...await operation(head), records: mode === 'existing' ? [] : records, ...(mode !== 'existing' ? { sourceCaptures: [capture] } : {}) }
  const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
  const before = await snapshot()
  await expect(run()).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})
it.each(['local', 'pull'] as const)('rechecks installed descriptor and payload identity before %s pointer publication', async selector => {
  const token = setup()
  for (const change of ['descriptor', 'payload'] as const) {
    const record = await cache.stageAccountJson(database, token, graph(), [])
    const prepared = await operation(record, true)
    const context = selector === 'pull' ? await pull(token, prepared) : undefined
    const check = selection.prepareSelectedV1Check
    let afterRace: Awaited<ReturnType<typeof snapshot>>
    vi.spyOn(selection, 'prepareSelectedV1Check').mockImplementationOnce(async (...args) => {
      const result = await check(...args)
      const replacement = structuredClone(record)
      if (change === 'payload') Object.assign(replacement, { payloadId: cache.accountLocalId() })
      else Object.assign(replacement.descriptor, { dependencies: [ref()] })
      await database.encryptedRevisions.put(replacement)
      afterRace = await snapshot()
      return result
    })
    await expect(context ? context.run() : activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
    expect(await snapshot()).toEqual(afterRace!)
    vi.restoreAllMocks()
  }
})
it.each(['local', 'pull'] as const)('rechecks effective source-view appearance, replacement and removal through %s', async selector => {
  const token = setup()
  for (const change of ['appearance', 'replacement', 'removal'] as const) {
    const value = graph()
    const source = await cache.stageAccountJson(database, token, value, [])
    const view = await cache.stageAccountJson(database, token, { ...value, sourceEvidenceVersion: 1 }, [])
    const wrapper = await cache.stageAccountJson(database, token, { version: 1, kind: 'local-source-view', source: cache.cipherRef(source), view: cache.cipherRef(view) }, [cache.cipherRef(source), cache.cipherRef(view)])
    await database.encryptedRevisions.bulkAdd([source, view, wrapper])
    const row = { id: `source-view:${source.revisionId}`, ref: cache.cipherRef(wrapper) }
    if (change !== 'appearance') await database.syncState.put(row)
    const prepared = { ...await operation(source), records: [] }
    const context = selector === 'pull' ? await pull(token, prepared) : undefined
    const check = selection.prepareSelectedV1Check
    let afterRace: Awaited<ReturnType<typeof snapshot>>
    vi.spyOn(selection, 'prepareSelectedV1Check').mockImplementationOnce(async (...args) => {
      const result = await check(...args)
      if (change === 'removal') await database.syncState.delete(row.id)
      else await database.syncState.put(change === 'appearance' ? row : { ...row, ref: ref() })
      afterRace = await snapshot()
      return result
    })
    await expect(context ? context.run() : activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
    expect(await snapshot()).toEqual(afterRace!)
    vi.restoreAllMocks()
  }
})
it.each(['valid', 'wrapper-version', 'wrapper-extra', 'suffix', 'dependencies', 'view-mark', 'lineage', 'revision', 'time', 'selections'] as const)('authenticates source-view association and header: %s', async change => {
  const token = setup(), value = graph()
  const source = await cache.stageAccountJson(database, token, value, [])
  const view = await cache.stageAccountJson(database, token, { ...value, sourceEvidenceVersion: change === 'view-mark' ? undefined : 1, ...(change === 'lineage' ? { lineageId: 'foreign' } : {}), ...(change === 'revision' ? { localRevision: 1 } : {}), ...(change === 'time' ? { localUpdatedAt: 'other' } : {}), ...(change === 'selections' ? { selections: { scenarios: { foreign: 'scenario' } } } : {}) }, [])
  const wrapper = await cache.stageAccountJson(database, token, { version: change === 'wrapper-version' ? 2 : 1, kind: 'local-source-view', source: cache.cipherRef(source), view: cache.cipherRef(view), ...(change === 'wrapper-extra' ? { inheritedEvidence: [] } : {}) }, change === 'dependencies' ? [cache.cipherRef(source)] : [cache.cipherRef(source), cache.cipherRef(view)])
  const capture = { id: `source-view:${change === 'suffix' ? cache.accountLocalId() : source.revisionId}`, ref: cache.cipherRef(wrapper) }
  const prepared = { ...await operation(source), records: [source, view, wrapper], sourceCaptures: [capture] }
  const before = await snapshot()
  if (change !== 'valid') { await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow(); expect(await snapshot()).toEqual(before); return }
  const check = selection.prepareSelectedV1Check
  vi.spyOn(selection, 'prepareSelectedV1Check').mockImplementationOnce(async (...args) => {
    const result = await check(...args)
    Object.assign(capture.ref, ref()); capture.id = 'source-view:foreign'
    return result
  })
  await activateLocalAccountCommit(database, token, prepared)
  expect((await database.syncState.get(`source-view:${source.revisionId}`))?.ref).toEqual(cache.cipherRef(wrapper))
})
it('zeroes authenticated parse bytes on successful and rejected admission', async () => {
  const token = setup()
  const read = cache.readAccountRecordBytes, observed: Uint8Array[] = []
  vi.spyOn(cache, 'readAccountRecordBytes').mockImplementation(async (...args) => { const bytes = await read(...args); observed.push(bytes); return bytes })
  for (const version of [1, 2]) {
    const record = await cache.stageAccountJson(database, token, graph(version), [])
    const prepared = await operation(record)
    if (version === 1) await activateLocalAccountCommit(database, token, prepared)
    else await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  }
  expect(observed.length).toBeGreaterThan(0)
  expect(observed.every(bytes => bytes.every(value => value === 0))).toBe(true)
})
it.each(['profile', 'fence'] as const)('preserves %s invalidation after admission', async change => {
  const token = setup()
  const record = await cache.stageAccountJson(database, token, graph(), [])
  const prepared = await operation(record)
  const check = selection.prepareSelectedV1Check
  let afterRace: Awaited<ReturnType<typeof snapshot>>
  vi.spyOn(selection, 'prepareSelectedV1Check').mockImplementationOnce(async (...args) => {
    const result = await check(...args)
    if (change === 'profile') invalidateProfile()
    else await database.profileMeta.put({ key: 'active', headRevision: 4, head: ref() })
    afterRace = await snapshot()
    return result
  })
  await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  expect(await snapshot()).toEqual(afterRace!)
})
it.each(['local', 'pull'] as const)('retains historical non-exact v1 root dependencies through %s', async selector => {
  const token = setup()
  const dependency = await cache.stageAccountJson(database, token, { synthetic: 'older dependency' }, [])
  await database.encryptedRevisions.add(dependency)
  const record = await cache.stageAccountJson(database, token, graph(), [cache.cipherRef(dependency)])
  const prepared = await operation(record)
  const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
  await run()
  expect((await database.profileMeta.get('active'))?.head).toEqual(cache.cipherRef(record))
})
it.each(['matching', 'changed'] as const)('retains the opener semantic-equivalence check for %s v1 source views', async semantic => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { prepareAccountWorkspace, AccountWorkspaceRootSchema, openAccountWorkspace } = await import('../workspace/account-graph')
  const token = setup(), localData = createBlankLocalData()
  const state = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1 as const, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
  const view = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd([...view.records])
  const root = await cache.openAccountJson(database, token, view.head, AccountWorkspaceRootSchema)
  const empty = await cache.stageAccountJson(database, token, { version: 1, entries: [], children: [] }, [])
  const source = await cache.stageAccountJson(database, token, { ...root, sourceEvidenceVersion: undefined, ...(semantic === 'changed' ? { index: cache.cipherRef(empty) } : {}) }, [])
  const wrapper = await cache.stageAccountJson(database, token, { version: 1, kind: 'local-source-view', source: cache.cipherRef(source), view: view.head }, [cache.cipherRef(source), view.head])
  const prepared = { ...await operation(source), records: [empty, source, wrapper], sourceCaptures: [{ id: `source-view:${source.revisionId}`, ref: cache.cipherRef(wrapper) }] }
  await activateLocalAccountCommit(database, token, prepared)
  if (semantic === 'changed') await expect(openAccountWorkspace(database, token, cache.cipherRef(source))).rejects.toThrow('Source migration changed an original semantic frame')
  else expect((await openAccountWorkspace(database, token, cache.cipherRef(source))).state).toEqual(state)
})
it('rejects a missing final chunk even after authenticating an earlier chunk', async () => {
  const token = setup()
  const record = await cache.stageAccountJson(database, token, { ...graph(), lineageId: 'synthetic'.repeat(600_000) }, [])
  expect(record.descriptor.chunks.length).toBeGreaterThan(1)
  await database.stagedCipherChunks.delete([record.payloadId, record.descriptor.chunks.at(-1)!.index])
  const prepared = await operation(record), before = await snapshot()
  await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})
it('denied pull preserves completed outbox, accepted bindings and all publication/cache rows before staging remote state', async () => {
  const token = setup()
  const record = await cache.stageAccountJson(database, token, graph(2), [])
  const prepared = await operation(record)
  const { candidate, expected } = await pull(token, prepared)
  const publication = { id: 'publication', ref: ref() }, intent = { id: cache.accountLocalId(), ref: ref(), status: 'mapped-local' as const }
  await database.syncState.bulkPut([publication, { id: 'remote', ref: ref() }, { id: 'projection', ref: ref() }, { id: `accepted:${cache.accountLocalId()}`, ref: ref() }, { id: `binding:${cache.accountLocalId()}`, ref: ref() }])
  Object.assign(candidate, { previous: await database.syncState.get('remote') })
  await database.outbox.add(intent)
  const before = await snapshot(), chunks = await database.stagedCipherChunks.toArray()
  await expect(activatePulledState(database, token, candidate, expected, { ...prepared, opened: { version: 1 } } as unknown as PreparedAccountWorkspace, { intent, publication }, undefined, () => {}, [cache.accountLocalId()])).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
  expect(await database.stagedCipherChunks.toArray()).toEqual(chunks)
})
it.each(['local', 'pull'] as const)('rejects an authenticated v2 replacement of the installed v1 descriptor through %s', async selector => {
  const { encryptRevision } = await import('../account/crypto/revisions')
  const { withAccountKey } = await import('../account/profile')
  const token = setup(), record = await cache.stageAccountJson(database, token, graph(), [])
  const prepared = await operation(record, true), context = selector === 'pull' ? await pull(token, prepared) : undefined
  const bytes = new TextEncoder().encode(JSON.stringify(graph(2))), payloadId = cache.accountLocalId()
  const encrypted = await withAccountKey(token, key => encryptRevision(key, { format: 1, accountId: token.accountId, ...prepared.head, parents: [], dependencies: [], protected: true, plainBytes: bytes.length }, cache.accountLocalId(), (async function* () { yield bytes })(), { id: payloadId, write: async (index, bytes) => { await database.stagedCipherChunks.add({ payloadId, index, bytes }) } }))
  const replacement = { revisionId: record.revisionId, payloadId, descriptor: encrypted.descriptor }
  const plaintext = await cache.readAccountRecordBytes(database, token, prepared.head, replacement)
  try { expect(JSON.parse(new TextDecoder().decode(plaintext)).version).toBe(2) } finally { plaintext.fill(0) }
  const check = selection.prepareSelectedV1Check
  let afterRace: Awaited<ReturnType<typeof snapshot>>
  vi.spyOn(selection, 'prepareSelectedV1Check').mockImplementationOnce(async (...args) => {
    const result = await check(...args)
    await database.encryptedRevisions.put(replacement)
    afterRace = await snapshot()
    return result
  })
  await expect(context ? context.run() : activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  expect(await snapshot()).toEqual(afterRace!)
})
it.each(['missing', 'foreign', 'disposed'] as const)('does not trust %s owner or forged opened claims to select v2', async claim => {
  const token = setup(), record = await cache.stageAccountJson(database, token, graph(2), [])
  const owner = claim === 'missing' ? undefined : claim === 'foreign' ? { accountId: cache.accountLocalId() } : { disposed: true }
  const prepared = { ...await operation(record), owner, opened: { version: 1, sourceEvidenceVersion: 1 } }
  const before = await snapshot()
  await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
  const { candidate, expected } = await pull(token, prepared), beforePull = await snapshot()
  await expect(activatePulledState(database, token, candidate, expected, prepared as unknown as PreparedAccountWorkspace)).rejects.toThrow()
  expect(await snapshot()).toEqual(beforePull)
})
it.each(['local', 'pull'] as const)('authenticates the final stream tag before %s selection', async selector => {
  const { getSodium } = await import('../account/crypto/sodium')
  const token = setup(), sodium = await getSodium()
  const push = sodium.crypto_secretstream_xchacha20poly1305_push
  // Produce a valid encrypted and hashed chunk with an authenticated non-final tag
  const fault = vi.spyOn(sodium, 'crypto_secretstream_xchacha20poly1305_push').mockImplementation((state, message, associated, _tag, outputFormat) => push(state, message, associated, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE, outputFormat))
  let record: CipherRecord
  try { record = await cache.stageAccountJson(database, token, graph(), []) } finally { fault.mockRestore() }
  const prepared = await operation(record)
  const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
  const before = await snapshot()
  await expect(run()).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})
it.each(['local', 'pull'] as const)('rechecks the actual fresh row inserted by %s', async selector => {
  const token = setup(), record = await cache.stageAccountJson(database, token, graph(), [])
  const prepared = await operation(record)
  const run = selector === 'local' ? () => activateLocalAccountCommit(database, token, prepared) : (await pull(token, prepared)).run
  const before = await snapshot(), add = IDBObjectStore.prototype.add
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
    if (this.name === 'encryptedRevisions' && value.revisionId === record.revisionId) value = { ...value, payloadId: cache.accountLocalId() }
    return add.call(this, value, key)
  })
  await expect(run()).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})
it('rechecks the exact proposed source-view row after its native insertion', async () => {
  const token = setup(), value = graph()
  const source = await cache.stageAccountJson(database, token, value, [])
  const view = await cache.stageAccountJson(database, token, { ...value, sourceEvidenceVersion: 1 }, [])
  const wrapper = await cache.stageAccountJson(database, token, { version: 1, kind: 'local-source-view', source: cache.cipherRef(source), view: cache.cipherRef(view) }, [cache.cipherRef(source), cache.cipherRef(view)])
  const capture = { id: `source-view:${source.revisionId}`, ref: cache.cipherRef(wrapper) }
  const prepared = { ...await operation(source), records: [source, view, wrapper], sourceCaptures: [capture] }
  const before = await snapshot(), add = IDBObjectStore.prototype.add
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
    if (this.name === 'syncState' && value.id === capture.id) value = { ...value, ref: ref() }
    return add.call(this, value, key)
  })
  await expect(activateLocalAccountCommit(database, token, prepared)).rejects.toThrow()
  expect(await snapshot()).toEqual(before)
})

it.each(['local', 'pull'].flatMap(selector => [false, true].flatMap(nonempty => [false, true].map(installed => ({ selector, nonempty, installed })))))(
  'admits only installed complete v2 through $selector (nonempty=$nonempty, installed=$installed) with exact receipts', async ({ selector, nonempty, installed }) => {
    const { createBlankInactiveAccountWorkspacePreparation, openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
    const { completeInactiveCandidate, exactAccountTables } = await import('./account-inactive-test-helpers')
    const token = setup(), bootstrap = createBlankInactiveAccountWorkspacePreparation(database, token)
    const blank = await bootstrap.prepare()
    await activateLocalAccountCommit(database, token, { version: 1, id: cache.accountLocalId(), expected: undefined, head: blank.head, records: blank.records })
    await bootstrap.abandon()
    const origin = await openInactiveAccountWorkspace(database, token, blank.head)
    const candidate = await completeInactiveCandidate(database, token, origin, nonempty, { segmentedMetadata: nonempty && installed })
    try {
      if (installed) {
        await database.encryptedRevisions.bulkAdd([...candidate.records])
        await candidate.dispose(); await origin.dispose()
        const reopened = await openInactiveAccountWorkspace(database, token, candidate.head)
        await candidate.assertContents(reopened); await reopened.dispose()
        if (selector === 'local' && nonempty) {
          const evidenceRoot = candidate.records.find(record => record.revisionId === candidate.evidence.root.revisionId)!
          for (const fault of ['missing', 'corrupt'] as const) {
            if (fault === 'missing') await database.encryptedRevisions.delete(evidenceRoot.revisionId)
            else await database.encryptedRevisions.put({ ...evidenceRoot, payloadId: cache.accountLocalId() })
            const before = await exactAccountTables(database)
            await expect(activateLocalAccountCommit(database, token, { version: 1, id: cache.accountLocalId(), expected: await database.profileMeta.get('active'), head: candidate.head, records: [] }), fault).rejects.toThrow()
            deepStrictEqual(await exactAccountTables(database), before, fault)
            await database.encryptedRevisions.put(evidenceRoot)
          }
        }
      }
      const intent = { id: cache.accountLocalId(), ref: blank.head, status: 'mapped-local' as const }
      await database.outbox.add(intent)
      await database.conflicts.add({ id: cache.accountLocalId(), ref: blank.head })
      await database.syncState.bulkPut(['remote', 'projection', 'scan', 'publication', `accepted:${cache.accountLocalId()}`, `binding:${cache.accountLocalId()}`, 'source-view:unrelated', 'source-context:unrelated'].map(id => ({ id, ref: blank.head })))
      const expected = (await database.profileMeta.get('active'))!
      const pullCandidate: PullCandidate = { previous: await database.syncState.get('remote'), scanRow: (await database.syncState.get('scan'))!, state: { version: 1, kind: 'remote-state', cursor: 'complete-v2-denial', watermark: 0, publicationEpoch: 0, heads: blank.head, initialComplete: true }, heads: new Map() }
      for (const owner of [undefined, { accountId: cache.accountLocalId() }, { disposed: true }]) {
        // Serializable claims cannot stand in for installed ciphertext or a current local fence
        const envelope = { version: 1 as const, id: cache.accountLocalId(), expected, head: candidate.head, records: installed ? [] : candidate.records, opened: { version: 1 }, owner }
        const before = await exactAccountTables(database)
        const run = () => selector === 'local' ? activateLocalAccountCommit(database, token, envelope) : activatePulledState(database, token, pullCandidate, expected, envelope as unknown as PreparedAccountWorkspace, { intent, publication: { id: 'publication', ref: blank.head } }, undefined, () => {}, [cache.accountLocalId()])
        if (installed && owner === undefined) {
          await run()
          expect((await database.profileMeta.get('active'))!.head).toEqual(candidate.head)
          break
        }
        await expect(run()).rejects.toThrow()
        deepStrictEqual(await exactAccountTables(database), before)
      }
      const installedRecords = await database.encryptedRevisions.toArray()
      const retainedPayloads = new Set(installedRecords.map(record => record.payloadId))
      const retainedChunks = (await database.stagedCipherChunks.toArray()).filter(chunk => retainedPayloads.has(chunk.payloadId))
      await candidate.dispose()
      deepStrictEqual(await database.encryptedRevisions.toArray(), installedRecords)
      deepStrictEqual(await database.stagedCipherChunks.toArray(), retainedChunks)
    } finally { await candidate.dispose(); await origin.dispose(); await bootstrap.abandon() }
  },
)
