import Dexie from 'dexie'
import { equalLegacyValue } from './legacy-value'
import { validateWorkspaceClosure } from './closure'
import { CryKitDatabase } from '../persistence/database'
import { InspectorStorage } from '../mod-inspector/storage'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { disposeWorkspaceSnapshot, assertOwnedWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { GuestFilesDatabase } from './guest-files'
import { assertGuestCurrent, readGuestWorkspace, guestParticipants, type GuestBindings, GUEST_ACTIVATED_EVENT } from './guest-workspace'
import { captureLegacyBranch, readLegacyCapture, compareLegacyBranch } from './legacy-capture'
import { readCapturedGuestEvidence } from './guest-evidence-capture'
import { guestEvidenceFromSnapshot, mergeGuestEvidence, mergeGuestSavedChanges, writeGuestEvidence, readGuestEvidence, compareGuestEvidence, databaseEvidenceRows, GUEST_EVIDENCE_STORES, GUEST_EXTENSION_KEY } from './guest-evidence'
import { activateGuestProfile, type GuestManifest } from './guest-coordinator'

// This producer copies destination planner/history unchanged; imported records have no operative authority
// All three containers are fresh because the coordinator permanently fences every retired participant
export async function importGuestInheritedEvidence(binding: GuestBindings, source: WorkspaceSnapshot, options: { readonly signal?: AbortSignal } = {}): Promise<GuestManifest> {
  if (binding.manifest.version !== 1) throw new Error('Restored guest profiles require a v2 successor')
  options.signal?.throwIfAborted()
  await assertOwnedWorkspaceSnapshot(source)
  await assertGuestCurrent(binding)
  const participants = await guestParticipants(binding), capture = await captureLegacyBranch(binding.coordinator, participants, options.signal)
  const check = async () => {
    options.signal?.throwIfAborted(); await assertGuestCurrent(binding)
    if ((await compareLegacyBranch(binding.coordinator, capture, participants, options.signal)).status !== 'equal') throw new Error('The captured guest changed during evidence import')
    await assertGuestCurrent(binding)
  }
  const originalEvidence = await readCapturedGuestEvidence(binding.coordinator, capture, check)
  let inherited: Awaited<ReturnType<typeof inheritWorkspaceSnapshot>> | undefined
  const id = crypto.randomUUID()
  const target: GuestManifest = { version: 1, id, revision: binding.manifest.revision + 1, planner: `crykit-profile-${id}-planner`, inspector: `crykit-profile-${id}-inspector`, files: `crykit-profile-${id}-files` }
  const planner = new CryKitDatabase(target.planner), inspector = new InspectorStorage(target.inspector), files = new GuestFilesDatabase(target.files)
  let activationAttempted = false
  try {
    inherited = await inheritWorkspaceSnapshot(source, [source], options)
    const imported = await mergeGuestEvidence(originalEvidence, await guestEvidenceFromSnapshot(inherited, { version: 1, kind: 'guest-planner-evidence', savedChanges: [] }), { ...originalEvidence.planner, savedChanges: mergeGuestSavedChanges(originalEvidence.planner.savedChanges, source.state.planner.savedChanges ?? source.state.planner.localData.changes), ...(source.state.planner.journal ? { importedJournal: source.state.planner.journal } : {}) })
    await planner.open(); await files.open()
    const stores = { planner, inspector: await inspector.openDatabase(), files }
    for await (const row of readLegacyCapture(binding.coordinator, capture)) {
      options.signal?.throwIfAborted()
      if (row.kind !== 'record' || row.participant === 'files' && (row.table in GUEST_EVIDENCE_STORES || row.table === 'documents' && row.key === GUEST_EXTENSION_KEY)) continue
      const table = stores[row.participant].table(row.table)
      if (table.schema.primKey.keyPath) await table.add(row.value)
      else await table.add(row.value, row.key as import('dexie').IndexableType)
    }
    await writeGuestEvidence(files, imported)
    // Reopen with fresh handles before publication; imported staging may be released after this boundary
    files.close()
    const reopened = new GuestFilesDatabase(target.files)
    try {
      await reopened.open()
      await compareGuestEvidence(imported, await readGuestEvidence(databaseEvidenceRows(reopened), async () => {}))
      // Individually valid originals can collide with operative changes; validate their staged union before publication
      // This ordinary read checks destination changes without rewriting either original evidence stream
      await validateWorkspaceClosure(await readGuestWorkspace({ ...binding, planner, inspector, files: reopened }))
    } finally { reopened.close() }
    // Independent handles must see the complete captured destination, including local journal rows
    // Checking only the semantic planner would miss corruption in its ownership and revision metadata
    const copied = { planner: new Dexie(target.planner), inspector: new Dexie(target.inspector), files: new Dexie(target.files) }
    try {
      for (const participant of capture.participants) {
        const database = copied[participant.kind]
        await database.open()
        if (!equalLegacyValue(database.tables.map(table => table.name).sort(), [...participant.tables].sort())) throw new Error('The copied guest table inventory changed')
      }
      let count = 0
      for await (const row of readLegacyCapture(binding.coordinator, capture)) {
        options.signal?.throwIfAborted()
        if (row.participant === 'files' && row.table in GUEST_EVIDENCE_STORES) continue
        const table = copied[row.participant].table(row.table)
        if (row.kind === 'record') {
          if (row.participant === 'files' && row.table === 'documents' && row.key === GUEST_EXTENSION_KEY) continue
          if (!equalLegacyValue(await table.get(row.key as import('dexie').IndexableType), row.value)) throw new Error('The copied guest row changed')
          count++
        } else {
          const expected = count + (row.participant === 'files' && row.table === 'documents' ? 1 : 0)
          if (await table.count() !== expected) throw new Error('The copied guest row inventory changed')
          count = 0
        }
      }
    } finally { for (const database of Object.values(copied)) database.close() }
    await assertOwnedWorkspaceSnapshot(source); await check()
    activationAttempted = true
    await activateGuestProfile(binding.coordinator, { id, mode: 'additive', expected: binding.manifest, target, capture }, participants, options.signal)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(GUEST_ACTIVATED_EVENT); channel.postMessage({ version: 1 }); channel.close() }
    return target
  } finally {
    planner.close(); inspector.close(); files.close()
    if (inherited) await disposeWorkspaceSnapshot(inherited)
    // Once publication is attempted the coordinator owns independent pointer/source outcomes
    // Uncertain targets are retained for reconciliation, never deleted on an inferred rollback
    if (!activationAttempted) { await planner.delete(); await files.delete(); await (await inspector.openDatabase()).delete(); inspector.close() }
  }
}
