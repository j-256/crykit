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
