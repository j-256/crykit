import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
const ACTION_TIMEOUT_MS = 20_000
const NAVIGATION_TIMEOUT_MS = 30_000
const PROOF_TIMEOUT_MS = 240_000
export default defineConfig({
  testDir: '.', testMatch: 'actual-app.spec.ts', fullyParallel: false, workers: 1, retries: 0,
  timeout: PROOF_TIMEOUT_MS, expect: { timeout: ACTION_TIMEOUT_MS },
  outputDir: resolve(process.env.CRYKIT_RUM_OUTPUT!, 'browser'),
  reporter: [['list']],
  use: { actionTimeout: ACTION_TIMEOUT_MS, navigationTimeout: NAVIGATION_TIMEOUT_MS, launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] }, browserName: 'chromium', headless: true, ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' },
})
