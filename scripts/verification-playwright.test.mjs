import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createCheckpointSession } from './verification-checkpoints.mjs'
import * as browser from './verification-playwright.mjs'

const require = createRequire(import.meta.url)
const entry = require.resolve('@playwright/test')
const cli = require.resolve('@playwright/test/cli')
const report = (status = 'passed') => ({ errors: [], suites: [{ title: 'fixture', specs: [{ title: 'case', file: 'fixture.spec.js', line: 1, column: 1, tags: [], tests: [{ projectName: 'desktop', expectedStatus: 'passed', timeout: 1000, status: status === 'passed' ? 'expected' : 'skipped', results: [{ status, retry: 0 }] }] }] }] })

test('partition validation rejects duplicate or missing coverage and incomplete success reports', () => {
  assert.equal(typeof browser.playwrightManifest, 'function')
  const manifest = browser.playwrightManifest(report())
  browser.assertPartitionCoverage(manifest, [manifest])
  assert.throws(() => browser.assertPartitionCoverage(manifest, []), /coverage/)
  assert.throws(() => browser.assertPartitionCoverage(manifest, [manifest, manifest]), /coverage/)
  browser.validatePlaywrightReport(report(), manifest)
  for (const status of ['skipped', 'interrupted', 'failed', 'timedOut']) assert.throws(() => browser.validatePlaywrightReport(report(status), manifest), /did not pass/)
  const incomplete = report()
  incomplete.suites[0].specs[0].tests[0].results = []
  assert.throws(() => browser.validatePlaywrightReport(incomplete, manifest), /did not pass/)
  assert.throws(() => browser.validatePlaywrightReport({ ...report(), errors: [{ message: 'teardown failed' }] }, manifest), /errors/)
  const wrong = report()
  wrong.suites[0].specs[0].tests[0].projectName = 'wrong'
  assert.throws(() => browser.validatePlaywrightReport(wrong, manifest), /coverage/)
})

test('real Playwright shards preserve serial fixtures and resume only failed or pending partitions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'verification-playwright-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cwd = join(directory, 'source')
  mkdirSync(cwd)
  const flag = join(directory, 'fail')
  writeFileSync(flag, 'fail')
  const config = join(cwd, 'playwright.config.cjs')
  writeFileSync(config, `module.exports = { testDir: '.', fullyParallel: true, retries: 0, workers: 2, timeout: 10000, projects: [{name:'desktop'}] }`)
  writeFileSync(join(cwd, 'fixture.spec.cjs'), `
const { test, expect } = require(${JSON.stringify(entry)})
const { existsSync } = require('node:fs')
let state = 0
test.describe.serial('shared fixture', () => {
  test('setup', () => { state = 1 })
  test('continuation', () => { expect(state).toBe(1); state = 2 })
  test('finish', () => { expect(state).toBe(2) })
})
for (let i=0;i<9;i++) test('independent '+i, () => { if (i===4) expect(existsSync(${JSON.stringify(flag)})).toBe(false) })
`)
  const options = { cwd, env: process.env, cli, config, partitions: 6 }
  const phase = await browser.discoverPlaywrightPhase(options)
  assert.equal(phase.manifest.length, 12)
  assert.equal(phase.partitions.flatMap(part => part.manifest).length, 12)
  const shared = phase.partitions.map(part => part.manifest.filter(item => item.titles.includes('shared fixture')).length)
  assert.equal(shared.filter(Boolean).length, 1)
  assert.equal(Math.max(...shared), 3)
  const checkpoint = { directory: join(directory, 'cache'), identity: 'fixture' }
  const first = createCheckpointSession(checkpoint)
  await assert.rejects(browser.runPlaywrightPhase({ ...options, phase, session: first, id: 'fixture', output: join(directory, 'aggregate.json'), echo: false }), /failed/)
  const passed = first.summary().executed.length - 1
  assert.ok(passed > 0)
  first.close()
  rmSync(flag)
  const second = createCheckpointSession({ ...checkpoint, resume: true })
  await browser.runPlaywrightPhase({ ...options, phase, session: second, id: 'fixture', output: join(directory, 'aggregate.json'), echo: false })
  assert.equal(second.summary().reused.length, passed)
  assert.equal(second.summary().recovered.length, 1)
  browser.validatePlaywrightReport(JSON.parse(readFileSync(join(directory, 'aggregate.json'), 'utf8')), phase.manifest)
  second.close()
})
