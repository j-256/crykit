import type Dexie from 'dexie'
import { AppDataError } from '../interchange/errors'

export const GUEST_BARRIER_KEY = 'workspace-write-barrier-v1'
export interface ParticipantBarrier { readonly key: typeof GUEST_BARRIER_KEY; readonly value: string }

export function installGuestWriteBarrier(database: Dexie): void {
  database.use({
    stack: 'dbcore', name: 'workspace-participant-barrier', level: 0,
    create: core => ({
      ...core,
      // Include meta at native transaction creation, covering implicit writes and deletion/cache paths
      transaction: (stores, mode, options) => core.transaction(mode === 'readwrite' ? [...new Set([...stores, 'meta'])] : stores, mode, options),
      table: name => {
        const table = core.table(name)
        return { ...table, mutate: request => {
          const transaction = request.trans as IDBTransaction
          // Layout upgrades precede normal captured participants and may create meta itself
          if (transaction.mode === 'versionchange') return table.mutate(request)
          return core.table('meta').get({ trans: request.trans, key: GUEST_BARRIER_KEY }).then((barrier: ParticipantBarrier | undefined) => {
            if (barrier) throw new AppDataError('revision-conflict', 'This local workspace was retired. Keep your draft and reopen the selected workspace.')
            return table.mutate(request)
          })
        } }
      },
    }),
  })
}

async function changeBarrier(database: Dexie, operationId: string, release: boolean): Promise<void> {
  await database.open()
  await new Promise<void>((resolve, reject) => {
    // Coordinator-owned native writes bypass the participant guard while preserving transaction order
    const transaction = database.backendDB().transaction('meta', 'readwrite')
    let failure: Error | undefined
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Workspace barrier failed'))
    const store = transaction.objectStore('meta'), read = store.get(GUEST_BARRIER_KEY)
    read.onsuccess = () => {
      const current = read.result as ParticipantBarrier | undefined
      if (current && (Object.keys(current).sort().join(',') !== 'key,value' || current.key !== GUEST_BARRIER_KEY || current.value !== operationId)) { failure = new AppDataError('revision-conflict', 'A different workspace operation owns this write barrier.'); transaction.abort(); return }
      // Native request creation can throw before an IDB error event exists
      try {
        if (release) { if (current) store.delete(GUEST_BARRIER_KEY) }
        else store.put({ key: GUEST_BARRIER_KEY, value: operationId } satisfies ParticipantBarrier)
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); transaction.abort() }
    }
  })
}
export function acquireParticipantBarrier(database: Dexie, operationId: string): Promise<void> { return changeBarrier(database, operationId, false) }
export function releaseParticipantBarrier(database: Dexie, operationId: string): Promise<void> { return changeBarrier(database, operationId, true) }
