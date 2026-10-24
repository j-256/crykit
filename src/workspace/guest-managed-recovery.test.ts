import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it } from 'vitest'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { GUEST_BARRIER_KEY } from './guest-barrier'
import { captureLegacyBranch, type LegacyParticipant } from './legacy-capture'
import { compareManagedGuestRetained } from './guest-managed-retained'
import { memoryBlob } from './blobs'
import { captureManagedRecovery, exportManagedRecovery, withManagedRecoverySource } from './guest-managed-recovery'
import { requireGuestManagedMigration, GuestManagedRecoverySelectionSchema } from './guest-managed-contract'

it('publishes only the chosen exact recovery baseline and fences old comparisons while retaining other branches', async () => {
  const coordinator = new GuestCoordinatorDatabase(`synthetic-recovery-coordinator-${crypto.randomUUID()}`)
  const opened: Dexie[] = []
  const participants = async (prefix: string): Promise<LegacyParticipant[]> => Promise.all((['planner', 'inspector', 'files'] as const).map(async kind => {
    const database = new Dexie(`${prefix}-${kind}`); opened.push(database)
    database.version(1).stores({ meta: 'key' }); await database.table('meta').put({ key: 'native', value: 'original' })
    return { kind, database }
  }))
  const older = await participants(`synthetic-recovery-old-${crypto.randomUUID()}`), current = await participants(`synthetic-recovery-current-${crypto.randomUUID()}`)
  const names = (values: LegacyParticipant[]) => Object.fromEntries(values.map(value => [value.kind, value.database.name])) as { planner: string; inspector: string; files: string }
  const olderManifest = { version: 1 as const, id: 'old-source', revision: 0, ...names(older) }
  const legacy = { version: 1 as const, id: 'published-legacy', revision: 1, ...names(current) }
  const olderCapture = await captureLegacyBranch(coordinator, older)
  for (const value of older) await value.database.table('meta').put({ key: GUEST_BARRIER_KEY, value: legacy.id })
  await coordinator.journal.add({ version: 1, id: legacy.id, mode: 'replace', expected: olderManifest, target: legacy, capture: olderCapture, localStatus: 'published', acquired: [], recovery: 'unchecked' })
  await coordinator.active.put({ key: 'active', manifest: legacy })
  const capture = await captureLegacyBranch(coordinator, current), id = crypto.randomUUID()
  for (const value of current) await value.database.table('meta').put({ key: GUEST_BARRIER_KEY, value: id })
  const migration = requireGuestManagedMigration({ version: 1 as const, kind: 'guest-managed-migration' as const, id, expected: legacy, capture, phase: 'publishing' as const })
  await coordinator.table('managedMigrations').add(migration)
  const store = createGuestLocalStore(coordinator, () => {})
  const root = await store.adapter.stage(id, memoryBlob(new Uint8Array([1])), [])
  const first = await store.activate(id, root, legacy, () => {}, undefined, migration)
  const compare = (manifest = first.target) => compareManagedGuestRetained(coordinator.name, manifest, new AbortController().signal)
  try {
    expect(await compare()).toEqual([])
    await current[0]!.database.table('meta').put({ key: 'native', value: 'chosen recovery' })
    await older[0]!.database.table('meta').put({ key: 'native', value: 'unrelated divergence' })
    expect((await compare()).map(value => value.id)).toEqual([id, legacy.id])
    let alive = true
    const check = async () => { if (!alive) throw new Error('Synthetic captured profile retired') }
    const notice = { id, status: 'diverged' as const, frozenCaptureId: capture.id }
    await expect(captureManagedRecovery(coordinator, first.target, { ...notice, id: 'foreign' }, check, new AbortController().signal)).rejects.toThrow(/branch changed/)
    const capturedRecovery = await captureManagedRecovery(coordinator, first.target, notice, check, new AbortController().signal)
    let aborted = false, closed = false
    await expect(exportManagedRecovery(capturedRecovery, { async write() { alive = false }, async close() { closed = true }, async abort() { aborted = true } })).rejects.toThrow(/profile retired/)
    expect(aborted).toBe(true); expect(closed).toBe(false)
    alive = true
    await current[0]!.database.table('meta').put({ key: 'native', value: 'changed after capture' })
    let published = false
    await expect(withManagedRecoverySource(capturedRecovery, async () => { published = true })).rejects.toThrow(/changed during recovery copy/)
    expect(published).toBe(false)
    expect((await coordinator.active.get('active'))!.manifest).toEqual(first.target)
    await current[0]!.database.table('meta').put({ key: 'native', value: 'chosen recovery' })
    const nextCapture = await captureLegacyBranch(coordinator, current.map(value => ({ ...value, barrierOwner: id })))
    const selection = GuestManagedRecoverySelectionSchema.parse({ version: 1, kind: 'selected-guest-recovery', branchId: id, originalCaptureId: capture.id, previousCaptureId: capture.id, capture: nextCapture })
    const nextRoot = await store.adapter.stage('copy', memoryBlob(new Uint8Array([2])), [root])
    const copied = await store.activate('copy', nextRoot, first.target, () => {}, undefined, undefined, selection)
    expect(copied.target.recoveryId).toBe('copy')
    expect(await compare(copied.target)).toEqual([{ id: legacy.id, status: 'diverged', frozenCaptureId: olderCapture.id }])
    await expect(compare(first.target)).rejects.toThrow(/selection changed/)
    expect(await coordinator.captures.get(capture.id)).toEqual(capture)
    expect(await coordinator.captures.get(nextCapture.id)).toEqual(nextCapture)
    await older[0]!.database.table('meta').put({ key: 'native', value: 'original' })
    expect(await compare(copied.target)).toEqual([])
    const normal = await store.adapter.stage('ordinary', memoryBlob(new Uint8Array([3])), [nextRoot])
    const advanced = await store.activate('ordinary', normal, copied.target, () => {})
    expect(advanced.target.recoveryId).toBe('copy')
    expect(await compare(copied.target)).toEqual([])
    await current[0]!.database.table('meta').put({ key: 'native', value: 'later old-tab edit' })
    expect(await compare(advanced.target)).toEqual([{ id, status: 'diverged', frozenCaptureId: nextCapture.id }])
    const row = await coordinator.table('managedOperations').get('copy')
    await coordinator.table('managedOperations').put({ ...row, recovery: { ...row.recovery, previousCaptureId: olderCapture.id } })
    await expect(compare(advanced.target)).rejects.toThrow(/continuity/)
    await coordinator.table('managedOperations').put(row)
    const invalid = await store.adapter.stage('foreign', memoryBlob(new Uint8Array([4])), [])
    await expect(store.activate('foreign', invalid, advanced.target, () => {}, undefined, undefined, { ...selection, branchId: 'foreign' })).rejects.toThrow()
    expect((await coordinator.active.get('active'))!.manifest).toEqual(advanced.target)
    expect(await store.receipt('foreign')).toBeUndefined()
  } finally { for (const database of opened) database.close(); coordinator.close() }
})
