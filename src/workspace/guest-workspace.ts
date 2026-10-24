import { captureProfileEpoch } from '../account/profile'
import { openSelectedGuestPlanner } from './open-required-guest-planner'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { CryKitDatabase } from '../persistence/database'
import { loadLocalData, changedLocalData, historyEntry, jsonEqual } from '../persistence/local-data'
import { InspectorStorage, getInspectorStorage } from '../mod-inspector/storage'
import { GuestCoordinatorDatabase, requireGuestPublicationJournal, requireGuestRestoreManifest, requireV1GuestManifest, activateGuestProfile, type GuestManifest, type GuestManifestV2 } from './guest-coordinator'
import { GuestFilesDatabase, readGuestFiles, writeGuestFiles } from './guest-files'
import { captureLegacyBranch, compareLegacyBranch, readLegacyCapture, type LegacyParticipant, type LegacyCapture } from './legacy-capture'
import { validateWorkspaceClosure } from './closure'
import { encodeCatalogPayload } from './catalog-codec'
import { readBlob, blobIdentity, BLOB_CHUNK_BYTES } from './blobs'
import type { WorkspaceState, WorkspaceSourceRecord } from './documents'
import type { LoadedLocalData } from '../interchange/types'
import { equalLegacyValue } from './legacy-value'
import { WorkspaceError } from './repository'
import { GUEST_PLANNER_LAYOUT_KEY, guestPlannerValuesEqual, validateGuestPlannerRecord } from '../persistence/guest-planner-record'

import { readGuestEvidence, databaseEvidenceRows, mergeGuestSavedChanges, validateGuestCurrentBodies, type CapturedGuestEvidence } from './guest-evidence'
import { readCapturedGuestEvidence } from './guest-evidence-capture'

export interface GuestBindings { readonly coordinator: GuestCoordinatorDatabase; readonly manifest: GuestManifest | GuestManifestV2; readonly planner: CryKitDatabase; readonly inspector: InspectorStorage; readonly files: GuestFilesDatabase }
const ACTIVE_RECORD = 'local-data-record'
export const GUEST_ACTIVATED_EVENT = 'crykit-guest-activated'
export async function openGuestBindings(original: CryKitDatabase): Promise<GuestBindings> {
  const profile = captureProfileEpoch()
  const primary = original.name === 'crykit'
  const coordinator = new GuestCoordinatorDatabase(primary ? undefined : `${original.name}-coordinator`)
  let selected = await coordinator.active.get('active')
  if (!selected) {
    const manifest: GuestManifest = { version: 1, id: crypto.randomUUID(), revision: 0, planner: original.name, inspector: primary ? 'crykit-mod-inspector-v1' : `${original.name}-inspector`, files: `${original.name}-workspace-files-v1` }
    await coordinator.transaction('rw', coordinator.active, async () => { if (!await coordinator.active.get('active')) await coordinator.active.add({ key: 'active', manifest }) })
    selected = await coordinator.active.get('active')
  }
  // Routing must finish before any selected participant handle is constructed
  if ((selected!.manifest as { version?: number }).version === 2) {
    const manifest = requireGuestRestoreManifest(selected!.manifest)
    const journal = requireGuestPublicationJournal(await coordinator.table('journal').get(manifest.id))
    if (journal.phase !== 'published' || !equalLegacyValue(journal.target, manifest) || !journal.targetCapture) throw new Error('The selected restore has no published journal')
    if (journal.kind === 'guest-successor' && journal.recoveryCapture) {
      const retained = await coordinator.captures.get(journal.recoveryCapture.id)
      if (!retained || !guestPlannerValuesEqual(retained, journal.recoveryCapture)) throw new Error('The selected successor recovery capture changed')
    }
    const planner = await openSelectedGuestPlanner(manifest.planner, { signal: profile.signal, assertCurrent: () => { profile.assertCurrent(); return undefined } })
    const inspector = new InspectorStorage(manifest.inspector, { requiredGuestTarget: true })
    const files = new GuestFilesDatabase(manifest.files, { requiredGuestTarget: true })
    try {
      await planner.open(); await inspector.openDatabase(); await files.open()
      const { readUnselectedGuestCapture } = await import('./guest-snapshot')
      const savedCapture = await coordinator.captures.get(journal.targetCapture.id)
      if (!savedCapture || !guestPlannerValuesEqual(savedCapture, journal.targetCapture)) throw new Error('The selected restore capture changed')
      const restored = await readUnselectedGuestCapture(coordinator, savedCapture, manifest, () => {})
      await validateWorkspaceClosure(restored.state)
      const actual = await coordinator.active.get('active')
      if (!actual || !equalLegacyValue(actual.manifest, manifest)) throw new Error('The selected restore changed during reopening')
      // File and Inspector edits need not advance the planner revision; validate the live graph on every reopen
      await validateWorkspaceClosure(await readGuestWorkspace({ coordinator, manifest, planner, inspector, files }))
      profile.assertCurrent()
      if (planner.frozenSource240) {
        const { migrateSelectedGuest250 } = await import('./guest-successor')
        await migrateSelectedGuest250({ coordinator, manifest, planner, inspector, files }, profile.assertCurrent)
        planner.close(); inspector.close(); files.close(); coordinator.close()
        return openGuestBindings(original)
      }
      return { coordinator, manifest, planner, inspector, files }
    } catch (error) { planner.close(); inspector.close(); files.close(); coordinator.close(); throw error }
  }
  const manifest = requireV1GuestManifest(selected!.manifest)
  return { coordinator, manifest, planner: manifest.planner === original.name ? original : new CryKitDatabase(manifest.planner), inspector: getInspectorStorage(manifest.inspector), files: new GuestFilesDatabase(manifest.files) }
}
export async function assertGuestCurrent(binding: GuestBindings): Promise<void> {
  const selected = await binding.coordinator.active.get('active')
  if (!selected || !equalLegacyValue(binding.manifest.version === 1 ? requireV1GuestManifest(selected.manifest) : requireGuestRestoreManifest(selected.manifest), binding.manifest)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'This local workspace was retired. Keep your draft and reopen the selected workspace.')
  if (binding.manifest.version === 2) {
    const journal = requireGuestPublicationJournal(await binding.coordinator.table('journal').get(binding.manifest.id))
    if (journal.phase !== 'published' || !equalLegacyValue(journal.target, binding.manifest)) throw new Error('The selected restore journal changed')
  }
}
export async function guestParticipants(binding: GuestBindings): Promise<readonly LegacyParticipant[]> {
  await assertGuestCurrent(binding)
  await binding.planner.open()
  await assertGuestCurrent(binding)
  await binding.files.open()
  await assertGuestCurrent(binding)
  const inspector = await binding.inspector.openDatabase()
  await assertGuestCurrent(binding)
  return [{ kind: 'planner', database: binding.planner }, { kind: 'inspector', database: inspector }, { kind: 'files', database: binding.files }]
}
export async function readGuestWorkspace(binding: GuestBindings): Promise<WorkspaceState> {
  await assertGuestCurrent(binding)
  if (!binding.planner.frozenSource240) await loadLocalData(binding.planner)
  const planner = await binding.planner.transaction('r', binding.planner.tables, async () => {
    const record = await binding.planner.localDatas.get(ACTIVE_RECORD)
    if (!record) throw new Error('The saved planner is unavailable')
    const sources: WorkspaceSourceRecord[] = []
    await binding.planner.sources.each(({ bytes, ...source }) => sources.push({ ...source, original: { documentId: `source:${source.id}`, revisionId: source.digest, byteLength: bytes.byteLength, sha256: source.digest, encoding: 'bytes' } }))
    const catalogs = [...new Map([...BUNDLED_CATALOGS, ...(await binding.planner.catalogs.toArray()).map(row => row.snapshot)].map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])).values()]
    const history = await binding.planner.history.toArray()
    const admitted = binding.manifest.version === 2 ? validateGuestPlannerRecord(record, await binding.planner.meta.get(GUEST_PLANNER_LAYOUT_KEY), history, 'journaled', binding.planner.frozenSource240) : undefined
    if (admitted && admitted.format !== 'journaled') throw new Error('The selected restore planner is not journaled')
    return { localData: record.localData, lineage: record.lineage, catalogs, evidence: await binding.planner.evidence.toArray(), history, sources,
      ...(admitted && admitted.format === 'journaled' ? { journal: admitted.journal, savedChanges: admitted.descriptor.savedDestinationChanges } : {}) }
  })
  const files = await readGuestFiles(binding.files, () => assertGuestCurrent(binding))
  const bodies = planner.sources.map(source => ({ ref: source.original, content: {
    byteLength: source.original.byteLength,
    async *open() {
      await assertGuestCurrent(binding)
      const stored = await binding.planner.sources.get(source.id)
      await assertGuestCurrent(binding)
      if (!stored || stored.digest !== source.digest || stored.bytes.length !== source.original.byteLength) throw new Error('The captured source original changed')
      for (let offset = 0; offset < stored.bytes.length; offset += BLOB_CHUNK_BYTES) { await assertGuestCurrent(binding); yield stored.bytes.subarray(offset, offset + BLOB_CHUNK_BYTES) }
    },
  } }))
  const sourceKeys = new Set(bodies.map(blob => blobIdentity(blob.ref)))
  if (files.blobs.some(blob => sourceKeys.has(blobIdentity(blob.ref)))) throw new Error('Contradictory guest body binding')
  const evidence = await readGuestEvidence(databaseEvidenceRows(binding.files), () => assertGuestCurrent(binding))
  const currentPlanner = evidence.planner.savedChanges.length ? { ...planner, savedChanges: mergeGuestSavedChanges(evidence.planner.savedChanges, planner.localData.changes) } : planner
  const state: WorkspaceState = { planner: currentPlanner, ...files, blobs: [...bodies, ...files.blobs] }
  await validateGuestCurrentBodies(state, evidence)
  await assertGuestCurrent(binding)
  return state
}

export async function readGuestWorkspaceWithEvidence(binding: GuestBindings, existing?: { capture: LegacyCapture; participants: readonly LegacyParticipant[] }): Promise<{ state: WorkspaceState; evidence: CapturedGuestEvidence; capture: LegacyCapture }> {
  const participants = existing?.participants ?? await guestParticipants(binding)
  const capture = existing?.capture ?? await captureLegacyBranch(binding.coordinator, participants)
  const check = async () => {
    await assertGuestCurrent(binding)
    if ((await compareLegacyBranch(binding.coordinator, capture, participants)).status !== 'equal') throw new Error('Captured guest workspace changed')
    await assertGuestCurrent(binding)
  }
  const state = await readGuestWorkspace(binding), evidence = await readCapturedGuestEvidence(binding.coordinator, capture, check)
  await check()
  return { state, evidence, capture }
}

export interface GuestCommitOptions { readonly assertPreparedInspector?: (storage: InspectorStorage) => Promise<void>; readonly recoveryCapture?: LegacyCapture; readonly assertMayActivate?: () => void; readonly operationId?: string; readonly command?: string; readonly onPrepared?: (manifest: GuestManifest, state: WorkspaceState, evidence: CapturedGuestEvidence) => void; readonly onPreparedV2?: (manifest: GuestManifestV2, state: WorkspaceState, evidence: CapturedGuestEvidence) => void }
export async function commitGuestWorkspace(binding: GuestBindings, next: WorkspaceState, expectedRevision: number, mode: 'additive' | 'replace' = 'additive', options: GuestCommitOptions = {}): Promise<LoadedLocalData> {
  if (binding.manifest.version === 2) {
    const { commitGuestWorkspaceSuccessor } = await import('./guest-successor')
    return commitGuestWorkspaceSuccessor(binding, next, expectedRevision, mode, options)
  }
  options.assertMayActivate?.()
  await assertGuestCurrent(binding)
  const before = await readGuestWorkspace(binding)
  if (before.planner.localData.revision !== expectedRevision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
  const participants = await guestParticipants(binding)
  const capture = await captureLegacyBranch(binding.coordinator, participants)
  // The frozen comparison must describe the same planner revision used to prepare the command
  const { state: captured, evidence: selectedEvidence } = await readGuestWorkspaceWithEvidence(binding, { capture, participants })
  if (!samePlanner(before.planner, captured.planner)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed during capture. Keep your draft and retry.')
  const evidence = options.recoveryCapture ? await readCapturedGuestEvidence(binding.coordinator, options.recoveryCapture, () => selectedEvidence.check(), true) : selectedEvidence
  const id = options.operationId ?? crypto.randomUUID()
  const target: GuestManifest = { version: 1, id, revision: binding.manifest.revision + 1, planner: `crykit-profile-${id}-planner`, inspector: `crykit-profile-${id}-inspector`, files: `crykit-profile-${id}-files` }
  const timestamp = new Date().toISOString()
  const localData = changedLocalData(before.planner.localData, next.planner.localData, 'workspace-command', timestamp as import('../domain/types').Timestamp)
  const histories = new Map(before.planner.history.map(entry => [entry.id, entry]))
  for (const entry of next.planner.history) {
    const existing = histories.get(entry.id)
    if (existing && !jsonEqual(existing, entry)) throw new Error('Historical planner identity conflicts')
    histories.set(entry.id, entry)
  }
  const entry = historyEntry(before.planner.localData, localData, 'workspace-command', timestamp as import('../domain/types').Timestamp)
  histories.set(entry.id, entry)
  const state: WorkspaceState = { ...next, planner: { ...next.planner, localData, history: [...histories.values()], ...(evidence.planner.savedChanges.length ? { savedChanges: mergeGuestSavedChanges(evidence.planner.savedChanges, localData.changes) } : {}) } }
  await validateWorkspaceClosure(state)
  options.onPrepared?.(target, state, evidence)
  const planner = new CryKitDatabase(target.planner), inspector = new InspectorStorage(target.inspector), files = new GuestFilesDatabase(target.files)
  try {
    await planner.localDatas.add({ id: ACTIVE_RECORD, revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: state.planner.lineage })
    for (const catalog of state.planner.catalogs) if ((encodeCatalogPayload(catalog) as { kind?: string }).kind !== 'packaged-catalog-pin') await planner.catalogs.add({ key: JSON.stringify([catalog.id, catalog.revisionId]), id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum, snapshot: catalog })
    for (const evidence of state.planner.evidence) await planner.evidence.add(evidence)
    for (const history of state.planner.history) await planner.history.add(history)
    const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
    for (const { original, ...source } of state.planner.sources) {
      const blob = blobs.get(blobIdentity(original))!
      await planner.sources.add({ ...source, bytes: await readBlob(blob.content, original.byteLength) })
    }
    const inspectorDatabase = await inspector.openDatabase()
    // Copy exact inspector storage rows; B01 owns translation into the complete editor container
    for await (const record of readLegacyCapture(binding.coordinator, options.recoveryCapture ?? capture)) {
      if (record.participant === 'inspector' && record.kind === 'record') await inspectorDatabase.table(record.table).put(record.value)
      if (record.participant === 'planner' && record.table === 'meta' && record.kind === 'record') await planner.meta.put(record.value as import('../persistence/database').MetaRecord)
      if (record.participant === 'planner' && record.table === 'imports' && record.kind === 'record') await planner.imports.put(record.value as import('../persistence/database').ImportRecord)
    }
    await writeGuestFiles(files, state, evidence)
    await options.assertPreparedInspector?.(inspector)
    options.assertMayActivate?.()
    const staged = await readGuestWorkspace({ coordinator: binding.coordinator, manifest: binding.manifest, planner, inspector, files })
    await validateWorkspaceClosure(staged)
    if (!samePlanner(state.planner, staged.planner)) throw new Error('The staged planner failed exact validation')
    await assertGuestCurrent(binding)
    await activateGuestProfile(binding.coordinator, { id, mode, expected: binding.manifest, target, capture }, participants, undefined, options.assertMayActivate)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(GUEST_ACTIVATED_EVENT); channel.postMessage({ version: 1 }); channel.close() }
    return { localData, lineage: state.planner.lineage, catalogs: state.planner.catalogs, evidence: state.planner.evidence, revision: localData.revision, canUndo: true }
  } finally { planner.close(); inspector.close(); files.close() }
}

function samePlanner(left: WorkspaceState['planner'], right: WorkspaceState['planner']): boolean {
  const { catalogs: leftCatalogs, ...leftRecords } = left, { catalogs: rightCatalogs, ...rightRecords } = right
  // IndexedDB key order cannot redefine imported history order or discard another root's immutable evidence
  const ordered = (value: typeof leftRecords) => ({ ...value, history: [...value.history].sort((a, b) => a.id.localeCompare(b.id)), sources: [...value.sources].sort((a, b) => a.id.localeCompare(b.id)), evidence: [...value.evidence].sort((a, b) => a.id.localeCompare(b.id)) })
  if (JSON.stringify(ordered(leftRecords)) !== JSON.stringify(ordered(rightRecords)) || leftCatalogs.length !== rightCatalogs.length) return false
  return leftCatalogs.every(catalog => {
    const other = rightCatalogs.find(value => value.id === catalog.id && value.revisionId === catalog.revisionId)
    return catalog === other || Boolean(other && JSON.stringify(catalog) === JSON.stringify(other))
  })
}
