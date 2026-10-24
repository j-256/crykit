import { waitForAccountForeground } from '../account/background-work'
import { assertActiveProfile, registerProfileCleanup, type ProfileToken } from '../account/profile'
import { createProfileWorker, type ProfileWorkerLease } from '../account/profile-worker'
import type { AccountDatabase, AccountIntentRecord, AccountFence, CipherRef } from '../persistence/account-database'
import { activateIncrementalMapping, activateIncrementalBaseline, readIncrementalMappedRoot, IncrementalMappingTicketSchema } from './account-local-mapping'

const workers = new WeakMap<ProfileToken, Promise<ProfileWorkerLease>>()
async function workerFor(token: ProfileToken): Promise<ProfileWorkerLease> {
  assertActiveProfile(token)
  let pending = workers.get(token)
  if (!pending) {
    pending = createProfileWorker(token, new Worker(new URL('./account-local-mapping-worker.ts', import.meta.url), { type: 'module' }))
    workers.set(token, pending)
    registerProfileCleanup(token, () => workers.delete(token))
    void pending.catch(() => { if (workers.get(token) === pending) workers.delete(token) })
  }
  return pending
}
export async function mapIncrementalAccountIntent(database: AccountDatabase, token: ProfileToken, input: AccountIntentRecord, signal?: AbortSignal): Promise<void> {
  const row = structuredClone(input), worker = await workerFor(token)
  assertActiveProfile(token)
  try {
    const ticket = IncrementalMappingTicketSchema.parse(await worker.request({ kind: 'map', row }, signal))
    assertActiveProfile(token)
    if (ticket.operationId !== row.id) throw new Error('Mapping response identity changed')
    // Only the original main-profile owner can publish the exact encrypted worker receipt
    // A later foreground save is independent and its selected head is never replaced here
    await activateIncrementalMapping(database, token, ticket, () => waitForAccountForeground(token, signal))
  } catch (error) {
    worker.dispose(); workers.delete(token)
    throw error
  }
}

export async function mapIncrementalAccountBaseline(database: AccountDatabase, token: ProfileToken, input: AccountFence, signal?: AbortSignal): Promise<CipherRef> {
  const fence = structuredClone(input), existing = await readIncrementalMappedRoot(database, token, fence)
  if (existing) return existing
  const worker = await workerFor(token)
  assertActiveProfile(token)
  try {
    const ticket = IncrementalMappingTicketSchema.parse(await worker.request({ kind: 'baseline', fence }, signal))
    assertActiveProfile(token)
    await activateIncrementalBaseline(database, token, ticket, () => waitForAccountForeground(token, signal), fence)
    const mapped = await readIncrementalMappedRoot(database, token, fence)
    if (!mapped) throw new Error('Mapping baseline response changed')
    return mapped
  } catch (error) { worker.dispose(); workers.delete(token); throw error }
}
