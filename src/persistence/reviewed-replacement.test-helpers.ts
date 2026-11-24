import { accountLocalId } from '../workspace/account-cache'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import type { WorkspaceSnapshot } from '../workspace/snapshot'
import { editorClosureFixture } from '../workspace/test-helpers'
import { conflictService } from './sync-conflict-fixture'

type ConflictService = Awaited<ReturnType<typeof conflictService>>

export function createReviewedReplacementFixture(snapshots: WorkspaceSnapshot[], ownService: (service: ConflictService) => void) {
  async function source(name: string) {
    const fixture = await editorClosureFixture()
    const snapshot = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: name, capturedAt: '2026-11-14', revisionVector: {}, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, filename: name }] } }))
    snapshots.push(snapshot)
    return snapshot
  }

  async function start() {
    const api = await import('../workspace/reviewed-replacement')
    const service = await conflictService()
    // Register the service before subsequent fixture operations can fail so the calling file can dispose it
    ownService(service)
    const original = await source('original'), replacement = await source('replacement')
    const device = await service.device(0, original.state)
    await device.settle()
    const controller = api.createReviewedReplacementService(device.db, device.token)
    const review = await controller.refresh()
    const stage = await controller.prepare(review, replacement, accountLocalId())
    await controller.activate(stage)
    await stage.dispose(); await review.dispose()
    return { api, device, original, replacement, controller }
  }

  async function appendLocalOriginal(device: Awaited<ReturnType<ConflictService['device']>>) {
    const { createAccountLocalStore } = await import('../workspace/account-local-store')
    const { admitLocalRoot, prepareLocalWorkspace } = await import('../workspace/local-root')
    const { readLocalEvidence, prepareLocalEvidence } = await import('../workspace/local-evidence')
    const { guestEvidenceFromSnapshot, mergeGuestEvidence, emptyPlannerEvidence } = await import('../workspace/guest-evidence')
    const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup')
    const { captureAccountReviewWorkspace } = await import('../workspace/account-sync-capture')
    const { activateLocalAccountCommit } = await import('./account-database')
    const fence = (await device.db.profileMeta.get('active'))!, store = createAccountLocalStore(device.db, device.token)
    const mapped = await captureAccountReviewWorkspace(device.db, device.token, fence)
    try {
      const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
      const existing = (await readLocalEvidence(store.adapter, previous.root.inheritedEvidence, async () => {}))!
      const extra = await source('additional local original')
      const inherited = await inheritWorkspaceSnapshot(extra, [extra]); snapshots.push(inherited)
      const evidence = await mergeGuestEvidence(existing, await guestEvidenceFromSnapshot(inherited, emptyPlannerEvidence()), existing.planner)
      const operationId = accountLocalId(), evidenceRef = await prepareLocalEvidence(store.adapter, operationId, evidence)
      const result = await prepareLocalWorkspace(store.adapter, operationId, previous.state, store.lifetime, undefined, evidenceRef)
      // This valid mapped selection deliberately retains a local original absent from its native publication
      const native = { head: mapped.workspace.head, records: [], entries: mapped.workspace.entries, opened: mapped.workspace, validatedEvidence: mapped.validatedEvidence }
      await activateLocalAccountCommit(device.db, device.token, await store.prepareMappedActivation(operationId, result, fence, previous, native))
      store.committed(operationId)
    } finally { await mapped.dispose(); await store.dispose() }
  }

  return { source, start, appendLocalOriginal }
}
