import type { scanCleanupCandidates, previewAccountCleanup, executeAccountCleanup } from './cleanup'
import type { z } from 'zod'
import { StorageObservationSchema, ServiceRecoverySchema } from './storage-protocol'
import { accountRequest } from './auth-client'
import { assertActiveProfile, profileSignal, withProfileSession, type ProfileToken } from './profile'
import { removeProfileFromDevice } from './lifecycle'
import { AccountDatabase } from '../persistence/account-database'
import type { WorkspaceRepository } from '../workspace/repository'

export const STORAGE_WARNING_FRACTION = 0.8
export interface LocalStorageObservation { readonly observedAt: number; readonly pendingWork: boolean; readonly contentBytes: number; readonly categories: readonly { readonly label: string; readonly count: number }[] }
export interface DeviceRemoval { readonly pendingWork: boolean; remove(): Promise<void> }
export interface StorageService {
  scanCleanup?(after?: string): ReturnType<typeof scanCleanupCandidates>
  previewCleanup?(candidate: import('./cleanup').CleanupCandidate): ReturnType<typeof previewAccountCleanup>
  cleanup?(preview: import('./storage-protocol').CleanupPreview): ReturnType<typeof executeAccountCleanup>
  local(): Promise<LocalStorageObservation>
  remote(): Promise<z.infer<typeof StorageObservationSchema>>
  recovery(): Promise<z.infer<typeof ServiceRecoverySchema>>
  backup(): Promise<void>
  prepareRemoval(): Promise<DeviceRemoval>
}
export function createStorageService(token: ProfileToken, repository: WorkspaceRepository, backup: () => Promise<void>, assertMayRemove: () => void): StorageService {
  const check = () => { assertActiveProfile(token); if (repository.kind !== 'account') throw new Error('Account workspace required') }
  async function capture() {
    check()
    const database = new AccountDatabase(token.accountId)
    try {
      const value = await database.transaction('r', database.profileMeta, database.outbox, database.syncState, async () => ({ fence: await database.profileMeta.get('active'), pendingWork: await database.outbox.count() > 0 || !!await database.syncState.get('publication') }))
      check(); return value
    } finally { database.close() }
  }
  return {
    // Optional storage actions load planner code on use; each implementation checks the captured profile before access
    scanCleanup: async after => (await import('./cleanup')).scanCleanupCandidates(token, after),
    previewCleanup: async candidate => (await import('./cleanup')).previewAccountCleanup(token, candidate),
    cleanup: async preview => (await import('./cleanup')).executeAccountCleanup(token, preview),
    async local() {
      check()
      // Category labels and counts come only from the captured decrypted workspace
      const state = await repository.readWorkspace(), local = await capture()
      check()
      return { observedAt: Date.now(), pendingWork: local.pendingWork, contentBytes: state.blobs.reduce((total, blob) => total + blob.ref.byteLength, 0), categories: [
        { label: 'Editor files', count: state.editorDocuments.length }, { label: 'Save files', count: state.saveDocuments.length },
        { label: 'Source originals', count: state.planner.sources.length }, { label: 'Retained file versions', count: state.retainedContent.length },
        { label: 'Planner history', count: state.planner.history.length }, { label: 'Conflicts', count: state.conflicts.length },
      ] }
    },
    remote: () => withProfileSession(token, session => accountRequest('account/storage', undefined, StorageObservationSchema, session.csrf, 'GET', profileSignal(token))),
    recovery: () => withProfileSession(token, session => accountRequest('account/recovery', undefined, ServiceRecoverySchema, session.csrf, 'GET', profileSignal(token))),
    async backup() { check(); await backup(); check() },
    async prepareRemoval() {
      check(); assertMayRemove()
      const reviewed = await capture()
      check(); assertMayRemove()
      if (!reviewed.fence) throw new Error('Saved account data is unavailable')
      return { pendingWork: reviewed.pendingWork, async remove() {
        check(); assertMayRemove()
        // The transaction rechecks the reviewed local fence and open-draft owner before clearing
        await removeProfileFromDevice(token, { pendingWork: reviewed.pendingWork, exportBackup: backup, removeEncryptedData: async () => (await import('../workspace/account-repository')).removeEncryptedAccountData(token, reviewed.fence, assertMayRemove) }, { confirmed: true, recovery: 'discard' })
      } }
    },
  }
}
