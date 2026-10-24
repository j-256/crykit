import { defineConfig, devices } from '@playwright/test'

// The isolated acceptance server supplies immutable proof assets and actual HTTPS behavior
// No implicit dev server or shared database is created by the timing producer
delete process.env.NO_COLOR
const LOCAL_SAVE_TEST_WORKERS = 2
export default defineConfig({
  // Groups own independent browser storage; each mapper checkpoint sequence stays explicitly serial
  testDir: './e2e', outputDir: '.account-tests/local-save-artifacts', testMatch: 'local-save-performance.spec.ts', workers: LOCAL_SAVE_TEST_WORKERS, fullyParallel: true, retries: 0, forbidOnly: true,
  timeout: 180_000,
  use: { ...devices['Desktop Chrome'], baseURL: process.env.CRYKIT_SAVE_ORIGIN ?? 'https://127.0.0.1:8802', ignoreHTTPSErrors: true, launchOptions: { args: ['--ignore-certificate-errors'] }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: '.account-tests/local-save-results.json' }]],
})
