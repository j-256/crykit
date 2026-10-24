import { isRequiredPlannerNativeVersionError, assertRequiredPlannerDatabaseOpen, captureRequiredPlannerOpeningError, CryKitDatabase } from '../persistence/database'

interface RequiredPlannerOpeningOwner {
  readonly signal: AbortSignal
  assertCurrent(): undefined
}

type OpeningOutcome =
  | { readonly kind: 'opened' }
  | { readonly kind: 'open-failed'; readonly error: unknown }
  | { readonly kind: 'aborted'; readonly reason: unknown }

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new DOMException('Required planner opening cancelled', 'AbortError') : signal.reason
}

export async function openRequiredGuestPlanner(name: string, owner: RequiredPlannerOpeningOwner, frozenSource240 = false): Promise<CryKitDatabase> {
  const signal = owner.signal
  const assertCurrent = owner.assertCurrent.bind(owner)
  const assertOwner = () => {
    if (signal.aborted) throw cancellationReason(signal)
    const result: unknown = assertCurrent()
    if (result !== undefined) {
      // A caller's asynchronous check cannot authorize opening; observe its rejection without awaiting it
      void Promise.resolve(result).catch(() => {})
      throw new TypeError('Required planner opening owner must assert currentness synchronously')
    }
    if (signal.aborted) throw cancellationReason(signal)
  }
  assertOwner()

  // Keep this fresh handle private until open, owner currentness and native admission all succeed
  const candidate = new CryKitDatabase(name, { plannerFormatRequirement: 'journaled', ...(frozenSource240 ? { frozenSource240: true } : {}) })
  const normalizeOpeningError = captureRequiredPlannerOpeningError(candidate)
  const cleanupFailures: unknown[] = []
  let resolveAbort!: (outcome: OpeningOutcome) => void
  const abortOutcome = new Promise<OpeningOutcome>(resolve => { resolveAbort = resolve })
  const onAbort = () => {
    resolveAbort({ kind: 'aborted', reason: cancellationReason(signal) })
    try { candidate.close() } catch (error) { cleanupFailures.push(error) }
  }
  let listenerRegistered = false
  try {
    signal.addEventListener('abort', onAbort, { once: true })
    listenerRegistered = true
    assertOwner()
    const openOutcome: Promise<OpeningOutcome> = (() => {
      try {
        return candidate.open().then(
          () => ({ kind: 'opened' as const }),
          error => ({ kind: 'open-failed' as const, error }),
        )
      } catch (error) { return Promise.resolve({ kind: 'open-failed', error }) }
    })()
    const outcome = await Promise.race([openOutcome, abortOutcome])
    if (outcome.kind === 'aborted') throw outcome.reason
    if (outcome.kind === 'open-failed') {
      const diagnosis = normalizeOpeningError(outcome.error)
      if (diagnosis) throw diagnosis
      assertOwner()
      throw outcome.error
    }
    assertOwner()
    signal.removeEventListener('abort', onAbort)
    listenerRegistered = false
    // No awaited work or caller callback may intervene between this assertion and transfer
    assertRequiredPlannerDatabaseOpen(candidate)
    return candidate
  } catch (primary) {
    if (listenerRegistered) signal.removeEventListener('abort', onAbort)
    // A failed required handle is terminal; retries need a newly constructed candidate
    try { candidate.close() } catch (error) { cleanupFailures.push(error) }
    if (cleanupFailures.length) throw new AggregateError([primary, ...cleanupFailures], 'Required planner opening cleanup failed', { cause: primary })
    if (isRequiredPlannerNativeVersionError(candidate, primary) && primary !== null && typeof primary === 'object') nativeVersionErrors.add(primary)
    throw primary
  }
}

const nativeVersionErrors = new WeakSet<object>()
export async function openSelectedGuestPlanner(name: string, owner: RequiredPlannerOpeningOwner): Promise<CryKitDatabase> {
  try { return await openRequiredGuestPlanner(name, owner, true) }
  catch (error) {
    // Only the actual native VersionError permits trying the other closed supported layout
    if (error === null || typeof error !== 'object' || !nativeVersionErrors.has(error)) throw error
    return openRequiredGuestPlanner(name, owner)
  }
}
