import { expect, it } from 'vitest'
import { diagnosticEvents, requestDiagnostic, safeLimitDiagnostic } from './diagnostics'

const startedAt = Date.UTC(2026, 9, 21)
function trace(extra: Partial<TraceItem> = {}): TraceItem {
  return { event: null, eventTimestamp: startedAt, logs: [], exceptions: [], diagnosticsChannelEvents: [], scriptName: 'producer', outcome: 'ok', executionModel: 'stateless', truncated: false, cpuTime: 1, wallTime: 1, ...extra }
}

it.each([
  ['/api/public/v1/shares/private-id?capability=private', '/api/public/v1/shares/:shareId'],
  ['/api/v1/sync/uploads/private-id/chunks/3?private', '/api/v1/sync/uploads/:uploadId/chunks/:index'],
  ['/api/v1/auth/login/start?private', '/api/v1/auth/login/start'],
  ['/api/v1/account/transactions/private-id', '/api/v1/account/transactions/:transactionId'],
  ['/api/admin/v1/private-id?private', '/api/admin/v1/:operation'],
  ['/admin/confirm/private-id?private', '/admin/:page'],
  ['/api/v1/auth/private-id?private', 'unmatched'],
])('redactsRequestValuesFrom%s', (path, route) => {
  expect(requestDiagnostic(new Request(`https://example.test${path}`))).toEqual({ route, method: 'GET' })
})

it('dropsMalformedOrPrivateDiagnosticDetailsRatherThanStringifyingThem', () => {
  expect(safeLimitDiagnostic({ route: 'https://example.test/private', method: 'private', limiter: 'https://example.test', scope: 'private', counter: 'private', limit: -1, observedCount: Infinity, windowMs: 'private', retryAfterSeconds: 60, password: 'private' })).toEqual({ retryAfterSeconds: 60 })
})

it('forwardsOnlyValidatedFieldsAndSourceProvenance', () => {
  const privateValue = 'synthetic-private'
  const event = trace({
    scriptVersion: { id: '4eb2f6ab-35a7-42ac-9287-47e5545d57cb' },
    event: { request: { url: `https://example.test/?capability=${privateValue}`, method: 'GET', headers: { authorization: privateValue }, getUnredacted() { return this } }, response: { status: 503 } },
    logs: [{ timestamp: startedAt, level: 'log', message: [JSON.stringify({ operation: 'sync', stage: 'commit', code: 'SERVICE_UNAVAILABLE', requestId: 'opaque-reference', mutationId: 'opaque-mutation', durationMs: 12, body: privateValue, error: privateValue, request: { url: privateValue }, route: privateValue })] }],
  })
  const output = diagnosticEvents([event, trace({ ...event, scriptName: 'unrelated' })], 'producer')
  expect(output).toEqual([{ operation: 'sync', stage: 'commit', code: 'SERVICE_UNAVAILABLE', requestId: 'opaque-reference', mutationId: 'opaque-mutation', durationMs: 12, occurredAt: startedAt, sourceWorker: 'producer', sourceVersionId: '4eb2f6ab-35a7-42ac-9287-47e5545d57cb' }])
  expect(JSON.stringify(output)).not.toContain(privateValue)
})

it('retainsContentFreeRuntimeFailuresWithoutRawExceptionMessages', () => {
  const output = diagnosticEvents([trace({ outcome: 'exception', exceptions: [{ name: 'Error', message: 'synthetic-private', timestamp: startedAt }] })], 'producer')
  expect(output).toEqual([{ operation: 'runtime', stage: 'execution', code: 'WORKER_FAILURE', occurredAt: startedAt, sourceWorker: 'producer' }])
})
