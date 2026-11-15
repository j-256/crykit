import { afterEach, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import * as sourceFulfillment from '../domain/source-fulfillment'
import * as localValidation from '../persistence/local-data'
import { historyEntry } from '../persistence/local-data'
import { syntheticCatalog } from './test-helpers'
import type { WorkspaceState } from './documents'
import { validateWorkspace } from './validation'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const before = createBlankLocalData()
  const middle = { ...before, revision: 1 }, after = { ...before, revision: 2 }
  const journal = historyEntry(before, middle, 'synthetic-first', before.updatedAt)
  const history = historyEntry(middle, after, 'synthetic-second', before.updatedAt)
  const catalogs = [syntheticCatalog('workspace-validation')]
  const state: WorkspaceState = {
    planner: { localData: after, lineage: { rootLocalDataId: before.id }, catalogs, sources: [], evidence: [], history: [history], journal: { version: 1, changes: [], checkpoints: [journal], undoable: true } },
    editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [],
  }
  return { state, catalogs, endpoints: [journal.before, journal.after, history.before, history.after, after] }
}

it.each([false, true])('validates a fixed catalog set once while checking distinct planner endpoints (frozen membership=%s)', frozen => {
  const { state, catalogs, endpoints } = fixture()
  if (frozen) Object.freeze(catalogs)
  const original = structuredClone(state)
  const source = vi.spyOn(sourceFulfillment, 'sourcePayloadValid')
  const endpoint = vi.spyOn(localValidation, 'validateLocalDataForStorage')
  validateWorkspace(state)
  expect(source).toHaveBeenCalledExactlyOnceWith(catalogs[0])
  for (const value of endpoints) expect(endpoint.mock.calls.some(([checked]) => checked === value)).toBe(true)
  expect(state).toEqual(original)
  expect(state.planner.catalogs).toBe(catalogs)
  expect(Object.isFrozen(catalogs)).toBe(frozen)
})

it.each(['shape', 'content', 'duplicate'] as const)('rejects %s catalog failures before granting endpoint reuse', mode => {
  const { state, catalogs } = fixture()
  if (mode === 'shape') (catalogs[0] as unknown as { claims: unknown }).claims = 'invalid'
  if (mode === 'content') catalogs[0] = { ...catalogs[0], importedAt: '2026-02-01T00:00:00.000Z' as CatalogSnapshot['importedAt'] }
  if (mode === 'duplicate') catalogs.push(catalogs[0])
  expect(() => validateWorkspace(state)).toThrow()
})

it.each(['journal-before', 'journal-after', 'history-before', 'history-after', 'current'] as const)('retains semantic validation of the %s endpoint', target => {
  const { state } = fixture()
  const invalid = (value: LocalData): LocalData => ({ ...value, selectedPlaythroughId: 'absent-playthrough' as LocalData['selectedPlaythroughId'] })
  const side = target.endsWith('before') ? 'before' : 'after'
  const planner = target === 'current' ? { ...state.planner, localData: invalid(state.planner.localData) }
    : target.startsWith('journal') ? { ...state.planner, journal: { ...state.planner.journal!, checkpoints: [{ ...state.planner.journal!.checkpoints[0], [side]: invalid(state.planner.journal!.checkpoints[0][side]) }] } }
      : { ...state.planner, history: [{ ...state.planner.history[0], [side]: invalid(state.planner.history[0][side]) }] }
  expect(() => validateWorkspace({ ...state, planner })).toThrow()
})

it('takes new mutable membership on each pass without reusing same-identity altered content', () => {
  const { state, catalogs } = fixture()
  validateWorkspace(state)
  expect(Object.isFrozen(catalogs)).toBe(false)
  catalogs.push(syntheticCatalog('added-membership'))
  const source = vi.spyOn(sourceFulfillment, 'sourcePayloadValid')
  validateWorkspace(state)
  expect(source).toHaveBeenCalledTimes(catalogs.length)
  for (const catalog of catalogs) expect(source).toHaveBeenCalledWith(catalog)
  catalogs[0] = { ...catalogs[0], importedAt: '2026-02-01T00:00:00.000Z' as CatalogSnapshot['importedAt'] }
  expect(() => validateWorkspace(state)).toThrow()
})

it('preserves admitted frozen membership reuse while checking changed operative data', () => {
  const { state, catalogs } = fixture()
  Object.freeze(catalogs)
  validateWorkspace(state)
  const source = vi.spyOn(sourceFulfillment, 'sourcePayloadValid')
  validateWorkspace({ ...state, planner: { ...state.planner, localData: { ...state.planner.localData } } })
  expect(source).not.toHaveBeenCalled()
  expect(() => validateWorkspace({ ...state, planner: { ...state.planner, localData: { ...state.planner.localData, selectedPlaythroughId: 'absent-playthrough' as LocalData['selectedPlaythroughId'] } } })).toThrow()
})

it('does not reinterpret a non-array iterable as persisted catalog membership', () => {
  const { state, catalogs } = fixture()
  expect(() => validateWorkspace({ ...state, planner: { ...state.planner, catalogs: new Set(catalogs) as unknown as CatalogSnapshot[] } })).toThrow()
})
