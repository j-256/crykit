import { observeBackupJsonWork, type BackupJsonByteCounter } from '../interchange/workspace-backup-json'

const MAX_EVENTS = 128
const STAGES = ['signin', 'chooser', 'review', 'confirm', 'local-open', 'remote-accepted', 'journey', 'waiting-for-sync', 'reading-source', 'opening-account', 'syncing-account', 'checking-account', 'checking-source', 'comparing-records', 'preparing-review', 'preparing-merge'] as const
const OUTCOMES = ['started', 'complete', 'failed', 'cancelled'] as const
const ERROR_CODES = ['quota', 'review-stale', 'source-changed', 'receipt-mismatch', 'offline', 'signin-required', 'cancelled', 'profile-changed', 'account-unavailable', 'saved-copy-review-required', 'replacement-review-required', 'opening-failed', 'preparation-failed', 'unexpected'] as const
export type SigninMergeStage = typeof STAGES[number]
export interface SigninMergeDiagnostic {
  readonly operationId: string
  readonly stage: SigninMergeStage
  readonly outcome: typeof OUTCOMES[number]
  readonly elapsedMs: number
  readonly errorCode?: typeof ERROR_CODES[number]
  // These count codec stream traversal in this realm's observation interval, including repeated passes
  // Objects have no output byte stream, so unobserved stream directions remain absent
  readonly metadata?: Readonly<Partial<Record<BackupJsonByteCounter, number>> & { traversalBytes: number }>
}
type Event = Omit<SigninMergeDiagnostic, 'operationId' | 'metadata' | 'errorCode'> & { readonly errorCode?: string }
let enabled = false
let current: ReturnType<typeof createSigninMergeDiagnostics> | undefined
let stopPrevious: (() => void) | undefined

// Only the synthetic proof entry enables observation; production creates no observer or retained trace
export function enableSigninMergeDiagnostics() { enabled = true; stopPrevious?.(); current = undefined }
export function stopSigninMergeDiagnostics() { enabled = false; stopPrevious?.() }
export function recordSigninMergeBoundary(stage: 'remote-accepted' | 'journey') { current?.record({ stage, outcome: 'complete', elapsedMs: performance.now() - current.startedAt }) }
export function beginSigninMergeDiagnostics() { return enabled ? createSigninMergeDiagnostics() : undefined }
export function readSigninMergeDiagnostics(): readonly SigninMergeDiagnostic[] { return current?.snapshot() ?? [] }
export function createSigninMergeDiagnostics() {
  // Successor operations retire the prior observer before subscribing; late disposal cannot retire the successor
  stopPrevious?.()
  const operationId = crypto.randomUUID(), events: SigninMergeDiagnostic[] = []
  const startedAt = performance.now()
  const metadata: Partial<Record<BackupJsonByteCounter, number>> = {}
  let terminal = false
  const stop = observeBackupJsonWork((counter, bytes) => { metadata[counter] = (metadata[counter] ?? 0) + bytes })
  stopPrevious = stop
  const diagnostics = {
    record(event: Event) {
      if (terminal || !STAGES.includes(event.stage) || !OUTCOMES.includes(event.outcome) || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) return
      const traversalBytes = Object.values(metadata).reduce((sum, value) => sum + value, 0)
      const safe: SigninMergeDiagnostic = { operationId, stage: event.stage, outcome: event.outcome, elapsedMs: event.elapsedMs,
        ...(event.errorCode ? { errorCode: ERROR_CODES.find(code => code === event.errorCode) ?? 'unexpected' } : {}),
        ...(traversalBytes ? { metadata: { ...metadata, traversalBytes } } : {}) }
      events.push(safe)
      if (events.length > MAX_EVENTS) events.shift()
      if (event.outcome === 'failed' || event.outcome === 'cancelled') { terminal = true; stop() }
    },
    snapshot: (): readonly SigninMergeDiagnostic[] => events.map(event => ({ ...event, ...(event.metadata ? { metadata: { ...event.metadata } } : {}) })),
    stop,
    startedAt,
  }
  current = diagnostics
  return diagnostics
}
