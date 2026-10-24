import { createPersonalDefinition } from '../domain/local-data'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { addTestBuild, createTestLocalData, TEST_NOW } from '../domain/test-helpers'

// This fixture has no catalog refs; migration ownership is independent of bundled game-data volume
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

// These native-version migration and restore subjects keep the real native wrapper and source barriers
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

const tables = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
async function fixture(badHistory: boolean) {
  const name = `team-migration-${crypto.randomUUID()}`
  names.push(name)
  const old = new Dexie(name)
  old.version(6).stores(tables)
  const seeded = addTestBuild(addTestBuild(createTestLocalData(), 'source-one', '', {}), 'source-two', '', {})
  const setupId = seeded.buildRevisions['source-two-revision']!.gameSetupRevisionId
  const { teamRevisions: _revisions, ...base } = seeded
  const data = { ...base, gameSetups: { ...base.gameSetups, different: { ...base.gameSetups[setupId]!, id: 'different' as never, ppLimit: { state: 'known', value: 99 } } }, buildRevisions: { ...base.buildRevisions, 'source-two-revision': { ...base.buildRevisions['source-two-revision']!, gameSetupRevisionId: 'different' as never } } } as typeof base
  const team = (id: string, slots: (string | null)[]) => ({ id, title: id, revision: 0, slots, createdAt: TEST_NOW, updatedAt: TEST_NOW })
  const before = { ...data, schemaVersion: '2.4.0', teams: { empty: team('empty', [null, null, null, null]), mixed: team('mixed', ['source-one-revision', null, 'source-two-revision', null]), equivalent: team('equivalent', ['source-one-revision', null, 'source-one-revision', null]) } }
  const { teamRevisions: _afterRevisions, ...changed } = createPersonalDefinition({ ...data, teamRevisions: {} }, { name: 'Synthetic', kind: 'item', now: TEST_NOW })
  const after = { ...changed, schemaVersion: '2.4.0', teams: before.teams }
  const root = { id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: after, lineage: { rootLocalDataId: before.id } }
  const history = { id: 'old-undo', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: badHistory ? { ...before, schemaVersion: '2.99.0' } : before, after, recordedAt: TEST_NOW }
  await old.table('localDatas').put(root)
  await old.table('history').put(history)
  old.close()
  return { name, root, history }
}
it('badUndoSnapshotRollsBackWholeUpgrade', async () => {
  const { name, root, history } = await fixture(true)
  const next = new CryKitDatabase(name)
  await expect(next.open().then(() => 'opened')).rejects.toThrow()
  next.close()
  const old = new Dexie(name)
  old.version(6).stores(tables)
  await old.open()
  expect(old.backendDB().version).toBe(60)
  expect(await old.table('localDatas').get(root.id)).toEqual(root)
  expect(await old.table('history').get(history.id)).toEqual(history)
  old.close()
})
it('migrates roots and every undo endpoint together without renumbering history', async () => {
  const { name, root, history } = await fixture(false)
  const next = new CryKitDatabase(name)
  await next.open()
  expect(next.backendDB().version).toBe(70)
  expect((await next.localDatas.get(root.id))!.localData.schemaVersion).toBe('2.5.0')
  const migrated = (await next.history.get(history.id))!
  expect(migrated.before.schemaVersion).toBe('2.5.0')
  expect(migrated.after.schemaVersion).toBe('2.5.0')
  expect(migrated.id).toBe(history.id)
  expect(migrated.previousRevision).toBe(history.previousRevision)
  expect(migrated.nextRevision).toBe(history.nextRevision)
  expect(await next.meta.get('domain-2.5.0-rollback')).toBeDefined()
  next.close()
})

it('admits frozen native60 read-only and requires a fresh exact70 handle for current data', async () => {
  const { openSelectedGuestPlanner } = await import('../workspace/open-required-guest-planner')
  const { acquireParticipantBarrier, releaseParticipantBarrier } = await import('../workspace/guest-barrier')
  const old = await fixture(false)
  const owner = { signal: new AbortController().signal, assertCurrent: () => undefined }
  const source = await openSelectedGuestPlanner(old.name, owner)
  try {
    expect(source.frozenSource240).toBe(true)
    expect(source.backendDB().version).toBe(60)
    expect(await source.localDatas.get(old.root.id)).toEqual(old.root)
    await expect(source.meta.put({ key: 'forbidden', value: 'write' })).rejects.toThrow('read-only')
    await expect(source.vip.table('meta').put({ key: 'forbidden', value: 'vip' })).rejects.toThrow('read-only')
    await acquireParticipantBarrier(source, 'migration-owner')
    expect((await source.meta.get('workspace-write-barrier-v1'))?.value).toBe('migration-owner')
    await releaseParticipantBarrier(source, 'migration-owner')
    expect(await source.meta.get('forbidden')).toBeUndefined()
  } finally { source.close() }
  const currentName = `team-current-${crypto.randomUUID()}`
  names.push(currentName)
  const current = new CryKitDatabase(currentName)
  await current.open(); current.close()
  const selected = await openSelectedGuestPlanner(currentName, owner)
  try { expect(selected.frozenSource240).toBe(false); expect(selected.backendDB().version).toBe(70) }
  finally { selected.close() }
})

it('does not create a missing selected source and rejects intermediate or future layouts', async () => {
  const { openSelectedGuestPlanner } = await import('../workspace/open-required-guest-planner')
  const owner = { signal: new AbortController().signal, assertCurrent: () => undefined }
  const missing = `team-missing-${crypto.randomUUID()}`
  names.push(missing)
  await expect(openSelectedGuestPlanner(missing, owner).then(() => 'opened')).rejects.toThrow()
  expect((await indexedDB.databases()).some(database => database.name === missing)).toBe(false)
  for (const version of [50, 65, 80]) {
    const name = `team-unsupported-${crypto.randomUUID()}`
    names.push(name)
    const old = new Dexie(name); old.version(version / 10).stores(tables); await old.open(); old.close()
    await expect(openSelectedGuestPlanner(name, owner).then(() => 'opened')).rejects.toThrow()
    expect((await indexedDB.databases()).find(database => database.name === name)?.version).toBe(version)
  }
})

async function selectedFixture() {
  const { GuestCoordinatorDatabase } = await import('../workspace/guest-coordinator')
  const { GuestFilesDatabase } = await import('../workspace/guest-files')
  const { InspectorStorage } = await import('../mod-inspector/storage')
  const { captureLegacyBranch } = await import('../workspace/legacy-capture')
  const { GUEST_PLANNER_LAYOUT_KEY } = await import('./guest-planner-record')
  const { name, root, history } = await fixture(false)
  const original = new CryKitDatabase(`team-route-${crypto.randomUUID()}`)
  const coordinator = new GuestCoordinatorDatabase(`${original.name}-coordinator`)
  const id = crypto.randomUUID(), prefix = `crykit-restored-v2-${id}`
  const manifest = { version: 2 as const, id, revision: 1, planner: `${prefix}-planner`, inspector: `${prefix}-inspector`, files: `${prefix}-files` }
  names.push(original.name, coordinator.name, manifest.planner, manifest.inspector, manifest.files)
  const planner = new Dexie(manifest.planner); planner.version(6).stores(tables)
  const epoch = crypto.randomUUID()
  const record = { ...root, operativePlanner: { version: 1, kind: 'guest-operative-planner', epoch, localDataId: root.localData.id, revision: root.revision, checkpointIds: [history.id], savedDestinationChanges: root.localData.changes, undoable: true } }
  await planner.table('localDatas').put(record)
  await planner.table('history').put(history)
  await planner.table('meta').put({ key: GUEST_PLANNER_LAYOUT_KEY, value: JSON.stringify({ version: 1, kind: 'guest-journaled-planner', epoch }) })
  const files = new GuestFilesDatabase(manifest.files), inspector = new InspectorStorage(manifest.inspector)
  await files.open()
  const capture = await captureLegacyBranch(coordinator, [{ kind: 'planner', database: planner }, { kind: 'inspector', database: await inspector.openDatabase() }, { kind: 'files', database: files }])
  await coordinator.table('journal').put({ version: 2, kind: 'guest-restore', id, expected: { ...manifest, version: 1, id: 'synthetic-previous', revision: 0 }, target: manifest, capture, targetCapture: capture, phase: 'published', ownerGeneration: 0, sourceVectorDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), acquired: [], recovery: 'equal' })
  await coordinator.table('active').put({ key: 'active', manifest })
  planner.close(); inspector.close(); files.close()
  return { original, coordinator, manifest, record, history, name }
}

it('migrates a selected native60 journal through the successor and retains its original history', async () => {
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { readGuestEvidence, databaseEvidenceRows, guestEvidenceSources } = await import('../workspace/guest-evidence')
  const setup = await selectedFixture()
  let binding: Awaited<ReturnType<typeof guestRepositoryBindings>> | undefined
  try {
    const repository = createGuestRepository(setup.original)
    const state = await repository.readWorkspace()
    binding = await guestRepositoryBindings(repository)
    names.push(binding.manifest.planner, binding.manifest.inspector, binding.manifest.files)
    expect(binding.manifest.id).not.toBe(setup.manifest.id)
    expect(binding.planner.backendDB().version).toBe(70)
    expect(state.planner.localData.schemaVersion).toBe('2.5.0')
    expect(state.planner.localData.revision).toBe(setup.record.revision)
    expect(state.planner.localData.changes).toEqual(setup.record.localData.changes)
    expect(state.planner.journal!.checkpoints.map(entry => entry.id)).toEqual([setup.history.id])
    expect(state.planner.journal!.checkpoints[0]!.before.schemaVersion).toBe('2.5.0')
    expect((await indexedDB.databases()).find(database => database.name === setup.manifest.planner)?.version).toBe(60)
    const retained = await readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    const sources = guestEvidenceSources(retained)
    expect(sources.members).toHaveLength(1)
    const { readBackupMetadata } = await import('../interchange/workspace-backup-evidence')
    const metadata = await readBackupMetadata(sources.members[0]!.metadata) as { state: { planner: { localData: unknown; history: unknown[] } } }
    expect(metadata.state.planner.localData).toEqual(setup.record.localData)
    expect(metadata.state.planner.history).toEqual([setup.history])
    const saved = await repository.save(createPersonalDefinition(state.planner.localData, { name: 'After migration', kind: 'item', now: TEST_NOW }), state.planner.localData.revision)
    const successor = createGuestRepository(setup.original)
    const undone = await successor.undo(saved.localData.revision)
    const finalRepository = createGuestRepository(setup.original)
    const final = await finalRepository.readWorkspace()
    expect(final.planner.localData.teams.empty!.kind).toBe('legacy-mixed')
    expect(final.planner.localData.teams.mixed).toEqual({ ...setup.record.localData.teams.mixed, kind: 'legacy-mixed' })
    expect(final.planner.localData.teams.equivalent!.kind).toBe('shared')
    expect(final.planner.localData.buildRevisions).toEqual(setup.record.localData.buildRevisions)
    expect(undone.localData.personalDefinitions).toEqual(state.planner.localData.personalDefinitions)
    const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
    const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
    const { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, activateGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview } = await import('../workspace/restore')
    const capture = await captureWorkspaceSnapshot(finalRepository)
    const backup = await readWorkspaceBackup(exportWorkspaceBackup(capture))
    try {
      if (backup.version !== 2) throw new Error('Missing guest inherited original')
      const original = await openHistoricalSnapshot(backup, backup.historicalEvidence.snapshots[0]!.id)
      try {
        expect(original.state.planner.localData).toEqual(setup.record.localData)
        expect(original.state.planner.history).toEqual([setup.history])
      } finally { await disposeWorkspaceSnapshot(original) }
      const preview = await previewGuestWorkspaceRestore(await guestRepositoryBindings(finalRepository), backup)
      try {
        const journal = await beginGuestWorkspaceRestore(preview)
        names.push(journal.target.planner, journal.target.inspector, journal.target.files)
        await stageGuestWorkspaceRestore(preview, journal.id)
        await activateGuestWorkspaceRestore(preview, journal.id)
        const restored = await createGuestRepository(setup.original).readWorkspace()
        expect(restored.planner.localData.teams).toEqual(final.planner.localData.teams)
        expect(restored.planner.localData.teamRevisions).toEqual(final.planner.localData.teamRevisions)
        expect(restored.planner.localData.buildRevisions).toEqual(setup.record.localData.buildRevisions)
      } finally { await releaseGuestWorkspaceRestorePreview(preview) }
    } finally { await disposeWorkspaceSnapshot(backup); await disposeWorkspaceSnapshot(capture) }

  } finally {
    binding?.planner.close(); binding?.inspector.close(); binding?.files.close(); binding?.coordinator.close()
    const journals = await setup.coordinator.table('journal').toArray()
    for (const journal of journals) names.push(journal.target.planner, journal.target.inspector, journal.target.files)
    setup.coordinator.close(); setup.original.close()
  }
})

it.each(['stage', 'final-owner', 'malformed-history'] as const)('retains the selected native60 source after %s failure', async failure => {
  const { migrateSelectedGuest250 } = await import('../workspace/guest-successor')
  const { openSelectedGuestPlanner } = await import('../workspace/open-required-guest-planner')
  const { GuestFilesDatabase } = await import('../workspace/guest-files')
  const { InspectorStorage } = await import('../mod-inspector/storage')
  const setup = await selectedFixture()
  const planner = await openSelectedGuestPlanner(setup.manifest.planner, { signal: new AbortController().signal, assertCurrent: () => undefined })
  const binding = { coordinator: setup.coordinator, manifest: setup.manifest, planner, inspector: new InspectorStorage(setup.manifest.inspector, { requiredGuestTarget: true }), files: new GuestFilesDatabase(setup.manifest.files, { requiredGuestTarget: true }) }
  let checks = 0
  try {
    if (failure === 'malformed-history') {
      const raw = new Dexie(setup.manifest.planner); await raw.open()
      await raw.table('history').put({ ...setup.history, before: { ...setup.history.before, schemaVersion: '2.99.0' } }); raw.close()
    }
    const history = await planner.history.toArray()
    if (failure === 'stage') {
      const open = CryKitDatabase.prototype.open
      vi.spyOn(CryKitDatabase.prototype, 'open').mockImplementation(function (this: CryKitDatabase) {
        if (this.name !== setup.manifest.planner) throw new Error('Synthetic target-stage failure')
        return open.call(this)
      })
    }
    await expect(migrateSelectedGuest250(binding, () => { if (failure === 'final-owner' && ++checks === 3) throw new Error('Synthetic stale owner') })).rejects.toThrow()
    expect((await setup.coordinator.active.get('active'))!.manifest).toEqual(setup.manifest)
    expect((await indexedDB.databases()).find(database => database.name === setup.manifest.planner)?.version).toBe(60)
    expect(await planner.localDatas.get(setup.record.id)).toEqual(setup.record)
    expect(await planner.history.toArray()).toEqual(history)
    expect(await planner.meta.get('workspace-write-barrier-v1')).toBeUndefined()
    if (failure === 'final-owner') expect(checks).toBe(3)
  } finally {
    vi.restoreAllMocks()
    const journals = await setup.coordinator.table('journal').toArray()
    for (const journal of journals) names.push(journal.target.planner, journal.target.inspector, journal.target.files)
    planner.close(); binding.inspector.close(); binding.files.close(); setup.coordinator.close(); setup.original.close()
  }
})

it('keeps frozen account bodies and inherited originals through migration, edit, publication and backup restore', async () => {
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { AccountDatabase, activateLocalAccountCommit } = await import('./account-database')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { prepareAccountWorkspace, openAccountWorkspace } = await import('../workspace/account-graph')
  const { openAccountRepository } = await import('../workspace/account-repository')
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { preparePublicationAttempt } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  const old = await fixture(false)
  const state = { planner: { localData: old.root.localData, lineage: old.root.lineage, catalogs: [], sources: [], evidence: [], history: [old.history], journal: { version: 1, changes: old.root.localData.changes, checkpoints: [old.history], undoable: true } }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } } as unknown as import('../workspace/documents').WorkspaceState
  let capture: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  let restored: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    const initial = await prepareAccountWorkspace(database, token, state)
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records, intentStatus: 'mapped-local' })
    const originalState = (await openAccountWorkspace(database, token, fence.head)).state
    const originals = await database.encryptedRevisions.toArray()
    const repository = await openAccountRepository(token)
    const migrated = await repository.readWorkspace()
    expect(migrated.planner.localData.schemaVersion).toBe('2.5.0')
    expect(migrated.planner.localData.revision).toBe(old.root.revision)
    expect(migrated.planner.history).toEqual([old.history])
    expect(migrated.planner.journal!.checkpoints[0]!.before.schemaVersion).toBe('2.5.0')
    expect((await openAccountWorkspace(database, token, fence.head)).state).toEqual(originalState)
    const changed = createPersonalDefinition(migrated.planner.localData, { name: 'Edited shared Team workspace', kind: 'item', now: TEST_NOW })
    const saved = await repository.save(changed, migrated.planner.localData.revision)
    const active = (await database.profileMeta.get('active'))!
    const { openManagedNativeWorkspace } = await import('./managed-sync.test-helpers')
    const workspace = await openManagedNativeWorkspace(database, token)
    const publication = await preparePublicationAttempt(database, token, workspace, null, new Map(), 0)
    const heads = new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId]))
    const remote = await openRemoteProjection(database, token, heads, workspace.head, active.headRevision)
    expect(remote!.workspace.state.planner.localData.teams).toEqual(changed.teams)
    expect(remote!.workspace.inheritedEvidence).toBeDefined()
    for (const original of originals) expect(await database.encryptedRevisions.get(original.revisionId)).toEqual(original)
    capture = await captureWorkspaceSnapshot(repository)
    restored = await readWorkspaceBackup(exportWorkspaceBackup(capture))
    expect(restored.state.planner.localData).toEqual(saved.localData)
    if (restored.version !== 2) throw new Error('Expected complete inherited backup')
    let found = false
    for (const member of restored.historicalEvidence.snapshots) {
      const historical = await openHistoricalSnapshot(restored, member.id)
      try {
        if (String(historical.state.planner.localData.schemaVersion) === '2.4.0') {
          expect(historical.state.planner.localData).toEqual(originalState.planner.localData)
          expect(historical.state.planner.history).toEqual([old.history])
          expect(historical.sourceEvidence!.units.some(unit => JSON.parse(unit.key)[0] === 'team')).toBe(true)
          found = true
        }
      } finally { await disposeWorkspaceSnapshot(historical) }
    }
    expect(found).toBe(true)
    // Exercise the destination boundary, including the source/live pair sharing one immutable history ID
    expect(restored.state.planner.history.find(entry => entry.id === old.history.id)).toEqual(old.history)
    expect(restored.state.planner.journal!.checkpoints.find(entry => entry.id === old.history.id)!.after.schemaVersion).toBe('2.5.0')
    const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
    const { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, activateGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview } = await import('../workspace/restore')
    const guest = new CryKitDatabase(`account-backup-guest-${crypto.randomUUID()}`)
    names.push(guest.name, `${guest.name}-coordinator`, `${guest.name}-inspector`, `${guest.name}-workspace-files-v1`)
    const blank = createTestLocalData()
    await guest.localDatas.add({ id: 'local-data-record', revision: blank.revision, updatedAt: blank.updatedAt, localData: blank, lineage: { rootLocalDataId: blank.id } })
    const guestRepositories = [createGuestRepository(guest)]
    const binding = await guestRepositoryBindings(guestRepositories[0])
    let roundTrip: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
    let guestCapture: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
    const preview = await previewGuestWorkspaceRestore(binding, restored)
    try {
      const journal = await beginGuestWorkspaceRestore(preview)
      names.push(journal.target.planner, journal.target.inspector, journal.target.files)
      const staged = await stageGuestWorkspaceRestore(preview, journal.id)
      expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(journal.expected)
      expect(await activateGuestWorkspaceRestore(preview, staged.id)).toEqual(staged.target)
      const reopened = createGuestRepository(guest)
      guestRepositories.push(reopened)
      const accepted = await reopened.readWorkspace()
      expect(accepted.planner.localData.teams).toEqual(saved.localData.teams)
      expect(accepted.planner.localData.teamRevisions).toEqual(saved.localData.teamRevisions)
      expect(accepted.planner.localData.buildRevisions).toEqual(old.root.localData.buildRevisions)
      expect(accepted.planner.history).toContainEqual(old.history)
      expect(accepted.planner.journal).toMatchObject({ checkpoints: [], undoable: false })
      const guestSaved = await reopened.save(createPersonalDefinition(accepted.planner.localData, { name: 'Guest edit after account restore', kind: 'item', now: TEST_NOW }), accepted.planner.localData.revision)
      const undoRepository = createGuestRepository(guest)
      guestRepositories.push(undoRepository)
      const undone = await undoRepository.undo(guestSaved.localData.revision)
      expect(undone.localData.personalDefinitions).toEqual(accepted.planner.localData.personalDefinitions)
      const finalRepository = createGuestRepository(guest)
      guestRepositories.push(finalRepository)
      const final = await finalRepository.readWorkspace()
      expect(final.planner.localData.teamRevisions).toEqual(saved.localData.teamRevisions)
      expect(final.planner.history).toContainEqual(old.history)
      guestCapture = await captureWorkspaceSnapshot(finalRepository)
      roundTrip = await readWorkspaceBackup(exportWorkspaceBackup(guestCapture))
      if (roundTrip.version !== 2) throw new Error('Expected inherited account originals after guest restore')
      let foundOriginal = false
      for (const member of roundTrip.historicalEvidence.snapshots) {
        const historical = await openHistoricalSnapshot(roundTrip, member.id)
        try {
          if (String(historical.state.planner.localData.schemaVersion) === '2.4.0') {
            expect(historical.state.planner.localData).toEqual(originalState.planner.localData)
            expect(historical.state.planner.history).toEqual([old.history])
            expect(historical.sourceEvidence!.units.some(unit => JSON.parse(unit.key)[0] === 'team')).toBe(true)
            foundOriginal = true
          }
        } finally { await disposeWorkspaceSnapshot(historical) }
      }
      expect(foundOriginal).toBe(true)
    } finally {
      if (roundTrip) await disposeWorkspaceSnapshot(roundTrip)
      if (guestCapture) await disposeWorkspaceSnapshot(guestCapture)
      await releaseGuestWorkspaceRestorePreview(preview)
      for (const journal of await binding.coordinator.journal.toArray()) names.push(journal.target.planner, journal.target.inspector, journal.target.files)
      for (const repository of guestRepositories) {
        const handles = await guestRepositoryBindings(repository)
        handles.planner.close(); handles.inspector.close(); handles.files.close(); handles.coordinator.close()
      }
      guest.close()
    }
  } finally {
    if (restored) await disposeWorkspaceSnapshot(restored)
    if (capture) await disposeWorkspaceSnapshot(capture)
    invalidateProfile(); await database.delete()
  }
})
