import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import * as capture from '../workspace/account-sync-capture'
import * as mapping from '../workspace/account-local-mapping'
import * as stores from '../workspace/account-local-store'
import * as evidence from '../workspace/account-evidence-snapshots'
import { accountEvidenceContains } from '../workspace/account-evidence-union'
import { openAccountWorkspace, prepareAccountWorkspaceWithExistingEvidence } from '../workspace/account-graph'
import { openRemoteProjection } from '../account/sync/projection'
import * as projections from '../account/sync/projection'
import { preparePublicationAttempt } from '../account/sync/publication'
import { admitLocalRoot, prepareLocalWorkspace } from '../workspace/local-root'
import { prepareLocalEvidence, readLocalEvidence } from '../workspace/local-evidence'
import { emptyPlannerEvidence, guestEvidenceFromSnapshot, mergeGuestEvidence } from '../workspace/guest-evidence'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import { editorClosureFixture } from '../workspace/test-helpers'
import { prepareManagedSync } from './managed-sync.test-helpers'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); invalidateProfile() })

async function fixture(extra = true) {
  const key = crypto.getRandomValues(new Uint8Array(32)), token = installProfile(accountLocalId(), key.slice())
  const database = new AccountDatabase(token.accountId)
  cleanup.push(() => database.delete())
  const original = await editorClosureFixture(), state = { ...original.state, editorDocuments: [original.file] }
  const snapshot = async (name: string) => {
    const source = { dataGeneration: LAUNCH_DATA_GENERATION, version: 1 as const, snapshotId: name, capturedAt: '2026-11-15', revisionVector: {}, state }
    const value = await inheritWorkspaceSnapshot(source, [source])
    cleanup.push(() => disposeWorkspaceSnapshot(value))
    return value
  }
  const store = stores.createAccountLocalStore(database, token)
  try {
    const operationId = accountLocalId()
    const inherited = await guestEvidenceFromSnapshot(await snapshot('mapped original'), emptyPlannerEvidence())
    const inheritedRef = await prepareLocalEvidence(store.adapter, operationId, inherited)
    const local = await prepareLocalWorkspace(store.adapter, operationId, state, store.lifetime, undefined, inheritedRef)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operationId, local, undefined))
    store.committed(operationId)
    await prepareManagedSync(database, token)
    if (extra) {
      const fence = (await database.profileMeta.get('active'))!
      const mapped = await capture.captureAccountReviewWorkspace(database, token, fence)
      try {
        const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
        const retained = (await readLocalEvidence(store.adapter, previous.root.inheritedEvidence, async () => {}))!
        const combined = await mergeGuestEvidence(retained, await guestEvidenceFromSnapshot(await snapshot('additional local original'), emptyPlannerEvidence()), retained.planner)
        const id = accountLocalId(), ref = await prepareLocalEvidence(store.adapter, id, combined)
        const next = await prepareLocalWorkspace(store.adapter, id, previous.state, store.lifetime, undefined, ref)
        // Preserve the admitted mapping while adding a genuine original only to the local archive
        const native = { head: mapped.workspace.head, records: [], entries: mapped.workspace.entries, opened: mapped.workspace, validatedEvidence: mapped.validatedEvidence }
        await activateLocalAccountCommit(database, token, await store.prepareMappedActivation(id, next, fence, previous, native))
        store.committed(id)
      } finally { await mapped.dispose() }
    }
  } finally { await store.dispose() }
  const fence = (await database.profileMeta.get('active'))!
  const read = async () => {
    const value = await capture.captureAccountSyncWorkspace(database, token, fence)
    cleanup.push(() => value.dispose())
    return value
  }
  return { database, token, key, state, fence, read }
}

it.each([false, true])('retains exact mapped and publication proofs with extra originals %s', async extra => {
  const input = await fixture(extra), open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  const captured = await input.read(), mapped = captured.validatedEvidence!, publication = captured.publicationValidatedEvidence!
  expect(publication).toBeDefined()
  expect(mapped.root).toEqual(captured.workspace.inheritedEvidence)
  expect(publication.root).toEqual(captured.inheritedEvidence)
  expect(publication.members).toHaveLength(extra ? 2 : 1)
  expect(mapped.members).toHaveLength(1)
  if (extra) expect(publication.root).not.toEqual(mapped.root)
  else { expect(publication).toBe(mapped); expect(open).toHaveBeenCalledTimes(1) }
  await evidence.assertAccountInheritedEvidenceOwner(publication, input.database, input.token)
  await captured.dispose()
  await expect(mapped.check()).rejects.toThrow()
  await expect(publication.check()).rejects.toThrow()
  open.mockClear()
  const next = await input.read()
  expect(next.publicationValidatedEvidence).not.toBe(publication)
  expect(next.publicationValidatedEvidence!.root).toEqual(publication.root)
  expect(open).toHaveBeenCalledTimes(extra ? 2 : 1)
  await next.publicationValidatedEvidence!.check()
})

it('attempts every distinct capture owner and retries a publication release that failed before cleanup', async () => {
  const input = await fixture(), ensure = mapping.ensureIncrementalAccountEvidence, create = stores.createAccountLocalStore
  let publication: evidence.AccountInheritedEvidence | undefined, release: (() => Promise<void>) | undefined
  let attempts = 0, completed = 0, storeAttempts = 0
  vi.spyOn(mapping, 'ensureIncrementalAccountEvidence').mockImplementation((db, token, store, local, check, retain) => ensure(db, token, store, local, check, (handle, dispose) => {
    publication = handle; release = dispose
    retain?.(handle, async () => { if (++attempts === 1) throw new Error('publication release unavailable'); await dispose(); completed++ })
  }))
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => { const store = create(...args); return { ...store, async dispose() { storeAttempts++; await store.dispose() } } })
  const captured = await input.read()
  cleanup.push(async () => { await release?.() })
  await expect(captured.dispose()).rejects.toThrow('publication release unavailable')
  expect(storeAttempts).toBe(1)
  expect(completed).toBe(0)
  await expect(captured.validatedEvidence!.check()).rejects.toThrow()
  await expect(publication!.check()).resolves.toBeUndefined()
  await captured.dispose()
  expect(attempts).toBe(2)
  expect(completed).toBe(1)
  await expect(publication!.check()).rejects.toThrow()
})

it.each([false, true])('releases publication then mapped proof before closing the store, including failure %s', async failRelease => {
  const input = await fixture(), ensure = mapping.ensureIncrementalAccountEvidence, create = stores.createAccountLocalStore
  let unblock!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { unblock = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  let releaseAttempts = 0, storeAttempts = 0
  let mapped: evidence.AccountInheritedEvidence | undefined
  vi.spyOn(mapping, 'ensureIncrementalAccountEvidence').mockImplementation((db, token, store, local, check, retain) => ensure(db, token, store, local, check, (handle, release) => {
    retain?.(handle, async () => {
      if (++releaseAttempts === 1) {
        started(); await held
        if (failRelease) throw new Error('publication retirement unavailable')
      }
      await release()
    })
  }))
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
    const store = create(...args)
    return { ...store, async dispose() {
      storeAttempts++
      if (mapped) await expect(mapped.check()).rejects.toThrow('released')
      await store.dispose()
    } }
  })
  const captured = await input.read()
  mapped = captured.validatedEvidence!
  const pending = captured.dispose()
  try {
    await entered
    expect(storeAttempts).toBe(0)
    await expect(mapped.check()).resolves.toBeUndefined()
  } finally { unblock(); await pending.catch(() => {}) }
  if (failRelease) await expect(pending).rejects.toThrow('publication retirement unavailable')
  else await expect(pending).resolves.toBeUndefined()
  expect(storeAttempts).toBe(1)
  await expect(mapped.check()).rejects.toThrow('released')
  await captured.dispose()
  await expect(captured.publicationValidatedEvidence!.check()).rejects.toThrow()
})

it.each(['before-retain', 'after-retain'] as const)('capture construction failure %s releases every acquired owner despite another failure', async mode => {
  const input = await fixture(), ensure = mapping.ensureIncrementalAccountEvidence, create = stores.createAccountLocalStore
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  let publication: evidence.AccountInheritedEvidence | undefined, release: (() => Promise<void>) | undefined
  let storeAttempts = 0, releaseAttempts = 0
  vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => { const store = create(...args); return { ...store, async dispose() { storeAttempts++; await store.dispose() } } })
  vi.spyOn(mapping, 'ensureIncrementalAccountEvidence').mockImplementation(async (db, token, store, local, check, retain) => {
    if (mode === 'before-retain') throw new Error('before retained publication')
    const root = await ensure(db, token, store, local, check, (handle, dispose) => {
      publication = handle; release = dispose
      retain?.(handle, async () => { releaseAttempts++; await dispose(); throw new Error('publication cleanup reported failure') })
    })
    await input.database.profileMeta.put({ ...input.fence, headRevision: input.fence.headRevision + 1 })
    return root
  })
  cleanup.push(async () => { await release?.() })
  await expect(input.read()).rejects.toThrow()
  expect(storeAttempts).toBe(1)
  expect(open.mock.results.length).toBeGreaterThan(0)
  await expect((await open.mock.results[0].value).check()).rejects.toThrow()
  if (mode === 'after-retain') { expect(releaseAttempts).toBe(1); await expect(publication!.check()).rejects.toThrow() }
})

it('borrows distinct complete roots through containment, preparation, readback and either projection role', async () => {
  const input = await fixture(), captured = await input.read()
  const mapped = captured.validatedEvidence!, publication = captured.publicationValidatedEvidence!
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(accountEvidenceContains(input.database, input.token, publication, mapped)).resolves.toBe(true)
  await expect(accountEvidenceContains(input.database, input.token, mapped, publication)).resolves.toBe(false)
  await expect(accountEvidenceContains(input.database, input.token, mapped, mapped)).resolves.toBe(true)
  const prepared = await prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, publication, captured.workspace, undefined, undefined, mapped)
  expect(prepared.validatedEvidence).toBe(publication)
  await input.database.encryptedRevisions.bulkAdd([...prepared.records])
  const opened = await openAccountWorkspace(input.database, input.token, prepared.head, prepared.validatedEvidence)
  expect(opened.inheritedEvidence).toEqual(publication.root)
  for (const workspace of [captured.workspace, opened]) {
    const attempt = await preparePublicationAttempt(input.database, input.token, workspace, null, new Map(), 0)
    const projection = await openRemoteProjection(input.database, input.token, new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId])), workspace.head, 0, mapped, publication)
    expect(projection!.inheritedEvidence).toEqual(workspace.inheritedEvidence)
  }
  expect(open).not.toHaveBeenCalled()
  await expect(prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, opened.state, mapped, opened, undefined, undefined, publication)).rejects.toThrow('cannot discard historical originals')
  await mapped.check(); await publication.check()
})

it('keeps bare-ref admission and valid different-root fallbacks locally owned', async () => {
  const input = await fixture(), captured = await input.read()
  const mapped = captured.validatedEvidence!, publication = captured.publicationValidatedEvidence!
  const different = await evidence.createAccountInheritedEvidencePreparation(input.database, input.token).prepare({})
  cleanup.push(() => different.dispose())
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(accountEvidenceContains(input.database, input.token, publication.root, mapped.root)).resolves.toBe(true)
  expect(open).toHaveBeenCalledTimes(2)
  const prepared = await prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, publication, captured.workspace, undefined, undefined, different.handle)
  expect(open).toHaveBeenCalledTimes(3)
  expect(open.mock.calls[2][2]).toEqual(mapped.root)
  await input.database.encryptedRevisions.bulkAdd([...prepared.records])
  const attempt = await preparePublicationAttempt(input.database, input.token, prepared.opened, null, new Map(), 0)
  const projection = await openRemoteProjection(input.database, input.token, new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId])), prepared.head, 0, mapped, different.handle)
  expect(projection!.inheritedEvidence).toEqual(publication.root)
  expect(open).toHaveBeenCalledTimes(4)
  expect(open.mock.calls[3][2]).toEqual(publication.root)
  for (const result of open.mock.results) await expect((await result.value).check()).rejects.toThrow()
  await different.handle.check(); await mapped.check(); await publication.check()
})

it.each(['forged', 'disposed', 'database', 'account', 'generation', 'stale-profile'] as const)('rejects supplied %s authority before fresh fallback, including a nonmatching root', async mode => {
  const input = await fixture(), captured = await input.read()
  let proof = captured.validatedEvidence!, database = input.database, token = input.token
  if (mode === 'forged') proof = { ...proof, root: { documentId: accountLocalId(), revisionId: accountLocalId() } }
  if (mode === 'disposed') await proof.dispose()
  if (mode === 'database') { database = new AccountDatabase(token.accountId); cleanup.push(async () => database.close()) }
  if (mode === 'account') token = { ...token, accountId: accountLocalId() }
  if (mode === 'generation') token = { ...token, generation: token.generation + 1 }
  if (mode === 'stale-profile') { invalidateProfile(); token = installProfile(token.accountId, input.key) }
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(accountEvidenceContains(database, token, captured.inheritedEvidence!, proof)).rejects.toThrow()
  await expect(accountEvidenceContains(database, token, proof, captured.inheritedEvidence!)).rejects.toThrow()
  await expect(prepareAccountWorkspaceWithExistingEvidence(database, token, captured.workspace.state, captured.inheritedEvidence!, captured.workspace, undefined, undefined, proof)).rejects.toThrow()
  await expect(prepareAccountWorkspaceWithExistingEvidence(database, token, captured.workspace.state, proof, captured.workspace)).rejects.toThrow()
  await expect(openRemoteProjection(database, token, new Map(), captured.workspace.head, 0, captured.publicationValidatedEvidence, proof)).rejects.toThrow()
  await expect(openRemoteProjection(database, token, new Map(), captured.workspace.head, 0, proof, captured.publicationValidatedEvidence)).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
})

it('disposes only freshly opened containment sides when the second archive fails admission', async () => {
  const input = await fixture(), captured = await input.read()
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  const absent = { documentId: accountLocalId(), revisionId: accountLocalId() }
  await expect(accountEvidenceContains(input.database, input.token, captured.inheritedEvidence!, absent)).rejects.toThrow()
  await expect((await open.mock.results[0].value).check()).rejects.toThrow()
  await expect(accountEvidenceContains(input.database, input.token, captured.publicationValidatedEvidence!, absent)).rejects.toThrow()
  await captured.publicationValidatedEvidence!.check()
})

it.each(['documentId', 'revisionId'] as const)('requires both previous archive fields when only %s changes', async field => {
  const input = await fixture(), captured = await input.read(), mapped = captured.validatedEvidence!, publication = captured.publicationValidatedEvidence!
  const root = { ...mapped.root, [field]: accountLocalId() }
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await expect(prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, publication, { ...captured.workspace, inheritedEvidence: root }, undefined, undefined, mapped)).rejects.toThrow()
  expect(open).toHaveBeenCalledExactlyOnceWith(input.database, input.token, root)
  await mapped.check(); await publication.check()
})

it('rechecks same-root containment lifetime after borrowing the owner', async () => {
  const input = await fixture(false), captured = await input.read(), proof = captured.validatedEvidence!
  const pending = accountEvidenceContains(input.database, input.token, proof, proof)
  await proof.dispose()
  await expect(pending).rejects.toThrow('released')
})

it('preserves current graph and physical ciphertext admission while borrowing publication evidence', async () => {
  const input = await fixture(), captured = await input.read(), proof = captured.publicationValidatedEvidence!
  await expect(prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, { ...captured.workspace.state, blobs: [] }, proof, captured.workspace, undefined, undefined, captured.validatedEvidence)).rejects.toThrow()
  await proof.check(); await captured.validatedEvidence!.check()
  const prepared = await prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, proof, captured.workspace, undefined, undefined, captured.validatedEvidence)
  await input.database.encryptedRevisions.bulkAdd([...prepared.records])
  const publication = await preparePublicationAttempt(input.database, input.token, prepared.opened, null, new Map(), 0)
  const heads = new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const entry = prepared.entries.find(value => value.kind === 'library-defaults')!
  const record = (await input.database.encryptedRevisions.get(entry.ref.revisionId))!
  const chunk = (await input.database.stagedCipherChunks.get([record.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await input.database.stagedCipherChunks.put({ ...chunk, bytes })
  await expect(openAccountWorkspace(input.database, input.token, prepared.head, proof)).rejects.toThrow()
  await expect(openRemoteProjection(input.database, input.token, heads, prepared.head, 0, captured.validatedEvidence, proof)).rejects.toThrow()
  await proof.check(); await captured.validatedEvidence!.check()
})

it('fresh containment and nonmatching projection proofs reject altered archive ciphertext', async () => {
  const input = await fixture(), captured = await input.read()
  const mapped = captured.validatedEvidence!, full = captured.publicationValidatedEvidence!
  const prepared = await prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, full, captured.workspace, undefined, undefined, mapped)
  await input.database.encryptedRevisions.bulkAdd([...prepared.records])
  const publication = await preparePublicationAttempt(input.database, input.token, prepared.opened, null, new Map(), 0)
  const record = (await input.database.encryptedRevisions.get(full.root.revisionId))!
  const chunk = (await input.database.stagedCipherChunks.get([record.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await input.database.stagedCipherChunks.put({ ...chunk, bytes })
  await expect(accountEvidenceContains(input.database, input.token, full.root, mapped)).rejects.toThrow()
  await expect(openRemoteProjection(input.database, input.token, new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId])), prepared.head, 0, mapped)).rejects.toThrow()
  await expect(input.read()).rejects.toThrow()
  await mapped.check()
})

async function publishedFixture() {
  const input = await fixture(), captured = await input.read()
  const prepared = await prepareAccountWorkspaceWithExistingEvidence(input.database, input.token, captured.workspace.state, captured.publicationValidatedEvidence!, captured.workspace, undefined, undefined, captured.validatedEvidence)
  await input.database.encryptedRevisions.bulkAdd([...prepared.records])
  const publication = await preparePublicationAttempt(input.database, input.token, prepared.opened, null, new Map(), 0)
  return { ...input, captured, prepared, heads: new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId])) }
}

it.each(['fresh', 'borrowed', 'different'] as const)('owns only fresh projection evidence for %s capture', async mode => {
  const input = await publishedFixture(), open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  expect(projections).toHaveProperty('captureRemoteProjection')
  const supplied = mode === 'fresh' ? undefined : mode === 'borrowed' ? input.captured.publicationValidatedEvidence : input.captured.validatedEvidence
  const capture = await projections.captureRemoteProjection(input.database, input.token, input.heads, input.prepared.head, 0, supplied)
  cleanup.push(() => capture.dispose())
  expect(capture.validatedEvidence!.root).toEqual(input.prepared.opened.inheritedEvidence)
  expect(capture.projection!.workspace.state.editorDocuments).toEqual(input.state.editorDocuments)
  await evidence.assertAccountInheritedEvidenceOwner(capture.validatedEvidence!, input.database, input.token)
  expect(open).toHaveBeenCalledTimes(mode === 'borrowed' ? 0 : 1)
  await capture.dispose()
  if (mode === 'borrowed') { expect(capture.validatedEvidence).toBe(supplied); await supplied!.check() }
  else await expect(capture.validatedEvidence!.check()).rejects.toThrow('released')
  if (supplied) await supplied.check()
})

it('default projection releases fresh evidence while each owned capture gets a new lifetime', async () => {
  const input = await publishedFixture(), open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  await openRemoteProjection(input.database, input.token, input.heads, input.prepared.head, 0)
  await expect((await open.mock.results[0].value).check()).rejects.toThrow('released')
  expect(projections).toHaveProperty('captureRemoteProjection')
  const first = await projections.captureRemoteProjection(input.database, input.token, input.heads, input.prepared.head, 0)
  cleanup.push(() => first.dispose())
  await first.dispose()
  const next = await projections.captureRemoteProjection(input.database, input.token, input.heads, input.prepared.head, 0)
  cleanup.push(() => next.dispose())
  expect(next.validatedEvidence).not.toBe(first.validatedEvidence)
  await next.validatedEvidence!.check()
})

it.each(['forged', 'disposed', 'database', 'account', 'generation', 'stale-profile'] as const)('owned projection rejects %s supplied authority before fresh admission', async mode => {
  const input = await publishedFixture(), open = vi.spyOn(evidence, 'openAccountInheritedEvidence')
  expect(projections).toHaveProperty('captureRemoteProjection')
  let proof = input.captured.validatedEvidence!, database = input.database, token = input.token
  if (mode === 'forged') proof = { ...proof }
  if (mode === 'disposed') await proof.dispose()
  if (mode === 'database') { database = new AccountDatabase(token.accountId); cleanup.push(async () => database.close()) }
  if (mode === 'account') token = { ...token, accountId: accountLocalId() }
  if (mode === 'generation') token = { ...token, generation: token.generation + 1 }
  if (mode === 'stale-profile') { invalidateProfile(); installProfile(token.accountId, input.key.slice()) }
  await expect(projections.captureRemoteProjection(database, token, input.heads, input.prepared.head, 0, proof, input.captured.publicationValidatedEvidence)).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
})

it.each([false, true])('owned projection preserves physical rejection and releases only fresh proof on failure, borrowed %s', async borrowed => {
  const input = await publishedFixture()
  expect(projections).toHaveProperty('captureRemoteProjection')
  const entry = input.prepared.entries.find(value => value.kind === 'library-defaults')!
  const record = (await input.database.encryptedRevisions.get(entry.ref.revisionId))!
  const chunk = (await input.database.stagedCipherChunks.get([record.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await input.database.stagedCipherChunks.put({ ...chunk, bytes })
  const open = vi.spyOn(evidence, 'openAccountInheritedEvidence'), supplied = borrowed ? input.captured.publicationValidatedEvidence : undefined
  await expect(projections.captureRemoteProjection(input.database, input.token, input.heads, input.prepared.head, 0, supplied)).rejects.toThrow()
  if (borrowed) { expect(open).not.toHaveBeenCalled(); await supplied!.check() }
  else { expect(open).toHaveBeenCalledOnce(); await expect((await open.mock.results[0].value).check()).rejects.toThrow('released') }
})
