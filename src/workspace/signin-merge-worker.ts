import { observeBackupJsonWork, type BackupJsonByteCounter } from '../interchange/workspace-backup-json'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile, assertActiveProfile, type ProfileToken } from '../account/profile'
import { installAccountWorkCheckpoint } from '../account/background-work'
import { assertKey } from '../account/crypto/types'
import { OpaqueIdSchema } from '../account/protocol'
import { createSigninMergePreparation } from './signin-merge-preparation'
import { signinMergeResourceFailure, SIGNIN_MERGE_ERRORS, SigninMergeLocatorSchema, SigninMergeFenceSchema, type SigninMergeCommand, type SigninMergeProgress } from './signin-merge-protocol'

type Envelope = SigninMergeCommand & { incarnation: string; id: string }
type Request = Envelope | { kind: 'initialize'; incarnation: string; accountId: string; key: Uint8Array; diagnostics?: true } | { kind: 'foreground'; incarnation: string; pending: boolean } | { kind: 'cancel'; incarnation: string }
let captured: { incarnation: string; token: ProfileToken; database: AccountDatabase } | undefined
let preparation: Awaited<ReturnType<typeof createSigninMergePreparation>> | undefined
let operationId: string | undefined
let reportProgress: ((value: SigninMergeProgress) => void) | undefined
const codec: Partial<Record<BackupJsonByteCounter, number>> = {}
let stopCodec: (() => void) | undefined
let initialized = false, busy = false, paused = false
const waiting = new Set<() => void>(), SLICE_MS = 4
let lastYield = performance.now()
const resume = () => { for (const resolve of waiting) resolve(); waiting.clear() }
const checkpoint = async () => {
  if (paused || performance.now() - lastYield >= SLICE_MS) { await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now() }
  while (paused && captured) await new Promise<void>(resolve => waiting.add(resolve))
  if (!captured || !captured.database.isOpen()) throw new Error('SIGNIN_PREPARATION_FAILED')
  assertActiveProfile(captured.token)
}
const cancel = () => {
  const owner = captured
  captured = undefined; stopCodec?.(); paused = false; resume(); invalidateProfile()
  void preparation?.dispose().finally(() => owner?.database.close()).catch(() => {})
  owner?.database.close()
}
self.onmessageerror = cancel
self.onmessage = (event: MessageEvent<Request>) => {
  const input = event.data
  if (input.kind === 'initialize') {
    if (initialized) { input.key.fill(0); cancel(); return }
    initialized = true
    void (async () => {
      try {
        assertKey(input.key)
        const token = installProfile(input.accountId, input.key.slice()), database = new AccountDatabase(input.accountId, { existingOnly: true })
        captured = { incarnation: input.incarnation, token, database }
        input.key.fill(0)
        await database.open(); assertActiveProfile(token)
        installAccountWorkCheckpoint(token, checkpoint)
        if (input.diagnostics === true) stopCodec = observeBackupJsonWork((key, bytes) => { codec[key] = (codec[key] ?? 0) + bytes })
        self.postMessage({ incarnation: input.incarnation, status: 'ready' })
      } catch { self.postMessage({ incarnation: input.incarnation, status: 'failed', code: 'SIGNIN_PREPARATION_FAILED' }); cancel() }
      finally { input.key.fill(0) }
    })()
    return
  }
  const owner = captured
  if (!owner || input.incarnation !== owner.incarnation) return
  if (input.kind === 'cancel') { cancel(); return }
  if (input.kind === 'foreground') { paused = input.pending; if (!paused) resume(); return }
  const reply = (status: 'complete' | 'progress' | 'failed', value?: unknown, code?: string) => {
    if (status !== 'progress' && stopCodec && captured === owner) self.postMessage({ incarnation: owner.incarnation, id: input.id, operationId: input.operationId, status: 'progress', value: { stage: input.kind === 'review' ? 'comparing-records' : 'preparing-merge', codec: { ...codec } } })
    if (status === 'progress' && !stopCodec && value && typeof value === 'object') value = { stage: (value as { stage: string }).stage }
    if (captured === owner) self.postMessage({ incarnation: owner.incarnation, id: input.id, operationId: input.operationId, status, ...(value === undefined ? {} : { value }), ...(code ? { code } : {}) })
  }
  if (busy) { reply('failed', undefined, 'SIGNIN_PREPARATION_FAILED'); return }
  busy = true
  // The retained preparation owner spans requests, but progress belongs only to the active request
  reportProgress = value => reply('progress', value)
  void (async () => {
    try {
      OpaqueIdSchema.parse(input.operationId); await checkpoint()
      if (input.kind === 'review') {
        if (preparation || operationId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        operationId = input.operationId
        preparation = await createSigninMergePreparation(owner.database, owner.token, operationId, SigninMergeLocatorSchema.parse(input.locator), SigninMergeFenceSchema.parse(input.fence), value => reportProgress?.(value))
        reply('complete', { handle: preparation.handle, preview: preparation.preview })
      } else {
        if (!preparation || input.operationId !== operationId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        if (input.kind === 'prepare') reply('complete', await preparation.prepare(input.handle))
        else { await preparation.dispose(); preparation = undefined; reply('complete', null) }
      }
    } catch (error) {
      // Main cleans registered inert payloads after this reply; worker termination alone does
      // not acknowledge release of the worker's shared lease before that nonwaiting cleanup
      // Retire authority before awaiting disposal so cancellation cannot dispose it twice
      const failed = preparation
      preparation = undefined
      try { await failed?.dispose() }
      catch { /* Keep the original failure; the main registry cleaner still requires exclusive ownership */ }
      // Optional observation is request-bound and cannot replace the actual terminal failure
      if (stopCodec && captured === owner) try {
        const resourceFailure = signinMergeResourceFailure(error)
        if (resourceFailure) reply('progress', { stage: input.kind === 'review' ? 'comparing-records' : 'preparing-merge', resourceFailure })
      } catch { /* Diagnostic delivery is best effort; the original failure still terminates the request */ }
      // Only fixed public codes cross the boundary; errors may contain private source values
      const code = error instanceof Error && SIGNIN_MERGE_ERRORS.find(value => value === error.message)
      reply('failed', undefined, code || 'SIGNIN_PREPARATION_FAILED')
    } finally { reportProgress = undefined; busy = false }
  })()
}
