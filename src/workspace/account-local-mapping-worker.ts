import { AccountDatabase, type AccountIntentRecord, type AccountFence } from '../persistence/account-database'
import { installProfile, invalidateProfile, assertActiveProfile, type ProfileToken } from '../account/profile'
import { installAccountWorkCheckpoint } from '../account/background-work'
import { assertKey } from '../account/crypto/types'
import { prepareIncrementalMapping, prepareIncrementalBaseline } from './account-local-mapping'

export type AccountMappingWorkerRequest =
  | { kind: 'initialize'; incarnation: string; accountId: string; key: Uint8Array }
  | { kind: 'foreground'; incarnation: string; pending: boolean }
  | { kind: 'map'; incarnation: string; id: string; row: AccountIntentRecord }
  | { kind: 'baseline'; incarnation: string; id: string; fence: AccountFence }
  | { kind: 'cancel'; incarnation: string }

let captured: { incarnation: string; token: ProfileToken; database: AccountDatabase } | undefined
let initialized = false, paused = false, busy = false
const waiting = new Set<() => void>()
const resume = () => { for (const resolve of waiting) resolve(); waiting.clear() }
const MAPPING_SLICE_MS = 4
let lastYield = performance.now()
const checkpoint = async () => {
  // Yield a task, not a microtask, so foreground/cancel messages are observed between bounded IO units
  if (paused || performance.now() - lastYield >= MAPPING_SLICE_MS) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    lastYield = performance.now()
  }
  while (paused && captured) await new Promise<void>(resolve => { waiting.add(resolve) })
  if (!captured) throw new Error('Mapping worker was released')
  assertActiveProfile(captured.token)
}
const cancel = () => {
  const previous = captured
  captured = undefined; paused = false; resume()
  invalidateProfile(); previous?.database.close()
}
self.onmessage = (event: MessageEvent<AccountMappingWorkerRequest>) => {
  const input = event.data
  if (input.kind === 'initialize') {
    // Even a cancelled worker cannot install a successor account or accept a second key
    if (initialized) { input.key.fill(0); cancel(); return }
    initialized = true
    try {
      assertKey(input.key)
      const token = installProfile(input.accountId, input.key.slice())
      captured = { incarnation: input.incarnation, token, database: new AccountDatabase(input.accountId) }
      installAccountWorkCheckpoint(token, checkpoint)
    } catch { cancel(); throw new Error('Account worker initialization failed') }
    finally { input.key.fill(0) }
    return
  }
  const owner = captured
  if (!owner || input.incarnation !== owner.incarnation) return
  if (input.kind === 'cancel') { cancel(); return }
  if (input.kind === 'foreground') { paused = input.pending; if (!paused) resume(); return }
  if (busy) { self.postMessage({ incarnation: owner.incarnation, id: input.id, status: 'failed' }); return }
  busy = true
  void (async () => {
    try {
      await checkpoint()
      const value = input.kind === 'baseline' ? await prepareIncrementalBaseline(owner.database, owner.token, input.fence, checkpoint) : await prepareIncrementalMapping(owner.database, owner.token, input.row, checkpoint)
      assertActiveProfile(owner.token)
      if (captured !== owner) throw new Error('Mapping owner changed')
      self.postMessage({ incarnation: owner.incarnation, id: input.id, status: 'complete', value })
    } catch {
      // Responses contain no private error text, plaintext metadata or source bytes
      if (captured === owner) self.postMessage({ incarnation: owner.incarnation, id: input.id, status: 'failed' })
    } finally { busy = false }
  })()
}
