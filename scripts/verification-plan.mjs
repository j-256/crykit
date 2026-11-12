import { execFileSync } from 'node:child_process'
import { copyFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { digest, fingerprintPaths, writeJson } from './verification-checkpoints.mjs'
import { discoverPlaywrightPhase, runPlaywrightPhase } from './verification-playwright.mjs'

export const VERIFICATION_STEPS = Object.freeze({ prepare: 'prepare:verification', checks: 'check:deterministic:base', saves: 'test:e2e:saves:prepared', tests: 'test:vitest:prepared', browser: 'test:e2e', accounts: 'test:e2e:accounts:remaining' })
export const VERIFICATION_COMMANDS = Object.freeze(Object.values(VERIFICATION_STEPS))
const PREPARED_INPUTS = Object.freeze(['dist', '.account-tests/browser', '.account-tests/local', '.account-tests/production', '.account-tests/wasm', '.account-tests/opaque-adapter', '.account-tests/alerts'])
const BROWSER_NAMES = Object.freeze(['chromium', 'chromium-headless-shell', 'firefox', 'webkit', 'ffmpeg'])
// TypeScript build-info and Vitest's filesystem module cache are written by required checks
// Fingerprinting these generated outputs would invalidate the run that produced them
const MUTABLE_DEPENDENCY_CACHES = new Set(['.vite', '.vite-temp', '.cache', '.tmp', '.vitest-cache'])
const isFinderMetadata = name => name.split('/').at(-1) === '.DS_Store'
const ENVIRONMENT_KEYS = /^(CI$|NODE_|NODE_ENV$|TZ$|LANG$|LC_|PLAYWRIGHT_|PWDEBUG$|CRYKIT_|VITE_|UV_THREADPOOL_SIZE$|PATH$|npm_config_|NPM_CONFIG_)/

export function executionEnvironment(env) {
  // Keep secrets out of receipts while invalidating relevant test and build overrides
  return digest(JSON.stringify(Object.entries(env).filter(([key]) => ENVIRONMENT_KEYS.test(key)).sort(([a], [b]) => a.localeCompare(b))))
}

export function readInstalled({ cwd, env, metadata = false }) {
  if (env.PWDEBUG && env.PWDEBUG !== '0') throw new Error('PWDEBUG disables required deadlines; unset it for publication verification')
  const require = createRequire(join(cwd, 'package.json'))
  // This version-pinned adapter includes the headless shell, which chromium.executablePath omits
  // An incompatible Playwright registry fails closed until its adapter is reviewed
  const registry = require('playwright-core/lib/coreBundle').registry.registry
  const browsers = BROWSER_NAMES.map(name => {
    const executable = registry.findExecutable(name)
    if (!executable?.directory || !executable.executablePath()) throw new Error(`Missing Playwright installation: ${name}`)
    return [name, fingerprintPaths(executable.directory, ['.'], { ignore: isFinderMetadata, metadata })]
  })
  const dependencies = readdirSync(join(cwd, 'node_modules')).filter(name => !MUTABLE_DEPENDENCY_CACHES.has(name)).map(name => `node_modules/${name}`)
  return digest(JSON.stringify({
    environment: executionEnvironment(env),
    dependencies: fingerprintPaths(cwd, ['package-lock.json', ...dependencies], { ignore: isFinderMetadata, metadata }), browsers,
    npm: execFileSync('npm', ['--version'], { cwd, env, encoding: 'utf8' }).trim(),
    openssl: execFileSync('openssl', ['version'], { encoding: 'utf8' }).trim(),
  }))
}

export function readPrepared({ cwd, metadata = false }) {
  // Wrangler emits a timestamp-only README beside bundles; fixtures consume modules and manifests
  // Finder metadata likewise has no runtime meaning, while all executable and served app bytes count
  return fingerprintPaths(cwd, PREPARED_INPUTS, { metadata, ignore: name => isFinderMetadata(name) || /^\.account-tests\/(local|production|wasm|opaque-adapter|alerts)\/README\.md$/.test(name) })
}

export function validateVitestReport(report) {
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0 || !(report.numTotalTests > 0) || !Array.isArray(report.testResults) || !report.testResults.length) throw new Error('Vitest report is incomplete or unsuccessful')
  const assertions = report.testResults.flatMap(suite => {
    if (suite.status !== 'passed' || !Array.isArray(suite.assertionResults) || !suite.assertionResults.length) throw new Error('Vitest report contains an incomplete suite')
    return suite.assertionResults
  })
  const counts = { passed: 0, pending: 0, todo: 0 }
  for (const assertion of assertions) {
    if (!Object.hasOwn(counts, assertion.status) || assertion.failureMessages?.length) throw new Error('Vitest report contains an unsuccessful assertion')
    counts[assertion.status]++
  }
  if (assertions.length !== report.numTotalTests || counts.passed !== report.numPassedTests || counts.pending !== report.numPendingTests || counts.todo !== report.numTodoTests) throw new Error('Vitest report totals do not match its assertions')
}

export function validateVitestReceipt(artifacts) {
  const bytes = readFileSync(join(artifacts, 'results.json'))
  const receipt = JSON.parse(readFileSync(join(artifacts, 'command.json'), 'utf8'))
  if (receipt.command !== VERIFICATION_STEPS.tests || receipt.passed !== true || digest(bytes) !== receipt.reportDigest) throw new Error('Vitest report changed after completion')
  validateVitestReport(JSON.parse(bytes))
}

export async function createVerificationPlan({ cwd, env, run }) {
  const commandPhase = command => ({
    execute: async artifacts => {
      await run(command, { cwd, env, log: join(artifacts, 'run.log') })
      writeJson(join(artifacts, 'command.json'), { command, passed: true })
    },
    validate: artifacts => {
      const receipt = JSON.parse(readFileSync(join(artifacts, 'command.json'), 'utf8'))
      if (receipt.command !== command || receipt.passed !== true) throw new Error('Command receipt is incomplete')
    },
  })
  const browserPhase = async (id, config, output, partitions) => {
    const options = { cwd, env, config, partitions }
    const phase = await discoverPlaywrightPhase(options)
    return { partitioned: true, execute: session => runPlaywrightPhase({ ...options, phase, session, id, output: join(cwd, output) }) }
  }
  const vitest = commandPhase(VERIFICATION_STEPS.tests)
  return {
    [VERIFICATION_STEPS.checks]: commandPhase(VERIFICATION_STEPS.checks),
    [VERIFICATION_STEPS.saves]: await browserPhase('saves', 'playwright.saves.config.ts', '.account-tests/save-performance-results.json', 1),
    [VERIFICATION_STEPS.tests]: {
      execute: async artifacts => {
        await vitest.execute(artifacts)
        copyFileSync(join(cwd, '.account-tests/vitest-results.json'), join(artifacts, 'results.json'))
        const bytes = readFileSync(join(artifacts, 'results.json'))
        validateVitestReport(JSON.parse(bytes))
        writeJson(join(artifacts, 'command.json'), { command: VERIFICATION_STEPS.tests, passed: true, reportDigest: digest(bytes) })
      },
      validate: validateVitestReceipt,
      restore: artifacts => copyFileSync(join(artifacts, 'results.json'), join(cwd, '.account-tests/vitest-results.json')),
    },
    [VERIFICATION_STEPS.browser]: await browserPhase('guest', 'playwright.config.ts', 'test-results/timings.json'),
    [VERIFICATION_STEPS.accounts]: await browserPhase('accounts', 'playwright.acceptance-remaining.config.ts', '.account-tests/acceptance-results.json'),
  }
}
