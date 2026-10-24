import type Dexie from 'dexie'
import type { LoadedLocalData } from '../interchange/types'
import { InspectorStorage } from '../mod-inspector/storage'
import { CryKitDatabase } from '../persistence/database'
import { GUEST_PLANNER_LAYOUT_KEY, GUEST_PLANNER_ROOT_KEY, guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import { writePreparedGuestPlanner } from '../persistence/guest-planner-store'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from './blobs'
import { validateWorkspaceClosure } from './closure'
import { requireGuestSuccessorJournal, type GuestSuccessorJournal, type GuestManifestV2 } from './guest-coordinator'
import { compareGuestEvidence, databaseEvidenceRows, mergeGuestEvidence, readGuestEvidence, emptyPlannerEvidence, guestEvidenceFromFrozenCurrent, type CapturedGuestEvidence, type GuestEvidenceStageWriter } from './guest-evidence'
import { readCapturedGuestEvidence } from './guest-evidence-capture'
import { GuestFilesDatabase, writeGuestFiles } from './guest-files'
import { assertGuestCurrent, guestParticipants, readGuestWorkspace, type GuestBindings, type GuestCommitOptions } from './guest-workspace'
import { prepareGuestRestorePlanner, prepareGuestDomainMigration250, requirePreparedGuestPlanner } from './guest-planner'
import { readUnselectedGuestCapture } from './guest-snapshot'
import { withGuestOperationOwner, type GuestOperationOwner } from './guest-ownership'
import { GUEST_BARRIER_KEY, acquireParticipantBarrier, releaseParticipantBarrier } from './guest-barrier'
import { captureLegacyBranch, compareHeldLegacyBranch, compareLegacyBranch, holdLegacyReaders, readLegacyCapture, type LegacyCapture, type LegacyParticipant, type HeldLegacyReaders } from './legacy-capture'
import { equalLegacyValue } from './legacy-value'
import { backupMetadataDigest, ownWorkspaceSnapshot } from './snapshot'
import { historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'
import { WorkspaceError } from './repository'
import type { WorkspaceState } from './documents'

interface SuccessorAuthority {
  readonly binding: GuestBindings
  readonly source: LegacyCapture
  readonly participants: readonly LegacyParticipant[]
  readonly journal: GuestSuccessorJournal
}

function comparableState(state: WorkspaceState): unknown {
  const ordered = <T extends { id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id))
  return {
    ...state, planner: { ...state.planner, catalogs: [...state.planner.catalogs].sort((a, b) => JSON.stringify([a.id, a.revisionId]).localeCompare(JSON.stringify([b.id, b.revisionId]))), sources: ordered(state.planner.sources), evidence: ordered(state.planner.evidence), history: ordered(state.planner.history) },
    editorDocuments: ordered(state.editorDocuments), saveDocuments: ordered(state.saveDocuments), assets: ordered(state.assets), conflicts: ordered(state.conflicts), retainedContent: ordered(state.retainedContent),
    blobs: state.blobs.map(({ ref }) => ref).sort((a, b) => blobIdentity(a).localeCompare(blobIdentity(b))),
  }
}

function preserveInspectorOnlyDrafts(before: WorkspaceState, captured: WorkspaceState, next: WorkspaceState): WorkspaceState {
  const visible = new Set(before.editorDocuments.map(document => document.id))
  const requested = new Set(next.editorDocuments.map(document => document.id))
  const drafts = captured.editorDocuments.filter(document => !visible.has(document.id) && !requested.has(document.id))
  if (!drafts.length) return next
  const capturedBodies = new Map(captured.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const blobs = new Map(next.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  for (const draft of drafts) for (const ref of [draft.original, draft.lastApplied, draft.unfinished?.text]) {
    if (!ref) continue
    const key = blobIdentity(ref), body = capturedBodies.get(key)
    if (!body) throw new Error('Captured Inspector draft body is unavailable')
    if (!blobs.has(key)) blobs.set(key, body)
  }
  // Project native-only drafts once so subsequent commands and backups see the same complete file graph
  return { ...next, editorDocuments: [...next.editorDocuments, ...drafts], blobs: [...blobs.values()] }
}

async function stageBatch<T>(authority: SuccessorAuthority, action: (owner: GuestOperationOwner) => Promise<T>): Promise<T> {
  const { binding, source, journal } = authority
  return withGuestOperationOwner(binding.coordinator, undefined, async owner => {
    const table = binding.coordinator.table<GuestSuccessorJournal, string>('journal')
    await binding.coordinator.transaction('rw', binding.coordinator.active, table, binding.coordinator.captures, async () => {
      owner.assertAlive()
      const row = requireGuestSuccessorJournal(await table.get(journal.id))
      const selected = await binding.coordinator.active.get('active')
      const frozen = await binding.coordinator.captures.get(source.id)
      const recovery = journal.recoveryCapture && await binding.coordinator.captures.get(journal.recoveryCapture.id)
      if ((row.phase !== 'registered' && row.phase !== 'staging') || !equalLegacyValue(row.expected, journal.expected)
        || !selected || !equalLegacyValue(selected.manifest, journal.expected) || !frozen || !equalLegacyValue(frozen, source)
        || !guestPlannerValuesEqual(row.recoveryCapture, journal.recoveryCapture)
        || journal.recoveryCapture && !guestPlannerValuesEqual(recovery, journal.recoveryCapture)) throw new Error('Guest successor staging authority changed')
      await table.put({ ...row, phase: 'staging', owner: owner.id, ownerGeneration: row.ownerGeneration + 1 })
      owner.assertAlive()
    })
    const result = await action(owner)
    owner.assertAlive()
    return result
  })
}

async function markBlocked(authority: SuccessorAuthority): Promise<void> {
  const table = authority.binding.coordinator.table<GuestSuccessorJournal, string>('journal')
  await withGuestOperationOwner(authority.binding.coordinator, undefined, async owner => authority.binding.coordinator.transaction('rw', table, async () => {
    owner.assertAlive()
    const row = requireGuestSuccessorJournal(await table.get(authority.journal.id))
    if (row.phase === 'registered' || row.phase === 'staging' || row.phase === 'staged') await table.put({ ...row, phase: 'blocked', recovery: 'incomplete', owner: owner.id, ownerGeneration: row.ownerGeneration + 1 })
  }))
}

async function publish(authority: SuccessorAuthority, assertMayActivate: () => void): Promise<void> {
  const { binding, source, participants, journal } = authority
  const table = binding.coordinator.table<GuestSuccessorJournal, string>('journal')
  const row = requireGuestSuccessorJournal(await table.get(journal.id))
  if (row.phase !== 'staged' || !row.targetCapture || !equalLegacyValue(row.expected, binding.manifest)) throw new Error('Guest successor is not staged')
  const savedSource = await binding.coordinator.captures.get(source.id)
  const savedTarget = await binding.coordinator.captures.get(row.targetCapture.id)
  if (!savedSource || !equalLegacyValue(savedSource, source)) throw new Error('Guest successor source capture changed')
  if (row.recoveryCapture && !guestPlannerValuesEqual(await binding.coordinator.captures.get(row.recoveryCapture.id), row.recoveryCapture)) throw new Error('Guest successor recovery capture changed')
  // The strict journal parser orders fields differently from the capture store, so compare normalized metadata
  const normalizedTarget = savedTarget && { id: savedTarget.id, version: savedTarget.version, completed: savedTarget.completed,
    participants: savedTarget.participants.map(participant => ({ kind: participant.kind, name: participant.name, tables: participant.tables })) }
  if (!normalizedTarget || !equalLegacyValue(normalizedTarget, row.targetCapture)) throw new Error('Guest successor target capture changed')
  const target = { planner: new CryKitDatabase(row.target.planner, { plannerFormatRequirement: 'journaled' }), inspector: new InspectorStorage(row.target.inspector, { requiredGuestTarget: true }), files: new GuestFilesDatabase(row.target.files, { requiredGuestTarget: true }) }
  try {
    await target.planner.open(); await target.inspector.openDatabase(); await target.files.open()
    const targetParticipants: LegacyParticipant[] = [{ kind: 'planner', database: target.planner }, { kind: 'inspector', database: await target.inspector.openDatabase() }, { kind: 'files', database: target.files }]
    const frozen = await readUnselectedGuestCapture(binding.coordinator, savedTarget, row.target, () => {})
    if (await backupMetadataDigest(comparableState(frozen.state)) !== row.resultDigest) throw new Error('Guest successor result changed')
    await validateWorkspaceClosure(frozen.state)
    for (const member of frozen.inherited.members) if ((await historicalMetadataIdentity(member.metadata)).id !== member.id) throw new Error('Guest successor history changed')
    for (const body of frozen.inherited.bodies) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Guest successor historical body changed')
    if ((await compareLegacyBranch(binding.coordinator, savedTarget, targetParticipants)).status !== 'equal') throw new Error('Guest successor target changed')
    assertMayActivate()
    await withGuestOperationOwner(binding.coordinator, undefined, async owner => {
      let current = requireGuestSuccessorJournal(await table.get(row.id))
      const selected = await binding.coordinator.active.get('active')
      if (current.phase !== 'staged' || current.ownerGeneration !== row.ownerGeneration || !selected || !equalLegacyValue(selected.manifest, row.expected)) throw new Error('Guest successor publication authority changed')
      let sourceHeld: HeldLegacyReaders | undefined, targetHeld: HeldLegacyReaders | undefined
      try {
        // A committed barrier must always have a non-inert journal phase for restart reconciliation
        current = { ...current, phase: 'publishing', owner: owner.id, ownerGeneration: current.ownerGeneration + 1 }
        await table.put(current)
        owner.assertAlive()
        for (const participant of participants) {
          owner.assertAlive(); assertMayActivate()
          await acquireParticipantBarrier(participant.database, row.id)
          current = { ...current, acquired: [...current.acquired, participant.database.name], ownerGeneration: current.ownerGeneration + 1 }
          await table.put(current)
        }
        sourceHeld = await holdLegacyReaders(participants.map(participant => ({ ...participant, barrierOwner: row.id })), owner.signal)
        targetHeld = await holdLegacyReaders(targetParticipants, owner.signal)
        if (!await compareHeldLegacyBranch(binding.coordinator, source, sourceHeld)) throw new Error('Guest successor source changed before publication')
        if (!await compareHeldLegacyBranch(binding.coordinator, savedTarget, targetHeld)) throw new Error('Guest successor target changed before publication')
        owner.assertAlive(); sourceHeld.assertAlive(); targetHeld.assertAlive(); assertMayActivate()
        await binding.coordinator.transaction('rw', binding.coordinator.active, table, async () => {
          owner.assertAlive(); sourceHeld!.assertAlive(); targetHeld!.assertAlive(); assertMayActivate()
          const actual = requireGuestSuccessorJournal(await table.get(row.id))
          const pointer = await binding.coordinator.active.get('active')
          if (actual.phase !== 'publishing' || actual.owner !== owner.id || actual.ownerGeneration !== current.ownerGeneration
            || !pointer || !equalLegacyValue(pointer.manifest, row.expected)) throw new Error('Guest successor pointer authority changed')
          await binding.coordinator.table<{ key: 'active'; manifest: GuestManifestV2 }, string>('active').put({ key: 'active', manifest: row.target })
          await table.put({ ...actual, phase: 'published', recovery: 'unchecked' })
          owner.assertAlive(); sourceHeld!.assertAlive(); targetHeld!.assertAlive(); assertMayActivate()
        })
        await targetHeld.release(); targetHeld = undefined
        await sourceHeld.release(); sourceHeld = undefined
      } catch (error) {
        await targetHeld?.release(true); await sourceHeld?.release(true)
        owner.assertAlive()
        const pointer = await binding.coordinator.active.get('active')
        if (pointer && equalLegacyValue(pointer.manifest, row.expected)) {
          for (const participant of [...participants].reverse()) { owner.assertAlive(); await releaseParticipantBarrier(participant.database, row.id) }
          const blocked = requireGuestSuccessorJournal(await table.get(row.id))
          if (blocked.phase !== 'published') await table.put({ ...blocked, phase: 'blocked', recovery: 'incomplete', owner: owner.id, ownerGeneration: blocked.ownerGeneration + 1 })
        }
        throw error
      }
    })
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('crykit-guest-activated'))
  } finally { target.planner.close(); target.inspector.close(); target.files.close() }
}

export async function commitGuestWorkspaceSuccessor(binding: GuestBindings, next: WorkspaceState, expectedRevision: number, mode: 'additive' | 'replace', options: GuestCommitOptions, domainMigration250 = false): Promise<LoadedLocalData> {
  if (binding.planner.frozenSource240 !== domainMigration250) throw new Error('A frozen source requires the domain migration path')
  if (binding.manifest.version !== 2) throw new Error('A selected v2 guest profile is required')
  options.assertMayActivate?.()
  await assertGuestCurrent(binding)
  const before = await readGuestWorkspace(binding)
  if (before.planner.localData.revision !== expectedRevision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
  const participants = await guestParticipants(binding)
  const source = await captureLegacyBranch(binding.coordinator, participants)
  const captured = await readUnselectedGuestCapture(binding.coordinator, source, binding.manifest, () => {})
  if (!guestPlannerValuesEqual(before.planner, captured.state.planner)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed during capture. Keep your draft and retry.')
  const check = async () => {
    await assertGuestCurrent(binding)
    if ((await compareLegacyBranch(binding.coordinator, source, participants)).status !== 'equal') throw new Error('The selected guest source changed')
  }
  const selectedEvidence = await readCapturedGuestEvidence(binding.coordinator, source, check)
  let recoveryEvidence: CapturedGuestEvidence | undefined
  if (options.recoveryCapture) {
    const saved = await binding.coordinator.captures.get(options.recoveryCapture.id)
    if (!saved || !guestPlannerValuesEqual(saved, options.recoveryCapture)) throw new Error('The retained recovery capture changed')
    recoveryEvidence = await readCapturedGuestEvidence(binding.coordinator, saved, check, true)
  }
  const currentTuple = await binding.planner.transaction('r', [binding.planner.localDatas, binding.planner.meta, binding.planner.history], async () => {
    const record = await binding.planner.localDatas.get(GUEST_PLANNER_ROOT_KEY)
    const declaration = await binding.planner.meta.get(GUEST_PLANNER_LAYOUT_KEY)
    if (!record || !declaration) throw new Error('The selected operative planner is incomplete')
    return { record, declaration, history: await binding.planner.history.toArray() }
  })
  const resolved = preserveInspectorOnlyDrafts(before, captured.state, next)
  const prepared = domainMigration250 ? prepareGuestDomainMigration250(captured.state.planner, currentTuple) : prepareGuestRestorePlanner(captured.state.planner, resolved.planner, mode, currentTuple, options.command ?? 'workspace-command')
  const preparedPlanner = requirePreparedGuestPlanner(prepared).planner
  let evidence = await mergeGuestEvidence(selectedEvidence, recoveryEvidence ?? selectedEvidence, { ...emptyPlannerEvidence(), savedChanges: preparedPlanner.savedChanges ?? preparedPlanner.localData.changes })
  if (domainMigration250) {
    const original = ownWorkspaceSnapshot({ version: 1, snapshotId: source.id, capturedAt: captured.state.planner.localData.updatedAt, revisionVector: { guest: binding.manifest.id, capture: source.id }, state: captured.state }, { check, dispose: async () => {} })
    evidence = await mergeGuestEvidence(evidence, await guestEvidenceFromFrozenCurrent(original), evidence.planner)
  }
  const sources = new Set(preparedPlanner.sources.map(value => blobIdentity(value.original)))
  const blobs = new Map(resolved.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  for (const blob of captured.state.blobs) if (sources.has(blobIdentity(blob.ref)) && !blobs.has(blobIdentity(blob.ref))) blobs.set(blobIdentity(blob.ref), blob)
  const state: WorkspaceState = { ...resolved, planner: preparedPlanner, blobs: [...blobs.values()] }
  await validateWorkspaceClosure(state)
  await check()
  const commandId = options.operationId ?? crypto.randomUUID()
  const id = crypto.randomUUID(), prefix = `crykit-restored-v2-${id}`
  const journal = requireGuestSuccessorJournal({ version: 2, kind: 'guest-successor', id, commandId, expected: binding.manifest,
    target: { version: 2, id, revision: binding.manifest.revision + 1, planner: `${prefix}-planner`, inspector: `${prefix}-inspector`, files: `${prefix}-files` },
    capture: source, phase: 'registered', ownerGeneration: 0, sourceVectorDigest: await backupMetadataDigest({ expected: binding.manifest, capture: source }),
    resultDigest: await backupMetadataDigest(comparableState(state)), acquired: [], recovery: 'unchecked',
    ...(options.recoveryCapture ? { recoveryCapture: options.recoveryCapture } : {}) })
  const authority: SuccessorAuthority = { binding, source, participants, journal }
  await withGuestOperationOwner(binding.coordinator, undefined, async owner => {
    if ((await compareLegacyBranch(binding.coordinator, source, participants, owner.signal)).status !== 'equal') throw new Error('The selected guest source changed before registration')
    await binding.coordinator.transaction('rw', binding.coordinator.active, binding.coordinator.journal, async () => {
      owner.assertAlive()
      const pointer = await binding.coordinator.active.get('active')
      if (!pointer || !equalLegacyValue(pointer.manifest, binding.manifest)) throw new Error('The selected guest profile changed before registration')
      await binding.coordinator.table<GuestSuccessorJournal, string>('journal').add(journal)
      owner.assertAlive()
    })
  })
  const planner = new CryKitDatabase(journal.target.planner, { plannerFormatRequirement: 'journaled', freshGuestTarget: true })
  const inspector = new InspectorStorage(journal.target.inspector, { freshGuestTarget: true })
  const files = new GuestFilesDatabase(journal.target.files, { freshGuestTarget: true })
  try {
    await stageBatch(authority, async owner => {
      const close = () => { planner.close(); inspector.close(); files.close() }
      owner.signal.addEventListener('abort', close, { once: true })
      try { await planner.open(); owner.assertAlive(); await inspector.openDatabase(); owner.assertAlive(); await files.open(); owner.assertAlive() }
      finally { owner.signal.removeEventListener('abort', close) }
    })
    const add = async (database: Dexie, table: string, value: unknown) => stageBatch(authority, async owner => { owner.assertAlive(); await database.table(table).add(value); owner.assertAlive() })
    for (const item of state.planner.evidence) await add(planner, 'evidence', item)
    for (const sourceRow of state.planner.sources) {
      const body = blobs.get(blobIdentity(sourceRow.original))
      if (!body) throw new Error('Guest successor source body is missing')
      const bytes = await readBlob(body.content, sourceRow.original.byteLength)
      if (await hashBlob(memoryBlob(bytes)) !== sourceRow.original.sha256) throw new Error('Guest successor source body changed')
      const { original: _original, ...metadata } = sourceRow
      await add(planner, 'sources', { ...metadata, bytes })
    }
    const raw = options.recoveryCapture ?? source
    const inspectorDatabase = await inspector.openDatabase()
    for await (const record of readLegacyCapture(binding.coordinator, raw)) {
      if (record.kind !== 'record') continue
      if (record.participant === 'inspector' && record.table !== 'meta') await add(inspectorDatabase, record.table, record.value)
      if (record.participant === 'inspector' && record.table === 'meta' && (record.value as { key?: string }).key !== GUEST_BARRIER_KEY) await add(inspectorDatabase, 'meta', record.value)
      if (record.participant === 'planner' && record.table === 'imports') await add(planner, 'imports', record.value)
      if (record.participant === 'planner' && record.table === 'meta' && ![GUEST_PLANNER_LAYOUT_KEY, GUEST_BARRIER_KEY].includes((record.value as { key?: string }).key ?? '')) await add(planner, 'meta', record.value)
    }
    const stagedRows = { localDatas: await planner.localDatas.toArray(), catalogs: await planner.catalogs.toArray(), evidence: await planner.evidence.toArray(), sources: await planner.sources.toArray(), history: await planner.history.toArray(), imports: await planner.imports.toArray(), meta: await planner.meta.toArray() }
    await stageBatch(authority, owner => writePreparedGuestPlanner(planner, prepared, { expectedStaged: stagedRows, assertOwned: () => owner.assertAlive() }))
    const writer: GuestEvidenceStageWriter = { put: (table, value) => add(files, table, value), clear: table => stageBatch(authority, async owner => { owner.assertAlive(); await files.table(table).clear(); owner.assertAlive() }), delete: (table, key) => stageBatch(authority, async owner => { owner.assertAlive(); await files.table(table).delete(key); owner.assertAlive() }) }
    await writeGuestFiles(files, state, evidence, writer)
    await check()
    const targetParticipants: LegacyParticipant[] = [{ kind: 'planner', database: planner }, { kind: 'inspector', database: await inspector.openDatabase() }, { kind: 'files', database: files }]
    const targetCapture = await captureLegacyBranch(binding.coordinator, targetParticipants)
    const unselected = await readUnselectedGuestCapture(binding.coordinator, targetCapture, journal.target, () => {})
    if (!guestPlannerValuesEqual(comparableState(state), comparableState(unselected.state))) throw new Error('Guest successor differs from its staged result')
    await validateWorkspaceClosure(unselected.state)
    await compareGuestEvidence(evidence, await readGuestEvidence(databaseEvidenceRows(files), async () => {}))
    await check()
    // Persist the exact projected target digest after semantic equality with the requested state
    const stagedResultDigest = await backupMetadataDigest(comparableState(unselected.state))
    await withGuestOperationOwner(binding.coordinator, undefined, async owner => binding.coordinator.transaction('rw', binding.coordinator.active, binding.coordinator.journal, async () => {
      owner.assertAlive()
      const table = binding.coordinator.table<GuestSuccessorJournal, string>('journal')
      const actual = requireGuestSuccessorJournal(await table.get(journal.id))
      const pointer = await binding.coordinator.active.get('active')
      if (actual.phase !== 'staging' || !pointer || !equalLegacyValue(pointer.manifest, binding.manifest)) throw new Error('Guest successor staging authority changed')
      await table.put({ ...actual, targetCapture, resultDigest: stagedResultDigest, phase: 'staged', owner: owner.id, ownerGeneration: actual.ownerGeneration + 1 })
      owner.assertAlive()
    }))
    options.onPreparedV2?.(journal.target, unselected.state, evidence)
    await options.assertPreparedInspector?.(inspector)
    options.assertMayActivate?.()
    await publish(authority, options.assertMayActivate ?? (() => {}))
    return { localData: unselected.state.planner.localData, lineage: unselected.state.planner.lineage, catalogs: unselected.state.planner.catalogs, evidence: unselected.state.planner.evidence, revision: unselected.state.planner.localData.revision, canUndo: unselected.state.planner.journal?.undoable ?? false }
  } catch (error) { await markBlocked(authority).catch(() => {}); throw error }
  finally { planner.close(); inspector.close(); files.close() }
}

export async function migrateSelectedGuest250(binding: GuestBindings, assertMayActivate?: () => void): Promise<LoadedLocalData> {
  if (!binding.planner.frozenSource240) throw new Error('The selected source is not the frozen 2.4 format')
  const source = await readGuestWorkspace(binding)
  return commitGuestWorkspaceSuccessor(binding, source, source.planner.localData.revision, 'additive', { assertMayActivate }, true)
}
