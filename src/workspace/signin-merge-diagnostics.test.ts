import { BackupJsonReader, encodeBackupJson } from '../interchange/workspace-backup-json'
import { describe, expect, it } from 'vitest'
import { createSigninMergeDiagnostics, readSigninMergeDiagnostics } from './signin-merge-diagnostics'

describe('sign-in merge diagnostics', () => {
  it('retains ordered stage events under one random operation identity', () => {
    const diagnostics = createSigninMergeDiagnostics()
    diagnostics.record({ stage: 'signin', outcome: 'started', elapsedMs: 0 })
    diagnostics.record({ stage: 'chooser', outcome: 'complete', elapsedMs: 12 })
    const events = diagnostics.snapshot()
    expect(events.map(value => value.stage)).toEqual(['signin', 'chooser'])
    expect(events[0].operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[1].operationId).toBe(events[0].operationId)
    expect(createSigninMergeDiagnostics().snapshot()).toEqual([])
  })

  it('bounds retention and preserves a terminal failure against later observer events', () => {
    const diagnostics = createSigninMergeDiagnostics()
    for (let index = 0; index < 150; index++) diagnostics.record({ stage: 'checking-source', outcome: 'started', elapsedMs: index })
    diagnostics.record({ stage: 'review', outcome: 'failed', elapsedMs: 151, errorCode: 'quota' })
    for (let index = 0; index < 150; index++) diagnostics.record({ stage: 'reading-source', outcome: 'started', elapsedMs: 152 + index })
    expect(diagnostics.snapshot()).toHaveLength(128)
    expect(diagnostics.snapshot().at(-1)).toMatchObject({ stage: 'review', outcome: 'failed', errorCode: 'quota' })
  })

  it('copies only safe fields and never serializes arbitrary errors or private content', () => {
    const diagnostics = createSigninMergeDiagnostics()
    diagnostics.record({ stage: 'review', outcome: 'failed', elapsedMs: 1, errorCode: 'password secret private name', error: new Error('credential'), label: 'private label', accountId: 'private account' } as never)
    const serialized = JSON.stringify(diagnostics.snapshot())
    expect(serialized).not.toMatch(/secret|password|credential|private|accountId|label/)
    expect(diagnostics.snapshot()[0].errorCode).toBe('unexpected')
    const snapshot = diagnostics.snapshot()
    ;(snapshot[0] as { elapsedMs: number }).elapsedMs = 999
    expect(diagnostics.snapshot()[0].elapsedMs).toBe(1)
  })

  it('counts actual codec byte work cumulatively and leaves unobserved streams unavailable', () => {
    const diagnostics = createSigninMergeDiagnostics()
    const pages = [...encodeBackupJson({ synthetic: true })]
    const reader = new BackupJsonReader()
    for (const page of pages) reader.consume(page)
    reader.finish()
    diagnostics.record({ stage: 'review', outcome: 'complete', elapsedMs: 1 })
    const bytes = pages.reduce((sum, page) => sum + page.length, 0)
    expect(readSigninMergeDiagnostics()[0].metadata).toEqual({ encodedOutputBytes: bytes, decodedInputBytes: bytes, traversalBytes: bytes * 2 })
    createSigninMergeDiagnostics()
    expect(readSigninMergeDiagnostics()).toEqual([])
  })
})

it('reports optional observation unavailable without exposing arbitrary error text', async () => {
  const { observeSigninMergeReadback } = await import('../../e2e/accounts/signin-helpers')
  const observation = await observeSigninMergeReadback(async () => { throw new Error('Private name password credential') })
  expect(observation).toEqual({ outcome: 'unavailable', errorCode: 'observation-unavailable' })
  expect(JSON.stringify(observation)).not.toMatch(/Private|password|credential/)
  expect(await observeSigninMergeReadback(async () => ({ catalogs: 2 }))).toEqual({ outcome: 'complete', value: { catalogs: 2 } })
})

it('rejects missing and off-phase synthetic paint receipts even when keyboard timing looks fast', async () => {
  const { assessSigninMergeResponsiveness } = await import('../../e2e/accounts/signin-helpers')
  const event = { name: 'keydown', startTime: 10, duration: 16, syntheticTarget: true }
  expect(assessSigninMergeResponsiveness({ paints: [], events: [event], eventTimingAvailable: true })).toMatchObject({ receiptStatus: 'missing', sampledInputToPaint: null, eventTiming: { reason: 'receipt-missing' } })
  const receipt = { requestedAt: 11, handledAt: 12, paintOpportunityAt: 30, elapsedMs: 19, pendingAtInput: false, trusted: true, keydownStartTime: 10 }
  expect(assessSigninMergeResponsiveness({ paints: [receipt], events: [event], eventTimingAvailable: true })).toMatchObject({ receiptStatus: 'off-phase', sampledInputToPaint: null, eventTiming: { reason: 'receipt-off-phase' } })
})

it('associates pending synthetic input only with its own targeted keydown timing without enforcing latency', async () => {
  const { assessSigninMergeResponsiveness } = await import('../../e2e/accounts/signin-helpers')
  const receipt = { requestedAt: 11, handledAt: 12, paintOpportunityAt: 930, elapsedMs: 919, pendingAtInput: true, trusted: true, keydownStartTime: 10 }
  const events = [{ name: 'keydown', startTime: 9, duration: 16, syntheticTarget: true }, { name: 'keydown', startTime: 10, duration: 16, syntheticTarget: false }, { name: 'keyup', startTime: 10, duration: 16, syntheticTarget: true }, { name: 'keydown', startTime: 10, duration: 900, syntheticTarget: true }]
  expect(assessSigninMergeResponsiveness({ paints: [receipt], events, eventTimingAvailable: true })).toEqual({ receiptStatus: 'pending', eventTiming: { status: 'available', durationMs: 900 }, sampledInputToPaint: false })
})

it('distinguishes unsupported timing, absent matching entry, and untrusted input', async () => {
  const { assessSigninMergeResponsiveness } = await import('../../e2e/accounts/signin-helpers')
  const receipt = { requestedAt: 11, handledAt: 12, paintOpportunityAt: 30, elapsedMs: 19, pendingAtInput: true, trusted: true, keydownStartTime: 10 }
  expect(assessSigninMergeResponsiveness({ paints: [receipt], events: [], eventTimingAvailable: false })).toMatchObject({ receiptStatus: 'pending', sampledInputToPaint: null, eventTiming: { reason: 'api-unsupported' } })
  expect(assessSigninMergeResponsiveness({ paints: [receipt], events: [], eventTimingAvailable: true })).toMatchObject({ receiptStatus: 'pending', sampledInputToPaint: null, eventTiming: { reason: 'no-matching-entry' } })
  expect(assessSigninMergeResponsiveness({ paints: [{ ...receipt, trusted: false }], events: [], eventTimingAvailable: true })).toMatchObject({ receiptStatus: 'untrusted', sampledInputToPaint: null, eventTiming: { reason: 'receipt-untrusted' } })
  expect(assessSigninMergeResponsiveness({ paints: [{ ...receipt, keydownStartTime: undefined }], events: [], eventTimingAvailable: true })).toMatchObject({ receiptStatus: 'unassociated', sampledInputToPaint: null, eventTiming: { reason: 'receipt-unassociated' } })
  expect(assessSigninMergeResponsiveness(null)).toMatchObject({ receiptStatus: 'missing', sampledInputToPaint: null, eventTiming: { reason: 'probe-unavailable' } })
})

it('records confirmed merge preparation separately from review computation', () => {
  const diagnostics = createSigninMergeDiagnostics()
  diagnostics.record({ stage: 'review', outcome: 'complete', elapsedMs: 1 })
  diagnostics.record({ stage: 'confirm', outcome: 'started', elapsedMs: 2 })
  diagnostics.record({ stage: 'preparing-merge', outcome: 'started', elapsedMs: 3 })
  expect(diagnostics.snapshot().map(event => event.stage)).toEqual(['review', 'confirm', 'preparing-merge'])
})

it('keeps worker codec work and repeated ciphertext observations separate from main codec counters', () => {
  const diagnostics = createSigninMergeDiagnostics()
  const observer = diagnostics.workerObserver()
  observer.beginRequest(); observer.work({ encodedOutputBytes: 12, decodedInputBytes: 9 }); observer.endRequest()
  diagnostics.ciphertextWork('worker', 3, 40)
  diagnostics.ciphertextWork('main', 3, 40)
  diagnostics.ciphertextWork('main', 1, 10)
  diagnostics.record({ stage: 'preparing-merge', outcome: 'complete', elapsedMs: 1 })
  expect(diagnostics.snapshot()[0]).toMatchObject({ workerMetadata: { encodedOutputBytes: 12, decodedInputBytes: 9, traversalBytes: 21 }, ciphertextObservations: { worker: { records: 3, bytes: 40 }, main: { records: 4, bytes: 50 } } })
  expect(diagnostics.snapshot()[0].metadata).toBeUndefined()
})

it('ignores aggregate worker observations after synthetic diagnostics are stopped', async () => {
  const api = await import('./signin-merge-diagnostics')
  api.enableSigninMergeDiagnostics()
  const diagnostics = api.beginSigninMergeDiagnostics()!
  api.stopSigninMergeDiagnostics()
  api.createSigninMergeWorkerObserver()?.work({ encodedOutputBytes: 99 })
  api.recordSigninMergeCiphertextWork('main', 1, 99)
  api.recordSigninMergeCiphertextFailure('worker')
  diagnostics.record({ stage: 'journey', outcome: 'complete', elapsedMs: 1 })
  expect(diagnostics.snapshot()[0].workerMetadata).toBeUndefined()
  expect(diagnostics.snapshot()[0].ciphertextObservations).toBeUndefined()
})

it('adds every worker attempt while de-duplicating cumulative reports and identifying missing terminal receipts', () => {
  const diagnostics = createSigninMergeDiagnostics()
  const first = diagnostics.workerObserver(), second = diagnostics.workerObserver()
  first.beginRequest(); first.work({ encodedOutputBytes: 12, decodedInputBytes: 9 }); first.endRequest()
  second.beginRequest(); second.work({ encodedOutputBytes: 7, decodedInputBytes: 3 }); second.work({ encodedOutputBytes: 7, decodedInputBytes: 3 }); second.endRequest()
  second.beginRequest(); second.work({ encodedOutputBytes: 11, decodedInputBytes: 8 }); second.endRequest()
  const crashed = diagnostics.workerObserver()
  crashed.beginRequest(); crashed.endRequest()
  diagnostics.record({ stage: 'local-open', outcome: 'complete', elapsedMs: 1 })
  expect(diagnostics.snapshot()[0]).toMatchObject({ workerMetadata: { encodedOutputBytes: 23, decodedInputBytes: 17, traversalBytes: 40 }, workerAccounting: { startedRequests: 4, reportedRequests: 3, incompleteRequests: 1 } })
})

it('binds delayed worker reports to their original observation instead of a successor journey', () => {
  const old = createSigninMergeDiagnostics(), observer = old.workerObserver()
  observer.beginRequest()
  const next = createSigninMergeDiagnostics()
  observer.work({ encodedOutputBytes: 99 }); observer.endRequest()
  next.record({ stage: 'local-open', outcome: 'complete', elapsedMs: 1 })
  expect(next.snapshot()[0].workerMetadata).toBeUndefined()
  expect(next.snapshot()[0].workerAccounting).toBeUndefined()
})

it('retains one strict numeric refusal per active captured request without completing codec accounting', async () => {
  const { SIGNIN_MERGE_LIMITS } = await import('./signin-merge-protocol')
  const value = { dimension: 'observationBytes', value: SIGNIN_MERGE_LIMITS.observationBytes + 17, limit: SIGNIN_MERGE_LIMITS.observationBytes, basis: 'counted-byte-prefix', records: 2 }
  const diagnostics = createSigninMergeDiagnostics(), observer = diagnostics.workerObserver()
  observer.resourceFailure(value)
  diagnostics.record({ stage: 'review', outcome: 'started', elapsedMs: 0 })
  expect(diagnostics.snapshot()[0].resourceFailure).toBeUndefined()
  observer.beginRequest()
  observer.resourceFailure({ ...value, privateId: 'secret' })
  observer.resourceFailure({ ...value, value: Infinity })
  diagnostics.record({ stage: 'review', outcome: 'started', elapsedMs: 1 })
  expect(diagnostics.snapshot().at(-1)?.resourceFailure).toBeUndefined()
  observer.resourceFailure(value)
  observer.resourceFailure({ ...value, value: value.value + 1 })
  observer.work({ encodedOutputBytes: 7 }); observer.endRequest()
  observer.resourceFailure({ ...value, value: value.value + 2 })
  diagnostics.record({ stage: 'review', outcome: 'failed', elapsedMs: 2, errorCode: 'resource-limit' })
  expect(diagnostics.snapshot().at(-1)).toMatchObject({ resourceFailure: value, workerAccounting: { startedRequests: 1, reportedRequests: 1, incompleteRequests: 0 } })
  expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/privateId|secret/)
  const next = createSigninMergeDiagnostics()
  observer.beginRequest(); observer.resourceFailure(value)
  next.record({ stage: 'review', outcome: 'started', elapsedMs: 0 })
  expect(next.snapshot()[0].resourceFailure).toBeUndefined()
  const retired = next.workerObserver(); retired.beginRequest(); next.stop(); retired.resourceFailure(value)
  next.record({ stage: 'review', outcome: 'complete', elapsedMs: 1 })
  expect(next.snapshot().at(-1)?.resourceFailure).toBeUndefined()
})

it('rejects a delayed numeric observation from a nonterminal predecessor collector', async () => {
  const { SIGNIN_MERGE_LIMITS } = await import('./signin-merge-protocol')
  const old = createSigninMergeDiagnostics(), observer = old.workerObserver()
  observer.beginRequest()
  const next = createSigninMergeDiagnostics()
  observer.resourceFailure({ dimension: 'records', value: SIGNIN_MERGE_LIMITS.records + 1, limit: SIGNIN_MERGE_LIMITS.records, basis: 'record-cardinality' })
  old.record({ stage: 'review', outcome: 'complete', elapsedMs: 1 })
  next.record({ stage: 'review', outcome: 'complete', elapsedMs: 1 })
  expect(old.snapshot()[0].resourceFailure).toBeUndefined()
  expect(next.snapshot()[0].resourceFailure).toBeUndefined()
})

it('reads active work without recording a boundary or moving a late completion to its successor', async () => {
  const api = await import('./signin-merge-diagnostics')
  api.enableSigninMergeDiagnostics()
  try {
    const old = api.beginSigninMergeDiagnostics()!
    let resolve!: () => void
    const operation = new Promise<void>(accept => { resolve = accept })
    const pending = api.observeSigninSyncWork('capture-local', () => operation)
    expect(pending).toBe(operation)
    const worker = old.workerObserver()
    worker.beginRequest()
    const live = api.readLiveSigninSyncDiagnostics()
    expect(live).toMatchObject({ state: 'observing', activeWorkerRequests: 1, activeUnreportedWorkerRequests: 1, spans: [{ label: 'capture-local', activeAgeMs: expect.any(Number) }] })
    expect(live).not.toHaveProperty('workerMetadata')
    expect(old.snapshot()).toEqual([])
    worker.work({ decodedInputBytes: 17 }); worker.endRequest()
    expect(api.readLiveSigninSyncDiagnostics()).toMatchObject({ activeWorkerRequests: 0, activeUnreportedWorkerRequests: 0, workerMetadata: { decodedInputBytes: 17, traversalBytes: 17 } })
    api.beginSigninMergeDiagnostics()
    resolve(); await pending
    expect(old.live()).toMatchObject({ state: 'stopped' })
    expect(api.readLiveSigninSyncDiagnostics()).toMatchObject({ spans: [], activeWorkerRequests: 0 })
    expect(api.readSigninMergeDiagnostics()).toEqual([])
  } finally { api.stopSigninMergeDiagnostics() }
})

it('bounds span history and reports settled work without changing its rejection', async () => {
  const api = await import('./signin-merge-diagnostics')
  api.enableSigninMergeDiagnostics()
  try {
    api.beginSigninMergeDiagnostics()
    for (let i = 0; i < 65; i++) await api.observeSigninSyncWork('sync-iteration', () => Promise.resolve())
    const reason = new Error('rejected mapping')
    await expect(api.observeSigninSyncWork('map-request', () => Promise.reject(reason))).rejects.toBe(reason)
    const live = api.readLiveSigninSyncDiagnostics()
    expect(live?.state).toBe('observing')
    if (live?.state !== 'observing') throw new Error('Missing observation')
    expect(live.spans).toHaveLength(64)
    expect(live.evictedCompleted).toBe(2)
    expect(live.omittedStarts).toBe(0)
    expect(live.spans.at(-1)).toMatchObject({ label: 'map-request', outcome: 'failed', endMs: expect.any(Number) })
    expect(api.readSigninMergeDiagnostics()).toEqual([])
  } finally { api.stopSigninMergeDiagnostics() }
})
