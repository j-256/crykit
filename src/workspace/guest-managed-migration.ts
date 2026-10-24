import Dexie from 'dexie'
import { StoredNativeLocalDataSchema, NativeHistorySchema } from '../interchange/native-schema'
import { BUNDLED_SOURCE_ENTITY_IDS } from '../catalog/bundled'
import { HISTORICAL_BUNDLED_CATALOG } from '../domain/withdrawn-catalogs'
import { upgradeBundledReferences } from '../domain/bundled-reference-upgrade'
import type { LocalData } from '../domain/types'
import type { WorkspaceState } from './documents'
import { connectedHistory, migratePlanner250 } from './planner-journal'
import { ownWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { guestEvidenceFromFrozenCurrent, guestEvidenceSources, mergeGuestEvidence, type CapturedGuestEvidence } from './guest-evidence'
import { joinWorkspaceSnapshotEvidence } from '../interchange/workspace-backup-evidence'
import { GUEST_FILES_V1_STORES, GUEST_EVIDENCE_STORES } from './guest-evidence'
import { requireGuestManagedMigration, type GuestManagedMigration } from './guest-managed-contract'
export { requireGuestManagedMigration, type GuestManagedMigration } from './guest-managed-contract'
import { captureProfileEpoch } from '../account/profile'
import { assertGuestCurrent, type GuestBindings } from './guest-workspace'
import { checkGuestRecovery } from './guest-recovery'
import { captureLegacyBranch, holdLegacyReaders, compareHeldLegacyBranch, compareLegacyBranch, LegacyCaptureDatabase, type HeldLegacyReaders, type LegacyParticipant } from './legacy-capture'
import { acquireParticipantBarrier, releaseParticipantBarrier, GUEST_BARRIER_KEY } from './guest-barrier'
import { withGuestOperationOwner } from './guest-ownership'
import { readUnselectedGuestRecoveryCapture } from './guest-snapshot'
import { readCapturedGuestEvidence } from './guest-evidence-capture'
import { compareGuestEvidence } from './guest-evidence'
import { prepareLocalEvidence, readLocalEvidence } from './local-evidence'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'
import { createGuestLocalStore, type GuestManagedManifest } from './guest-local-store'
import { assertFileCommandResult } from './owned-file-command'
import { equalLegacyValue } from './legacy-value'

const inspectorSchemas: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  1: { drafts: 'id, updatedAt' },
  2: { drafts: 'id, updatedAt', chunks: '[draftId+kind+index], [draftId+kind], draftId' },
  3: { drafts: 'id, updatedAt', chunks: '[draftId+kind+index], [draftId+kind], draftId', meta: 'key' },
}
// Native index enumeration is name-ordered; declared index order carries no data semantics
const normalizedSchema = (schema: string) => { const [primary, ...indexes] = schema.replaceAll(' ', '').split(','); return [primary, ...indexes.sort()].join(',') }
const tableSchema = (table: Dexie['tables'][number]) => normalizedSchema([table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(','))

// Opening a retained Inspector through its writer would parse and rewrite saved drafts before capture
// Dynamic handles admit the supported schema without any versionchange or participant reseeding
async function migrationParticipants(binding: GuestBindings) {
  const opened: Dexie[] = []
  try {
    await assertGuestCurrent(binding)
    const initial = binding.manifest.version === 1 && binding.manifest.revision === 0 && !await binding.coordinator.journal.get(binding.manifest.id)
    const participants: LegacyParticipant[] = []
    for (const kind of ['planner', 'inspector', 'files'] as const) {
      const name = binding.manifest[kind]
      if (!await Dexie.exists(name)) {
        if (!initial || kind === 'planner') throw new Error('The selected guest participant is missing')
        // Pre-feature guests did not allocate unused Inspector/files storage; this is their existing empty initialization
        if (kind === 'inspector') await binding.inspector.openDatabase()
        else await binding.files.open()
      }
      await assertGuestCurrent(binding)
      const database = new Dexie(name); opened.push(database)
      await database.open()
      const schema: Readonly<Record<string, string>> | undefined = kind === 'planner' && Number.isInteger(database.verno) && database.verno >= 1 && database.verno <= 7
        ? Object.fromEntries(binding.planner.tables.map(table => [table.name, tableSchema(table)]))
        : kind === 'inspector' ? inspectorSchemas[database.verno]
        : kind === 'files' && database.verno === 1 ? GUEST_FILES_V1_STORES
        : kind === 'files' && database.verno === 2 ? { ...GUEST_FILES_V1_STORES, ...GUEST_EVIDENCE_STORES } : undefined
      if (!schema || Object.keys(schema).sort().join(',') !== database.tables.map(table => table.name).sort().join(',')
        || database.tables.some(table => tableSchema(table) !== normalizedSchema(schema[table.name] ?? ''))) throw new Error('The selected guest schema is unsupported')
      if (binding.manifest.version === 2 && (kind === 'planner' ? ![6, 7].includes(database.verno) : kind === 'inspector' ? database.verno !== 3 : database.verno !== 2)) throw new Error('The selected restored guest schema is unsupported')
      participants.push({ kind, database })
    }
    await assertGuestCurrent(binding)
    return { participants, close: () => { for (const database of opened) database.close() } }
  } catch (error) { for (const database of opened) database.close(); throw error }
}

// Use the same native normalization and pin migration as the legacy versionchange producer
// Only the new managed projection changes; the held source capture and original databases stay exact
function projectLegacyPlanner(state: WorkspaceState, version: number) {
  if (state.planner.journal) return { state, original: state }
  const normalize = (value: LocalData): LocalData => version < 6
    ? upgradeBundledReferences(StoredNativeLocalDataSchema.parse(value) as unknown as LocalData, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)
    : value
  const original = { ...state, planner: { ...state.planner, localData: normalize(state.planner.localData), history: state.planner.history.map(entry => {
    const parsed = version < 6 ? NativeHistorySchema.parse(entry) as unknown as typeof entry : entry
    return { ...parsed, before: normalize(parsed.before), after: normalize(parsed.after) }
  }) } }
  const migrated = migratePlanner250(original.planner)
  const checkpoints = migrated.journal?.checkpoints ?? connectedHistory(migrated)
  if (migrated === original.planner && !checkpoints.length) return { state: original, original }
  const byId = new Map(checkpoints.map(entry => [entry.id, entry]))
  const planner = { ...migrated, history: migrated.history.map(entry => byId.get(entry.id) ?? entry), journal: migrated.journal ?? { version: 1 as const, changes: migrated.localData.changes, checkpoints, undoable: checkpoints.length > 0 } }
  return { state: { ...state, planner }, original }
}

export async function captureGuestNativeForCopy(binding: GuestBindings): Promise<{ readonly snapshot: WorkspaceSnapshot; readonly originals: CapturedGuestEvidence }> {
  const profile = captureProfileEpoch()
  if ((await checkGuestRecovery(binding, profile.signal)).length) throw new Error('Resolve retained guest recovery before copying')
  const opened = await migrationParticipants(binding), frozen = new LegacyCaptureDatabase(`crykit-copy-guest-capture-${crypto.randomUUID()}`)
  let disposed = false, disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => { disposed = true; opened.close(); await frozen.delete() })()
  const alive = () => { profile.assertCurrent(); if (disposed) throw new Error('Local copy capture was released') }
  try {
    // Use the migration's non-upgrading readers and pure projection, without publishing a successor
    // Opening an old planner through its typed writer would upgrade the very original being copied
    const capture = await captureLegacyBranch(frozen, opened.participants, profile.signal)
    const check = async () => {
      alive(); await assertGuestCurrent(binding)
      const comparison = await compareLegacyBranch(frozen, capture, opened.participants, profile.signal)
      await assertGuestCurrent(binding); alive()
      if (comparison.status !== 'equal') throw new Error('The local workspace changed during copy preview')
    }
    const source = await readUnselectedGuestRecoveryCapture(frozen, capture, alive, { omitUnreferencedBundledCatalogs: true })
    const projection = projectLegacyPlanner(source.state, opened.participants[0].database.verno)
    const inherited = await readCapturedGuestEvidence(frozen, capture, check, true, alive)
    const header = { version: 1 as const, snapshotId: capture.id, capturedAt: projection.original.planner.localData.updatedAt, revisionVector: { guest: binding.manifest.id, capture: capture.id } }
    const original = ownWorkspaceSnapshot({ ...header, state: projection.original }, { check, dispose })
    const evidence = await mergeGuestEvidence(inherited, await guestEvidenceFromFrozenCurrent(original), inherited.planner)
    const current = equalLegacyValue(projection.state, projection.original) ? original : ownWorkspaceSnapshot({ ...header, state: projection.state }, { check, dispose })
    await check()
    // The join adopts the same frozen owner, retaining source freshness and every older original
    const snapshot = await joinWorkspaceSnapshotEvidence(current, guestEvidenceSources(evidence), { signal: profile.signal })
    return Object.freeze({ snapshot, originals: evidence })
  } catch (error) { await dispose(); throw error }
}

// Native ownership excludes a still-live publisher before interrupted barriers are released
// A published receipt is never rolled back, even after a later managed edit changes the active head
export async function reconcileGuestManagedMigration(binding: GuestBindings, id: string): Promise<'published' | 'failed'> {
  const profile = captureProfileEpoch(), rows = binding.coordinator.table<GuestManagedMigration, string>('managedMigrations')
  return withGuestOperationOwner(binding.coordinator, profile.signal, async owner => {
    const row = requireGuestManagedMigration(await rows.get(id))
    if (!equalLegacyValue(row.expected, binding.manifest) || !equalLegacyValue(await binding.coordinator.captures.get(row.capture.id), row.capture)) throw new Error('Managed migration source changed')
    if (row.phase === 'published') {
      const receipt = await binding.coordinator.table('managedOperations').get(id)
      if (!receipt || !equalLegacyValue(receipt.target, row.target) || !equalLegacyValue(receipt.expected, row.expected)) throw new Error('Managed migration receipt changed')
      return 'published'
    }
    await assertGuestCurrent(binding)
    const opened = await migrationParticipants(binding), participants = opened.participants
    try {
      const owned: GuestManagedMigration = { ...row, owner: owner.id }
      await binding.coordinator.transaction('rw', rows, binding.coordinator.active, async () => {
        owner.assertAlive(); profile.assertCurrent()
        if (!equalLegacyValue(await rows.get(id), row) || !equalLegacyValue((await binding.coordinator.active.get('active'))?.manifest, row.expected)) throw new Error('Managed migration ownership changed')
        await rows.put(owned)
      })
      for (const participant of [...participants].reverse()) {
        owner.assertAlive(); profile.assertCurrent()
        if (!participant.database.tables.some(table => table.name === 'meta')) continue
        const barrier = await participant.database.table('meta').get(GUEST_BARRIER_KEY)
        if (barrier) {
          if (!equalLegacyValue(barrier, { key: GUEST_BARRIER_KEY, value: id })) throw new Error('Another operation owns the guest barrier')
          await releaseParticipantBarrier(participant.database, id)
        }
      }
      await binding.coordinator.transaction('rw', rows, binding.coordinator.active, async () => {
        owner.assertAlive(); profile.assertCurrent()
        if (!equalLegacyValue(await rows.get(id), owned) || !equalLegacyValue((await binding.coordinator.active.get('active'))?.manifest, row.expected)) throw new Error('Managed migration reconciliation changed')
        await rows.put({ ...owned, phase: 'failed' })
      })
      return 'failed'
    } finally { opened.close() }
  })
}

// Preparation is explicit startup work, never charged to the first ordinary save
// The old participant stores and frozen source remain recoverable after the one coordinator CAS
export async function migrateGuestWorkspace(binding: GuestBindings): Promise<GuestManagedManifest> {
  const profile = captureProfileEpoch()
  const check = () => profile.assertCurrent()
  if ((await checkGuestRecovery(binding, profile.signal)).length) throw new Error('Resolve retained guest recovery before migration')
  await assertGuestCurrent(binding)
  const opened = await migrationParticipants(binding), participants = opened.participants
  try {
    const capture = await captureLegacyBranch(binding.coordinator, participants, profile.signal)
    const frozen = await readUnselectedGuestRecoveryCapture(binding.coordinator, capture, check)
    let evidence = await readCapturedGuestEvidence(binding.coordinator, capture, async () => check(), true, check)
    const projection = projectLegacyPlanner(frozen.state, participants[0].database.verno)
    if (!equalLegacyValue(projection.state.planner, projection.original.planner)) {
      const original = ownWorkspaceSnapshot({ version: 1, snapshotId: capture.id, capturedAt: projection.original.planner.localData.updatedAt, revisionVector: { guest: binding.manifest.id, capture: capture.id }, state: projection.original }, { check: async () => check(), dispose: async () => {} })
      evidence = await mergeGuestEvidence(evidence, await guestEvidenceFromFrozenCurrent(original), evidence.planner)
    }
    const id = crypto.randomUUID(), store = createGuestLocalStore(binding.coordinator, check)
    const rows = binding.coordinator.table<GuestManagedMigration, string>('managedMigrations')
    const journal = requireGuestManagedMigration({ version: 1, kind: 'guest-managed-migration', id, expected: binding.manifest, capture, phase: 'prepared' })
    await rows.add(journal)
    const inherited = await prepareLocalEvidence(store.adapter, id, evidence)
    const lifetime = { check, assertCurrent: async () => check() }
    const prepared = await prepareLocalWorkspace(store.adapter, id, projection.state, lifetime, undefined, inherited, frozen.destinationChanges)
    await store.flush(id)
    const reader = createGuestLocalStore(binding.coordinator, check)
    const reopened = await admitLocalRoot(reader.adapter, prepared.head, lifetime)
    assertFileCommandResult(projection.state, reopened.state)
    await compareGuestEvidence(evidence, (await readLocalEvidence(reader.adapter, inherited, async () => check()))!)
    await assertGuestCurrent(binding)
    return await withGuestOperationOwner(binding.coordinator, profile.signal, async owner => {
      const owned: GuestManagedMigration = { ...journal, phase: 'publishing', owner: owner.id }
      await binding.coordinator.transaction('rw', rows, binding.coordinator.active, async () => {
        owner.assertAlive(); check()
        if (!equalLegacyValue(await rows.get(id), journal) || !equalLegacyValue((await binding.coordinator.active.get('active'))?.manifest, binding.manifest)) throw new Error('Guest migration selection changed')
        await rows.put(owned)
        owner.assertAlive(); check()
      })
      let held: HeldLegacyReaders | undefined
      const acquired: typeof participants[number][] = []
      try {
        // Pre-feature schemas without meta cannot obey a new barrier; keep their exact native readers through CAS
        // Their original schema stays intact and later writes are detected by the retained monitor
        for (const participant of participants) {
          owner.assertAlive(); check()
          if (participant.database.tables.some(table => table.name === 'meta')) { await acquireParticipantBarrier(participant.database, id); acquired.push(participant) }
        }
        held = await holdLegacyReaders(participants.map(participant => ({ ...participant, ...(acquired.includes(participant) ? { barrierOwner: id } : {}) })), owner.signal)
        if (!await compareHeldLegacyBranch(binding.coordinator, capture, held)) throw new Error('The original guest changed during migration')
        const receipt = await store.activate(id, prepared.head, binding.manifest, () => { check(); owner.assertAlive(); held!.assertAlive() }, undefined, owned)
        held.assertAlive()
        await held.release(); held = undefined
        return receipt.target
      } catch (error) {
        await held?.release(true)
        // Only an actual pre-publication pointer permits barrier release; ambiguous publication keeps both branches
        owner.assertAlive(); check()
        const active = await binding.coordinator.active.get('active')
        if (equalLegacyValue(active?.manifest, binding.manifest)) {
          for (const participant of acquired.reverse()) { owner.assertAlive(); await releaseParticipantBarrier(participant.database, id) }
        }
        throw error
      }
    })
  } finally { opened.close() }
}
