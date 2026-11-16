import assert from 'node:assert/strict'

export interface OldSyncFailure {
  readonly failed: string
  readonly issues?: readonly { readonly path: unknown; readonly code: string }[]
  readonly cachedCommitResponse?: unknown
}
export type OldSyncTerminal =
  | { readonly kind: 'refused'; readonly failure: OldSyncFailure }
  | { readonly kind: 'returned'; readonly value: unknown }
  | { readonly kind: 'exception'; readonly name: string; readonly message: string }

export class OldSyncRefusal extends Error {
  readonly failure: OldSyncFailure
  constructor(failure: OldSyncFailure) {
    super('Frozen sync refused')
    this.failure = failure
  }
}

export async function captureOldSyncTerminal(run: () => Promise<unknown>): Promise<OldSyncTerminal> {
  try { return { kind: 'returned', value: await run() } }
  catch (error) {
    if (error instanceof OldSyncRefusal) return { kind: 'refused', failure: error.failure }
    return { kind: 'exception', name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) }
  }
}

export function assertOldCompactAdmissionRefusal(terminal: OldSyncTerminal): void {
  assert.equal(terminal.kind, 'refused', 'Old resume must reach strict compact format admission')
  if (terminal.kind !== 'refused') throw new Error('Missing old format admission refusal')
  // The frozen binary's exact schema issues distinguish format refusal from auth, network, or other failures
  // Cached response metadata is diagnostic only; the transport test checks the actual final response separately
  assert.deepEqual({ failed: terminal.failure.failed, issues: terminal.failure.issues }, {
    failed: 'ZodError',
    issues: [{ path: ['version'], code: 'invalid_value' }, { path: [], code: 'unrecognized_keys' }],
  })
}
