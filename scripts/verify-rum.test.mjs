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
