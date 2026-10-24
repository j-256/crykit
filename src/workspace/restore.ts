import type { GuestBindings } from './guest-workspace'
import { assertGuestCurrent, guestParticipants, readGuestWorkspaceWithEvidence } from './guest-workspace'
import { compareHeldLegacyBranch, compareLegacyBranch, captureLegacyBranch, holdLegacyReaders, readLegacyCapture, type HeldLegacyReaders, type LegacyCapture, type LegacyParticipant } from './legacy-capture'
import { requireGuestRestoreJournal, type GuestRestoreJournal, type GuestManifest, type GuestManifestV2 } from './guest-coordinator'
import { withGuestOperationOwner } from './guest-ownership'
import { equalLegacyValue } from './legacy-value'
import { assertOwnedWorkspaceSnapshot, assertWorkspaceSnapshotCurrent, backupMetadataDigest, disposeWorkspaceSnapshot, snapshotMetadata, validateWorkspaceSnapshot, type WorkspaceSnapshot, type WorkspaceSnapshotV2 } from './snapshot'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { guestEvidenceFromSnapshot, guestEvidenceSources, emptyPlannerEvidence, mergeGuestEvidence, readGuestEvidence, compareGuestEvidence, databaseEvidenceRows, type GuestEvidenceStageWriter } from './guest-evidence'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from './blobs'
import { CryKitDatabase } from '../persistence/database'
import { InspectorStorage } from '../mod-inspector/storage'
import { GuestFilesDatabase, writeGuestFiles } from './guest-files'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from './guest-planner'
import { writePreparedGuestPlanner } from '../persistence/guest-planner-store'
import { GUEST_PLANNER_LAYOUT_KEY, GUEST_PLANNER_ROOT_KEY, guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import { GUEST_BARRIER_KEY, acquireParticipantBarrier, releaseParticipantBarrier } from './guest-barrier'
import { readUnselectedGuestCapture } from './guest-snapshot'
import { validateWorkspaceClosure } from './closure'
import { historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'

export interface GuestRestorePreview {
  readonly target: 'guest'
  readonly selectedProfileId: string
  readonly categories: Readonly<Record<'planner' | 'editor' | 'save' | 'asset' | 'history', number>>
  readonly privateBytes: number
  readonly effect: 'replace-selected-profile'
}
interface PreviewAuthority {
  readonly binding: GuestBindings
  readonly input: WorkspaceSnapshot
  readonly snapshot: WorkspaceSnapshotV2
  readonly expected: GuestManifest | GuestManifestV2
  readonly capture: LegacyCapture
  readonly participants: readonly LegacyParticipant[]
  readonly snapshotDigest: string
  readonly sourceVectorDigest: string
}
const previews = new WeakMap<GuestRestorePreview, PreviewAuthority>()
const registered = new Map<string, PreviewAuthority>()

export async function previewGuestWorkspaceRestore(binding: GuestBindings, snapshot: WorkspaceSnapshot): Promise<GuestRestorePreview> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  await assertGuestCurrent(binding)
  const normalized = snapshot.version === 2 ? snapshot : await inheritWorkspaceSnapshot(snapshot, [])
  try {
    await validateWorkspaceSnapshot(normalized)
    // The backup reader validates framing, but lazy historical bodies are rechecked before any target is registered
    const inherited = guestEvidenceSources(await guestEvidenceFromSnapshot(normalized, emptyPlannerEvidence()))
    for (const member of inherited.members) await hashBlob(member.metadata)
    for (const body of inherited.bodies) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Historical restore body changed')
    const participants = await guestParticipants(binding)
    const capture = await captureLegacyBranch(binding.coordinator, participants)
    const expected = binding.manifest
    const sourceVectorDigest = await backupMetadataDigest({ expected, capture })
    const snapshotDigest = await backupMetadataDigest(snapshotMetadata(normalized))
    await assertWorkspaceSnapshotCurrent(normalized)
    await assertGuestCurrent(binding)
    const state = normalized.state
    const preview: GuestRestorePreview = Object.freeze({
      target: 'guest', selectedProfileId: expected.id,
      categories: Object.freeze({ planner: 1, editor: state.editorDocuments.length, save: state.saveDocuments.length, asset: state.assets.length, history: state.planner.history.length + normalized.historicalEvidence.snapshots.length }),
      privateBytes: normalized.historicalEvidence.blobs.reduce((sum, ref) => sum + ref.byteLength, 0), effect: 'replace-selected-profile',
    })
    previews.set(preview, { binding, input: snapshot, snapshot: normalized, expected, capture, participants, snapshotDigest, sourceVectorDigest })
    return preview
  } catch (error) { if (normalized !== snapshot) await disposeWorkspaceSnapshot(normalized); throw error }
}

export async function releaseGuestWorkspaceRestorePreview(preview: GuestRestorePreview): Promise<void> {
  const authority = previews.get(preview)
  if (!authority) return
  previews.delete(preview)
  for (const [id, registeredAuthority] of registered) if (registeredAuthority === authority) registered.delete(id)
  // V1 normalization owns independent encrypted staging; the caller still owns the uploaded snapshot
  if (authority.snapshot !== authority.input) await disposeWorkspaceSnapshot(authority.snapshot)
}

export async function beginGuestWorkspaceRestore(preview: GuestRestorePreview): Promise<GuestRestoreJournal> {
  const authority = previews.get(preview)
  if (!authority) throw new Error('A validated guest restore preview is required')
  const { binding, snapshot, expected, capture, participants, sourceVectorDigest, snapshotDigest } = authority
  await assertOwnedWorkspaceSnapshot(snapshot)
  return withGuestOperationOwner(binding.coordinator, undefined, async owner => {
    owner.assertAlive()
    await assertGuestCurrent(binding)
    if ((await compareLegacyBranch(binding.coordinator, capture, participants, owner.signal)).status !== 'equal') throw new Error('The guest workspace changed after restore preview')
    owner.assertAlive()
    await assertOwnedWorkspaceSnapshot(snapshot)
    // The fresh operation identity is generated here, after preview; no archive field controls target names
    const id = crypto.randomUUID(), prefix = `crykit-restored-v2-${id}`
    const journal = requireGuestRestoreJournal({ version: 2, kind: 'guest-restore', id, expected,
      target: { version: 2, id, revision: expected.revision + 1, planner: `${prefix}-planner`, inspector: `${prefix}-inspector`, files: `${prefix}-files` },
      capture, phase: 'registered', ownerGeneration: 0, sourceVectorDigest, snapshotDigest, acquired: [], recovery: 'unchecked' })
    await binding.coordinator.transaction('rw', binding.coordinator.active, binding.coordinator.journal, async () => {
      owner.assertAlive()
      const selected = await binding.coordinator.active.get('active')
      if (!selected || !equalLegacyValue(selected.manifest, expected)) throw new Error('The selected guest profile changed after restore preview')
      await binding.coordinator.table<GuestRestoreJournal, string>('journal').add(journal)
      owner.assertAlive()
    })
    // A released preview may finish registration; its inert journal leaves the old selection intact
    if (previews.get(preview) === authority) registered.set(id, authority)
    return journal
  })
}

interface RestoreTargets { readonly planner: CryKitDatabase; readonly inspector: InspectorStorage; readonly files: GuestFilesDatabase; close(): void }
async function stageBatch<T>(authority: PreviewAuthority, id: string, action: (owner: import('./guest-ownership').GuestOperationOwner) => Promise<T>): Promise<T> {
  const { binding, expected, capture } = authority
  return withGuestOperationOwner(binding.coordinator, undefined, async owner => {
    const journalTable = binding.coordinator.table<GuestRestoreJournal, string>('journal')
    await binding.coordinator.transaction('rw', binding.coordinator.active, journalTable, binding.coordinator.captures, async () => {
      owner.assertAlive()
      const row = requireGuestRestoreJournal(await journalTable.get(id))
      const selected = await binding.coordinator.active.get('active')
      const frozen = await binding.coordinator.captures.get(capture.id)
      if ((row.phase !== 'registered' && row.phase !== 'staging') || !equalLegacyValue(row.expected, expected)
        || !selected || !equalLegacyValue(selected.manifest, expected) || !frozen || !equalLegacyValue(frozen, capture)) throw new Error('Guest restore staging authority changed')
      await journalTable.put({ ...row, phase: 'staging', ownerGeneration: row.ownerGeneration + 1, owner: owner.id })
      owner.assertAlive()
    })
    owner.assertAlive()
    const result = await action(owner)
    owner.assertAlive()
    return result
  })
}

async function markBlocked(authority: PreviewAuthority, id: string): Promise<void> {
  await withGuestOperationOwner(authority.binding.coordinator, undefined, async owner => {
    const journalTable = authority.binding.coordinator.table<GuestRestoreJournal, string>('journal')
    await authority.binding.coordinator.transaction('rw', journalTable, async () => {
      owner.assertAlive()
      const row = requireGuestRestoreJournal(await journalTable.get(id))
      if (row.phase === 'registered' || row.phase === 'staging' || row.phase === 'staged') await journalTable.put({ ...row, phase: 'blocked', recovery: 'incomplete', owner: owner.id, ownerGeneration: row.ownerGeneration + 1 })
    })
  })
}

function comparableState(state: import('./documents').WorkspaceState): unknown {
  const ordered = <T extends { id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id))
  return {
    ...state, planner: { ...state.planner, catalogs: [...state.planner.catalogs].sort((a, b) => JSON.stringify([a.id, a.revisionId]).localeCompare(JSON.stringify([b.id, b.revisionId]))),
      sources: ordered(state.planner.sources), evidence: ordered(state.planner.evidence), history: ordered(state.planner.history) },
    editorDocuments: ordered(state.editorDocuments), saveDocuments: ordered(state.saveDocuments), assets: ordered(state.assets),
    conflicts: ordered(state.conflicts), retainedContent: ordered(state.retainedContent),
    blobs: state.blobs.map(({ ref }) => ref).sort((a, b) => blobIdentity(a).localeCompare(blobIdentity(b))),
  }
}

export async function stageGuestWorkspaceRestore(preview: GuestRestorePreview, id: string): Promise<GuestRestoreJournal> {
  const authority = previews.get(preview)
  if (!authority || registered.get(id) !== authority) throw new Error('A registered guest restore preview is required')
  const { binding, snapshot, capture, participants } = authority
  let targets: RestoreTargets | undefined
  let targetLive = true
  try {
    await assertOwnedWorkspaceSnapshot(snapshot)
    const current = await readGuestWorkspaceWithEvidence(binding, { capture, participants })
    const currentTuple = binding.manifest.version === 2 ? await binding.planner.transaction('r', [binding.planner.localDatas, binding.planner.meta, binding.planner.history], async () => {
      const record = await binding.planner.localDatas.get(GUEST_PLANNER_ROOT_KEY)
      const declaration = await binding.planner.meta.get(GUEST_PLANNER_LAYOUT_KEY)
      if (!record || !declaration) throw new Error('The selected restored planner tuple is incomplete')
      return { record, declaration, history: await binding.planner.history.toArray() }
    }) : undefined
    const prepared = prepareGuestRestorePlanner(current.state.planner, snapshot.state.planner, 'replace', currentTuple)
    const preparedPlanner = requirePreparedGuestPlanner(prepared).planner
    const backupEvidence = await guestEvidenceFromSnapshot(snapshot, emptyPlannerEvidence())
    const evidence = await mergeGuestEvidence(current.evidence, backupEvidence, { ...emptyPlannerEvidence(), savedChanges: preparedPlanner.savedChanges ?? preparedPlanner.localData.changes })
    const sourceKeys = new Set(preparedPlanner.sources.map(source => blobIdentity(source.original)))
    const blobs = new Map(snapshot.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
    for (const blob of current.state.blobs) if (sourceKeys.has(blobIdentity(blob.ref)) && !blobs.has(blobIdentity(blob.ref))) blobs.set(blobIdentity(blob.ref), blob)
    const state = { ...snapshot.state, planner: preparedPlanner, blobs: [...blobs.values()] }
    await validateWorkspaceClosure(state)
    const row = requireGuestRestoreJournal(await binding.coordinator.table('journal').get(id))
    const planner = new CryKitDatabase(row.target.planner, { plannerFormatRequirement: 'journaled', freshGuestTarget: true })
    const inspector = new InspectorStorage(row.target.inspector, { freshGuestTarget: true })
    const files = new GuestFilesDatabase(row.target.files, { freshGuestTarget: true })
    targets = { planner, inspector, files, close() { planner.close(); inspector.close(); files.close() } }
    await stageBatch(authority, id, async owner => {
      const close = () => targets?.close()
      owner.signal.addEventListener('abort', close, { once: true })
      try { await planner.open(); owner.assertAlive(); await inspector.openDatabase(); owner.assertAlive(); await files.open(); owner.assertAlive() }
      finally { owner.signal.removeEventListener('abort', close) }
    })
    const add = async (database: import('dexie').default, table: string, value: unknown) => stageBatch(authority, id, async owner => {
      owner.assertAlive(); await database.table(table).add(value); owner.assertAlive()
    })
    for (const item of state.planner.evidence) await add(planner, 'evidence', item)
    for (const source of state.planner.sources) {
      const body = blobs.get(blobIdentity(source.original))
      if (!body) throw new Error('Restore source body is missing')
      const bytes = await readBlob(body.content, source.original.byteLength)
      if (await hashBlob(memoryBlob(bytes)) !== source.original.sha256) throw new Error('Restore source body changed')
      const { original: _original, ...metadata } = source
      await add(planner, 'sources', { ...metadata, bytes })
    }
    const inspectorDatabase = await inspector.openDatabase()
    // Copy retained native drafts and inert planner rows from the frozen source, not from a reconstructed current view
    for await (const record of readLegacyCapture(binding.coordinator, capture)) {
      if (record.kind !== 'record') continue
      if (record.participant === 'inspector' && record.table !== 'meta') await add(inspectorDatabase, record.table, record.value)
      if (record.participant === 'inspector' && record.table === 'meta') {
        const row = record.value as { key?: string }
        if (row.key !== GUEST_BARRIER_KEY) await add(inspectorDatabase, 'meta', row)
      }
      if (record.participant === 'planner' && record.table === 'imports') await add(planner, 'imports', record.value)
      if (record.participant === 'planner' && record.table === 'meta') {
        const row = record.value as { key?: string }
        if (row.key !== GUEST_PLANNER_LAYOUT_KEY && row.key !== GUEST_BARRIER_KEY) await add(planner, 'meta', row)
      }
    }
    const stagedRows = { localDatas: await planner.localDatas.toArray(), catalogs: await planner.catalogs.toArray(), evidence: await planner.evidence.toArray(), sources: await planner.sources.toArray(), history: await planner.history.toArray(), imports: await planner.imports.toArray(), meta: await planner.meta.toArray() }
    await stageBatch(authority, id, owner => writePreparedGuestPlanner(planner, prepared, { expectedStaged: stagedRows, assertOwned: () => owner.assertAlive() }))
    const writer: GuestEvidenceStageWriter = {
      put: (table, value) => add(files, table, value),
      clear: table => stageBatch(authority, id, async owner => { owner.assertAlive(); await files.table(table).clear(); owner.assertAlive() }),
      delete: (table, key) => stageBatch(authority, id, async owner => { owner.assertAlive(); await files.table(table).delete(key); owner.assertAlive() }),
    }
    await writeGuestFiles(files, state, evidence, writer)
    await assertOwnedWorkspaceSnapshot(snapshot)
    if ((await compareLegacyBranch(binding.coordinator, capture, participants)).status !== 'equal') throw new Error('Guest source changed during restore staging')
    const targetParticipants: LegacyParticipant[] = [{ kind: 'planner', database: planner }, { kind: 'inspector', database: await inspector.openDatabase() }, { kind: 'files', database: files }]
    const targetCapture = await captureLegacyBranch(binding.coordinator, targetParticipants)
    const unselected = await readUnselectedGuestCapture(binding.coordinator, targetCapture, row.target, () => { if (!targetLive) throw new Error('Restore staging was retired') })
    if (!guestPlannerValuesEqual(comparableState(state), comparableState(unselected.state))) throw new Error('Restored workspace differs from its validated source')
    await validateWorkspaceClosure(unselected.state)
    await compareGuestEvidence(evidence, await readGuestEvidence(databaseEvidenceRows(files), async () => {}))
    await assertOwnedWorkspaceSnapshot(snapshot)
    return withGuestOperationOwner(binding.coordinator, undefined, async owner => binding.coordinator.transaction('rw', binding.coordinator.active, binding.coordinator.journal, async () => {
      owner.assertAlive()
      const journalTable = binding.coordinator.table<GuestRestoreJournal, string>('journal')
      const actual = requireGuestRestoreJournal(await journalTable.get(id))
      const selected = await binding.coordinator.active.get('active')
      if (actual.phase !== 'staging' || !selected || !equalLegacyValue(selected.manifest, actual.expected)) throw new Error('Restore staging authority changed')
      const staged = requireGuestRestoreJournal({ ...actual, targetCapture, phase: 'staged', owner: owner.id, ownerGeneration: actual.ownerGeneration + 1 })
      await journalTable.put(staged)
      return staged
    }))
  } catch (error) { await markBlocked(authority, id).catch(() => {}); throw error }
  finally { targetLive = false; targets?.close() }
}

export async function activateGuestWorkspaceRestore(preview: GuestRestorePreview, id: string, assertMayActivate: () => void = () => {}): Promise<GuestManifestV2> {
  const authority = previews.get(preview)
  if (!authority || registered.get(id) !== authority) throw new Error('A staged guest restore preview is required')
  try { return await activatePreparedGuestRestore(authority, id, assertMayActivate) }
  catch (error) { await markBlocked(authority, id).catch(() => {}); throw error }
}

async function activatePreparedGuestRestore(authority: PreviewAuthority, id: string, assertMayActivate: () => void): Promise<GuestManifestV2> {
  const { binding, snapshot, expected, capture, participants, snapshotDigest, sourceVectorDigest } = authority
  const journalTable = binding.coordinator.table<GuestRestoreJournal, string>('journal')
  assertMayActivate()
  await assertOwnedWorkspaceSnapshot(snapshot)
  if (await backupMetadataDigest(snapshotMetadata(snapshot)) !== snapshotDigest
    || await backupMetadataDigest({ expected, capture }) !== sourceVectorDigest) throw new Error('Guest restore preview authority changed')
  const row = requireGuestRestoreJournal(await journalTable.get(id))
  if (row.phase !== 'staged' || !row.targetCapture || !equalLegacyValue(row.expected, expected)
    || row.snapshotDigest !== snapshotDigest || row.sourceVectorDigest !== sourceVectorDigest) throw new Error('The guest restore is not staged')
  const savedSource = await binding.coordinator.captures.get(capture.id), savedTarget = await binding.coordinator.captures.get(row.targetCapture.id)
  if (!savedSource || !guestPlannerValuesEqual(savedSource, capture) || !savedTarget || !guestPlannerValuesEqual(savedTarget, row.targetCapture)) throw new Error('Guest restore capture authority changed')
  const target = { planner: new CryKitDatabase(row.target.planner, { plannerFormatRequirement: 'journaled' }), inspector: new InspectorStorage(row.target.inspector, { requiredGuestTarget: true }), files: new GuestFilesDatabase(row.target.files, { requiredGuestTarget: true }) }
  try {
    await target.planner.open(); await target.inspector.openDatabase(); await target.files.open()
    const targetParticipants: LegacyParticipant[] = [{ kind: 'planner', database: target.planner }, { kind: 'inspector', database: await target.inspector.openDatabase() }, { kind: 'files', database: target.files }]
    const frozen = await readUnselectedGuestCapture(binding.coordinator, savedTarget, row.target, () => {})
    await validateWorkspaceClosure(frozen.state)
    for (const member of frozen.inherited.members) if ((await historicalMetadataIdentity(member.metadata)).id !== member.id) throw new Error('Restored historical metadata changed')
    for (const body of frozen.inherited.bodies) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Restored historical body changed')
    if ((await compareLegacyBranch(binding.coordinator, savedTarget, targetParticipants)).status !== 'equal') throw new Error('The staged guest target changed')
    await assertOwnedWorkspaceSnapshot(snapshot)
    assertMayActivate()
    return await withGuestOperationOwner(binding.coordinator, undefined, async owner => {
      let current = requireGuestRestoreJournal(await journalTable.get(id))
      const selected = await binding.coordinator.active.get('active')
      if (current.phase !== 'staged' || current.ownerGeneration !== row.ownerGeneration || !selected || !equalLegacyValue(selected.manifest, expected)) throw new Error('Guest restore publication authority changed')
      let sourceHeld: HeldLegacyReaders | undefined, targetHeld: HeldLegacyReaders | undefined
      try {
        // Recovery must see a non-inert phase before the first source barrier can commit
        current = { ...current, phase: 'publishing', owner: owner.id, ownerGeneration: current.ownerGeneration + 1 }
        await journalTable.put(current)
        owner.assertAlive()
        for (const participant of participants) {
          owner.assertAlive(); assertMayActivate()
          await acquireParticipantBarrier(participant.database, id)
          owner.assertAlive()
          current = { ...current, acquired: [...current.acquired, participant.database.name], ownerGeneration: current.ownerGeneration + 1 }
          await journalTable.put(current)
        }
        sourceHeld = await holdLegacyReaders(participants.map(participant => ({ ...participant, barrierOwner: id })), owner.signal)
        targetHeld = await holdLegacyReaders(targetParticipants, owner.signal)
        if (!await compareHeldLegacyBranch(binding.coordinator, savedSource, sourceHeld)) throw new Error('The retained guest source changed before publication')
        if (!await compareHeldLegacyBranch(binding.coordinator, savedTarget, targetHeld)) throw new Error('The staged guest target changed before publication')
        owner.assertAlive(); sourceHeld.assertAlive(); targetHeld.assertAlive(); assertMayActivate()
        await binding.coordinator.transaction('rw', binding.coordinator.active, journalTable, async () => {
          owner.assertAlive(); sourceHeld!.assertAlive(); targetHeld!.assertAlive(); assertMayActivate()
          const actual = requireGuestRestoreJournal(await journalTable.get(id))
          const pointer = await binding.coordinator.active.get('active')
          if (actual.phase !== 'publishing' || actual.owner !== owner.id || actual.ownerGeneration !== current.ownerGeneration
            || !pointer || !equalLegacyValue(pointer.manifest, expected)) throw new Error('Guest restore pointer authority changed')
          await binding.coordinator.table<{ key: 'active'; manifest: GuestManifest | GuestManifestV2 }, string>('active').put({ key: 'active', manifest: row.target })
          await journalTable.put({ ...actual, phase: 'published', recovery: 'unchecked' })
          owner.assertAlive(); sourceHeld!.assertAlive(); targetHeld!.assertAlive(); assertMayActivate()
        })
        await targetHeld.release(); targetHeld = undefined
        await sourceHeld.release(); sourceHeld = undefined
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('crykit-guest-activated'))
        return row.target
      } catch (error) {
        await targetHeld?.release(true); await sourceHeld?.release(true)
        // The pointer transaction may have committed even if a later callback failed
        owner.assertAlive()
        const actual = await binding.coordinator.active.get('active')
        if (actual && equalLegacyValue(actual.manifest, expected)) {
          for (const participant of [...participants].reverse()) { owner.assertAlive(); await releaseParticipantBarrier(participant.database, id) }
          const blocked = requireGuestRestoreJournal(await journalTable.get(id))
          if (blocked.phase !== 'published') await journalTable.put({ ...blocked, phase: 'blocked', recovery: 'incomplete', owner: owner.id, ownerGeneration: blocked.ownerGeneration + 1 })
        }
        throw error
      }
    })
  } finally { target.planner.close(); target.inspector.close(); target.files.close() }
}
