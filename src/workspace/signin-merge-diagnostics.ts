import { observeBackupJsonWork, type BackupJsonByteCounter } from '../interchange/workspace-backup-json'

const MAX_EVENTS = 128
const STAGES = ['signin', 'chooser', 'review', 'confirm', 'local-open', 'remote-accepted', 'journey', 'waiting-for-sync', 'reading-source', 'opening-account', 'syncing-account', 'checking-account', 'checking-source', 'comparing-records', 'preparing-review', 'preparing-merge', 'preparing-mapping'] as const
const OUTCOMES = ['started', 'complete', 'failed', 'cancelled'] as const
const ERROR_CODES = ['quota', 'review-stale', 'source-changed', 'receipt-mismatch', 'offline', 'signin-required', 'cancelled', 'profile-changed', 'account-unavailable', 'saved-copy-review-required', 'replacement-review-required', 'opening-failed', 'preparation-failed', 'resource-limit', 'coordination-unavailable', 'unexpected'] as const
export type SigninMergeStage = typeof STAGES[number]
export interface SigninMergeDiagnostic {
  readonly operationId: string
  readonly stage: SigninMergeStage
  readonly outcome: typeof OUTCOMES[number]
  readonly elapsedMs: number
  readonly errorCode?: typeof ERROR_CODES[number]
  // These count codec stream traversal in this realm's observation interval, including repeated passes
  // Objects have no output byte stream, so unobserved stream directions remain absent
  readonly workerMetadata?: Readonly<Partial<Record<BackupJsonByteCounter, number>> & { traversalBytes: number }>
  readonly workerAccounting?: Readonly<{ startedRequests: number; reportedRequests: number; incompleteRequests: number }>
  readonly ciphertextObservations?: Readonly<Partial<Record<'worker' | 'main', { records: number; bytes: number; completedPasses: number; failedPasses: number }>>>
  readonly metadata?: Readonly<Partial<Record<BackupJsonByteCounter, number>> & { traversalBytes: number }>
}
type Event = Omit<SigninMergeDiagnostic, 'operationId' | 'metadata' | 'workerMetadata' | 'ciphertextObservations' | 'workerAccounting' | 'errorCode'> & { readonly errorCode?: string }
let enabled = false
let current: ReturnType<typeof createSigninMergeDiagnostics> | undefined
let stopPrevious: (() => void) | undefined

// Only the synthetic proof entry enables observation; production creates no observer or retained trace
export function enableSigninMergeDiagnostics() { enabled = true; stopPrevious?.(); current = undefined }
export function stopSigninMergeDiagnostics() { enabled = false; stopPrevious?.() }
export function recordSigninMergeBoundary(stage: 'remote-accepted' | 'journey') { current?.record({ stage, outcome: 'complete', elapsedMs: performance.now() - current.startedAt }) }
export const signinMergeDiagnosticsEnabled = () => enabled
export function createSigninMergeWorkerObserver() { return enabled ? current?.workerObserver() : undefined }
export function recordSigninMergeCiphertextWork(realm: 'worker' | 'main', records: number, bytes: number) { if (enabled) current?.ciphertextWork(realm, records, bytes) }
export function recordSigninMergeCiphertextFailure(realm: 'worker' | 'main') { if (enabled) current?.ciphertextFailure(realm) }
export function beginSigninMergeDiagnostics() { return enabled ? createSigninMergeDiagnostics() : undefined }
export function readSigninMergeDiagnostics(): readonly SigninMergeDiagnostic[] { return current?.snapshot() ?? [] }
export function createSigninMergeDiagnostics() {
  // Successor operations retire the prior observer before subscribing; late disposal cannot retire the successor
  stopPrevious?.()
  const operationId = crypto.randomUUID(), events: SigninMergeDiagnostic[] = []
  const startedAt = performance.now()
  const metadata: Partial<Record<BackupJsonByteCounter, number>> = {}
  let terminal = false
  const workerMetadata: Partial<Record<BackupJsonByteCounter, number>> = {}
  let workerAccounting: { startedRequests: number; reportedRequests: number; incompleteRequests: number } | undefined
  const ciphertextObservations: Partial<Record<'worker' | 'main', { records: number; bytes: number; completedPasses: number; failedPasses: number }>> = {}
  const stop = observeBackupJsonWork((counter, bytes) => { metadata[counter] = (metadata[counter] ?? 0) + bytes })
  stopPrevious = stop
  const diagnostics = {
    workerObserver() {
      workerAccounting ??= { startedRequests: 0, reportedRequests: 0, incompleteRequests: 0 }
      const accounting = workerAccounting, previous: Partial<Record<BackupJsonByteCounter, number>> = {}
      let active = false, reported = false, invalid = false
      return {
        beginRequest() { if (terminal || active) return; active = true; reported = false; invalid = false; accounting.startedRequests++ },
        work(value: Partial<Record<BackupJsonByteCounter, number>>) {
          if (terminal || !active) return
          // Reports are cumulative within one worker, including terminal failure reports
          // A retry owns a fresh collector so its smaller counters still contribute every byte
          for (const key of ['encodedOutputBytes', 'decodedInputBytes'] as const) {
            const count = value[key] ?? previous[key] ?? 0
            if (!Number.isSafeInteger(count) || count < (previous[key] ?? 0) || !Number.isSafeInteger((workerMetadata[key] ?? 0) + count - (previous[key] ?? 0))) { invalid = true; return }
          }
          for (const key of ['encodedOutputBytes', 'decodedInputBytes'] as const) if (value[key] !== undefined) {
            workerMetadata[key] = (workerMetadata[key] ?? 0) + value[key]! - (previous[key] ?? 0)
            previous[key] = value[key]
          }
          if (!reported) { reported = true; accounting.reportedRequests++ }
        },
        endRequest() {
          if (!active) return
          active = false
          // A crashed or cancelled worker cannot claim zero unreported codec work
          if (!reported || invalid) accounting.incompleteRequests++
        },
      }
    },
    ciphertextWork(realm: 'worker' | 'main', records: number, bytes: number) {
      if (terminal || !Number.isSafeInteger(records) || records < 0 || !Number.isSafeInteger(bytes) || bytes < 0) return
      const prior = ciphertextObservations[realm] ?? { records: 0, bytes: 0, completedPasses: 0, failedPasses: 0 }
      ciphertextObservations[realm] = { records: prior.records + records, bytes: prior.bytes + bytes, completedPasses: prior.completedPasses + 1, failedPasses: prior.failedPasses }
    },
    ciphertextFailure(realm: 'worker' | 'main') {
      if (terminal) return
      const prior = ciphertextObservations[realm] ?? { records: 0, bytes: 0, completedPasses: 0, failedPasses: 0 }
      ciphertextObservations[realm] = { ...prior, failedPasses: prior.failedPasses + 1 }
    },
    record(event: Event) {
      if (terminal || !STAGES.includes(event.stage) || !OUTCOMES.includes(event.outcome) || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) return
      const traversalBytes = Object.values(metadata).reduce((sum, value) => sum + value, 0)
      const safe: SigninMergeDiagnostic = { operationId, stage: event.stage, outcome: event.outcome, elapsedMs: event.elapsedMs,
        ...(event.errorCode ? { errorCode: ERROR_CODES.find(code => code === event.errorCode) ?? 'unexpected' } : {}),
        ...(traversalBytes ? { metadata: { ...metadata, traversalBytes } } : {}),
        ...(Object.keys(workerMetadata).length ? { workerMetadata: { ...workerMetadata, traversalBytes: Object.values(workerMetadata).reduce((sum, value) => sum + value, 0) } } : {}),
        ...(workerAccounting ? { workerAccounting: { ...workerAccounting } } : {}),
        ...(Object.keys(ciphertextObservations).length ? { ciphertextObservations: structuredClone(ciphertextObservations) } : {}) }
      events.push(safe)
      if (events.length > MAX_EVENTS) events.shift()
      if (event.outcome === 'failed' || event.outcome === 'cancelled') { terminal = true; stop() }
    },
    snapshot: (): readonly SigninMergeDiagnostic[] => structuredClone(events),
    stop,
    startedAt,
  }
  current = diagnostics
  return diagnostics
}
