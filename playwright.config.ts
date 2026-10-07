import { defineConfig, devices } from '@playwright/test'
import { MOBILE_TEST_TAG } from './e2e/test-tags'

const e2ePort = process.env.CRYKIT_E2E_PORT ?? '4173'
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`
const END_TO_END_TEST_TIMEOUT_MS = 60_000
const CI_END_TO_END_WORKERS = 1
// Bound concurrent offline cache installs so the preview server can serve the map assets
const LOCAL_END_TO_END_WORKERS = 2
// Mobile offline journeys cache the full map shell; run one at a time
const MOBILE_END_TO_END_WORKERS = 1
const END_TO_END_TIMING_REPORT_PATH = 'test-results/timings.json'

export default defineConfig({
  testDir: './e2e',
  timeout: END_TO_END_TEST_TIMEOUT_MS,
  fullyParallel: true,
  workers: process.env.CI ? CI_END_TO_END_WORKERS : LOCAL_END_TO_END_WORKERS,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github'], ['json', { outputFile: END_TO_END_TIMING_REPORT_PATH }]] : [['list']],
  use: {
    baseURL: e2eBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', grep: new RegExp(MOBILE_TEST_TAG), workers: MOBILE_END_TO_END_WORKERS, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run preview -- --port ${e2ePort} --strictPort`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
