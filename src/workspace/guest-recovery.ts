import Dexie from 'dexie'
import { captureProfileEpoch } from '../account/profile'
import { openSelectedGuestPlanner } from './open-required-guest-planner'
import { CryKitDatabase } from '../persistence/database'
import { InspectorStorage } from '../mod-inspector/storage'
import { GuestFilesDatabase } from './guest-files'
import { assertGuestCurrent, readGuestWorkspace, commitGuestWorkspace, type GuestBindings } from './guest-workspace'
import { GUEST_RESTORE_INERT_PHASES, reconcileGuestOperation, requireGuestPublicationJournal, requireGuestRestoreManifest, requireV1GuestJournal, type GuestActivationJournal, type GuestRestoreJournal, type GuestSuccessorJournal } from './guest-coordinator'
import { captureLegacyBranch, compareLegacyBranch, readLegacyCapture, type LegacyCapture, type LegacyParticipant } from './legacy-capture'
import { encodeLegacyValue, equalLegacyValue } from './legacy-value'
import { withGuestOperationOwner } from './guest-ownership'
import { releaseParticipantBarrier } from './guest-barrier'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import { preserveLocalSelections } from './local-selections'
import { BLOB_CHUNK_BYTES, hashBlob } from './blobs'
import { readUnselectedGuestRecoveryCapture } from './guest-snapshot'
import { validateWorkspaceClosure } from './closure'
import { historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'

export interface GuestRecoveryNotice { readonly id: string; readonly status: 'diverged' | 'incomplete'; readonly frozenCaptureId: string }
async function participants(binding: GuestBindings, journal: GuestActivationJournal | GuestRestoreJournal | GuestSuccessorJournal) {
  await assertGuestCurrent(binding)
  // Retained participants keep their recorded layouts; a normal constructor would migrate behind the retired barrier
  const profile = captureProfileEpoch()
  const planner = journal.expected.version === 2
    ? await openSelectedGuestPlanner(journal.expected.planner, { signal: profile.signal, assertCurrent: () => { profile.assertCurrent(); return undefined } })
    : new Dexie(journal.expected.planner)
  const inspector = new InspectorStorage(journal.expected.inspector, journal.expected.version === 2 ? { requiredGuestTarget: true } : undefined)
  const files = journal.expected.version === 2 ? new GuestFilesDatabase(journal.expected.files, { requiredGuestTarget: true }) : new Dexie(journal.expected.files)
  try {
    await assertGuestCurrent(binding); await planner.open()
    await assertGuestCurrent(binding); await files.open()
    await assertGuestCurrent(binding)
    const openedInspector = await inspector.openDatabase()
    await assertGuestCurrent(binding)
    const values: LegacyParticipant[] = [{ kind: 'planner', database: planner, barrierOwner: journal.id }, { kind: 'inspector', database: openedInspector, barrierOwner: journal.id }, { kind: 'files', database: files, barrierOwner: journal.id }]
    return { values, close() { planner.close(); inspector.close(); files.close() } }
  } catch (error) { planner.close(); inspector.close(); files.close(); throw error }
}
const checks = new Map<string, Promise<readonly GuestRecoveryNotice[]>>()
export async function checkGuestRecovery(binding: GuestBindings, signal?: AbortSignal): Promise<readonly GuestRecoveryNotice[]> {
  if (signal?.aborted) return Promise.reject(new Error('Legacy check cancelled'))
  // Every coalesced caller checks its own captured selection before sharing a scan
  await assertGuestCurrent(binding)
  if (signal?.aborted) throw new Error('Legacy check cancelled')
  const key = binding.coordinator.name, existing = checks.get(key)
  // The shared repository gate must finish even when a notice unmounts or goes into the background
  const pending = existing ?? performGuestRecoveryCheck(binding).finally(() => { if (checks.get(key) === pending) checks.delete(key) })
  if (!existing) checks.set(key, pending)
  if (!signal) { const result = await pending; await assertGuestCurrent(binding); return result }
  const result = await new Promise<readonly GuestRecoveryNotice[]>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new Error('Legacy check cancelled')) }
    signal.addEventListener('abort', cancel, { once: true })
    pending.then(result => { signal.removeEventListener('abort', cancel); if (signal.aborted) cancel(); else resolve(result) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
  })
  await assertGuestCurrent(binding)
  if (signal?.aborted) throw new Error('Legacy check cancelled')
  return result
}
async function performGuestRecoveryCheck(binding: GuestBindings): Promise<readonly GuestRecoveryNotice[]> {
  const notices: GuestRecoveryNotice[] = []
  await assertGuestCurrent(binding)
  const journals = await binding.coordinator.journal.toArray()
  const selected = await binding.coordinator.active.get('active')
  if (!selected) throw new Error('The selected guest profile is unavailable')
  const publishedAncestors = new Set<string>()
  let cursor: unknown = selected.manifest
  while (cursor && typeof cursor === 'object' && (cursor as { version?: number }).version === 2) {
    const manifest = requireGuestRestoreManifest(cursor)
    if (publishedAncestors.has(manifest.id)) throw new Error('The guest restore ancestry is cyclic')
    const row = requireGuestPublicationJournal(journals.find(value => value.id === manifest.id))
    if (row.phase !== 'published' || !equalLegacyValue(row.target, manifest)) throw new Error('The guest restore pointer and journal disagree')
    publishedAncestors.add(manifest.id)
    cursor = row.expected
  }
  for (const journal of journals) {
    await assertGuestCurrent(binding)
    if ((journal as { version?: number }).version === 2) {
      const restored = requireGuestPublicationJournal(journal)
      if (GUEST_RESTORE_INERT_PHASES.has(restored.phase)) continue
      if (restored.phase === 'publishing' && equalLegacyValue(selected.manifest, restored.expected)) {
        // Pointer and published journal commit together; a prepublication interruption retains the old selection
        await withGuestOperationOwner(binding.coordinator, undefined, async owner => {
          owner.assertAlive()
          const actual = requireGuestPublicationJournal(await binding.coordinator.table('journal').get(restored.id))
          const pointer = await binding.coordinator.active.get('active')
          if (actual.phase !== 'publishing' || !pointer || !equalLegacyValue(pointer.manifest, actual.expected)) return
          const opened = await participants(binding, actual)
          try {
            for (const participant of [...opened.values].reverse()) {
              owner.assertAlive()
              await releaseParticipantBarrier(participant.database, actual.id)
            }
          } finally { opened.close() }
          owner.assertAlive()
          await binding.coordinator.table<GuestRestoreJournal | GuestSuccessorJournal, string>('journal').put({ ...actual, phase: 'blocked', recovery: 'incomplete', owner: owner.id, ownerGeneration: actual.ownerGeneration + 1 })
        })
        continue
      }
      if (restored.phase !== 'published' || !publishedAncestors.has(restored.id)) throw new Error('The guest restore pointer and journal disagree')
      const savedCapture = await binding.coordinator.captures.get(restored.capture.id)
      if (!savedCapture || !guestPlannerValuesEqual(savedCapture, restored.capture)) throw new Error('The retained guest source capture changed')
      const opened = await participants(binding, restored)
      try {
        const result = await compareLegacyBranch(binding.coordinator, savedCapture, opened.values)
        if (result.status !== 'equal') notices.push({ id: restored.id, status: result.status, frozenCaptureId: restored.capture.id })
      } finally { opened.close() }
      continue
    }
    if (binding.manifest.version === 2) { requireV1GuestJournal(journal); continue }
    const admitted = requireV1GuestJournal(journal)
    if (admitted.localStatus === 'failed') continue
    const opened = await participants(binding, admitted)
    try {
      const result = await reconcileGuestOperation(binding.coordinator, journal.id, opened.values)
      if (result.recovery === 'diverged' || result.recovery === 'incomplete') notices.push({ id: result.id, status: result.recovery, frozenCaptureId: result.capture.id })
    } finally { opened.close() }
  }
  await assertGuestCurrent(binding)
  return notices
}
export async function captureGuestRecovery(binding: GuestBindings, notice: GuestRecoveryNotice, signal?: AbortSignal): Promise<LegacyCapture> {
  if (signal?.aborted) throw new Error('Legacy check cancelled')
  await assertGuestCurrent(binding)
  if (signal?.aborted) throw new Error('Legacy check cancelled')
  const stored = await binding.coordinator.table<GuestActivationJournal | GuestRestoreJournal | GuestSuccessorJournal, string>('journal').get(notice.id)
  if (!stored) throw new Error('The retained local branch is unavailable')
  const journal = stored.version === 2 ? requireGuestPublicationJournal(stored) : requireV1GuestJournal(stored)
  if (stored.version === 2 ? journal.version !== 2 || journal.phase !== 'published' || journal.capture.id !== notice.frozenCaptureId
    : journal.version !== 1 || journal.localStatus !== 'published') throw new Error('The retained local branch is unavailable')
  await assertGuestCurrent(binding)
  if (signal?.aborted) throw new Error('Legacy check cancelled')
  const opened = await participants(binding, journal)
  try { const capture = await captureLegacyBranch(binding.coordinator, opened.values, signal); await assertGuestCurrent(binding); return capture }
  finally { opened.close() }
}
export interface LegacyExportSink { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export async function exportGuestCapture(binding: Pick<GuestBindings, 'coordinator'>, capture: LegacyCapture, sink: LegacyExportSink, signal?: AbortSignal): Promise<void> {
  if (!capture.completed || capture.version !== 1) throw new Error('The exact recovery capture is incomplete')
  async function record(value: unknown) {
    let length = 0
    for (const part of encodeLegacyValue(value)) { if (signal?.aborted) throw new Error('Recovery export cancelled'); length += part.length }
    const header = new Uint8Array(8); new DataView(header.buffer).setBigUint64(0, BigInt(length), true)
    await sink.write(header)
    let buffer = new Uint8Array(BLOB_CHUNK_BYTES), used = 0
    for (const part of encodeLegacyValue(value)) {
      if (signal?.aborted) throw new Error('Recovery export cancelled')
      let offset = 0
      while (offset < part.length) {
        const count = Math.min(buffer.length - used, part.length - offset)
        buffer.set(part.subarray(offset, offset + count), used); used += count; offset += count
        if (used === buffer.length) { await sink.write(buffer); buffer = new Uint8Array(BLOB_CHUNK_BYTES); used = 0 }
      }
    }
    if (used) await sink.write(buffer.subarray(0, used))
  }
  try {
    await sink.write(new TextEncoder().encode('CRYKIT-LEGACY/1\n'))
    await record(capture)
    // Each exact structured record is encoded independently; output does not aggregate the branch
    for await (const saved of readLegacyCapture(binding.coordinator, capture)) await record(saved)
    await sink.close()
  } catch (error) { await sink.abort(); throw error }
}

export async function copyGuestRecovery(binding: GuestBindings, capture: LegacyCapture, canReplace: () => boolean): Promise<void> {
  const assertMayActivate = () => { if (!canReplace()) throw new Error('Keep or export your open draft before copying retained data') }
  assertMayActivate()
  await assertGuestCurrent(binding)
  const saved = await binding.coordinator.captures.get(capture.id)
  if (!saved?.completed || JSON.stringify(saved) !== JSON.stringify(capture)) throw new Error('The exact recovery capture is incomplete')
  const current = await readGuestWorkspace(binding)
  if (binding.manifest.version === 2) {
    const recovered = await readUnselectedGuestRecoveryCapture(binding.coordinator, saved, () => {})
    await validateWorkspaceClosure(recovered.state)
    for (const member of recovered.inherited.members) if ((await historicalMetadataIdentity(member.metadata)).id !== member.id) throw new Error('Retained recovery history changed')
    for (const body of recovered.inherited.bodies) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Retained recovery original changed')
    assertMayActivate(); await assertGuestCurrent(binding)
    await commitGuestWorkspace(binding, { ...recovered.state, planner: { ...recovered.state.planner,
      localData: preserveLocalSelections(recovered.state.planner.localData, current.planner.localData) } },
    current.planner.localData.revision, 'replace', { recoveryCapture: saved, assertMayActivate })
    return
  }
  const id = crypto.randomUUID()
  const planner = new CryKitDatabase(`crykit-recovery-${id}-planner`), inspector = new InspectorStorage(`crykit-recovery-${id}-inspector`), files = new GuestFilesDatabase(`crykit-recovery-${id}-files`)
  try {
    const stores = { planner, inspector: await inspector.openDatabase(), files }
    await files.open()
    // Only a captured v2 graph replaces fresh target-owned initialization
    // A legacy capture keeps the new empty extension alongside its exact old rows
    if (capture.participants.find(participant => participant.kind === 'files')?.tables.includes('evidenceRoots')) for (const table of files.tables) await table.clear()
    // Restore exact captured rows into isolated stores; neither retained nor selected data is mutated
    for await (const record of readLegacyCapture(binding.coordinator, capture)) {
      if (record.kind !== 'record') continue
      const table = stores[record.participant].table(record.table)
      if (table.schema.primKey.keyPath) await table.add(record.value)
      else await table.add(record.value, record.key as import('dexie').IndexableType)
    }
    const recovered = await readGuestWorkspace({ ...binding, planner, inspector, files })
    await commitGuestWorkspace(binding, { ...recovered, planner: { ...recovered.planner, localData: preserveLocalSelections(recovered.planner.localData, current.planner.localData) } }, current.planner.localData.revision, 'replace', { recoveryCapture: capture, assertMayActivate })
  } finally { planner.close(); inspector.close(); files.close() }
}
