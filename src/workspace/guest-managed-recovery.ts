import type { AdmittedLocalSnapshot, LocalStoreAdapter } from './local-root'
import type { WorkspaceState } from './documents'
import { readUnselectedGuestRecoveryCapture } from './guest-snapshot'
import { readCapturedGuestEvidence } from './guest-evidence-capture'
import { readLocalEvidence } from './local-evidence'
import { guestEvidenceFromFrozenCurrent, mergeGuestEvidence, emptyPlannerEvidence, validateGuestCurrentBodies } from './guest-evidence'
import { ownWorkspaceSnapshot } from './snapshot'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from './guest-planner'
import { managedGuestPlannerTuple } from './managed-guest-planner'
import { blobIdentity } from './blobs'
import { validateWorkspaceClosure } from './closure'
import Dexie from 'dexie'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import type { GuestManagedManifest } from './guest-managed-contract'
import { readManagedRetainedBranches } from './guest-managed-retained'
import { captureLegacyBranch, holdLegacyReaders, compareHeldLegacyBranch, type LegacyParticipant } from './legacy-capture'
import { exportGuestCapture, type GuestRecoveryNotice, type LegacyExportSink } from './guest-recovery'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'

// Recovery reads are bound to a selected managed head, even when divergence blocks ordinary writes
// Named retired stores open dynamically without migration, initialization or a successor lookup
export async function captureManagedRecovery(database: GuestCoordinatorDatabase, expected: GuestManagedManifest, notice: GuestRecoveryNotice, check: () => Promise<void>, signal: AbortSignal) {
  await check()
  const retained = await readManagedRetainedBranches(database, expected)
  const branch = retained.branches.find(value => value.id === notice.id && value.capture.id === notice.frozenCaptureId)
  if (!branch) throw new Error('The selected retained recovery branch changed')
  const opened: Dexie[] = []
  try {
    const participants: LegacyParticipant[] = []
    for (const source of branch.capture.participants) {
      const participant = new Dexie(source.name); opened.push(participant)
      await participant.open(); await check()
      if (!guestPlannerValuesEqual([...participant.backendDB().objectStoreNames].sort(), [...source.tables].sort())) throw new Error('The retained recovery layout changed')
      participants.push({ kind: source.kind, database: participant, ...(source.tables.includes('meta') ? { barrierOwner: branch.id } : {}) })
    }
    const capture = await captureLegacyBranch(database, participants, signal)
    await retained.assertUnchanged(); await check()
    return { database, expected, branch, capture, check, signal }
  } finally { for (const participant of opened) participant.close() }
}
export type ManagedRecoveryCapture = Awaited<ReturnType<typeof captureManagedRecovery>>

export async function inspectManagedRecovery(captured: ManagedRecoveryCapture) {
  await captured.check()
  let plannerRecords = 0, editorRecords = 0
  await captured.database.records.where('captureId').equals(captured.capture.id).each(record => {
    if (record.kind === 'record' && record.participant === 'planner') plannerRecords++
    if (record.kind === 'record' && record.participant === 'inspector') editorRecords++
  })
  await captured.check()
  return { plannerRecords, editorRecords }
}
export async function exportManagedRecovery(captured: ManagedRecoveryCapture, sink: LegacyExportSink): Promise<void> {
  await captured.check()
  await exportGuestCapture({ coordinator: captured.database }, captured.capture, {
    async write(bytes) { await captured.check(); await sink.write(bytes); await captured.check() },
    async close() { await captured.check(); await sink.close() },
    abort: () => sink.abort(),
  }, captured.signal)
}

// These held readers cover the exact chosen source through the coordinator CAS
// Other retained branches keep their own baselines and may still block the newly selected copy
export async function withManagedRecoverySource<T>(captured: ManagedRecoveryCapture, publish: (assertAlive: () => void) => Promise<T>): Promise<T> {
  const opened: Dexie[] = []
  let held: import('./legacy-capture').HeldLegacyReaders | undefined
  try {
    await captured.check()
    const participants: LegacyParticipant[] = []
    for (const source of captured.capture.participants) {
      const database = new Dexie(source.name); opened.push(database)
      await database.open(); await captured.check()
      if (!guestPlannerValuesEqual([...database.backendDB().objectStoreNames].sort(), [...source.tables].sort())) throw new Error('The retained recovery layout changed')
      participants.push({ kind: source.kind, database, ...(source.tables.includes('meta') ? { barrierOwner: captured.branch.id } : {}) })
    }
    held = await holdLegacyReaders(participants, captured.signal)
    if (!await compareHeldLegacyBranch(captured.database, captured.capture, held)) throw new Error('The retained source changed during recovery copy')
    await captured.check()
    return await publish(() => held!.assertAlive())
  } finally { await held?.release(); for (const database of opened) database.close() }
}

export async function prepareManagedRecoveryCopy(captured: ManagedRecoveryCapture, before: AdmittedLocalSnapshot, adapter: LocalStoreAdapter, operationId: string, assertOwned: () => void) {
  await captured.check(); assertOwned()
  const recovered = await readUnselectedGuestRecoveryCapture(captured.database, captured.capture, assertOwned)
  const planner = before.state.planner
  const operative = { ...planner, journal: planner.journal ?? { version: 1 as const, changes: planner.localData.changes, checkpoints: [], undoable: false } }
  const projection = requirePreparedGuestPlanner(prepareGuestRestorePlanner(operative, recovered.state.planner, 'replace', managedGuestPlannerTuple(before)))
  const sourceRefs = new Set(projection.planner.sources.map(value => blobIdentity(value.original)))
  const blobs = new Map(recovered.state.blobs.map(value => [blobIdentity(value.ref), value]))
  for (const body of before.state.blobs) if (sourceRefs.has(blobIdentity(body.ref)) && !blobs.has(blobIdentity(body.ref))) blobs.set(blobIdentity(body.ref), body)
  const state = { ...recovered.state, planner: projection.planner, blobs: [...blobs.values()] }
  await validateWorkspaceClosure(state)
  const retained = await readLocalEvidence(adapter, before.root.inheritedEvidence, captured.check)
  const inherited = await readCapturedGuestEvidence(captured.database, captured.capture, captured.check, true, assertOwned)
  // Both complete pre-copy graphs remain portable evidence, including files removed by the chosen copy
  // Snapshot IDs are operation-owned; no captured native frame or historical selector is rewritten
  const frozen = async (source: WorkspaceState, role: string) => guestEvidenceFromFrozenCurrent(ownWorkspaceSnapshot({ version: 1, snapshotId: `${operationId}-${role}`, capturedAt: new Date().toISOString(), revisionVector: { guest: captured.expected.id, capture: role === 'selected' ? JSON.stringify(captured.expected.root) : captured.capture.id }, state: source }, { check: captured.check, dispose: async () => {} }))
  const selected = await frozen(before.state, 'selected'), original = await frozen(recovered.state, 'retained')
  const plannerEvidence = { ...emptyPlannerEvidence(), savedChanges: projection.planner.savedChanges ?? projection.planner.localData.changes }
  let evidence = await mergeGuestEvidence(retained ?? selected, inherited, plannerEvidence)
  evidence = await mergeGuestEvidence(evidence, selected, plannerEvidence)
  evidence = await mergeGuestEvidence(evidence, original, plannerEvidence)
  await validateGuestCurrentBodies(state, evidence)
  return { state, evidence, destinationChanges: projection.record.operativePlanner.savedDestinationChanges }
}
