import 'fake-indexeddb/auto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { guestParticipants } from '../workspace/guest-workspace'
import { importGuestInheritedEvidence } from '../workspace/guest-evidence-import'
import { readGuestEvidence, databaseEvidenceRows, guestEvidenceSources } from '../workspace/guest-evidence'
import { editorClosureFixture } from '../workspace/test-helpers'
import { createPersonalDefinition } from '../domain/local-data'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { historicalEvidenceId, capturedBackupEvidence, readBackupMetadata } from '../interchange/workspace-backup-evidence'
import { assertOwnedWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, snapshotMetadata, type WorkspaceSnapshot } from '../workspace/snapshot'

// Exercise native v1/v2 compatibility directly before public startup migrates these stores to managed storage
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

it.each([true, false])('validates staged inert and operative same-ID changes before publication, conflicting=%s', async conflicting => {
  const database = new CryKitDatabase(`guest-evidence-admission-${crypto.randomUUID()}`), repository = createGuestRepository(database)
  let source: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    const initial = await repository.readWorkspace()
    const saved = await repository.save(createPersonalDefinition(initial.planner.localData, { name: 'Destination command', kind: 'item' }), initial.planner.localData.revision)
    const change = saved.localData.changes[0]
    expect(change).toBeDefined()
    const binding = await guestRepositoryBindings(repository), participants = await guestParticipants(binding)
    const rows = () => Promise.all(participants.map(async participant => ({ kind: participant.kind, tables: await Promise.all(participant.database.tables.map(async table => ({ name: table.name, rows: await table.toArray() }))) })))
    const originalRows = await rows(), originalPointer = await binding.coordinator.active.get('active'), before = await repository.readWorkspace()
    const { state } = await editorClosureFixture()
    source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'same-change-id', capturedAt: '2026-10-12', revisionVector: {}, state: { ...state, planner: { ...state.planner, savedChanges: [{ ...change, command: conflicting ? 'different-source-command' : change.command }] } } }))
    const originalMetadata = JSON.stringify(snapshotMetadata(source))
    if (conflicting) {
      await expect(importGuestInheritedEvidence(binding, source)).rejects.toThrow('Saved planner change identity collision')
      expect(await binding.coordinator.active.get('active')).toEqual(originalPointer)
      expect(await binding.coordinator.journal.count()).toBe(0)
      expect(await rows()).toEqual(originalRows)
      expect((await repository.readWorkspace()).planner).toEqual(before.planner)
    } else {
      await importGuestInheritedEvidence(binding, source)
      const successor = createGuestRepository(database), after = await successor.readWorkspace(), selected = await guestRepositoryBindings(successor)
      expect(after.planner.localData).toEqual(before.planner.localData)
      expect(after.planner.history).toEqual(before.planner.history)
      expect(after.planner.savedChanges).toEqual([change])
      const evidence = await readGuestEvidence(databaseEvidenceRows(selected.files), async () => {})
      expect(evidence.planner.savedChanges).toEqual([change])
      const [original] = guestEvidenceSources(evidence).members
      expect(JSON.stringify(await readBackupMetadata(original.metadata))).toBe(originalMetadata)
    }
    await assertOwnedWorkspaceSnapshot(source)
    expect(JSON.stringify(snapshotMetadata(source))).toBe(originalMetadata)
  } finally { if (source) await disposeWorkspaceSnapshot(source); await database.delete() }
})

function inertChanges(count: number, prefix: string): readonly import('../domain/types').ChangeEntry[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${count - index}` as import('../domain/types').ChangeId, command: `Inert command ${index}`, previousRevision: index, nextRevision: index + 1, changedPaths: ['zeta', 'alpha'], recordedAt: '2026-10-12T00:00:00.000Z' as import('../domain/types').Timestamp }))
}
async function portableOriginal(changes: readonly import('../domain/types').ChangeEntry[], id: string) {
  const { state } = await editorClosureFixture()
  const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: id, capturedAt: '2026-10-12', revisionVector: {}, state: { ...state, planner: { ...state.planner, savedChanges: changes } } }))
  expect(source.state.planner.localData.changes).toEqual([])
  expect(source.state.planner.savedChanges).toEqual(changes)
  return source
}

describe('portable inert saved changes beyond the operative list bound', () => {
  const changes = inertChanges(501, 'single-original')
  let database: CryKitDatabase, binding: Awaited<ReturnType<typeof guestRepositoryBindings>>
  let captured: WorkspaceSnapshot | undefined, originalMetadata: string
  const prepareOriginal = async () => {
    database = new CryKitDatabase(`guest-evidence-large-changes-${crypto.randomUUID()}`)
    const source = await portableOriginal(changes, 'large-inert-sequence')
    try {
      originalMetadata = JSON.stringify(snapshotMetadata(source))
      const repository = createGuestRepository(database)
      await repository.readWorkspace()
      await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
    } finally { await disposeWorkspaceSnapshot(source) }
    const selected = createGuestRepository(database), state = await selected.readWorkspace()
    expect(state.planner.savedChanges).toEqual(changes)
    expect(state.planner.localData.changes).toEqual([])
    await selected.commitWorkspace(state, state.planner.localData.revision)
    const successor = createGuestRepository(database), reopened = await successor.readWorkspace()
    expect(reopened.planner.savedChanges?.slice(0, changes.length)).toEqual(changes)
    expect(reopened.planner.savedChanges?.slice(changes.length)).toEqual(reopened.planner.localData.changes)
    binding = await guestRepositoryBindings(successor)
    captured = await (await import('../workspace/guest-snapshot')).captureGuestSnapshot(binding)
  }
  // Both assertions use this same persisted successor and capture after the original reader is disposed
  afterAll(async () => { if (captured) await disposeWorkspaceSnapshot(captured); await database?.delete() })
  it('reopens every inert entry in original order after a genuine full command', async () => {
    // Full native capture is part of this bulk journey, separate from ordinary command latency
    await prepareOriginal()
    const evidence = await readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    expect(evidence.planner.savedChanges).toEqual(changes)
    const [member] = guestEvidenceSources(evidence).members
    expect(JSON.stringify(await readBackupMetadata(member.metadata))).toBe(originalMetadata)
  })
  it('exports and independently rereads the exact large original and current saved-change union', async () => {
    if (!captured) throw new Error('Missing large original capture')
    const reopened = await readWorkspaceBackup(exportWorkspaceBackup(captured))
    try {
      expect(reopened.state.planner.savedChanges).toEqual(captured.state.planner.savedChanges)
      expect(reopened.state.planner.savedChanges?.slice(0, changes.length)).toEqual(changes)
      if (reopened.version !== 2) throw new Error('Missing inherited original')
      expect(reopened.historicalEvidence.snapshots).toHaveLength(1)
      const child = await openHistoricalSnapshot(reopened, reopened.historicalEvidence.snapshots[0].id)
      try { expect(JSON.stringify(snapshotMetadata(child))).toBe(originalMetadata) } finally { await disposeWorkspaceSnapshot(child) }
    } finally { await disposeWorkspaceSnapshot(reopened) }
  })
})

it('retains an accumulated inert sequence across two imports beyond the operative list bound', async () => {
  const database = new CryKitDatabase(`guest-evidence-accumulated-${crypto.randomUUID()}`), expected: import('../domain/types').ChangeEntry[] = [], originals = new Map<string, string>()
  try {
    for (const [index, count] of [300, 201].entries()) {
      const changes = inertChanges(count, `union-${index}`), source = await portableOriginal(changes, `union-source-${index}`)
      try {
        const raw = snapshotMetadata(source)
        // Historical identity covers the stored original pages, including their legacy packing
        originals.set(await historicalEvidenceId(capturedBackupEvidence(source).current), JSON.stringify(raw))
        const repository = createGuestRepository(database)
        await repository.readWorkspace()
        await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
        expected.push(...changes)
      } finally { await disposeWorkspaceSnapshot(source) }
    }
    const selected = createGuestRepository(database), state = await selected.readWorkspace(), binding = await guestRepositoryBindings(selected)
    expect(state.planner.savedChanges).toEqual(expected)
    expect(state.planner.localData.changes).toEqual([])
    const evidence = await readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    expect(evidence.planner.savedChanges).toEqual(expected)
    expect(guestEvidenceSources(evidence).members.map(member => member.id)).toEqual([...originals.keys()].sort())
    for (const member of guestEvidenceSources(evidence).members) expect(JSON.stringify(await readBackupMetadata(member.metadata))).toBe(originals.get(member.id))
  } finally { await database.delete() }
})
