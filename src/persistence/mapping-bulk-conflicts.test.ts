import 'fake-indexeddb/auto'
import { IDBObjectStore } from 'fake-indexeddb'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { invalidateProfile, profileSignal, ProfileChangedError } from '../account/profile'
import { appendFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { resolveConflict } from '../workspace/conflicts'
import { blobIdentity, readBlob } from '../workspace/blobs'
import { conflictService } from './sync-conflict-fixture'
import { editorClosureFixture } from '../workspace/test-helpers'
import { readRemoteState, readRemoteHeads } from '../account/sync/pull'
import { openRemoteProjection } from '../account/sync/projection'
import { directoryShard } from '../workspace/directory'
import { maxChangedHeads } from '../account/protocol'
import { runSyncIteration } from '../account/sync/outbox'
import { attachSyncScheduler, requestSync, subscribeSync } from '../account/sync/scheduler'

async function* additiveBulkComparisonJourney() {
  const started = Date.now(), service = await conflictService()
  const measured = Boolean(process.env.CRYKIT_SYNC_PROOF_TIMINGS)
  const phasePath = process.env.CRYKIT_SYNC_PROOF_TIMINGS ?? process.env.CRYKIT_SYNC_PROOF_PHASES
  let disposeScheduler: (() => void) | undefined, unsubscribe: (() => void) | undefined
  const metrics = new Map<string, { calls: number; elapsedMs: number }>(), sourceReads = new Map<string, number>()
  const iterations = new AsyncLocalStorage<{ id: number; started: number; identity: string; helpers: Record<string, { calls: number; elapsedMs: number }>; reads: Map<string, number>; mutations: Record<string, number>; projections: Record<string, { calls: number; elapsedMs: number }> }>()
  let iterationId = 0
  const iterationProofs: Record<string, unknown>[] = []
  const activeIterations = new Map<number, NonNullable<ReturnType<typeof iterations.getStore>>>()
  const flush = (value: Record<string, unknown>) => { if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${JSON.stringify(value)}\n`) }
  const observer = measured ? setInterval(() => { for (const value of activeIterations.values()) flush({ phase: 'iteration-partial', elapsedMs: Date.now() - started, iteration: value.id, durationMs: Date.now() - value.started, reads: [...value.reads.values()].reduce((a, b) => a + b, 0), distinct: value.reads.size, mutations: value.mutations, projections: value.projections, commitCalls: service.commits.length }) }, 5000) : undefined
  if (measured) {
    const streams = await import('../workspace/account-streams'), originalSource = streams.openAccountSource
    vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
      const source = await originalSource(...args), id = JSON.stringify(args[2])
      return { ...source, async *open() {
        const start = Date.now(); sourceReads.set(id, (sourceReads.get(id) ?? 0) + 1)
        try { yield* source.open() } finally { const value = metrics.get('source-open') ?? { calls: 0, elapsedMs: 0 }; value.calls++; value.elapsedMs += Date.now() - start; metrics.set('source-open', value) }
      } }
    })
    const contexts = await import('../account/sync/mapping-context'), originalContext = contexts.readMappingContext
    vi.spyOn(contexts, 'readMappingContext').mockImplementation(async (...args) => {
      const start = Date.now()
      try { return await originalContext(...args) } finally { const value = metrics.get('mapping-context') ?? { calls: 0, elapsedMs: 0 }; value.calls++; value.elapsedMs += Date.now() - start; metrics.set('mapping-context', value) }
    })
    const evidence = await import('../workspace/account-evidence'), originalValidation = evidence.validateCapturedWorkspaceRecords
    vi.spyOn(evidence, 'validateCapturedWorkspaceRecords').mockImplementation(async (...args) => {
      const start = Date.now()
      try { return await originalValidation(...args) } finally { const value = metrics.get('captured-validation') ?? { calls: 0, elapsedMs: 0 }; value.calls++; value.elapsedMs += Date.now() - start; metrics.set('captured-validation', value) }
    })
  }
  const proof = (phase: string, values: Record<string, unknown>) => {
    if (!phasePath) return
    const record = { phase, elapsedMs: Date.now() - started, metrics: Object.fromEntries(metrics), sourceReads: { total: [...sourceReads.values()].reduce((a, b) => a + b, 0), distinct: sourceReads.size, repeated: [...sourceReads].sort((a, b) => b[1] - a[1]).slice(0, 5) }, ...values }
    if (measured) console.info(JSON.stringify(record))
    if (measured || phase !== 'scheduler-attempt-error') appendFileSync(phasePath, `${JSON.stringify(record)}\n`)
  }
  if (measured) {
    const outboxModule = await import('../account/sync/outbox'), iterate = outboxModule.runSyncIteration
    vi.spyOn(outboxModule, 'runSyncIteration').mockImplementation((...args) => iterations.run({ id: ++iterationId, started: Date.now(), identity: JSON.stringify(args[0]), helpers: {}, reads: new Map(), mutations: {}, projections: {} }, async () => {
      activeIterations.set(iterations.getStore()!.id, iterations.getStore()!)
      try { return await iterate(...args) } finally {
        const value = iterations.getStore()!
        activeIterations.delete(value.id)
        iterationProofs.push({ phase: 'iteration-cost', elapsedMs: Date.now() - started, iteration: value.id, identity: value.identity, durationMs: Date.now() - value.started, helpers: value.helpers, mutations: value.mutations, reads: { total: [...value.reads.values()].reduce((a, b) => a + b, 0), distinct: value.reads.size, repeated: [...value.reads].sort((a, b) => b[1] - a[1]).slice(0, 8) }, projections: value.projections })
        flush(iterationProofs.at(-1)!)
      }
    }))
    const pullModule = await import('../account/sync/pull'), ensure = pullModule.ensureProjectionClosure
    vi.spyOn(pullModule, 'ensureProjectionClosure').mockImplementation(async (...args) => {
      const start = Date.now()
      try { return await ensure(...args) } finally {
        const cost = iterations.getStore()
        if (cost) { const value = cost.helpers.ensureProjectionClosure ??= { calls: 0, elapsedMs: 0 }; value.calls++; value.elapsedMs += Date.now() - start }
      }
    })
    const projectionModule = await import('../account/sync/projection'), project = projectionModule.openRemoteProjection
    vi.spyOn(projectionModule, 'openRemoteProjection').mockImplementation(async (...args) => {
      const start = Date.now(), identity = JSON.stringify({ account: args[0].name, token: args[1], heads: [...args[2]].sort(), localHead: args[3], localRevision: args[4] })
      try { return await project(...args) } finally {
        const cost = iterations.getStore()
        if (cost) { const value = cost.projections[identity] ??= { calls: 0, elapsedMs: 0 }; value.calls++; value.elapsedMs += Date.now() - start }
      }
    })
  }
  try {
    const fixture = await editorClosureFixture(), key = JSON.stringify(['editor', fixture.file.id]), shard = await directoryShard(key)
    const initial = { ...fixture.state, editorDocuments: [], retainedContent: [], blobs: [] }
    let a = await service.device(0, initial)
    if (measured) for (const method of ['get', 'add', 'put', 'delete'] as const) {
      const original = IDBObjectStore.prototype[method]
      vi.spyOn(IDBObjectStore.prototype, method).mockImplementation(function(this: IDBObjectStore, ...args: unknown[]) {
        const cost = iterations.getStore()
        if (cost && ['encryptedRevisions', 'stagedCipherChunks'].includes(this.name)) {
          if (method === 'get') { const key = JSON.stringify([this.transaction.db.name, this.name, args[0]]); cost.reads.set(key, (cost.reads.get(key) ?? 0) + 1) }
          else { const key = `${this.name}.${method}`; cost.mutations[key] = (cost.mutations[key] ?? 0) + 1 }
        }
        return Reflect.apply(original, this, args)
      })
    }
    expect((await a.settle()).state).toBe('synced')
    let b = await service.device(1); expect((await b.settle()).state).toBe('synced')
    const captured = (await readRemoteState(b.db, b.token))!.value
    const before = await (await b.open()).readWorkspace()
    await (await b.open()).commitWorkspace({ ...before, blobs: fixture.blobs.filter(blob => blob.ref.documentId === 'text'), editorDocuments: [{ ...fixture.file, filename: 'Pending allocation.json' }] }, before.planner.localData.revision)
    const pending = await b.native()
    const pendingEntry = pending.entries.find(entry => entry.key === key)!
    const originalCipher = await b.db.encryptedRevisions.get(pendingEntry.ref.revisionId)
    const originalIntent = (await b.db.outbox.toArray())[0]
    proof('pending-first-allocation', { pendingDocument: pendingEntry.ref.documentId, capturedLineage: captured.effective!.lineageId })
    a = await service.device(0)
    const acceptedBefore = await (await a.open()).readWorkspace()
    // Real semantic additions cross the accepted head gate; no altered projection or forced bulk option
    let sameShardId: string | undefined
    for (let index = 0; index < 4096 && !sameShardId; index++) {
      const candidate = `bulk-same-shard-${index}`
      if (await directoryShard(JSON.stringify(['editor', candidate])) === shard) sameShardId = candidate
    }
    expect(sameShardId).toBeDefined()
    const additions = Array.from({ length: maxChangedHeads }, (_, index) => ({ ...fixture.file, id: (index ? `bulk-unrelated-${index}` : sameShardId!) as typeof fixture.file.id, filename: `Unrelated ${index}.json` }))
    const commitStart = service.commits.length
    await (await a.open()).commitWorkspace({ ...acceptedBefore, blobs: fixture.blobs.filter(blob => blob.ref.documentId === 'text'), editorDocuments: [{ ...fixture.file, filename: 'Accepted allocation.json' }, ...additions] }, acceptedBefore.planner.localData.revision)
    expect((await a.settle()).state).toBe('synced')
    const acceptedSnapshot = (await readRemoteState(a.db, a.token))!.value
    const accepted = (await openRemoteProjection(a.db, a.token, await readRemoteHeads(a.db, a.token, acceptedSnapshot.heads), (await a.native()).head, (await (await a.open()).readWorkspace()).planner.localData.revision))!
    expect(accepted.lineageId).not.toBe(captured.effective!.lineageId)
    expect(accepted.directories.get(shard)!.allocations).toEqual([])
    expect(accepted.baseline.some(entry => entry.kind === 'mutable' && entry.key === key && entry.seed.revisionId === accepted.units.get(key)!.ref.revisionId)).toBe(true)
    expect(accepted.units.get(key)!.ref.documentId).not.toBe(pendingEntry.ref.documentId)
    expect(service.commits.slice(commitStart).some(command => command.heads.length === 1 && command.heads[0].documentId === accepted.control.documentId && command.expectedPublicationEpoch !== undefined)).toBe(true)
    proof('actual-bulk-winner', { semanticAdditions: additions.length + 1, lineage: accepted.lineageId, rawShardEntries: accepted.directories.get(shard)!.allocations.length, baselineOwnsWinner: true })
    b = await service.device(1)
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('navigator', { onLine: true })
    let calls = 0
    const errors: string[] = []
    const signal = profileSignal(b.token)
    let abortWait: () => void
    const conflictState = new Promise<void>((resolve, reject) => {
      // Teardown revokes this profile; a paused scheduler must not leave the comparison wait pending forever
      abortWait = () => reject(new ProfileChangedError())
      signal.addEventListener('abort', abortWait, { once: true })
      disposeScheduler = attachSyncScheduler(b.token, async (token, signal) => {
        calls++
        try { await b.native(); return await runSyncIteration(token, signal) }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); proof('scheduler-attempt-error', { attempt: calls, error: errors.at(-1) }); throw error }
      })
      unsubscribe = subscribeSync(b.token, state => { if (state === 'conflict') resolve() })
    })
    try { await conflictState } finally { signal.removeEventListener('abort', abortWait!) }
    const state = await (await b.open()).readWorkspace(), beforeSaveCalls = calls
    requestSync(b.token, 'save')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await b.db.encryptedRevisions.get(pendingEntry.ref.revisionId)).toEqual(originalCipher)
    if (measured) {
      const frontier = await service.fixture.db.prepare(`
        WITH RECURSIVE source(revision_id) AS (
          SELECT ? UNION SELECT d.dependency_id FROM source s
          JOIN sync_dependencies d ON d.revision_id = s.revision_id AND d.account_id = ?
        )
        SELECT p.mutation_id, w.state, COUNT(*) AS nodes, SUM(p.done) AS done,
          SUM(p.retained) AS retained, MAX(progress.processed_steps) AS steps,
          SUM(CASE WHEN source.revision_id IS NOT NULL THEN 1 ELSE 0 END) AS accepted_control_nodes
        FROM publication_pins p JOIN publication_work w USING(account_id, mutation_id)
        LEFT JOIN publication_progress progress USING(account_id, mutation_id)
        LEFT JOIN source ON source.revision_id = p.revision_id
        GROUP BY p.mutation_id, w.state
      `).bind(accepted.control.revisionId, b.token.accountId).all()
      const certificates = await service.fixture.db.prepare('SELECT * FROM publication_certificates').all()
      const borrows = await service.fixture.db.prepare('SELECT mutation_id,work_id,revision_id,document_id,generation,source_mutation,source_work,metadata_bytes FROM publication_borrows').all()
      proof('actual-command-frontiers', { control: accepted.control, frontier: frontier.results, certificates: certificates.results, borrows: borrows.results, commands: [...new Map(service.commits.map(command => [command.mutationId, { mutationId: command.mutationId, revisions: command.revisions.map(value => ({ documentId: value.documentId, revisionId: value.revisionId, dependencies: value.dependencies })), heads: command.heads }])).values()] })
    }
    proof('loser-scheduler-outcome', { errors, calls, saveTriggeredCalls: calls - beforeSaveCalls, comparisons: state.conflicts.length, pendingIntentRetained: (await b.db.outbox.toArray()).some(row => row.id === originalIntent.id), originalCipherUnchanged: true })
    expect(state.conflicts).toHaveLength(1)
    expect(state.conflicts[0].unit).toEqual({ kind: 'directory-mapping', privateKey: key, shard })
    disposeScheduler?.(); disposeScheduler = undefined; unsubscribe?.(); unsubscribe = undefined
    expect((await b.settle()).state).toBe('conflict')
    const pendingState = await (await b.open()).readWorkspace()
    await (await b.open()).commitWorkspace({ ...pendingState, editorDocuments: pendingState.editorDocuments.map(file => file.id === additions[0].id ? { ...file, filename: 'Unrelated saved while unresolved.json' } : file) }, pendingState.planner.localData.revision)
    expect((await b.settle()).state).toBe('conflict')
    expect(await directoryShard(JSON.stringify(['editor', additions[0].id]))).toBe(shard)
    proof('unrelated-publication', { stillUnresolved: true, sameShard: shard })
    const third = await service.device(2); expect((await third.settle()).state).toBe('conflict')
    const independent = await (await third.open()).readWorkspace(), conflict = independent.conflicts[0]
    expect(independent.editorDocuments.find(file => file.id === additions[0].id)!.filename).toBe('Unrelated saved while unresolved.json')
    const originals = []
    for (const [index, branch] of conflict.branches.entries()) {
      const closed = await inspectWorkspaceClosure(independent, branch.closure)
      expect(closed.mapping!.privateKey).toBe(key)
      expect((closed.value as { filename: string }).filename).toBe(index ? 'Accepted allocation.json' : 'Pending allocation.json')
      if (index) expect(closed.publication!.mapping!.context!.control.ref).toEqual(accepted.control)
      originals.push(...await Promise.all(independent.blobs.filter(blob => closed.refs.has(blobIdentity(blob.ref))).map(async blob => ({ ref: blob.ref, bytes: await readBlob(blob.content, blob.ref.byteLength) }))))
    }
    expect(conflict.commonAncestor.kind).toBe('present')
    if (conflict.commonAncestor.kind !== 'present') throw new Error('Missing closed allocation absence')
    const ancestor = await inspectWorkspaceClosure(independent, conflict.commonAncestor.closure)
    expect(ancestor.value).toEqual({ allocation: 'absent' })
    expect(ancestor.publication!.mapping!.context).toBeDefined()
    const snapshot = (await readRemoteState(third.db, third.token))!.value
    const projection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, snapshot.heads), (await third.native()).head, independent.planner.localData.revision))!
    const authority = projection.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
    const loser = authority.branches[0].publication.ref
    expect(service.commits.some(command => !command.heads.length && command.revisions.some(revision => revision.revisionId === loser.revisionId))).toBe(true)
    expect(service.commits.some(command => command.heads.some(head => head.revisionId === loser.revisionId))).toBe(false)
    const { captureMappingContext } = await import('../account/sync/mapping-context')
    const { readMappingPublication } = await import('../account/sync/mapping-publication')
    const { stagePublicationControl } = await import('../account/sync/publication')
    const capturedCloud = authority.branches[1].publication, cloudContext = capturedCloud.mapping!.context!
    const preparedControl = await stagePublicationControl(third.db, third.token, projection.lineageId, projection.baseline, projection.control)
    const preparedContext = await captureMappingContext(third.db, third.token, { ...projection, control: preparedControl }, key)
    const activationBeforeNegatives = await third.db.profileMeta.get('active')
    await expect(readMappingPublication(third.db, third.token, capturedCloud.ref, key, capturedCloud.mapping!.record!.ref, preparedContext, projection.control)).rejects.toThrow()
    await expect(readMappingPublication(third.db, third.token, capturedCloud.ref, key, authority.branches[0].publication.mapping!.record!.ref, cloudContext, projection.control)).rejects.toThrow()
    const { recordPhysicalHead: _positive, ...absentContext } = cloudContext
    await expect(readMappingPublication(third.db, third.token, capturedCloud.ref, key, undefined, absentContext, projection.control)).rejects.toThrow()
    await expect(readMappingPublication(third.db, third.token, projection.directories.get((shard + 1) % 64)!.ref, key, capturedCloud.mapping!.record!.ref, cloudContext, projection.control)).rejects.toThrow()
    expect(await third.db.profileMeta.get('active')).toEqual(activationBeforeNegatives)
    proof('third-device-closed-inspection', { originalClosures: originals.length, baselinePositive: true, capturedAbsent: true, archivedLoser: true })
    yield
    proof('resolution-start', {})
    await resolveConflict(third.token, conflict.id, 'this', independent.planner.localData.revision)
    proof('resolution-locally-saved', {})
    expect((await third.settle()).state).toBe('synced')
    const resolved = await (await third.open()).readWorkspace()
    expect(resolved.editorDocuments.find(file => file.id === fixture.file.id)!.filename).toBe('Pending allocation.json')
    expect(resolved.editorDocuments.find(file => file.id === additions[0].id)!.filename).toBe('Unrelated saved while unresolved.json')
    expect(resolved.editorDocuments).toHaveLength(additions.length + 1)
    const envelope = service.commits.flatMap(command => command.revisions).find(revision => revision.documentId === loser.documentId && revision.parents.includes(loser.revisionId) && revision.parents.length === 2)!
    expect(envelope.parents).toEqual([loser.revisionId, projection.directories.get(shard)!.ref.revisionId])
    for (const original of originals) expect(await readBlob(resolved.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original.ref))!.content, original.ref.byteLength)).toEqual(original.bytes)
    a = await service.device(0); expect((await a.settle()).state).toBe('synced')
    expect((await (await a.open()).readWorkspace()).editorDocuments.find(file => file.id === fixture.file.id)!.filename).toBe('Pending allocation.json')
    if (phasePath) {
      const transactions = service.fixture.events().filter(event => event.operation === 'sync' && event.stage === 'transaction')
      const liabilities = await service.fixture.db.prepare(`SELECT
        (SELECT COUNT(*) FROM publication_certificates) AS certificates,
        (SELECT COALESCE(SUM(metadata_bytes),0) FROM publication_certificates) AS certificate_bytes,
        (SELECT COUNT(*) FROM publication_borrows) AS bindings,
        (SELECT COALESCE(SUM(metadata_bytes),0) FROM publication_borrows) AS binding_bytes`).first()
      proof('resolved-and-independent-activation', { actualTwoParents: true, originalsUnchanged: true, unrelatedMembership: additions.length, liabilities, transactions: { count: transactions.length, rowsRead: transactions.reduce((sum, event) => sum + (event.rowsRead ?? 0), 0), rowsWritten: transactions.reduce((sum, event) => sum + (event.rowsWritten ?? 0), 0), elapsedMs: transactions.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) }, commitAttempts: service.commits.length })
    }
  } finally {
    if (observer) clearInterval(observer)
    proof('final-measurement', { iterations: iterationProofs.length }); disposeScheduler?.(); unsubscribe?.(); vi.restoreAllMocks(); await service.dispose() }
}

const BULK_STEP_TIMEOUT_MS = 150_000
describe('firstAllocationRaceAgainstAnActualAdditiveBulkWinnerCreatesAReviewableComparison', { concurrent: false }, () => {
  const journey = additiveBulkComparisonJourney()
  let pending: ReturnType<typeof journey.next> | undefined
  let compared = false
  // The independent comparison and the user's later resolution share all actual service and device state
  afterAll(async () => {
    if (pending) invalidateProfile()
    await pending?.catch(() => {})
    await journey.return(undefined)
  }, BULK_STEP_TIMEOUT_MS)
  it('retains the loser and admits the complete comparison on an independent device', async () => {
    pending = journey.next()
    const result = await pending
    pending = undefined
    expect(result.done).toBe(false)
    compared = true
  }, BULK_STEP_TIMEOUT_MS)
  it('publishes the explicit resolution and preserves every original and unrelated member', async () => {
    expect(compared).toBe(true)
    pending = journey.next()
    const result = await pending
    pending = undefined
    expect(result.done).toBe(true)
  }, BULK_STEP_TIMEOUT_MS)
})
