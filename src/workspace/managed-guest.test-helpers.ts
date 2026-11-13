import { createBlankLocalData } from '../domain/local-data'
import type { CryKitDatabase } from '../persistence/database'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { prepareLocalWorkspace } from './local-root'

export async function seedBlankManagedGuest(database: CryKitDatabase): Promise<void> {
  const localData = createBlankLocalData()
  const coordinator = new GuestCoordinatorDatabase(`${database.name}-coordinator`)
  try {
    const store = createGuestLocalStore(coordinator, () => {})
    const state = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1 as const, layers: [] } }
    const prepared = await prepareLocalWorkspace(store.adapter, 'fixture', state, { check: () => {}, assertCurrent: async () => {} })
    await store.activate('fixture', prepared.head, undefined, () => {})
  } finally { coordinator.close() }
}

export async function managedGuestBinding(repository: import('./repository').WorkspaceRepository) {
  const { capturedManagedGuestRepository } = await import('./guest-repository')
  const { managedGuestSelection } = await import('./guest-managed-repository')
  const selected = await capturedManagedGuestRepository(repository)
  const binding = selected && managedGuestSelection(selected)
  if (!binding) throw new Error('Expected a managed guest fixture')
  return binding
}

export async function corruptManagedRecord(repository: import('./repository').WorkspaceRepository, key: string) {
  const binding = await managedGuestBinding(repository)
  const { createGuestLocalStore } = await import('./guest-local-store')
  const { admitLocalRoot } = await import('./local-root')
  const store = createGuestLocalStore(binding.coordinator, binding.assertProfile)
  const snapshot = await admitLocalRoot(store.adapter, binding.manifest.root, { check: binding.assertProfile, assertCurrent: () => store.assertCurrent(binding.manifest) })
  const entry = snapshot.entries.find(value => value.key === key)
  if (!entry) throw new Error('Missing managed fixture record')
  const chunks = binding.coordinator.table('managedChunks')
  const chunk = await chunks.get([entry.ref.revisionId, 0])
  if (!chunk?.bytes.length) throw new Error('Missing managed fixture chunk')
  const bytes = new Uint8Array(chunk.bytes)
  bytes[bytes.length - 1] ^= 1
  await chunks.put({ ...chunk, bytes })
  return async () => { await chunks.put(chunk) }
}
