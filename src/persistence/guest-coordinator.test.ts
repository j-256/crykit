import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { GuestCoordinatorDatabase, activateGuestProfile, reconcileGuestOperation, type GuestManifest } from '../workspace/guest-coordinator'
import { captureLegacyBranch, type LegacyParticipant } from '../workspace/legacy-capture'
import { installGuestWriteBarrier, GUEST_BARRIER_KEY } from '../workspace/guest-barrier'

it('publishes one pointer after exact comparison and restart retains the frozen history and old barrier', async () => {
  const source = new Dexie(`guest-source-${crypto.randomUUID()}`); source.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(source)
  const extras = ['inspector', 'files'].map(kind => { const database = new Dexie(`${source.name}-${kind}`); database.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(database); return database })
  const coordinator = new GuestCoordinatorDatabase(`guest-coordinator-${crypto.randomUUID()}`)
  try {
    await source.table('records').put({ id: 'original', history: ['retained'] })
    const expected: GuestManifest = { version: 1, id: 'before', revision: 0, planner: source.name, inspector: extras[0].name, files: extras[1].name }
    const target: GuestManifest = { ...expected, id: 'after', revision: 1, planner: 'planner-new', inspector: 'inspector-new', files: 'files-new' }
    await coordinator.active.put({ key: 'active', manifest: expected })
    const participants: LegacyParticipant[] = [{ kind: 'planner', database: source }, { kind: 'inspector', database: extras[0] }, { kind: 'files', database: extras[1] }]
    const capture = await captureLegacyBranch(coordinator, participants)
    await activateGuestProfile(coordinator, { id: 'operation', mode: 'replace', expected, target, capture }, participants)
    expect((await coordinator.active.get('active'))?.manifest).toEqual(target)
    await expect(source.table('records').put({ id: 'new' })).rejects.toThrow('retired')
    expect((await reconcileGuestOperation(coordinator, 'operation', participants)).localStatus).toBe('published')
    expect((await coordinator.records.where('captureId').equals(capture.id).toArray()).find(row => row.kind === 'record')?.value).toEqual({ id: 'original', history: ['retained'] })
  } finally { await source.delete(); for (const database of extras) await database.delete(); await coordinator.delete() }
})
it('source changes and pointer-write failure preserve the previous active profile and release only owned barriers', async () => {
  const source = new Dexie(`guest-failure-${crypto.randomUUID()}`); source.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(source)
  const extras = ['inspector', 'files'].map(kind => { const database = new Dexie(`${source.name}-${kind}`); database.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(database); return database })
  const coordinator = new GuestCoordinatorDatabase(`guest-fail-coordinator-${crypto.randomUUID()}`)
  try {
    await source.table('records').put({ id: 'one', value: 'before' })
    const expected: GuestManifest = { version: 1, id: 'before', revision: 0, planner: source.name, inspector: extras[0].name, files: extras[1].name }, target = { ...expected, id: 'after', revision: 1, planner: `${source.name}-next`, inspector: `${source.name}-inspector-next`, files: `${source.name}-files-next` }
    await coordinator.active.put({ key: 'active', manifest: expected })
    const participants: LegacyParticipant[] = [{ kind: 'planner', database: source }, { kind: 'inspector', database: extras[0] }, { kind: 'files', database: extras[1] }]
    const capture = await captureLegacyBranch(coordinator, participants)
    await source.table('records').put({ id: 'one', value: 'later' })
    await expect(activateGuestProfile(coordinator, { id: 'stale', mode: 'replace', expected, target, capture }, participants)).rejects.toThrow()
    expect((await coordinator.active.get('active'))?.manifest).toEqual(expected)
    expect(await source.table('meta').get(GUEST_BARRIER_KEY)).toBeUndefined()
    const current = await captureLegacyBranch(coordinator, participants)
    const put = IDBObjectStore.prototype.put
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) { if (this.name === 'active') throw new DOMException('Synthetic failure', 'QuotaExceededError'); return put.apply(this, args) })
    await expect(activateGuestProfile(coordinator, { id: 'failed', mode: 'additive', expected, target, capture: current }, participants)).rejects.toThrow()
    spy.mockRestore()
    expect((await coordinator.active.get('active'))?.manifest).toEqual(expected)
    expect(await source.table('meta').get(GUEST_BARRIER_KEY)).toBeUndefined()
  } finally { vi.restoreAllMocks(); await source.delete(); for (const database of extras) await database.delete(); await coordinator.delete() }
})

for (const boundary of [0, 1, 2, 'after-pointer'] as const) it(`reconciles independent guest transaction failure at ${boundary}`, async () => {
  const legacy = await import('../workspace/legacy-capture')
  const sources = ['planner', 'inspector', 'files'].map(kind => { const database = new Dexie(`guest-outcome-${kind}-${crypto.randomUUID()}`); database.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(database); return database })
  const coordinator = new GuestCoordinatorDatabase(`guest-outcome-coordinator-${crypto.randomUUID()}`)
  try {
    const participants: LegacyParticipant[] = sources.map((database, index) => ({ kind: ['planner', 'inspector', 'files'][index] as LegacyParticipant['kind'], database }))
    for (const source of sources) await source.table('records').put({ id: 'original', value: source.name })
    const expected: GuestManifest = { version: 1, id: 'before', revision: 0, planner: sources[0].name, inspector: sources[1].name, files: sources[2].name }
    const target = { ...expected, id: 'after', revision: 1, planner: `${expected.planner}-next`, inspector: `${expected.inspector}-next`, files: `${expected.files}-next` }
    await coordinator.active.put({ key: 'active', manifest: expected })
    const capture = await captureLegacyBranch(coordinator, participants)
    if (boundary === 'after-pointer') {
      const hold = legacy.holdLegacyReaders
      let pointerCommitted = false
      const put = IDBObjectStore.prototype.put
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
        if (this.name === 'active') this.transaction.addEventListener('complete', () => { pointerCommitted = true })
        return put.apply(this, args)
      })
      vi.spyOn(legacy, 'holdLegacyReaders').mockImplementation(async (...args) => {
        const held = await hold(...args)
        return { ...held, assertAlive() { held.assertAlive(); if (pointerCommitted) throw new Error('Synthetic source outcome lost after pointer commit') } }
      })
    } else {
      const put = IDBObjectStore.prototype.put
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
        if (this.name === 'meta' && this.transaction.db.name === sources[boundary].name) throw new DOMException('Synthetic participant quota', 'QuotaExceededError')
        return put.apply(this, args)
      })
    }
    await expect(activateGuestProfile(coordinator, { id: 'outcome', mode: 'replace', expected, target, capture }, participants)).rejects.toThrow()
    vi.restoreAllMocks()
    expect((await coordinator.active.get('active'))?.manifest).toEqual(boundary === 'after-pointer' ? target : expected)
    if (boundary === 'after-pointer') expect((await coordinator.journal.get('outcome'))?.recovery).toBe('incomplete')
    for (const source of sources) expect(await source.table('meta').get(GUEST_BARRIER_KEY)).toEqual(boundary === 'after-pointer' ? { key: GUEST_BARRIER_KEY, value: 'outcome' } : undefined)
    coordinator.close()
    const restarted = new GuestCoordinatorDatabase(coordinator.name)
    expect((await reconcileGuestOperation(restarted, 'outcome', participants)).localStatus).toBe(boundary === 'after-pointer' ? 'published' : 'failed')
    restarted.close()
  } finally { vi.restoreAllMocks(); for (const source of sources) await source.delete(); await coordinator.delete() }
})

for (const acquired of [1, 3]) it(`a live activation owns rollback through barrier ${acquired} and excludes a stale observer`, async () => {
  const barrier = await import('../workspace/guest-barrier')
  const sources = ['planner', 'inspector', 'files'].map(kind => { const db = new Dexie(`owner-${kind}-${crypto.randomUUID()}`); db.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(db); return db })
  const coordinator = new GuestCoordinatorDatabase(`owner-${crypto.randomUUID()}`)
  const observer = new GuestCoordinatorDatabase(coordinator.name)
  let releaseActivation!: () => void, releaseObserver!: () => void
  const activationGate = new Promise<void>(resolve => { releaseActivation = resolve })
  const observerGate = new Promise<void>(resolve => { releaseObserver = resolve })
  try {
    const participants = sources.map((database, i) => ({ kind: ['planner', 'inspector', 'files'][i] as LegacyParticipant['kind'], database }))
    for (const db of sources) await db.table('records').put({ id: 'original' })
    const expected: GuestManifest = { version: 1, id: 'before', revision: 0, planner: sources[0].name, inspector: sources[1].name, files: sources[2].name }
    const target = { ...expected, id: 'after', revision: 1, planner: 'next-planner', inspector: 'next-inspector', files: 'next-files' }
    await coordinator.active.put({ key: 'active', manifest: expected })
    const capture = await captureLegacyBranch(coordinator, participants)
    const originalAcquire = barrier.acquireParticipantBarrier
    let ready!: () => void, calls = 0
    const paused = new Promise<void>(resolve => { ready = resolve })
    vi.spyOn(barrier, 'acquireParticipantBarrier').mockImplementation(async (...args) => { await originalAcquire(...args); if (++calls === acquired) { ready(); await activationGate } })
    const activation = activateGuestProfile(coordinator, { id: 'owned', mode: 'replace', expected, target, capture }, participants)
    await paused
    // The broken observer has already read the old pointer when its first participant read stalls
    const meta = sources[2].table('meta'), get = meta.get.bind(meta)
    let staleRead = false
    vi.spyOn(meta, 'get').mockImplementation((async (key: string) => { staleRead = true; await observerGate; return get(key) }) as typeof meta.get)
    const reconciliation = reconcileGuestOperation(observer, 'owned', participants)
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseActivation(); await activation
    releaseObserver(); const outcome = await reconciliation
    expect(outcome.localStatus).toBe('published')
    expect(staleRead).toBe(false)
    for (const db of sources) expect(await db.table('meta').get(GUEST_BARRIER_KEY)).toEqual({ key: GUEST_BARRIER_KEY, value: 'owned' })
    await expect(sources[0].table('records').put({ id: 'retired-write' })).rejects.toThrow('retired')
    observer.close(); coordinator.close()
    const reopened = new GuestCoordinatorDatabase(coordinator.name)
    expect((await reopened.active.get('active'))?.manifest).toEqual(target)
    expect((await reconcileGuestOperation(reopened, 'owned', participants)).localStatus).toBe('published')
    reopened.close()
  } finally { releaseActivation(); releaseObserver(); vi.restoreAllMocks(); observer.close(); for (const db of sources) await db.delete(); await coordinator.delete() }
})

it('fences a delayed publication callback after native ownership loss and recovery takeover', async () => {
  const sources = ['planner', 'inspector', 'files'].map(kind => { const db = new Dexie(`takeover-${kind}-${crypto.randomUUID()}`); db.version(1).stores({ records: 'id', meta: 'key' }); installGuestWriteBarrier(db); return db })
  const coordinator = new GuestCoordinatorDatabase(`takeover-${crypto.randomUUID()}`)
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  let ready!: () => void
  const paused = new Promise<void>(resolve => { ready = resolve })
  try {
    const participants = sources.map((database, i) => ({ kind: ['planner', 'inspector', 'files'][i] as LegacyParticipant['kind'], database }))
    for (const db of sources) await db.table('records').put({ id: 'original' })
    const expected: GuestManifest = { version: 1, id: 'before', revision: 0, planner: sources[0].name, inspector: sources[1].name, files: sources[2].name }
    const target = { ...expected, id: 'after', revision: 1, planner: 'next-planner', inspector: 'next-inspector', files: 'next-files' }
    await coordinator.active.put({ key: 'active', manifest: expected })
    const capture = await captureLegacyBranch(coordinator, participants)
    let ownership: IDBTransaction | undefined, publishing = false
    const native = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function(this: IDBDatabase, ...args) { const tx = native.apply(this, args); if (this.name === `${coordinator.name}-operation-ownership-v1`) ownership = tx; return tx })
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) { if (this.name === 'journal' && args[0].localStatus === 'publishing') publishing = true; return put.apply(this, args) })
    const transact = coordinator.transaction.bind(coordinator)
    vi.spyOn(coordinator, 'transaction').mockImplementation(((...args: Parameters<typeof transact>) => {
      const result = transact(...args)
      return result.then(async value => { if (publishing) { publishing = false; ready(); await gate }; return value })
    }) as typeof coordinator.transaction)
    const pending = activateGuestProfile(coordinator, { id: 'lost', mode: 'replace', expected, target, capture }, participants)
    const rejected = expect(pending).rejects.toThrow('ownership')
    await paused
    ownership!.abort()
    const observer = new GuestCoordinatorDatabase(coordinator.name)
    const recovered = await reconcileGuestOperation(observer, 'lost', participants)
    expect(recovered.localStatus).toBe('failed')
    resume(); await rejected
    expect(await observer.journal.get('lost')).toEqual(recovered)
    expect((await observer.active.get('active'))?.manifest).toEqual(expected)
    for (const db of sources) expect(await db.table('meta').get(GUEST_BARRIER_KEY)).toBeUndefined()
    observer.close()
  } finally { resume(); vi.restoreAllMocks(); for (const db of sources) await db.delete(); await coordinator.delete() }
})

it('cancels queued and active ownership promptly while fencing a delayed callback', async () => {
  const { withGuestOperationOwner } = await import('../workspace/guest-ownership')
  const coordinator = new GuestCoordinatorDatabase(`cancel-owner-${crypto.randomUUID()}`)
  const active = new AbortController(), waiting = new AbortController()
  let ready!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve }), gate = new Promise<void>(resolve => { resume = resolve })
  let staleError = ''
  const first = withGuestOperationOwner(coordinator, active.signal, async owner => { ready(); await gate; try { owner.assertAlive() } catch (error) { staleError = String(error); throw error } })
  const firstOutcome = first.catch(error => String(error))
  await entered
  const queued = withGuestOperationOwner(coordinator, waiting.signal, async () => { throw new Error('Cancelled waiter acquired authority') }).catch(error => String(error))
  waiting.abort()
  expect(await queued).toContain('ownership')
  active.abort()
  expect(await firstOutcome).toContain('ownership')
  await withGuestOperationOwner(coordinator, undefined, async owner => { owner.assertAlive() })
  resume(); await Promise.resolve(); await Promise.resolve()
  expect(staleError).toContain('ownership')
  await coordinator.delete()
})
