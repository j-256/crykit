import { validateRumReceipts } from './rum-proof/receipts.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const command = (...args) => spawnSync(process.execPath, ['scripts/verify-rum.mjs', ...args], { encoding: 'utf8' })
test('RUM verification explains required external artifact and never silently skips it', () => {
  for (const flag of ['-h', '--help']) { const result = command(flag); assert.equal(result.status, 0); assert.match(result.stdout, /--beacon/); assert.equal(result.stderr, '') }
  const missing = command(); assert.equal(missing.status, 2); assert.match(missing.stderr, /beacon/i)
  const absent = command('--beacon', join(tmpdir(), 'crykit-rum-absent-artifact.js')); assert.equal(absent.status, 2); assert.match(absent.stderr, /artifact/i)
})
test('wrong external bytes and unknown options fail before a browser/runtime starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'crykit-rum-cli-')); const artifact = join(directory, 'beacon.js'); writeFileSync(artifact, 'throw new Error("must not execute")')
  for (const args of [['--beacon', artifact], [`--beacon=${artifact}`], [`-b${artifact}`]]) { const result = command(...args); assert.equal(result.status, 2); assert.match(result.stderr, /digest/i) }
  for (const args of [['--unknown'], ['--output='], ['--beacon'], ['--beacon='], ['unexpected'], ['--', 'unexpected']]) assert.equal(command(...args).status, 2)
})

test('RUM completion requires both fresh bounded proofs and their native exit evidence', () => {
  const started = Date.parse('2026-01-01T00:00:00Z'), digest = 'a'.repeat(64)
  const receipt = proof => ({ proof, status: 'passed', beaconSha256: digest, observedAt: new Date(started + 1000).toISOString(), requestCount: 1500, nativeExitVitalsObserved: true, rejected: [], captures: [{}], scriptRequests: [{}], builtInputs: { 'dist/index.html': 'b'.repeat(64), 'dist/_headers': 'c'.repeat(64) } })
  const values = { 'receipt.json': receipt('private-state'), 'hosted-receipt.json': receipt('hosted-navigation') }
  assert.equal(validateRumReceipts(values, started, digest).proofs.length, 2)
  assert.throws(() => validateRumReceipts({ 'receipt.json': values['receipt.json'] }, started, digest))
  for (const change of [{ status: 'failed' }, { observedAt: new Date(started - 1).toISOString() }, { observedAt: 'unavailable' }, { requestCount: 2001 }, { requestCount: null }, { rejected: ['REQUEST_LIMIT'] }, { nativeExitVitalsObserved: false }, { captures: [] }, { scriptRequests: [] }, { builtInputs: { 'dist/index.html': 'd'.repeat(64), 'dist/_headers': 'c'.repeat(64) } }]) {
    assert.throws(() => validateRumReceipts({ ...values, 'hosted-receipt.json': { ...values['hosted-receipt.json'], ...change } }, started, digest))
  }
})
