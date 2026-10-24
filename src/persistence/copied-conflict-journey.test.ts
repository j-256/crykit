import { appendFileSync } from 'node:fs'
import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { createWorkspaceConflict, resolveConflict } from '../workspace/conflicts'
import { editorClosureFixture } from '../workspace/test-helpers'
import { ownWorkspaceSnapshot } from '../workspace/snapshot'
import { createGuestCopyService } from '../workspace/guest-copy'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { conflictService } from './sync-conflict-fixture'

async function* copiedConflictJourney(mode: 'copy' | 'restore') {
  const started = Date.now()
  const mark = (phase: string) => { if (process.env.CRYKIT_COPY_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_COPY_PROOF_TIMINGS, `${JSON.stringify({ mode, phase, elapsedMs: Date.now() - started })}\n`) }
  mark('start')
  const fixture = await editorClosureFixture()
  const sourceToken = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const sourceDb = new AccountDatabase(sourceToken.accountId)
  const original = { ...fixture.state, editorDocuments: [fixture.file] }
  const base = await prepareAccountWorkspace(sourceDb, sourceToken, original)
  const pending = await prepareAccountWorkspace(sourceDb, sourceToken, { ...original, editorDocuments: [{ ...fixture.file, filename: 'Imported pending.json' }] }, base.opened)
  const accepted = await prepareAccountWorkspace(sourceDb, sourceToken, { ...original, editorDocuments: [{ ...fixture.file, filename: 'Imported accepted.json' }] }, base.opened)
  await sourceDb.encryptedRevisions.bulkAdd([...base.records, ...pending.records, ...accepted.records])
  const { stagePublicationRecord } = await import('../account/sync/publication')
  const { readOriginalPublication } = await import('../account/sync/conflict-authority')
  const { cipherRef } = await import('../workspace/account-cache')
  const key = '["editor","editor-1"]'
  const ancestorRef = cipherRef(await stagePublicationRecord(sourceDb, sourceToken, base.entries.find(entry => entry.key === key)!, base.opened.lineageId))
  const pendingRef = cipherRef(await stagePublicationRecord(sourceDb, sourceToken, pending.entries.find(entry => entry.key === key)!, base.opened.lineageId, ancestorRef))
  const acceptedRef = cipherRef(await stagePublicationRecord(sourceDb, sourceToken, accepted.entries.find(entry => entry.key === key)!, base.opened.lineageId, ancestorRef))
  const authority: import('../workspace/conflict-authority').ConflictAuthority = { version: 1, unit: { kind: 'record', privateKey: key }, lineageId: base.opened.lineageId, commonAncestor: { kind: 'present', publication: await readOriginalPublication(sourceDb, sourceToken, ancestorRef) }, branches: [{ role: 'local-pending', publication: await readOriginalPublication(sourceDb, sourceToken, pendingRef) }, { role: 'accepted-cloud', publication: await readOriginalPublication(sourceDb, sourceToken, acceptedRef) }] }
  const captured = await createWorkspaceConflict({ base: base.opened, local: pending.opened, remote: accepted.opened, privateKey: key, authority })
  const portable = { ...accepted.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const backup = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'source-account-comparison', capturedAt: '2026-10-13', revisionVector: {}, state: portable }))
  // The strict portable archive has no executable intent or receipt; destination registration is new work
  invalidateProfile(); await sourceDb.delete()
  mark('portable-backup-key-removed')
  const server = await conflictService()
  try {
    const first = await server.device(0, { ...original, editorDocuments: [{ ...fixture.file, filename: 'Destination.json' }] })
    expect((await first.settle()).state).toBe('synced')
    mark('destination-initial-published')
    const service = createGuestCopyService(async () => ownWorkspaceSnapshot({ version: 1, snapshotId: 'foreign-original', capturedAt: '2026-10-13', revisionVector: {}, state: backup.state }, { async check() {}, async dispose() {} }))
    let operationId: string
    if (mode === 'copy') {
      const preview = await service.previewGuestCopy(first.token, [JSON.stringify(['conflict', captured.conflict.id])])
      await service.commitGuestCopy(first.token, preview)
      operationId = preview.copyId
      mark('copy-activated')
      await first.settle()
      mark('collision-published')
      const state = await (await first.open()).readWorkspace()
      expect(state.editorDocuments[0].filename).toBe('Destination.json')
      expect(state.conflicts).toHaveLength(1)
      expect((await service.inspectCopiedComparisons(first.token))[0].collision).toBe(true)
      mark('collision-inspected')
      await resolveConflict(first.token, state.conflicts[0].id, 'this', state.planner.localData.revision)
      await first.settle()
      mark('imported-base-chosen')
    } else {
      const { previewAccountWorkspaceRestore, stageAccountWorkspaceRestore, activateAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage } = await import('../workspace/account-restore')
      const preview = await previewAccountWorkspaceRestore(first.db, first.token, backup)
      const stage = await stageAccountWorkspaceRestore(preview)
      try { await activateAccountWorkspaceRestore(stage); operationId = stage.id }
      finally { releaseAccountWorkspaceRestorePreview(preview); await releaseAccountWorkspaceRestoreStage(stage) }
      expect((await (await first.open()).readWorkspace()).conflicts).toEqual([])
      await first.settle()
    }
    let state = await (await first.open()).readWorkspace()
    expect(state.editorDocuments[0].filename).toBe('Imported accepted.json')
    mark('before-continuation')
    await service.continueCopiedComparisons(first.token, operationId)
    mark('continuation-saved')
    await first.settle()
    mark('destination-comparison-published')
    expect((await service.inspectCopiedComparisons(first.token))[0].registered).toBe(true)
    mark('registered-inspected')
    await service.dispose()
    const second = await server.device(1)
    await second.settle()
    mark('second-device-pulled')
    state = await (await second.open()).readWorkspace()
    const reader = createGuestCopyService(async () => { throw new Error('Historical inspection must not capture guest records') })
    const originals = await reader.inspectCopiedComparisons(second.token)
    expect(originals.some(value => value.originalId === captured.conflict.id && value.historical)).toBe(true)
    await reader.dispose()
    mark('originals-inspected')
    const conflict = state.conflicts.find(value => value.disposition.kind === 'unresolved')!
    const versions = await Promise.all(conflict.branches.map(branch => inspectWorkspaceClosure(state, branch.closure)))
    expect(versions.map(value => (value.value as { filename: string }).filename)).toEqual(['Imported pending.json', 'Imported accepted.json'])
    const { readRemoteState, readRemoteHeads } = await import('../account/sync/pull')
    const { openRemoteProjection } = await import('../account/sync/projection')
    const remoteState = (await readRemoteState(second.db, second.token))!.value
    const projection = (await openRemoteProjection(second.db, second.token, await readRemoteHeads(second.db, second.token, remoteState.heads), (await second.native()).head, state.planner.localData.revision))!
    const parents = [versions[0].publication!.ref.revisionId, projection.units.get(conflict.unit.privateKey)!.ref.revisionId]
    expect(parents).not.toContain(pendingRef.revisionId)
    expect(parents).not.toContain(acceptedRef.revisionId)
    yield
    mark('before-final-choice')
    await resolveConflict(second.token, conflict.id, 'this', state.planner.localData.revision)
    mark('final-choice-saved')
    expect((await second.settle()).state).toBe('synced')
    mark('final-choice-synced')
    expect((await (await second.open()).readWorkspace()).editorDocuments[0].filename).toBe('Imported pending.json')
    expect(server.commits.flatMap(commit => commit.revisions).some(revision => JSON.stringify(revision.parents) === JSON.stringify(parents))).toBe(true)
  } finally { await server.dispose(); await disposeWorkspaceSnapshot(backup); mark('journey-disposed') }
}

const COPY_STEP_TIMEOUT_MS = 120_000
describe.each(['copy', 'restore'] as const)('registersPortableComparisonsAndResolvesOnAnotherDestinationDevice: %s', mode => {
  describe('destination comparison and explicit resolution', { concurrent: false }, () => {
    const journey = copiedConflictJourney(mode)
    let pending: ReturnType<typeof journey.next> | undefined
    let compared = false
    // Keep the same authenticated service and devices across real user steps, without overlapping timed-out work
    afterAll(async () => {
      if (pending) invalidateProfile()
      await pending?.catch(() => {})
      await journey.return(undefined)
    }, COPY_STEP_TIMEOUT_MS)
    it('registers the copied originals and proves the comparison on an independent device', async () => {
      pending = journey.next()
      const result = await pending
      pending = undefined
      expect(result.done).toBe(false)
      compared = true
    }, COPY_STEP_TIMEOUT_MS)
    it('publishes the explicit choice with exact originals and destination parents', async () => {
      expect(compared).toBe(true)
      pending = journey.next()
      const result = await pending
      pending = undefined
      expect(result.done).toBe(true)
    }, COPY_STEP_TIMEOUT_MS)
  })
})
