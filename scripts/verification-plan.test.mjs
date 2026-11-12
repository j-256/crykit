import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executionEnvironment, readInstalled, readPrepared } from './verification-plan.mjs'

test('execution identity includes relevant overrides without retaining secret values or coordination tokens', () => {
  const baseline = { CI: 'true', CRYKIT_SYNTHETIC_SECRET: 'private-value', NODE_OPTIONS: '--max-old-space-size=4096' }
  const identity = executionEnvironment(baseline)
  assert.match(identity, /^[a-f0-9]{64}$/)
  assert.equal(executionEnvironment({ ...baseline, WT_QUEUE_VERIFICATION_TOKEN: 'different-owner', TERM: 'different' }), identity)
  for (const key of ['CI', 'CRYKIT_SYNTHETIC_SECRET', 'NODE_OPTIONS', 'PLAYWRIGHT_BROWSERS_PATH', 'TZ', 'PATH', 'npm_config_userconfig']) assert.notEqual(executionEnvironment({ ...baseline, [key]: 'changed' }), identity)
  assert.equal(executionEnvironment(Object.fromEntries(Object.entries(baseline).reverse())), identity)
})

test('installed identity ignores compiler caches while retaining dependency and browser changes', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'verification-installation-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const browser = join(cwd, 'browser-runtime')
  for (const path of ['node_modules/playwright-core/lib', 'node_modules/dependency', 'browser-runtime']) mkdirSync(join(cwd, path), { recursive: true })
  writeFileSync(join(cwd, 'package.json'), '{}')
  writeFileSync(join(cwd, 'package-lock.json'), '{}')
  writeFileSync(join(cwd, 'node_modules/dependency/index.js'), 'original')
  writeFileSync(join(browser, 'browser'), 'original')
  const registryDirectory = join(cwd, 'node_modules/playwright-core/lib')
  // Keep fixture paths in JSON so filesystem values never become JavaScript source
  writeFileSync(join(registryDirectory, 'browser-directory.json'), JSON.stringify(browser))
  writeFileSync(join(registryDirectory, 'coreBundle.js'), "const directory = require('./browser-directory.json')\nexports.registry = { registry: { findExecutable: () => ({ directory, executablePath: () => 'browser' }) } }\n")
  for (const metadata of [false, true]) {
    const read = () => readInstalled({ cwd, env: process.env, metadata })
    const baseline = read()
    for (const cache of ['.tmp', '.vitest-cache']) {
      mkdirSync(join(cwd, 'node_modules', cache), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', cache, 'generated'), String(metadata))
    }
    assert.equal(read(), baseline, `generated caches must not change ${metadata ? 'metadata' : 'content'} identity`)
    writeFileSync(join(cwd, 'node_modules/dependency/index.js'), `changed dependency ${metadata}`)
    assert.notEqual(read(), baseline)
    const changedDependency = read()
    writeFileSync(join(browser, 'browser'), `changed browser ${metadata}`)
    assert.notEqual(read(), changedDependency)
  }
})

test('prepared identity tracks immutable bytes without including mutable account reports', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'verification-inputs-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const inputs = ['dist', '.account-tests/browser', '.account-tests/local', '.account-tests/production', '.account-tests/wasm', '.account-tests/opaque-adapter', '.account-tests/alerts']
  for (const path of inputs) { mkdirSync(join(cwd, path), { recursive: true }); writeFileSync(join(cwd, path, 'bundle.js'), 'original') }
  const first = readPrepared({ cwd })
  writeFileSync(join(cwd, '.account-tests/acceptance-results.json'), 'mutable')
  assert.equal(readPrepared({ cwd }), first)
  writeFileSync(join(cwd, 'dist/.DS_Store'), 'Finder metadata')
  writeFileSync(join(cwd, '.account-tests/local/README.md'), 'Wrangler generated timestamp')
  assert.equal(readPrepared({ cwd }), first)
  writeFileSync(join(cwd, '.account-tests/alerts/bundle.js'), 'changed')
  assert.notEqual(readPrepared({ cwd }), first)
  writeFileSync(join(cwd, '.account-tests/alerts/bundle.js'), 'original')
  writeFileSync(join(cwd, 'dist/bundle.js'), 'changed')
  assert.notEqual(readPrepared({ cwd }), first)
  rmSync(join(cwd, '.account-tests/local'), { recursive: true })
  assert.throws(() => readPrepared({ cwd }), /ENOENT/)
})

test('Vitest receipts reject missing assertions and inconsistent totals', async () => {
  const { validateVitestReport } = await import('./verification-plan.mjs')
  assert.equal(typeof validateVitestReport, 'function')
  const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
    testResults: [{ name: 'fixture.test.ts', status: 'passed', assertionResults: [{ fullName: 'required case', status: 'passed', failureMessages: [] }] }] }
  validateVitestReport(report)
  for (const invalid of [
    { ...report, numTotalTests: 999 },
    { ...report, testResults: [{ status: 'passed', assertionResults: [] }] },
    { ...report, testResults: [] },
    { ...report, numPassedTests: 0 },
    { ...report, testResults: [{ status: 'passed', assertionResults: [{ status: 'failed' }] }] },
  ]) assert.throws(() => validateVitestReport(invalid), /Vitest/)
})

test('a structurally valid truncated Vitest report still fails its completion digest', async t => {
  const { validateVitestReceipt } = await import('./verification-plan.mjs')
  const { digest } = await import('./verification-checkpoints.mjs')
  assert.equal(typeof validateVitestReceipt, 'function')
  const directory = mkdtempSync(join(tmpdir(), 'vitest-receipt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const assertion = { fullName: 'required case', status: 'passed', failureMessages: [] }
  const report = { success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0,
    testResults: [{ name: 'fixture.test.ts', status: 'passed', assertionResults: [assertion, { ...assertion, fullName: 'another case' }] }] }
  const bytes = JSON.stringify(report)
  writeFileSync(join(directory, 'results.json'), bytes)
  writeFileSync(join(directory, 'command.json'), JSON.stringify({ command: 'test:vitest:prepared', passed: true, reportDigest: digest(bytes) }))
  validateVitestReceipt(directory)
  report.numTotalTests = report.numPassedTests = 1
  report.testResults[0].assertionResults.pop()
  writeFileSync(join(directory, 'results.json'), JSON.stringify(report))
  assert.throws(() => validateVitestReceipt(directory), /changed after completion/)
})
