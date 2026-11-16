import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema } from '../account/protocol'
import type { AccountDatabase } from '../persistence/account-database'
import type { AccountPreparationReservation } from './account-prepared-records'

export interface AccountPreparationLease extends AccountPreparationReservation { release(): Promise<void> }
const lockName = (accountId: string, operationId: string) => `crykit-account-preparation-v1:${accountId}:${operationId}`
const locks = () => {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('SIGNIN_COORDINATION_UNAVAILABLE')
  return navigator.locks
}

// A granted lock is released by settling its callback, not by aborting its acquisition signal
// Main retains its share until worker termination or acknowledged installation, closing the realm handoff gap
export async function holdAccountPreparation(token: ProfileToken, operationId: string, signal?: AbortSignal): Promise<AccountPreparationLease> {
  assertActiveProfile(token); OpaqueIdSchema.parse(operationId)
  const manager = locks(), pendingSignal = AbortSignal.any([profileSignal(token), ...(signal ? [signal] : [])])
  let resolve!: () => void, granted!: () => void, reject!: (error: unknown) => void
  let live = false
  const held = new Promise<void>(next => { resolve = next })
  const ready = new Promise<void>((yes, no) => { granted = yes; reject = no })
  const done = manager.request(lockName(token.accountId, operationId), { mode: 'shared', signal: pendingSignal }, async lock => {
    if (!lock) throw new Error('SIGNIN_COORDINATION_UNAVAILABLE')
    pendingSignal.throwIfAborted(); assertActiveProfile(token)
    live = true; granted()
    try { await held } finally { live = false }
  })
  void done.catch(reject)
  await ready
  return Object.freeze({ operationId, check() { assertActiveProfile(token); if (!live) throw new Error('SIGNIN_PREPARATION_RELEASED') }, async release() { resolve(); await done } })
}

// Only registered new payloads are eligible; age and a missing journal do not prove abandoned ownership
// Exact row, descriptor exclusion, and chunk removal share one transaction with competing installers
export async function cleanupAccountPreparations(database: AccountDatabase, token: ProfileToken) {
  assertActiveProfile(token)
  if (database.accountId !== token.accountId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
  const manager = locks(), result = { cleaned: 0, active: 0, pending: 0 }
  const operations = await database.preparationPayloads.orderBy('operationId').uniqueKeys()
  for (const value of operations) {
    const parsed = OpaqueIdSchema.safeParse(value)
    if (!parsed.success) { result.pending++; continue }
    const operationId = parsed.data
    assertActiveProfile(token)
    await manager.request(lockName(token.accountId, operationId), { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) { result.active++; return }
      try {
        const cleaned = await database.transaction('rw', database.preparationPayloads, database.stagedCipherChunks, database.encryptedRevisions, async () => {
          assertActiveProfile(token)
          let count = 0
          const rows = await database.preparationPayloads.where('operationId').equals(operationId).toArray()
          for (const row of rows) {
            OpaqueIdSchema.parse(row.payloadId)
            if (row.operationId !== operationId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
            if (!await database.encryptedRevisions.where('payloadId').equals(row.payloadId).count()) {
              await database.stagedCipherChunks.where('payloadId').equals(row.payloadId).delete(); count++
            }
            await database.preparationPayloads.delete([operationId, row.payloadId])
          }
          assertActiveProfile(token)
          return count
        })
        result.cleaned += cleaned
      } catch { result.pending++ }
    })
  }
  return result
}
