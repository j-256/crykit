import { defineConfig, devices } from '@playwright/test'
import { CHROMIUM_STATUS_COMPLETION_TAG } from './e2e/test-tags'

// Acceptance owns an immutable HTTPS fixture; ordinary guest suites keep their separate static server
delete process.env.NO_COLOR
process.env.CRYKIT_OWN_ACCOUNT_RUNTIME = '1'
// Each worker owns its backend; local fixture telemetry stays inside the Worker until requested
// Keep the hosted runner budget independent of the qualified local concurrency
const ACCOUNT_ACCEPTANCE_WORKERS = process.env.CI ? 1 : 2
// CI stops after the failed case and cleanup; local runs retain the remaining cases
const ACCOUNT_ACCEPTANCE_MAX_FAILURES = process.env.CI ? 1 : 0
export default defineConfig({
  globalSetup: './e2e/accounts/global-setup.ts',
  testDir: './e2e/accounts', fullyParallel: true, workers: ACCOUNT_ACCEPTANCE_WORKERS, maxFailures: ACCOUNT_ACCEPTANCE_MAX_FAILURES, forbidOnly: true, retries: 0,
  testMatch: ['complete-workspace.spec.ts', 'privacy-boundaries.spec.ts', 'lifecycle.spec.ts', 'access.spec.ts', 'admin-security.spec.ts', 'admin-panel.spec.ts', 'guest-copy.spec.ts', 'status-recovery.spec.ts', 'runtime-isolation.spec.ts'],
  outputDir: '.account-tests/acceptance-artifacts',
  reporter: [['list'], ['json', { outputFile: '.account-tests/acceptance-results.json' }]],
  use: { ignoreHTTPSErrors: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    // Chromium's context certificate override does not cover ServiceWorker installation
    // This process is dedicated to synthetic loopback fixtures and does not change OS trust or production policy
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--ignore-certificate-errors'] } } },
    { name: 'local-saves', workers: 2, testDir: './e2e', testMatch: 'local-save-performance.spec.ts', timeout: 180_000, use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--ignore-certificate-errors'] } } },
    // Keep queued tiles and physical offline reload on every engine; compose only completion phases
    { name: 'firefox', grepInvert: new RegExp(CHROMIUM_STATUS_COMPLETION_TAG), use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grepInvert: new RegExp(CHROMIUM_STATUS_COMPLETION_TAG), use: { ...devices['Desktop Safari'] } },
  ],
})
