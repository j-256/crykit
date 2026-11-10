import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { createQualificationBudget, reserveQualificationWork, finishQualificationWork, readQualificationBudget } from './budget.mjs'

const NOW = Date.UTC(2026, 10, 10, 12)
const DAY = 24 * 60 * 60 * 1000
const costs = patch => ({ operations: 1, opaquePairs: 0, emailAttempts: 0, ciphertextBytes: 0, revisions: 0, loadMs: 0, d1RowsRead: 0, d1RowsWritten: 0, r2ClassA: 0, r2ClassB: 0, d1MetadataBytes: 0, d1RestoreBytes: 0, r2Bytes: 0, sourceContextBytes: 0, restoreContextBytes: 0, ...patch })
const request = (id, patch = {}) => ({ id, clientId: 'client-1', accountId: null, emailRecipients: [], costs: costs(), ...patch })
const email = count => ({ costs: costs({ emailAttempts: count }), emailRecipients: [`synthetic@${'crykit.lasers.app'}`] })
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-controller-budget-'))
  const path = join(directory, 'budget.sqlite')
  try { await createQualificationBudget(path, 'synthetic-run', NOW); await work(path, directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

// Every cost dimension must be declared; omitted costs must not silently become free work
test('requires known nonnegative integer costs and a known versioned run', async () => fixture(async path => {
  const before = await readQualificationBudget(path)
  for (const patch of [{ costs: {} }, { costs: costs({ operations: null }) }, { costs: costs({ d1RowsRead: -1 }) }, { costs: costs({ r2ClassA: 0.5 }) }, { costs: costs({ unknown: 1 }) }, { extra: true }]) {
    await assert.rejects(reserveQualificationWork(path, request('bad', patch), NOW))
  }
  assert.deepEqual(await readQualificationBudget(path), before)
  await assert.rejects(createQualificationBudget(path, 'replacement-run', NOW))
}))

test('commits a reservation before acceptance and never dispatches a replayed ID', async () => fixture(async path => {
  const input = request('once', { ...email(2) })
  assert.equal((await reserveQualificationWork(path, input, NOW)).dispatchAllowed, true)
  assert.equal((await readQualificationBudget(path)).total.emailAttempts, 2)
  assert.equal((await reserveQualificationWork(path, input, NOW)).dispatchAllowed, false)
  await assert.rejects(reserveQualificationWork(path, request('once', email(3)), NOW))
  await finishQualificationWork(path, 'once', 'uncertain', NOW)
  assert.equal((await reserveQualificationWork(path, input, NOW)).dispatchAllowed, false)
  assert.equal((await readQualificationBudget(path)).total.emailAttempts, 2)
}))

test('retains failed and uncertain mail across UTC days and rejects invalid recipients', async () => fixture(async path => {
  for (const recipients of [[], ['outside@example.org']]) await assert.rejects(reserveQualificationWork(path, request('invalid', { ...email(1), emailRecipients: recipients }), NOW))
  await reserveQualificationWork(path, request('first', email(20)), NOW)
  await finishQualificationWork(path, 'first', 'uncertain', NOW)
  await assert.rejects(reserveQualificationWork(path, request('over-day', email(1)), NOW + 61_000))
  for (const [i, attempts] of [[1, 20], [2, 10]]) {
    await reserveQualificationWork(path, request(`day-${i}`, email(attempts)), NOW + i * DAY)
    await finishQualificationWork(path, `day-${i}`, 'failed', NOW + i * DAY)
  }
  await assert.rejects(reserveQualificationWork(path, request('over-total', email(1)), NOW + 3 * DAY))
  const retained = await readQualificationBudget(path)
  assert.equal(retained.total.emailAttempts, 50)
  assert.equal(retained.reservationDayUtc, '2026-11-12')
  assert.equal(retained.day.emailAttempts, 10)
}))

test('uses rolling minute admission rather than resetting at a calendar minute boundary', async () => fixture(async path => {
  await reserveQualificationWork(path, request('burst', { costs: costs({ operations: 30 }) }), NOW + 59_000)
  await finishQualificationWork(path, 'burst', 'complete', NOW + 59_001)
  await assert.rejects(reserveQualificationWork(path, request('too-soon'), NOW + 61_000))
  await reserveQualificationWork(path, request('later'), NOW + 119_000)
  await finishQualificationWork(path, 'later', 'complete', NOW + 119_000)
  await assert.rejects(reserveQualificationWork(path, request('backward'), NOW + 118_000))
}))

test('limits OPAQUE pairs independently and accounts for start and finish operations', async () => fixture(async path => {
  await assert.rejects(reserveQualificationWork(path, request('under-costed', { costs: costs({ opaquePairs: 1 }) }), NOW))
  await reserveQualificationWork(path, request('opaque', { costs: costs({ opaquePairs: 10, operations: 20 }) }), NOW)
  await finishQualificationWork(path, 'opaque', 'complete', NOW)
  await assert.rejects(reserveQualificationWork(path, request('over-pairs', { costs: costs({ opaquePairs: 1, operations: 2 }) }), NOW))
}))

test('accounts for identities, per-account revisions and cumulative ciphertext before allocation', async () => fixture(async path => {
  for (let i = 0; i < 4; i++) {
    await reserveQualificationWork(path, request(`account-${i}`, { accountId: `account-${i}`, costs: costs({ revisions: 16, ciphertextBytes: 8 * 1024 * 1024 }) }), NOW + i * 61_000)
    await finishQualificationWork(path, `account-${i}`, 'complete', NOW + i * 61_000)
  }
  await assert.rejects(reserveQualificationWork(path, request('fifth', { accountId: 'account-4' }), NOW + 244_000))
  await assert.rejects(reserveQualificationWork(path, request('revision', { accountId: 'account-0', costs: costs({ revisions: 1 }) }), NOW + 244_000))
  await assert.rejects(reserveQualificationWork(path, request('ciphertext', { accountId: 'account-0', costs: costs({ ciphertextBytes: 1 }) }), NOW + 244_000))
}))

test('caps every native-work, storage allocation and context dimension without refunds', async () => fixture(async path => {
  const maxima = { d1RowsRead: 2_000_000, d1RowsWritten: 100_000, r2ClassA: 20_000, r2ClassB: 100_000, d1MetadataBytes: 64 * 1024 * 1024, d1RestoreBytes: 64 * 1024 * 1024, r2Bytes: 256 * 1024 * 1024, sourceContextBytes: 128 * 1024 * 1024, restoreContextBytes: 128 * 1024 * 1024 }
  await reserveQualificationWork(path, request('native', { costs: costs(maxima) }), NOW)
  await finishQualificationWork(path, 'native', 'failed', NOW)
  for (const field of Object.keys(maxima)) await assert.rejects(reserveQualificationWork(path, request('extra', { costs: costs({ [field]: 1 }) }), NOW + 61_000))
}))

test('reserves finite load windows with daily and total ceilings and refuses midnight ambiguity', async () => fixture(async path => {
  for (let i = 0; i < 3; i++) {
    const at = NOW + i * DAY
    const reserved = await reserveQualificationWork(path, request(`load-${i}`, { costs: costs({ loadMs: 60 * 60 * 1000 }) }), at)
    assert.equal(reserved.notAfter, at + 60 * 60 * 1000)
    await finishQualificationWork(path, `load-${i}`, 'complete', reserved.notAfter)
    await assert.rejects(reserveQualificationWork(path, request('over-day', { costs: costs({ loadMs: 1 }) }), reserved.notAfter))
  }
  await assert.rejects(reserveQualificationWork(path, request('over-total', { costs: costs({ loadMs: 1 }) }), NOW + 3 * DAY))
  await assert.rejects(reserveQualificationWork(path, request('cross-midnight', { costs: costs({ loadMs: 60_000 }) }), Date.UTC(2026, 10, 14, 23, 59, 30)))
}))

test('keeps abandoned reservations charged and occupies their client slots until explicit resolution', async () => fixture(async path => {
  for (let i = 0; i < 4; i++) await reserveQualificationWork(path, request(`held-${i}`, { clientId: `client-${i}` }), NOW)
  await assert.rejects(reserveQualificationWork(path, request('fifth', { clientId: 'client-4' }), NOW))
  await assert.rejects(reserveQualificationWork(path, request('overlap', { clientId: 'client-1' }), NOW))
  await finishQualificationWork(path, 'held-0', 'uncertain', NOW)
  await reserveQualificationWork(path, request('replacement', { clientId: 'client-4' }), NOW)
  assert.equal((await readQualificationBudget(path)).total.operations, 5)
}))

test('refuses unsafe private files, symlinks and malformed ledgers', async () => fixture(async (path, directory) => {
  await chmod(path, 0o644)
  await assert.rejects(readQualificationBudget(path))
  await chmod(path, 0o600)
  const alias = join(directory, 'alias.sqlite'); await symlink(path, alias)
  await assert.rejects(readQualificationBudget(alias))
  await chmod(directory, 0o755)
  await assert.rejects(readQualificationBudget(path))
  await chmod(directory, 0o700)
}))

test('serializes separate processes competing for the final shared allowance', async () => fixture(async path => {
  const module = new URL('./budget.mjs', import.meta.url).href
  const source = `import {reserveQualificationWork,finishQualificationWork} from ${JSON.stringify(module)}; const q=JSON.parse(process.argv[2]); try { const r=await reserveQualificationWork(process.argv[1],q,${NOW}); if(r.dispatchAllowed) await finishQualificationWork(process.argv[1],q.id,'complete',${NOW}); process.stdout.write('accepted'); } catch { process.stdout.write('denied'); }`
  const invoke = i => new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', source, path, JSON.stringify(request(`race-${i}`, { clientId: `client-${i}`, costs: costs({ operations: 10 }) }))], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let error = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { error += data })
    child.once('error', fail); child.once('close', code => code === 0 ? done(output) : fail(Error(error)))
  })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => invoke(i)))
  assert.equal(results.filter(value => value === 'accepted').length, 3)
  assert.equal((await readQualificationBudget(path)).total.operations, 30)
  assert.ok((await readFile(path)).byteLength > 0)
}))

test('stops at the total operation ceiling even after rolling windows expire', async () => fixture(async path => {
  let at = NOW
  for (let i = 0; i < 334; i++) {
    const count = i === 333 ? 10 : 30
    await reserveQualificationWork(path, request(`total-${i}`, { costs: costs({ operations: count }) }), at)
    await finishQualificationWork(path, `total-${i}`, 'complete', at)
    at += 61_000
  }
  assert.equal((await readQualificationBudget(path)).total.operations, 10_000)
  await assert.rejects(reserveQualificationWork(path, request('one-too-many'), at))
}))

test('rejects a midnight-crossing load before consuming any budget', async () => fixture(async path => {
  const before = await readQualificationBudget(path)
  await assert.rejects(reserveQualificationWork(path, request('crossing', { costs: costs({ loadMs: 60_000 }) }), Date.UTC(2026, 10, 10, 23, 59, 30)))
  assert.deepEqual(await readQualificationBudget(path), before)
}))

test('records an observed load overrun as uncertain and durably stops subsequent admissions', async () => fixture(async path => {
  const input = request('late', { costs: costs({ loadMs: 1000 }) })
  await reserveQualificationWork(path, input, NOW)
  const ended = await finishQualificationWork(path, 'late', 'complete', NOW + 1001)
  assert.equal(ended.halted, true)
  assert.equal((await reserveQualificationWork(path, input, NOW + 1001)).outcome, 'uncertain')
  await assert.rejects(reserveQualificationWork(path, request('after-overrun'), NOW + 61_000))
}))

test('does not reinterpret corrupt or missing private files as an empty run', async () => fixture(async (path, directory) => {
  await writeFile(path, 'synthetic non-database bytes')
  await assert.rejects(readQualificationBudget(path), e => e.message === 'QUALIFICATION_BUDGET_UNAVAILABLE')
  await assert.rejects(readQualificationBudget(join(directory, 'missing.sqlite')))
}))

test('completion retries preserve the original on-time outcome without inventing a later overrun', async () => fixture(async path => {
  await reserveQualificationWork(path, request('finished', { costs: costs({ loadMs: 1000 }) }), NOW)
  await finishQualificationWork(path, 'finished', 'complete', NOW + 500)
  assert.equal((await finishQualificationWork(path, 'finished', 'complete', NOW + 2000)).halted, false)
  assert.equal((await readQualificationBudget(path)).lastAt, NOW + 500)
  await assert.rejects(finishQualificationWork(path, 'finished', 'uncertain', NOW + 2000))
}))

test('records historical unreserved work separately and consumes allowance without authorizing dispatch', async () => fixture(async path => {
  const { recordHistoricalQualificationWork } = await import('./budget.mjs')
  assert.equal(typeof recordHistoricalQualificationWork, 'function')
  const input = request('historical-edge', { costs: costs({ operations: 12 }) })
  const result = await recordHistoricalQualificationWork(path, input, NOW)
  assert.equal(result.dispatchAllowed, false)
  const status = await readQualificationBudget(path)
  assert.equal(status.policy, 'crykit-private-qualification-v1')
  assert.equal(status.total.operations, 12)
  assert.equal(status.historicalTotal.operations, 12)
  assert.equal(status.activeClients, 0)
  assert.equal((await recordHistoricalQualificationWork(path, input, NOW)).dispatchAllowed, false)
  await assert.rejects(reserveQualificationWork(path, input, NOW))
  await assert.rejects(reserveQualificationWork(path, request('over-minute', { costs: costs({ operations: 19 }) }), NOW))
}))

test('retains historical overage instead of discarding reality and stops further work', async () => fixture(async path => {
  const { recordHistoricalQualificationWork } = await import('./budget.mjs')
  assert.equal(typeof recordHistoricalQualificationWork, 'function')
  await recordHistoricalQualificationWork(path, request('historical-overage', { costs: costs({ operations: 31 }) }), NOW)
  const status = await readQualificationBudget(path)
  assert.equal(status.total.operations, 31)
  assert.equal(status.halted, true)
  await assert.rejects(reserveQualificationWork(path, request('after-historical-overage'), NOW + 61_000))
}))

for (const method of ['reserveQualificationWork', 'recordHistoricalQualificationWork']) {
  test(`${method} detaches caller mutation before commit and preserves original replay identity`, async () => fixture(async path => {
    const operation = (await import('./budget.mjs'))[method]
    const original = () => request('detached', { ...email(1), costs: costs({ operations: 3, emailAttempts: 1 }) })
    const input = original()
    const pending = operation(path, input, NOW)
    input.id = 'changed-id'
    input.clientId = 'changed-client'
    input.accountId = 'changed-account'
    input.costs.operations = 0
    input.costs.emailAttempts = 0
    input.emailRecipients.push('outside@example.org')
    const result = await pending
    assert.equal(result.id, 'detached')
    assert.equal(result.dispatchAllowed, method === 'reserveQualificationWork')
    const retained = await readQualificationBudget(path)
    assert.equal(retained.total.operations, 3)
    assert.equal(retained.total.emailAttempts, 1)
    assert.equal(retained.accountCount, 0)
    assert.equal((await operation(path, original(), NOW)).dispatchAllowed, false)
    await assert.rejects(operation(path, { ...original(), costs: costs({ operations: 4, emailAttempts: 1 }) }, NOW))
    await assert.rejects(operation(path, { ...original(), emailRecipients: [`other@${'crykit.lasers.app'}`] }, NOW))
  }))
}
