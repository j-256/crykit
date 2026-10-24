import { expect, it } from 'vitest'
import { addTestScenario, createTestLocalData } from '../domain/test-helpers'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { createPersonalDefinition } from '../domain'
import { changedLocalData, historyEntry } from '../persistence/local-data'
import { nowTimestamp } from '../interchange/util'
import type { WorkspacePlannerState } from './documents'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from './guest-planner'
import { afterLocalCommand, connectedHistory, migratePlanner250, projectPlanner, undoCheckpoint } from './planner-journal'

const blank = (): WorkspacePlannerState => { const localData = createBlankLocalData(); return { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] } }
function command(before: WorkspacePlannerState, name: string): WorkspacePlannerState {
  const time = nowTimestamp(), localData = changedLocalData(before.localData, createPersonalDefinition(before.localData, { kind: 'item', name }), 'save', time)
  const checkpoint = historyEntry(before.localData, localData, 'save', time)
  return afterLocalCommand(before, { ...before, localData, history: [...before.history, checkpoint] }, checkpoint)
}
it('keepsSameNumberSourceHistoriesExactAndCreatesOnlyATruthfulLocalTransition', () => {
  const base = blank(), left = command(base, 'Left'), right = command(base, 'Right')
  const originals = JSON.stringify([left.history, right.history])
  const accepted = { ...right, localData: { ...right.localData, personalDefinitions: { ...left.localData.personalDefinitions, ...right.localData.personalDefinitions } } }
  const projected = projectPlanner(left, accepted, false)
  expect(projected.localData.revision).toBe(2)
  expect(projected.localData.changes.map(value => value.nextRevision)).toEqual([1, 2])
  expect(projected.savedChanges!.map(value => value.nextRevision)).toEqual([1, 1])
  expect(JSON.stringify([left.history, right.history])).toBe(originals)
  expect(projected.history).toEqual([...left.history, ...right.history])
  expect(undoCheckpoint(projected)).toBeUndefined()
  expect(connectedHistory(projected).at(-1)!.before).toEqual(left.localData)
  expect(connectedHistory(projected).at(-1)!.after).toEqual(projected.localData)
  const saved = command(projected, 'After pull')
  expect(undoCheckpoint(saved)!.before).toEqual(projected.localData)
  expect(saved.savedChanges!.some(value => value.command === 'sync-projection')).toBe(false)
})
it('adoptsAFirstRemoteWorkspaceWithoutInventingPriorDeviceHistory', () => {
  const remote = command(blank(), 'Original')
  const adopted = projectPlanner(blank(), remote, true)
  expect(adopted.localData.id).toBe(remote.localData.id)
  expect(adopted.localData.revision).toBe(0)
  expect(adopted.localData.changes).toEqual([])
  expect(adopted.history).toEqual(remote.history)
  expect(adopted.savedChanges).toEqual(remote.localData.changes)
  expect(connectedHistory(adopted)).toEqual([])
  expect(undoCheckpoint(adopted)).toBeUndefined()
})
it('resets operative undo on an equal-semantic guest restore', () => {
  const before = command(blank(), 'Current'), evidence = command(emptyPlanner(), 'New original')
  const imported = { ...before, history: [...before.history, ...evidence.history], savedChanges: [...before.localData.changes, ...evidence.localData.changes], journal: { version: 1 as const, changes: before.localData.changes, checkpoints: before.history, undoable: true } }
  const restored = requirePreparedGuestPlanner(prepareGuestRestorePlanner(before, imported, 'replace')).planner
  expect(restored.history).toContainEqual(evidence.history[0])
  expect(restored.savedChanges).toContainEqual(evidence.localData.changes[0])
  expect(restored.journal?.undoable).toBe(false)
  expect(restored.journal?.checkpoints).toEqual([])
  expect(restored.localData.revision).toBe(before.localData.revision + 1)
})

const emptyPlanner = (localData = createBlankLocalData()): WorkspacePlannerState => ({ localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] })
it('preserves destination identity and advances a real restore even for equal contents', () => {
  const current = emptyPlanner(), resolved = emptyPlanner()
  const result = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, resolved, 'replace'))
  expect(result.planner.localData.id).toBe(current.localData.id)
  expect(result.planner.localData.createdAt).toBe(current.localData.createdAt)
  expect(result.planner.localData.revision).toBe(1)
  expect(result.planner.history.at(-1)?.before).toEqual(current.localData)
  expect(result.planner.history.at(-1)?.after).toEqual(result.planner.localData)
  expect(result.planner.history.at(-1)?.command).toBe('guest-restore')
  expect(result.record.operativePlanner.checkpointIds).toEqual([])
  expect(result.record.operativePlanner.savedDestinationChanges).toEqual(result.planner.localData.changes)
  expect(result.resolved).toEqual(resolved)
})
it('does not give additive mode implicit merge or imported selection authority', () => {
  const current = command(emptyPlanner(), 'Only destination'), resolved = emptyPlanner()
  const result = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, resolved, 'additive'))
  expect(result.planner.localData.personalDefinitions).toEqual({})
  expect(result.mode).toBe('additive')
  expect(result.current.localData.personalDefinitions).toEqual(current.localData.personalDefinitions)
  expect(result.planner.history).toContainEqual(current.history[0])
})
it('requires the registered preparation identity and protects it from caller mutation', () => {
  const current = emptyPlanner(), resolved = emptyPlanner()
  const owned = prepareGuestRestorePlanner(current, resolved, 'replace')
  const projection = requirePreparedGuestPlanner(owned)
  expect(() => requirePreparedGuestPlanner({ ...owned })).toThrow()
  expect(() => requirePreparedGuestPlanner(structuredClone(owned))).toThrow()
  expect(() => requirePreparedGuestPlanner(projection as unknown as typeof owned)).toThrow()
  const before = structuredClone(projection)
  Object.assign(current.localData, { revision: 999 })
  Object.assign(resolved.localData, { revision: 999 })
  expect(requirePreparedGuestPlanner(owned)).toEqual(before)
  expect(() => Object.assign(projection.record.operativePlanner, { undoable: true })).toThrow()
  expect(() => (projection.planner.history as unknown[]).push({})).toThrow()
})
it('rejects root counter overflow before creating a transition', () => {
  const current = emptyPlanner()
  const full = { ...current, localData: { ...current.localData, revision: Number.MAX_SAFE_INTEGER } }
  expect(() => prepareGuestRestorePlanner(full, current, 'replace')).toThrow(/overflow/)
})
it('does not infer destination changes from mixed saved evidence', () => {
  const current = emptyPlanner(), source = command(emptyPlanner(), 'Imported original')
  const mixed = { ...current, savedChanges: source.localData.changes }
  const projection = requirePreparedGuestPlanner(prepareGuestRestorePlanner(mixed, source, 'replace'))
  expect(projection.record.operativePlanner.savedDestinationChanges).toHaveLength(1)
  expect(projection.record.operativePlanner.savedDestinationChanges[0].command).toBe('guest-restore')
  expect(projection.planner.savedChanges).toContainEqual(source.localData.changes[0])
  expect(projection.current.savedChanges).toEqual(source.localData.changes)
})
it('requires a matching current tuple and retains destination evidence beyond the visible window', () => {
  const legacy = command(emptyPlanner(), 'Older destination change')
  const first = requirePreparedGuestPlanner(prepareGuestRestorePlanner(legacy, legacy, 'replace'))
  const current = { ...first.planner, localData: { ...first.planner.localData, revision: 1000, changes: [] }, journal: { version: 1 as const, changes: [], checkpoints: [], undoable: false } }
  const record = { ...first.record, revision: 1000, localData: current.localData, operativePlanner: { ...first.record.operativePlanner, revision: 1000 } }
  const tuple = { record, declaration: first.declaration, history: current.history }
  expect(() => prepareGuestRestorePlanner(current, legacy, 'replace')).toThrow(/tuple/)
  const result = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, legacy, 'replace', tuple))
  expect(result.record.operativePlanner.savedDestinationChanges.slice(0, 2)).toEqual(first.record.operativePlanner.savedDestinationChanges)
  expect(result.planner.localData.revision).toBe(1001)
  expect(result.record.operativePlanner.epoch).not.toBe(first.record.operativePlanner.epoch)
  expect(() => prepareGuestRestorePlanner(current, legacy, 'replace', { ...tuple, record: { ...record, localData: { ...record.localData, createdAt: '2025-01-01T00:00:00.000Z' as typeof record.localData.createdAt } } })).toThrow(/destination/)
})
it('rejects changed immutable history and saved evidence identities', () => {
  const current = command(emptyPlanner(), 'Saved')
  expect(() => prepareGuestRestorePlanner(current, { ...current, history: [{ ...current.history[0], command: 'Changed' }] }, 'replace')).toThrow(/Immutable/)
  expect(() => prepareGuestRestorePlanner(current, { ...emptyPlanner(), savedChanges: [{ ...current.localData.changes[0], command: 'Changed' }] }, 'replace')).toThrow(/Immutable/)
})

function selectedPlanner(): WorkspacePlannerState {
  const localData = addTestScenario(addTestScenario(createTestLocalData(), {}, 'first'), {}, 'second')
  const playthrough = localData.playthroughs.playthrough
  return emptyPlanner({ ...localData, selectedPlaythroughId: playthrough.id, planningGameSetupRevisionId: Object.values(localData.gameSetups)[0].id, playthroughs: { ...localData.playthroughs, playthrough: { ...playthrough, activeScenarioId: Object.values(playthrough.scenarios)[0].id } } })
}
it('preserves only valid destination selectors and never imports active source choices', () => {
  const current = selectedPlanner(), imported = structuredClone(current)
  const sourcePlaythrough = imported.localData.playthroughs.playthrough
  Object.assign(sourcePlaythrough, { activeScenarioId: sourcePlaythrough.scenarios.second.id })
  const original = structuredClone(imported)
  const result = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, imported, 'replace'))
  expect(result.planner.localData.selectedPlaythroughId).toBe('playthrough')
  expect(result.planner.localData.planningGameSetupRevisionId).toBe('gameSetup-revision')
  expect(result.planner.localData.playthroughs.playthrough.activeScenarioId).toBe('first')
  expect(result.resolved).toEqual(original)
  expect(imported).toEqual(original)
  const fresh = requirePreparedGuestPlanner(prepareGuestRestorePlanner(emptyPlanner(), imported, 'replace'))
  expect(fresh.planner.localData.selectedPlaythroughId).toBeUndefined()
  expect(fresh.planner.localData.planningGameSetupRevisionId).toBeUndefined()
  expect(fresh.planner.localData.playthroughs.playthrough.activeScenarioId).toBeUndefined()
  const removed = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, emptyPlanner(), 'replace'))
  expect(removed.planner.localData.selectedPlaythroughId).toBeUndefined()
  expect(removed.planner.localData.planningGameSetupRevisionId).toBeUndefined()
})
it('uses validated recorded-party floors and destination clocks rather than imported counters', () => {
  const current = selectedPlanner(), imported = structuredClone(current)
  const value = imported.localData.playthroughs.playthrough
  Object.assign(value, { revision: 9000 })
  Object.assign(value.scenarios.first, { baseline: { kind: 'recordedParty', playthroughRevision: 50, assignments: {} } })
  const source = structuredClone(imported)
  const fresh = requirePreparedGuestPlanner(prepareGuestRestorePlanner(emptyPlanner(), imported, 'replace'))
  expect(fresh.planner.localData.playthroughs.playthrough.revision).toBe(50)
  const next = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, imported, 'replace'))
  expect(next.planner.localData.playthroughs.playthrough.revision).toBe(50)
  const later = structuredClone(current)
  Object.assign(later.localData.playthroughs.playthrough, { revision: 70 })
  const monotonic = requirePreparedGuestPlanner(prepareGuestRestorePlanner(later, imported, 'replace'))
  expect(monotonic.planner.localData.playthroughs.playthrough.revision).toBe(71)
  expect(imported).toEqual(source)
  Object.assign(value.scenarios.first, { baseline: { kind: 'recordedParty', playthroughRevision: 9001, assignments: {} } })
  expect(() => prepareGuestRestorePlanner(current, imported, 'replace')).toThrow(/future/)
})
it('retains unchanged playthrough clocks but rejects overflow on a changed playthrough', () => {
  const current = selectedPlanner(), imported = structuredClone(current)
  Object.assign(imported.localData.playthroughs.playthrough, { revision: 9000, updatedAt: '2025-01-01T00:00:00.000Z' })
  const result = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, imported, 'replace'))
  expect(result.planner.localData.playthroughs.playthrough.revision).toBe(current.localData.playthroughs.playthrough.revision)
  expect(result.planner.localData.playthroughs.playthrough.updatedAt).toBe(current.localData.playthroughs.playthrough.updatedAt)
  Object.assign(current.localData.playthroughs.playthrough, { revision: Number.MAX_SAFE_INTEGER })
  Object.assign(imported.localData.playthroughs.playthrough, { label: 'Changed' })
  expect(() => prepareGuestRestorePlanner(current, imported, 'replace')).toThrow(/overflow/)
})

it('rejects a second restore when its current tuple omitted the first live destination change', () => {
  const blank = emptyPlanner(), first = requirePreparedGuestPlanner(prepareGuestRestorePlanner(blank, blank, 'replace'))
  const record = { ...first.record, operativePlanner: { ...first.record.operativePlanner, savedDestinationChanges: [] } }
  const currentTuple = { record, declaration: first.declaration, history: first.planner.history }
  expect(first.planner.localData.changes).toHaveLength(1)
  expect(first.planner.localData.changes[0].command).toBe('guest-restore')
  expect(() => prepareGuestRestorePlanner(first.planner, blank, 'replace', currentTuple)).toThrow()
  expect(first.record.operativePlanner.savedDestinationChanges).toEqual(first.planner.localData.changes)
})

function frozenPlanner240(): WorkspacePlannerState {
  const planner = command(emptyPlanner(createTestLocalData()), 'Before Team migration')
  const frozen = (data: typeof planner.localData) => {
    const { teamRevisions: _revisions, ...rest } = data
    return { ...rest, schemaVersion: '2.4.0' } as unknown as typeof data
  }
  const history = planner.history.map(entry => ({ ...entry, before: frozen(entry.before), after: frozen(entry.after) }))
  return { ...planner, localData: frozen(planner.localData), history, journal: { version: 1, changes: planner.localData.changes, checkpoints: history, undoable: true } }
}
it('admits only the exact migrated source/live checkpoint pair without rewriting originals or importing undo', () => {
  const original = frozenPlanner240(), source = migratePlanner250(original)
  const before = structuredClone(source)
  expect(connectedHistory(source).map(entry => entry.id)).toEqual(original.history.map(entry => entry.id))
  const restored = requirePreparedGuestPlanner(prepareGuestRestorePlanner(emptyPlanner(), source, 'replace'))
  expect(restored.resolved).toEqual(before)
  expect(restored.planner.history).toContainEqual(original.history[0])
  expect(restored.planner.journal).toMatchObject({ checkpoints: [], undoable: false })
  expect(source).toEqual(before)
})
it.each(['before endpoint', 'after endpoint', 'command', 'previous counter', 'next counter', 'duplicate original', 'duplicate checkpoint', 'same-version conflict', 'malformed original'] as const)('rejects a conflicting source/live checkpoint: %s', corruption => {
  const source = structuredClone(migratePlanner250(frozenPlanner240()))
  const checkpoint = source.journal!.checkpoints[0]
  if (corruption === 'before endpoint') Object.assign(checkpoint.before, { updatedAt: '2025-01-01T00:00:00.000Z' })
  if (corruption === 'after endpoint') Object.assign(checkpoint.after, { updatedAt: '2025-01-01T00:00:00.000Z' })
  if (corruption === 'command') Object.assign(checkpoint, { command: 'different command' })
  if (corruption === 'previous counter') Object.assign(checkpoint, { previousRevision: checkpoint.previousRevision + 1 })
  if (corruption === 'next counter') Object.assign(checkpoint, { nextRevision: checkpoint.nextRevision + 1 })
  if (corruption === 'duplicate original') Object.assign(source, { history: [...source.history, { ...source.history[0], command: 'different original' }] })
  if (corruption === 'duplicate checkpoint') Object.assign(source.journal!, { checkpoints: [...source.journal!.checkpoints, { ...checkpoint, command: 'different checkpoint' }] })
  if (corruption === 'same-version conflict') Object.assign(source, { history: [{ ...checkpoint, command: 'different current-schema history' }] })
  if (corruption === 'malformed original') Object.assign(source.history[0].before, { schemaVersion: '2.99.0' })
  const before = structuredClone(source)
  expect(() => prepareGuestRestorePlanner(emptyPlanner(), source, 'replace')).toThrow()
  expect(source).toEqual(before)
})
