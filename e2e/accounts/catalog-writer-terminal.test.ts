import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOldCompactAdmissionRefusal, captureOldSyncTerminal, OldSyncRefusal } from './catalog-writer-terminal.ts'

const admission = { failed: 'ZodError', issues: [{ path: ['version'], code: 'invalid_value' }, { path: [], code: 'unrecognized_keys' }] }

test('retains and requires the structured old compact admission refusal', async () => {
  const failure = { ...admission, cachedCommitResponse: { status: 503 } }
  const terminal = await captureOldSyncTerminal(async () => { throw new OldSyncRefusal(failure) })
  assert.deepEqual(terminal, { kind: 'refused', failure })
  assert.doesNotThrow(() => assertOldCompactAdmissionRefusal(terminal))
})

for (const failure of [
  { failed: 'UNAUTHORIZED' },
  { failed: 'SERVICE_UNAVAILABLE', cachedCommitResponse: { status: 503 } },
  { failed: 'TypeError' },
  { failed: 'ZodError', issues: [{ path: ['unrelated'], code: 'invalid_value' }, { path: [], code: 'unrecognized_keys' }] },
  { failed: 'ZodError', issues: [{ path: ['version'], code: 'invalid_value' }] },
]) test(`rejects an unrelated or incomplete refusal: ${JSON.stringify(failure)}`, async () => {
  const terminal = await captureOldSyncTerminal(async () => { throw new OldSyncRefusal(failure) })
  assert.throws(() => assertOldCompactAdmissionRefusal(terminal))
})

test('rejects successful resume and unexpected transport exceptions', async () => {
  const returned = await captureOldSyncTerminal(async () => ({ state: 'idle', moreWork: false }))
  assert.deepEqual(returned, { kind: 'returned', value: { state: 'idle', moreWork: false } })
  assert.throws(() => assertOldCompactAdmissionRefusal(returned))
  const exception = await captureOldSyncTerminal(async () => { throw new Error('Synthetic network failure') })
  assert.deepEqual(exception, { kind: 'exception', name: 'Error', message: 'Synthetic network failure' })
  assert.throws(() => assertOldCompactAdmissionRefusal(exception))
})
