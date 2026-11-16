import type { GuestCoordinatorDatabase } from '../../src/workspace/guest-coordinator'
import type { createGuestLocalStore } from '../../src/workspace/guest-local-store'
import type { admitLocalRoot, prepareLocalWorkspace } from '../../src/workspace/local-root'
import type { WorkspaceState } from '../../src/workspace/documents'
import type { ChangeEntry } from '../../src/domain/types'

export const MATCHED_STARTER_METHOD = 'baseline-preedit-starter-v1'
export interface StarterApi {
  createGuestLocalStore: typeof createGuestLocalStore
  prepareLocalWorkspace: typeof prepareLocalWorkspace
  admitLocalRoot: typeof admitLocalRoot
  captureGuestWorkspaceEpoch(): { signal: AbortSignal; assertCurrent(): void }
}
export function exactStarterValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && exactStarterValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
export function requirePreeditStarter(state: WorkspaceState, destinationChanges: readonly ChangeEntry[]): void {
  if (!Array.isArray(destinationChanges) || destinationChanges.length || state.planner.localData.changes.length
    || state.planner.history.length || state.planner.sources.length || state.planner.evidence.length
    || Object.hasOwn(state.planner, 'journal') || Object.hasOwn(state.planner, 'savedChanges')
    || state.blobs.length || state.conflicts.length || state.retainedContent.length || state.editorDocuments.length || state.saveDocuments.length || state.assets.length
    || state.planner.localData.revision !== 0) throw new Error('The matched starter is not the admitted pre-edit topology')
}

// This test-only path mirrors fresh initialization with an already admitted immutable starter
// It never restores history or copies a receipt, and the real store owns the absent-head transaction
export async function initializeMatchedStarter(api: StarterApi, database: GuestCoordinatorDatabase, state: WorkspaceState, destinationChanges: readonly ChangeEntry[], signal?: AbortSignal) {
  for (const name of ['createGuestLocalStore', 'prepareLocalWorkspace', 'admitLocalRoot', 'captureGuestWorkspaceEpoch'] as const) {
    if (typeof api[name] !== 'function') throw new Error(`Required starter export unavailable: ${name}`)
  }
  requirePreeditStarter(state, destinationChanges)
  const profile = api.captureGuestWorkspaceEpoch()
  const check = () => { profile.assertCurrent(); if (profile.signal.aborted || signal?.aborted) throw new Error('Matched starter setup cancelled') }
  const lifetime = { check, async assertCurrent() { check() } }
  check()
  if (await database.active.get('active')) throw new Error('Matched starter target is occupied')
  check()
  const id = crypto.randomUUID(), store = api.createGuestLocalStore(database, check)
  const prepared = await api.prepareLocalWorkspace(store.adapter, id, state, lifetime, undefined, undefined, destinationChanges)
  check(); await store.flush(id); check()
  const reader = api.createGuestLocalStore(database, check)
  const admitted = await api.admitLocalRoot(reader.adapter, prepared.head, lifetime)
  check()
  if (!exactStarterValue(admitted.state, state) || !exactStarterValue(admitted.destinationChanges, destinationChanges)) throw new Error('Matched starter durable admission changed')
  const receipt = await store.activate(id, prepared.head, undefined, check)
  check(); await store.assertCurrent(receipt.target); check()
  return { manifest: receipt.target, root: admitted.root, entries: admitted.entries, destinationChanges: admitted.destinationChanges }
}
