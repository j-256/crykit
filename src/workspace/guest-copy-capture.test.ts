import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { createBlankLocalData } from '../domain/local-data'
import { invalidateProfile } from '../account/profile'
import { captureGuestWorkspaceForCopy } from './guest-repository'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { assertOwnedWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot, ownWorkspaceSnapshot } from './snapshot'
import { openGuestBindings } from './guest-workspace'
import { guestEvidenceFromSnapshot, writeGuestEvidence, emptyPlannerEvidence, guestEvidenceSources, guestEvidenceForCopy } from './guest-evidence'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { editorClosureFixture } from './test-helpers'
import { readBlob, blobIdentity } from './blobs'

// This source-freshness fixture has no catalog references; native catalog capture is exercised in browsers
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

it('captures a pre-account planner without upgrading its original database or saved root', async () => {
  const original = new CryKitDatabase(`synthetic-preaccount-copy-${crypto.randomUUID()}`), raw = new Dexie(original.name)
  raw.version(6).stores(Object.fromEntries(original.tables.map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')])))
  const { teamRevisions: _teamRevisions, ...data } = createBlankLocalData()
  const row = { id: 'local-data-record', revision: data.revision, updatedAt: data.updatedAt, localData: { ...data, schemaVersion: '2.4.0' }, lineage: { rootLocalDataId: data.id } }
  await raw.table('localDatas').put(row)
  raw.close()
  const { snapshot, originals } = await captureGuestWorkspaceForCopy(original), retained = new Dexie(original.name)
  try {
    await retained.open()
    expect(retained.backendDB().version).toBe(60)
    expect(await retained.table('localDatas').get(row.id)).toEqual(row)
    if (snapshot.version !== 2) throw new Error('The original planner is missing')
    let found = false
    for (const { id } of snapshot.historicalEvidence.snapshots) {
      const historical = await openHistoricalSnapshot(snapshot, id)
      try { if (historical.state.planner.localData.schemaVersion === row.localData.schemaVersion) { expect(historical.state.planner.localData).toEqual(row.localData); found = true } }
      finally { await disposeWorkspaceSnapshot(historical) }
    }
    expect(found).toBe(true)
    expect(originals).toBeDefined()
    expect(guestEvidenceSources(originals!).members.map(member => member.id)).toEqual(snapshot.historicalEvidence.snapshots.map(member => member.id))
    const selected = ownWorkspaceSnapshot({ version: 1, snapshotId: 'selected-copy', capturedAt: snapshot.capturedAt, revisionVector: {}, state: snapshot.state }, { check: () => assertOwnedWorkspaceSnapshot(snapshot), async dispose() {} })
    const selectedOnly = await guestEvidenceForCopy(selected), complete = await guestEvidenceForCopy(selected, snapshot, originals)
    const expectedIds = new Set([...guestEvidenceSources(selectedOnly).members.map(member => member.id), ...snapshot.historicalEvidence.snapshots.map(member => member.id)])
    expect(new Set(guestEvidenceSources(complete).members.map(member => member.id))).toEqual(expectedIds)
    await expect(guestEvidenceForCopy(selected, snapshot, { ...originals! })).rejects.toThrow(/captured|registered/)
    await expect(guestEvidenceForCopy(selected, snapshot, selectedOnly)).rejects.toThrow(/differs/)
  } finally { await disposeWorkspaceSnapshot(snapshot); invalidateProfile(); original.close(); retained.close() }
})

it.each([false, true])('captures a legacy copy with its complete original and freshness fence without migrating the source: inherited=%s', async inherited => {
  const original = new CryKitDatabase(`synthetic-copy-only-${crypto.randomUUID()}`), coordinator = new GuestCoordinatorDatabase(`${original.name}-coordinator`)
  const localData = createBlankLocalData()
  await original.localDatas.add({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  const fixture = await editorClosureFixture()
  let originalId: string | undefined
  if (inherited) {
    const prior = await inheritWorkspaceSnapshot({ version: 1, snapshotId: 'older-copy-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }, [{ version: 1, snapshotId: 'older-copy-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }])
    const binding = await openGuestBindings(original)
    try {
      originalId = prior.historicalEvidence.snapshots[0].id
      await writeGuestEvidence(binding.files, await guestEvidenceFromSnapshot(prior, emptyPlannerEvidence()))
    } finally { await disposeWorkspaceSnapshot(prior); binding.files.close(); binding.inspector.close(); binding.coordinator.close() }
  }
  const before = await original.localDatas.toArray(), { snapshot } = await captureGuestWorkspaceForCopy(original)
  try {
    expect((await coordinator.active.get('active'))!.manifest.version).toBe(1)
    expect(await coordinator.table('managedMigrations').count()).toBe(0)
    expect(await coordinator.table('managedRecords').count()).toBe(0)
    expect(await original.localDatas.toArray()).toEqual(before)
    if (snapshot.version !== 2) throw new Error('The complete source original is missing')
    expect(snapshot.historicalEvidence.snapshots).toHaveLength(inherited ? 2 : 1)
    for (const { id } of snapshot.historicalEvidence.snapshots) {
      const historical = await openHistoricalSnapshot(snapshot, id)
      try {
        if (id !== originalId) expect(historical.state.planner.localData).toEqual(localData)
        else for (const body of fixture.state.blobs) expect(await readBlob(historical.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      } finally { await disposeWorkspaceSnapshot(historical) }
    }
    await original.meta.put({ key: 'synthetic-copy-source-change', value: 'changed' })
    await expect(assertOwnedWorkspaceSnapshot(snapshot)).rejects.toThrow(/changed/i)
  } finally { await disposeWorkspaceSnapshot(snapshot); invalidateProfile(); original.close(); coordinator.close() }
})
